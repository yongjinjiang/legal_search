#!/usr/bin/env python3
"""Prepare the legal-search evaluation corpus from local source files."""

from __future__ import annotations

import argparse
import csv
from collections import Counter
from pathlib import Path

import pymupdf


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw_pdfs"
METADATA_DIR = ROOT / "data" / "metadata"
TEXT_DIR = ROOT / "data" / "extracted_text"
EVALUATION_DIR = ROOT / "data" / "evaluation"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def extract_pdf(pdf_path: Path, text_path: Path) -> tuple[int, int, list[str]]:
    warnings: list[str] = []
    sections: list[str] = []
    with pymupdf.open(pdf_path) as document:
        if document.needs_pass:
            raise ValueError(f"Password-protected PDF cannot be extracted: {pdf_path.name}")
        page_count = document.page_count
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text", sort=True).strip()
            if not text:
                warnings.append(f"{pdf_path.name}: page {page_number} yielded no text")
            sections.append(f"--- PAGE {page_number} ---\n{text}\n")
    output = "\n".join(sections)
    text_path.write_text(output, encoding="utf-8", newline="\n")
    return page_count, len(output), warnings


def build_report(
    metadata: list[dict[str, str]],
    queries: list[dict[str, str]],
    stats: list[tuple[dict[str, str], int, int]],
    warnings: list[str],
) -> str:
    styles = Counter(row["query_style"] for row in queries)
    total_pages = sum(page_count for _, page_count, _ in stats)
    lines = [
        "# Corpus Report",
        "",
        "## Summary",
        "",
        f"- Cases: {len(metadata)}",
        f"- Total pages: {total_pages}",
        f"- Benchmark queries: {len(queries)}",
        "",
        "## Cases",
        "",
        "| Case ID | PDF | Pages | Extracted characters |",
        "|---|---|---:|---:|",
    ]
    for row, page_count, char_count in stats:
        lines.append(
            f"| `{row['case_id']}` | `{row['file_name']}` | {page_count} | {char_count} |"
        )
    lines.extend(["", "## Queries by style", ""])
    for style, count in sorted(styles.items()):
        lines.append(f"- `{style}`: {count}")
    lines.extend(["", "## Extraction warnings", ""])
    if warnings:
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("- None.")
    lines.extend(
        [
            "",
            "## Review notes",
            "",
            "- None. Legal labels and gold-case assignments were copied without modification.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()

    for directory in (METADATA_DIR, TEXT_DIR, EVALUATION_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    metadata_path = METADATA_DIR / "metadata.csv"
    queries_path = EVALUATION_DIR / "legal_search_queries.csv"

    metadata = read_csv(metadata_path)
    queries = read_csv(queries_path)
    stats: list[tuple[dict[str, str], int, int]] = []
    warnings: list[str] = []
    for row in metadata:
        pdf_path = RAW_DIR / row["file_name"]
        if not pdf_path.is_file():
            raise FileNotFoundError(f"Metadata PDF is missing: {pdf_path}")
        text_path = TEXT_DIR / f"{pdf_path.stem}.txt"
        page_count, char_count, pdf_warnings = extract_pdf(pdf_path, text_path)
        stats.append((row, page_count, char_count))
        warnings.extend(pdf_warnings)

    report = build_report(metadata, queries, stats, warnings)
    (ROOT / "corpus_report.md").write_text(report, encoding="utf-8", newline="\n")
    print(f"Prepared {len(metadata)} cases, {sum(item[1] for item in stats)} pages, and {len(queries)} queries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
