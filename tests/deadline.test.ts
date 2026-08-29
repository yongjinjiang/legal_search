import { afterEach, describe, expect, it, vi } from "vitest";
import { DEADLINE_FLOOR_MS, DeadlineExceededError, budgetFor, deadlineIn, remainingMs } from "../src/lib/deadline";
import { CHAT_TIMEOUT_MS, EMBEDDING_TIMEOUT_MS, LLM_ROUTE_BUDGET_MS, SUMMARY_TIMEOUT_MS } from "../src/lib/limits";

afterEach(() => { vi.useRealTimers(); });

describe("request budget composition", () => {
  it("caps a step by whatever is left, not by its own limit", () => {
    const now = 1_000_000;
    const deadline = deadlineIn(30_000, now);
    // 25s already spent: the step may have 5s, not its own 50s cap.
    expect(budgetFor(50_000, deadline, now + 25_000)).toBe(5_000);
    // Plenty left: the step's own cap still applies.
    expect(budgetFor(10_000, deadline, now)).toBe(10_000);
  });

  it("refuses to start a call that cannot plausibly finish", () => {
    const now = 1_000_000;
    const deadline = deadlineIn(DEADLINE_FLOOR_MS - 1, now);
    // Starting it would be abandoned by the platform mid-flight, with no error path left.
    expect(() => budgetFor(50_000, deadline, now)).toThrow(DeadlineExceededError);
    expect(remainingMs(deadline, now)).toBeLessThan(DEADLINE_FLOOR_MS);
  });

  it("applies the cap unchanged when there is no deadline, for offline scripts", () => {
    expect(budgetFor(120_000)).toBe(120_000);
  });

  /** The defect this module exists for. /api/summarize runs an embedding call and then a
   *  completion call in sequence. Their independent caps sum to the whole platform allowance,
   *  so a slow first step used to leave the second free to consume the rest and be killed. */
  it("prevents two serial network calls from together exceeding the route budget", () => {
    const start = 5_000_000;
    const deadline = deadlineIn(LLM_ROUTE_BUDGET_MS, start);

    // Independently, the two caps can outrun the platform's 60s function limit.
    expect(EMBEDDING_TIMEOUT_MS + SUMMARY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);

    // Shared, they cannot. Worst case: the embedding consumes its whole allowance first.
    const embedBudget = budgetFor(EMBEDDING_TIMEOUT_MS, deadline, start);
    const afterEmbedding = start + embedBudget;
    const generateBudget = budgetFor(SUMMARY_TIMEOUT_MS, deadline, afterEmbedding);
    expect(embedBudget + generateBudget).toBeLessThanOrEqual(LLM_ROUTE_BUDGET_MS);
    expect(embedBudget + generateBudget).toBeLessThan(60_000);
  });

  it("leaves the route headroom to serialise a reply after its last call", () => {
    // 60s is the declared maxDuration on both LLM routes.
    expect(LLM_ROUTE_BUDGET_MS).toBeLessThan(60_000);
    expect(60_000 - LLM_ROUTE_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
    expect(budgetFor(CHAT_TIMEOUT_MS, deadlineIn(LLM_ROUTE_BUDGET_MS, 0), 0)).toBe(CHAT_TIMEOUT_MS);
  });
});
