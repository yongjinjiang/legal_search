/**
 * A single wall-clock allowance shared by every step of one request.
 *
 * Per-call timeouts do not compose. `/api/summarize` runs an embedding call and then a
 * completion call in sequence; with independent 10s and 50s caps their worst case is exactly the
 * 60s the platform allows the function, leaving nothing for loading the index, building the
 * prompt, parsing the response, or serialising an error. The platform would kill the function
 * before the application could explain why.
 *
 * A deadline is an absolute timestamp rather than a duration, so a later step sees the time an
 * earlier one already spent instead of starting its own budget from zero.
 */

/** Below this, a network call cannot plausibly finish, so it is refused rather than started and
 *  abandoned — the caller gets a useful error instead of a platform kill. */
export const DEADLINE_FLOOR_MS = 2_000;

export class DeadlineExceededError extends Error {
  constructor(message = "The request ran out of time before this step could start.") { super(message); }
}

export function deadlineIn(budgetMs: number, now = Date.now()): number {
  return now + budgetMs;
}

export function remainingMs(deadlineAt: number, now = Date.now()): number {
  return deadlineAt - now;
}

/** The timeout a step may use: its own cap, or whatever is left of the request, whichever is
 *  smaller. Without a deadline the cap applies unchanged, which is what offline scripts want. */
export function budgetFor(cap: number, deadlineAt?: number, now = Date.now()): number {
  if (deadlineAt === undefined) return cap;
  const remaining = remainingMs(deadlineAt, now);
  if (remaining < DEADLINE_FLOOR_MS) throw new DeadlineExceededError();
  return Math.min(cap, remaining);
}
