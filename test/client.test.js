import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicClient } from '../src/anthropic.js';
import { ExplanationService } from '../src/explain.js';
import { generateQuestions } from '../src/generate.js';
import { makeRandom } from '../src/debias.js';

/** Build a fake fetch that replays a queue of scripted responses. */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (typeof next === 'function') return next();
    return next;
  };
  return { impl, calls };
}

function textResponse(text, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      model: 'test-model',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    text: async () => text,
  };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => 'upstream error', json: async () => ({}) };
}

const client = (responses, opts = {}) => {
  const { impl, calls } = fakeFetch(responses);
  return {
    client: new AnthropicClient({ apiKey: 'test-key', fetchImpl: impl, ...opts }),
    calls,
  };
};

test('complete returns the concatenated text blocks and records usage', async () => {
  const { client: c } = client([textResponse('hello')]);
  const result = await c.complete({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.text, 'hello');
  assert.equal(c.usage.calls, 1);
  assert.equal(c.usage.inputTokens, 100);
  assert.equal(c.usage.outputTokens, 50);
});

test('complete retries a 503 and succeeds', async () => {
  let served = 0;
  const { client: c } = client([
    () => {
      served += 1;
      return served === 1 ? errorResponse(503) : textResponse('recovered');
    },
  ]);

  const result = await c.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.text, 'recovered');
  assert.equal(c.usage.retries, 1);
});

