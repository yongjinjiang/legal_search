#!/usr/bin/env python3
"""Download the public opinion PDFs and verify their pinned SHA-256 hashes."""

from __future__ import annotations

import csv
import hashlib
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
METADATA_PATH = ROOT / "data" / "metadata" / "metadata.csv"
HASHES_PATH = ROOT / "data" / "metadata" / "pdf_sha256.csv"
RAW_DIR = ROOT / "data" / "raw_pdfs"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    with METADATA_PATH.open(encoding="utf-8-sig", newline="") as handle:
        metadata = {row["file_name"]: row for row in csv.DictReader(handle)}
    with HASHES_PATH.open(encoding="utf-8", newline="") as handle:
        expected = {row["file_name"]: row["sha256"] for row in csv.DictReader(handle)}
    if metadata.keys() != expected.keys():
        raise ValueError("PDF hash manifest does not match corpus metadata")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for filename, row in metadata.items():
        destination = RAW_DIR / filename
        if destination.is_file() and sha256(destination) == expected[filename]:
            print(f"verified {filename}")
            continue
        temporary = destination.with_suffix(destination.suffix + ".download")
        try:
            request = urllib.request.Request(row["source_url"], headers={"User-Agent": "Legal-Retrieval-Explorer/1.0"})
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            actual = sha256(temporary)
            if actual != expected[filename]:
                raise ValueError(f"SHA-256 mismatch for {filename}: expected {expected[filename]}, got {actual}")
            temporary.replace(destination)
            print(f"downloaded and verified {filename}")
        finally:
            if temporary.exists():
                temporary.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
