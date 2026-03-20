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
import glob
import os
import sys
import json
import re
from concurrent.futures import ThreadPoolExecutor

EMBED_MODEL = "text-embedding-3-small"
# Use current Haiku (Claude 4.5 Haiku); see https://docs.anthropic.com/en/docs/about-claude/model-deprecations
DEFAULT_CLAUDE_MODEL = os.environ.get("AI_MODEL", "claude-haiku-4-5-20251001")
IMAGE_RELEVANCE_MODEL = "claude-haiku-4-5-20251001"
IMAGE_RELEVANCE_PROMPT = (
    "Does this text excerpt describe a specific physical body position, pose, lighting setup, "
    "or visual technique that would be visible in a photograph? Answer only yes or no.\n\n"
    "Text: {chunk_text}"
)

SYSTEM_PROMPT = """You are a portrait photography expert. Answer the question using only the excerpts from photography books provided below.

Return ONLY valid JSON with this schema (no markdown, no extra text):
{
  "answerText": string,
  "referenceImage": null,
  "pageImages": array of objects,
  "sources": array of strings
}

Rules:
1) Do not use markdown. answerText must be plain text with short paragraphs.
2) Use clean flowing paragraphs, never bullets or numbered lists.
3) Never include diagrams, SVG instructions, or generated visuals.
4) referenceImage must be null and pageImages must be an empty array (the system attaches real page images after retrieval).
5) If the excerpts do not cover what's asked, say so in answerText.
6) When you use a specific idea from the text, it must be supported by the excerpts and you should list the book title in sources."""


BUSINESS_SYSTEM_PROMPT = """You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

When answering questions, use the business principles from the excerpts provided and apply them specifically and practically to Ian's portrait photography business. Even if the book does not mention photography directly, translate every principle into concrete actionable advice for his specific context. Never say the book does not cover photography — instead bridge the gap yourself using the principles provided."""

ALL_BOOKS_SYSTEM_PROMPT = """You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

Use the principles and information from the excerpts provided and apply them specifically and practically to Ian's portrait photography business and situation. Never say the excerpts don't cover Phixo — bridge the gap yourself using the principles provided. Give concrete, actionable answers specific to Phixo."""


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def should_include_image_for_chunk(client, chunk_text: str) -> bool:
    text = str(chunk_text or "").strip()
    if not text:
        return False
    message = client.messages.create(
        model=IMAGE_RELEVANCE_MODEL,
        max_tokens=5,
        messages=[{
            "role": "user",
            "content": IMAGE_RELEVANCE_PROMPT.format(chunk_text=text),
        }],
    )
    reply = (message.content[0].text if getattr(message, "content", None) else "").strip().lower()
    return reply.startswith("yes")


