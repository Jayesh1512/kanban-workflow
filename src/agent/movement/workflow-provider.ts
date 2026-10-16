import type {
  Db,
  MovementConfig,
  MovementFailure,
  MovementHttpPort,
  WorkflowInferenceRequest,
  WorkflowInferenceResult,
} from '../../contracts/index.ts';
import { MOVEMENT_LIMITS, ModelResponseError } from '../../contracts/index.ts';
import { parseWorkflowWire, workflowWireBody } from './workflow-wire.ts';

export function workflowClassifier(
  cfg: MovementConfig,
  deps: { db: Db; now(): Date; sleep(ms: number): Promise<void>; http: MovementHttpPort },
  status: (failure: MovementFailure | null) => void,
) {
  const config = { ...cfg },
    gateway = config.endpoint === 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
  let terminalFailure: MovementFailure | null = null;
  const fresh = (signal: AbortSignal) => {
    signal.throwIfAborted();
    deps.db.get('SELECT 1');
  };
  return async (input: WorkflowInferenceRequest, signal: AbortSignal): Promise<WorkflowInferenceResult> => {
    fresh(signal);
    const fail = (code: MovementFailure): WorkflowInferenceResult => {
      if (['unauthorised', 'missing_config', 'endpoint_blocked'].includes(code)) terminalFailure = code;
      status(code);
      return { kind: 'failed', code };
    };
    if (terminalFailure) return fail(terminalFailure);
    if (!gateway && config.endpoint !== 'https://api.typesafe.ai/v1/systemone') return fail('endpoint_blocked');
    if (
      !config.apiKey ||
      !config.model ||
      (gateway ? config.model !== 'typesafe-ai/jev' : !/^jev-\S+$/.test(config.model))
    )
      return fail('missing_config');
    const r = structuredClone(input);
    let body: string;
    try {
      body = workflowWireBody(r, config.model);
    } catch (e) {
      return fail(e instanceof Error && e.message === 'context_limit' ? 'context_limit' : 'invalid_response');
    }
    const deadline = deps.now().getTime() + config.maxAttempts * config.timeoutMs + (config.maxAttempts - 1) * 1000;
    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      fresh(signal);
      let code: MovementFailure = 'unavailable';
      if (deps.now().getTime() >= deadline) return fail('timeout');
      try {
        const response = await deps.http.post({
          url: config.endpoint as string,
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
          const result = parseWorkflowWire(response.body, r, config.model, gateway, response.providerRequestId ?? null);
          fresh(signal);
          status(null);
          return result;
        }
      } catch (error) {
        fresh(signal);
        code =
          error instanceof ModelResponseError && error.code === 'context_limit'
            ? 'context_limit'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : error instanceof Error && ['invalid_response', 'context_limit'].includes(error.message)
                ? (error.message as 'invalid_response' | 'context_limit')
                : 'unavailable';
      }
      if (
        ['unavailable', 'timeout'].includes(code) &&
        attempt + 1 < config.maxAttempts &&
        deps.now().getTime() + 1000 < deadline
      ) {
        await deps.sleep(1000);
        fresh(signal);
        continue;
      }
      return fail(code);
    }
    return fail('unavailable');
  };
}
