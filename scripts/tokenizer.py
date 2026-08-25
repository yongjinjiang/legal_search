#!/usr/bin/env python3
"""Load the tiktoken BPE encoding with an explicit, actionable failure mode.

tiktoken ships no encoding data. The first call to get_encoding downloads the BPE asset from
openaipublic.blob.core.windows.net and caches it, so chunking and chunk validation are not
offline operations on a cold cache. Without this wrapper an offline run fails deep inside
urllib with a stack trace that says nothing about what is missing.
"""

from __future__ import annotations

import sys

import tiktoken

ENCODING_NAME = "cl100k_base"
ASSET_URL = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"


def load_encoding(name: str = ENCODING_NAME) -> tiktoken.Encoding:
    try:
        return tiktoken.get_encoding(name)
    except Exception as error:  # noqa: BLE001 - tiktoken surfaces several unrelated network errors
        raise SystemExit(
            f"error: could not load the '{name}' tokenizer: {error}\n"
            f"tiktoken downloads this asset on first use from {ASSET_URL} and caches it.\n"
            "Run 'make tokenizer' once with network access, or set TIKTOKEN_CACHE_DIR to a\n"
            "directory that already holds the cached asset."
        ) from error


def main() -> int:
    encoding = load_encoding()
    assert encoding.encode("preflight")
    print(f"tokenizer '{ENCODING_NAME}' is available and cached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
