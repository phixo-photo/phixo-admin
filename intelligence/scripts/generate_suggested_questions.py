#!/usr/bin/env python3
"""
Generate suggested questions for a single ingested book from sampled chunks.

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


def main():
    parser = argparse.ArgumentParser(description="Generate suggested book questions from sampled Chroma chunks.")
    parser.add_argument("--source", required=True, help="Exact source_document title")
    parser.add_argument("--topic", default="general", help="Book topic tag")
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
    results = collection.get(
        where={"source_document": args.source},
        include=["documents", "metadatas"],
    )
    docs = results.get("documents") or []
    metas = results.get("metadatas") or []
    text_docs = []
    for doc, meta in zip(docs, metas):
        ctype = (meta or {}).get("chunk_type", "text")
        text = str(doc or "").strip()
        if ctype == "image" or not text:
            continue
        text_docs.append(text)

    if not text_docs:
        print(f"No chunks found for source_document='{args.source}'", file=sys.stderr)
        sys.exit(1)

    sample_count = min(SAMPLE_SIZE, len(text_docs))
    sampled = random.sample(text_docs, sample_count)
    topic_label = TOPIC_LABELS.get(args.topic, "General")
    prompt = build_prompt(sampled, topic_label, (args.sub_topic or "").strip() or None)

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
