import test from 'node:test';
import assert from 'node:assert/strict';

import { QuestionQueue } from '../src/queue.js';

function makeQuestion(n) {
  return {
    id: `q${n}`,
    question: `Generated question number ${n} about the topic at hand?`,
    options: ['Option one', 'Option two', 'Option three', 'Option four'],
    correctIndex: n % 4,
  };
}

/** A generator that hands back sequential questions after an optional delay. */
function stubGenerator({ delayMs = 0, failTimes = 0 } = {}) {
  let counter = 0;
  let failures = 0;
  const calls = [];

  const generate = async ({ count, avoid }) => {
    calls.push({ count, avoid: [...(avoid ?? [])] });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failures < failTimes) {
      failures += 1;
      throw new Error('generation failed');
    }
    const questions = Array.from({ length: count }, () => makeQuestion(counter++));
    return { questions, report: {} };
  };

  return { generate, calls };
}

test('prime fills the buffer before the first round', async () => {
  const { generate } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'kubernetes', batchSize: 5 });

  const size = await queue.prime();
  assert.ok(size >= 4, `buffer only reached ${size}`);
});

test('take returns buffered questions without awaiting the network', async () => {
  const { generate } = stubGenerator({ delayMs: 50 });
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });
  await queue.prime();

  const started = Date.now();
  const { question, source } = queue.take();
  const elapsed = Date.now() - started;

  assert.ok(question, 'expected a question');
  assert.equal(source, 'ai');
  assert.ok(elapsed < 20, `take blocked for ${elapsed}ms`);
});

test('take falls back to the static set when the buffer is empty', () => {
  const { generate } = stubGenerator({ delayMs: 1000 });
  const fallbackQuestion = makeQuestion(999);
  const queue = new QuestionQueue(
    { generate, fallback: () => fallbackQuestion },
    { topic: 'linux' },
  );

  const { question, source } = queue.take();
  assert.equal(source, 'fallback');
  assert.equal(question.id, 'q999');
  assert.equal(queue.stats.fromFallback, 1);
});

test('take reports none when there is nothing to serve at all', () => {
  const { generate } = stubGenerator({ delayMs: 1000 });
  const queue = new QuestionQueue({ generate }, { topic: 'linux' });

  const { question, source } = queue.take();
  assert.equal(question, null);
  assert.equal(source, 'none');
});

test('a generation failure does not throw into the game loop', async () => {
  const errors = [];
  const { generate } = stubGenerator({ failTimes: 1 });
  const queue = new QuestionQueue(
    { generate, fallback: () => makeQuestion(0) },
    { topic: 'git', onError: (e) => errors.push(e) },
  );

  await queue.prime();
  assert.equal(errors.length, 1);
  assert.equal(queue.stats.errors, 1);

  const { source } = queue.take();
  assert.equal(source, 'fallback');
});

test('asked questions are passed to the generator so it can avoid repeats', async () => {
  const { generate, calls } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'sql', bufferSize: 4, refillAt: 2 });
  await queue.prime();

  queue.take();
  queue.take();
  queue.take();
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = calls.at(-1);
  assert.ok(lastCall.avoid.length > 0, 'expected asked questions in the avoid list');
});

test('concurrent refills collapse into one in-flight request', async () => {
  const { generate, calls } = stubGenerator({ delayMs: 30 });
  const queue = new QuestionQueue({ generate }, { topic: 'docker' });

  await Promise.all([queue.prime(), queue.prime(), queue.prime()]);
  assert.equal(calls.length, 1, `expected 1 generation call, saw ${calls.length}`);
});

test('retarget drops the stale buffer and refills on the new topic', async () => {
  const { generate, calls } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });
  await queue.prime();

  await queue.retarget({ topic: 'terraform', difficulty: 'hard' });

  assert.equal(queue.topic, 'terraform');
  assert.equal(queue.difficulty, 'hard');
  assert.equal(calls.length, 2);
  assert.ok(queue.size > 0);
});

test('stop empties the buffer and blocks further refills', async () => {
  const { generate } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });
  await queue.prime();

  queue.stop();
  assert.equal(queue.size, 0);

  await queue.prime();
  assert.equal(queue.size, 0);
});
