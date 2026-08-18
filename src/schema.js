/**
 * Parsing and structural validation for model output.
 *
 * The model is asked for bare JSON, but "asked for" is not "guaranteed".
 * Everything crossing this boundary is treated as untrusted input: fenced
 * blocks are stripped, shapes are checked field by field, and anything that
 * fails is rejected with a reason the caller can feed back into a retry.
 */

export const OPTION_COUNT = 4;
export const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * Extract a JSON value from model text, tolerating markdown fences and
 * the occasional stray preamble.
 *
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty response' };
  }

  let candidate = text.trim();

  // Strip a leading ```json / ``` fence and its closing partner.
  const fenced = candidate.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) candidate = fenced[1].trim();

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    // Last resort: the outermost array or object in the text.
    const sliced = sliceOutermost(candidate);
    if (sliced === null) return { ok: false, reason: 'no JSON found in response' };
    try {
      return { ok: true, value: JSON.parse(sliced) };
    } catch (err) {
      return { ok: false, reason: `malformed JSON: ${err.message}` };
    }
  }
}

function sliceOutermost(text) {
  const openers = [
    [text.indexOf('['), text.lastIndexOf(']')],
    [text.indexOf('{'), text.lastIndexOf('}')],
  ].filter(([start, end]) => start !== -1 && end > start);

  if (openers.length === 0) return null;
  openers.sort((a, b) => a[0] - b[0]);
  const [start, end] = openers[0];
  return text.slice(start, end + 1);
}

/**
 * Validate one question object.
 *
 * Canonical shape:
 *   { id, question, options: [4 strings], correctIndex, explanation, topic, difficulty }
 *
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
export function validateQuestion(raw, { topic, difficulty } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'question is not an object' };
  }

  const question = trimString(raw.question ?? raw.text ?? raw.prompt);
  if (!question) return { ok: false, reason: 'missing question text' };
  if (question.length < 10) return { ok: false, reason: 'question text too short' };
  if (question.length > 320) return { ok: false, reason: 'question text too long' };

  if (!Array.isArray(raw.options)) return { ok: false, reason: 'options is not an array' };
  if (raw.options.length !== OPTION_COUNT) {
    return { ok: false, reason: `expected ${OPTION_COUNT} options, got ${raw.options.length}` };
  }

  const options = raw.options.map(trimString);
  if (options.some((opt) => !opt)) return { ok: false, reason: 'an option is empty' };
  if (options.some((opt) => opt.length > 160)) return { ok: false, reason: 'an option is too long' };

  const normalised = options.map((opt) => opt.toLowerCase().replace(/[\s.]+$/, ''));
  if (new Set(normalised).size !== OPTION_COUNT) {
    return { ok: false, reason: 'duplicate options' };
  }

  const correctIndex = resolveCorrectIndex(raw, options);
  if (correctIndex === null) return { ok: false, reason: 'cannot resolve the correct option' };

  return {
    ok: true,
    value: {
      id: trimString(raw.id) || null,
      question,
      options,
      correctIndex,
      explanation: trimString(raw.explanation) || '',
      topic: trimString(raw.topic) || topic || null,
      difficulty: trimString(raw.difficulty) || difficulty || null,
      source: 'ai',
    },
  };
}

/**
 * Accept whichever of the plausible answer encodings the model produced:
 * a numeric index, a letter, or the literal answer text.
 */
function resolveCorrectIndex(raw, options) {
  const numeric = raw.correctIndex ?? raw.answerIndex ?? raw.correct;
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < options.length) {
    return numeric;
  }

  const letter = trimString(raw.correctLetter ?? raw.answer ?? raw.correct);
  if (letter && letter.length === 1) {
    const index = LETTERS.indexOf(letter.toUpperCase());
    if (index !== -1) return index;
  }

  const answerText = trimString(raw.answer ?? raw.correctAnswer);
  if (answerText) {
    const index = options.findIndex(
      (opt) => opt.toLowerCase() === answerText.toLowerCase(),
    );
    if (index !== -1) return index;
  }

  return null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
