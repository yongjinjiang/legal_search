#!/usr/bin/env python3
"""Create deterministic, provenance-aware retrieval chunks from extracted case text."""

from __future__ import annotations

import csv
import re
import statistics
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import tiktoken
try:  # imported as scripts.<module> by the test suite, run directly by the Makefile
    from scripts.tokenizer import load_encoding
except ImportError:
    from tokenizer import load_encoding


ROOT = Path(__file__).resolve().parents[1]
METADATA_PATH = ROOT / "data" / "metadata" / "metadata.csv"
TEXT_DIR = ROOT / "data" / "extracted_text"
CHUNK_DIR = ROOT / "data" / "chunks"
CSV_PATH = CHUNK_DIR / "legal_chunks.csv"
PARQUET_PATH = CHUNK_DIR / "legal_chunks.parquet"
REPORT_PATH = ROOT / "chunking_report.md"

PAGE_RE = re.compile(r"(?m)^--- PAGE (\d+) ---\s*$")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9“‘\"(\[])" )
TARGET_TOKENS = 900
MIN_TOKENS = 700
MAX_TOKENS = 1000
OVERLAP_TOKENS = 125
UNIT_TARGET_TOKENS = 250
ENCODING_NAME = "cl100k_base"

FIELDS = [
    "chunk_id", "case_id", "case_name", "citation", "year", "court",
    "primary_topic", "page_start", "page_end", "chunk_text", "source_file", "source_url",
]


@dataclass(frozen=True)
class Unit:
    text: str
    page: int
    tokens: int


def token_count(text: str, encoding: tiktoken.Encoding) -> int:
    return len(encoding.encode(text))


