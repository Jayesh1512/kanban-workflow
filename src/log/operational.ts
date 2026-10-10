import type { OpLog } from '../contracts/index.ts';

export function createOpLog(now: () => Date, write: (line: string) => void): OpLog {
  return (level, event, fields = {}) => {
    write(`${JSON.stringify({ ...fields, at: now().toISOString(), level, event })}\n`);
  };
}
