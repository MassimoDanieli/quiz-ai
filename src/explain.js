/**
 * Contextual explanations.
 *
 * A precomputed explanation says why the right answer is right. This says why
 * the answer a team actually chose was tempting, and what distinguishes it
 * from the correct one — which is the part that teaches.
 *
 * Explanations are cached on (question, chosen option) because within a
 * cohort the same wrong answer recurs constantly, and a cache hit turns a
 * two-second wait into nothing.
 */

const SYSTEM_PROMPT = `You are the technical facilitator of a live team quiz for early-career software engineers. A round has just closed and you are explaining the answer to the room.

Address the specific mistake that was made. If a team picked a wrong option, say what makes it a reasonable thing to think, then name the precise distinction that rules it out. That distinction is the lesson; lead with it, do not bury it.

Style:
- Under 70 words. It is read aloud between rounds.
- Plain, direct, second person plural ("you"). No preamble, no "great question", no scoring the team.
- Never condescending. A wrong answer here is a near miss, not a failure.
- If nobody got it wrong, spend the words on the one thing people usually get wrong instead.
- Plain prose. No markdown, no bullet points, no headings.`;

export class ExplanationService {
  /**
   * @param {object} deps
   * @param {import('./anthropic.js').AnthropicClient} deps.client
   * @param {object} [opts]
   * @param {number} [opts.cacheSize]  Max cached explanations. Default 500.
   * @param {number} [opts.timeoutMs]  Give up and fall back after this. Default 6000.
   */
  constructor({ client }, { cacheSize = 500, timeoutMs = 6000 } = {}) {
    this.client = client;
    this.cacheSize = cacheSize;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, fallbacks: 0 };
  }

  get hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : Math.round((this.stats.hits / total) * 100);
  }

  /**
   * @param {object} opts
   * @param {object} opts.question              A validated question object.
   * @param {Array<{team: string, choiceIndex: number}>} [opts.answers]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{text: string, source: 'cache'|'model'|'fallback', latencyMs: number}>}
   */
  async explain({ question, answers = [], signal } = {}) {
    const key = cacheKey(question, answers);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits += 1;
      // Refresh recency for the LRU eviction below.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { text: cached, source: 'cache', latencyMs: 0 };
    }

    this.stats.misses += 1;

    try {
      const response = await this.client.complete({
        system: SYSTEM_PROMPT,
        maxTokens: 300,
        temperature: 0.7,
        signal,
        messages: [{ role: 'user', content: buildPrompt(question, answers) }],
      });

      const text = response.text.replace(/\s+/g, ' ').trim();
      this.#store(key, text);
      return { text, source: 'model', latencyMs: response.latencyMs };
    } catch {
      this.stats.fallbacks += 1;
      return { text: fallbackText(question), source: 'fallback', latencyMs: 0 };
    }
  }

  #store(key, text) {
    this.cache.set(key, text);
    while (this.cache.size > this.cacheSize) {
      // Map preserves insertion order, so the first key is the least recent.
      this.cache.delete(this.cache.keys().next().value);
    }
  }
}

function buildPrompt(question, answers) {
  const lines = [
    `Question: ${question.question}`,
    '',
    'Options:',
    ...question.options.map(
      (opt, i) => `${'ABCD'[i]}. ${opt}${i === question.correctIndex ? '   <- correct' : ''}`,
    ),
  ];

  const wrong = answers.filter((a) => a.choiceIndex !== question.correctIndex);
  const right = answers.filter((a) => a.choiceIndex === question.correctIndex);

  lines.push('');
  if (answers.length === 0) {
    lines.push('No answers were recorded. Explain the correct answer and the misconception that usually catches people.');
  } else if (wrong.length === 0) {
    lines.push('Every team got it right. Confirm briefly, then name the trap they avoided.');
  } else {
    lines.push('What the teams chose:');
    for (const answer of wrong) {
      lines.push(`- ${answer.team} chose ${'ABCD'[answer.choiceIndex]}: ${question.options[answer.choiceIndex]}`);
    }
    for (const answer of right) {
      lines.push(`- ${answer.team} chose the correct answer`);
    }
    lines.push('', 'Explain to the teams that got it wrong why their choice is tempting and what rules it out.');
  }

  if (question.explanation) {
    lines.push('', `Reference note (do not quote verbatim): ${question.explanation}`);
  }

  return lines.join('\n');
}

/** Used when the model is unavailable — the round must not stall. */
function fallbackText(question) {
  const correct = question.options[question.correctIndex];
  return question.explanation
    ? `The answer is ${'ABCD'[question.correctIndex]}: ${correct}. ${question.explanation}`
    : `The answer is ${'ABCD'[question.correctIndex]}: ${correct}.`;
}

function cacheKey(question, answers) {
  const chosen = [...new Set(answers.map((a) => a.choiceIndex))].sort().join('');
  const stem = (question.id || question.question).slice(0, 120);
  return `${stem}|${question.correctIndex}|${chosen}`;
}
