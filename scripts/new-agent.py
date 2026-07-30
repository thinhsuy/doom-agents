#!/usr/bin/env python3
"""Scaffold a new staff agent in one command.

Staff agents are NOT OOP classes — they are DATA (a Markdown persona + DB/roster config)
run by ONE uniform backend path. So the effort-reducer isn't a base class to subclass;
it's a generator that fills every place a new agent must appear, in the right format:

  • the persona .md      — correct frontmatter + all 7 sections, per-division filename convention
  • roster.json          — the hire entry (with --hire)
  • lint + originality    — run automatically so you know it passes CI before committing

It does NOT touch the DB (provider/model, permissions) — do that after `npm run data`
via the Providers / Access Tools tabs (or the Access & Tools Administrator agent), so the
scoped write-paths stay the single source of truth.

Usage:
  python3 scripts/new-agent.py \
      --name "Release Manager" --division engineering \
      --description "Owns the release train: cut, stage, and ship builds safely." \
      --emoji 🚀 --color cyan --role "release engineering & deploy governance" \
      --hire --group "Vận hành" --why "Điều phối release, gác cổng deploy"

Then: cd company/ui && npm run data     # upsert into company.agents + export console data
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def valid_divisions() -> list[str]:
    d = json.loads((ROOT / "divisions.json").read_text(encoding="utf-8"))
    divs = d["divisions"]
    return list(divs.keys()) if isinstance(divs, dict) else [x["id"] for x in divs]


def division_is_prefixed(division: str) -> bool:
    """Follow the target division's MAJORITY filename convention: most divisions name files
    `<division>-<slug>.md`; specialized / game-development / spatial-computing mostly don't."""
    d = ROOT / division
    files = [p.stem for p in d.glob("*.md")] if d.is_dir() else []
    if not files:
        # Known-unprefixed divisions per repo convention; default others to prefixed.
        return division not in ("specialized", "game-development", "spatial-computing")
    prefixed = sum(1 for stem in files if stem.startswith(division + "-"))
    return prefixed * 2 >= len(files)


def existing_names() -> dict[str, str]:
    """Map lowercased display name -> file, across every division dir (duplicate-name guard:
    two agents sharing `name:` silently shadow each other when installed)."""
    out: dict[str, str] = {}
    for div in valid_divisions():
        d = ROOT / div
        if not d.is_dir():
            continue
        for p in d.glob("*.md"):
            m = re.search(r"^name:\s*(.+)$", p.read_text(encoding="utf-8"), re.MULTILINE)
            if m:
                out[m.group(1).strip().lower()] = str(p.relative_to(ROOT))
    return out


PERSONA_TEMPLATE = """\
---
name: {name}
emoji: {emoji}
description: {description}
color: {color}
vibe: {vibe}
---

# {emoji} {name} Agent

You are {name} — {role_sentence}. {mission_line}

## 🧠 Your Identity & Memory
- **Role**: {role_cap}. <!-- TODO: sharpen the exact remit -->
- **Personality**: <!-- TODO: how this agent thinks and what it refuses to let slide -->
- **Memory**: You track, across the conversation, {memory_line} — so your work compounds instead of resetting each turn.
- **Experience**: <!-- TODO: the methods/frameworks this role is grounded in -->

## 🎯 Your Core Mission
- {mission_line}
- <!-- TODO: the second outcome this agent is accountable for -->
- <!-- TODO: the third outcome -->

## 🚨 Critical Rules You Must Follow
- **Stay in your lane.** Do {role_short}; hand off anything outside it rather than guessing.
- <!-- TODO: a non-negotiable this role must never violate -->
- <!-- TODO: another hard rule (evidence, scope, safety…) -->

## 📋 Your Technical Deliverables
- <!-- TODO: the concrete artefacts this agent produces -->

## 🔄 Your Workflow Process
1. <!-- TODO: step one -->
2. <!-- TODO: step two -->
3. <!-- TODO: report the result plainly -->

## 💭 Your Communication Style
- <!-- TODO: how this agent talks — a representative line in its voice -->

## 🎯 Your Success Metrics
- <!-- TODO: how you know this agent is doing its job well -->
"""


