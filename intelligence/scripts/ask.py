#!/usr/bin/env python3
"""
Step 5: Ask a question -> retrieve top chunks -> chat model answers using that context.

You need OPENAI_API_KEY (for embeddings) and a chat API key for LiteLLM/OpenAI-compatible
chat completions.

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
DEFAULT_CHAT_MODEL = os.environ.get(
    "PHIXO_AI_CHAT_MODEL_ALIAS",
    os.environ.get("AI_MODEL", "slack-bot-chat"),
)
IMAGE_RELEVANCE_MODEL = os.environ.get("PHIXO_AI_CHAT_MODEL_ALIAS", "slack-bot-chat")
IMAGE_RELEVANCE_PROMPT = (
    "Would a reader need the actual page picture to understand this excerpt? Answer only yes or no.\n"
    "Answer YES only for: poses, lighting setups, composition examples, gear arrangements, or diagrams "
    "where the image carries the teaching point.\n"
    "Answer NO for: title slides, chapter banners, decorative stock photos, mostly definitions or prose, "
    "software UI steps (sliders, eyedropper, Capture One / Lightroom controls), or color theory explained in text only.\n\n"
    "Text: {chunk_text}"
)

SYSTEM_PROMPT = """You are a portrait photography expert. Answer the question using the reference notes from photography books provided below.

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
5) Write as a practicing photographer giving direct, practical guidance. Do not discuss the notes, excerpts, retrieval, or whether something is missing or not covered. If the context is thin, still give the best grounded answer you can without apologizing or listing gaps.
6) Synthesize across multiple sources when several notes contribute; do not fixate on a single module. Put source titles only in the "sources" array — do not narrate sourcing in answerText.
7) Never put slide titles, module banners, or all-caps course headers (e.g. PHOTO THEORY II) in answerText."""


BUSINESS_SYSTEM_PROMPT = """You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

When answering questions, use the business principles from the excerpts provided and apply them specifically and practically to Ian's portrait photography business. Even if the book does not mention photography directly, translate every principle into concrete actionable advice for his specific context. Never say the book does not cover photography — instead bridge the gap yourself using the principles provided."""

ALL_BOOKS_SYSTEM_PROMPT = """You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

Use the principles and information from the reference notes provided and apply them specifically and practically to Ian's portrait photography business and situation. Never say the notes don't cover Phixo — bridge the gap yourself using the principles provided. Give concrete, actionable answers specific to Phixo. Do not discuss excerpts, retrieval, or coverage gaps in answerText."""

COURSE_PACK_SYSTEM_PROMPT = """You are a senior photography instructor helping Ian apply concepts from his course materials (multiple modules: theory, digital imaging, visual perception, etc.) to real portrait work at his studio Phixo.

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
3) referenceImage must be null and pageImages must be an empty array (the system attaches real page images after retrieval).
4) Answer the question directly as practical guidance. Synthesize ideas across the labeled sections when more than one is relevant — do not rely on a single module if others apply.
5) Never say "the excerpts", "the materials", "the notes provided", "does not cover", "is not addressed", or similar. Do not apologize for limitations.
6) Put human-readable source labels (section titles / filenames as given in the labels) only in the "sources" array — not as meta-commentary in answerText.
7) Never output slide titles, module banners, or all-caps course headers (e.g. PHOTO THEORY II) in answerText — those are not part of the answer."""


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def strip_slide_title_lines(text: str) -> str:
    """Remove standalone all-caps / banner lines the model sometimes copies from deck slides."""
    if not text or not str(text).strip():
        return text
    line_pat = re.compile(r"^[A-Z][A-Z0-9 \.\-\–\—\'’,&/]{2,100}$")
    out_lines = []
    for line in str(text).split("\n"):
        s = line.strip()
        if not s:
            out_lines.append(line)
            continue
        if line_pat.match(s) and len(s.split()) <= 10:
            continue
        out_lines.append(line)
    return "\n".join(out_lines).strip()


def diversify_by_book_slug(docs, metadatas, distances, target_n: int, max_per_slug: int):
    """Prefer top semantic hits while capping how many chunks come from one book_slug (per uploaded file)."""
    n = len(docs)
    if n == 0:
        return [], [], []
    dist_list = list(distances or [])
    if len(dist_list) < n:
        dist_list = dist_list + [float("inf")] * (n - len(dist_list))
    indexed = list(range(n))
    indexed.sort(key=lambda i: dist_list[i] if dist_list[i] is not None else float("inf"))
    picked = []
    picked_set = set()
    counts = {}
    for i in indexed:
        if len(picked) >= target_n:
            break
        meta = metadatas[i]
        bslug = str((meta or {}).get("book_slug") or (meta or {}).get("source_document") or "_default")
        if counts.get(bslug, 0) >= max_per_slug:
            continue
        counts[bslug] = counts.get(bslug, 0) + 1
        picked.append(i)
        picked_set.add(i)
    for i in indexed:
        if len(picked) >= target_n:
            break
        if i in picked_set:
            continue
        picked.append(i)
        picked_set.add(i)
    return (
        [docs[i] for i in picked],
        [metadatas[i] for i in picked],
        [dist_list[i] for i in picked],
    )


