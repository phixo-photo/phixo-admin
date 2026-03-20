#!/usr/bin/env python3
"""
Generate suggested questions from sampled Chroma chunks.

Rules:
- Always uses claude-haiku-4-5-20251001
- Always samples up to 10 chunks (never more)
- Returns JSON array of 8 question strings on stdout
"""

import argparse
import json
import os
import random
import re
import sys

MODEL = "claude-haiku-4-5-20251001"
SAMPLE_SIZE = 10
QUESTION_COUNT = 8

TOPIC_LABELS = {
    "posing": "Posing",
    "lighting": "Lighting",
    "gear": "Gear",
    "color_theory": "Color theory",
    "client_psychology": "Client psychology",
    "business": "Business",
    "general": "General",
}

PHOTOGRAPHY_TOPIC_CATEGORIES = [
    "posing",
    "lighting",
    "gear",
    "color_theory",
    "client_psychology",
    "general",
]

ALL_BOOKS_FOCUS_LABELS = {
    "photography": "Photography",
    "business": "Business",
    "all": "All",
}


def extract_json_array(raw: str):
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(raw[start : end + 1])
            if isinstance(parsed, list):
                return parsed
        except Exception:
            return None
    return None


def normalize_questions(items):
    out = []
    for item in items or []:
        q = str(item or "").strip()
        if not q:
            continue
        if len(q) > 400:
            q = q[:400].rstrip()
        out.append(q)
    seen = set()
    deduped = []
    for q in out:
        key = re.sub(r"\s+", " ", q).strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(q)
    return deduped[:QUESTION_COUNT]


def build_prompt(excerpts: list[str], topic_label: str, sub_topic: str | None):
    joined = "\n\n---\n\n".join(excerpts)
    prompt = f"""You are helping a portrait photographer learn from this book.
Based on these excerpts, generate 8 questions this photographer would genuinely want to ask.
Use the topic tag to guide the style of questions:
- Posing: practical technique questions (e.g. 'How do I pose hands for a nervous client?')
- Lighting: setup and quality of light questions (e.g. 'What is the difference between broad and short lighting?')
- Gear: equipment and settings questions
- Color theory: editing and color grading questions
- Client psychology: questions about managing client anxiety and behavior
- Business: strategy, pricing, and marketing questions (e.g. 'How do I handle a client who objects to my pricing?')
- General: broad photography questions

Topic tag for this book: {topic_label}
"""
    if sub_topic:
        prompt += f"""
Focus specifically on this sub-topic: {sub_topic}
Only generate questions relevant to this sub-topic.
"""
    prompt += f"""
Return ONLY a JSON array of 8 question strings. No preamble, no markdown, no explanation.
Example format: ["Question 1?", "Question 2?", "Question 3?"]

Excerpts:
{joined}
"""
    return prompt


def build_all_books_prompt(excerpts: list[str], focus: str, sub_topic: str | None):
    joined = "\n\n---\n\n".join(excerpts)
    focus_label = ALL_BOOKS_FOCUS_LABELS.get(focus, "All")
    # Required system prompt addition for All Books mode.
    system_addition = (
        "Ian is a portrait photographer running Phixo, a boutique studio in Montreal's West Island. "
        "He shoots 10-12 sessions per month as a side hustle. Generate questions that would genuinely help him "
        "run and grow his photography business - spanning technique, client work, and business strategy as appropriate "
        "for the selected focus."
    )
    prompt = f"""{system_addition}

Selected focus: {focus_label}

Based on these excerpts, generate 8 questions this photographer would genuinely want to ask.
"""
    if sub_topic:
        prompt += f"""
Focus specifically on this sub-topic: {sub_topic}
Only generate questions relevant to this sub-topic.
"""
    prompt += f"""
Return ONLY a JSON array of 8 question strings. No preamble, no markdown, no explanation.
Example format: ["Question 1?", "Question 2?", "Question 3?"]

Excerpts:
{joined}
"""
    return prompt


