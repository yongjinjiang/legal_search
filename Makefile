.PHONY: setup fetch prepare validate validate-corpus chunks validate-chunks all bootstrap test-python

PYTHON := .venv/bin/python

setup:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r requirements.txt

fetch:
	$(PYTHON) scripts/fetch_corpus.py

prepare:
	$(PYTHON) scripts/prepare_corpus.py
	$(PYTHON) scripts/validate_corpus.py

validate: validate-corpus validate-chunks

validate-corpus:
	$(PYTHON) scripts/validate_corpus.py

chunks:
	$(PYTHON) scripts/chunk_corpus.py
	$(PYTHON) scripts/validate_chunks.py

validate-chunks:
	$(PYTHON) scripts/validate_chunks.py

all: prepare chunks

bootstrap: setup fetch all

test-python:
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py'