def main():
    parser = argparse.ArgumentParser(description="Ask a question and get an answer from the knowledge base via Claude.")
    parser.add_argument("query", nargs="*", help="Your question (as one quoted string)")
    parser.add_argument("--top", "-n", type=int, default=5, help="Number of chunks to pass to Claude (default: 5)")
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB path")
    parser.add_argument("--model", "-m", default=DEFAULT_CLAUDE_MODEL, help=f"Claude model (default: {DEFAULT_CLAUDE_MODEL})")
    parser.add_argument("--source", default="", help="Optional source_document filter (exact title)")
    parser.add_argument("--topic", default="general", help="Optional book topic tag (e.g. Business)")
    parser.add_argument(
        "--topic-focus",
        default="",
        help="Optional topic focus for all-books mode: photography | business | all",
    )
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

    topic_tag = str(getattr(args, "topic", "general") or "general").strip().lower()
    topic_focus = str(getattr(args, "topic_focus", "") or "").strip().lower()

    PHOTOGRAPHY_TOPIC_CATEGORIES = [
        "posing",
        "lighting",
        "gear",
        "color_theory",
        "client_psychology",
        "general",
    ]

    all_books_mode = topic_focus in ("photography", "business", "all")
    if all_books_mode:
        # All-books mode must always use the Phixo-specific prompt,
        # even when chunk retrieval is limited to "Photography".
        system_prompt = ALL_BOOKS_SYSTEM_PROMPT
    else:
        # Back-compat: per-book mode uses `--topic` only.
        system_prompt = BUSINESS_SYSTEM_PROMPT if topic_tag == "business" else SYSTEM_PROMPT

    from openai import OpenAI
    import chromadb

    print("Retrieving relevant chunks...")
    client_openai = OpenAI()
    resp = client_openai.embeddings.create(input=[query], model=EMBED_MODEL)
    query_embedding = resp.data[0].embedding

    client_db = chromadb.PersistentClient(path=args.db_path)
    collection = client_db.get_collection(name=args.collection)
    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": args.top,
        "include": ["documents", "metadatas", "distances"],
    }
    source_filter = (args.source or "").strip()

    topic_filter_where = None
    if topic_focus == "photography":
        # Use $or/$eq-style matching for maximum Chroma where-filter compatibility.
        topic_filter_where = {"$or": [{"topic_category": c} for c in PHOTOGRAPHY_TOPIC_CATEGORIES]}
    elif topic_focus == "business":
        topic_filter_where = {"topic_category": "business"}

    if source_filter and topic_filter_where:
        query_kwargs["where"] = {"$and": [{"source_document": source_filter}, topic_filter_where]}
    elif source_filter:
        query_kwargs["where"] = {"source_document": source_filter}
    elif topic_filter_where:
        query_kwargs["where"] = topic_filter_where
    results = collection.query(**query_kwargs)

    docs = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results.get("distances", [[]])[0] or []
    sources = list({m.get("source_document", "?") for m in metadatas})
    if source_filter and not docs:
        print(f"No chunks found for selected book: {source_filter}", file=sys.stderr)
        sys.exit(1)

    context_parts = []
    page_matches = []
    excerpt_index = 1
    for doc, meta, dist in zip(docs, metadatas, distances):
        ctype = (meta or {}).get("chunk_type", "text")
        if ctype == "image":
            continue
        page_matches.append({
            "page_number": (meta or {}).get("page_number"),
            "book_slug": (meta or {}).get("book_slug"),
            "source_document": (meta or {}).get("source_document"),
            "topic_category": (meta or {}).get("topic_category"),
            "doc_text": doc,
        })
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
    req_payload = {
        "model": args.model,
        "max_tokens": 1024,
        "system": "[present]",
        "messages": [{"role": "user", "content_preview": user_content[:1200]}],
    }
    print("[AI REQUEST ask.py]", json.dumps(req_payload, ensure_ascii=False), file=sys.stderr)
    message = client.messages.create(
        model=args.model,
        max_tokens=1024,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )
    resp_summary = {
        "id": getattr(message, "id", None),
        "model": getattr(message, "model", args.model),
        "usage": {
            "input_tokens": getattr(getattr(message, "usage", None), "input_tokens", None),
            "output_tokens": getattr(getattr(message, "usage", None), "output_tokens", None),
        },
        "text_preview": (message.content[0].text if message.content else "")[:800],
    }
    print("[AI RESPONSE ask.py]", json.dumps(resp_summary, ensure_ascii=False), file=sys.stderr)

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
            "pageImages": [],
            "sources": sources,
        }

    if "sources" not in payload or not isinstance(payload.get("sources"), list):
        payload["sources"] = sources

    # Normalize expected response fields.
    if "referenceImage" not in payload:
        payload["referenceImage"] = None
    if "pageImages" not in payload or not isinstance(payload.get("pageImages"), list):
        payload["pageImages"] = []

    # Rule 1 — Topic focus filter:
    # If we're in All Books mode with Business focus, return text only.
    if all_books_mode and topic_focus == "business":
        payload["referenceImage"] = None
        payload["pageImages"] = []
        print(json.dumps(payload, ensure_ascii=False))
        return

    # Filter page images to only chunks that are visually relevant.
    page_images = []
    seen_pages = set()
    data_root = os.path.dirname(os.path.abspath(args.db_path))
    images_root = os.path.join(data_root, "images")
    relevance_flags = [False] * len(page_matches)
    if page_matches:
        # Rule 2 — Mixed results filter:
        # In All Books mode, only run the image relevance filter for chunks from
        # Photography topic books. Never attach images from Business topic books.
        if all_books_mode:
            with ThreadPoolExecutor(max_workers=min(8, len(page_matches))) as executor:
                futures_by_idx = {}
                for idx, pm in enumerate(page_matches):
                    topic_category = str(pm.get("topic_category") or "").strip().lower()
                    is_photography = topic_category in PHOTOGRAPHY_TOPIC_CATEGORIES
                    if not is_photography:
                        continue
                    futures_by_idx[idx] = executor.submit(
                        should_include_image_for_chunk,
                        client,
                        pm.get("doc_text", ""),
                    )
                for idx, future in futures_by_idx.items():
                    try:
                        relevance_flags[idx] = bool(future.result())
                    except Exception:
                        relevance_flags[idx] = False
        else:
            with ThreadPoolExecutor(max_workers=min(8, len(page_matches))) as executor:
                futures = [
                    executor.submit(should_include_image_for_chunk, client, pm.get("doc_text", ""))
                    for pm in page_matches
                ]
                for idx, future in enumerate(futures):
                    try:
                        relevance_flags[idx] = bool(future.result())
                    except Exception:
                        relevance_flags[idx] = False

    for pm, is_relevant in zip(page_matches, relevance_flags):
        if not is_relevant:
            continue
        page_number = pm.get("page_number")
        source_document = str(pm.get("source_document") or "")
        if page_number is None or not source_document:
            continue
        page_key = f"{source_document}:{int(page_number)}"
        if page_key in seen_pages:
            continue
        seen_pages.add(page_key)
        book_slug = slug(source_document)
        pattern = os.path.join(images_root, book_slug, f"page{int(page_number):04d}_*.jpg")
        image_candidates = sorted(glob.glob(pattern))
        if not image_candidates:
            continue
        img_rel = os.path.relpath(image_candidates[0], images_root).replace("\\", "/")
        page_images.append({
            "path": img_rel,
            "description": None,
            "page": int(page_number),
            "book": book_slug,
        })

    payload["referenceImage"] = page_images[0] if page_images else None
    payload["pageImages"] = page_images

    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
