#!/usr/bin/env python3
"""
Check if an Algonquin source file was already ingested into Chroma.

We treat "duplicate" as: collection contains at least one chunk whose metadata
matches both:
- original_filename
- file_type
"""

import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Algonquin duplicate ingestion by metadata.")
    parser.add_argument("--db-path", required=True, help="Chroma persistent DB path")
    parser.add_argument("--collection", required=True, help="Chroma collection name")
    parser.add_argument("--original-filename", required=True, help="Original filename (including extension)")
    parser.add_argument("--file-type", required=True, choices=["pdf", "doc", "video", "audio"], help="Algonquin file type")
    args = parser.parse_args()

    try:
        import chromadb
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Missing chromadb dependency: {e}"}))
        return 1

    original_filename = str(args.original_filename).strip()
    file_type = str(args.file_type).strip().lower()

    client_db = chromadb.PersistentClient(path=args.db_path)

    try:
        collection = client_db.get_collection(name=args.collection)
    except Exception:
        print(json.dumps({"ok": True, "duplicate": False, "reason": "collection_not_found"}))
        return 0

    try:
        res = collection.get(
            where={"original_filename": original_filename, "file_type": file_type},
            include=["metadatas", "ids"],
        )
        metadatas = res.get("metadatas") or []
        ids = res.get("ids") or []
        dup = bool(metadatas or ids)
        print(json.dumps({"ok": True, "duplicate": dup, "count": len(ids) if ids is not None else len(metadatas)}))
        return 0
    except Exception as e:
        # If filtering isn't supported or metadata doesn't exist, fail open:
        # treat as "not duplicate" so ingestion still works.
        print(json.dumps({"ok": True, "duplicate": False, "reason": "where_query_failed", "error": str(e)}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

