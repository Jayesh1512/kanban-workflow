import type { ServiceStatus } from '../shared/domain.js';
import type { Clock, Database, JevPort, RuntimeConfig, SqlExecutor } from '../shared/ports.js';
import { hash } from './sql.js';

export const JEV_BREAKER_KEY = 'workflow:jev:breaker';
export const JEV_INITIALIZED_KEY = 'workflow:jev:initialized';
type BreakerState = { paused: boolean; code: 'entitlement' | 'unconfigured' | 'unavailable'; revision: string; changedAt: string };
export async function resetJevBreaker(tx: SqlExecutor): Promise<void> { await tx.query('DELETE FROM app_settings WHERE key=$1', [JEV_BREAKER_KEY]); }

/** PM-approved bootstrap of the already observed supplied Gateway entitlement failure.
 * Separate initialization survives replay; no credential identity/fingerprint is stored.
 */
export async function seedKnownJevRestriction(db: Database, config: RuntimeConfig, clock: Clock): Promise<void> {
  if (config.jev.provider !== 'vercel' || !config.jev.apiKey || config.jev.model !== 'typesafe-ai/jev' || config.jev.endpoint !== 'https://ai-gateway.vercel.sh/typesafe/v1/systemone') return;
  await db.withSessionLock('antseed:jev:dispatch', async () => db.transaction(async (tx) => {
    const marker = await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key', [JEV_INITIALIZED_KEY, JSON.stringify({ source: 'observed_gateway_403', initializedAt: clock.now().toISOString() })]);
    if (!marker.rows.length) return;
    const value: BreakerState = { paused: true, code: 'entitlement', revision: hash({ endpoint: config.jev.endpoint, model: config.jev.model }), changedAt: clock.now().toISOString() };
    await tx.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [JEV_BREAKER_KEY, JSON.stringify(value)]);
  }));
}

/** Serializes only Jev dispatch. A durable pause applies to every queued/new job and every process. */
export function withDurableJevBreaker(db: Database, provider: JevPort, config: RuntimeConfig, clock: Clock): JevPort {
  const providerName = config.jev.provider === 'openai' ? 'OpenAI Decisions' : 'Jev';
  async function revision(): Promise<string> {
    // Only a deliberately changed endpoint/model can automatically release a pause.
    // Credential changes, file touches/remounts and unrelated OpenAI edits require replay.
    return hash({ endpoint: config.jev.endpoint, model: config.jev.model });
  }
  async function current(): Promise<BreakerState | null> {
    const row = (await db.query<{ value: BreakerState }>('SELECT value FROM app_settings WHERE key=$1', [JEV_BREAKER_KEY])).rows[0];
    return row?.value ?? null;
  }
  return {
    async status(): Promise<ServiceStatus> {
      const saved = await current();
      if (saved?.paused && saved.revision === await revision()) return { state: 'unavailable', code: `provider_${saved.code}`, detail: `${providerName} paused across jobs/restarts; explicit replay or deliberate endpoint/model change required`, checkedAt: clock.now().toISOString() };
      return provider.status();
    },
    async decide(input, signal) {
      return db.withSessionLock('antseed:jev:dispatch', async (_session, lockSignal) => {
        const combined = signal ? AbortSignal.any([signal, lockSignal]) : lockSignal; combined.throwIfAborted();
        const version = await revision(); const saved = await current();
        if (saved?.paused && saved.revision === version) return { ok: false, code: saved.code, retryable: false, retryAt: null, detail: `${providerName} is durably paused; explicit replay or deliberate endpoint/model change required` };
        if (saved?.paused) await resetJevBreaker(db);
        // A crash/session loss between the upstream result and its durable handling must not
        // silently reissue a paid/entitlement request on restart. In-flight uncertainty pauses.
        const inFlight: BreakerState = { paused: true, code: 'unavailable', revision: version, changedAt: clock.now().toISOString() };
        await db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JEV_BREAKER_KEY, JSON.stringify(inFlight)]);
        const result = await provider.decide(input, combined); combined.throwIfAborted();
        if (!result.ok && (result.code === 'entitlement' || result.code === 'unconfigured')) {
          const state: BreakerState = { paused: true, code: result.code, revision: version, changedAt: clock.now().toISOString() };
          await db.query(`INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [JEV_BREAKER_KEY, JSON.stringify(state)]);
        } else await resetJevBreaker(db);
        return result;
      });
    },
  };
}
