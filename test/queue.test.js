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

test('prime returns quickly, then reaches the full buffer', async () => {
  const { generate } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'kubernetes', batchSize: 5 });

  const size = await queue.prime();
  assert.equal(size, 2, 'the first wave should be small');

  await new Promise((r) => setTimeout(r, 30));
  assert.ok(queue.size >= 4, `buffer only reached ${queue.size}`);
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
  await new Promise((r) => setTimeout(r, 20)); // let the background top-up land

  // Drain past the refill threshold — the buffer now runs deeper than it did
  // before the two-wave prime, so three takes no longer trip it.
  while (queue.size > queue.refillAt) queue.take();
  queue.take();
  await new Promise((r) => setTimeout(r, 20));

  const lastCall = calls.at(-1);
  assert.ok(lastCall.avoid.length > 0, 'expected asked questions in the avoid list');
});

test('concurrent refills collapse into one in-flight request', async () => {
  const { generate, calls } = stubGenerator({ delayMs: 30 });
  const queue = new QuestionQueue({ generate }, { topic: 'docker' });

  await Promise.all([
    queue.prime({ fast: false }),
    queue.prime({ fast: false }),
    queue.prime({ fast: false }),
  ]);
  assert.equal(calls.length, 1, `expected 1 generation call, saw ${calls.length}`);
});

test('retarget drops the stale buffer and refills on the new topic', async () => {
  const { generate, calls } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });
  await queue.prime();

  const before = calls.length;
  await queue.retarget({ topic: 'terraform', difficulty: 'hard' });

  assert.equal(queue.topic, 'terraform');
  assert.equal(queue.difficulty, 'hard');
  assert.ok(calls.length > before, 'retarget should trigger generation');
  assert.equal(calls.at(-1).avoid.length, 0, 'a new topic starts with a clean avoid list');
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

test('prime returns after a small first batch and tops up in background', async () => {
  const { generate, calls } = stubGenerator({ delayMs: 10 });
  const queue = new QuestionQueue(
    { generate },
    { topic: 'aws', bufferSize: 6, batchSize: 6, primeBatchSize: 2 },
  );

  const size = await queue.prime();
  assert.equal(size, 2, `fast prime should return 2, got ${size}`);
  assert.equal(calls[0].count, 2, 'first wave should be small');

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(queue.size > 2, `background top-up did not run, buffer at ${queue.size}`);
});

test('prime({fast:false}) fills the whole buffer before returning', async () => {
  const { generate } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws', bufferSize: 6, batchSize: 6 });

  const size = await queue.prime({ fast: false });
  assert.ok(size >= 6, `expected a full buffer, got ${size}`);
});

test('a fatal error trips the breaker immediately and stops further calls', async () => {
  const errors = [];
  let calls = 0;
  const generate = async () => {
    calls += 1;
    const err = new Error('Anthropic API rejected the credentials (401).');
    err.fatal = true;
    throw err;
  };

  const queue = new QuestionQueue(
    { generate, fallback: () => makeQuestion(1) },
    { topic: 'aws', onError: (e) => errors.push(e) },
  );

  await queue.prime();
  for (let i = 0; i < 10; i += 1) queue.take();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calls, 1, `expected one doomed call, saw ${calls}`);
  assert.equal(errors.length, 1, 'the failure should be reported once, not per round');
  assert.equal(queue.breakerOpen, true);
  assert.equal(queue.health.fatal, true);
  assert.match(queue.health.message, /credentials/);
});

test('transient errors trip the breaker only after the threshold', async () => {
  let calls = 0;
  const generate = async () => { calls += 1; throw new Error('network wobble'); };
  const queue = new QuestionQueue(
    { generate, fallback: () => makeQuestion(1) },
    { topic: 'aws', breakerThreshold: 3 },
  );

  for (let i = 0; i < 6; i += 1) {
    await queue.prime();
    queue.take();
  }
  assert.equal(calls, 3, `expected to stop at the threshold, saw ${calls} calls`);
  assert.equal(queue.breakerOpen, true);
  assert.equal(queue.health.fatal, false);
});

test('reset re-closes the breaker after the problem is fixed', async () => {
  let shouldFail = true;
  const generate = async ({ count }) => {
    if (shouldFail) { const e = new Error('401'); e.fatal = true; throw e; }
    return { questions: Array.from({ length: count }, (_, i) => makeQuestion(i)), report: {} };
  };
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });

  await queue.prime();
  assert.equal(queue.breakerOpen, true);

  shouldFail = false;
  queue.reset();
  await queue.prime();
  assert.ok(queue.size > 0, 'should generate again after reset');
  assert.equal(queue.health, null);
});

test('seedAsked puts earlier sessions into the avoid list', async () => {
  const { generate, calls } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });

  queue.seedAsked(['What is an availability zone?', 'When does an EBS volume detach?']);
  await queue.prime();

  assert.match(calls[0].avoid.join('|'), /availability zone/);
  assert.equal(calls[0].avoid.length, 2);
});

test('seedAsked keeps the avoid list bounded and ignores junk', () => {
  const { generate } = stubGenerator();
  const queue = new QuestionQueue({ generate }, { topic: 'aws' });

  queue.seedAsked(Array.from({ length: 500 }, (_, i) => `Question number ${i}?`));
  assert.equal(queue.asked.length, 200, 'the tail should be bounded');
  assert.match(queue.asked.at(-1), /499/, 'the most recent should survive');

  queue.seedAsked(null);
  queue.seedAsked(['', '   ', 42]);
  assert.equal(queue.asked.length, 200);
});
