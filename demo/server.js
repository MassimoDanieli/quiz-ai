/**
 * Demo harness. Not production code — no auth, no rate limiting, single room.
 * It exists so the two capabilities can be driven by hand before deciding
 * whether they belong in Team Quiz.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run demo
 *   open http://localhost:3100
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createQuizAI } from '../src/index.js';
import { analyseSet } from '../src/debias.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3100);

const fallbackSet = JSON.parse(
  await fs.readFile(path.join(HERE, '..', 'data', 'fallback.json'), 'utf8'),
);

const ai = createQuizAI({
  timeoutMs: Number(process.env.AI_TIMEOUT_MS || 12000),
});

/** One queue, because this is a demo. In Team Quiz it would be one per room. */
let queue = null;
/** Everything served so far, so the bias statistics mean something. */
const served = [];

const routes = {
  'POST /api/queue/start': async (body) => {
    queue?.stop();
    queue = ai.createQueue({
      topic: body.topic,
      difficulty: body.difficulty || 'medium',
      bufferSize: 4,
      fallback: ({ topic }) =>
        fallbackSet.find((q) => q.topic === topic) ?? fallbackSet[0],
      onError: (err) => console.error('[queue]', err.message),
    });
    const startedAt = Date.now();
    const size = await queue.prime();
    return { buffered: size, primeMs: Date.now() - startedAt };
  },

  'POST /api/queue/next': async () => {
    if (!queue) throw new HttpError(409, 'Start a topic first');
    const { question, source } = queue.take();
    if (!question) throw new HttpError(503, 'No question available yet — try again in a moment');
    served.push(question);
    return { question, source, buffered: queue.size, stats: queue.stats };
  },

  'POST /api/explain': async (body) => {
    if (!body.question) throw new HttpError(400, 'question is required');
    return ai.explain({ question: body.question, answers: body.answers ?? [] });
  },

  'GET /api/metrics': async () => ({
    ...ai.metrics(),
    served: served.length,
    bias: analyseSet(served),
    queue: queue ? { topic: queue.topic, buffered: queue.size, ...queue.stats } : null,
  }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await fs.readFile(path.join(HERE, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const handler = routes[route];
  if (!handler) {
    send(res, 404, { error: `No route for ${route}` });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await handler(body));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[demo]', err);
    send(res, status, { error: err.message });
  }
});

server.listen(PORT, () => {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log(`quiz-ai demo listening on http://localhost:${PORT}`);
  console.log(`model: ${ai.client.model}`);
  if (!key) console.log('ANTHROPIC_API_KEY is not set — every call will fall back to the static set');
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}
