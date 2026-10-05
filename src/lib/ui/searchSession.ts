import { readError } from "@/lib/errorMessage";
import type { CaseResult, QueryType, SearchState } from "@/lib/search/types";
import type { LegalSummary, SummarySource } from "@/lib/chat/summaryTypes";

export type CompletedSearch = SearchState & { mock: boolean };

/** Everything the session tells the view. Keeping React out of this module is what makes the
 *  request-ordering rules testable with deferred responses instead of a rendered DOM. */
export type SearchSessionSink = {
  setLoading(value: boolean): void;
  setError(value: string): void;
  setCompletedSearch(value: CompletedSearch | undefined): void;
  setSummary(value: string): void;
  setSummarySources(value: SummarySource[]): void;
  setSummaryError(value: string): void;
  setSummaryLoading(value: boolean): void;
};

/**
 * Sequencing for the two overlapping request families on the page.
 *
 * Search responses were already version-guarded. Summaries were not: search A completes, the
 * visitor asks for summary A, search B completes, and A's response then calls `setSummary`
 * unconditionally — so a synthesis of A's precedents appears underneath B's results, indexed to
 * B's method badge, with nothing on screen saying otherwise. A stale *failure* did the same with
 * an error message. The `finally` blocks had the matching defect in the other direction: an old
 * request could clear a newer one's loading indicator.
 *
 * A summary is therefore bound to two identities — which search produced the results, and which
 * summary request it is — and every one of the three exits checks both. Aborting the browser
 * fetch is useful cleanup and nothing more: the server-side generation is already paid for and
 * may still deliver, so cancellation can never be the thing that keeps stale text off the screen.
 */
export class SearchSession {
  private searchesIssued = 0;
  /** The most recently *started* search. */
  private latestSearch = 0;
  /** The search whose results are on screen; 0 when none are, or when a replacement is running. */
  private shownSearch = 0;
  private summariesIssued = 0;
  /** The summary request whose result the view will accept; 0 when none is in flight. */
  private activeSummary = 0;
  private shown: CompletedSearch | undefined;
  private summaryAbort: AbortController | undefined;

  constructor(private readonly sink: SearchSessionSink) {}

  /** True only while the on-screen results are the newest completed search, which is exactly
   *  when a summary can be attached to what the visitor is looking at. The button's `disabled`
   *  state derives from the same two facts (`loading`, `summaryLoading`), so the guard and the
   *  control cannot disagree. */
  canSummarize(): boolean {
    return this.shownSearch !== 0 && this.shownSearch === this.latestSearch && this.activeSummary === 0;
  }

  async search(query: string, method: QueryType): Promise<void> {
    const id = ++this.searchesIssued;
    this.latestSearch = id;
    // Invalidate before awaiting anything. An in-flight summary is dead the moment a new search
    // starts, whether that search later succeeds, fails, or is itself replaced.
    this.shownSearch = 0;
    this.shown = undefined;
    this.activeSummary = 0;
    this.summaryAbort?.abort();
    this.summaryAbort = undefined;
    // Results stay on screen while the replacement runs; only the summary is cleared, because a
    // summary of the previous query is the thing that would be silently wrong.
    this.sink.setLoading(true);
    this.sink.setError("");
    this.sink.setSummary("");
    this.sink.setSummarySources([]);
    this.sink.setSummaryError("");
    this.sink.setSummaryLoading(false);
    try {
      const response = await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, queryType: method, numResults: 20 }) });
      if (!response.ok) throw new Error(await readError(response, "Search could not be completed."));
      const data = await response.json() as { results: CaseResult[]; mock: boolean };
      if (id !== this.latestSearch) return;
      const completed: CompletedSearch = { query, method, results: data.results, mock: data.mock };
      this.shown = completed;
      this.shownSearch = id;
      this.sink.setCompletedSearch(completed);
    } catch (error) {
      if (id !== this.latestSearch) return;
      this.sink.setError(error instanceof Error ? error.message : "Search failed.");
      this.sink.setCompletedSearch(undefined);
    } finally {
      if (id === this.latestSearch) this.sink.setLoading(false);
    }
  }

  async summarize(): Promise<void> {
    if (!this.canSummarize() || !this.shown) return;
    const search = this.shownSearch;
    const id = ++this.summariesIssued;
    this.activeSummary = id;
    const target = this.shown;
    const controller = new AbortController();
    this.summaryAbort = controller;
    this.sink.setSummaryLoading(true);
    this.sink.setSummaryError("");
    this.sink.setSummary("");
    this.sink.setSummarySources([]);
    try {
      const response = await fetch("/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: target.query, queryType: target.method }), signal: controller.signal });
      if (!response.ok) throw new Error(await readError(response, "The research summary could not be generated."));
      const data = await response.json() as LegalSummary;
      if (!this.isCurrentSummary(id, search)) return;
      this.sink.setSummary(data.summary);
      this.sink.setSummarySources(data.sources ?? []);
    } catch (error) {
      if (!this.isCurrentSummary(id, search)) return;
      this.sink.setSummaryError(error instanceof Error ? error.message : "The research summary could not be generated.");
    } finally {
      // Guarded like the other two exits: a superseded request clearing this would switch off a
      // newer request's spinner while that request is still running.
      if (this.isCurrentSummary(id, search)) {
        this.activeSummary = 0;
        this.summaryAbort = undefined;
        this.sink.setSummaryLoading(false);
      }
    }
  }

  private isCurrentSummary(summaryId: number, searchId: number): boolean {
    return summaryId === this.activeSummary && searchId === this.shownSearch && this.shownSearch === this.latestSearch;
  }
}
