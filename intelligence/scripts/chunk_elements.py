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
import base64
import json
import logging
import os
import re
import sys
import datetime
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


def _utc_iso() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


def append_ingest_log(log_path: str | None, job_id: str | None, payload: dict):
    if not log_path:
        return
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        base = {
            "time": _utc_iso(),
        }
        if job_id:
            base["jobId"] = job_id
        base.update(payload)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(base, ensure_ascii=False) + "\n")
    except Exception:
        # Logging must never break ingest.
        return


def describe_image_with_claude(image_bytes: bytes, media_type: str, model: str = "claude-haiku-4-5") -> tuple[str, dict]:
    """
    Returns (description_text, usage_dict).
    usage_dict may include input_tokens/output_tokens if available.
    """
    import anthropic

    prompt = (
        "Describe this photography reference image in detail. "
        "Include: subject pose, body position, camera angle, lighting if visible, "
        "and any technique being demonstrated. Be specific and spatial."
    )
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=model,
        max_tokens=700,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    text = (msg.content[0].text or "").strip()
    usage = {}
    try:
        if getattr(msg, "usage", None):
            usage = {
                "input_tokens": getattr(msg.usage, "input_tokens", None),
                "output_tokens": getattr(msg.usage, "output_tokens", None),
            }
    except Exception:
        usage = {}
    return text, usage


