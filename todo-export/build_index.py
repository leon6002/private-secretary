#!/usr/bin/env python3
"""
Build the todo RAG index: embed each task's `text` blob and store vectors +
filterable metadata in todo_index.json.

  python3 build_index.py            # reads todo_export.jsonl -> todo_index.json

Local, offline, zero API key: multilingual MiniLM via fastembed (中英双语).
Corpus is tiny (~1.7K items) so the query side brute-forces cosine in memory —
no FAISS / vector DB needed.
"""

import json
import sys
from fastembed import TextEmbedding

MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
SRC = "todo_export.jsonl"
OUT = "todo_index.json"
# Metadata kept per item for filtering at query time (NOT embedded).
META = ["id", "list", "title", "status", "status_zh", "importance",
        "due", "completed", "created", "subtasks", "notes"]


def main():
    rows = [json.loads(l) for l in open(SRC, encoding="utf-8") if l.strip()]
    texts = [r.get("text", "") for r in rows]
    print(f"embedding {len(texts)} tasks with {MODEL} ...", file=sys.stderr)

    model = TextEmbedding(model_name=MODEL)
    vecs = list(model.embed(texts))  # one 384-d vector per task
    dim = len(vecs[0]) if vecs else 0

    items = []
    for r, v in zip(rows, vecs):
        item = {k: r.get(k) for k in META}
        item["text"] = r.get("text", "")
        # round to 6 dp — keeps the file small, no measurable recall loss
        item["vec"] = [round(float(x), 6) for x in v]
        items.append(item)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"model": MODEL, "dim": dim, "count": len(items), "items": items},
                  f, ensure_ascii=False)
    print(f"wrote {OUT}: {len(items)} items, dim={dim}", file=sys.stderr)


if __name__ == "__main__":
    main()
