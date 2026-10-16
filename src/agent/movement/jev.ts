import type {
  Db,
  MovementConfig,
  MovementDecisionProvider,
  MovementFailure,
  MovementHttpPort,
  MovementProviderStatus,
  MovementRequest,
  MovementResult,
} from '../../contracts/index.ts';
import { AppError, MOVEMENT_LIMITS, ModelResponseError } from '../../contracts/index.ts';
import { boundRequest, parseWire, wireBody } from './wire.ts';
import { workflowClassifier } from './workflow-provider.ts';

export function jevProvider(
  cfg: MovementConfig,
  deps: { db: Db; now(): Date; sleep(ms: number): Promise<void>; http: MovementHttpPort },
): MovementDecisionProvider {
  const config = { ...cfg };
  const endpoint = config.endpoint;
  const gateway = endpoint === 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
  let reason: MovementFailure | null =
    !gateway && endpoint !== 'https://api.typesafe.ai/v1/systemone'
      ? 'endpoint_blocked'
      : !config.apiKey ||
          !config.model ||
          (gateway ? config.model !== 'typesafe-ai/jev' : !/^jev-\S+$/.test(config.model))
        ? 'missing_config'
        : null;
  let state: MovementProviderStatus['state'] = reason ? 'blocked' : 'ready';
  function fresh(signal: AbortSignal) {
    signal.throwIfAborted();
    deps.db.get('SELECT 1');
  }
  function failed(r: MovementRequest, code: MovementFailure): MovementResult {
    return {
      provider: 'jev',
      execution: 'hosted',
      configuredModel: config.model,
      providerRequestId: null,
      schemaVersion: 1,
      requestId: r.requestId,
      snapshotHash: r.snapshotHash,
      kind: 'failed',
      code,
    };
  }
  return {
    classifyWorkflow: workflowClassifier(config, deps, (failure) => {
      reason = failure;
      state =
        failure === null
          ? 'ready'
          : ['unauthorised', 'missing_config', 'endpoint_blocked'].includes(failure)
            ? 'blocked'
            : 'degraded';
    }),
    status: () => ({
      provider: 'jev',
      execution: 'hosted',
      state,
      reason,
      endpointHost: gateway ? 'ai-gateway.vercel.sh' : 'api.typesafe.ai',
      model: config.model,
    }),
    async decide(input, signal) {
      fresh(signal);
      let r: MovementRequest;
      let body: string;
      try {
        r = boundRequest(structuredClone(input));
        if (!r.options.length)
          return {
            provider: 'jev',
            execution: 'hosted',
            configuredModel: config.model,
            providerRequestId: null,
            schemaVersion: 1,
            requestId: r.requestId,
            snapshotHash: r.snapshotHash,
            kind: 'not_requested',
            code: 'no_destination',
          };
        if (state === 'blocked' && reason) return failed(r, reason);
        if (!endpoint || !config.model || !config.apiKey) return failed(r, 'missing_config');
        body = wireBody(r, config.model);
      } catch (error) {
        const code = error instanceof Error && error.message === 'context_limit' ? 'context_limit' : 'invalid_response';
        if (state !== 'blocked') {
          state = 'degraded';
          reason = code;
        }
        return failed(input, code);
      }
      const deadline = deps.now().getTime() + config.maxAttempts * config.timeoutMs + (config.maxAttempts - 1) * 1000;
      for (let n = 0; n < config.maxAttempts; n++) {
        fresh(signal);
        if (deps.now().getTime() >= deadline) {
          state = 'degraded';
          reason = 'timeout';
          return failed(r, 'timeout');
        }
        let code: MovementFailure = 'unavailable';
        try {
          const response = await deps.http.post({
            url: endpoint,
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body,
            signal,
            timeoutMs: Math.min(config.timeoutMs, deadline - deps.now().getTime()),
            redirect: 'error',
            maxResponseBytes: MOVEMENT_LIMITS.responseBytes,
          });
          fresh(signal);
          if (response.status === 401 || response.status === 403) code = 'unauthorised';
          else if (response.status === 429 || response.status >= 500) code = 'unavailable';
          else if (response.status !== 200) code = 'invalid_response';
          else {
            if (Buffer.byteLength(response.body) > MOVEMENT_LIMITS.responseBytes) code = 'context_limit';
            else {
              const result = parseWire(
                response.body,
                r,
                'hosted',
                config.model,
                response.providerRequestId ?? null,
                gateway,
              );
              fresh(signal);
              state = 'ready';
              reason = null;
              return result;
            }
          }
        } catch (error) {
          fresh(signal);
          code =
            error instanceof ModelResponseError && error.code === 'context_limit'
              ? 'context_limit'
              : error instanceof AppError && error.code === 'forbidden'
                ? 'endpoint_blocked'
                : error instanceof Error && error.name === 'TimeoutError'
                  ? 'timeout'
                  : error instanceof Error && ['invalid_response', 'context_limit'].includes(error.message)
                    ? (error.message as 'invalid_response' | 'context_limit')
                    : 'unavailable';
        }
        if (
          (code === 'unavailable' || code === 'timeout') &&
          n + 1 < config.maxAttempts &&
          deps.now().getTime() + 1000 < deadline
        ) {
          await deps.sleep(1000);
          fresh(signal);
          continue;
        }
        fresh(signal);
        reason = code;
        state = code === 'unauthorised' || code === 'endpoint_blocked' ? 'blocked' : 'degraded';
        return failed(r, code);
      }
      return failed(r, 'unavailable');
    },
  };
}
