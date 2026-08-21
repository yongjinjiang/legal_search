#!/usr/bin/env python3
"""Run and score the legal-search benchmark against a Databricks AI Search index."""

from __future__ import annotations

import argparse
import csv
import json
import os
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


def collapse_case_ids(payload: dict[str, Any], limit: int = 5) -> list[str]:
    """Map Databricks chunk rows to unique case IDs in retrieval order."""
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
        if len(ranked) == limit:
            break
    return ranked


def score_runs(runs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Compute primary-gold Recall@k and MRR for every retrieval method."""
    scores: dict[str, dict[str, float]] = {}
    for method in METHODS:
        method_runs = [run for run in runs if run["method"] == method]
        if not method_runs:
            continue
        ranks: list[int | None] = []
        for run in method_runs:
            ranked = run["ranked_case_ids"]
            try:
                ranks.append(ranked.index(run["primary_gold_case"]) + 1)
            except ValueError:
                ranks.append(None)
        total = len(ranks)
        scores[method] = {
            "queries": float(total),
            "recall_at_1": sum(rank is not None and rank <= 1 for rank in ranks) / total,
            "recall_at_3": sum(rank is not None and rank <= 3 for rank in ranks) / total,
            "recall_at_5": sum(rank is not None and rank <= 5 for rank in ranks) / total,
            "mrr": sum(1 / rank for rank in ranks if rank is not None) / total,
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--score", type=Path, help="Score an existing result file without calling Databricks")
    parser.add_argument("--num-results", type=int, default=20)
    args = parser.parse_args()

    if args.score:
        payload = json.loads(args.score.read_text(encoding="utf-8"))
        print_scores(score_runs(payload["runs"]))
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
            runs.append({
                "query_id": row["query_id"],
                "method": method,
                "primary_gold_case": row["primary_gold_case"],
                "other_relevant_cases": [case for case in row["other_relevant_cases"].split("|") if case],
                "ranked_case_ids": ranked_case_ids,
            })
            print(f"{row['query_id']} {method}: {', '.join(ranked_case_ids)}")

    result = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "index_name": index_name,
        "num_chunk_results": args.num_results,
        "query_file": str(QUERIES_PATH.relative_to(ROOT)),
        "runs": runs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print_scores(score_runs(runs))
    print(f"Saved auditable rankings to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
