#!/usr/bin/env python3
"""List distinct ingested Algonquin documents (by book_slug) from Chroma metadata."""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="List Algonquin KB documents by book_slug.")
    parser.add_argument("--source-document", required=True, help="Chunk metadata source_document (exact).")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB persistence path.")
    parser.add_argument("--collection", "-c", default="algonquin-college", help="ChromaDB collection name.")
    parser.add_argument("--limit", type=int, default=50000, help="Max chunks to scan (metadata only).")
    args = parser.parse_args()

    try:
        import chromadb
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "documents": []}), file=sys.stderr)
        return 1

    source_document = str(args.source_document).strip()
    if not source_document:
        print(json.dumps({"ok": False, "error": "source-document required", "documents": []}), file=sys.stderr)
        return 1

    client_db = chromadb.PersistentClient(path=args.db_path)
    try:
        collection = client_db.get_collection(name=args.collection)
    except Exception as e:
        print(json.dumps({"ok": True, "documents": [], "reason": str(e)}))
        return 0

    data = collection.get(
        where={"source_document": source_document},
        include=["metadatas"],
        limit=int(args.limit),
    )
    metas = data.get("metadatas") or []
    by_slug = {}
    for m in metas:
        if not m:
            continue
        slug = m.get("book_slug")
        if not slug:
            continue
        slug_s = str(slug).strip()
        if slug_s not in by_slug:
            by_slug[slug_s] = {
                "bookSlug": slug_s,
                "subSource": str(m.get("sub_source") or "").strip(),
                "originalFilename": str(m.get("original_filename") or "").strip(),
            }

    docs = sorted(by_slug.values(), key=lambda x: (x.get("subSource") or "").lower())
    print(json.dumps({"ok": True, "documents": docs}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
