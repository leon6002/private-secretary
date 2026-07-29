#!/usr/bin/env python3
"""
Export all Microsoft To Do lists + tasks into RAG-friendly artifacts.

Zero dependencies (stdlib only). Outputs three files:
  - todo_export.jsonl : one task per line, structured fields + a `text` blob
                        ready for chunking/embedding (the RAG corpus).
  - todo_export.md    : human/agent-readable mirror, grouped by list.
  - todo_export.json  : the full nested structure (lists -> tasks), for reference.

Token: ./token.txt or GRAPH_TOKEN env. Read-only Tasks.Read is enough.
"""

import json
import os
import sys
import urllib.request
import urllib.error

GRAPH = "https://graph.microsoft.com/v1.0"
STATUS_ZH = {
    "notStarted": "未开始",
    "inProgress": "进行中",
    "waitingOnOthers": "等待他人",
    "deferred": "已推迟",
    "completed": "已完成",
}


def get_all(url, token):
    items = []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            sys.exit(f"HTTP {e.code} on {url}\n{e.read().decode('utf-8','replace')}")
        items.extend(data.get("value", []))
        url = data.get("@odata.nextLink")
    return items


def d(dt):
    if not dt:
        return ""
    return dt.get("dateTime", "")[:10] if isinstance(dt, dict) else str(dt)[:10]


def main():
    token = os.environ.get("GRAPH_TOKEN", "").strip()
    if not token and os.path.exists("token.txt"):
        token = open("token.txt", encoding="utf-8").read().strip()
    token = token.removeprefix("Bearer ").strip()
    if not token:
        sys.exit("No token (token.txt or GRAPH_TOKEN).")

    lists = get_all(f"{GRAPH}/me/todo/lists", token)
    corpus = []          # jsonl records
    nested = []          # full structure
    md = ["# Microsoft To Do — full export", ""]

    for lst in lists:
        lname = lst.get("displayName", "")
        # $expand pulls checklist sub-items in the same call
        tasks = get_all(
            f"{GRAPH}/me/todo/lists/{lst['id']}/tasks?$expand=checklistItems&$top=100",
            token,
        )
        print(f"{lname}: {len(tasks)} tasks", file=sys.stderr)
        nested.append({"list": lname, "tasks": tasks})
        md.append(f"## {lname}  ({len(tasks)} tasks)\n")

        for t in tasks:
            status = t.get("status", "")
            title = t.get("title", "").strip()
            notes = (t.get("body") or {}).get("content", "").strip()
            due = d(t.get("dueDateTime"))
            done = d(t.get("completedDateTime"))
            created = d(t.get("createdDateTime"))
            importance = t.get("importance", "")
            subs = [c.get("displayName", "") for c in t.get("checklistItems", [])]

            # natural-language blob for embedding
            parts = [f"List: {lname}", f"Task: {title}",
                     f"Status: {STATUS_ZH.get(status, status)}"]
            if importance and importance != "normal":
                parts.append(f"Importance: {importance}")
            if due:
                parts.append(f"Due: {due}")
            if done:
                parts.append(f"Completed: {done}")
            if subs:
                parts.append("Subtasks: " + "; ".join(s for s in subs if s))
            if notes:
                parts.append(f"Notes: {notes}")
            text = ". ".join(parts)

            corpus.append({
                "id": t.get("id"),
                "list": lname,
                "title": title,
                "status": status,
                "status_zh": STATUS_ZH.get(status, status),
                "importance": importance,
                "due": due,
                "completed": done,
                "created": created,
                "subtasks": [s for s in subs if s],
                "notes": notes,
                "text": text,
            })

            mark = "x" if status == "completed" else " "
            line = f"- [{mark}] **{title}** — {STATUS_ZH.get(status, status)}"
            meta = []
            if due:
                meta.append(f"due {due}")
            if done:
                meta.append(f"done {done}")
            if importance == "high":
                meta.append("⚑high")
            if meta:
                line += f"  _({', '.join(meta)})_"
            md.append(line)
            for s in subs:
                if s:
                    md.append(f"    - {s}")
            if notes:
                md.append(f"    > {notes.splitlines()[0][:200]}")
        md.append("")

    with open("todo_export.jsonl", "w", encoding="utf-8") as f:
        for r in corpus:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open("todo_export.json", "w", encoding="utf-8") as f:
        json.dump(nested, f, ensure_ascii=False, indent=2)
    with open("todo_export.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    print(f"\n{len(corpus)} tasks across {len(lists)} lists", file=sys.stderr)
    by_status = {}
    for r in corpus:
        by_status[r["status_zh"]] = by_status.get(r["status_zh"], 0) + 1
    for s, n in sorted(by_status.items()):
        print(f"  {s}: {n}", file=sys.stderr)


if __name__ == "__main__":
    main()
