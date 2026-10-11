import type { TelegramApi } from '../../contracts/index.ts';

/** Connector-private local control; never part of TelegramApi or a channel RPC port. */
export const terminalControl = Symbol('connector terminal control');
export interface TerminalControl {
  pause(): void;
  authenticated(): boolean;
  detachedCleanup: boolean;
  finish(): void;
}
export function apiControl(api: TelegramApi): TerminalControl | null {
  if (terminalControl in api) return api[terminalControl] as TerminalControl;
  return null;
}

/** One destruction per admitted API client generation. Old cleanup is always observed. */
export function createApiLifecycle(api: TelegramApi) {
  const control = apiControl(api);
  let authenticated = false;
  let generation = 0;
  let cleanup: Promise<void> | null = null;
  let pending = false;
  return {
    currentAuth: () => control?.authenticated() ?? authenticated,
    pause: () => control?.pause(),
    finish: () => control?.finish(),
    prior: () => (pending && !control?.detachedCleanup ? cleanup : null),
    async importSession(value: string) {
      const token = ++generation;
      cleanup = null;
      await api.importSession(value);
      if (token === generation) authenticated = true;
    },
    authorized() {
      authenticated = true;
      cleanup = null;
    },
    lost() {
      authenticated = false;
    },
    destroy() {
      if (cleanup) return cleanup;
      ++generation;
      authenticated = false;
      pending = true;
      try {
        cleanup = Promise.resolve(api.destroy());
      } catch (error) {
        cleanup = Promise.reject(error);
      }
      const captured = cleanup;
      void captured.then(
        () => {
          if (cleanup === captured) pending = false;
        },
        () => {
          if (cleanup === captured) pending = false;
        },
      );
      return captured;
    },
  };
}
