# quiz-ai

Runtime AI layer for [Team Quiz](https://quiz.massimodanieli.com/). Two capabilities:

1. **Question generation on demand** — the host names a topic and a difficulty, questions are written on the spot.
2. **Contextual explanations** — after a round, the explanation addresses what each team actually picked, not just why the right answer is right.

Separate repo on purpose. Team Quiz stays a quiz engine; this stays a library it can call. No Socket.IO, no game state, no coupling. If the experiment does not earn its place, deleting it costs one import.

Status: **prototype**. Complete and tested, but not wired into Team Quiz and not deployed.

---

## Running it

```bash
npm test                                  # 43 tests, no network, no key needed
ANTHROPIC_API_KEY=sk-... npm run demo     # bench UI on http://localhost:3100
ANTHROPIC_API_KEY=sk-... npm run smoke    # end-to-end against the real API
```

Zero dependencies — global `fetch`, `node:test`, nothing else. Node 20+.

Without a key everything still runs and falls back to `data/fallback.json`, which is also the fastest way to see the degradation path work.

The bench UI is a control desk, not a product: it shows the question in play on the right, and on the left the buffer depth, latency, cache hit rate, and a live meter of which letter has been correct so far. That meter is the point — see below.

---

## The three problems this had to solve

### Latency

A round has a countdown. Nobody waits two seconds for question N to be written while the clock is meant to be running.

`QuestionQueue` generates question N+1 while N is being played. `take()` is synchronous from the caller's point of view: it returns from the buffer, or from the static set, and never blocks the game loop on a network call. If the buffer runs dry the session continues on static questions — it does not stop.

```js
const queue = ai.createQueue({ topic: 'Kubernetes troubleshooting', bufferSize: 4 });
await queue.prime();          // small first wave, rest fills in background
const { question, source } = queue.take();   // returns immediately, always
```

Two things make the first wait bearable.

**Two waves.** Asking for the whole buffer up front means writing several thousand tokens before anything appears. `prime()` returns after a small first batch and tops up in the background.

**Parallel calls.** Generation latency is output-token bound: one call writing eight questions takes roughly twice as long as two calls writing four, because tokens come out in sequence. Batches are split across concurrent calls (`perCall`, default 3), and the prime wave goes further — one question per call, all in flight — so the host waits for a single question rather than a batch. Parallel calls cannot see each other's output and occasionally collide; deduplication already handles that, and a discarded duplicate is cheaper than the seconds.

Measured on the bench before the split: 13s from topic change to first question.

The same trick applies to explanations, which is where the wait is actually visible — everyone is looking at the screen waiting for the reveal. `prewarm()` fires the explanations for all four options the moment a question goes on screen, so by the time the timer runs out they are cached:

Warming happens when a question enters the buffer, not when it reaches the screen — a round is a few seconds of reading time, but a question sits in the buffer for minutes:

```js
const queue = ai.createQueue({
  topic,
  onEnqueue: (question) => ai.prewarm({ question }),   // warm on the way in
});
// ...rounds later...
await ai.explain({ question, answers });   // cache hit, no wait
```

Warming is bounded (`prewarmConcurrency`, default 4). A background top-up can deliver five questions at once, and four explanations each would be twenty simultaneous calls — enough to slow down the explanation somebody is actually waiting for. Speculative work must never crowd out real work.

Two cases stay slow by construction:

- **The first question of a session** is served the moment it is generated, so there is no warming window. The bench shows this plainly; a real round has a countdown, and the warm-up finishes long before it expires. Meanwhile the reveal shows the static explanation generated with the question, and the contextual one replaces it when it lands — so the wait is never empty.
- **A room split across several wrong options** is a combination that was not warmed, and needs a live call. That is where streaming would earn its keep.

### The bias comes back

The static sets were rebalanced by hand once: option B was correct 95% of the time, and the correct answer was the uniquely longest option in 90% of cases — 55 characters against 16. Learners were answering without knowing the subject.

A language model reintroduces exactly those tells. It knows most about the correct answer, so it writes more about it, and it places it early.

Prompting alone does not fix this. `src/debias.js` is the second layer, and it runs on every question before a player can see it:

- Fisher-Yates shuffle of the options, correct index tracked through
- reject if the correct answer is more than 14 characters longer than every distractor, or more than 1.6× the mean
- reject "all of the above" and friends
- reject an option that quotes the question stem
- `analyseSet()` runs the original position/length audit over anything served, so the same check that caught the 95% can now run against live traffic instead of a static file

Generation over-asks by two and discards. Rejecting a question is cheap; serving a guessable one is not.

### Failing loudly enough

The first real run failed with a 401 and the bench showed the same static question over and over with no explanation why — the error only reached the server console. Degrading silently is worse than degrading.

`QuestionQueue` now carries a circuit breaker. Auth failures are fatal and suspend generation immediately; transient failures suspend it after three in a row, with a cooldown. The error is reported once rather than once per round, and `queue.health` gives the caller something to put on screen. `queue.reset()` clears it after the underlying problem is fixed.

The demo's static fallback also rotates. It used to return `find(...) ?? set[0]`, which is the same question forever — indistinguishable from a hung app.

### Everything the model returns is untrusted input

`src/schema.js` strips markdown fences, recovers JSON from a stray preamble, and validates field by field. It accepts whichever answer encoding the model produced — numeric index, letter, or literal answer text — because it will use all three eventually. Anything that fails is rejected with a reason, and the reason ends up in the report rather than in a player's face.

---

## Layout

```
src/anthropic.js   API client: timeout, bounded retry with jitter, usage counters
src/schema.js      parse and validate model output
src/debias.js      shuffle, tell detection, set-level bias audit
src/generate.js    prompt, validation loop, dedup against the session
src/explain.js     contextual explanation, LRU cache, static fallback
src/queue.js       prefetch buffer
src/index.js       createQuizAI() facade
demo/              bench server and UI
scripts/smoke.js   end-to-end against the real API
```

`createQuizAI()` returns plain async functions. The integration surface with Team Quiz is three calls.

---

## Wiring it into Team Quiz

Sketch, not done yet:

```js
// src/socketHandlers.js
const ai = createQuizAI();
const queues = new Map();   // roomId -> QuestionQueue

socket.on('host:setTopic', async ({ roomId, topic, difficulty }) => {
  queues.get(roomId)?.stop();
  const queue = ai.createQueue({
    topic, difficulty,
    fallback: () => staticSets.next(roomId),   // existing question history logic
  });
  queues.set(roomId, queue);
  io.to(roomId).emit('room:generating');
  await queue.prime();
  io.to(roomId).emit('room:ready', { buffered: queue.size });
});

// where the next question is currently pulled from the static set:
const { question, source } = queues.get(roomId).take();

// after the round closes, non-blocking — the scoreboard does not wait:
ai.explain({ question, answers }).then((e) => io.to(roomId).emit('round:explanation', e));
```

Two things to decide before that lands:

- **Question history.** Team Quiz persists asked-question ids to `/data/state.json` so a set is not repeated. Generated questions have no stable ids across sessions — the queue passes recent stems back into the prompt as an avoid-list, which handles a session but not a cohort seen twice in a term. Persisting generated questions to the same store is probably the answer, and would also build a reusable set over time.
- **Module system.** This is ESM, Team Quiz is CommonJS. The modules have no dependencies, so converting is mechanical — but it is cleaner to leave this ESM and load it dynamically, or keep it as a separate small service.

---

## Governance, before this goes near learners

On your own EC2 with your own key this is a personal project and it ends there.

If the leadership deck lands and Team Quiz becomes a programme tool, an outbound call to a third-party API during a session with learners is a different conversation: data handling, spend ownership, and what happens when the API is down mid-session. The fallback path answers the last one. The first two are not technical problems and are cheaper to raise now than after adoption.

Worth noting in your favour: nothing personal is sent. The prompts contain a topic, a question, and an option index. Team names go in the explanation prompt — that is the only thing worth stripping, and it is one line.

---

## Not built

- Streaming explanations. Pre-warming covers the single-choice case; streaming is the answer for rooms that split across several wrong options.
- Open-response questions graded by the model. The real prize — it stops measuring recognition and starts measuring reasoning — and the largest jump in risk.
- End-of-session debrief for the facilitator: where the cohort was weak, what to revisit.
- Difficulty adaptation from live scores.
- Cost ceiling per room. Currently unbounded; a session is cents, a stuck refill loop is not.
