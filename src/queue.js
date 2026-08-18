/**
 * Prefetch buffer.
 *
 * A round has a countdown. Nobody can wait three seconds for question N to be
 * written while the clock is meant to be running, so question N+1 is generated
 * while N is being played. `take()` is synchronous from the caller's point of
 * view: it returns from the buffer, or from the static set, and never blocks
 * the game loop on a network call.
 *
 * This is the piece that decides whether the AI layer is a feature or a
 * liability. If the buffer runs dry the session continues on static questions;
 * it does not stop.
 */

export class QuestionQueue {
  /**
   * @param {object} deps
   * @param {Function} deps.generate    async ({topic, difficulty, count, avoid}) => {questions, report}
   * @param {Function} [deps.fallback]  ({topic, difficulty}) => question|null
   * @param {object} [opts]
   * @param {string} opts.topic
   * @param {string} [opts.difficulty]
   * @param {number} [opts.bufferSize]  Questions kept ready. Default 4.
   * @param {number} [opts.refillAt]    Refill when the buffer drops to this. Default 2.
   * @param {number} [opts.batchSize]   Questions per generation call. Default 5.
   * @param {Function} [opts.onError]   Called with generation failures.
   */
  constructor(
    { generate, fallback = () => null },
    {
      topic,
      difficulty = 'medium',
      bufferSize = 4,
      refillAt = 2,
      batchSize = 5,
      primeBatchSize = 2,
      breakerThreshold = 3,
      breakerCooldownMs = 60000,
      onError = () => {},
      onEnqueue = () => {},
    } = {},
  ) {
    if (typeof generate !== 'function') throw new TypeError('generate is required');
    if (!topic) throw new TypeError('topic is required');

    this.generate = generate;
    this.fallback = fallback;
    this.topic = topic;
    this.difficulty = difficulty;
    this.bufferSize = bufferSize;
    this.refillAt = refillAt;
    this.batchSize = batchSize;
    this.primeBatchSize = primeBatchSize;
    this.onError = onError;
    this.onEnqueue = onEnqueue;

    this.buffer = [];
    this.asked = [];
    this.refilling = null;
    this.stopped = false;

    /**
     * Circuit breaker. A 401 will still be a 401 in four seconds; retrying it
     * once per round produces a wall of identical log lines and hides the one
     * fact that matters. After `breakerThreshold` consecutive failures — or
     * immediately on a fatal error — generation is suspended and `lastError`
     * is left where the caller can surface it.
     */
    this.breakerThreshold = breakerThreshold;
    this.breakerCooldownMs = breakerCooldownMs;
    this.consecutiveErrors = 0;
    this.openedAt = null;
    this.fatal = false;
    this.lastError = null;

    this.stats = { served: 0, fromBuffer: 0, fromFallback: 0, refills: 0, errors: 0 };
  }

  get size() {
    return this.buffer.length;
  }

  get starved() {
    return this.buffer.length === 0;
  }

