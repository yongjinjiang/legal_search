# Chunking Report

## Configuration

- Tokenizer: `cl100k_base` via `tiktoken`
- Target: 900 tokens
- Preferred range: 700-1000 tokens
- Overlap target: 125 tokens
- Boundary strategy: page-aware paragraphs, then sentences for oversized paragraphs

## Summary

- Total chunks: 234
- Minimum tokens: 249
- Median tokens: 905.0
- Mean tokens: 886.3
- Maximum tokens: 998
- Chunks below 700: 6
- Chunks above 1000: 0

## Chunks per case

| Case ID | Chunks |
|---|---:|
| `bostock_clayton` | 101 |
| `burlington_white` | 20 |
| `crawford_nashville` | 10 |
| `jackson_birmingham` | 23 |
| `kasten_saint_gobain` | 20 |
| `murray_ubs` | 14 |
| `nassar` | 39 |
| `thompson_nas` | 7 |

## Token-count distribution

| Range | Chunks |
|---|---:|
| <700 | 6 |
| 700-799 | 20 |
| 800-899 | 79 |
| 900-1000 | 129 |
| >1000 | 0 |

## Warnings

- `burlington_white` has a short final chunk (377 tokens); retained to avoid crossing case boundaries.
- `01_burlington_v_white.txt` contained 242 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `crawford_nashville` has a short final chunk (558 tokens); retained to avoid crossing case boundaries.
- `02_crawford_v_nashville.txt` contained 100 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `03_thompson_v_north_american_stainless.txt` contained 79 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `03_thompson_v_north_american_stainless.txt` contained 2 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
- `04_nassar.txt` contained 354 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
- `04_nassar.txt` contains questionable OCR-like text preserved without correction: `ąfth` (1), `affliation` (6), `fled suit` (2).
- `murray_ubs` has a short final chunk (598 tokens); retained to avoid crossing case boundaries.
- `05_murray_v_ubs.txt` contained 159 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `05_murray_v_ubs.txt` contained 8 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
- `jackson_birmingham` has a short final chunk (564 tokens); retained to avoid crossing case boundaries.
- `06_jackson_v_birmingham.txt` contained 215 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
- `kasten_saint_gobain` has a short final chunk (551 tokens); retained to avoid crossing case boundaries.
- `07_kasten_v_saint_gobain.txt` contained 164 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `07_kasten_v_saint_gobain.txt` contained 4 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
- `bostock_clayton` has a short final chunk (249 tokens); retained to avoid crossing case boundaries.
- `08_bostock_v_clayton_county.txt` contained 1063 soft-hyphen line-wrap artifact(s); removed in chunks only.
- `08_bostock_v_clayton_county.txt` contained 106 line-ending hyphen wrap(s); whitespace after the hyphen was removed in chunks only.
