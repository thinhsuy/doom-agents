#!/usr/bin/env python3
"""One-shot DB bootstrap/upgrade for a deploy.

Runs INSIDE the app container as a one-off ECS task (so it sits in the VPC and can
reach the private RDS), in TCP mode because the task has no PGCONTAINER. Applies, in order:

  1. company/db/0*.sql                    schema + agent-INDEPENDENT fixed data
  2. company/ui/build.py                  agent roster, synced from the repo's .md files
  3. company/db/seed/deploy_post_build.sql agent-DEPENDENT fixed data (goals, access grants)
  4. company/db/seed/standing_channels.sql standing command channels + members

Everything is idempotent, so this is safe to run on every deploy. No `psql` binary is
needed — SQL is applied through company/api/db.py's execute() over psycopg, the same
transport the app uses. Exit code is non-zero on the first failure so CI can gate on it.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "company" / "api"))

import db  # noqa: E402  — TCP mode when PGCONTAINER is unset (as in ECS)

DB_DIR = ROOT / "company" / "db"


def _apply(path: Path) -> None:
    print(f"[migrate] apply {path.relative_to(ROOT)}", flush=True)
    db.execute(path.read_text(encoding="utf-8"))


def main() -> int:
    print("[migrate] transport:", "docker" if db._USE_DOCKER else "TCP", flush=True)

    # 1) migrations, in filename order
    for f in sorted(DB_DIR.glob("0*.sql")):
        _apply(f)

    # 2) agent roster (build.py is pure Python; inherits this task's PG* env → TCP)
    print("[migrate] sync roster (build.py)…", flush=True)
    subprocess.run([sys.executable, str(ROOT / "company" / "ui" / "build.py")], check=True)

    # 3+4) agent-dependent seeds, after the roster exists
    for name in ("deploy_post_build.sql", "standing_channels.sql"):
        _apply(DB_DIR / "seed" / name)

    db.close()
    print("[migrate] done.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
