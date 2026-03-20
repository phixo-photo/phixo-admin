#!/usr/bin/env python3
"""
Algonquin-specific PDF chunking + image extraction.

Key differences from the regular pipeline:
1) Chunk IDs include a unique book_slug derived from (source_document, sub_source, original_filename),
   so chunks from different uploads never collide in Chroma upsert.
2) Embedded image extraction writes to images/<unique-book-slug>/..., so images never overwrite.

Output: writes one chunk JSON file ready for embed_and_store.py.
"""

import argparse
import hashlib
import json
import os
import sys
import traceback


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from chunk_elements import get_encoder, make_chunks, slug  # type: ignore


def sha_short(s: str, n: int = 10) -> str:
    return hashlib.sha1(s.encode("utf-8", errors="ignore")).hexdigest()[:n]


def main() -> int:
    parser = argparse.ArgumentParser(description="Algonquin PDF chunking to chunk JSON.")
    parser.add_argument("--pdf-path", required=True, help="Path to PDF file")
    parser.add_argument("--data-path", required=True, help="DATA_PATH root (contains images/ and is the Chroma parent)")
    parser.add_argument("--out-dir", required=True, help="Directory to write the chunk JSON")

    parser.add_argument("--source-document", required=True, help="Chroma metadata: source_document")
    parser.add_argument("--sub-source", required=True, help="Chroma metadata: sub_source")
    parser.add_argument("--topic", required=True, help="Chroma metadata: topic (e.g. algonquin-college)")
    parser.add_argument("--file-type", required=True, choices=["pdf", "doc"], help="Chroma metadata: file_type")
    parser.add_argument("--original-filename", required=True, help="Chroma metadata: original_filename")
    parser.add_argument("--author", default="Algonquin College", help="Optional Chroma metadata: author")

    parser.add_argument("--chunk-size", type=int, default=512, help="Chunk size in tokens")
    parser.add_argument("--overlap", type=int, default=64, help="Chunk overlap in tokens")
    args = parser.parse_args()

    if not os.path.isfile(args.pdf_path):
        print(f"File not found: {args.pdf_path}", file=sys.stderr)
        return 1

    os.makedirs(args.out_dir, exist_ok=True)

    source_document = str(args.source_document)
    sub_source = str(args.sub_source)
    original_filename = str(args.original_filename)

    source_document_slug = slug(source_document)
    sub_slug = slug(sub_source)
    filename_hash = sha_short(original_filename, 10)
    # Unique per-upload "book" namespace for images + chunk ids.
    book_slug = f"{source_document_slug}__{sub_slug}__{filename_hash}"

    encoder = get_encoder()
    try:
        from pdfminer.high_level import extract_text
    except Exception as e:
        print(f"Failed importing pdfminer: {e}", file=sys.stderr)
        return 1

    print("Loading PDF and extracting text...")
    raw_text = extract_text(args.pdf_path) or ""
    page_texts = []
    for page_number, page_raw in enumerate(raw_text.split("\f"), 1):
        cleaned = "\n\n".join(line.strip() for line in page_raw.splitlines() if line.strip())
        if cleaned:
            page_texts.append((page_number, cleaned))

    if not page_texts:
        print("No text extracted from PDF.", file=sys.stderr)
        return 1

    print(f"Building chunks ({args.chunk_size} tokens, {args.overlap} overlap)...")
    chunks_with_meta = []

    for page_number, page_text in page_texts:
        text_chunks = make_chunks(
            page_text,
            chunk_size=args.chunk_size,
            overlap=args.overlap,
            encoder=encoder,
        )
        for i, text in enumerate(text_chunks):
            if not text:
                continue
            chunk_id = f"{book_slug}_p{int(page_number):04d}_chunk_{i:04d}"
            chunks_with_meta.append(
                {
                    "chunk_id": chunk_id,
                    "text": text,
                    "metadata": {
                        "chunk_id": chunk_id,
                        "chunk_type": "text",
                        "page_number": int(page_number),
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

    # Extract embedded images into a unique folder.
    images_root = os.path.join(args.data_path, "images")
    book_images_dir = os.path.join(images_root, book_slug)

    extracted_images = 0
    skipped_small = 0
    existing_images = 0

    try:
        import fitz  # pymupdf

        print("Extracting embedded images (PyMuPDF)...")
        doc = fitz.open(args.pdf_path)
        for page_index in range(len(doc)):
            page_number = page_index + 1
            page = doc[page_index]
            imgs = page.get_images() or []
            for img_idx, img in enumerate(imgs):
                xref = img[0]
                filename = f"page{page_number:04d}_{img_idx:02d}.jpg"
                out_path = os.path.join(book_images_dir, filename)
                if os.path.exists(out_path):
                    existing_images += 1
                    continue
                try:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.n - pix.alpha > 3:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    if pix.width < 200 or pix.height < 200:
                        skipped_small += 1
                        continue
                    os.makedirs(book_images_dir, exist_ok=True)
                    pix.save(out_path)
                    extracted_images += 1
                except Exception:
                    # Best-effort: image extraction errors should not prevent text ingest.
                    continue
    except Exception:
        # Best-effort: if PyMuPDF fails, still allow text chunking + embedding.
        pass

    out_filename = f"algonquin__{book_slug}.json"
    out_path = os.path.join(args.out_dir, out_filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(chunks_with_meta, f, indent=2, ensure_ascii=False)

    print(
        f"Algonquin PDF chunking done: chunks={len(chunks_with_meta)} "
        f"images_saved={extracted_images} images_existing={existing_images} too_small_skipped={skipped_small}"
    )
    print(f"Wrote {out_path}")
    # Machine-readable payload for the Node server.
    print(
        json.dumps(
            {"ok": True, "chunk_path": out_path, "chunks": len(chunks_with_meta)},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

