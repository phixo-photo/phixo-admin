#!/usr/bin/env python3
"""Delete all Chroma chunks for one Algonquin upload (book_slug) and remove its image folder."""

import argparse
import json
import os
import shutil
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Delete one Algonquin document by book_slug.")
    parser.add_argument("--book-slug", required=True, help="Chunk metadata book_slug for that upload.")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB persistence path.")
    parser.add_argument("--collection", "-c", default="algonquin-college", help="ChromaDB collection name.")
    args = parser.parse_args()

    try:
        import chromadb
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 1

    book_slug = str(args.book_slug).strip()
    if not book_slug:
        print(json.dumps({"ok": False, "error": "book-slug required"}), file=sys.stderr)
        return 1

    client_db = chromadb.PersistentClient(path=args.db_path)
    try:
        collection = client_db.get_collection(name=args.collection)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"collection: {e}"}), file=sys.stderr)
        return 1

    try:
        existing = collection.get(where={"book_slug": book_slug}, include=[], limit=500000)
        n = len(existing.get("ids") or [])
    except Exception:
        n = 0

    if n == 0:
        print(json.dumps({"ok": True, "deletedChunks": 0, "imagesRemoved": False, "reason": "not_found"}))
        return 0

    collection.delete(where={"book_slug": book_slug})

    data_root = os.path.dirname(os.path.abspath(args.db_path))
    images_dir = os.path.join(data_root, "images", book_slug)
    removed = False
    if os.path.isdir(images_dir):
        try:
            shutil.rmtree(images_dir)
            removed = True
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"chunks deleted but images: {e}"}), file=sys.stderr)
            return 1

    print(json.dumps({"ok": True, "deletedChunks": n, "imagesRemoved": removed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
