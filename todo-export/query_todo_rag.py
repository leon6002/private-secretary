#!/usr/bin/env python3
"""
Query the todo RAG: semantic search over task `text` + metadata filters.

  python3 query_todo_rag.py "<query>" [--k N] [--list NAME] [--status S]
                                      [--open] [--due-before YYYY-MM-DD] [--json]

  --open        shorthand for --status notStarted (current to-dos only)
  --status S    filter by status (notStarted | completed | ...)
  --list NAME   filter by To Do list (e.g. Taiv, Backlog, 秦老师)
  --due-before  only tasks with a due date on/before this date
  --k N         top-K (default 8)   --json  machine-readable output

Brute-force cosine over the in-memory index (corpus is tiny). Same local model
as build_index.py (no API key).
"""

import argparse
import json
import sys
import math
from fastembed import TextEmbedding


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--list", dest="list_name")
    ap.add_argument("--status")
    ap.add_argument("--open", action="store_true", help="status=notStarted")
    ap.add_argument("--due-before", dest="due_before")
    ap.add_argument("--index", default="todo_index.json")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    idx = json.load(open(a.index, encoding="utf-8"))
    items = idx["items"]
    status = "notStarted" if a.open else a.status

    # metadata filter first (cheap), then rank the survivors
    def keep(it):
        if a.list_name and it.get("list") != a.list_name:
            return False
        if status and it.get("status") != status:
            return False
        if a.due_before:
            due = it.get("due") or ""
            if not due or due > a.due_before:
                return False
        return True

    pool = [it for it in items if keep(it)]
    if not pool:
        print("(no tasks match the filters)", file=sys.stderr)
        return

    qvec = next(TextEmbedding(model_name=idx["model"]).embed([a.query]))
    ranked = sorted(pool, key=lambda it: cosine(qvec, it["vec"]), reverse=True)[: a.k]

    if a.json:
        out = [{k: it.get(k) for k in ("id", "list", "title", "status",
                "status_zh", "due", "importance", "notes")}
               | {"score": round(cosine(qvec, it["vec"]), 4)} for it in ranked]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    for it in ranked:
        score = cosine(qvec, it["vec"])
        meta = [it["status_zh"]]
        if it.get("due"):
            meta.append(f"due {it['due']}")
        if it.get("importance") == "high":
            meta.append("⚑high")
        print(f"[{score:.3f}] ({it['list']}) {it['title']}  — {', '.join(meta)}")
        if it.get("notes"):
            print(f"        {it['notes'].splitlines()[0][:120]}")


if __name__ == "__main__":
    main()