def _read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: str, payload: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Chunk PDF elements into 512/64 token chunks with metadata.")
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument("--source", "-s", required=True, help="Source document title (e.g. 'The Natural Light Portrait Book')")
    parser.add_argument("--author", "-a", required=True, help="Author(s) (e.g. 'Scott Kelby')")
    parser.add_argument("--topic", "-t", default="general", choices=["lighting", "posing", "gear", "color_theory", "client_psychology", "business", "general"],
                        help="Topic category for the document")
    parser.add_argument("--job-id", help="Optional ingest job id for JSONL logging")
    parser.add_argument("--log-path", help="Optional path to JSONL ingest log (append-only)")
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
                "chunk_type": "text",
                "source_document": args.source,
                "author": args.author,
                "chapter": "unknown",
                "topic_category": args.topic,
                "content_type": "narrative",
                "copyright_status": "copyrighted_private",
            },
        })

    # Extract embedded images and create "image chunks" (text=vision-generated description)
    data_root = os.path.dirname(os.path.abspath(args.out_dir))
    images_root = os.path.join(data_root, "images")
    book_images_dir = os.path.join(images_root, source_slug)

    extracted_images = 0
    described_images = 0
    skipped_small = 0
    used_cached = 0
    already_exists = 0

    try:
        import fitz  # pymupdf

        print("Extracting embedded images (PyMuPDF)...")
        doc = fitz.open(args.pdf_path)
        for page_index in range(len(doc)):
            page = doc[page_index]
            # list of tuples; first element is xref
            imgs = page.get_images(full=True) or []
            for img_idx, img in enumerate(imgs):
                xref = img[0]
                page_number = page_index + 1
                filename = f"{page_number}_{img_idx}.png"
                rel_image_path = f"{source_slug}/{filename}"  # relative to DATA_PATH/images/
                out_path = os.path.join(book_images_dir, filename)
                sidecar_path = out_path + ".json"

                if os.path.exists(out_path):
                    already_exists += 1
                    cached = _read_json(sidecar_path)
                    if cached and isinstance(cached.get("description"), str) and cached["description"].strip():
                        used_cached += 1
                        desc_text = cached["description"].strip()
                        chunk_id = f"{source_slug}_image_{page_number:04d}_{img_idx:04d}"
                        chunks_with_meta.append({
                            "chunk_id": chunk_id,
                            "text": desc_text,
                            "metadata": {
                                "chunk_id": chunk_id,
                                "chunk_type": "image",
                                "image_path": rel_image_path,
                                "page_number": page_number,
                                "book_slug": source_slug,
                                "source_document": args.source,
                                "author": args.author,
                                "chapter": "unknown",
                                "topic_category": args.topic,
                                "content_type": "reference_image",
                                "copyright_status": "copyrighted_private",
                            },
                        })
                        append_ingest_log(args.log_path, args.job_id, {
                            "status": "image_cached_used",
                            "image_path": rel_image_path,
                            "page_number": page_number,
                            "book_slug": source_slug,
                        })
                    else:
                        append_ingest_log(args.log_path, args.job_id, {
                            "status": "image_exists",
                            "image_path": rel_image_path,
                            "page_number": page_number,
                            "book_slug": source_slug,
                        })
                    continue

                extracted = doc.extract_image(xref) or {}
                w = int(extracted.get("width") or 0)
                h = int(extracted.get("height") or 0)
                if w and h and (w < 50 or h < 50):
                    skipped_small += 1
                    append_ingest_log(args.log_path, args.job_id, {
                        "status": "vision_skip",
                        "reason": "too_small",
                        "width": w,
                        "height": h,
                        "image_path": rel_image_path,
                        "page_number": page_number,
                        "book_slug": source_slug,
                    })
                    continue

                # Save image as PNG (more reliable for downstream serving)
                os.makedirs(book_images_dir, exist_ok=True)
                try:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.n >= 5:  # CMYK or with alpha
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    pix.save(out_path)
                except Exception:
                    # Fallback: write raw bytes from extract_image (may not be png)
                    raw_bytes = extracted.get("image")
                    if isinstance(raw_bytes, (bytes, bytearray)):
                        with open(out_path, "wb") as f:
                            f.write(raw_bytes)
                    else:
                        continue

                extracted_images += 1

                # Vision describe (one-time ingest cost)
                try:
                    with open(out_path, "rb") as f:
                        img_bytes = f.read()
                    desc_text, usage = describe_image_with_claude(img_bytes, "image/png")
                    if not desc_text:
                        continue
                    described_images += 1
                    _write_json(sidecar_path, {
                        "description": desc_text,
                        "usage": usage,
                        "image_path": rel_image_path,
                        "page_number": page_number,
                        "book_slug": source_slug,
                        "created_at": _utc_iso(),
                        "model": "claude-haiku-4-5",
                    })
                    append_ingest_log(args.log_path, args.job_id, {
                        "status": "vision_call",
                        "image_path": rel_image_path,
                        "page_number": page_number,
                        "book_slug": source_slug,
                        "approx_tokens": usage,
                    })

                    chunk_id = f"{source_slug}_image_{page_number:04d}_{img_idx:04d}"
                    chunks_with_meta.append({
                        "chunk_id": chunk_id,
                        "text": desc_text,
                        "metadata": {
                            "chunk_id": chunk_id,
                            "chunk_type": "image",
                            "image_path": rel_image_path,
                            "page_number": page_number,
                            "book_slug": source_slug,
                            "source_document": args.source,
                            "author": args.author,
                            "chapter": "unknown",
                            "topic_category": args.topic,
                            "content_type": "reference_image",
                            "copyright_status": "copyrighted_private",
                        },
                    })
                except Exception as e:
                    append_ingest_log(args.log_path, args.job_id, {
                        "status": "vision_error",
                        "image_path": rel_image_path,
                        "page_number": page_number,
                        "book_slug": source_slug,
                        "message": str(e),
                    })
                    continue
    except Exception as e:
        append_ingest_log(args.log_path, args.job_id, {
            "status": "image_extract_error",
            "book_slug": source_slug,
            "message": str(e),
        })

    print(f"Created {len(chunks_with_meta)} chunks.")

    if not args.no_write:
        os.makedirs(args.out_dir, exist_ok=True)
        out_path = os.path.join(args.out_dir, f"{source_slug}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(chunks_with_meta, f, indent=2, ensure_ascii=False)
        print(f"Wrote {out_path}")

    if extracted_images or described_images or skipped_small or used_cached or already_exists:
        print(
            "Image summary:",
            f"saved={extracted_images}, described={described_images}, too_small_skipped={skipped_small},",
            f"cached_used={used_cached}, already_exists={already_exists}",
        )

    # Show first chunk as sample
    if chunks_with_meta:
        print("\n--- Sample chunk (first) ---")
        c = chunks_with_meta[0]
        print("metadata:", c["metadata"])
        print("text preview:", (c["text"][:300] + "..." if len(c["text"]) > 300 else c["text"]))


if __name__ == "__main__":
    main()
