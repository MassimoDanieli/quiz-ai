import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonLoose, validateQuestion } from '../src/schema.js';

const OPTIONS = [
  'It retries the request with backoff',
  'It closes the connection immediately',
  'It buffers the payload until timeout',
  'It escalates to the parent controller',
];

function raw(overrides = {}) {
  return {
    question: 'What does the client do when the upstream returns 503?',
    options: [...OPTIONS],
    correctLetter: 'A',
    explanation: 'A 503 is transient, so a bounded retry is appropriate.',
    ...overrides,
  };
}

test('parseJsonLoose reads bare JSON', () => {
  const result = parseJsonLoose('[{"a":1}]');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ a: 1 }]);
});

test('parseJsonLoose strips markdown fences', () => {
  const result = parseJsonLoose('```json\n[{"a":1}]\n```');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ a: 1 }]);
});

test('parseJsonLoose recovers JSON buried in prose', () => {
  const result = parseJsonLoose('Here you go:\n[{"a":1}]\nHope that helps.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [{ a: 1 }]);
});

test('parseJsonLoose reports empty and malformed input', () => {
  assert.equal(parseJsonLoose('').ok, false);
  assert.equal(parseJsonLoose('no json at all').ok, false);
  assert.equal(parseJsonLoose('[{"a":}]').ok, false);
});

test('validateQuestion accepts a well-formed question', () => {
  const result = validateQuestion(raw(), { topic: 'http', difficulty: 'medium' });
  assert.equal(result.ok, true);
  assert.equal(result.value.correctIndex, 0);
  assert.equal(result.value.topic, 'http');
  assert.equal(result.value.source, 'ai');
});

test('validateQuestion resolves a numeric index', () => {
  const result = validateQuestion(raw({ correctLetter: undefined, correctIndex: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.value.correctIndex, 2);
});

test('validateQuestion resolves an answer given as literal text', () => {
  const result = validateQuestion(raw({ correctLetter: undefined, answer: OPTIONS[3] }));
  assert.equal(result.ok, true);
  assert.equal(result.value.correctIndex, 3);
});

test('validateQuestion rejects the wrong number of options', () => {
  const result = validateQuestion(raw({ options: OPTIONS.slice(0, 3) }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected 4 options/);
});

test('validateQuestion rejects duplicate options', () => {
  const result = validateQuestion(raw({ options: [OPTIONS[0], OPTIONS[0], OPTIONS[2], OPTIONS[3]] }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /duplicate/);
});

test('validateQuestion rejects an unresolvable answer', () => {
  const result = validateQuestion(raw({ correctLetter: 'Z' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /correct option/);
});

test('validateQuestion rejects empty and non-object input', () => {
  assert.equal(validateQuestion(null).ok, false);
  assert.equal(validateQuestion([]).ok, false);
  assert.equal(validateQuestion(raw({ question: 'short' })).ok, false);
  assert.equal(validateQuestion(raw({ options: ['a', '', 'c', 'd'] })).ok, false);
});