def render(name, emoji, description, color, vibe, role) -> str:
    role = role or description.rstrip(".").lower()
    return PERSONA_TEMPLATE.format(
        name=name,
        emoji=emoji or "🧩",
        description=description,
        color=color,
        vibe=vibe or f"Owns {role} and treats it as a system to be made repeatable, not a one-off.",
        role_sentence=f"a specialist responsible for {role}",
        role_cap=role[:1].upper() + role[1:],
        role_short=role,
        mission_line=f"Deliver {role} reliably and make it legible to the rest of the company.",
        memory_line=f"the current state of {role}, open questions, and decisions already made",
    )


def run_check(script: str, arg: str) -> tuple[bool, str]:
    try:
        r = subprocess.run([str(ROOT / "scripts" / script), arg],
                           capture_output=True, text=True, cwd=ROOT, timeout=120)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, f"could not run {script}: {e}"


def add_to_roster(slug: str, group: str, why: str) -> None:
    path = ROOT / "company" / "roster.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("hired", {})[slug] = {"group": group or "", "why": (why or "")[:300]}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Scaffold a new staff agent (persona + roster + checks).")
    ap.add_argument("--name", required=True, help="Display name, Title Case (e.g. 'Release Manager')")
    ap.add_argument("--division", required=True, help=f"One of: {', '.join(valid_divisions())}")
    ap.add_argument("--description", required=True, help="One-line summary (frontmatter description)")
    ap.add_argument("--color", default="indigo")
    ap.add_argument("--emoji", default="🧩")
    ap.add_argument("--vibe", default="")
    ap.add_argument("--role", default="", help="Short role phrase woven into the sections")
    ap.add_argument("--slug", default="", help="Override the derived slug (filename stem)")
    ap.add_argument("--hire", action="store_true", help="Also add the hire entry to company/roster.json")
    ap.add_argument("--group", default="", help="Roster group (with --hire), e.g. 'Kỹ thuật'")
    ap.add_argument("--why", default="", help="Roster 'why' (with --hire)")
    ap.add_argument("--force", action="store_true", help="Overwrite if the file already exists")
    args = ap.parse_args()

    divisions = valid_divisions()
    if args.division not in divisions:
        print(f"error: unknown division '{args.division}'. Valid: {', '.join(divisions)}")
        return 2

    base = args.slug.strip() or slugify(args.name)
    stem = f"{args.division}-{base}" if division_is_prefixed(args.division) and not base.startswith(args.division + "-") else base
    path = ROOT / args.division / f"{stem}.md"

    # Duplicate-name guard (a same-name agent silently shadows another when installed).
    dup = existing_names().get(args.name.strip().lower())
    if dup:
        print(f"error: display name '{args.name}' already used by {dup} — pick a distinct name (names must be unique).")
        return 2
    if path.exists() and not args.force:
        print(f"error: {path.relative_to(ROOT)} already exists (use --force to overwrite).")
        return 2

    path.write_text(render(args.name, args.emoji, args.description, args.color, args.vibe, args.role),
                    encoding="utf-8")
    print(f"✓ wrote {path.relative_to(ROOT)}  (slug: {stem})")

    if args.hire:
        add_to_roster(stem, args.group, args.why or args.description)
        print(f"✓ hired in company/roster.json  (group: {args.group or '—'})")

    rel = str(path.relative_to(ROOT))
    ok_lint, out_lint = run_check("lint-agents.sh", rel)
    ok_orig, out_orig = run_check("check-agent-originality.sh", rel)
    print(f"\n{'✓' if ok_lint else '✗'} lint-agents.sh: {'PASSED' if ok_lint else 'FAILED'}")
    if not ok_lint:
        print(out_lint)
    print(f"{'✓' if ok_orig else '✗'} check-agent-originality.sh: {'PASSED' if ok_orig else 'FAILED'}")
    if not ok_orig:
        print(out_orig)

    print("\nNext:")
    print("  1) Fill in the TODO sections in the .md (replace the stubs with real substance).")
    if not args.hire:
        print("  2) Add the hire entry to company/roster.json (or re-run with --hire).")
    print(f"  {'2' if args.hire else '3'}) cd company/ui && npm run data   # upsert into company.agents + export")
    print(f"  {'3' if args.hire else '4'}) (optional) set provider/model on Providers tab; grant tools on Access Tools tab.")
    return 0 if (ok_lint and ok_orig) else 1


if __name__ == "__main__":
    sys.exit(main())
