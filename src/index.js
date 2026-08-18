/**
 * quiz-ai — runtime AI layer for Team Quiz.
 *
 * Two capabilities, both usable independently:
 *   1. generate questions for a topic on demand
 *   2. explain an answer in terms of what the teams actually chose
 *
 * Nothing here knows about Socket.IO or the game engine. The integration
 * point is `createQuizAI()`, which returns plain async functions the socket
 * handlers can call.
 */

import { AnthropicClient } from './anthropic.js';
import { generateQuestions, DIFFICULTIES } from './generate.js';
import { ExplanationService } from './explain.js';
import { QuestionQueue } from './queue.js';
import { debias, debiasBatch, analyseSet, inspect, makeRandom } from './debias.js';
import { validateQuestion, parseJsonLoose } from './schema.js';

export {
  AnthropicClient,
  ExplanationService,
  QuestionQueue,
  generateQuestions,
  debias,
  debiasBatch,
  analyseSet,
  inspect,
  makeRandom,
  validateQuestion,
  parseJsonLoose,
  DIFFICULTIES,
};

/**
 * @param {object} [opts] Passed through to AnthropicClient.
 */
export function createQuizAI(opts = {}) {
  const client = new AnthropicClient(opts);
  const explanations = new ExplanationService({ client }, opts);

  const generate = (args) => generateQuestions({ client }, args);

  return {
    client,
    generate,
    explain: (args) => explanations.explain(args),

    /** One queue per room. The room id is the caller's business. */
    createQueue: (queueOpts) =>
      new QuestionQueue({ generate, fallback: queueOpts?.fallback }, queueOpts),

    /** Cheap enough to expose next to the existing healthz probe. */
    metrics: () => ({
      model: client.model,
      calls: client.usage.calls,
      failures: client.usage.failures,
      retries: client.usage.retries,
      inputTokens: client.usage.inputTokens,
      outputTokens: client.usage.outputTokens,
      averageLatencyMs: client.averageLatencyMs,
      explanationCacheHitRate: explanations.hitRate,
      explanationFallbacks: explanations.stats.fallbacks,
    }),
  };
}
