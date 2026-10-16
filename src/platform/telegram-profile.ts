import type { RuntimeConfig } from '../shared/ports.js';

// Published AppBuiltin profile from iyear/tdl v0.20.4 (distinct from AppDesktop).
// Source: https://github.com/iyear/tdl/blob/9d7d49eef2bcb04da720c26e33598c49c68b9ddd/pkg/tclient/app.go
// Public application configuration only; never an account login/session credential.
const publishedTdl = Object.freeze({ apiId: 15055931, apiHash: '021d433426cbb920eeb95164498fe3d3' });

export function telegramApplication(values: NodeJS.ProcessEnv): Pick<RuntimeConfig['telegram'], 'apiId' | 'apiHash'> {
  const profile = values['TELEGRAM_APPLICATION_PROFILE']?.trim() || 'tdl';
  if (profile !== 'tdl' && profile !== 'custom') throw new Error('TELEGRAM_APPLICATION_PROFILE must be tdl or custom');
  const id = values['TELEGRAM_API_ID']?.trim() || null, hash = values['TELEGRAM_API_HASH']?.trim() || null;
  // Custom settings are one pair; never mix one custom half with a published half.
  if (Boolean(id) !== Boolean(hash)) throw new Error('Configure both TELEGRAM_API_ID and TELEGRAM_API_HASH');
  if (id && hash) {
    const apiId = Number(id);
    if (!Number.isSafeInteger(apiId) || apiId <= 0 || apiId > 2_147_483_647) throw new Error('Invalid TELEGRAM_API_ID: expected a positive 32-bit integer');
    return { apiId, apiHash: hash };
  }
  return profile === 'tdl' ? { ...publishedTdl } : { apiId: null, apiHash: null };
}
