.PHONY: prepare validate chunks validate-chunks all

PYTHON := .venv/bin/python

prepare:
	$(PYTHON) scripts/prepare_corpus.py
	$(PYTHON) scripts/validate_corpus.py

validate:
	$(PYTHON) scripts/validate_corpus.py

chunks:
	$(PYTHON) scripts/chunk_corpus.py
	$(PYTHON) scripts/validate_chunks.py

validate-chunks:
	$(PYTHON) scripts/validate_chunks.py

all: prepare chunks
