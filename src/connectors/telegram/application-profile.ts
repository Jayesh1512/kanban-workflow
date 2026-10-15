import { AppError } from '../../contracts/index.ts';

/** Published AppBuiltin, iyear/tdl v0.20.4 (distinct from AppDesktop).
 * https://github.com/iyear/tdl/blob/9d7d49eef2bcb04da720c26e33598c49c68b9ddd/pkg/tclient/app.go
 * Publication attributes this profile to iyear; registrant and permission are not verified.
 */
const tdlApplication = {
  apiId: 15055931,
  apiHash: '021d433426cbb920eeb95164498fe3d3',
};

/** Validate selection separately so notices need no SDK construction or network. */
export function telegramApplicationProfile(config: Record<string, string>): 'custom' | 'tdl' {
  const profile = config.APPLICATION_PROFILE ?? 'custom';
  if (profile !== 'custom' && profile !== 'tdl') throw new AppError('invalid', 'Unknown Telegram application profile');
  if (profile === 'tdl' && ['API_ID', 'API_HASH', 'APP_OWNER'].some((key) => config[key] !== undefined))
    throw new AppError('invalid', 'Telegram tdl profile cannot be combined with custom application settings');
  return profile;
}

export function telegramApplication(config: Record<string, string>) {
  if (telegramApplicationProfile(config) === 'tdl') return { ...tdlApplication };
  const apiId = Number(config.API_ID);
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !config.API_HASH || !config.APP_OWNER)
    throw new AppError('invalid', 'Telegram API_ID, API_HASH and APP_OWNER are required');
  return { apiId, apiHash: config.API_HASH };
}
