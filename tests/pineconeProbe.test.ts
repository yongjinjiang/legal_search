import { describe, expect, it } from "vitest";
import { verifyVectorProbe } from "../src/lib/pinecone/probe";
import { fixtureIndex } from "./fixtures";

const index = fixtureIndex();
const probe = [0, 0, 1, 0];
const valid = [{ id: "c3", score: 1 }, { id: "c4", score: 0.6 }];

describe("Pinecone upload score probes", () => {
  it("allows only near-tied candidates to reorder or cross the top-k boundary", () => {
    const tied = fixtureIndex();
    tied.embeddings.data.set([0, 0, 1, 0], 0);
    tied.embeddings.data.set([0, 0, 0.9999, Math.sqrt(1 - 0.9999 ** 2)], 4);
    expect(verifyVectorProbe(tied, probe, [{ id: "c2", score: 0.9999 }, { id: "c1", score: 1 }], 2)).toMatchObject({ exactOrderMatch: false });
  });

  it("accepts valid candidate identity and cosine scores", () => {
    expect(verifyVectorProbe(index, probe, valid, 2)).toMatchObject({ exactOrderMatch: true });
  });

  it.each([
    { matches: [{ id: "stale", score: 1 }, valid[1]], reason: /unknown chunk/ },
    { matches: [valid[0], valid[0]], reason: /duplicate chunk/ },
    { matches: [valid[0]], reason: /expected 2/ },
    { matches: [valid[0], { id: "c4", score: 0.9 }], reason: /score differs/ },
    { matches: [valid[0], { id: "c4", score: NaN }], reason: /score differs/ },
    { matches: [valid[0], { id: "c1", score: 0 }], reason: /higher-scoring candidate/ },
    { matches: [...valid].reverse(), reason: /score inversion/ },
  ])("rejects corrupted or materially worse candidates", ({ matches, reason }) => {
    expect(() => verifyVectorProbe(index, probe, matches, 2)).toThrow(reason);
  });
});
