"""Database layer for the FastAPI backend.

TWO transports, chosen automatically at import from config:

  • LOCAL (dev)  — `docker exec psql`, when PGCONTAINER is set. The container's
    5432 is shadowed by a native postgres@16 on this machine, so a TCP driver
    can't reach it here; docker-exec is the only working path locally.
  • CLOUD (RDS)  — psycopg over TCP, when PGCONTAINER is absent and PGHOST points
    at a reachable endpoint (e.g. the RDS instance from infra/). This is what runs
    in ECS, where there is no docker daemon to exec into.

Both expose the SAME contract — `lit` / `query_json` / `query_scalar` / `execute` —
so main.py (and its q/ex/scalar wrappers) is identical in both. psycopg is imported
lazily, so the local docker path does not require it to be installed.

Injection-safe: string literals are single-quote-escaped (Postgres runs with
standard_conforming_strings on), like dbio.py / db.mjs.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parents[1] / ".env.local"  # company/.env.local


def _load_env() -> dict[str, str]:
    # Real process env wins (ECS injects PGHOST/PGPASSWORD/... as task env); the
    # .env.local file only fills gaps and is absent in the cloud.
    env: dict[str, str] = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if not t or t.startswith("#") or "=" not in t:
                continue
            k, _, v = t.partition("=")
            env.setdefault(k.strip(), v.strip())
    return env


_ENV = _load_env()
_USE_DOCKER = bool(_ENV.get("PGCONTAINER"))

# Fail loudly and early if the chosen transport is missing its config.
if _USE_DOCKER:
    _REQUIRED = ("PGCONTAINER", "PGUSER", "PGDATABASE", "PGPASSWORD")
else:
    _REQUIRED = ("PGHOST", "PGUSER", "PGDATABASE", "PGPASSWORD")
for _k in _REQUIRED:
    if not _ENV.get(_k):
        _mode = "docker" if _USE_DOCKER else "TCP"
        raise RuntimeError(f"db.py ({_mode} mode) is missing required env {_k}")


def lit(s) -> str:
    """SQL string literal (or NULL)."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


# --------------------------------------------------------------------------- #
# Transport A — docker exec psql (local dev)                                   #
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Transport B — psycopg over TCP (cloud / RDS)                                 #
# --------------------------------------------------------------------------- #

_pool = None  # lazily created psycopg_pool.ConnectionPool


def _get_pool():
    global _pool
    if _pool is None:
        from psycopg_pool import ConnectionPool  # lazy: not needed in docker mode

        conninfo = (
            f"host={_ENV['PGHOST']} port={_ENV.get('PGPORT', '5432')} "
            f"dbname={_ENV['PGDATABASE']} user={_ENV['PGUSER']} "
            f"password={_ENV['PGPASSWORD']} connect_timeout=10 "
            f"application_name=agency-api"
        )
        _pool = ConnectionPool(
            conninfo,
            min_size=1,
            max_size=int(_ENV.get("PGPOOL_MAX", "8")),
            kwargs={"autocommit": True},
            open=True,
        )
    return _pool


def _tcp_one(sql: str):
    """Run a single-statement SELECT, return the first column of the first row (or None)."""
    with _get_pool().connection() as conn:
        cur = conn.execute(sql)
        row = cur.fetchone() if cur.description else None
        return row[0] if row else None


def _tcp_exec(sql: str) -> None:
    """Run a possibly multi-statement script via libpq PQexec — the same all-or-nothing
    semantics as psql feeding `-f -`. conn.execute() only runs one statement, so the
    two-statement writes in main.py (UPDATE + status_events INSERT) need this path."""
    from psycopg import pq  # lazy

    with _get_pool().connection() as conn:
        res = conn.pgconn.exec_(sql.encode())
        if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
            msg = (res.error_message or b"").decode().strip()
            raise RuntimeError(msg or f"psql exec status {res.status}")


# --------------------------------------------------------------------------- #
# Unified contract — dispatches to the active transport                        #
# --------------------------------------------------------------------------- #

def query_json(sql: str):
    """Run a query whose single column is JSON; return the parsed value (or None)."""
    if _USE_DOCKER:
        out = _psql(["-tAc", sql]).strip()
        return json.loads(out) if out else None
    val = _tcp_one(sql)
    # psycopg auto-parses json/jsonb to Python objects; guard the str case anyway.
    if isinstance(val, (str, bytes, bytearray)):
        return json.loads(val)
    return val


def query_scalar(sql: str) -> str:
    """Run a query returning a single value; return it as text (matching psql -tA:
    empty string for no rows, 't'/'f' for booleans)."""
    if _USE_DOCKER:
        return _psql(["-tAc", sql]).strip()
    val = _tcp_one(sql)
    if val is None:
        return ""
    if isinstance(val, bool):
        return "t" if val else "f"
    return str(val)


def execute(sql: str) -> None:
    if _USE_DOCKER:
        _psql(["-f", "-"], sql=sql)
        return
    _tcp_exec(sql)


def close() -> None:
    """Close the TCP pool on app shutdown (no-op in docker mode)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
