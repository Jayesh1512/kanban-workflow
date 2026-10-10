import { request as httpsRequest } from 'node:https';
import OpenAI from 'openai';
import type { ModelConfig, MovementHttpPort, OpenAIResponsesPort } from '../contracts/index.ts';
import {
  AppError,
  GENERAL_LIMITS,
  ModelResponseError,
  ModelUnavailable,
  OpenAIResponseRequestSchema,
} from '../contracts/index.ts';

/** Assembly transport injection. Production uses node:https, which has no ambient proxy/auth configuration. */
export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;

function destination(url: string, expected: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('forbidden', 'Provider destination blocked');
  }
  if (parsed.href !== expected || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new AppError('forbidden', 'Provider destination blocked');
}
function boundedOptions(timeoutMs: number, maxResponseBytes: number, maxTimeout: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maxTimeout ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 1048576
  )
    throw new AppError('invalid', 'Invalid provider limits');
}

function nullBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

const nativeFetch: ProviderFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'POST', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined },
      (res) => {
        let finished = false;
        let released = false;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const release = () => {
          if (released) return;
          released = true;
          // Always attempt both releases, including when a transport cleanup itself fails.
          try {
            res.destroy();
          } catch {}
          try {
            req.destroy();
          } catch {}
        };
        const fail = (error: unknown) => {
          if (finished) return;
          finished = true;
          controller?.error(error);
          release();
          reject(error);
        };
        // These handlers also consume late errors after cancellation or a bodyless response.
        res.on('error', fail);
        req.on('error', fail);
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = res.statusCode ?? 502;
          if (nullBody(status)) {
            const response = new Response(null, { status, headers });
            finished = true;
            release();
            resolve(response);
            return;
          }
          const body = new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              res.on('data', (chunk: Buffer) => {
                if (finished) return;
                try {
                  controller?.enqueue(chunk);
                  res.pause();
                } catch (error) {
                  fail(error);
                }
              });
              res.on('end', () => {
                if (finished) return;
                try {
                  controller?.close();
                  finished = true;
                } catch (error) {
                  fail(error);
                }
              });
            },
            pull() {
              if (finished) return;
              try {
                res.resume();
              } catch (error) {
                fail(error);
              }
            },
            cancel() {
              finished = true;
              release();
            },
          });
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          fail(error);
        }
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });

async function boundedPost(url: string, init: RequestInit, bytes: number, send: ProviderFetch): Promise<Response> {
  init.signal?.throwIfAborted();
  const pending = send(url, { ...init, redirect: 'error', credentials: 'omit' });
  let abort: (() => void) | undefined;
  const response = await Promise.race([
    pending.then((r) => {
      if (init.signal?.aborted) {
        void r.body?.cancel().catch(() => {});
        init.signal.throwIfAborted();
      }
      return r;
    }),
    new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('cancelled', 'AbortError'));
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) abort();
    }),
  ]).finally(() => {
    if (abort) init.signal?.removeEventListener('abort', abort);
  });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new AppError('forbidden', 'Provider redirect blocked');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        init.signal?.throwIfAborted();
        const chunk = await reader.read();
        init.signal?.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > bytes) throw new ModelResponseError('context_limit');
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      init.signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  return new Response(nullBody(response.status) ? null : Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}

/** Official SDK bridge only. General envelope parsing and judgment remain A1-owned. No inference at construction. */
export function createOpenAIResponsesPort(
  cfg: ModelConfig,
  send: ProviderFetch = nativeFetch,
): OpenAIResponsesPort | undefined {
  if (cfg.provider !== 'openai' || !cfg.apiKey || !cfg.name) return undefined;
  const apiKey = cfg.apiKey;
  const model = cfg.name;
  return {
    async create(input, options) {
      boundedOptions(options.timeoutMs, options.maxResponseBytes, 60000);
      if (!OpenAIResponseRequestSchema.safeParse(input).success || input.model !== model)
        throw new ModelResponseError('schema_invalid');
      if (Buffer.byteLength(JSON.stringify(input)) > GENERAL_LIMITS.requestBytes)
        throw new ModelResponseError('context_limit');
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
      let transportFailure: unknown;
      // Per-call limits live in this closure; concurrent calls cannot share response caps or signals.
      try {
        const client = new OpenAI({
          apiKey,
          adminAPIKey: null,
          organization: null,
          project: null,
          webhookSecret: null,
          baseURL: 'https://api.openai.com/v1',
          maxRetries: 0,
          timeout: options.timeoutMs,
          logLevel: 'off',
          defaultHeaders: {},
          defaultQuery: {},
          fetch: async (url, init) => {
            try {
              destination(String(url), 'https://api.openai.com/v1/responses');
              if (init?.method !== 'POST') throw new AppError('forbidden', 'Provider operation blocked');
              return await boundedPost(
                String(url),
                {
                  method: 'POST',
                  body: init.body,
                  signal,
                  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                },
                options.maxResponseBytes,
                send,
              );
            } catch (error) {
              transportFailure = error;
              throw error;
            }
          },
        });
        return await client.responses.create(input, { signal, timeout: options.timeoutMs, maxRetries: 0 });
      } catch (error) {
        if (options.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        if (signal.aborted) throw new ModelUnavailable('timeout');
        if (transportFailure instanceof AppError || transportFailure instanceof ModelResponseError)
          throw transportFailure;
        if (error instanceof SyntaxError) throw new ModelResponseError('schema_invalid');
        if (error instanceof OpenAI.APIError) {
          if (error.status === 401 || error.status === 403) throw new ModelResponseError('unauthorised');
          if (error.status === 400) throw new ModelResponseError('unsupported_schema');
        }
        throw new ModelUnavailable();
      }
    },
  };
}

/** Movement HTTP bridge only; question construction/response interpretation and retries remain A1-owned. */
export function createMovementHttpPort(send: ProviderFetch = nativeFetch): MovementHttpPort {
  return {
    async post(input) {
      destination(input.url, 'https://api.typesafe.ai/v1/systemone');
      boundedOptions(input.timeoutMs, input.maxResponseBytes, 30000);
      if (input.redirect !== 'error') throw new AppError('forbidden', 'Provider redirect blocked');
      if (Buffer.byteLength(input.body) > 262144) throw new ModelResponseError('context_limit');
      const auth = input.headers.Authorization ?? input.headers.authorization;
      if (!auth || !/^Bearer \S+$/.test(auth)) throw new AppError('invalid', 'Movement authentication required');
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
      try {
        const response = await boundedPost(
          input.url,
          {
            method: 'POST',
            body: input.body,
            signal,
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
          },
          input.maxResponseBytes,
          send,
        );
        // No invented provider metadata; A1 parses documented body metadata.
        return { status: response.status, body: await response.text() };
      } catch (error) {
        if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
        if (signal.aborted) throw new DOMException('timeout', 'TimeoutError');
        if (error instanceof AppError || error instanceof ModelResponseError) throw error;
        throw new Error('unavailable');
      }
    },
  };
}
