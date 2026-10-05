import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchSession, type CompletedSearch, type SearchSessionSink } from "../src/lib/ui/searchSession";
import type { CaseResult } from "../src/lib/search/types";
import type { SummarySource } from "../src/lib/chat/summaryTypes";

/** The component's state, recorded rather than rendered. Every assertion below is about what the
 *  page would be showing, not about how the module is written. */
function sink() {
  const state = { loading: false, error: "", completed: undefined as CompletedSearch | undefined, summary: "", summarySources: [] as SummarySource[], summaryNotice: "", summaryError: "", summaryLoading: false };
  const api: SearchSessionSink = {
    setLoading: (value) => { state.loading = value; },
    setError: (value) => { state.error = value; },
    setCompletedSearch: (value) => { state.completed = value; },
    setSummary: (value) => { state.summary = value; },
    setSummarySources: (value) => { state.summarySources = value; },
    setSummaryNotice: (value) => { state.summaryNotice = value; },
    setSummaryError: (value) => { state.summaryError = value; },
    setSummaryLoading: (value) => { state.summaryLoading = value; },
  };
  return { state, api };
}

type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void; reject: (error: unknown) => void };
function defer(): Deferred {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const CASE: CaseResult = { rank: 1, caseId: "burlington_white", caseName: "Burlington Northern v. White", citation: "548 U.S. 53", pageStart: 1, pageEnd: 2, bestPassage: "passage", method: "HYBRID", passages: [] };
const searchBody = (mock = false) => new Response(JSON.stringify({ results: [CASE], mock }), { status: 200 });
const SOURCE: SummarySource = { id: 1, caseName: CASE.caseName, citation: CASE.citation, pageStart: 1, pageEnd: 2 };
const summaryBody = (text: string, notice?: string) => new Response(JSON.stringify({ summary: text, sources: [SOURCE], notice }), { status: 200 });

/** Queues one deferred per request, keyed by route, so a test can settle A after B has started. */
function router() {
  const search: Deferred[] = [];
  const summarize: Deferred[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const pending = defer();
    if (input === "/api/search") search.push(pending); else { summarize.push(pending); signals.push(init?.signal ?? undefined); }
    return pending.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { search, summarize, signals, fetchMock };
}

/** Let the awaited chain inside the session run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("search and summary sequencing", () => {
  it("generates a summary for the completed search", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);
    const searching = session.search("first query", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searching;
    expect(state.completed?.query).toBe("first query");
    expect(session.canSummarize()).toBe(true);

    const summarizing = session.summarize();
    expect(state.summaryLoading).toBe(true);
    routes.summarize[0].resolve(summaryBody("grounded synthesis", "Some paragraphs were omitted."));
    await summarizing;
    expect(state.summary).toBe("grounded synthesis");
    expect(state.summarySources).toEqual([SOURCE]);
    expect(state.summaryNotice).toBe("Some paragraphs were omitted.");
    expect(state.summaryError).toBe("");
    expect(state.summaryLoading).toBe(false);
    const replacement = session.search("replacement query", "FULL_TEXT");
    expect(state.summarySources).toEqual([]);
    expect(state.summaryNotice).toBe("");
    expect(state.summary).toBe("");
    routes.search[1].resolve(searchBody());
    await replacement;
  });

  // The defect: A's summary resolved after B's results were on screen and wrote itself under them.
  it("discards a summary that resolves after a newer search completed", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);

    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;
    const summaryA = session.summarize();
    await settle();

    const searchB = session.search("query B", "ANN");
    routes.search[1].resolve(searchBody());
    await searchB;
    expect(state.completed?.query).toBe("query B");

    routes.summarize[0].resolve(summaryBody("synthesis of query A", "Stale notice"));
    await summaryA;

    expect(state.summary).toBe("");
    expect(state.summarySources).toEqual([]);
    expect(state.summaryNotice).toBe("");
    expect(state.summaryError).toBe("");
    expect(state.summaryLoading).toBe(false);
  });

  it("discards a stale summary failure instead of showing it under new results", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);

    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;
    const summaryA = session.summarize();
    await settle();

    const searchB = session.search("query B", "ANN");
    routes.search[1].resolve(searchBody());
    await searchB;

    routes.summarize[0].resolve(new Response(JSON.stringify({ error: "The summary service is temporarily unavailable." }), { status: 503 }));
    await summaryA;
    expect(state.summaryError).toBe("");
    expect(state.summary).toBe("");
  });

  it("invalidates the summary even when the replacing search fails", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);

    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;
    const summaryA = session.summarize();
    await settle();

    const searchB = session.search("query B", "ANN");
    routes.search[1].resolve(new Response(JSON.stringify({ error: "Search could not be completed." }), { status: 502 }));
    await searchB;
    expect(state.error).toBe("Search could not be completed.");
    expect(state.completed).toBeUndefined();

    routes.summarize[0].resolve(summaryBody("synthesis of query A"));
    await summaryA;
    expect(state.summary).toBe("");
    expect(state.summaryError).toBe("");
  });

  // The `finally` half of the same defect, in the other direction.
  it("does not let a superseded request switch off a newer summary's spinner", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);

    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;
    const summaryA = session.summarize();
    await settle();

    const searchB = session.search("query B", "ANN");
    routes.search[1].resolve(searchBody());
    await searchB;
    const summaryB = session.summarize();
    await settle();
    expect(state.summaryLoading).toBe(true);

    routes.summarize[0].resolve(summaryBody("synthesis of query A"));
    await summaryA;
    expect(state.summaryLoading).toBe(true);
    expect(state.summary).toBe("");

    routes.summarize[1].resolve(summaryBody("synthesis of query B"));
    await summaryB;
    expect(state.summaryLoading).toBe(false);
    expect(state.summary).toBe("synthesis of query B");
  });

  it("refuses to summarise results a replacement search is already replacing", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);

    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;

    const searchB = session.search("query B", "ANN");
    await settle();
    // The old results are still rendered, so the button exists; `loading` is what disables it,
    // and the handler guard has to agree with that or the two drift apart.
    expect(state.loading).toBe(true);
    expect(state.completed?.query).toBe("query A");
    expect(session.canSummarize()).toBe(false);

    await session.summarize();
    expect(routes.summarize).toHaveLength(0);

    routes.search[1].resolve(searchBody());
    await searchB;
    expect(session.canSummarize()).toBe(true);
  });

  it("does not start a second summary while one is in flight", async () => {
    const { api } = sink();
    const routes = router();
    const session = new SearchSession(api);
    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;

    const first = session.summarize();
    await settle();
    await session.summarize();
    expect(routes.summarize).toHaveLength(1);
    routes.summarize[0].resolve(summaryBody("one"));
    await first;
  });

  it("aborts the in-flight summary request when a new search starts", async () => {
    const { api } = sink();
    const routes = router();
    const session = new SearchSession(api);
    const searchA = session.search("query A", "HYBRID");
    routes.search[0].resolve(searchBody());
    await searchA;
    const summaryA = session.summarize();
    await settle();
    expect(routes.signals[0]?.aborted).toBe(false);

    const searchB = session.search("query B", "ANN");
    // Cancellation is cleanup, not correctness: the paid call may already be running server-side,
    // which is why the identity checks above carry the guarantee.
    expect(routes.signals[0]?.aborted).toBe(true);
    routes.search[1].resolve(searchBody());
    await searchB;
    routes.summarize[0].resolve(summaryBody("synthesis of query A"));
    await summaryA;
  });

  it("ignores a superseded search response", async () => {
    const { state, api } = sink();
    const routes = router();
    const session = new SearchSession(api);
    const searchA = session.search("query A", "HYBRID");
    await settle();
    const searchB = session.search("query B", "ANN");
    routes.search[1].resolve(searchBody());
    await searchB;
    routes.search[0].resolve(searchBody());
    await searchA;
    expect(state.completed?.query).toBe("query B");
    expect(state.loading).toBe(false);
  });
});
