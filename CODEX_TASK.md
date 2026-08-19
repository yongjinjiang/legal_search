# Codex Task: Prepare the Legal Search Evaluation Corpus

You are working in the local project folder:

`/Users/shuaiyuan/Dropbox/Mac/Documents/legal search`

The folder already contains:

`data/raw_pdfs/`

with these eight PDFs:

1. `01_burlington_v_white.pdf`
2. `02_crawford_v_nashville.pdf`
3. `03_thompson_v_north_american_stainless.pdf`
4. `04_nassar.pdf`
5. `05_murray_v_ubs.pdf`
6. `06_jackson_v_birmingham.pdf`
7. `07_kasten_v_saint_gobain.pdf`
8. `08_bostock_v_clayton_county.pdf`

## Goal

Prepare a small, reproducible legal-search benchmark for later comparison of:

- semantic/vector retrieval
- full-text/keyword retrieval
- hybrid retrieval
- reranking

Do **not** build the search engine or UI yet. The current task is corpus preparation and benchmark validation only.

## Required work

1. Verify that all eight PDFs exist and are readable.
2. Create these directories if needed:
   - `data/metadata/`
   - `data/extracted_text/`
   - `data/evaluation/`
   - `scripts/`
3. Put the supplied `metadata.csv` into `data/metadata/metadata.csv`.
4. Put the supplied `legal_search_queries.csv` into `data/evaluation/legal_search_queries.csv`.
5. Extract text from every PDF using a reliable local Python library such as PyMuPDF.
   - Preserve page boundaries.
   - Save one UTF-8 text file per PDF in `data/extracted_text/`.
   - Prefix each page with a marker such as `--- PAGE 12 ---`.
6. Create `scripts/validate_corpus.py` that checks:
   - all metadata filenames map to real PDFs;
   - every PDF produced a nonempty extracted-text file;
   - every `primary_gold_case` and every ID in `other_relevant_cases` exists in metadata;
   - query IDs are unique;
   - case IDs are unique;
   - report PDF byte size, page count, and extracted character count.
7. Create `corpus_report.md` summarizing:
   - number of cases;
   - total pages;
   - per-case page count and extracted-text size;
   - number of benchmark queries by `query_style`;
   - any extraction warnings.
8. Run the validator and fix any errors.
9. Do not silently change legal labels or gold-case assignments. If you believe something is questionable, note it under a `Review notes` section in `corpus_report.md` rather than changing it.

## Engineering requirements

- Use a small Python virtual environment if the project does not already have one.
- Keep dependencies minimal.
- Add a `requirements.txt`.
- Make scripts rerunnable and idempotent.
- Do not modify the original PDFs.
- Do not use proprietary/company data.
- Do not upload the corpus to an external service.
- Show me the files created and the final validator output when finished.

## Optional, only if quick

Add a `Makefile` or a small `run_prepare.sh` so the entire preparation step can be rerun with one command.
