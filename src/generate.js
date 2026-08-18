/**
 * On-demand question generation.
 *
 * The host asks for a topic and a difficulty; this produces validated,
 * de-biased questions. Generation over-asks and then discards, because
 * rejecting a question is cheap and serving a guessable one is not.
 */

import { parseJsonLoose, validateQuestion, LETTERS } from './schema.js';
import { debiasBatch, MAX_LENGTH_MARGIN } from './debias.js';

/**
 * Difficulty tiers.
 *
 * These are Team Quiz's vocabulary, not a generic one: its 664 curated
 * questions are already tagged medium/hard/pro, the host UI filters on those
 * three, and the engine defaults an untagged question to 'hard'. A generated
 * question has to sit in the same pool as a curated one, so the generator
 * speaks the incumbent's language rather than inventing a parallel scale.
 */
export const DIFFICULTIES = ['medium', 'hard', 'pro'];

const SYSTEM_PROMPT = `You write multiple-choice questions for a live team quiz used to train early-career software engineers.

Output rules — these are absolute:
- Reply with a bare JSON array. No prose, no markdown fences, no commentary.
- Each element: {"question": string, "options": [4 strings], "correctLetter": "A"|"B"|"C"|"D", "explanation": string}
- Exactly one option is correct and defensible. The other three are wrong.

Question rules:
- Test understanding, not recall of trivia. Prefer "why does X happen" and "what breaks if Y" over "what year was Z released".
- Keep the stem under 200 characters and answerable in about 20 seconds under time pressure.
- Ground it in something a practitioner actually meets at work.

Answer rules — the quiz is played by people who will exploit any pattern:
- All four options must be within ${MAX_LENGTH_MARGIN} characters of each other in length. The correct answer must NOT be the longest. Write the distractors at full length, not as stubs.
- Distractors must be plausible to someone with partial knowledge: common misconceptions, adjacent tools, near-miss definitions. Never absurd.
- Never use "all of the above", "none of the above", or "both A and B".
- Vary which letter is correct across the batch.
- No option may quote the question stem back.

Explanation: one or two sentences saying why the correct answer holds. Not a restatement of the option.`;

/**
 * @param {object} deps
 * @param {import('./anthropic.js').AnthropicClient} deps.client
 * @param {object} opts
 * @param {string} opts.topic
 * @param {string} [opts.difficulty]
 * @param {number} [opts.count]         How many clean questions are wanted.
 * @param {number} [opts.overAsk]       Extra questions requested to absorb rejects.
 * @param {number} [opts.perCall]       Questions per API call. See below.
 * @param {string[]} [opts.avoid]       Question stems already used this session.
 * @param {Function} [opts.random]      Injectable PRNG for reproducible shuffles.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{questions: object[], report: object}>}
 */
export async function generateQuestions(
  { client },
  {
    topic,
    difficulty = 'medium',
    count = 5,
    overAsk = 2,
    perCall = 3,
    avoid = [],
    random = Math.random,
    signal,
  } = {},
) {
  if (!topic || typeof topic !== 'string') {
    throw new TypeError('topic is required');
  }
  if (!DIFFICULTIES.includes(difficulty)) {
    throw new TypeError(`difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
  }

  const requested = count + overAsk;

  /**
   * Latency here is output-token bound: one call writing eight questions takes
   * roughly twice as long as two calls writing four, because the tokens come
   * out in sequence. Splitting the batch across concurrent calls cuts the wait
   * by about the split factor.
   *
   * The cost is that parallel calls cannot see each other's questions, so they
   * occasionally collide. Deduplication below already handles that, and a
   * discarded duplicate is cheaper than the extra seconds.
   */
  const chunks = [];
  for (let remaining = requested; remaining > 0; remaining -= perCall) {
    chunks.push(Math.min(perCall, remaining));
  }

  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    chunks.map((size) =>
      client.complete({
        system: SYSTEM_PROMPT,
        maxTokens: 400 * size + 300,
        temperature: 1,
        signal,
        messages: [
          { role: 'user', content: buildUserPrompt({ topic, difficulty, requested: size, avoid }) },
        ],
      }),
    ),
  );

  const responses = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (responses.length === 0) {
    // Every call failed; surface the first reason, which carries the fatal flag.
    throw settled[0].reason;
  }

  const rawList = [];
  const parseErrors = [];
  for (const response of responses) {
    const parsed = parseJsonLoose(response.text);
    if (!parsed.ok) {
      parseErrors.push(parsed.reason);
      continue;
    }
    const value = parsed.value;
    if (Array.isArray(value)) rawList.push(...value);
    else if (Array.isArray(value?.questions)) rawList.push(...value.questions);
    else rawList.push(value);
  }

  if (rawList.length === 0) {
    throw new Error(`Could not read the generated batch (${parseErrors[0] ?? 'no questions returned'})`);
  }

  const valid = [];
  const invalid = [];
  for (const raw of rawList) {
    const result = validateQuestion(raw, { topic, difficulty });
    if (result.ok) valid.push(result.value);
    else invalid.push(result.reason);
  }

  const { accepted, rejected } = debiasBatch(valid, random);

  const seen = new Set(avoid.map(normaliseStem));
  const deduped = [];
  for (const question of accepted) {
    const key = normaliseStem(question.question);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...question, id: question.id || makeId(topic, key) });
  }

  return {
    questions: deduped.slice(0, count),
    report: {
      requested,
      calls: chunks.length,
      callsFailed: settled.length - responses.length,
      returned: rawList.length,
      invalid,
      parseErrors,
      rejectedForBias: rejected.map((r) => r.issues),
      deduplicated: accepted.length - deduped.length,
      delivered: Math.min(deduped.length, count),
      latencyMs: Date.now() - startedAt,
      model: responses[0].model,
    },
  };
}

function buildUserPrompt({ topic, difficulty, requested, avoid }) {
  const lines = [
    `Topic: ${topic}`,
    `Difficulty: ${difficulty} (${difficultyHint(difficulty)})`,
    `Write ${requested} questions.`,
  ];

  if (avoid.length > 0) {
    const recent = avoid.slice(-25);
    lines.push(
      '',
      'These have already been asked this session. Do not repeat them or ask a near-variant:',
      ...recent.map((stem) => `- ${stem}`),
    );
  }

  lines.push(
    '',
    `Remember: bare JSON array, ${LETTERS.join('/')} for correctLetter, distractors the same length as the answer.`,
  );

  return lines.join('\n');
}

function difficultyHint(difficulty) {
  switch (difficulty) {
    case 'hard':
      return 'requires having debugged this in production at least once';
    case 'pro':
      return 'a specialist question — most of the room should get it wrong';
    default:
      return 'a competent junior engineer gets it about half the time';
  }
}

function normaliseStem(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function makeId(topic, key) {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0;
  }
  return `${slug}-${(hash >>> 0).toString(36)}`;
}
