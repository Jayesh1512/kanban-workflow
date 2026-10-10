export type Id = number;

export type IsoTime = string;

export type SetBy = 'agent' | 'human';

export type Actor =
  | { kind: 'agent' }
  | { kind: 'teammate'; id: Id }
  | { kind: 'credential'; id: Id }
  | { kind: 'system' };

export interface Ctx {
  db: Db;
  actor: Actor;
  canReadText: boolean;
  now(): Date;
}

export type ErrorCode = 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid' | 'conflict';

export class AppError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  tx<T>(fn: () => T): T;
  close(): void;
}

export type OpLog = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;
