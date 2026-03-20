#!/usr/bin/env python3
"""
Algonquin text chunking for DOCX (after text extraction), TXT, and Whisper transcripts.

This uses the same chunking logic as the existing chunk_elements.py (make_chunks),
but writes chunk JSON with Algonquin-required metadata and upload-unique book_slug.
"""

import argparse
import hashlib
import json
import os
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from chunk_elements import get_encoder, make_chunks, slug  # type: ignore


def sha_short(s: str, n: int = 10) -> str:
    return hashlib.sha1(s.encode("utf-8", errors="ignore")).hexdigest()[:n]


def main() -> int:
    parser = argparse.ArgumentParser(description="Algonquin text chunking to chunk JSON.")
    parser.add_argument("--text-path", required=True, help="Path to text file to chunk")
    parser.add_argument("--out-dir", required=True, help="Directory to write the chunk JSON")

    parser.add_argument("--source-document", required=True, help="Chroma metadata: source_document")
    parser.add_argument("--sub-source", required=True, help="Chroma metadata: sub_source")
    parser.add_argument("--topic", required=True, help="Chroma metadata: topic (e.g. algonquin-college)")
    parser.add_argument("--file-type", required=True, choices=["pdf", "doc", "video", "audio"], help="Chroma metadata: file_type")
    parser.add_argument("--original-filename", required=True, help="Chroma metadata: original_filename")
    parser.add_argument("--author", default="Algonquin College", help="Optional Chroma metadata: author")

    parser.add_argument("--chunk-size", type=int, default=512, help="Chunk size in tokens")
    parser.add_argument("--overlap", type=int, default=64, help="Chunk overlap in tokens")
    args = parser.parse_args()

    if not os.path.isfile(args.text_path):
        print(f"Text file not found: {args.text_path}", file=sys.stderr)
        return 1

    os.makedirs(args.out_dir, exist_ok=True)

    text = ""
    with open(args.text_path, "r", encoding="utf-8", errors="ignore") as f:
        text = f.read() or ""
    text = text.strip()
    if not text:
        print("No text to chunk.", file=sys.stderr)
        return 1

    source_document = str(args.source_document)
    sub_source = str(args.sub_source)
    original_filename = str(args.original_filename)

    source_document_slug = slug(source_document)
    sub_slug = slug(sub_source)
    filename_hash = sha_short(original_filename, 10)
    book_slug = f"{source_document_slug}__{sub_slug}__{filename_hash}"

    encoder = get_encoder()
    print(f"Chunking Algonquin text ({len(text)} chars)...")
    text_chunks = make_chunks(text, chunk_size=args.chunk_size, overlap=args.overlap, encoder=encoder)

    chunks_with_meta = []
    for i, chunk_text in enumerate(text_chunks):
        if not chunk_text:
            continue
        chunk_id = f"{book_slug}_chunk_{i:04d}"
        chunks_with_meta.append(
            {
                "chunk_id": chunk_id,
                "text": chunk_text,
                "metadata": {
                    "chunk_id": chunk_id,
                    "chunk_type": "text",
                    # No pages for transcripts / extracted text.
                    "page_number": None,
                    "book_slug": book_slug,
                    "source_document": source_document,
                    "sub_source": sub_source,
                    "author": args.author,
                    "chapter": "unknown",
                    "topic_category": args.topic,
                    "topic": args.topic,
                    "file_type": args.file_type,
                    "original_filename": original_filename,
                    "content_type": "narrative",
                    "copyright_status": "copyrighted_private",
                },
            }
        )

    out_filename = f"algonquin__{book_slug}.json"
    out_path = os.path.join(args.out_dir, out_filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(chunks_with_meta, f, indent=2, ensure_ascii=False)

    print(f"Algonquin text chunking done: chunks={len(chunks_with_meta)}")
    print(f"Wrote {out_path}")
    # Machine-readable payload for the Node server.
    print(json.dumps({"ok": True, "chunk_path": out_path, "chunks": len(chunks_with_meta)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

