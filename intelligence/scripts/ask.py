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
import json

EMBED_MODEL = "text-embedding-3-small"
# Use current Haiku (Claude 4.5 Haiku); see https://docs.anthropic.com/en/docs/about-claude/model-deprecations
DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5"

SYSTEM_PROMPT = """You are a portrait photography expert. Answer the question using only the excerpts from photography books provided below.

Return ONLY valid JSON with this schema (no markdown, no extra text):
{
  "answerText": string,
  "referenceImage": null,
  "poseDiagram": null | {
    "cameraFacing": "top",
    "poseShape": "V" | "C" | "Triangles" | "Unknown",
    "weightShift": "left_leg" | "right_leg" | "unknown",
    "torsoAngle": "toward_camera" | "away_from_camera" | "slight" | "unknown",
    "hipAngle": "toward_camera" | "away_from_camera" | "slight" | "unknown",
    "frontFootDirection": "toward_camera" | "away_from_camera" | "side" | "unknown",
    "backFootDirection": "toward_camera" | "away_from_camera" | "side" | "unknown"
  },
  "lightingDiagram": null | {
    "cameraFacing": "top",
    "lightTypes": array of strings,
    "positions": array of strings,
    "angles": array of strings,
    "modifiers": array of strings
  },
  "sources": array of strings
}

Rules:
1) Do not use markdown. answerText must be plain text with short paragraphs.
2) If posing is relevant, fill poseDiagram. Otherwise poseDiagram must be null.
3) If lighting is relevant, fill lightingDiagram. Otherwise lightingDiagram must be null.
4) referenceImage must be null (the system will attach an image if one is retrieved).
5) If the excerpts do not cover what's asked, say so in answerText.
6) When you use a specific idea from the text, it must be supported by the excerpts and you should list the book title in sources."""


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
        include=["documents", "metadatas", "distances"],
    )

    docs = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results.get("distances", [[]])[0] or []
    sources = list({m.get("source_document", "?") for m in metadatas})

    context_parts = []
    image_candidates = []
    excerpt_index = 1
    for doc, meta, dist in zip(docs, metadatas, distances):
        ctype = (meta or {}).get("chunk_type", "text")
        if ctype == "image":
            image_candidates.append((dist, doc, meta))
            continue
        title = (meta or {}).get("source_document", "Unknown")
        context_parts.append(f"[Excerpt {excerpt_index} — {title}]\n{doc}")
        excerpt_index += 1
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

    raw = message.content[0].text

    # Be defensive: even with "JSON only" prompts, models sometimes wrap or prefix text.
    # Try strict JSON first, then extract the first {...} block.
    payload = None
    try:
        payload = json.loads(raw)
    except Exception:
        first_brace = raw.find('{')
        last_brace = raw.rfind('}')
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            try:
                payload = json.loads(raw[first_brace:last_brace + 1])
            except Exception:
                payload = None

    if not payload or not isinstance(payload, dict):
        payload = {
            "answerText": raw,
            "referenceImage": None,
            "poseDiagram": None,
            "lightingDiagram": None,
            "sources": sources,
        }

    if "sources" not in payload or not isinstance(payload.get("sources"), list):
        payload["sources"] = sources

    # Normalize diagram fields: missing keys -> null.
    if "referenceImage" not in payload:
        payload["referenceImage"] = None
    if "poseDiagram" not in payload:
        payload["poseDiagram"] = None
    if "lightingDiagram" not in payload:
        payload["lightingDiagram"] = None

    # Attach best reference image (if retrieved). Chroma distances: lower is more similar.
    ref = None
    if image_candidates:
        image_candidates.sort(key=lambda t: (t[0] is None, t[0]))
        best_dist, best_doc, best_meta = image_candidates[0]
        if isinstance(best_meta, dict):
            img_path = best_meta.get("image_path")
            page = best_meta.get("page_number")
            book = best_meta.get("book_slug")
            if img_path:
                ref = {
                    "path": img_path,
                    "description": best_doc,
                    "page": page,
                    "book": book,
                }
    payload["referenceImage"] = ref

    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
