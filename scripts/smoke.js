/**
 * End-to-end smoke test against the real API.
 * Costs a few thousand tokens. Needs ANTHROPIC_API_KEY.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run smoke
 */

import { createQuizAI, analyseSet } from '../src/index.js';

const topic = process.argv[2] || 'Kubernetes troubleshooting';
const rounds = Number(process.argv[3] || 6);

const ai = createQuizAI();
const queue = ai.createQueue({ topic, difficulty: 'medium', onError: (e) => console.error(' !', e.message) });

console.log(`topic: ${topic}\nmodel: ${ai.client.model}\n`);

const t0 = Date.now();
await queue.prime();
console.log(`primed ${queue.size} questions in ${Date.now() - t0} ms\n`);

const served = [];
for (let i = 1; i <= rounds; i += 1) {
  const started = Date.now();
  const { question, source } = queue.take();
  if (!question) { console.log(`${i}. nothing available`); continue; }
  served.push(question);

  console.log(`${i}. [${source}] ${question.question}`);
  question.options.forEach((opt, j) => {
    const mark = j === question.correctIndex ? '*' : ' ';
    console.log(`   ${mark} ${'ABCD'[j]}. ${opt}  (${opt.length})`);
  });
  console.log(`   take: ${Date.now() - started} ms, buffer now ${queue.size}`);

  const wrong = (question.correctIndex + 1) % 4;
  const explanation = await ai.explain({
    question,
    answers: [{ team: 'Blue', choiceIndex: wrong }, { team: 'Red', choiceIndex: question.correctIndex }],
  });
  console.log(`   explain [${explanation.source}, ${explanation.latencyMs} ms]: ${explanation.text}\n`);
}

console.log('bias over served set:', analyseSet(served));
console.log('metrics:', ai.metrics());
queue.stop();
