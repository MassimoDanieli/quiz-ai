/**
 * Runtime de-biasing.
 *
 * The static question sets were rebalanced by hand once: option B was correct
 * 95% of the time, and the correct answer was the uniquely longest option in
 * 90% of cases, averaging 55 characters against 16 for the distractors. A
 * language model reintroduces exactly those tells — the correct answer is the
 * one it knows most about, so it writes more about it, and it tends to place
 * it early.
 *
 * Prompting alone does not fix this reliably. This module is the second layer:
 * every generated question is shuffled and inspected before it can reach a
 * player, and anything still carrying a tell is rejected rather than shipped.
 */

import { OPTION_COUNT } from './schema.js';

/** A correct answer longer than every distractor by more than this many
 *  characters is guessable without knowing the subject. */
export const MAX_LENGTH_MARGIN = 14;

/** Same idea as a ratio, to catch short questions where 14 chars is a lot. */
export const MAX_LENGTH_RATIO = 1.6;

const FILLER_OPTIONS = [
  'all of the above',
  'none of the above',
  'both a and b',
  'all of these',
  'none of these',
  'any of the above',
];

/**
 * Deterministic PRNG (mulberry32) so a seeded shuffle is reproducible in
 * tests and in incident replay.
 */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates over the options, tracking where the correct answer lands.
 *
 * @param {object} question
 * @param {Function} [random]
 * @returns {object} a new question object; the input is not mutated
 */
export function shuffleOptions(question, random = Math.random) {
  const indices = question.options.map((_, i) => i);

  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  return {
    ...question,
    options: indices.map((i) => question.options[i]),
    correctIndex: indices.indexOf(question.correctIndex),
  };
}

/**
 * Inspect a question for the tells that make it answerable without knowledge.
 *
 * @returns {{clean: boolean, issues: string[], metrics: object}}
 */
export function inspect(question) {
  const issues = [];
  const lengths = question.options.map((opt) => opt.length);
  const correctLength = lengths[question.correctIndex];
  const distractorLengths = lengths.filter((_, i) => i !== question.correctIndex);
  const longestDistractor = Math.max(...distractorLengths);
  const meanDistractor =
    distractorLengths.reduce((sum, n) => sum + n, 0) / distractorLengths.length;

  const margin = correctLength - longestDistractor;
  const ratio = meanDistractor === 0 ? Infinity : correctLength / meanDistractor;

  if (margin > MAX_LENGTH_MARGIN) {
    issues.push(`correct answer is ${margin} chars longer than any distractor`);
  }
  if (ratio > MAX_LENGTH_RATIO && margin > 6) {
    issues.push(`correct answer is ${ratio.toFixed(2)}x the mean distractor length`);
  }

  const filler = question.options.filter((opt) =>
    FILLER_OPTIONS.includes(opt.toLowerCase().replace(/[.\s]+$/, '')),
  );
  if (filler.length > 0) {
    issues.push(`filler option present: "${filler[0]}"`);
  }

  // A distractor that merely restates the stem is not a distractor.
  const stem = question.question.toLowerCase();
  const echoing = question.options.filter(
    (opt) => opt.length > 12 && stem.includes(opt.toLowerCase()),
  );
  if (echoing.length > 0) {
    issues.push('an option repeats the question stem');
  }

  if (question.options.length !== OPTION_COUNT) {
    issues.push(`expected ${OPTION_COUNT} options`);
  }

  return {
    clean: issues.length === 0,
    issues,
    metrics: {
      correctLength,
      longestDistractor,
      meanDistractor: Math.round(meanDistractor * 10) / 10,
      margin,
      ratio: Math.round(ratio * 100) / 100,
    },
  };
}

/**
 * The full pipeline for one question: shuffle, then inspect.
 *
 * @returns {{question: object, clean: boolean, issues: string[], metrics: object}}
 */
export function debias(question, random = Math.random) {
  const shuffled = shuffleOptions(question, random);
  return { question: shuffled, ...inspect(shuffled) };
}

/**
 * Run a batch through the pipeline and split it into what is safe to serve
 * and what is not, with reasons attached for the regeneration prompt.
 */
export function debiasBatch(questions, random = Math.random) {
  const accepted = [];
  const rejected = [];

  for (const question of questions) {
    const result = debias(question, random);
    if (result.clean) accepted.push(result.question);
    else rejected.push({ question: result.question, issues: result.issues });
  }

  return { accepted, rejected };
}

/**
 * Aggregate position and length statistics over a set. This is the check that
 * caught the original 95%-B problem; keeping it available means the same
 * check can run against live traffic instead of only against a static file.
 */
export function analyseSet(questions) {
  if (questions.length === 0) {
    return { count: 0, positions: {}, correctIsLongestPct: 0, meanMargin: 0 };
  }

  const positions = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let correctIsLongest = 0;
  let marginSum = 0;

  for (const question of questions) {
    positions[question.correctIndex] = (positions[question.correctIndex] ?? 0) + 1;
    const { metrics } = inspect(question);
    if (metrics.margin > 0) correctIsLongest += 1;
    marginSum += metrics.margin;
  }

  const pct = (n) => Math.round((n / questions.length) * 1000) / 10;

  return {
    count: questions.length,
    positions: {
      A: pct(positions[0]),
      B: pct(positions[1]),
      C: pct(positions[2]),
      D: pct(positions[3]),
    },
    correctIsLongestPct: pct(correctIsLongest),
    meanMargin: Math.round((marginSum / questions.length) * 10) / 10,
  };
}
