#!/usr/bin/env python3
"""
Step 2: Take extracted PDF elements → fixed-size chunks (512 tokens, 64 overlap) + metadata.

Run after you're happy with the extraction from ingest_one_pdf.py.
Output: chunks with required metadata (source_document, copyright_status, etc.) for the next step (embed + ChromaDB).

Usage:
  python scripts/chunk_elements.py path/to/file.pdf --source "The Natural Light Portrait Book" --author "Scott Kelby"
  python scripts/chunk_elements.py path/to/file.pdf --source "Light Science and Magic" --author "Fil Hunter, Steven Biver, Paul Fuqua" --topic lighting

Writes chunks to data/chunks/<source_slug>.json by default (use --no-write to only print summary).
"""

import argparse
import json
import logging
import os
import re
import sys
import warnings

warnings.filterwarnings("ignore", message=".*[Ff]ont[Bb]ox.*")
warnings.filterwarnings("ignore", message=".*font descriptor.*")
logging.getLogger("pdfminer").setLevel(logging.ERROR)
logging.getLogger("unstructured").setLevel(logging.ERROR)


# Token counting (512 chunk, 64 overlap per plan)
def get_encoder():
    try:
        import tiktoken
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return None


def make_chunks(full_text: str, chunk_size: int = 512, overlap: int = 64, encoder=None):
    """Split text into chunk_size token chunks with overlap tokens."""
    if encoder is not None:
        tokens = encoder.encode(full_text)
        chunks = []
        start = 0
        while start < len(tokens):
            end = start + chunk_size
            chunk_tokens = tokens[start:end]
            if not chunk_tokens:
                break
            chunk_text = encoder.decode(chunk_tokens).strip()
            if chunk_text:
                chunks.append(chunk_text)
            if end >= len(tokens):
                break
            start = end - overlap
        return chunks
    # Fallback without tiktoken: ~4 chars per token
    c_size = chunk_size * 4
    c_overlap = overlap * 4
    chunks = []
    start = 0
    while start < len(full_text):
        end = start + c_size
        chunk_text = full_text[start:end].strip()
        if chunk_text:
            chunks.append(chunk_text)
        if end >= len(full_text):
            break
        start = end - c_overlap
    return chunks


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    parser = argparse.ArgumentParser(description="Chunk PDF elements into 512/64 token chunks with metadata.")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("--source", "-s", required=True, help="Source document title (e.g. 'The Natural Light Portrait Book')")
    parser.add_argument("--author", "-a", required=True, help="Author(s) (e.g. 'Scott Kelby')")
    parser.add_argument("--topic", "-t", default="general", choices=["lighting", "posing", "gear", "color_theory", "client_psychology", "business", "general"],
                        help="Topic category for the document")
    parser.add_argument("--chunk-size", type=int, default=512, help="Chunk size in tokens (default 512)")
    parser.add_argument("--overlap", type=int, default=64, help="Overlap in tokens (default 64)")
    parser.add_argument("--out-dir", default="data/chunks", help="Directory to write chunk JSON (default data/chunks)")
    parser.add_argument("--no-write", action="store_true", help="Only print summary, do not write JSON")
    args = parser.parse_args()

    if not os.path.isfile(args.pdf_path):
        print(f"File not found: {args.pdf_path}", file=sys.stderr)
        sys.exit(1)

    encoder = get_encoder()
    if encoder is None:
        print("Warning: tiktoken not installed; using character-based approximate chunking. Install with: pip install tiktoken", file=sys.stderr)

    print("Loading PDF and extracting text (lightweight)...")
    # IMPORTANT:
    # We intentionally avoid `unstructured.partition.pdf` here because it can pull in
    # heavy dependencies (cv2 / unstructured-inference) that may not be available
    # on Railway and often fail with missing system libs like `libxcb.so.1`.
    #
    # For our Phase 1 pipeline we only need text to chunk + embed.
    from pdfminer.high_level import extract_text

    full_text = extract_text(args.pdf_path) or ""
    full_text = "\n\n".join(line.strip() for line in full_text.splitlines() if line.strip())
    if not full_text.strip():
        print("No text extracted from PDF.", file=sys.stderr)
        sys.exit(1)

    print(f"Building chunks ({args.chunk_size} tokens, {args.overlap} overlap)...")
    text_chunks = make_chunks(full_text, chunk_size=args.chunk_size, overlap=args.overlap, encoder=encoder)

    source_slug = slug(args.source)
    chunks_with_meta = []
    for i, text in enumerate(text_chunks):
        if not text:
            continue
        chunk_id = f"{source_slug}_chunk_{i:04d}"
        chunks_with_meta.append({
            "chunk_id": chunk_id,
            "text": text,
            "metadata": {
                "chunk_id": chunk_id,
                "source_document": args.source,
                "author": args.author,
                "chapter": "unknown",
                "topic_category": args.topic,
                "content_type": "narrative",
                "copyright_status": "copyrighted_private",
            },
        })

    print(f"Created {len(chunks_with_meta)} chunks from {len(elements)} elements.")

    if not args.no_write:
        os.makedirs(args.out_dir, exist_ok=True)
        out_path = os.path.join(args.out_dir, f"{source_slug}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(chunks_with_meta, f, indent=2, ensure_ascii=False)
        print(f"Wrote {out_path}")

    # Show first chunk as sample
    if chunks_with_meta:
        print("\n--- Sample chunk (first) ---")
        c = chunks_with_meta[0]
        print("metadata:", c["metadata"])
        print("text preview:", (c["text"][:300] + "..." if len(c["text"]) > 300 else c["text"]))


if __name__ == "__main__":
    main()
