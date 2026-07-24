"""Database layer for the FastAPI backend.

Talks to the company Postgres via `docker exec psql` — the same working path as
company/mcp, company/office-server, and build.py. Host 127.0.0.1:5432 is shadowed
by a native postgresql@16, so a normal TCP driver can't reach the container on
this machine. Everything is isolated here: swap to asyncpg later by rewriting
only this file (give the backend a reachable TCP endpoint / the docker network).

Injection-safe: string literals are single-quote-escaped (Postgres runs with
standard_conforming_strings on), like dbio.py / db.mjs.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[1] / ".env.local"  # company/.env.local


def _load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, v = t.partition("=")
        env[k.strip()] = v.strip()
    for k in ("PGCONTAINER", "PGUSER", "PGDATABASE", "PGPASSWORD"):
        if not env.get(k):
            raise RuntimeError(f"{ENV_FILE} is missing {k}")
    return env


_ENV = _load_env()


import time

# Docker Desktop's exec API on Mac intermittently 500s or hangs under bursts of
# concurrent `docker exec` (poll + worker + chat + metering all use this path).
# psql itself is not the problem — the transport is — so a short retry masks the
# hiccup instead of dropping a poll tick / worker step. Two attempts, brief backoff.
_RETRIES = 2
_BACKOFF_S = 0.4


def _psql(args: list[str], sql: str | None = None) -> str:
    cmd = [
        "docker", "exec", "-i",
        "-e", f"PGPASSWORD={_ENV['PGPASSWORD']}",
        _ENV["PGCONTAINER"],
        "psql", "-U", _ENV["PGUSER"], "-h", "127.0.0.1", "-d", _ENV["PGDATABASE"],
        "-v", "ON_ERROR_STOP=1", "-q", *args,
    ]
    last: Exception | None = None
    for attempt in range(_RETRIES):
        try:
            r = subprocess.run(cmd, input=sql, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            # A hang is AMBIGUOUS: a write may have already committed before docker
            # killed the process. Retrying could double-insert → do NOT retry; let the
            # caller (poll/worker loop catches & skips the tick) recover.
            raise
        if r.returncode == 0:
            return r.stdout
        err = (r.stderr or "").strip()
        # A real SQL error (ERROR:/psql:) is deterministic → don't retry.
        if "ERROR:" in err or err.startswith("psql:"):
            raise RuntimeError(f"psql exit {r.returncode}: {err}")
        # Transport failure (docker daemon 500 BEFORE psql ran → nothing committed) →
        # safe to retry.
        last = RuntimeError(f"psql exit {r.returncode}: {err}")
        if attempt < _RETRIES - 1:
            time.sleep(_BACKOFF_S)
    raise last if last else RuntimeError("psql failed")


def lit(s) -> str:
    """SQL string literal (or NULL)."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def query_json(sql: str):
    """Run a query whose single column is JSON; return the parsed value (or None)."""
    out = _psql(["-tAc", sql]).strip()
    return json.loads(out) if out else None


def query_scalar(sql: str) -> str:
    return _psql(["-tAc", sql]).strip()


def execute(sql: str) -> None:
    _psql(["-f", "-"], sql=sql)
