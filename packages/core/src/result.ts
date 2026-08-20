/**
 * Result — carried over from the earlier system.
 *
 * Every service method returns Ok or Fail rather than throwing. Expected
 * failures (validation, missing rows, lost races) are values; only genuine
 * bugs throw. Callers narrow with isOk / isFail, or switch on `code`.
 */

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Fail<E extends string = string> {
  ok: false;
  code: E;
  message: string;
  details?: unknown;
}

export type Result<T, E extends string = string> = Ok<T> | Fail<E>;

export function ok(): Result<void>;
export function ok<T>(data: T): Result<T>;
export function ok<T>(data?: T): Result<T | undefined> {
  return { ok: true, data };
}

export function fail<E extends string>(
  code: E,
  message: string,
  details?: unknown,
): Fail<E> {
  return { ok: false, code, message, details };
}

export function isOk<T, E extends string>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isFail<T, E extends string>(r: Result<T, E>): r is Fail<E> {
  return !r.ok;
}

/** Unwraps a successful result, throwing on failure. Tests and startup only. */
export function unwrap<T, E extends string>(r: Result<T, E>): T {
  if (!r.ok) {
    throw new Error(`Expected Ok, got ${r.code}: ${r.message}`);
  }
  return r.data;
}