def should_include_image_for_chunk(client, chunk_text: str) -> bool:
    text = str(chunk_text or "").strip()
    if not text:
        return False
    response = client.chat.completions.create(
        model=IMAGE_RELEVANCE_MODEL,
        max_tokens=8,
        temperature=0,
        messages=[{
            "role": "user",
            "content": IMAGE_RELEVANCE_PROMPT.format(chunk_text=text),
        }],
    )
    reply = ""
    try:
        reply = (response.choices[0].message.content or "").strip().lower()
    except Exception:
        reply = ""
    return reply.startswith("yes")


def main():
    parser = argparse.ArgumentParser(
        description="Ask a question and get an answer from the knowledge base via LiteLLM/OpenAI-compatible chat."
    )
    parser.add_argument("query", nargs="*", help="Your question (as one quoted string)")
    parser.add_argument("--top", "-n", type=int, default=5, help="Number of chunks to pass to Claude (default: 5)")
    parser.add_argument("--collection", "-c", default="phixo_kb", help="ChromaDB collection name")
    parser.add_argument("--db-path", default="data/chromadb", help="ChromaDB path")
    parser.add_argument(
        "--model",
        "-m",
        default=DEFAULT_CHAT_MODEL,
        help=f"Chat model alias (default: {DEFAULT_CHAT_MODEL})",
    )
    parser.add_argument("--source", default="", help="Optional source_document filter (exact title)")
    parser.add_argument("--topic", default="general", help="Optional book topic tag (e.g. Business)")
    parser.add_argument(
        "--topic-focus",
        default="",
        help="Optional topic focus for all-books mode: photography | business | all",
    )
    parser.add_argument(
        "--diversify-by-book-slug",
        action="store_true",
        help="Retrieve extra chunks then cap per book_slug so multi-file packs (e.g. Algonquin) mix sources.",
    )
    args = parser.parse_args()

    query = " ".join(args.query).strip()
    if not query:
        print('Usage: python scripts/ask.py "Your question here"', file=sys.stderr)
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("Set OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(1)
    chat_api_key = (
        os.environ.get("PHIXO_AI_CHAT_API_KEY")
        or os.environ.get("SLACK_CHATBOT_API_KEY")
        or os.environ.get("LITELLM_MASTER_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if not chat_api_key:
        print(
            "Set PHIXO_AI_CHAT_API_KEY (or SLACK_CHATBOT_API_KEY / LITELLM_MASTER_KEY / OPENAI_API_KEY).",
            file=sys.stderr,
        )
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
    ALGONQUIN_TOPIC_CATEGORY = "algonquin-college"

    def is_photography_topic_category(cat: str) -> bool:
        c = str(cat or "").strip().lower()
        return c in PHOTOGRAPHY_TOPIC_CATEGORIES or c == ALGONQUIN_TOPIC_CATEGORY

    all_books_mode = topic_focus in ("photography", "business", "all")
    if all_books_mode:
        # All-books mode must always use the Phixo-specific prompt,
        # even when chunk retrieval is limited to "Photography".
        system_prompt = ALL_BOOKS_SYSTEM_PROMPT
    elif topic_tag == "business":
        system_prompt = BUSINESS_SYSTEM_PROMPT
    elif topic_tag == ALGONQUIN_TOPIC_CATEGORY:
        system_prompt = COURSE_PACK_SYSTEM_PROMPT
    else:
        system_prompt = SYSTEM_PROMPT

    from openai import OpenAI
    import chromadb

    print("Retrieving relevant chunks...")
    client_openai = OpenAI()
    resp = client_openai.embeddings.create(input=[query], model=EMBED_MODEL)
    query_embedding = resp.data[0].embedding

    client_db = chromadb.PersistentClient(path=args.db_path)
    collection = client_db.get_collection(name=args.collection)
    source_filter = (args.source or "").strip()
    retrieve_n = args.top
    if getattr(args, "diversify_by_book_slug", False) and source_filter:
        retrieve_n = min(120, max(args.top * 10, 50))

    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": retrieve_n,
        "include": ["documents", "metadatas", "distances"],
    }

    topic_filter_where = None
    if topic_focus == "photography":
        # Include Algonquin course-pack chunks (topic_category algonquin-college) in Photography scope.
        photo_cats = list(PHOTOGRAPHY_TOPIC_CATEGORIES) + [ALGONQUIN_TOPIC_CATEGORY]
        topic_filter_where = {"$or": [{"topic_category": c} for c in photo_cats]}
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
    if getattr(args, "diversify_by_book_slug", False) and source_filter:
        docs, metadatas, distances = diversify_by_book_slug(
            docs, metadatas, distances, args.top, max_per_slug=3
        )
    else:
        docs = docs[: args.top]
        metadatas = metadatas[: args.top]
        distances = distances[: args.top] if distances else []
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
        sd = (meta or {}).get("source_document", "Unknown")
        sub = (meta or {}).get("sub_source")
        title = f"{sub} — {sd}" if sub and str(sub).strip() else str(sd)
        context_parts.append(f"[Excerpt {excerpt_index} — {title}]\n{doc}")
        excerpt_index += 1
    context = "\n\n---\n\n".join(context_parts)

    user_content = f"""Here are reference notes:

{context}

---

Question: {query}

Answer directly and practically. Do not use phrases like "the excerpts", "the materials provided", "the notes state", "does not cover", "is not addressed", or similar commentary about the notes."""

    print(f"Asking chat model via LiteLLM ({args.model})...")
    chat_base_url = (
        os.environ.get("PHIXO_AI_OPENAI_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or "http://127.0.0.1:4000/v1"
    )
    client = OpenAI(api_key=chat_api_key, base_url=chat_base_url)
    req_payload = {
        "model": args.model,
        "max_tokens": 1024,
        "base_url": chat_base_url,
        "system": "[present]",
        "messages": [{"role": "user", "content_preview": user_content[:1200]}],
    }
    print("[AI REQUEST ask.py]", json.dumps(req_payload, ensure_ascii=False), file=sys.stderr)
    response = client.chat.completions.create(
        model=args.model,
        max_tokens=1024,
        temperature=0.8,
        response_format={"type": "json_object"},
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )
    text_out = ""
    try:
        text_out = response.choices[0].message.content or ""
    except Exception:
        text_out = ""
    resp_summary = {
        "id": getattr(response, "id", None),
        "model": getattr(response, "model", args.model),
        "usage": dict(getattr(response, "usage", {}) or {}),
        "text_preview": str(text_out)[:800],
    }
    print("[AI RESPONSE ask.py]", json.dumps(resp_summary, ensure_ascii=False), file=sys.stderr)
    raw = str(text_out)

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
    at_raw = payload.get("answerText")
    if isinstance(at_raw, str) and at_raw.strip():
        payload["answerText"] = strip_slide_title_lines(at_raw)
    # Expose the original retrieved text chunks so the frontend can request a
    # deeper follow-up without re-running retrieval/relevance filtering.
    payload["retrievedChunks"] = page_matches

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
                    is_photography = is_photography_topic_category(topic_category)
                    if not is_photography:
                        continue
                    pn = pm.get("page_number")
                    if pn is not None and int(pn) <= 1:
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
                futures_by_idx = {}
                for idx, pm in enumerate(page_matches):
                    # Only chunks with a page_number can map to a physical page image.
                    if (pm.get("page_number") is None):
                        continue
                    pn = pm.get("page_number")
                    if pn is not None and int(pn) <= 1:
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

    for pm, is_relevant in zip(page_matches, relevance_flags):
        if not is_relevant:
            continue
        page_number = pm.get("page_number")
        source_document = str(pm.get("source_document") or "")
        if page_number is None or not source_document:
            continue
        if int(page_number) <= 1:
            continue
        # Use per-chunk book_slug when available so multiple uploads under the same
        # source_document (e.g. Algonquin persistent KB) never collide on images.
        book_slug = pm.get("book_slug")
        book_slug = str(book_slug).strip() if book_slug else slug(source_document)
        page_key = f"{source_document}:{book_slug}:{int(page_number)}"
        if page_key in seen_pages:
            continue
        seen_pages.add(page_key)
        pattern = os.path.join(images_root, book_slug, f"page{int(page_number):04d}_*.jpg")
        paths = glob.glob(pattern)
        if not paths:
            continue

        def _fsize(p: str) -> int:
            try:
                return os.path.getsize(p)
            except OSError:
                return 10**12

        ranked = sorted(paths, key=_fsize)
        min_useful = 12 * 1024
        chosen = next((p for p in ranked if _fsize(p) >= min_useful), ranked[0])
        img_rel = os.path.relpath(chosen, images_root).replace("\\", "/")
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
