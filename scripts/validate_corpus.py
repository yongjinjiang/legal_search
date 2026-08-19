#!/usr/bin/env python3
"""Validate the prepared legal-search corpus and print corpus statistics."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import pymupdf


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw_pdfs"
METADATA_PATH = ROOT / "data" / "metadata" / "metadata.csv"
QUERIES_PATH = ROOT / "data" / "evaluation" / "legal_search_queries.csv"
TEXT_DIR = ROOT / "data" / "extracted_text"


def read_csv(path: Path, required: set[str], errors: list[str]) -> list[dict[str, str]]:
    if not path.is_file():
        errors.append(f"Missing CSV: {path.relative_to(ROOT)}")
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or [])
        missing = required - fields
        if missing:
            errors.append(f"{path.name} lacks columns: {', '.join(sorted(missing))}")
        return list(reader)


def find_duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(duplicates)


def main() -> int:
    errors: list[str] = []
    metadata = read_csv(METADATA_PATH, {"case_id", "file_name"}, errors)
    queries = read_csv(
        QUERIES_PATH,
        {"query_id", "primary_gold_case", "other_relevant_cases", "query_style"},
        errors,
    )

    case_ids = [row.get("case_id", "").strip() for row in metadata]
    query_ids = [row.get("query_id", "").strip() for row in queries]
    if "" in case_ids:
        errors.append("One or more metadata rows have an empty case_id")
    if "" in query_ids:
        errors.append("One or more query rows have an empty query_id")
    for duplicate in find_duplicates(case_ids):
        errors.append(f"Duplicate case_id: {duplicate}")
    for duplicate in find_duplicates(query_ids):
        errors.append(f"Duplicate query_id: {duplicate}")

    known_cases = set(case_ids)
    for row in queries:
        query_id = row.get("query_id", "<unknown>")
        primary = row.get("primary_gold_case", "").strip()
        if primary not in known_cases:
            errors.append(f"{query_id}: unknown primary_gold_case {primary!r}")
        others = [item.strip() for item in row.get("other_relevant_cases", "").split("|") if item.strip()]
        for case_id in others:
            if case_id not in known_cases:
                errors.append(f"{query_id}: unknown other_relevant_cases ID {case_id!r}")

    rows: list[tuple[str, int, int, int]] = []
    for row in metadata:
        filename = row.get("file_name", "").strip()
        pdf_path = RAW_DIR / filename
        if not pdf_path.is_file():
            errors.append(f"Missing metadata PDF: {filename}")
            continue
        try:
            byte_size = pdf_path.stat().st_size
            with pymupdf.open(pdf_path) as document:
                page_count = document.page_count
                if document.needs_pass:
                    errors.append(f"Unreadable password-protected PDF: {filename}")
                if page_count < 1:
                    errors.append(f"PDF has no pages: {filename}")
        except Exception as exc:
            errors.append(f"Unreadable PDF {filename}: {exc}")
            continue

        text_path = TEXT_DIR / f"{Path(filename).stem}.txt"
        if not text_path.is_file():
            errors.append(f"Missing extracted text: {text_path.name}")
            char_count = 0
        else:
            try:
                extracted = text_path.read_text(encoding="utf-8")
                char_count = len(extracted)
                if not extracted.strip():
                    errors.append(f"Empty extracted text: {text_path.name}")
                marker_count = sum(1 for line in extracted.splitlines() if line.startswith("--- PAGE "))
                if marker_count != page_count:
                    errors.append(
                        f"Page-marker mismatch for {text_path.name}: {marker_count} markers, {page_count} pages"
                    )
            except (OSError, UnicodeError) as exc:
                errors.append(f"Unreadable UTF-8 text {text_path.name}: {exc}")
                char_count = 0
        rows.append((filename, byte_size, page_count, char_count))

    print("Legal Search Corpus Validation")
    print("=" * 94)
    print(f"{'PDF':45} {'Bytes':>12} {'Pages':>8} {'Extracted chars':>18}")
    print("-" * 94)
    for filename, byte_size, page_count, char_count in rows:
        print(f"{filename:45} {byte_size:12,d} {page_count:8,d} {char_count:18,d}")
    print("-" * 94)
    print(
        f"Totals: {len(metadata)} cases, {sum(row[2] for row in rows):,} pages, "
        f"{sum(row[3] for row in rows):,} extracted characters, {len(queries)} queries"
    )
    if errors:
        print(f"\nFAILED ({len(errors)} error(s)):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("\nPASS: all corpus validation checks succeeded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
