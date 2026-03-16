#!/usr/bin/env python3
"""
One command to add a book to the pipeline: PDF → chunk → embed → ChromaDB.

Runs chunk_elements.py then embed_and_store.py so you add a new source with a single call.
Requires OPENAI_API_KEY. ChromaDB collection grows with each book (no --replace).

Usage:
  python scripts/add_book.py "/path/to/Light Science and Magic.pdf" \\
    --source "Light Science and Magic" --author "Fil Hunter, Steven Biver, Paul Fuqua" --topic lighting
  python scripts/add_book.py "/path/to/Photographer's Guide to Posing.pdf" \\
    --source "The Photographer's Guide to Posing" --author "Lindsay Adler" --topic posing
"""

import argparse
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    parser = argparse.ArgumentParser(
        description="Add a PDF to the knowledge base: extract → chunk → embed → store.",
    )
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("--source", "-s", required=True, help="Book/source title")
    parser.add_argument("--author", "-a", required=True, help="Author(s)")
    parser.add_argument("--topic", "-t", default="general",
                        choices=["lighting", "posing", "gear", "color_theory", "client_psychology", "business", "general"],
                        help="Topic category")
    parser.add_argument("--chunk-size", type=int, default=512, help="Chunk size in tokens")
    parser.add_argument("--overlap", type=int, default=64, help="Chunk overlap in tokens")
    parser.add_argument("--out-dir", default="data/chunks", help="Where to write chunk JSON")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB path")
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name")
    args = parser.parse_args()

    if not os.path.isfile(args.pdf_path):
        print(f"File not found: {args.pdf_path}", file=sys.stderr)
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("Set OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(1)

    source_slug = slug(args.source)
    chunk_json = os.path.join(PROJECT_ROOT, args.out_dir, f"{source_slug}.json")

    # 1. Chunk the PDF
    chunk_cmd = [
        sys.executable,
        os.path.join(SCRIPT_DIR, "chunk_elements.py"),
        args.pdf_path,
        "--source", args.source,
        "--author", args.author,
        "--topic", args.topic,
        "--chunk-size", str(args.chunk_size),
        "--overlap", str(args.overlap),
        "--out-dir", os.path.join(PROJECT_ROOT, args.out_dir),
    ]
    print("Step 1/2: Chunking PDF...")
    r = subprocess.run(chunk_cmd, cwd=PROJECT_ROOT)
    if r.returncode != 0:
        sys.exit(r.returncode)

    if not os.path.isfile(chunk_json):
        print(f"Chunk file not created: {chunk_json}", file=sys.stderr)
        sys.exit(1)

    # 2. Embed and store (upsert into existing collection)
    embed_cmd = [
        sys.executable,
        os.path.join(SCRIPT_DIR, "embed_and_store.py"),
        chunk_json,
        "--collection", args.collection,
        "--db-path", os.path.join(PROJECT_ROOT, args.db_path),
    ]
    print("Step 2/2: Embedding and storing in ChromaDB...")
    r = subprocess.run(embed_cmd, cwd=PROJECT_ROOT)
    if r.returncode != 0:
        sys.exit(r.returncode)

    print(f"Done. '{args.source}' is in the knowledge base. Ask questions with scripts/ask.py")


if __name__ == "__main__":
    main()
