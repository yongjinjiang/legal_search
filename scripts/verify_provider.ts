/**
 * Live compatibility smoke test against the configured provider profile.
 *
 *   npm run verify:provider -- --live
 *
 * This is a pre-deploy release check, deliberately NOT part of `npm test`. The hermetic suite can
 * prove that an empty completion is rejected safely; it cannot prove that the configured model,
 * prompt, reasoning effort, and token budget avoid producing one. Both defects that reached
 * production — an output budget consumed entirely by reasoning tokens, and an embedding batch
 * larger than the account's per-request ceiling — were of that kind and passed a green gate.
 *
 * It is a stochastic smoke sample, not a quality evaluation: a handful of repetitions catches
 * provider drift, tier limits, model alias changes, and bad configuration combinations. It says
 * nothing statistical about answer quality.
 *
 * Run it when any of these change: model, provider, base URL, reasoning effort, system prompts or
 * included documentation, passage/context budgets, output-token or time limits, embedding batch
 * size or dimensions, or the provider account tier.
 *
 * Options:
 *   --live            required; acknowledges that this spends money on real API calls
 *   --repeat <n>      completions per route (default 3)
 *   --report <path>   write the machine-readable report here as well as stdout
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt, resolveSummaryDraft } from "@/lib/chat/summary";
import { GUIDE_SYSTEM_PREAMBLE, guideRuntimeContext } from "@/lib/chat/guide";
import { contextFiles, loadProjectContext } from "@/lib/chat/contextLoader";
import { embeddingProvider } from "@/lib/embeddings/openai";
import { llmProvider, resolveReasoningEffort } from "@/lib/llm/openai";
import { budgetFor, deadlineIn } from "@/lib/deadline";
import { CHAT_TIMEOUT_MS, EMBEDDING_TIMEOUT_MS, LLM_ROUTE_BUDGET_MS, MAX_GUIDE_OUTPUT_TOKENS, MAX_SUMMARY_OUTPUT_TOKENS, SUMMARY_TIMEOUT_MS } from "@/lib/limits";
import { searchCases } from "@/lib/search/backend";
import { loadEnvFiles } from "./lib/env";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFiles(ROOT);

const flag = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const repeat = Math.max(1, Number(flag("repeat") ?? 3));

// A fixed, representative query rather than a random one, so runs are comparable over time.
const QUERY = "Does a plaintiff bringing a Title VII retaliation claim have to prove but-for causation?";
const GUIDE_QUESTION = "Explain the retrieval architecture end to end, why it changed, how RRF works here, and what the benchmark showed on Q17 and Q18.";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); };

async function main(): Promise<number> {
  if (!process.argv.includes("--live")) {
    console.error("Refusing to run: this makes real, billed API calls. Re-run with --live to acknowledge.");
    return 2;
  }
  const embeddings = embeddingProvider();
  const llm = llmProvider();
  if (!embeddings || !llm) { console.error("OPENAI_API_KEY is required."); return 2; }

  const effort = resolveReasoningEffort();
  const calls = 2 + repeat * 3; // probe + prompt retrieval, then an embedding per summary attempt
  console.log(`Live compatibility smoke — NOT a quality evaluation.`);
  console.log(`  model ${llm.model} · effort ${effort} · embeddings ${embeddings.model}@${embeddings.dimensions}`);
  console.log(`  will make ${calls} provider calls (${2 + repeat} embeddings, ${repeat} summary, ${repeat} guide)\n`);

  const started = Date.now();

  // 1 — query embedding: correct finite width, inside its deadline.
  const embedStart = Date.now();
  const vector = await embeddings.embedQuery(QUERY, EMBEDDING_TIMEOUT_MS);
  const embedMs = Date.now() - embedStart;
  record("embedding dimensions", vector.length === embeddings.dimensions, `${vector.length} of ${embeddings.dimensions}`);
  record("embedding finite", vector.every((value) => Number.isFinite(value)), `${vector.length} values`);
  record("embedding latency", embedMs < EMBEDDING_TIMEOUT_MS, `${embedMs}ms < ${EMBEDDING_TIMEOUT_MS}ms`);

  // Real assembled prompts, not synthetic ones — prompt growth is one of the drifts this catches.
  const { results } = await searchCases(QUERY, "HYBRID");
  const summaryPrompt = buildSummaryPrompt(QUERY, results);
  const guideContext = await loadProjectContext("detailed");

  const routes = [
    { label: "summary", system: SUMMARY_SYSTEM_PROMPT, user: summaryPrompt, cap: MAX_SUMMARY_OUTPUT_TOKENS, callCap: SUMMARY_TIMEOUT_MS, ground: true },
    { label: "guide", system: `${GUIDE_SYSTEM_PREAMBLE}\n\n${guideContext}\n\n${guideRuntimeContext()}`, user: GUIDE_QUESTION, cap: MAX_GUIDE_OUTPUT_TOKENS, callCap: CHAT_TIMEOUT_MS, ground: false },
  ];

  for (const route of routes) {
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      // Model the route faithfully: one request budget, from which earlier steps have already
      // spent time. A fixed pessimistic split would report timeouts the route would not hit.
      const deadlineAt = deadlineIn(LLM_ROUTE_BUDGET_MS);
      if (route.ground) await embeddings.embedQuery(QUERY, budgetFor(EMBEDDING_TIMEOUT_MS, deadlineAt));
      const allowed = budgetFor(route.callCap, deadlineAt);
      const t = Date.now();
      let text = "";
      try {
        text = await llm.complete([{ role: "system", content: route.system }, { role: "user", content: route.user }], { maxOutputTokens: route.cap, timeoutMs: allowed });
      } catch (error) {
        record(`${route.label} ${attempt} completion`, false, `${(error as Error).message} (allowed ${allowed}ms, elapsed ${Date.now() - t}ms)`);
        continue;
      }
      const ms = Date.now() - t;
      record(`${route.label} ${attempt} non-empty`, text.trim().length > 0, `${text.length} chars`);
      record(`${route.label} ${attempt} within budget`, ms < allowed, `${ms}ms < ${allowed}ms`);
      if (route.ground) {
        try {
          const resolved = resolveSummaryDraft(text, results);
          record(`${route.label} ${attempt} source references`, true, `${resolved.sources.length} references resolved from server passages; prose accuracy is not evaluated`);
        } catch (error) {
          record(`${route.label} ${attempt} source references`, false, (error as Error).message);
        }
      }
    }
  }

  const failed = checks.filter((check) => !check.ok);
  const report = {
    kind: "live-compatibility-smoke",
    generatedAt: new Date().toISOString(),
    model: llm.model,
    reasoningEffort: effort,
    embeddingModel: embeddings.model,
    embeddingDimensions: embeddings.dimensions,
    // Prompt text is never recorded; a hash detects that the prompt changed without disclosing it.
    summaryPromptSha256: createHash("sha256").update(summaryPrompt).digest("hex").slice(0, 16),
    guideContextFiles: contextFiles("detailed"),
    limits: { MAX_SUMMARY_OUTPUT_TOKENS, MAX_GUIDE_OUTPUT_TOKENS, CHAT_TIMEOUT_MS, SUMMARY_TIMEOUT_MS, EMBEDDING_TIMEOUT_MS, LLM_ROUTE_BUDGET_MS },
    repetitions: repeat,
    billedCalls: calls,
    totalMs: Date.now() - started,
    checks,
    passed: failed.length === 0,
  };
  const destination = flag("report");
  if (destination) { writeFileSync(path.resolve(ROOT, destination), `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.log(`\nReport written to ${destination}`); }

  console.log(`\n${failed.length === 0 ? "PASS" : `FAIL — ${failed.length} of ${checks.length} checks`}  (${((Date.now() - started) / 1000).toFixed(1)}s, ${calls} billed calls)`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