def normalize_paragraph(text: str) -> str:
    """Remove PDF line-wrap artifacts while retaining substantive punctuation."""
    text = re.sub(r"\u00ad\s*", "", text)
    text = re.sub(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", "-", text)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_pages(text: str) -> list[tuple[int, str]]:
    matches = list(PAGE_RE.finditer(text))
    if not matches:
        raise ValueError("No page markers found")
    pages: list[tuple[int, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        pages.append((int(match.group(1)), text[start:end].strip()))
    expected = list(range(1, len(pages) + 1))
    actual = [page for page, _ in pages]
    if actual != expected:
        raise ValueError(f"Non-sequential page markers: expected {expected}, got {actual}")
    return pages


def split_oversized(text: str, page: int, encoding: tiktoken.Encoding) -> list[Unit]:
    sentences = [part.strip() for part in SENTENCE_RE.split(text) if part.strip()]
    if len(sentences) == 1:
        token_ids = encoding.encode(text)
        return [
            Unit(encoding.decode(token_ids[start:start + MAX_TOKENS]), page, len(token_ids[start:start + MAX_TOKENS]))
            for start in range(0, len(token_ids), MAX_TOKENS)
        ]
    units: list[Unit] = []
    buffer: list[str] = []
    for sentence in sentences:
        candidate = " ".join(buffer + [sentence])
        if buffer and token_count(candidate, encoding) > MAX_TOKENS:
            combined = " ".join(buffer)
            units.extend(split_oversized(combined, page, encoding) if token_count(combined, encoding) > MAX_TOKENS else [Unit(combined, page, token_count(combined, encoding))])
            buffer = [sentence]
        else:
            buffer.append(sentence)
    if buffer:
        combined = " ".join(buffer)
        units.extend(split_oversized(combined, page, encoding) if token_count(combined, encoding) > MAX_TOKENS else [Unit(combined, page, token_count(combined, encoding))])
    return units


def make_units(pages: list[tuple[int, str]], encoding: tiktoken.Encoding) -> list[Unit]:
    units: list[Unit] = []
    for page, page_text in pages:
        paragraphs = [normalize_paragraph(part) for part in re.split(r"\n\s*\n", page_text)]
        for paragraph in filter(None, paragraphs):
            count = token_count(paragraph, encoding)
            if count <= UNIT_TARGET_TOKENS:
                units.append(Unit(paragraph, page, count))
            else:
                sentences = [part.strip() for part in SENTENCE_RE.split(paragraph) if part.strip()]
                buffer: list[str] = []
                for sentence in sentences:
                    candidate = " ".join(buffer + [sentence])
                    if buffer and token_count(candidate, encoding) > UNIT_TARGET_TOKENS:
                        combined = " ".join(buffer)
                        units.extend(split_oversized(combined, page, encoding) if token_count(combined, encoding) > MAX_TOKENS else [Unit(combined, page, token_count(combined, encoding))])
                        buffer = [sentence]
                    else:
                        buffer.append(sentence)
                if buffer:
                    combined = " ".join(buffer)
                    units.extend(split_oversized(combined, page, encoding) if token_count(combined, encoding) > MAX_TOKENS else [Unit(combined, page, token_count(combined, encoding))])
    return units


def chunk_units(units: list[Unit], encoding: tiktoken.Encoding) -> list[tuple[str, int, int, int]]:
    chunks: list[tuple[str, int, int, int]] = []
    start = 0
    while start < len(units):
        end = start
        selected: list[Unit] = []
        while end < len(units):
            candidate = selected + [units[end]]
            candidate_text = "\n\n".join(unit.text for unit in candidate)
            count = token_count(candidate_text, encoding)
            if selected and count > MAX_TOKENS:
                break
            selected = candidate
            end += 1
            if count >= TARGET_TOKENS:
                break
        if not selected:
            selected = [units[start]]
            end = start + 1
        chunk_text = "\n\n".join(unit.text for unit in selected).strip()
        chunks.append((chunk_text, min(unit.page for unit in selected), max(unit.page for unit in selected), token_count(chunk_text, encoding)))
        if end >= len(units):
            break
        overlap = 0
        next_start = end
        while next_start > start + 1 and overlap < OVERLAP_TOKENS:
            next_start -= 1
            overlap += units[next_start].tokens
        start = next_start if next_start > start else end
    return chunks


def require_chunks(case_id: str, chunks: list[tuple[str, int, int, int]]) -> None:
    if not chunks:
        raise ValueError(f"{case_id}: no chunks produced; inspect the extracted text for empty or unreadable pages")


def write_outputs(rows: list[dict[str, object]]) -> None:
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    schema = pa.schema([
        pa.field("chunk_id", pa.string(), nullable=False),
        pa.field("case_id", pa.string(), nullable=False),
        pa.field("case_name", pa.string(), nullable=False),
        pa.field("citation", pa.string(), nullable=False),
        pa.field("year", pa.int32(), nullable=False),
        pa.field("court", pa.string(), nullable=False),
        pa.field("primary_topic", pa.string(), nullable=False),
        pa.field("page_start", pa.int32(), nullable=False),
        pa.field("page_end", pa.int32(), nullable=False),
        pa.field("chunk_text", pa.string(), nullable=False),
        pa.field("source_file", pa.string(), nullable=False),
        pa.field("source_url", pa.string(), nullable=False),
    ])
    table = pa.Table.from_pylist(rows, schema=schema)
    pq.write_table(table, PARQUET_PATH, compression="zstd", version="2.6")


def report(rows: list[dict[str, object]], token_counts: list[int], warnings: list[str]) -> str:
    per_case = Counter(str(row["case_id"]) for row in rows)
    ordered = sorted(token_counts)
    under = sum(count < MIN_TOKENS for count in token_counts)
    over = sum(count > MAX_TOKENS for count in token_counts)
    bins = [
        ("<700", sum(count < 700 for count in token_counts)),
        ("700-799", sum(700 <= count <= 799 for count in token_counts)),
        ("800-899", sum(800 <= count <= 899 for count in token_counts)),
        ("900-1000", sum(900 <= count <= 1000 for count in token_counts)),
        (">1000", sum(count > 1000 for count in token_counts)),
    ]
    lines = [
        "# Chunking Report", "", "## Configuration", "",
        f"- Tokenizer: `{ENCODING_NAME}` via `tiktoken`",
        f"- Target: {TARGET_TOKENS} tokens", f"- Preferred range: {MIN_TOKENS}-{MAX_TOKENS} tokens",
        f"- Overlap target: {OVERLAP_TOKENS} tokens", "- Boundary strategy: page-aware paragraphs, then sentences for oversized paragraphs",
        "", "## Summary", "", f"- Total chunks: {len(rows)}",
        f"- Minimum tokens: {min(ordered)}", f"- Median tokens: {statistics.median(ordered):.1f}",
        f"- Mean tokens: {statistics.mean(ordered):.1f}", f"- Maximum tokens: {max(ordered)}",
        f"- Chunks below {MIN_TOKENS}: {under}", f"- Chunks above {MAX_TOKENS}: {over}",
        "", "## Chunks per case", "", "| Case ID | Chunks |", "|---|---:|",
    ]
    lines.extend(f"| `{case_id}` | {count} |" for case_id, count in sorted(per_case.items()))
    lines.extend(["", "## Token-count distribution", "", "| Range | Chunks |", "|---|---:|"])
    lines.extend(f"| {label} | {count} |" for label, count in bins)
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in warnings) if warnings else lines.append("- None.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    encoding = load_encoding(ENCODING_NAME)
    with METADATA_PATH.open(encoding="utf-8-sig", newline="") as handle:
        metadata = list(csv.DictReader(handle))
    if not metadata:
        raise ValueError("Corpus metadata contains no cases")
    rows: list[dict[str, object]] = []
    warnings: list[str] = []
    token_counts: list[int] = []
    for case in metadata:
        source_file = Path(case["file_name"]).with_suffix(".txt").name
        text = (TEXT_DIR / source_file).read_text(encoding="utf-8")
        pages = parse_pages(text)
        units = make_units(pages, encoding)
        case_chunks = chunk_units(units, encoding)
        require_chunks(case["case_id"], case_chunks)
        for sequence, (chunk_text, page_start, page_end, count) in enumerate(case_chunks, start=1):
            rows.append({
                "chunk_id": f"{case['case_id']}__{sequence:04d}", "case_id": case["case_id"],
                "case_name": case["case_name"], "citation": case["citation"], "year": int(case["year"]),
                "court": case["court"], "primary_topic": case["primary_topic"], "page_start": page_start,
                "page_end": page_end, "chunk_text": chunk_text, "source_file": source_file,
                "source_url": case["source_url"],
            })
            token_counts.append(count)
        final_count = case_chunks[-1][3]
        if final_count < MIN_TOKENS:
            warnings.append(f"`{case['case_id']}` has a short final chunk ({final_count} tokens); retained to avoid crossing case boundaries.")
        soft_hyphens = text.count("\u00ad")
        if soft_hyphens:
            warnings.append(f"`{source_file}` contained {soft_hyphens} soft-hyphen line-wrap artifact(s); removed in chunks only.")
        replacement_count = text.count("�")
        if replacement_count:
            warnings.append(f"`{source_file}` contains {replacement_count} Unicode replacement character(s) from source extraction.")
        hard_wraps = len(re.findall(r"(?<=\w)-[ \t]*\n[ \t]*(?=\w)", text))
        if hard_wraps:
            warnings.append(f"`{source_file}` contained {hard_wraps} line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.")
        questionable = [(term, text.lower().count(term.lower())) for term in ("ąfth", "affliation", "fled suit")]
        found = [f"`{term}` ({count})" for term, count in questionable if count]
        if found:
            warnings.append(f"`{source_file}` contains questionable OCR-like text preserved without correction: {', '.join(found)}.")
    write_outputs(rows)
    REPORT_PATH.write_text(report(rows, token_counts, warnings), encoding="utf-8", newline="\n")
    print(f"Wrote {len(rows)} chunks to {CSV_PATH.relative_to(ROOT)} and {PARQUET_PATH.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
