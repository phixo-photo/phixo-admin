#!/usr/bin/env python3
"""
Delete ChromaDB chunks for a specific book (filtered by source_document).

This is intentionally narrow (single source_document match) so it never wipes other books.
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Delete ChromaDB chunks for a single book source_document.")
    parser.add_argument("--source-document", required=True, help="Exact kb source title (matches chunk metadata source_document).")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB persistence path.")
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name.")
    args = parser.parse_args()

    # Import inside main so the script fails fast with a clear message if deps are missing.
    try:
        import chromadb
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Missing chromadb dependency: {e}"}), file=sys.stderr)
        sys.exit(1)

    source_document = str(args.source_document).strip()
    if not source_document:
        print(json.dumps({"ok": False, "error": "source-document is required"}), file=sys.stderr)
        sys.exit(1)

    client_db = chromadb.PersistentClient(path=args.db_path)
    try:
        collection = client_db.get_collection(name=args.collection)
    except Exception:
        # Nothing to delete; treat as success so the caller can still delete the DB row.
        print(json.dumps({"ok": True, "deleted": 0, "reason": "collection_not_found"}))
        return

    # Delete only rows whose metadata.source_document matches the exact book source title.
    collection.delete(where={"source_document": source_document})
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    main()

