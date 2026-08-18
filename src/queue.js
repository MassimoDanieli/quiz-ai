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
      onError = () => {},
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
    this.onError = onError;

    this.buffer = [];
    this.asked = [];
    this.refilling = null;
    this.stopped = false;
    this.stats = { served: 0, fromBuffer: 0, fromFallback: 0, refills: 0, errors: 0 };
  }

  get size() {
    return this.buffer.length;
  }

  get starved() {
    return this.buffer.length === 0;
  }

  /** Fill the buffer before the first round. Safe to await; safe to skip. */
  async prime() {
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
  async #refill() {
    if (this.stopped) return;
    if (this.refilling) return this.refilling;
    if (this.buffer.length >= this.bufferSize) return;

    const wanted = Math.max(this.batchSize, this.bufferSize - this.buffer.length);

    this.refilling = (async () => {
      try {
        this.stats.refills += 1;
        const { questions } = await this.generate({
          topic: this.topic,
          difficulty: this.difficulty,
          count: wanted,
          avoid: this.asked,
        });
        if (this.stopped) return;
        this.buffer.push(...questions);
      } catch (err) {
        this.stats.errors += 1;
        this.onError(err);
      } finally {
        this.refilling = null;
      }
    })();

    return this.refilling;
  }
}
