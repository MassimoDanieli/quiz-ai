/**
 * Minimal Anthropic Messages API client.
 *
 * Deliberately dependency-free: global fetch, AbortController, no SDK.
 * Everything the quiz runtime needs is here — timeout, bounded retry with
 * jitter, and usage accounting so latency and token spend are observable
 * per call rather than guessed at after the fact.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Errors worth retrying: transient transport and server-side conditions. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Errors that will never fix themselves: retrying is pure noise. */
const FATAL_STATUS = new Set([401, 403]);

export class AnthropicError extends Error {
  constructor(message, { status, body, retryable = false, fatal = false } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    /** A configuration problem, not a transient one. Stop trying, tell someone. */
    this.fatal = fatal;
  }
}

export class AnthropicClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]      Defaults to ANTHROPIC_API_KEY.
   * @param {string} [opts.model]       Defaults to ANTHROPIC_MODEL.
   * @param {number} [opts.timeoutMs]   Per-attempt timeout. Default 8000.
   * @param {number} [opts.maxRetries]  Retries after the first attempt. Default 2.
   * @param {Function} [opts.fetchImpl] Injectable for tests.
   */
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    timeoutMs = 8000,
    maxRetries = 2,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;

    /** Cumulative counters. Cheap to expose on a /healthz-style endpoint. */
    this.usage = {
      calls: 0,
      failures: 0,
      retries: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalLatencyMs: 0,
    };
  }

  get averageLatencyMs() {
    return this.usage.calls === 0
      ? 0
      : Math.round(this.usage.totalLatencyMs / this.usage.calls);
  }

  /**
   * Send a Messages request and return the concatenated text blocks.
   *
   * @param {object} opts
   * @param {Array}  opts.messages
   * @param {string} [opts.system]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   * @param {string} [opts.model]        Per-call model override.
   * @param {AbortSignal} [opts.signal]  Caller-side cancellation.
   * @returns {Promise<{text: string, model: string, latencyMs: number, usage: object}>}
   */
  async complete({
    messages,
    system,
    maxTokens = 1500,
    temperature = 1,
    model = this.model,
    signal,
  }) {
    if (!this.apiKey) {
      throw new AnthropicError('ANTHROPIC_API_KEY is not set', {
        retryable: false,
        fatal: true,
      });
    }

    const payload = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages,
      ...(system ? { system } : {}),
    };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        this.usage.retries += 1;
        await sleep(backoffMs(attempt));
      }

      const startedAt = Date.now();
      try {
        const result = await this.#attempt(payload, signal);
        const latencyMs = Date.now() - startedAt;

        this.usage.calls += 1;
        this.usage.totalLatencyMs += latencyMs;
        this.usage.inputTokens += result.usage?.input_tokens ?? 0;
        this.usage.outputTokens += result.usage?.output_tokens ?? 0;

        return { ...result, latencyMs };
      } catch (err) {
        lastError = err;
        if (!(err instanceof AnthropicError) || !err.retryable) break;
        if (signal?.aborted) break;
      }
    }

    this.usage.failures += 1;
    throw lastError;
  }

  async #attempt(payload, callerSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await this.fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await safeText(response);
        const fatal = FATAL_STATUS.has(response.status);
        throw new AnthropicError(
          fatal
            ? `Anthropic API rejected the credentials (${response.status}). Check ANTHROPIC_API_KEY.`
            : `Anthropic API returned ${response.status}`,
          {
            status: response.status,
            body,
            retryable: RETRYABLE_STATUS.has(response.status),
            fatal,
          },
        );
      }

      const data = await response.json();
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      if (!text) {
        throw new AnthropicError('Response contained no text blocks', {
          status: response.status,
          retryable: true,
        });
      }

      return { text, model: data.model ?? payload.model, usage: data.usage };
    } catch (err) {
      if (err instanceof AnthropicError) throw err;
      // AbortError from our own timeout, or a transport-level failure.
      throw new AnthropicError(`Request failed: ${err.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

function backoffMs(attempt) {
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 150);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
