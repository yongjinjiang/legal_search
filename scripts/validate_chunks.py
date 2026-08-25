#!/usr/bin/env python3
"""Validate CSV and Parquet retrieval chunks, provenance, and size distribution."""

from __future__ import annotations

import csv
import re
import statistics
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
try:  # imported as scripts.<module> by the test suite, run directly by the Makefile
    from scripts.tokenizer import load_encoding
except ImportError:
    from tokenizer import load_encoding


ROOT = Path(__file__).resolve().parents[1]
METADATA_PATH = ROOT / "data" / "metadata" / "metadata.csv"
CSV_PATH = ROOT / "data" / "chunks" / "legal_chunks.csv"
PARQUET_PATH = ROOT / "data" / "chunks" / "legal_chunks.parquet"
TEXT_DIR = ROOT / "data" / "extracted_text"
PAGE_RE = re.compile(r"(?m)^--- PAGE (\d+) ---\s*$")
REQUIRED = ["chunk_id", "case_id", "case_name", "citation", "year", "court", "primary_topic", "page_start", "page_end", "chunk_text", "source_file", "source_url"]


def normalize_source(text: str) -> str:
    text = re.sub(r"\u00ad\s*", "", text)
    text = re.sub(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", "-", text)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_page(text: str) -> str:
    return " ".join(normalize_source(part) for part in re.split(r"\n\s*\n", text) if normalize_source(part))


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    encoding = load_encoding()
    with METADATA_PATH.open(encoding="utf-8-sig", newline="") as handle:
        metadata = {row["case_id"]: row for row in csv.DictReader(handle)}
    with CSV_PATH.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != REQUIRED:
            errors.append(f"CSV columns differ from required order/schema: {reader.fieldnames}")
        csv_rows = list(reader)
    table = pq.read_table(PARQUET_PATH)
    parquet_rows = table.to_pylist()
    if table.column_names != REQUIRED:
        errors.append(f"Parquet columns differ from required order/schema: {table.column_names}")
    if len(csv_rows) != len(parquet_rows):
        errors.append(f"CSV/Parquet row mismatch: {len(csv_rows)} vs {len(parquet_rows)}")

    ids = [row["chunk_id"] for row in csv_rows]
    duplicates = sorted({item for item in ids if ids.count(item) > 1})
    if duplicates:
        errors.append(f"Duplicate chunk_id values: {duplicates}")
    page_counts = {}
    source_pages: dict[str, dict[int, str]] = {}
    for case_id, meta in metadata.items():
        source_file = Path(meta["file_name"]).with_suffix(".txt").name
        source_text = (TEXT_DIR / source_file).read_text(encoding="utf-8")
        matches = list(PAGE_RE.finditer(source_text))
        page_counts[case_id] = len(matches)
        source_pages[case_id] = {}
        for page_index, match in enumerate(matches):
            end = matches[page_index + 1].start() if page_index + 1 < len(matches) else len(source_text)
            source_pages[case_id][int(match.group(1))] = source_text[match.end():end]

    token_counts: list[int] = []
    per_case = Counter()
    for index, row in enumerate(csv_rows):
        chunk_id = row["chunk_id"]
        case_id = row["case_id"]
        if case_id not in metadata:
            errors.append(f"{chunk_id}: invalid case_id {case_id!r}")
            continue
        if not chunk_id.startswith(f"{case_id}__"):
            errors.append(f"{chunk_id}: chunk_id does not belong uniquely to case_id {case_id}")
        if not row["chunk_text"].strip():
            errors.append(f"{chunk_id}: empty chunk")
        try:
            start, end = int(row["page_start"]), int(row["page_end"])
            if not (1 <= start <= end <= page_counts[case_id]):
                errors.append(f"{chunk_id}: invalid page range {start}-{end} for {page_counts[case_id]} pages")
            else:
                source_range = " ".join(normalize_page(source_pages[case_id][page]) for page in range(start, end + 1))
                if normalize_source(row["chunk_text"]) not in source_range:
                    errors.append(f"{chunk_id}: chunk text is not traceable to its declared page range")
        except ValueError:
            errors.append(f"{chunk_id}: non-integer page range")
        meta = metadata[case_id]
        expected = {
            "case_name": meta["case_name"], "citation": meta["citation"], "year": meta["year"],
            "court": meta["court"], "primary_topic": meta["primary_topic"],
            "source_file": Path(meta["file_name"]).with_suffix(".txt").name, "source_url": meta["source_url"],
        }
        for field, value in expected.items():
            if row[field] != value:
                errors.append(f"{chunk_id}: {field} does not match metadata")
        if index < len(parquet_rows):
            normalized = {key: (str(value) if key in {"year", "page_start", "page_end"} else value) for key, value in parquet_rows[index].items()}
            if normalized != row:
                errors.append(f"{chunk_id}: CSV and Parquet values differ")
        count = len(encoding.encode(row["chunk_text"]))
        token_counts.append(count)
        per_case[case_id] += 1

    in_range = sum(700 <= count <= 1000 for count in token_counts)
    coverage = in_range / len(token_counts) if token_counts else 0
    if not token_counts:
        errors.append("No chunks found")
    elif coverage < 0.80:
        errors.append(f"Only {coverage:.1%} of chunks are in the preferred 700-1000 token range")
    if token_counts and max(token_counts) > 1050:
        errors.append(f"Maximum chunk size is unreasonably high: {max(token_counts)}")
    short = [count for count in token_counts if count < 700]
    if short:
        warnings.append(f"{len(short)} chunk(s) below 700 tokens; inspect report for case-final remainders")

    print("Legal Chunk Validation")
    print("=" * 72)
    print(f"Chunks: {len(csv_rows)}")
    for case_id, count in sorted(per_case.items()):
        print(f"  {case_id:28} {count:4d}")
    if token_counts:
        print(f"Token counts: min={min(token_counts)}, median={statistics.median(token_counts):.1f}, mean={statistics.mean(token_counts):.1f}, max={max(token_counts)}")
        print(f"Preferred range (700-1000): {in_range}/{len(token_counts)} ({coverage:.1%})")
    for warning in warnings:
        print(f"WARNING: {warning}")
    if errors:
        print(f"FAILED ({len(errors)} error(s)):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("PASS: all chunk validation checks succeeded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
