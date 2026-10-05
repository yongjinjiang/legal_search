import type { LocalSearchIndex } from "@/lib/search/artifacts";
import { searchEmbeddings } from "@/lib/search/semanticSearch";
import type { PineconeMatch } from "./client";

// Float32 arithmetic and remote near-tie ordering need not be bit-identical. This allowance
// checks scores and candidate quality; it is not a claim about general retrieval relevance.
export const PROBE_SCORE_TOLERANCE = 0.0005;

export function verifyVectorProbe(index: LocalSearchIndex, vector: number[], matches: PineconeMatch[], topK: number) {
  if (!Number.isInteger(topK) || topK < 1 || index.documents.length === 0) throw new Error("Probe needs a positive topK and a non-empty corpus.");
  const local = searchEmbeddings(index.embeddings, vector, index.documents.length);
  const expectedCount = Math.min(topK, local.length);
  if (matches.length !== expectedCount) throw new Error(`Probe returned ${matches.length} matches; expected ${expectedCount}.`);
  const scores = new Map(local.map((entry) => [index.documents[entry.index].chunkId, entry.score]));
  const cutoff = local[expectedCount - 1].score;
  const seen = new Set<string>();
  let previousScore = Infinity;
  for (const match of matches) {
    const score = scores.get(match.id);
    if (score === undefined) throw new Error(`Probe returned unknown chunk ${match.id}.`);
    if (seen.has(match.id)) throw new Error(`Probe returned duplicate chunk ${match.id}.`);
    seen.add(match.id);
    if (!Number.isFinite(match.score) || Math.abs(score - match.score) > PROBE_SCORE_TOLERANCE) throw new Error(`Probe score differs from the local cosine for ${match.id}.`);
    if (score < cutoff - PROBE_SCORE_TOLERANCE) throw new Error(`Probe omitted a materially higher-scoring candidate in favour of ${match.id}.`);
    if (score > previousScore + PROBE_SCORE_TOLERANCE) throw new Error("Probe ranking has a material score inversion.");
    previousScore = score;
  }
  const expectedIds = local.slice(0, expectedCount).map((entry) => index.documents[entry.index].chunkId);
  return { exactOrderMatch: expectedIds.join() === matches.map((match) => match.id).join(), scoreTolerance: PROBE_SCORE_TOLERANCE };
}
