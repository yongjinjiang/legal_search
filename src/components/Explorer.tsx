"use client";
import { useEffect, useRef, useState } from "react";
import { readError } from "@/lib/errorMessage";
import { EVALUATION_NOTES } from "@/lib/evaluation/localBenchmark";
import { SearchSession, type CompletedSearch } from "@/lib/ui/searchSession";
import type { CaseResult, QueryType, SearchState } from "@/lib/search/types";

const EXAMPLES = [
  ["Less desirable duties", "An employee was reassigned to less desirable duties after complaining about workplace discrimination and was later suspended without pay before being reinstated. What Supreme Court case explains whether these actions can count as retaliation?"],
  ["Materially adverse", "What case defines the Title VII retaliation standard for a materially adverse action that might dissuade a reasonable worker from making or supporting a discrimination charge?"],
  ["Internal investigation", "A worker never filed her own harassment complaint, but during the employer's internal investigation she answered questions and described inappropriate conduct. She was later fired. Can that participation still be protected from retaliation?"],
  ["Third-party retaliation", "An employee complains about discrimination and soon afterward someone close to that employee suffers an adverse employment action. Which Supreme Court cases are most relevant to evaluating retaliation?"],
  ["But-for causation", "Does a plaintiff bringing a Title VII retaliation claim have to prove but-for causation?"],
  ["Broad retaliation search", "A worker says the employer punished them after they raised a workplace concern, but the client has not yet identified the statute, the protected activity, or the type of adverse action. Find potentially relevant Supreme Court retaliation precedents."],
] as const;
const GUIDE_QUESTIONS = ["How does this system work end-to-end?", "Why use hybrid search instead of embeddings alone?", "Why evaluate at the case level?", "Why did ANN beat keyword search on Q17?", "What happened on the broad Q18 query?", "Where would reranking fit?"];
type ChatMessage = { role: "user" | "assistant"; content: string };
const METHOD_LABELS: Record<QueryType, string> = { HYBRID: "Hybrid", ANN: "Semantic", FULL_TEXT: "Full text" };
// The retrieval technique behind each control, so the toggle is self-explanatory without turning
// the page into an infrastructure readout.
const METHOD_TECHNIQUE: Record<QueryType, string> = {
  HYBRID: "BM25 + embedding similarity, fused with Reciprocal Rank Fusion",
  ANN: "Embedding similarity over precomputed corpus vectors",
  FULL_TEXT: "BM25 lexical scoring",
};
export function Explorer() {
  const [query, setQuery] = useState(""); const [method, setMethod] = useState<QueryType>("HYBRID"); const [completedSearch, setCompletedSearch] = useState<CompletedSearch | undefined>(); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [summary, setSummary] = useState(""); const [summaryLoading, setSummaryLoading] = useState(false); const [summaryError, setSummaryError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]); const [chatInput, setChatInput] = useState(""); const [mode, setMode] = useState<"standard" | "detailed">("standard"); const [chatLoading, setChatLoading] = useState(false); const chatRef = useRef<HTMLTextAreaElement>(null); const chatLogRef = useRef<HTMLDivElement>(null); const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The log scrolls within a bounded panel, so new replies would otherwise land below the fold.
  useEffect(() => { const log = chatLogRef.current; if (log) log.scrollTop = log.scrollHeight; }, [messages, chatLoading]);
  const searchState: SearchState | undefined = completedSearch;
  // Follows the selected method rather than the completed search, so the benchmark figures track the toggle.
  const note = EVALUATION_NOTES[method];
  const results = completedSearch?.results ?? [];
  async function sendChat(seed?: string) { const content = (seed ?? chatInput).trim(); if (!content || chatLoading) return; const next = [...messages, { role: "user" as const, content }]; setMessages(next); setChatInput(""); setChatLoading(true); try { const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: content, mode, search: searchState }) }); const answer = response.ok ? (await response.json()).answer as string : await readError(response, "The technical guide is temporarily unavailable."); setMessages([...next, { role: "assistant", content: answer }]); } catch { setMessages([...next, { role: "assistant", content: "The technical guide is temporarily unavailable." }]); } finally { setChatLoading(false); } }
  // Search and summary requests overlap, and are sequenced in one place because of it: a summary
  // of the previous query could otherwise resolve after a newer search and render under its
  // results. Retrieval itself never calls a language model — the summary runs only from the button
  // below the results, which is what keeps an ordinary search free of generation cost.
  // See src/lib/ui/searchSession.ts. A lazy initializer, so the session is constructed once and
  // never read during render.
  const [session] = useState(() => new SearchSession({ setLoading, setError, setCompletedSearch, setSummary, setSummaryError, setSummaryLoading }));
  function togglePassage(caseId: string) { setExpanded((current) => { const next = new Set(current); if (!next.delete(caseId)) next.add(caseId); return next; }); }
  function askWhy(result: CaseResult) {
    const question = `Why did ${result.caseName} rank ${result.rank} for this query, and what retrieval signal likely helped?`; setChatInput(question);
    requestAnimationFrame(() => {
      // focus() scrolls on its own, which would fight the animation below.
      chatRef.current?.focus({ preventScroll: true });
      const guide = document.getElementById("guide"); const box = guide?.getBoundingClientRect();
      // On desktop the guide is already pinned beside the results, so only scroll when it is actually offscreen.
      if (guide && box && (box.bottom <= 0 || box.top >= window.innerHeight)) guide.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  }
  return <>
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark">LRE</span><span>Legal Retrieval Explorer</span></a><nav><a href="#search">Search</a><a href="#guide"><span className="nav-full">Technical guide</span><span className="nav-short">Guide</span></a><a href="#evaluation">Evaluation</a></nav></header>
    <main id="top">
      <section className="hero"><div className="eyebrow"><span className="rule"/>Retrieval systems, made inspectable</div><h1>Find the precedent.<br/><em>Understand the retrieval.</em></h1><p>Semantic, lexical, and hybrid search across a focused corpus of U.S. Supreme Court opinions—with the engineering decisions and evaluation evidence in view.</p><div className="corpus-line"><span>8 opinions</span><span>350 pages</span><span>234 chunks</span><span>18 benchmark queries</span></div></section>
      <div className="workspace">
        <section id="search" className="search-column"><div className="section-label"><span>01</span> Legal case search</div><div className="query-box"><label htmlFor="legal-query">Research question</label><textarea id="legal-query" value={query} maxLength={2000} onChange={(e) => setQuery(e.target.value)} placeholder="Describe a legal issue, fact pattern, or research question…"/><div className="query-footer"><div className="methods" role="group" aria-label="Search method">{(["HYBRID", "ANN", "FULL_TEXT"] as const).map((item) => <button key={item} aria-pressed={method === item} onClick={() => setMethod(item)}>{METHOD_LABELS[item]}</button>)}</div><button className="search-button" onClick={() => void session.search(query.trim(), method)} disabled={loading || query.trim().length < 3}>{loading ? "Searching…" : "Search cases"}<span>→</span></button></div></div>
          <p className="method-note"><b>{METHOD_LABELS[method]}</b> · {METHOD_TECHNIQUE[method]}</p>
          <div className="examples"><span>Try a benchmark query</span><div>{EXAMPLES.map(([label, value]) => <button key={label} onClick={() => setQuery(value)}>{label}</button>)}</div></div>
          {error && <div className="notice error">{error}</div>}
          {completedSearch && results.length > 0 && <div className="results"><div className="results-head"><div><span className="section-label"><span>RESULTS</span> Case-level ranking</span><h2>{results.length} unique precedents</h2></div><div className="method-badge">{completedSearch.method.replace("FULL_TEXT", "FULL TEXT")}{completedSearch.mock && <small>MOCK DATA — NOT RETRIEVED</small>}</div></div>{results.map((result) => <article className="result-card" key={result.caseId}><div className="rank">{String(result.rank).padStart(2, "0")}</div><div className="result-body"><div className="result-meta"><span>{result.citation}</span><span>Pages {result.pageStart}–{result.pageEnd}</span></div><h3>{result.caseName}</h3><blockquote className={expanded.has(result.caseId) ? undefined : "clamped"}>{result.bestPassage}</blockquote>{result.bestPassage.length > 420 && <button className="passage-toggle" aria-expanded={expanded.has(result.caseId)} onClick={() => togglePassage(result.caseId)}>{expanded.has(result.caseId) ? "Show less" : "Show full passage"}</button>}<div className="card-actions"><details><summary>Additional matching passages <span>{result.passages.length - 1}</span></summary>{result.passages.slice(1).map((p) => <p key={p.chunkId}><b>Pages {p.pageStart}–{p.pageEnd}</b> {p.chunkText}</p>)}</details><button onClick={() => askWhy(result)}>Ask why this result ↗</button></div></div></article>)}
            <div className="summary-panel">
              <div className="summary-head"><div><span className="section-label"><span>OPTIONAL</span> Grounded synthesis</span><p>Sends the highest-ranked passages to a language model. Retrieval above ran without one.</p></div><button onClick={() => void session.summarize()} disabled={summaryLoading || loading}>{summaryLoading ? "Generating…" : "Generate research summary"}<span>↗</span></button></div>
              {summaryError && <div className="notice error">{summaryError}</div>}
              {summary && <div className="summary-body"><p>{summary}</p><small>Generated from the retrieved passages only. Verify against the opinions before relying on it. Not legal advice.</small></div>}
            </div>
          </div>}
        </section>
        <aside id="guide" className="guide"><div className="guide-inner"><div className="section-label light"><span>02</span> Technical guide</div><h2>Ask about the system</h2><p className="guide-intro">Explore the architecture, retrieval choices, benchmark, or the results beside you. Grounded in the project documentation.</p><div className="mode-toggle" role="group" aria-label="Guide detail level"><button className={mode === "standard" ? "active" : ""} aria-pressed={mode === "standard"} onClick={() => setMode("standard")}>Standard</button><button className={mode === "detailed" ? "active" : ""} aria-pressed={mode === "detailed"} onClick={() => setMode("detailed")}>Detailed technical</button></div><div className="chat-log" ref={chatLogRef} aria-live="polite">{messages.length === 0 ? <div className="prompts">{GUIDE_QUESTIONS.map((q) => <button key={q} onClick={() => sendChat(q)}>{q}<span>↗</span></button>)}</div> : messages.map((m, i) => <div key={i} className={`message ${m.role}`}><span>{m.role === "user" ? "You" : "Guide"}</span><p>{m.content}</p></div>)}{chatLoading && <div className="thinking">Consulting project documentation…</div>}</div><div className="chat-compose"><textarea ref={chatRef} value={chatInput} maxLength={3000} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }} placeholder="Ask about this project…"/><button onClick={() => sendChat()} disabled={!chatInput.trim() || chatLoading} aria-label="Send question">↑</button></div><p className="context-note">{searchState ? `The completed ${searchState.method.toLowerCase()} search is included as context.` : "Run a search to let the guide explain its results."}</p></div></aside>
      </div>
      <section id="evaluation" className="evaluation"><div><div className="section-label"><span>03</span> Evaluation note<em className="eval-method">{METHOD_LABELS[method]}</em></div><h2>{note.heading}</h2></div><div className="metric"><strong>{note.metric}</strong><span>{note.caption}</span></div><p>{note.body}<small className="eval-scope">{METHOD_LABELS[method]} search, measured on the fixed 18-query benchmark—not on your query or the results above.</small></p></section>
    </main><footer><span>Legal retrieval research prototype.</span> Public U.S. Supreme Court opinions only. Not legal advice.</footer>
  </>;
}
