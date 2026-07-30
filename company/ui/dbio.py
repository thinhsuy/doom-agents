"""
dbio.py — talk to the company Postgres, two transports (same choice as company/api/db.py):

  • LOCAL  — `docker exec ... psql`, when PGCONTAINER is set. The container's 5432 is
    shadowed by a native postgres on this machine, so a TCP driver can't reach it here.
  • CLOUD  — psycopg over TCP, when PGCONTAINER is absent and PGHOST points at RDS. This
    is how `build.py` seeds the roster into RDS during a deploy (no docker daemon there).

SQL string literals are single-quote-escaped (Postgres runs with standard_conforming_strings
on), and jsonb values are passed as escaped JSON text cast with ::jsonb, so Vietnamese text
and embedded quotes are safe. psycopg is imported lazily — the local docker path never needs it.

Connection settings come from process env (ECS injects them) with company/.env.local filling
gaps locally. Raises DbUnavailable with an actionable message if the DB can't be reached, so
`npm run data` fails loudly instead of silently shipping stale data.
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
    # Process env wins (ECS/deploy injects PGHOST/PGPASSWORD/...); .env.local fills gaps
    # locally and is simply absent in the cloud.
    env = dict(os.environ)
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                env.setdefault(k.strip(), v.strip())
    if not env.get("PGCONTAINER") and not env.get("PGHOST"):
        raise DbUnavailable(
            f"No database configured. Set PGCONTAINER (local docker) in {ENV_FILE},\n"
            "  or PGHOST/PGPORT (TCP / RDS) in the environment for a cloud deploy."
        )
    required = ("PGUSER", "PGDATABASE", "PGPASSWORD")
    required += ("PGCONTAINER",) if env.get("PGCONTAINER") else ("PGHOST",)
    for key in required:
        if not env.get(key):
            raise DbUnavailable(f"database config is missing {key}")
    return env


# --- Transport A: docker exec psql (local) ------------------------------------

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


# --- Transport B: psycopg over TCP (cloud / RDS) ------------------------------

_conn = None  # single reused connection; build.py is short-lived and single-threaded


def _get_conn(env):
    global _conn
    if _conn is not None and not _conn.closed:
        return _conn
    try:
        import psycopg
    except ImportError:
        raise DbUnavailable("psycopg is required for TCP mode — `pip install 'psycopg[binary]'`.")
    try:
        _conn = psycopg.connect(
            host=env["PGHOST"],
            port=env.get("PGPORT", "5432"),
            dbname=env["PGDATABASE"],
            user=env["PGUSER"],
            password=env.get("PGPASSWORD", ""),
            autocommit=True,
            connect_timeout=10,
            application_name="agency-build",
        )
    except Exception as e:  # noqa: BLE001
        raise DbUnavailable(f"could not connect to {env['PGHOST']}: {e}")
    return _conn


def _tcp_exec(env, sql):
    from psycopg import pq

    conn = _get_conn(env)
    res = conn.pgconn.exec_(sql.encode())
    if res.status not in (pq.ExecStatus.COMMAND_OK, pq.ExecStatus.TUPLES_OK):
        msg = (res.error_message or b"").decode().strip()
        raise DbUnavailable(msg or f"psql exec status {res.status}")


def _tcp_query_json(env, sql):
    conn = _get_conn(env)
    cur = conn.execute(sql)
    row = cur.fetchone() if cur.description else None
    val = row[0] if row else None
    if isinstance(val, (str, bytes, bytearray)):
        return json.loads(val)
    return val


# --- Public API (dispatch on transport) ---------------------------------------

def ping(env):
    """Confirm the DB is reachable and migrated before we touch it."""
    if env.get("PGCONTAINER"):
        out = _run(env, ["-tAc", "SELECT count(*) FROM company.schema_migrations"], capture=True)
        if not out.strip().isdigit():
            raise DbUnavailable("company schema not found — apply company/db/*.sql first.")
        return
    # TCP: schema_migrations was retired after ~012, so check the agents table exists.
    conn = _get_conn(env)
    got = conn.execute("SELECT to_regclass('company.agents') IS NOT NULL").fetchone()
    if not (got and got[0]):
        raise DbUnavailable("company schema not found on RDS — apply company/db/*.sql first.")


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
    if env.get("PGCONTAINER"):
        _run(env, ["-q", "-f", "-"], stdin=sql)
        return
    _tcp_exec(env, sql)


def query_json(env, sql):
    """Run a query whose single column is JSON; return the parsed value."""
    if env.get("PGCONTAINER"):
        out = _run(env, ["-tAc", sql], capture=True).strip()
        return json.loads(out) if out else None
    return _tcp_query_json(env, sql)
