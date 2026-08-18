import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shuffleOptions,
  inspect,
  debias,
  debiasBatch,
  analyseSet,
  makeRandom,
} from '../src/debias.js';

function question(overrides = {}) {
  return {
    question: 'Why does a rolling update stall when a PodDisruptionBudget is too strict?',
    options: [
      'The scheduler cannot find a node with capacity',
      'Eviction is refused because minAvailable is met',
      'The readiness probe never reports success',
      'The image pull secret has expired in namespace',
    ],
    correctIndex: 1,
    explanation: 'Eviction is blocked while draining would breach the budget.',
    ...overrides,
  };
}

test('shuffleOptions keeps the correct answer pointing at the same text', () => {
  const original = question();
  const correctText = original.options[original.correctIndex];

  for (let seed = 0; seed < 50; seed += 1) {
    const shuffled = shuffleOptions(original, makeRandom(seed));
    assert.equal(shuffled.options[shuffled.correctIndex], correctText);
    assert.equal(shuffled.options.length, 4);
    assert.deepEqual([...shuffled.options].sort(), [...original.options].sort());
  }
});

test('shuffleOptions does not mutate its input', () => {
  const original = question();
  const snapshot = JSON.parse(JSON.stringify(original));
  shuffleOptions(original, makeRandom(7));
  assert.deepEqual(original, snapshot);
});

test('shuffleOptions spreads the correct answer across all four positions', () => {
  const counts = [0, 0, 0, 0];
  for (let seed = 0; seed < 400; seed += 1) {
    counts[shuffleOptions(question(), makeRandom(seed)).correctIndex] += 1;
  }
  // The original failure was 95% in one position. Anything roughly even passes.
  for (const count of counts) {
    assert.ok(count > 60, `position under-represented: ${counts.join('/')}`);
    assert.ok(count < 160, `position over-represented: ${counts.join('/')}`);
  }
});

test('inspect passes a question with evenly sized options', () => {
  const result = inspect(question());
  assert.equal(result.clean, true, result.issues.join('; '));
});

test('inspect catches the correct answer being much longer', () => {
  const result = inspect(
    question({
      options: [
        'DNS caching',
        'Eviction is refused because the PodDisruptionBudget minAvailable is already met exactly',
        'Node taint',
        'Bad secret',
      ],
      correctIndex: 1,
    }),
  );
  assert.equal(result.clean, false);
  assert.ok(result.issues.some((i) => i.includes('longer')));
  assert.ok(result.metrics.margin > 14);
});

test('inspect catches filler options', () => {
  const result = inspect(
    question({
      options: ['Option one here', 'Option two here', 'Option three ok', 'All of the above'],
      correctIndex: 0,
    }),
  );
  assert.equal(result.clean, false);
  assert.ok(result.issues.some((i) => i.includes('filler')));
});

test('inspect catches an option that quotes the stem', () => {
  const result = inspect(
    question({
      question: 'Which statement about eventual consistency is correct here today?',
      options: [
        'Eventual consistency is correct',
        'Writes are ordered globally always',
        'Reads always see the last write',
        'Replicas converge given no writes',
      ],
      correctIndex: 3,
    }),
  );
  assert.equal(result.clean, false);
});

test('debias returns a shuffled question plus its verdict', () => {
  const result = debias(question(), makeRandom(3));
  assert.equal(typeof result.clean, 'boolean');
  assert.ok(Array.isArray(result.issues));
  assert.equal(result.question.options.length, 4);
});

test('debiasBatch separates clean questions from tell-carrying ones', () => {
  const dirty = question({
    options: [
      'Short',
      'A considerably longer and more detailed correct answer than the rest',
      'Tiny',
      'Brief',
    ],
    correctIndex: 1,
  });

  const { accepted, rejected } = debiasBatch([question(), dirty, question()], makeRandom(11));
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].issues.length > 0);
});

test('analyseSet reports position distribution and length margin', () => {
  const set = Array.from({ length: 200 }, (_, i) =>
    shuffleOptions(question(), makeRandom(i)),
  );
  const stats = analyseSet(set);

  assert.equal(stats.count, 200);
  for (const letter of ['A', 'B', 'C', 'D']) {
    assert.ok(stats.positions[letter] > 15, `${letter} at ${stats.positions[letter]}%`);
    assert.ok(stats.positions[letter] < 35, `${letter} at ${stats.positions[letter]}%`);
  }
});

test('analyseSet handles an empty set', () => {
  assert.equal(analyseSet([]).count, 0);
});
