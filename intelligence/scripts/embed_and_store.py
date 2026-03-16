#!/usr/bin/env python3
"""
Step 3: Load chunk JSON → embed with OpenAI → store in ChromaDB.

You need OPENAI_API_KEY set (e.g. in .env or export in terminal).
ChromaDB is stored under data/chromadb so it persists between runs.

Usage:
  python scripts/embed_and_store.py data/chunks/the-natural-light-portrait-book.json
  python scripts/embed_and_store.py data/chunks/   # all .json files in directory
  python scripts/embed_and_store.py data/chunks/ --replace   # wipe collection, load all
"""

import argparse
import glob
import json
import os
import sys

# Batch size for OpenAI (avoid rate limits)
EMBED_BATCH_SIZE = 50
EMBED_MODEL = "text-embedding-3-small"


def embed_and_upsert(chunks, collection, client_openai):
    if not chunks:
        return
    ids = [c["chunk_id"] for c in chunks]
    documents = [c["text"] for c in chunks]
    metadatas = [c["metadata"] for c in chunks]

    all_embeddings = []
    for i in range(0, len(documents), EMBED_BATCH_SIZE):
        batch = documents[i : i + EMBED_BATCH_SIZE]
        resp = client_openai.embeddings.create(input=batch, model=EMBED_MODEL)
        all_embeddings.extend([d.embedding for d in resp.data])
        print(f"  Embedded {min(i + EMBED_BATCH_SIZE, len(documents))}/{len(documents)}")
    meta_clean = [{k: v for k, v in m.items() if isinstance(v, (str, int, float, bool))} for m in metadatas]
    collection.upsert(ids=ids, embeddings=all_embeddings, documents=documents, metadatas=meta_clean)


def main():
    parser = argparse.ArgumentParser(description="Embed chunks with OpenAI and store in ChromaDB.")
    parser.add_argument(
        "chunk_path",
        nargs="?",
        default="data/chunks/the-natural-light-portrait-book.json",
        help="Path to a chunk JSON file, or a directory of .json files",
    )
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name (default: phixo_kb)")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB persistence path (default: data/chromadb)")
    parser.add_argument("--replace", action="store_true", help="Replace existing collection (default: add/update by chunk_id)")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Set OPENAI_API_KEY (e.g. export OPENAI_API_KEY=sk-... or use a .env file).", file=sys.stderr)
        sys.exit(1)

    if os.path.isfile(args.chunk_path):
        paths = [args.chunk_path]
    elif os.path.isdir(args.chunk_path):
        paths = sorted(glob.glob(os.path.join(args.chunk_path, "*.json")))
        if not paths:
            print(f"No .json files in {args.chunk_path}", file=sys.stderr)
            sys.exit(1)
        print(f"Found {len(paths)} chunk file(s) in {args.chunk_path}")
    else:
        print(f"Not a file or directory: {args.chunk_path}", file=sys.stderr)
        sys.exit(1)

    import chromadb
    from openai import OpenAI

    client_db = chromadb.PersistentClient(path=args.db_path)
    if args.replace:
        try:
            client_db.delete_collection(args.collection)
        except Exception:
            pass
    collection = client_db.get_or_create_collection(
        name=args.collection,
        metadata={"description": "Phixo knowledge base chunks"},
    )

    client_openai = OpenAI()
    for path in paths:
        with open(path, encoding="utf-8") as f:
            chunks = json.load(f)
        if not chunks:
            continue
        print(f"Embedding {len(chunks)} chunks from {os.path.basename(path)}...")
        embed_and_upsert(chunks, collection, client_openai)
        print(f"  Stored {len(chunks)} chunks.")

    print(f"Done. {collection.count()} chunks in collection '{args.collection}'.")


if __name__ == "__main__":
    main()
