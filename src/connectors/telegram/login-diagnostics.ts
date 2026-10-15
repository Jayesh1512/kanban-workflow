import { MtArgumentError, MtTimeoutError, tl } from '@mtcute/node';

/** Only code-owned labels leave this boundary. Never copy a raw error field into an event. */
export function loginDiagnostic(error: unknown): { reason: string; rpcStatus?: number } {
  if (tl.RpcError.is(error)) {
    const reason = rpcReason(error.text);
    const status = error.code;
    return Number.isInteger(status) && status >= 100 && status <= 599 ? { reason, rpcStatus: status } : { reason };
  }
  if (error instanceof MtArgumentError) return { reason: 'local_validation' };
  if (error instanceof MtTimeoutError) return { reason: 'local_transport_timeout' };
  if (error instanceof TypeError || error instanceof RangeError) return { reason: 'local_runtime' };
  return { reason: 'unknown' };
}

function rpcReason(text: string): string {
  switch (text) {
    case 'PHONE_NUMBER_INVALID':
      return 'PHONE_NUMBER_INVALID';
    case 'API_ID_INVALID':
      return 'API_ID_INVALID';
    case 'API_ID_PUBLISHED_FLOOD':
      return 'API_ID_PUBLISHED_FLOOD';
    case 'PHONE_NUMBER_FLOOD':
      return 'PHONE_NUMBER_FLOOD';
    case 'PHONE_NUMBER_BANNED':
      return 'PHONE_NUMBER_BANNED';
    case 'UPDATE_APP_TO_LOGIN':
      return 'UPDATE_APP_TO_LOGIN';
    case 'AUTH_RESTART':
    case 'AUTH_RESTART_%d':
      return 'AUTH_RESTART';
    case 'FLOOD_WAIT_%d':
    case 'SLOWMODE_WAIT_%d':
    case 'FLOOD_TEST_PHONE_WAIT_%d':
    case 'FLOOD_PREMIUM_WAIT_%d':
      return 'FLOOD_WAIT';
    default:
      // Older/direct synthetic RpcErrors can retain the numeric suffix. Emit no suffix or wait value.
      if (/^(?:FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_TEST_PHONE_WAIT|FLOOD_PREMIUM_WAIT)_[0-9]+$/.test(text))
        return 'FLOOD_WAIT';
      return 'unknown';
  }
}
