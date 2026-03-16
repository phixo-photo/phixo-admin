#!/usr/bin/env python3
"""
Step 5: Ask a question → retrieve top chunks → Claude answers using that context.

You need OPENAI_API_KEY (for embeddings) and ANTHROPIC_API_KEY (for Claude).
Get an Anthropic key at console.anthropic.com

Usage:
  python scripts/ask.py "How do I use window light for a portrait?"
  python scripts/ask.py "best lens for headshots" --top 5
"""

import argparse
import os
import sys

EMBED_MODEL = "text-embedding-3-small"
# Use current Haiku (Claude 4.5 Haiku); see https://docs.anthropic.com/en/docs/about-claude/model-deprecations
DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"

SYSTEM_PROMPT = """You are a portrait photography expert. Answer the question using only the excerpts from photography books provided below. Explain the reasoning and the "why" where the text supports it. If the excerpts don't cover what's asked, say so. When you use a specific idea from the text, mention the source (book title) in passing. Keep the answer clear and practical."""


def main():
    parser = argparse.ArgumentParser(description="Ask a question and get an answer from the knowledge base via Claude.")
    parser.add_argument("query", nargs="*", help="Your question (as one quoted string)")
    parser.add_argument("--top", "-n", type=int, default=5, help="Number of chunks to pass to Claude (default: 5)")
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB path")
    parser.add_argument("--model", "-m", default=DEFAULT_CLAUDE_MODEL, help=f"Claude model (default: {DEFAULT_CLAUDE_MODEL})")
    args = parser.parse_args()

    query = " ".join(args.query).strip()
    if not query:
        print('Usage: python scripts/ask.py "Your question here"', file=sys.stderr)
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("Set OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(1)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY (get one at console.anthropic.com).", file=sys.stderr)
        sys.exit(1)

    if not os.path.isdir(args.db_path):
        print(f"ChromaDB not found at {args.db_path}. Run embed_and_store.py first.", file=sys.stderr)
        sys.exit(1)

    from openai import OpenAI
    import chromadb

    print("Retrieving relevant chunks...")
    client_openai = OpenAI()
    resp = client_openai.embeddings.create(input=[query], model=EMBED_MODEL)
    query_embedding = resp.data[0].embedding

    client_db = chromadb.PersistentClient(path=args.db_path)
    collection = client_db.get_collection(name=args.collection)
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=args.top,
        include=["documents", "metadatas"],
    )

    docs = results["documents"][0]
    metadatas = results["metadatas"][0]
    sources = list({m.get("source_document", "?") for m in metadatas})

    context_parts = []
    for i, (doc, meta) in enumerate(zip(docs, metadatas), 1):
        title = meta.get("source_document", "Unknown")
        context_parts.append(f"[Excerpt {i} — {title}]\n{doc}")
    context = "\n\n---\n\n".join(context_parts)

    user_content = f"""Here are excerpts from photography books:

{context}

---

Question: {query}

Answer based on the excerpts above. If something isn't covered, say so briefly."""

    print(f"Asking Claude ({args.model})...")
    import anthropic

    client = anthropic.Anthropic()
    message = client.messages.create(
        model=args.model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )

    answer = message.content[0].text
    print()
    print("=" * 60)
    print("Answer")
    print("=" * 60)
    print(answer)
    print()
    print("Sources:", ", ".join(sources))
    print()


if __name__ == "__main__":
    main()