def main():
    parser = argparse.ArgumentParser(description="Generate suggested book questions from sampled Chroma chunks.")
    parser.add_argument("--source", required=False, help="Exact source_document title (omit for all-books mode)")
    parser.add_argument("--topic", default="general", help="Book topic tag")
    parser.add_argument(
        "--topic-focus",
        default="all",
        help="All-books topic focus: photography | business | all",
    )
    parser.add_argument("--db-path", required=True, help="ChromaDB path")
    parser.add_argument("--collection", default="phixo_kb", help="Collection name")
    parser.add_argument("--sub-topic", default="", help="Optional sub-topic focus")
    args = parser.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set ANTHROPIC_API_KEY.", file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(args.db_path):
        print(f"ChromaDB not found at {args.db_path}", file=sys.stderr)
        sys.exit(1)

    import chromadb
    import anthropic

    client_db = chromadb.PersistentClient(path=args.db_path)
    collection = client_db.get_collection(name=args.collection)

    source_filter = (args.source or "").strip()
    topic_focus = str(getattr(args, "topic_focus", "all") or "all").strip().lower()
    sub_topic = (args.sub_topic or "").strip() or None

    def collect_text_docs(where):
        get_kwargs = {"include": ["documents", "metadatas"]}
        if where is not None:
            get_kwargs["where"] = where
        results = collection.get(**get_kwargs)
        docs = results.get("documents") or []
        metas = results.get("metadatas") or []
        text_docs = []
        for doc, meta in zip(docs, metas):
            ctype = (meta or {}).get("chunk_type", "text")
            text = str(doc or "").strip()
            if ctype == "image" or not text:
                continue
            text_docs.append(text)
        return text_docs

    if source_filter:
        # Per-book mode (back-compat).
        text_docs = collect_text_docs({"source_document": source_filter})
        if not text_docs:
            print(f"No chunks found for source_document='{source_filter}'", file=sys.stderr)
            sys.exit(1)

        sample_count = min(SAMPLE_SIZE, len(text_docs))
        sampled = random.sample(text_docs, sample_count)
        topic_label = TOPIC_LABELS.get(args.topic, "General")
        prompt = build_prompt(sampled, topic_label, sub_topic)
    else:
        # All-books mode: filter by topic_category and sample exactly per focus.
        if topic_focus == "photography":
            photo_docs = collect_text_docs({"topic_category": {"$in": PHOTOGRAPHY_TOPIC_CATEGORIES}})
            if not photo_docs:
                print("No photography chunks found for all-books mode.", file=sys.stderr)
                sys.exit(1)
            sampled = random.sample(photo_docs, min(SAMPLE_SIZE, len(photo_docs)))
            prompt = build_all_books_prompt(sampled, "photography", sub_topic)
        elif topic_focus == "business":
            business_docs = collect_text_docs({"topic_category": "business"})
            if not business_docs:
                print("No business chunks found for all-books mode.", file=sys.stderr)
                sys.exit(1)
            sampled = random.sample(business_docs, min(SAMPLE_SIZE, len(business_docs)))
            prompt = build_all_books_prompt(sampled, "business", sub_topic)
        else:
            # All: sample 5 from photography-topic chunks and 5 from business-topic chunks.
            photo_docs = collect_text_docs({"topic_category": {"$in": PHOTOGRAPHY_TOPIC_CATEGORIES}})
            business_docs = collect_text_docs({"topic_category": "business"})
            if not photo_docs and not business_docs:
                print("No chunks found for all-books mode.", file=sys.stderr)
                sys.exit(1)

            photo_sample = min(5, len(photo_docs))
            business_sample = min(5, len(business_docs))
            sampled = []
            if photo_sample:
                sampled.extend(random.sample(photo_docs, photo_sample))
            if business_sample:
                sampled.extend(random.sample(business_docs, business_sample))

            # If one side has insufficient chunks, fill up to 10 from whatever remains.
            if len(sampled) < SAMPLE_SIZE:
                already = set(sampled)
                remaining_candidates = [t for t in photo_docs if t not in already] + [t for t in business_docs if t not in already]
                if remaining_candidates:
                    remaining = min(SAMPLE_SIZE - len(sampled), len(remaining_candidates))
                    sampled.extend(random.sample(remaining_candidates, remaining))

            prompt = build_all_books_prompt(sampled, "all", sub_topic)

    client = anthropic.Anthropic()
    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = message.content[0].text if message.content else "[]"
    parsed = extract_json_array(raw) or []
    questions = normalize_questions(parsed)

    if len(questions) < QUESTION_COUNT:
        print(
            f"Model returned {len(questions)} valid questions; expected {QUESTION_COUNT}.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(json.dumps(questions, ensure_ascii=False))


if __name__ == "__main__":
    main()
