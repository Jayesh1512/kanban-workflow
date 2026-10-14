import { html } from 'hono/html';
import type { WebDeps } from './shared.ts';

function reason(code: string | null): string {
  const descriptions: Record<string, string> = {
    no_model: 'No general model configured',
    model_config_missing: 'Server configuration is missing',
    missing_config: 'Server configuration is missing',
    model_endpoint_blocked: 'Destination refused',
    endpoint_blocked: 'Destination refused',
    model_unauthorised: 'Server credentials refused',
    unauthorised: 'Server credentials refused',
    model_configuration_invalid: 'Server configuration is invalid',
    model_unavailable: 'Provider unavailable',
    unavailable: 'Provider unavailable',
    timeout: 'Provider timed out',
    cancelled: 'Request cancelled',
    invalid_response: 'Unusable response',
    stale: 'Evidence changed',
    context_limit: 'Context exceeds the allowed limit',
  };
  return code ? (descriptions[code] ?? 'Provider unavailable') : 'No blocking reason reported';
}
export function providerStatus(deps: WebDeps) {
  const p = deps.pipeline.status();
  return html`<dl class="provider-status"><div><dt>OpenAI · general analysis</dt><dd>${deps.config.model.provider === 'openai' ? reason(deps.model.blocked ?? p.reason) : `Hosted provider not configured: ${reason(deps.model.blocked ?? p.reason)}`} · Pipeline ${p.state}</dd></div><div><dt>Jev · cross-lane judgment</dt><dd>${p.movement.execution === 'hosted' ? `${p.movement.state}: ${reason(p.movement.reason)}` : p.movement.execution === 'replay' ? 'Offline replay; hosted availability unverified' : 'Not configured'}</dd></div></dl><a href="/settings">Provider details</a>`;
}
export function providerDetails(deps: WebDeps) {
  const p = deps.pipeline.status();
  return html`<section><h2>Providers</h2>${providerStatus(deps)}<dl class="settings-data"><dt>General model</dt><dd>${deps.config.model.provider === 'openai' ? deps.model.name : 'Not configured for OpenAI'}</dd><dt>Allowed OpenAI destination</dt><dd>api.openai.com/v1/responses</dd><dt>Configured OpenAI host</dt><dd>${deps.model.endpointHost ?? 'Unavailable'}</dd><dt>Allowed Jev destination</dt><dd>api.typesafe.ai/v1/systemone</dd><dt>Configured Jev host</dt><dd>${p.movement.endpointHost ?? 'Unavailable'}</dd><dt>Jev model</dt><dd>${p.movement.model ?? 'Not configured'}</dd><dt>General response failure</dt><dd>${p.modelFailure ?? 'No failure reported'}</dd></dl><p class="prose">When configured, the official OpenAI service receives bounded relevant context for general analysis. TypeSafe Jev receives bounded movement context exclusively for cross-lane judgment. This context leaves the machine. Offline replay does not establish hosted availability or model quality.</p><p class="prose">Credentials and model configuration are controlled by the server administrator. Configure them in the server environment. This page does not accept provider keys.</p><p><a href="#openai-decision">OpenAI cloud decision</a> · <a href="#jev-decision">Jev movement decision</a></p><details id="openai-decision"><summary>Accepted OpenAI cloud decision</summary><p>OpenAI cloud handles general LLM functions. Keys and the configurable model ID are supplied later through server configuration; no local inference runtime is required. Canonical record: <code>decisions/2026-10-10-openai-cloud-llm.md</code>.</p></details><details id="jev-decision"><summary>Accepted Jev movement decision</summary><p>TypeSafe Jev judges cross-swimlane movement exclusively. Human cross-lane approval and the default threshold of 1 remain. Canonical record: <code>decisions/2026-10-10-jev-swimlane-decisions.md</code>.</p></details></section>`;
}
