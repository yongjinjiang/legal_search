#!/usr/bin/env python3
"""Run and score the legal-search benchmark against a Databricks AI Search index."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
QUERIES_PATH = ROOT / "data" / "evaluation" / "legal_search_queries.csv"
DEFAULT_OUTPUT = ROOT / "data" / "evaluation" / "retrieval_results.json"
METHODS = ("ANN", "FULL_TEXT", "HYBRID")
COLUMNS = ("chunk_id", "case_id")


def collapse_case_ids(payload: dict[str, Any], limit: int | None = None) -> list[str]:
    """Map Databricks chunk rows to unique case IDs in retrieval order.

    The full ranking is returned by default. Saved rankings must not be truncated to the
    UI's display depth: a gold case at rank 7 still contributes 1/7 to MRR, and truncating
    at 5 would silently score it as absent.
    """
    columns = [column.get("name") for column in payload.get("manifest", {}).get("columns", [])]
    rows = payload.get("result", {}).get("data_array")
    if not isinstance(rows, list) or not all(column in columns for column in COLUMNS):
        raise ValueError("Databricks response is missing required columns or rows")
    case_index = columns.index("case_id")
    ranked: list[str] = []
    for row in rows:
        if not isinstance(row, list) or case_index >= len(row) or row[case_index] is None:
            raise ValueError("Databricks response contains an incomplete row")
        case_id = str(row[case_index])
        if case_id not in ranked:
            ranked.append(case_id)
        if limit is not None and len(ranked) == limit:
            break
    return ranked


def chunk_row_count(payload: dict[str, Any]) -> int:
    rows = payload.get("result", {}).get("data_array")
    return len(rows) if isinstance(rows, list) else 0


def validate_runs(runs: list[dict[str, Any]], queries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Require exactly one run per query/method pair, with gold labels from the query file.

    Metrics are averaged over whatever records exist, so a result file containing only the
    queries that happened to succeed would report inflated scores. Gold labels are taken
    from the canonical CSV rather than trusted from the result file.
    """
    gold = {row["query_id"]: row["primary_gold_case"] for row in queries}
    expected = {(query_id, method) for query_id in gold for method in METHODS}
    seen: set[tuple[str, str]] = set()
    validated: list[dict[str, Any]] = []
    for run in runs:
        key = (run.get("query_id"), run.get("method"))
        if key[1] not in METHODS:
            raise ValueError(f"Result file contains an unknown method: {key[1]!r}")
        if key[0] not in gold:
            raise ValueError(f"Result file contains a query absent from {QUERIES_PATH.name}: {key[0]!r}")
        if key in seen:
            raise ValueError(f"Result file contains duplicate runs for {key[0]} {key[1]}")
        if run.get("primary_gold_case") != gold[key[0]]:
            raise ValueError(f"Result file gold case for {key[0]} does not match {QUERIES_PATH.name}")
        seen.add(key)
        validated.append(run)
    missing = sorted(expected - seen)
    if missing:
        summary = ", ".join(f"{query_id}/{method}" for query_id, method in missing[:5])
        raise ValueError(f"Result file is missing {len(missing)} of {len(expected)} runs: {summary}{'…' if len(missing) > 5 else ''}")
    return validated


def query_file_digest() -> str:
    return hashlib.sha256(QUERIES_PATH.read_bytes()).hexdigest()


def git_commit() -> str:
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


