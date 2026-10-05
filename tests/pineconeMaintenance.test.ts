import { describe, expect, it } from "vitest";
import { requestedPruneNamespaces, validatePruneNamespaces } from "../scripts/lib/pineconeMaintenance";

const current = `corpus-${"a".repeat(24)}`;
const previous = `corpus-${"b".repeat(24)}`;
const other = `corpus-${"c".repeat(24)}`;

describe("explicit Pinecone cleanup", () => {
  it("retains every namespace unless specifically requested", () => {
    expect(requestedPruneNamespaces([])).toEqual([]);
    expect(requestedPruneNamespaces(["--prune", previous])).toEqual([previous]);
    expect(requestedPruneNamespaces(["--prune", previous])).not.toContain(other);
  });
  it.each([{ args: ["--prune"] }, { args: ["--prune", "--other"] }, { args: ["--prune", "unrelated-application"] }])("rejects ambiguous or unrelated deletion arguments $args", ({ args }) => {
    expect(() => requestedPruneNamespaces(args)).toThrow(/explicit corpus namespace/);
  });
  it("accepts repeated explicit names and deduplicates them", () => {
    expect(requestedPruneNamespaces(["--prune", previous, "--prune", other, "--prune", previous])).toEqual([previous, other]);
  });
  it("refuses the namespace this build serves before any upload or deletion", () => {
    expect(() => validatePruneNamespaces(current, [previous, current])).toThrow(/Cannot prune/);
    expect(() => validatePruneNamespaces(current, [previous])).not.toThrow();
  });
});