test('complete does not retry a 400', async () => {
  const { client: c, calls } = client([errorResponse(400)]);
  await assert.rejects(() => c.complete({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(calls.length, 1);
  assert.equal(c.usage.failures, 1);
});

test('complete fails clearly when no API key is configured', async () => {
  const c = new AnthropicClient({ apiKey: undefined, fetchImpl: async () => textResponse('x') });
  await assert.rejects(
    () => c.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    /ANTHROPIC_API_KEY/,
  );
});

const GENERATED = JSON.stringify([
  {
    question: 'Why does a pod stay Pending when the cluster has spare capacity?',
    options: [
      'A node taint has no matching toleration',
      'The container image tag was not found',
      'The liveness probe failed three times',
      'The service account token has expired',
    ],
    correctLetter: 'A',
    explanation: 'Taints repel pods that do not tolerate them, regardless of capacity.',
  },
  {
    question: 'What happens to an EBS-backed pod rescheduled to another zone?',
    options: [
      'It stays Pending, the volume is zone-bound',
      'It starts and the volume follows it over',
      'It starts with an empty volume attached',
      'It fails immediately with CrashLoopBackOff',
    ],
    correctLetter: 'A',
    explanation: 'EBS volumes are bound to one availability zone.',
  },
]);

test('generateQuestions validates, de-biases and reports on a batch', async () => {
  const { client: c, calls } = client([textResponse(GENERATED)]);
  const { questions, report } = await generateQuestions(
    { client: c },
    { topic: 'kubernetes', difficulty: 'hard', count: 2, overAsk: 0, random: makeRandom(5) },
  );

  assert.equal(questions.length, 2);
  assert.equal(report.invalid.length, 0);
  assert.equal(report.delivered, 2);
  for (const question of questions) {
    assert.equal(question.topic, 'kubernetes');
    assert.equal(question.difficulty, 'hard');
    assert.ok(question.id);
    assert.ok(question.options[question.correctIndex]);
  }
  assert.match(calls[0].body.messages[0].content, /Topic: kubernetes/);
});

test('generateQuestions passes already-asked stems into the prompt', async () => {
  const { client: c, calls } = client([textResponse(GENERATED)]);
  await generateQuestions(
    { client: c },
    { topic: 'kubernetes', count: 1, overAsk: 0, avoid: ['What is a ReplicaSet?'] },
  );
  assert.match(calls[0].body.messages[0].content, /already been asked/);
  assert.match(calls[0].body.messages[0].content, /ReplicaSet/);
});

test('generateQuestions rejects an unknown difficulty', async () => {
  const { client: c } = client([textResponse(GENERATED)]);
  await assert.rejects(
    () => generateQuestions({ client: c }, { topic: 'aws', difficulty: 'brutal' }),
    /difficulty/,
  );
});

test('generateQuestions surfaces unreadable model output', async () => {
  const { client: c } = client([textResponse('sorry, I cannot do that')]);
  await assert.rejects(
    () => generateQuestions({ client: c }, { topic: 'aws' }),
    /Could not read/,
  );
});

const QUESTION = {
  id: 'k8s-1',
  question: 'Why does a pod stay Pending when the cluster has spare capacity?',
  options: [
    'A node taint has no matching toleration',
    'The container image tag was not found',
    'The liveness probe failed three times',
    'The service account token has expired',
  ],
  correctIndex: 0,
  explanation: 'Taints repel pods that do not tolerate them.',
};

test('explain calls the model and caches the result', async () => {
  const { client: c, calls } = client([textResponse('Capacity is not the only gate.')]);
  const service = new ExplanationService({ client: c });
  const answers = [{ team: 'Blue', choiceIndex: 1 }];

  const first = await service.explain({ question: QUESTION, answers });
  const second = await service.explain({ question: QUESTION, answers });

  assert.equal(first.source, 'model');
  assert.equal(second.source, 'cache');
  assert.equal(second.text, first.text);
  assert.equal(calls.length, 1);
  assert.equal(service.hitRate, 50);
});

test('explain tells the model which option each team picked', async () => {
  const { client: c, calls } = client([textResponse('ok')]);
  const service = new ExplanationService({ client: c });
  await service.explain({
    question: QUESTION,
    answers: [{ team: 'Red', choiceIndex: 2 }],
  });

  const prompt = calls[0].body.messages[0].content;
  assert.match(prompt, /Red chose C/);
  assert.match(prompt, /<- correct/);
});

test('explain falls back to the static text when the model is unavailable', async () => {
  const { client: c } = client([errorResponse(500)], { maxRetries: 0 });
  const service = new ExplanationService({ client: c });

  const result = await service.explain({ question: QUESTION, answers: [] });
  assert.equal(result.source, 'fallback');
  assert.match(result.text, /A node taint/);
  assert.equal(service.stats.fallbacks, 1);
});

test('the explanation cache evicts least-recently-used entries', async () => {
  const { client: c } = client([textResponse('x')]);
  const service = new ExplanationService({ client: c }, { cacheSize: 2 });

  for (const choiceIndex of [1, 2, 3]) {
    await service.explain({ question: QUESTION, answers: [{ team: 'A', choiceIndex }] });
  }
  assert.equal(service.cache.size, 2);
});

test('generateQuestions splits the batch across parallel calls', async () => {
  const { client: c, calls } = client([textResponse(GENERATED)]);
  await generateQuestions(
    { client: c },
    { topic: 'kubernetes', count: 6, overAsk: 2, perCall: 3 },
  );
  // 8 requested at 3 per call = 3 calls.
  assert.equal(calls.length, 3, `expected 3 parallel calls, saw ${calls.length}`);
});

test('generateQuestions survives one failed call out of several', async () => {
  let n = 0;
  const { client: c } = client([
    () => (++n === 1 ? errorResponse(500) : textResponse(GENERATED)),
  ], { maxRetries: 0 });

  const { questions, report } = await generateQuestions(
    { client: c },
    { topic: 'kubernetes', count: 2, overAsk: 1, perCall: 1 },
  );

  assert.ok(questions.length > 0, 'partial results should still be usable');
  assert.equal(report.callsFailed, 1);
});

test('generateQuestions rethrows a fatal error when every call fails', async () => {
  const { client: c } = client([errorResponse(401)], { maxRetries: 0 });
  await assert.rejects(
    () => generateQuestions({ client: c }, { topic: 'aws', count: 2, perCall: 1 }),
    (err) => err.fatal === true && /credentials/.test(err.message),
  );
});

test('prewarm caches an explanation for every option', async () => {
  const { client: c, calls } = client([textResponse('warm')]);
  const service = new ExplanationService({ client: c });

  const result = await service.prewarm({ question: QUESTION });
  assert.equal(result.warmed, 4);
  assert.equal(calls.length, 4);

  const hit = await service.explain({
    question: QUESTION,
    answers: [{ team: 'Blue', choiceIndex: 2 }],
  });
  assert.equal(hit.source, 'cache');
  assert.equal(calls.length, 4, 'a warmed option should not call the API again');
});