def score_runs(runs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Compute primary-gold Recall@k and MRR for every retrieval method."""
    scores: dict[str, dict[str, float]] = {}
    for method in METHODS:
        method_runs = [run for run in runs if run["method"] == method]
        if not method_runs:
            continue
        ranks: list[int | None] = []
        censored_misses = 0
        for run in method_runs:
            ranked = run["ranked_case_ids"]
            try:
                ranks.append(ranked.index(run["primary_gold_case"]) + 1)
            except ValueError:
                ranks.append(None)
                # num_results is a chunk depth, not a case depth. When the response filled
                # that depth, an unseen case may rank below the observed window rather than
                # be genuinely absent, so the miss is reported rather than assumed definitive.
                if run.get("censored"):
                    censored_misses += 1
        total = len(ranks)
        scores[method] = {
            "queries": float(total),
            "recall_at_1": sum(rank is not None and rank <= 1 for rank in ranks) / total,
            "recall_at_3": sum(rank is not None and rank <= 3 for rank in ranks) / total,
            "recall_at_5": sum(rank is not None and rank <= 5 for rank in ranks) / total,
            "mrr": sum(1 / rank for rank in ranks if rank is not None) / total,
            "unranked_gold": float(sum(rank is None for rank in ranks)),
            "censored_misses": float(censored_misses),
        }
    return scores


def query_index(host: str, token: str, index_name: str, query: str, method: str, num_results: int) -> dict[str, Any]:
    url = f"{host.rstrip('/')}/api/2.0/vector-search/indexes/{urllib.parse.quote(index_name, safe='')}/query"
    body = json.dumps({
        "query_text": query,
        "query_type": method,
        "columns": list(COLUMNS),
        "num_results": num_results,
    }).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        request_id = error.headers.get("x-databricks-request-id", "unknown")
        raise RuntimeError(f"Databricks request failed with HTTP {error.code}; request_id={request_id}") from error


def load_queries() -> list[dict[str, str]]:
    with QUERIES_PATH.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def print_scores(scores: dict[str, dict[str, float]]) -> None:
    print("Method      Recall@1  Recall@3  Recall@5  MRR")
    for method in METHODS:
        if method not in scores:
            continue
        row = scores[method]
        print(f"{method:10}  {row['recall_at_1']:.4f}    {row['recall_at_3']:.4f}    {row['recall_at_5']:.4f}    {row['mrr']:.4f}")
    for method in METHODS:
        censored = scores.get(method, {}).get("censored_misses", 0)
        if censored:
            print(f"warning: {method} has {int(censored)} gold case(s) unranked within the retrieved chunk depth; metrics are a lower bound")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--score", type=Path, help="Score an existing result file without calling Databricks")
    parser.add_argument("--num-results", type=int, default=20)
    args = parser.parse_args()

    if args.score:
        payload = json.loads(args.score.read_text(encoding="utf-8"))
        try:
            runs = validate_runs(payload["runs"], load_queries())
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        if payload.get("query_file_sha256") not in (None, query_file_digest()):
            print("error: result file was produced against a different query set", file=sys.stderr)
            return 2
        print_scores(score_runs(runs))
        return 0

    host = os.environ.get("DATABRICKS_HOST")
    token = os.environ.get("DATABRICKS_TOKEN")
    index_name = os.environ.get("DATABRICKS_INDEX_NAME")
    if not all((host, token, index_name)):
        print("DATABRICKS_HOST, DATABRICKS_TOKEN, and DATABRICKS_INDEX_NAME are required", file=sys.stderr)
        return 2
    if not 5 <= args.num_results <= 50:
        parser.error("--num-results must be between 5 and 50")

    queries = load_queries()
    runs: list[dict[str, Any]] = []
    for row in queries:
        for method in METHODS:
            payload = query_index(host, token, index_name, row["query"], method, args.num_results)
            ranked_case_ids = collapse_case_ids(payload)
            chunks_returned = chunk_row_count(payload)
            runs.append({
                "query_id": row["query_id"],
                "method": method,
                "primary_gold_case": row["primary_gold_case"],
                "other_relevant_cases": [case for case in row["other_relevant_cases"].split("|") if case],
                "ranked_case_ids": ranked_case_ids,
                "chunks_returned": chunks_returned,
                # The requested chunk depth was exhausted, so cases may exist below the window.
                "censored": chunks_returned >= args.num_results,
            })
            print(f"{row['query_id']} {method}: {', '.join(ranked_case_ids)}")

    result = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "index_name": index_name,
        "num_chunk_results": args.num_results,
        "query_file": str(QUERIES_PATH.relative_to(ROOT)),
        "query_file_sha256": query_file_digest(),
        "git_commit": git_commit(),
        "runs": runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print_scores(score_runs(validate_runs(runs, queries)))
    print(f"Saved auditable rankings to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