  /** True while generation is suspended. Fatal errors never re-close. */
  get breakerOpen() {
    if (this.fatal) return true;
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt < this.breakerCooldownMs) return true;
    this.openedAt = null;
    this.consecutiveErrors = 0;
    return false;
  }

  /**
   * What the caller should tell the user. `null` when everything is healthy.
   * @returns {{message: string, fatal: boolean, retryInMs: number|null}|null}
   */
  get health() {
    if (!this.lastError) return null;
    if (!this.fatal && !this.breakerOpen && this.buffer.length > 0) return null;
    return {
      message: this.lastError.message,
      fatal: this.fatal,
      retryInMs: this.fatal
        ? null
        : Math.max(0, this.breakerCooldownMs - (Date.now() - (this.openedAt ?? 0))),
    };
  }

  /** Clear a tripped breaker after fixing the underlying problem. */
  reset() {
    this.consecutiveErrors = 0;
    this.openedAt = null;
    this.fatal = false;
    this.lastError = null;
  }

  /**
   * Fill the buffer before the first round.
   *
   * Deliberately two-wave: a small first batch so the host is not staring at
   * a spinner while 3000 tokens are written, then a background top-up to the
   * full buffer size while the first question is being played.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.fast] Return as soon as the first small batch lands.
   */
  async prime({ fast = true } = {}) {
    if (fast && this.primeBatchSize < this.bufferSize) {
      await this.#refill({ want: this.primeBatchSize, fast: true });
      // Top up to bufferSize without blocking the caller.
      if (this.size > 0) this.#refill().catch(() => {});
      return this.size;
    }

    await this.#refill();
    return this.size;
  }

  /**
   * Hand out the next question. Never blocks on the network.
   * Triggers a background refill when the buffer gets low.
   *
   * @returns {{question: object|null, source: 'ai'|'fallback'|'none'}}
   */
  take() {
    let question = this.buffer.shift() ?? null;
    let source = 'ai';

    if (!question) {
      question = this.fallback({ topic: this.topic, difficulty: this.difficulty });
      source = question ? 'fallback' : 'none';
    }

    if (question) {
      this.stats.served += 1;
      this.stats[source === 'ai' ? 'fromBuffer' : 'fromFallback'] += 1;
      this.asked.push(question.question);
      if (this.asked.length > 60) this.asked.shift();
    }

    if (this.buffer.length <= this.refillAt) {
      // Fire and forget: the current round must not wait for this.
      this.#refill().catch(() => {});
    }

    return { question, source };
  }

  /**
   * Tell the queue about questions written in earlier sessions, so the
   * generator is asked not to repeat them.
   *
   * Without this a restart loses the avoid-list and the model cheerfully
   * rewrites the same questions it wrote yesterday — which the caller then
   * discards as duplicates, having paid for them.
   *
   * @param {string[]} stems Question texts.
   */
  seedAsked(stems) {
    if (!Array.isArray(stems)) return 0;
    for (const stem of stems) {
      if (typeof stem === 'string' && stem.trim()) this.asked.push(stem.trim());
    }
    // The prompt only carries the most recent slice, so keep the tail bounded
    // rather than growing a list that is mostly never sent.
    const MAX = 200;
    if (this.asked.length > MAX) this.asked = this.asked.slice(-MAX);
    return this.asked.length;
  }

  /** Change topic mid-session. Drops the buffer, since it is now off-topic. */
  async retarget({ topic, difficulty } = {}) {
    if (topic) this.topic = topic;
    if (difficulty) this.difficulty = difficulty;
    this.buffer = [];
    return this.prime();
  }

  stop() {
    this.stopped = true;
    this.buffer = [];
  }

  /** One refill at a time: concurrent calls join the in-flight promise. */
  async #refill({ want, fast = false } = {}) {
    if (this.stopped) return;
    if (this.breakerOpen) return;
    if (this.refilling) return this.refilling;
    if (this.buffer.length >= this.bufferSize) return;

    const wanted = want ?? Math.max(this.batchSize, this.bufferSize - this.buffer.length);

    this.refilling = (async () => {
      try {
        this.stats.refills += 1;
        const { questions } = await this.generate({
          topic: this.topic,
          difficulty: this.difficulty,
          count: wanted,
          avoid: this.asked,
          // The first wave is what the host waits for, so it is split as far
          // as it goes: one question per call, all in flight together. The
          // wait becomes the time to write a single question rather than a
          // batch. Later refills happen in the background and can batch
          // normally, which is cheaper.
          ...(fast ? { perCall: 1, overAsk: 1 } : {}),
        });
        if (this.stopped) return;

        this.buffer.push(...questions);
        this.consecutiveErrors = 0;
        this.openedAt = null;
        this.lastError = null;

        // Let the caller start work that should finish before these are served
        // — warming explanations, most obviously.
        for (const question of questions) {
          try {
            this.onEnqueue(question);
          } catch { /* a hook must never break the refill */ }
        }
      } catch (err) {
        this.stats.errors += 1;
        this.consecutiveErrors += 1;
        this.lastError = err;

        if (err?.fatal) {
          this.fatal = true;
          this.openedAt = Date.now();
        } else if (this.consecutiveErrors >= this.breakerThreshold) {
          this.openedAt = Date.now();
        }

        // Report once when the breaker trips, not once per round after that.
        if (this.openedAt === null || this.consecutiveErrors <= this.breakerThreshold) {
          this.onError(err);
        }
      } finally {
        this.refilling = null;
      }
    })();

    return this.refilling;
  }
}
