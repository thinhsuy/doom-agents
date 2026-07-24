"""
dbio.py — talk to the company Postgres via psql inside the existing container.

No Postgres driver dependency: everything goes through `docker exec ... psql`,
which is the same path already proven to work for this project. SQL string
literals are single-quote-escaped (Postgres runs with standard_conforming_strings
on), and jsonb values are passed as escaped JSON text cast with ::jsonb, so
Vietnamese text and embedded quotes are safe.

Reads connection settings from company/.env.local (PGCONTAINER/PGUSER/PGDATABASE/
PGPASSWORD). Raises DbUnavailable with an actionable message if the DB can't be
reached, so `npm run data` fails loudly instead of silently shipping stale data.
"""

import json
import os
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(_HERE))
ENV_FILE = os.path.join(ROOT, "company", ".env.local")


class DbUnavailable(RuntimeError):
    pass


def load_env():
    if not os.path.exists(ENV_FILE):
        raise DbUnavailable(
            f"{ENV_FILE} not found. The console's data now comes from Postgres.\n"
            "  Create it from company/.env.example (see company/db/README.md)."
        )
    env = {}
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    for key in ("PGCONTAINER", "PGUSER", "PGDATABASE", "PGPASSWORD"):
        if not env.get(key):
            raise DbUnavailable(f"{ENV_FILE} is missing {key}")
    return env


def _run(env, args, stdin=None, capture=False):
    cmd = [
        "docker", "exec", "-i",
        "-e", f"PGPASSWORD={env['PGPASSWORD']}",
        env["PGCONTAINER"],
        "psql", "-U", env["PGUSER"], "-h", "127.0.0.1", "-d", env["PGDATABASE"],
        "-v", "ON_ERROR_STOP=1", *args,
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=stdin.encode("utf-8") if stdin is not None else None,
            capture_output=True,
            timeout=60,
        )
    except FileNotFoundError:
        raise DbUnavailable("`docker` not found on PATH.")
    except subprocess.TimeoutExpired:
        raise DbUnavailable("psql timed out — is the Postgres container running?")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise DbUnavailable(f"psql failed (exit {proc.returncode}):\n  {err}")
    return proc.stdout.decode("utf-8") if capture else None


def ping(env):
    """Confirm the DB is reachable and migrated before we touch it."""
    out = _run(env, ["-tAc", "SELECT count(*) FROM company.schema_migrations"], capture=True)
    if not out.strip().isdigit():
        raise DbUnavailable("company schema not found — apply company/db/*.sql first.")


# --- SQL literal helpers (standard_conforming_strings assumed on) -------------

def lit(s):
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def jlit(obj):
    return lit(json.dumps(obj, ensure_ascii=False)) + "::jsonb"


def arr(items):
    if not items:
        return "'{}'::text[]"
    return "ARRAY[" + ",".join(lit(x) for x in items) + "]::text[]"


def exec_sql(env, sql):
    _run(env, ["-q", "-f", "-"], stdin=sql)


def query_json(env, sql):
    """Run a query whose single column is JSON; return the parsed value."""
    out = _run(env, ["-tAc", sql], capture=True).strip()
    return json.loads(out) if out else None
