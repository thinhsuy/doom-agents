"""Agency OS backend (FastAPI).

One server for everything the console needs:
  • REST — live data straight from Postgres (workspace / decisions / monitor / agents)
    and interactive endpoints (chat, floor config).
  • WebSocket /ws/office — the live office event stream (poll Postgres, broadcast).
  • Static — serves the built FE (company/ui/dist), so a SINGLE deploy works.

Dev: run the FE with Vite (HMR) and this with uvicorn --reload, proxy /api + /ws.
Prod: build the FE (`npm run build`) → this server mounts it → one process, one port.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import db
import queries
from toolkit import Access, ToolRegistry

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "company" / "ui" / "dist"
POLL_SECONDS = 1.0

# Load company/.env.local into the process env so provider keys (OPENAI_API_KEY,
# AWS_*, BEDROCK_*) are available without a separate `export`. Real env wins.
_ENV_FILE = ROOT / "company" / ".env.local"
if _ENV_FILE.exists():
    for _line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if _t and not _t.startswith("#") and "=" in _t:
            _k, _, _v = _t.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())
# ---- LLM providers: GPT (OpenAI) and Claude (AWS Bedrock) ------------------
PROVIDERS = {
    "gpt": {
        "label": "GPT (OpenAI)",
        "env": ["OPENAI_API_KEY"],
        "models": [
            {"id": "gpt-4o-mini", "label": "GPT-4o mini"},
            {"id": "gpt-4o", "label": "GPT-4o"},
        ],
    },
    "claude": {
        "label": "Claude (AWS Bedrock)",
        "env": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        "models": [
            {"id": "haiku", "label": "Claude Haiku 4.5"},
            {"id": "sonnet", "label": "Claude Sonnet 4.5"},
            {"id": "sonnet-5", "label": "Claude Sonnet 5"},
            {"id": "opus", "label": "Claude Opus 4.8"},
            {"id": "fable", "label": "Claude Fable 5"},
        ],
    },
}
# Claude aliases → Bedrock model IDs. Newer Claude on Bedrock is only reachable
# via a cross-region INFERENCE PROFILE (prefix global./apac.), not the raw model
# id — using the raw id returns "invalid model identifier". Defaults below are the
# global profiles verified ACTIVE on account 203918858918 in ap-southeast-1; a
# different account/region overrides via BEDROCK_HAIKU/BEDROCK_SONNET in .env.local.
BEDROCK_IDS = {
    "haiku": os.environ.get("BEDROCK_HAIKU", "global.anthropic.claude-haiku-4-5-20251001-v1:0"),
    "sonnet": os.environ.get("BEDROCK_SONNET", "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    "sonnet-5": os.environ.get("BEDROCK_SONNET5", "global.anthropic.claude-sonnet-5"),
    "opus": os.environ.get("BEDROCK_OPUS", "global.anthropic.claude-opus-4-8"),
    "fable": os.environ.get("BEDROCK_FABLE", "global.anthropic.claude-fable-5"),
}
DEFAULT_PROVIDER = os.environ.get("DEFAULT_PROVIDER", "claude")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "haiku")


def _provider_configured(pid: str) -> bool:
    p = PROVIDERS.get(pid)
    return bool(p) and all(os.environ.get(e) for e in p["env"])

# Division presentation (mirrors build.py) — for the /api/agents payload.
DIVISION_EMOJI = {
    "academic": "🎓", "design": "🎨", "engineering": "⚙️", "finance": "💰",
    "game-development": "🎮", "gis": "🗺️", "healthcare": "🩺", "hr": "🧑‍💼",
    "marketing": "📣", "paid-media": "🎯", "product": "📦", "project-management": "📋",
    "sales": "📈", "security": "🛡️", "spatial-computing": "🥽", "specialized": "✨",
    "support": "🛟", "testing": "🧪",
}


# ---- async DB helpers (docker-exec psql is blocking → run off the event loop) ----
async def q(sql: str):
    return await asyncio.to_thread(db.query_json, sql)


async def ex(sql: str) -> None:
    await asyncio.to_thread(db.execute, sql)


async def scalar(sql: str) -> str:
    return await asyncio.to_thread(db.query_scalar, sql)


# ---- Emergency brakes: daily cost ceiling + threshold + manual stop + per-model
# LLM timeout. All runtime-configurable via company.office_config (no restart):
#   key 'budget'         = {ceilingUsd, warnUsd}   daily spend cap + warn threshold
#   key 'worker_paused'  = {paused, reason}        manual OR auto (ceiling) stop
#   key 'model_timeouts' = {default, haiku, ...}   seconds per model
_DEFAULT_CEILING_USD = float(os.environ.get("MAX_DAILY_USD", "5") or 5)
_DEFAULT_TIMEOUTS = {"default": 60.0, "haiku": 45.0, "sonnet": 90.0, "sonnet-5": 90.0,
                     "opus": 120.0, "fable": 120.0, "gpt-4o-mini": 45.0, "gpt-4o": 90.0}
_budget = {"spent": 0.0, "spentMonth": 0.0, "spentQuarter": 0.0, "spentYear": 0.0,
           "ceiling": _DEFAULT_CEILING_USD, "warn": round(_DEFAULT_CEILING_USD * 0.8, 4),
           "over": False, "manual": False, "blocked": False, "warned": False, "reason": None}
_timeouts = dict(_DEFAULT_TIMEOUTS)


async def _cfg(key: str) -> dict:
    return await q(f"SELECT value FROM company.office_config WHERE key={db.lit(key)}") or {}


async def _set_cfg(key: str, value: dict) -> None:
    await ex(
        "INSERT INTO company.office_config (key, value, updated_at) "
        f"VALUES ({db.lit(key)}, {db.lit(json.dumps(value))}::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()"
    )


def _model_timeout(model_key: str) -> float:
    return float(_timeouts.get(model_key, _timeouts.get("default", 60.0)) or 60.0)


async def _refresh_budget() -> None:
    """Recompute today's real spend and the blocked state. Auto-latches a stop when
    spend hits the ceiling (stays stopped until the owner resumes). Cheap — one sum."""
    b = await _cfg("budget")
    ceiling = float(b.get("ceilingUsd") or _DEFAULT_CEILING_USD)
    warn = float(b.get("warnUsd") or round(ceiling * 0.8, 4))
    to = await _cfg("model_timeouts")
    if to:
        _timeouts.update({k: float(v) for k, v in to.items() if str(v).replace(".", "").isdigit()})
    p = await _cfg("worker_paused")
    manual = bool(p.get("paused"))
    # today / this month / quarter / year real spend, one query. Only DAILY drives the
    # auto-stop; month/quarter/year are for visibility (estimated ceilings = daily×N).
    sp = await q(
        "SELECT json_build_object("
        "'day',coalesce(round(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('day',now()))::numeric,4),0),"
        "'month',coalesce(round(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('month',now()))::numeric,4),0),"
        "'quarter',coalesce(round(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('quarter',now()))::numeric,4),0),"
        "'year',coalesce(round(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('year',now()))::numeric,4),0)) "
        "FROM company.usage_costed WHERE NOT is_sample"
    ) or {}
    spent = float(sp.get("day") or 0)
    over = spent >= ceiling
    if spent < warn:
        _budget["warned"] = False  # re-arm the warning (e.g. a new day resets spend)
    _budget.update(spent=spent, spentMonth=float(sp.get("month") or 0),
                   spentQuarter=float(sp.get("quarter") or 0), spentYear=float(sp.get("year") or 0),
                   ceiling=ceiling, warn=warn, over=over,
                   manual=manual, blocked=(manual or over), reason=p.get("reason"))
    if over and not manual:  # AUTO-STOP: latch a pause so it stays stopped
        rsn = f"Tự động dừng: chi phí hôm nay ${spent} ≥ trần ${ceiling}"
        await _set_cfg("worker_paused", {"paused": True, "reason": rsn})
        _budget.update(manual=True, blocked=True, reason=rsn)
        print("[budget] AUTO-STOP —", rsn)
    elif spent >= warn and not _budget["warned"]:
        _budget["warned"] = True
        print(f"[budget] WARN: ${spent} ≥ ngưỡng ${warn} (trần ${ceiling})")


# ---- office WebSocket hub + change-feed poll ----
class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def broadcast(self, obj: dict) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(obj)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()
cursor = {"message": 0, "status": 0, "comment": 0}


async def poll_loop() -> None:
    init = await q(
        "SELECT json_build_object("
        "'message', coalesce((SELECT max(id) FROM company.messages),0),"
        "'status', coalesce((SELECT max(id) FROM company.status_events),0),"
        "'comment', coalesce((SELECT max(id) FROM company.task_comments),0))"
    )
    cursor.update({k: int(v) for k, v in (init or {}).items()})
    while True:
        try:
            if hub.clients:
                for m in await q(
                    "SELECT coalesce(json_agg(json_build_object("
                    "'id',id,'from',from_agent,'to',to_agent,'kind',kind,"
                    "'body',left(body,240),'taskId',task_id,'createdAt',created_at) ORDER BY id),'[]') "
                    f"FROM company.messages WHERE id > {cursor['message']}"
                ) or []:
                    cursor["message"] = max(cursor["message"], int(m["id"]))
                    await hub.broadcast({"type": "message", **m})
                for e in await q(
                    "SELECT coalesce(json_agg(json_build_object("
                    "'id',e.id,'taskId',e.entity_id,'from',e.from_status,'to',e.to_status,"
                    "'by',e.changed_by,'reason',left(e.reason,240),'assignee',t.assignee,'reporter',t.reporter,"
                    "'createdAt',e.created_at) ORDER BY e.id),'[]') "
                    "FROM company.status_events e LEFT JOIN company.tasks t ON t.id=e.entity_id "
                    f"WHERE e.entity_type='task' AND e.id > {cursor['status']}"
                ) or []:
                    cursor["status"] = max(cursor["status"], int(e["id"]))
                    await hub.broadcast({"type": "taskStatus", **e})
                for c in await q(
                    "SELECT coalesce(json_agg(json_build_object("
                    "'id',id,'taskId',task_id,'agent',agent,'mentions',mentions,"
                    "'createdAt',created_at) ORDER BY id),'[]') "
                    f"FROM company.task_comments WHERE id > {cursor['comment']}"
                ) or []:
                    cursor["comment"] = max(cursor["comment"], int(c["id"]))
                    await hub.broadcast({"type": "comment", **c})
            else:
                # No viewers: keep the cursor at head so we don't replay a backlog.
                head = await q(
                    "SELECT json_build_object("
                    "'message', coalesce((SELECT max(id) FROM company.messages),0),"
                    "'status', coalesce((SELECT max(id) FROM company.status_events),0),"
                    "'comment', coalesce((SELECT max(id) FROM company.task_comments),0))"
                )
                cursor.update({k: int(v) for k, v in (head or {}).items()})
        except Exception as exc:  # noqa: BLE001
            print("[api] poll error:", exc)
        await asyncio.sleep(POLL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await _refresh_budget()  # know the blocked state before the first request
    except Exception as exc:  # noqa: BLE001
        print("[budget] initial refresh error:", exc)
    try:
        await _seed_auth()  # set owner password hashes from env (never stored plaintext)
    except Exception as exc:  # noqa: BLE001
        print("[auth] seed error:", exc)
    task = asyncio.create_task(poll_loop())
    worker = asyncio.create_task(worker_loop())  # staff agents work assigned tasks
    try:
        yield
    finally:
        task.cancel()
        worker.cancel()
        db.close()  # release the TCP pool cleanly (no-op in local docker mode)


app = FastAPI(title="Agency OS API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ==== Auth: 3 owner accounts (CEO/CTO/COO), same permissions, separate login identity ====
# Cookie-based sessions (same-origin, so the cookie rides every fetch/WS with no per-call
# header wiring). Passwords come from env and are stored ONLY as pbkdf2 hash + salt.
_SECRET_FILE = Path(__file__).resolve().parent / ".session_secret"


def _session_secret() -> bytes:
    """A stable HMAC key for signing session tokens — generated once, persisted (gitignored),
    so sessions survive restarts without the owner having to configure anything."""
    try:
        return _SECRET_FILE.read_bytes()
    except FileNotFoundError:
        s = secrets.token_bytes(32)
        _SECRET_FILE.write_bytes(s)
        try:
            os.chmod(_SECRET_FILE, 0o600)
        except OSError:
            pass
        return s


_SESSION_SECRET = _session_secret()
_TOKEN_TTL = 30 * 24 * 3600  # 30 days
_PBKDF2_ROUNDS = 200_000
_AUTH_USERS = ("ceo", "cto", "coo", "cio")


def _hash_pw(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), _PBKDF2_ROUNDS).hex()


def _make_token(username: str) -> str:
    body = f"{username}|{int(time.time()) + _TOKEN_TTL}".encode()
    sig = hmac.new(_SESSION_SECRET, body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body + b"|" + sig).decode()


def _verify_token(token: str | None) -> str | None:
    """Return the username if the token's signature is valid and unexpired, else None."""
    if not token:
        return None
    try:
        raw = base64.urlsafe_b64decode(token.encode())
        body, sig = raw.rsplit(b"|", 1)
        if not hmac.compare_digest(sig, hmac.new(_SESSION_SECRET, body, hashlib.sha256).digest()):
            return None
        username, exp = body.decode().split("|")
        return username if int(exp) >= int(time.time()) else None
    except Exception:  # noqa: BLE001
        return None


async def _seed_auth() -> None:
    """Set each owner's password hash from AUTH_<ROLE>_PASSWORD (if present) at startup.
    The env file is the source of truth for passwords; plaintext is hashed here and never
    stored/logged. Missing env → that account keeps whatever hash it had (NULL first run)."""
    for role in _AUTH_USERS:
        pw = os.environ.get(f"AUTH_{role.upper()}_PASSWORD")
        if pw:
            salt = secrets.token_hex(16)
            await ex(
                f"UPDATE company.users SET password_hash={db.lit(_hash_pw(pw, salt))}, "
                f"salt={db.lit(salt)} WHERE username={db.lit(role)}"
            )


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    """Gate every /api/* route behind a valid session, except the auth + health endpoints
    (and the static FE + /ws office stream, which aren't under /api)."""
    path = request.url.path
    if path.startswith("/api/") and not path.startswith("/api/auth/") and path != "/api/health":
        if not _verify_token(request.cookies.get("session")):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.post("/api/auth/login")
async def auth_login(response: Response, payload: dict = Body(...)):
    username = str(payload.get("username") or "").strip().lower()
    password = str(payload.get("password") or "")
    row = await q(
        "SELECT json_build_object('username',username,'displayName',display_name,'role',role,"
        f"'hash',password_hash,'salt',salt) FROM company.users WHERE username={db.lit(username)}"
    )
    if not row:
        raise HTTPException(401, "sai tài khoản hoặc mật khẩu")
    if not row.get("hash") or not row.get("salt"):
        raise HTTPException(
            403,
            f"tài khoản '{username}' chưa đặt mật khẩu — thêm AUTH_{username.upper()}_PASSWORD vào "
            "company/.env.local rồi khởi động lại backend",
        )
    if not hmac.compare_digest(_hash_pw(password, row["salt"]), row["hash"]):
        raise HTTPException(401, "sai tài khoản hoặc mật khẩu")
    await ex(f"UPDATE company.users SET last_login=now() WHERE username={db.lit(username)}")
    response.set_cookie("session", _make_token(username), httponly=True, samesite="lax",
                        max_age=_TOKEN_TTL, path="/")
    return {"ok": True, "user": {"username": row["username"], "displayName": row["displayName"], "role": row["role"]}}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie("session", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    username = _verify_token(request.cookies.get("session"))
    if not username:
        raise HTTPException(401, "chưa đăng nhập")
    row = await q(
        "SELECT json_build_object('username',username,'displayName',display_name,'role',role) "
        f"FROM company.users WHERE username={db.lit(username)}"
    )
    if not row:
        raise HTTPException(401, "phiên không hợp lệ")
    return row


@app.get("/api/users")
async def users_list():
    """The 3 owner accounts — for the Nhân sự "Ban điều hành" cards (requires a session)."""
    return await q(
        "SELECT coalesce(json_agg(json_build_object("
        "'username',username,'displayName',display_name,'role',role,"
        "'lastLogin',to_char(last_login,'YYYY-MM-DD HH24:MI')) ORDER BY username),'[]') FROM company.users"
    ) or []


# ---- REST: live data ----
@app.get("/api/health")
async def health():
    return {"ok": True, "clients": len(hub.clients), "cursor": cursor}


# ---- FX: live USD↔VND rate from free, no-key public APIs (server-side to dodge CORS,
# cached per source). The FE toggles the whole UI's currency using this. ------------
_FX_FALLBACK = 25400.0  # matches the FE's offline constant
_FX_TTL_S = 3600  # FX moves slowly; one fetch/hour/source is plenty
_FX_CACHE: dict[str, dict] = {}  # source -> {usdVnd, asOf, ts}
_FX_SOURCES = {
    "open-er-api": "open.er-api.com",
    "vietcombank": "Vietcombank (giá bán)",
    "fawaz": "fawazahmed0",
}


def _fetch_fx(source: str) -> dict:
    """Blocking HTTP GET (run in a thread). Returns {usdVnd, asOf}."""
    import urllib.request

    def _get(url: str):
        req = urllib.request.Request(url, headers={"User-Agent": "agency-agents/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)

    if source == "open-er-api":
        d = _get("https://open.er-api.com/v6/latest/USD")
        return {"usdVnd": float(d["rates"]["VND"]), "asOf": d.get("time_last_update_utc")}
    if source == "vietcombank":
        d = _get("https://www.vietcombank.com.vn/api/exchangerates?date=now")
        usd = next(x for x in d["Data"] if x.get("currencyCode") == "USD")
        return {"usdVnd": float(usd["sell"]), "asOf": d.get("UpdatedDate")}
    if source == "fawaz":
        d = _get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json")
        return {"usdVnd": float(d["usd"]["vnd"]), "asOf": d.get("date")}
    raise ValueError(f"unknown fx source {source}")


@app.get("/api/fx")
async def get_fx(source: str = "open-er-api"):
    if source not in _FX_SOURCES:
        source = "open-er-api"
    now = time.time()
    cached = _FX_CACHE.get(source)
    if cached and now - cached["ts"] < _FX_TTL_S:
        return {"source": source, "label": _FX_SOURCES[source], "usdVnd": cached["usdVnd"], "asOf": cached["asOf"], "cached": True}
    try:
        got = await asyncio.to_thread(_fetch_fx, source)
        _FX_CACHE[source] = {**got, "ts": now}
        return {"source": source, "label": _FX_SOURCES[source], "usdVnd": got["usdVnd"], "asOf": got["asOf"], "cached": False}
    except Exception as e:  # noqa: BLE001
        print(f"[fx] {source} error:", e)
        if cached:  # serve stale over nothing
            return {"source": source, "label": _FX_SOURCES[source], "usdVnd": cached["usdVnd"], "asOf": cached["asOf"], "stale": True}
        return {"source": source, "label": _FX_SOURCES[source], "usdVnd": _FX_FALLBACK, "asOf": None, "fallback": True}


@app.get("/api/fx/sources")
async def get_fx_sources():
    return [{"id": k, "label": v} for k, v in _FX_SOURCES.items()]


@app.get("/api/workspace")
async def workspace():
    return await q(queries.WORKSPACE_SQL)


@app.get("/api/decisions")
async def decisions():
    return await q(queries.DECISIONS_SQL)


@app.post("/api/decisions/{did}/decide")
async def decide_decision(did: str, payload: dict = Body(...)):
    """CEO/CTO submits a ruling → mark the decision decided, then TRIGGER the agent that
    raised it to CONTINUE, in the group it was raised from (fallback: the open company
    channel). The agent reads the ruling in context and proceeds with the remaining work."""
    ruling = str(payload.get("ruling") or "").strip()
    option = str(payload.get("option") or "").strip()  # optional label of the chosen option
    if not ruling:
        raise HTTPException(400, "cần nội dung quyết định")
    row = await q(
        "SELECT json_build_object('raisedBy',raised_by,'title',title,'status',status,'origin',origin_channel) "
        f"FROM company.decisions WHERE id={db.lit(did)}"
    )
    if not row:
        raise HTTPException(404, f"decision '{did}' not found")
    if row.get("status") == "decided":
        raise HTTPException(400, "quyết định này đã được chốt rồi")
    full_ruling = (f"Chọn: {option}\n{ruling}" if option else ruling)[:4000]
    await ex(
        f"UPDATE company.decisions SET status='decided', ruling={db.lit(full_ruling)}, decided_at=now() "
        f"WHERE id={db.lit(did)}"
    )
    raised = row.get("raisedBy")
    replying, chan = False, None
    if raised and await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(raised)} AND hired") == "1":
        chan = row.get("origin")
        if not chan or await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(chan)} AND NOT archived") != "1":
            chan = "ch-general"  # decision predates origin_channel, or its group is gone
        body = (
            f"✅ **CEO/CTO đã quyết định — {did}: {row.get('title')}**\n\n{full_ruling}\n\n"
            "→ Hãy TIẾP TỤC xử lý theo quyết định này (làm các bước còn lại, tạo ticket/tài liệu nếu cần)."
        )
        await ex(
            "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
            f"VALUES ({db.lit(chan)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(chan)}), "
            f"NULL, {db.lit(raised)}, 'chat', {db.lit(body[:8000])})"
        )
        asyncio.create_task(respond_as_agent(chan, str(raised)))
        replying = True
    return {"ok": True, "id": did, "status": "decided", "ruling": full_ruling, "replying": replying, "channel": chan}


@app.post("/api/decisions/{did}/cancel")
async def cancel_decision(did: str, payload: dict = Body(...)):
    """CEO/CTO CANCELS a pending decision (drops it instead of ruling on it), with an
    optional note. Unlike /decide this does NOT trigger the raiser to continue — the
    work tied to the decision is dropped — but it posts the cancellation into the group
    it came from so the raising agent has it on record (and the office animates it)."""
    note = str(payload.get("message") or "").strip()[:2000]
    row = await q(
        "SELECT json_build_object('raisedBy',raised_by,'title',title,'status',status,'origin',origin_channel) "
        f"FROM company.decisions WHERE id={db.lit(did)}"
    )
    if not row:
        raise HTTPException(404, f"decision '{did}' not found")
    if row.get("status") in ("decided", "cancelled"):
        raise HTTPException(400, "quyết định này đã được xử lý rồi (đã chốt hoặc đã huỷ)")
    # Cancelled rows may carry a note in `ruling` (the decided_has_ruling CHECK only
    # applies to status='decided', so a NULL ruling here is legal).
    await ex(
        f"UPDATE company.decisions SET status='cancelled', "
        f"ruling={db.lit(note) if note else 'ruling'}, decided_at=now() WHERE id={db.lit(did)}"
    )
    raised = row.get("raisedBy")
    notified, chan = False, None
    if raised and await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(raised)} AND hired") == "1":
        chan = row.get("origin")
        if not chan or await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(chan)} AND NOT archived") != "1":
            chan = "ch-general"
        body = (
            f"⛔ **CEO/CTO đã HUỶ quyết định — {did}: {row.get('title')}**"
            + (f"\n\n{note}" if note else "")
            + "\n\n→ Không cần xử lý tiếp phần phụ thuộc quyết định này nữa."
        )
        await ex(
            "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
            f"VALUES ({db.lit(chan)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(chan)}), "
            f"NULL, {db.lit(raised)}, 'note', {db.lit(body[:8000])})"
        )
        notified = True
    return {"ok": True, "id": did, "status": "cancelled", "note": note, "notified": notified, "channel": chan}


# ---- Goals (Mục tiêu): objective cards + virtual-revenue vs real-cost P&L -----
@app.get("/api/goals")
async def goals():
    """Objective cards agents must finish, each with a VIRTUAL revenue figure, plus a
    profit/loss summary: virtual revenue EARNED (done goals) vs the REAL LLM cost to
    date (company.usage_costed). Revenue is simulated; cost is metered from real usage."""
    data = await q(
        """
      SELECT json_build_object(
        'goals', (SELECT coalesce(json_agg(t.g ORDER BY t.ord, t.id), '[]'::json) FROM (
          SELECT go.id AS id,
            CASE go.status WHEN 'at_risk' THEN 0 WHEN 'in_progress' THEN 1
                           WHEN 'todo' THEN 2 ELSE 3 END AS ord,
            json_build_object(
              'id', go.id, 'title', go.title, 'description', go.description,
              'owner', go.owner, 'ownerName', coalesce(ag.name, go.owner),
              'ownerEmoji', ag.emoji, 'ownerDivision', ag.division,
              'status', go.status, 'progress', go.progress,
              'revenueUsd', go.revenue_usd::float8,
              'targetDate', to_char(go.target_date, 'YYYY-MM-DD')
            ) AS g
          FROM company.goals go
          LEFT JOIN company.agents ag ON ag.slug = go.owner
        ) t),
        'finance', json_build_object(
          'revenueEarned',   (SELECT coalesce(sum(revenue_usd),0)::float8 FROM company.goals WHERE status='done'),
          'revenuePipeline', (SELECT coalesce(sum(revenue_usd),0)::float8 FROM company.goals WHERE status<>'done'),
          'revenueTotal',    (SELECT coalesce(sum(revenue_usd),0)::float8 FROM company.goals),
          'goalsDone',       (SELECT count(*) FROM company.goals WHERE status='done'),
          'goalsTotal',      (SELECT count(*) FROM company.goals)
        ),
        'agents', (SELECT coalesce(json_agg(json_build_object(
            'slug', slug, 'name', name, 'emoji', emoji, 'division', division
          ) ORDER BY name), '[]'::json) FROM company.agents WHERE hired)
      )
    """
    )
    cost = await scalar(
        "SELECT round(coalesce(sum(cost_usd),0)::numeric,2) FROM company.usage_costed "
        "WHERE NOT coalesce(is_sample,false)"
    )
    infra = await scalar("SELECT round(coalesce(sum(est_monthly_usd),0)::numeric,2) FROM company.infra_pricing")
    fin = data.get("finance", {})
    earned = float(fin.get("revenueEarned") or 0)
    llm_cost = float(cost or 0)          # real LLM usage cost, to-date
    infra_cost = float(infra or 0)       # estimated infra cost, per month
    total_cost = round(llm_cost + infra_cost, 2)  # real cost = LLM + infra
    fin["llmCostUsd"] = round(llm_cost, 2)
    fin["infraMonthlyUsd"] = round(infra_cost, 2)
    fin["costToDate"] = total_cost
    fin["netRealized"] = round(earned - total_cost, 2)
    fin["profitable"] = earned >= total_cost
    fin["marginPct"] = round((earned - total_cost) / earned * 100, 1) if earned else None
    return data


_GOAL_STATUSES = ("todo", "in_progress", "done", "at_risk")


async def _goal_fields(payload: dict) -> dict:
    """Validate + normalise an editable goal payload (shared by create/update)."""
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "tiêu đề không được rỗng")
    status = str(payload.get("status") or "todo").strip()
    if status not in _GOAL_STATUSES:
        raise HTTPException(400, f"status phải thuộc {_GOAL_STATUSES}")
    try:
        progress = max(0, min(100, int(payload.get("progress") or 0)))
    except (TypeError, ValueError):
        raise HTTPException(400, "progress phải là số 0–100")
    try:
        revenue = max(0.0, float(payload.get("revenueUsd") or 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "doanh thu phải là số")
    owner = (str(payload.get("owner") or "").strip()) or None
    if owner and await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(owner)} AND hired") != "1":
        raise HTTPException(400, f"'{owner}' không phải agent đang trong biên chế")
    target = (str(payload.get("targetDate") or "").strip()) or None
    if target and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", target):
        raise HTTPException(400, "hạn chót phải dạng YYYY-MM-DD")
    return {
        "title": title, "description": (str(payload.get("description") or "").strip() or None),
        "owner": owner, "status": status, "progress": progress, "revenue": revenue, "target": target,
    }


@app.post("/api/goals")
async def create_goal(payload: dict = Body(...)):
    """CEO/CTO adds a new objective card."""
    g = await _goal_fields(payload)
    gid = "G-" + str(
        int(await scalar("SELECT coalesce(max(substring(id from '[0-9]+$')::int),0)+1 "
                         "FROM company.goals WHERE id ~ '[0-9]+$'") or "1")
    )
    tgt = f"{db.lit(g['target'])}::date" if g["target"] else "NULL"
    await ex(
        "INSERT INTO company.goals (id,title,description,owner,status,progress,revenue_usd,target_date) VALUES ("
        f"{db.lit(gid)}, {db.lit(g['title'])}, {db.lit(g['description'])}, {db.lit(g['owner'])}, "
        f"{db.lit(g['status'])}, {g['progress']}, {g['revenue']}, {tgt})"
    )
    return {"ok": True, "id": gid}


@app.post("/api/goals/{gid}")
async def update_goal(gid: str, payload: dict = Body(...)):
    """CEO/CTO edits an objective card's content."""
    if await scalar(f"SELECT 1 FROM company.goals WHERE id={db.lit(gid)}") != "1":
        raise HTTPException(404, f"goal '{gid}' not found")
    g = await _goal_fields(payload)
    tgt = f"{db.lit(g['target'])}::date" if g["target"] else "NULL"
    await ex(
        f"UPDATE company.goals SET title={db.lit(g['title'])}, description={db.lit(g['description'])}, "
        f"owner={db.lit(g['owner'])}, status={db.lit(g['status'])}, progress={g['progress']}, "
        f"revenue_usd={g['revenue']}, target_date={tgt} WHERE id={db.lit(gid)}"
    )
    return {"ok": True, "id": gid}


@app.delete("/api/goals/{gid}")
async def delete_goal(gid: str):
    """CEO/CTO removes an objective card."""
    if await scalar(f"SELECT 1 FROM company.goals WHERE id={db.lit(gid)}") != "1":
        raise HTTPException(404, f"goal '{gid}' not found")
    await ex(f"DELETE FROM company.goals WHERE id={db.lit(gid)}")
    return {"ok": True, "id": gid}


# ---- Task board: owner drag-drop status change -------------------------------
@app.post("/api/tasks/{tid}/status")
async def set_task_status(tid: str, payload: dict = Body(...)):
    """CEO/CTO changes a task's status from the board (drag-drop). Mirrors the agent
    tool: writes an append-only status_events row and bumps `attempt` toward the NEXUS
    3-try cap when a ticket enters `rejected`. Cancelling requires a reason."""
    status = str(payload.get("status") or "").strip()
    reason = (str(payload.get("reason") or "").strip() or None)
    if status not in _TASK_STATUSES:
        raise HTTPException(400, f"status phải thuộc {_TASK_STATUSES}")
    if status == "cancelled" and not reason:
        raise HTTPException(400, "huỷ task bắt buộc kèm lý do")
    cur = await q(
        f"SELECT json_build_object('status',status,'attempt',attempt) FROM company.tasks WHERE id={db.lit(tid)}"
    )
    if not cur:
        raise HTTPException(404, f"task '{tid}' not found")
    if cur["status"] == status:
        return {"ok": True, "id": tid, "status": status, "changed": False}
    attempt = min(cur["attempt"] + 1, 3) if status == "rejected" else cur["attempt"]
    note = reason or "Kéo-thả trạng thái bởi CEO/CTO"
    await ex(
        f"UPDATE company.tasks SET status={db.lit(status)}, attempt={attempt}, updated_at=now() WHERE id={db.lit(tid)};\n"
        "INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason) "
        f"VALUES ('task', {db.lit(tid)}, {db.lit(cur['status'])}, {db.lit(status)}, 'owner', {db.lit(note)});"
    )
    if status == "cancelled":  # owner author = NULL (task_comments.agent FK), keep the reason visible
        await ex(
            "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
            f"VALUES ({db.lit(tid)}, NULL, {db.lit('⛔ **Huỷ task** — lý do: ' + note)}, ARRAY[]::text[])"
        )
    return {"ok": True, "id": tid, "from": cur["status"], "status": status, "attempt": attempt, "changed": True}


# ---- Infra cost + config (Monitor drawer) ----------------------------------
@app.get("/api/infra")
async def infra_list():
    """Infra components with cost + tunable config, for the Monitor 'Chi phí hạ tầng' table
    and its per-component drawer."""
    return await q(
        "SELECT coalesce(json_agg(json_build_object("
        "'key',key,'service',service,'spec',spec,'monthlyUsd',est_monthly_usd::float8,"
        "'note',note,'config',config,'lastDeployAt',to_char(last_deploy_at,'YYYY-MM-DD HH24:MI')) "
        "ORDER BY sort,key),'[]') FROM company.infra_pricing"
    ) or []


@app.post("/api/infra/{key}")
async def infra_update(key: str, payload: dict = Body(...)):
    """Save the owner's edits to a component (spec / monthly estimate / note / config)."""
    if await scalar(f"SELECT 1 FROM company.infra_pricing WHERE key={db.lit(key)}") != "1":
        raise HTTPException(404, f"infra '{key}' không tồn tại")
    spec = str(payload.get("spec") or "").strip() or None
    note = str(payload.get("note") or "").strip() or None
    try:
        monthly = max(0.0, float(payload.get("monthlyUsd") or 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "monthlyUsd phải là số")
    config = payload.get("config")
    if not isinstance(config, dict):
        config = {}
    await ex(
        f"UPDATE company.infra_pricing SET spec={db.lit(spec)}, note={db.lit(note)}, "
        f"est_monthly_usd={monthly}, config={db.lit(json.dumps(config))}::jsonb WHERE key={db.lit(key)}"
    )
    return {"ok": True, "key": key}


@app.post("/api/infra/{key}/deploy")
async def infra_deploy(key: str, payload: dict = Body(...)):
    """Record a redeploy intent and RETURN the exact terraform command to run. The console
    does NOT run terraform (no AWS creds in the app, and infra apply is a privileged,
    hard-to-reverse op) — it hands the owner a ready-to-paste command, same as the
    decision-record / runtime-assignment copy patterns elsewhere."""
    row = await q(
        f"SELECT json_build_object('service',service,'config',config) FROM company.infra_pricing WHERE key={db.lit(key)}"
    )
    if not row:
        raise HTTPException(404, f"infra '{key}' không tồn tại")
    config = row.get("config") or {}
    # config keys mirror infra/variables.tf — emit matching -var flags (numbers unquoted).
    var_flags = [
        (f"-var={k}={v}" if isinstance(v, (int, float)) else f"-var='{k}={v}'")
        for k, v in config.items()
    ]
    cmd = "cd infra && terraform apply" + ("".join(f" \\\n  {f}" for f in var_flags) if var_flags else "")
    await ex(f"UPDATE company.infra_pricing SET last_deploy_at=now() WHERE key={db.lit(key)}")
    return {
        "ok": True,
        "key": key,
        "service": row.get("service"),
        "command": cmd,
        "note": "Console không tự chạy terraform (thao tác hạ tầng đặc quyền). Copy lệnh này chạy trong thư mục infra/.",
    }


# ---- Investments (Investment tab): owner-declared positions → REAL company revenue ----
_ASSET_TYPES = ("stock", "etf", "crypto", "bond", "fund", "other")


async def _investment_fields(payload: dict) -> dict:
    symbol = str(payload.get("symbol") or "").strip().upper()[:20]
    if not symbol:
        raise HTTPException(400, "cần mã (symbol)")
    asset = str(payload.get("assetType") or "stock").strip().lower()
    if asset not in _ASSET_TYPES:
        asset = "stock"
    try:
        qty = float(payload.get("quantity") or 0)
        buy = float(payload.get("buyPrice") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "quantity / buyPrice phải là số")
    if qty <= 0:
        raise HTTPException(400, "quantity phải > 0")
    if buy < 0:
        raise HTTPException(400, "buyPrice phải ≥ 0")
    sell_raw = payload.get("sellPrice")
    sell = None
    if sell_raw not in (None, ""):
        try:
            sell = float(sell_raw)
        except (TypeError, ValueError):
            raise HTTPException(400, "sellPrice phải là số")
        if sell < 0:
            raise HTTPException(400, "sellPrice phải ≥ 0")
    dates = {}
    for key in ("buyDate", "sellDate"):
        d = str(payload.get(key) or "").strip() or None
        if d and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            raise HTTPException(400, f"{key} phải dạng YYYY-MM-DD")
        dates[key] = d
    return {
        "symbol": symbol, "name": (str(payload.get("name") or "").strip() or None),
        "asset": asset, "qty": qty, "buy": buy, "sell": sell,
        "buy_date": dates["buyDate"], "sell_date": dates["sellDate"],
        "note": (str(payload.get("note") or "").strip() or None),
    }


@app.get("/api/investments")
async def investments_list():
    """Owner-declared positions + the company's REAL realized revenue (Σ (sell−buy)×qty over
    sold positions). Read-only shape used by the Investment tab and the view_db tool."""
    return await q(
        """
      SELECT json_build_object(
        'items', (SELECT coalesce(json_agg(json_build_object(
            'id', i.id, 'owner', i.owner, 'ownerName', coalesce(u.display_name, i.owner),
            'symbol', i.symbol, 'name', i.name, 'assetType', i.asset_type,
            'quantity', i.quantity::float8, 'buyPrice', i.buy_price::float8,
            'sellPrice', i.sell_price::float8, 'buyDate', to_char(i.buy_date,'YYYY-MM-DD'),
            'sellDate', to_char(i.sell_date,'YYYY-MM-DD'), 'note', i.note,
            'investedUsd', (i.buy_price * i.quantity)::float8,
            'realizedUsd', CASE WHEN i.sell_price IS NOT NULL
                                THEN ((i.sell_price - i.buy_price) * i.quantity)::float8 END,
            'sold', i.sell_price IS NOT NULL)
          ORDER BY (i.sell_price IS NULL) DESC, i.sell_date DESC NULLS LAST, i.id), '[]'::json)
          FROM company.investments i LEFT JOIN company.users u ON u.username = i.owner),
        'summary', json_build_object(
          'realizedRevenueUsd', (SELECT coalesce(sum((sell_price - buy_price) * quantity),0)::float8
                                 FROM company.investments WHERE sell_price IS NOT NULL),
          'investedUsd',        (SELECT coalesce(sum(buy_price * quantity),0)::float8 FROM company.investments),
          'openInvestedUsd',    (SELECT coalesce(sum(buy_price * quantity),0)::float8
                                 FROM company.investments WHERE sell_price IS NULL),
          'positions',          (SELECT count(*) FROM company.investments),
          'openPositions',      (SELECT count(*) FROM company.investments WHERE sell_price IS NULL),
          'soldPositions',      (SELECT count(*) FROM company.investments WHERE sell_price IS NOT NULL))
      )
    """
    )


@app.post("/api/investments")
async def investment_create(request: Request, payload: dict = Body(...)):
    """An owner (CEO/CTO/COO) declares one of their own positions."""
    owner = _verify_token(request.cookies.get("session"))
    if owner not in _OWNER_SLUGS:
        raise HTTPException(403, "chỉ CEO/CTO/COO khai báo được đầu tư")
    f = await _investment_fields(payload)
    iid = "INV-" + str(
        int(await scalar("SELECT coalesce(max(substring(id from '[0-9]+$')::int),0)+1 "
                         "FROM company.investments WHERE id ~ '[0-9]+$'") or "1")
    )
    bd = f"{db.lit(f['buy_date'])}::date" if f["buy_date"] else "NULL"
    sd = f"{db.lit(f['sell_date'])}::date" if f["sell_date"] else "NULL"
    await ex(
        "INSERT INTO company.investments (id,owner,symbol,name,asset_type,quantity,buy_price,sell_price,buy_date,sell_date,note) "
        f"VALUES ({db.lit(iid)}, {db.lit(owner)}, {db.lit(f['symbol'])}, {db.lit(f['name'])}, {db.lit(f['asset'])}, "
        f"{f['qty']}, {f['buy']}, {f['sell'] if f['sell'] is not None else 'NULL'}, {bd}, {sd}, {db.lit(f['note'])})"
    )
    return {"ok": True, "id": iid}


@app.post("/api/investments/{iid}")
async def investment_update(iid: str, payload: dict = Body(...)):
    if await scalar(f"SELECT 1 FROM company.investments WHERE id={db.lit(iid)}") != "1":
        raise HTTPException(404, f"đầu tư '{iid}' không tồn tại")
    f = await _investment_fields(payload)
    bd = f"{db.lit(f['buy_date'])}::date" if f["buy_date"] else "NULL"
    sd = f"{db.lit(f['sell_date'])}::date" if f["sell_date"] else "NULL"
    await ex(
        f"UPDATE company.investments SET symbol={db.lit(f['symbol'])}, name={db.lit(f['name'])}, "
        f"asset_type={db.lit(f['asset'])}, quantity={f['qty']}, buy_price={f['buy']}, "
        f"sell_price={f['sell'] if f['sell'] is not None else 'NULL'}, buy_date={bd}, sell_date={sd}, "
        f"note={db.lit(f['note'])}, updated_at=now() WHERE id={db.lit(iid)}"
    )
    return {"ok": True, "id": iid}


@app.delete("/api/investments/{iid}")
async def investment_delete(iid: str):
    n = await scalar(
        f"WITH d AS (DELETE FROM company.investments WHERE id={db.lit(iid)} RETURNING 1) SELECT count(*)::text FROM d"
    )
    if int(n or 0) == 0:
        raise HTTPException(404, f"đầu tư '{iid}' không tồn tại")
    return {"ok": True, "id": iid}


# ---- Recruitment (Tuyển dụng): owner-approved hiring pipeline ----------------
def _pg_text_array(items: list) -> str:
    if not items:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ", ".join(db.lit(str(i)) for i in items) + "]::text[]"


def _hire_into_roster(slug: str, group: str | None, why: str | None) -> None:
    """Add an agent to company/roster.json 'hired' — the durable source of truth that
    survives `npm run data`. Preserves the file's other keys (reformats with indent=2)."""
    path = ROOT / "company" / "roster.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("hired", {})[slug] = {"group": group or "", "why": (why or "")[:300]}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@app.get("/api/recruitment")
async def recruitment():
    cands = await q(
        "SELECT coalesce(json_agg(json_build_object("
        "'id',id,'sourceSlug',source_slug,'name',name,'division',division,'hireGroup',hire_group,"
        "'brief',brief,'skills',skills,'provider',provider,'model',model,"
        "'requestedPermissions',requested_permissions,'grantedPermissions',granted_permissions,"
        "'proposedBy',proposed_by,'status',status,"
        "'decidedAt',to_char(decided_at,'YYYY-MM-DD HH24:MI')) ORDER BY id),'[]') "
        "FROM company.hire_candidates"
    ) or []
    providers = [{"id": pid, "label": p["label"],
                  "models": [{"id": m["id"], "label": m["label"]} for m in p["models"]]}
                 for pid, p in PROVIDERS.items()]
    return {"candidates": cands, "permissions": await _perm_catalog(), "providers": providers}


@app.post("/api/recruitment/{cid}/approve")
async def recruitment_approve(cid: str, payload: dict = Body(...)):
    """CEO/CTO approves a hire (with any edits + the permissions they ticked). Executes the
    hire for a catalogue agent: roster.json + company.agents.hired + runtime + granted perms."""
    row = await q(
        "SELECT json_build_object('sourceSlug',source_slug,'status',status) "
        f"FROM company.hire_candidates WHERE id={db.lit(cid)}"
    )
    if not row:
        raise HTTPException(404, f"ứng viên '{cid}' không tồn tại")
    if row.get("status") != "proposed":
        raise HTTPException(400, "ứng viên này đã được xử lý")
    name = str(payload.get("name") or "").strip()
    division = str(payload.get("division") or "specialized").strip()
    group = (payload.get("hireGroup") or None) and str(payload["hireGroup"]).strip()
    brief = str(payload.get("brief") or "")[:2000]
    skills = [str(s) for s in (payload.get("skills") or []) if isinstance(s, str)]
    provider = str(payload.get("provider") or "claude")
    model = str(payload.get("model") or "sonnet")
    valid_perm = {p["key"] for p in await _perm_catalog()}
    granted = [str(p) for p in (payload.get("grantedPermissions") or []) if str(p) in valid_perm]
    src = row.get("sourceSlug")
    await ex(
        f"UPDATE company.hire_candidates SET name={db.lit(name)}, division={db.lit(division)}, "
        f"hire_group={db.lit(group)}, brief={db.lit(brief)}, skills={_pg_text_array(skills)}, "
        f"provider={db.lit(provider)}, model={db.lit(model)}, granted_permissions={_pg_text_array(granted)}, "
        f"status='approved', decided_at=now() WHERE id={db.lit(cid)}"
    )
    hired = False
    if src and await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(src)}") == "1":
        try:
            _hire_into_roster(src, group, brief)  # durable
        except Exception as e:  # noqa: BLE001
            print("[api] roster write error:", e)
        await ex(f"UPDATE company.agents SET hired=true WHERE slug={db.lit(src)}")  # immediate
        await ex(
            "INSERT INTO company.agent_runtime (slug, provider, model) "
            f"VALUES ({db.lit(src)}, {db.lit(provider)}, {db.lit(model)}) "
            "ON CONFLICT (slug) DO UPDATE SET provider=excluded.provider, model=excluded.model"
        )
        if granted:
            vals = ", ".join(f"({db.lit(src)}, {db.lit(p)}, NULL)" for p in granted)
            await ex(f"INSERT INTO company.agent_permissions (agent, permission, granted_by) VALUES {vals} ON CONFLICT DO NOTHING")
        hired = True
    return {
        "ok": True, "id": cid, "status": "approved", "hired": hired, "slug": src,
        "note": None if hired
        else "Persona MỚI (chưa có file agent) — cần orchestrator/Claude Code tạo file .md rồi npm run data để cài.",
    }


@app.post("/api/recruitment/{cid}/reject")
async def recruitment_reject(cid: str):
    st = await scalar(f"SELECT status FROM company.hire_candidates WHERE id={db.lit(cid)}")
    if not st:
        raise HTTPException(404, f"ứng viên '{cid}' không tồn tại")
    if st != "proposed":
        raise HTTPException(400, "ứng viên này đã được xử lý")
    await ex(f"UPDATE company.hire_candidates SET status='rejected', decided_at=now() WHERE id={db.lit(cid)}")
    return {"ok": True, "id": cid, "status": "rejected"}


@app.get("/api/monitor")
async def monitor():
    return await q(queries.MONITOR_SQL)


@app.get("/api/budget")
async def budget_get():
    await _refresh_budget()
    return dict(_budget)


@app.post("/api/budget")
async def budget_set(payload: dict = Body(...)):
    ceiling = float(payload.get("ceilingUsd") or _budget["ceiling"])
    warn = float(payload.get("warnUsd") or round(ceiling * 0.8, 4))
    if warn > ceiling:
        warn = ceiling
    if ceiling <= 0:
        raise HTTPException(400, "trần phải > 0")
    await _set_cfg("budget", {"ceilingUsd": ceiling, "warnUsd": warn})
    await _refresh_budget()
    return {"ok": True, **_budget}


@app.post("/api/worker/pause")
async def worker_pause(payload: dict = Body(default={})):
    reason = str((payload or {}).get("reason") or "Dừng khẩn cấp bởi CEO/CTO")
    await _set_cfg("worker_paused", {"paused": True, "reason": reason})
    await _refresh_budget()
    return {"ok": True, "paused": True, "reason": reason}


@app.post("/api/worker/resume")
async def worker_resume():
    await _set_cfg("worker_paused", {"paused": False, "reason": None})
    _budget["warned"] = False
    await _refresh_budget()
    return {"ok": True, "paused": False}


@app.get("/api/model-timeouts")
async def model_timeouts_get():
    await _refresh_budget()
    return {"timeouts": _timeouts, "models": list(_DEFAULT_TIMEOUTS.keys())}


@app.post("/api/model-timeouts")
async def model_timeouts_set(payload: dict = Body(...)):
    incoming = payload.get("timeouts") or {}
    clean = {k: float(v) for k, v in incoming.items() if str(v).replace(".", "", 1).isdigit() and float(v) > 0}
    merged = {**_timeouts, **clean}
    await _set_cfg("model_timeouts", merged)
    _timeouts.update(merged)
    return {"ok": True, "timeouts": _timeouts}


@app.get("/api/agent-learnings/{slug}")
async def agent_learnings(slug: str):
    """What one agent has learned (self-recorded skills/lessons + CEO/CTO reminders).
    Read-only view for the Nhân sự drawer; agents write via the record_learning tool."""
    return await q(
        "SELECT coalesce(json_agg(json_build_object('id',id,'kind',kind,'source',source,"
        "'content',content,'taskId',task_id,'createdAt',created_at) ORDER BY id DESC),'[]') "
        f"FROM company.agent_learnings WHERE agent={db.lit(slug)}"
    )


@app.get("/api/docs")
async def docs():
    """Knowledge base for the Documents tab: folders + files WITH content (docs are
    text, one fetch keeps the tab live like the others)."""
    return await q(
        "SELECT json_build_object("
        "'folders',(SELECT coalesce(json_agg(json_build_object("
        "  'path',path,'description',description,'createdBy',created_by) ORDER BY path),'[]') FROM company.doc_folders),"
        "'files',(SELECT coalesce(json_agg(json_build_object("
        "  'id',id,'folder',folder,'name',name,'format',format,'content',content,'author',author,"
        "  'engagementId',engagement_id,'createdAt',created_at,'updatedAt',updated_at) ORDER BY folder,name),'[]') "
        "  FROM company.documents))"
    )


_DOC_FORMATS = ("markdown", "mermaid", "ppt", "text", "json", "code", "csv", "html")


def _doc_payload(payload: dict) -> tuple[str, str, str, str]:
    folder = str(payload.get("folder") or "").strip().strip("/")
    name = str(payload.get("name") or "").strip()
    fmt = str(payload.get("format") or "markdown").strip().lower()
    content = str(payload.get("content") or "")
    if fmt not in _DOC_FORMATS:
        fmt = "markdown"
    return folder[:200], name[:200], fmt, content[:200000]


@app.post("/api/docs")
async def doc_create(payload: dict = Body(...)):
    """CEO/CTO creates or uploads a document (create-or-update on folder+name).
    Owner-authored → author NULL (documents.author FKs agents; the owner isn't one)."""
    folder, name, fmt, content = _doc_payload(payload)
    if not folder or not name:
        raise HTTPException(400, "cần folder + name")
    await ex(
        f"INSERT INTO company.doc_folders (path, created_by) VALUES ({db.lit(folder)}, NULL) "
        "ON CONFLICT (path) DO NOTHING"
    )
    row = await q(
        "INSERT INTO company.documents (folder, name, format, content, author) "
        f"VALUES ({db.lit(folder)}, {db.lit(name)}, {db.lit(fmt)}, {db.lit(content)}, NULL) "
        "ON CONFLICT (folder, name) DO UPDATE SET content=EXCLUDED.content, format=EXCLUDED.format, "
        "updated_at=now() RETURNING json_build_object('id',id)"
    )
    return {"ok": True, "id": (row or {}).get("id")}


@app.patch("/api/docs/{doc_id}")
async def doc_update(doc_id: int, payload: dict = Body(...)):
    """CEO/CTO edits a document (content/format, and optionally rename via folder+name)."""
    cur = await q(
        "SELECT json_build_object('folder',folder,'name',name,'format',format,'content',content) "
        f"FROM company.documents WHERE id={int(doc_id)}"
    )
    if not cur:
        raise HTTPException(404, f"tài liệu '{doc_id}' không tồn tại")
    folder, name, fmt, content = _doc_payload({**cur, **payload})
    if not folder or not name:
        raise HTTPException(400, "cần folder + name")
    if (folder, name) != (cur["folder"], cur["name"]):
        clash = await scalar(
            f"SELECT 1 FROM company.documents WHERE folder={db.lit(folder)} AND name={db.lit(name)} "
            f"AND id<>{int(doc_id)}"
        )
        if clash == "1":
            raise HTTPException(400, f"đã có tài liệu '{folder}/{name}'")
    await ex(
        f"INSERT INTO company.doc_folders (path, created_by) VALUES ({db.lit(folder)}, NULL) "
        "ON CONFLICT (path) DO NOTHING"
    )
    await ex(
        f"UPDATE company.documents SET folder={db.lit(folder)}, name={db.lit(name)}, "
        f"format={db.lit(fmt)}, content={db.lit(content)}, updated_at=now() WHERE id={int(doc_id)}"
    )
    return {"ok": True, "id": doc_id}


@app.delete("/api/docs/{doc_id}")
async def doc_delete(doc_id: int):
    """CEO/CTO deletes a document."""
    n = await scalar(
        f"WITH d AS (DELETE FROM company.documents WHERE id={int(doc_id)} RETURNING 1) SELECT count(*)::text FROM d"
    )
    if int(n or 0) == 0:
        raise HTTPException(404, f"tài liệu '{doc_id}' không tồn tại")
    return {"ok": True, "deleted": int(n)}


@app.get("/api/agents")
async def agents():
    # Owner rows (is_owner) have no persona doc — exclude them from the agent directory
    # (they appear in Nhân sự via the OwnersStrip / /api/users instead).
    docs = await q(
        "SELECT coalesce(json_agg(doc ORDER BY division, name), '[]') FROM company.agents "
        "WHERE NOT coalesce(is_owner, false)"
    ) or []
    dj = json.loads((ROOT / "divisions.json").read_text(encoding="utf-8"))["divisions"]
    counts: dict[str, int] = {}
    for a in docs:
        counts[a["division"]] = counts.get(a["division"], 0) + 1
    divisions = [
        {"slug": s, "label": m["label"], "color": m["color"], "icon": m["icon"],
         "emoji": DIVISION_EMOJI.get(s, "•"), "count": counts.get(s, 0)}
        for s, m in sorted(dj.items()) if counts.get(s, 0) > 0
    ]
    hired = [a for a in docs if a.get("hired")]
    return {
        "generatedFrom": "Postgres company.agents (live via API)",
        "agents": docs,
        "divisions": divisions,
        "stats": {"agents": len(docs), "hired": len(hired),
                  "divisions": len(divisions)},
    }


# ---- REST: Team Chat (owner sends as CEO/CTO = from_agent NULL) ----
@app.get("/api/chat")
async def chat_get(request: Request):
    """Channels + messages, scoped to the logged-in owner: a group with a member list is
    visible only if this owner is a member; open channels (no members — ch-general,
    engagement channels) are visible to everyone. Like a normal chat app."""
    data = await q(queries.CHAT_SQL)
    me = _verify_token(request.cookies.get("session"))
    channels = data.get("channels", []) or []
    visible = {
        c["id"] for c in channels
        if not (c.get("members") or []) or me in (c.get("members") or [])
    }
    data["channels"] = [c for c in channels if c["id"] in visible]
    data["messages"] = [m for m in (data.get("messages") or []) if m.get("channelId") in visible]
    return data


@app.post("/api/chat/send")
async def chat_send(request: Request, payload: dict = Body(...)):
    channel = str(payload.get("channel") or "")
    body = str(payload.get("body") or "").strip()
    to_agent = payload.get("toAgent")
    kind = payload.get("kind") or "chat"
    if not channel or not body:
        raise HTTPException(400, "channel + body required")
    # Attribute this owner message to the logged-in account (CEO/CTO/COO).
    actor = _verify_token(request.cookies.get("session"))
    owner_actor = (await scalar(f"SELECT display_name FROM company.users WHERE username={db.lit(actor)}")) if actor else None
    if await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(channel)} AND NOT archived") != "1":
        raise HTTPException(404, f"channel '{channel}' not found")
    members: list[str] = await q(
        f"SELECT coalesce(json_agg(agent ORDER BY agent),'[]') FROM company.channel_members WHERE channel_id={db.lit(channel)}"
    ) or []
    # Per-owner visibility: an owner can only post to a member-group they belong to
    # (open channels with no member list stay writable by everyone).
    if members and actor not in members:
        raise HTTPException(403, "bạn không phải thành viên nhóm này")
    # '@leads' is a broadcast, not an agent row — store to_agent NULL (group message).
    broadcast = to_agent == "@leads"
    if broadcast and members and not set(LEAD_SLUGS) <= set(members):
        raise HTTPException(400, "nhóm này không có đủ Ban lãnh đạo — tag từng người hoặc gửi không tag")
    if to_agent and not broadcast and members and to_agent not in members:
        raise HTTPException(400, f"'{to_agent}' không phải thành viên nhóm này")
    stored_to = None if broadcast else to_agent
    row = await q(
        "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, owner_actor, kind, body) "
        f"VALUES ({db.lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(channel)}), "
        f"NULL, {db.lit(stored_to)}, {db.lit(owner_actor)}, {db.lit(kind)}, {db.lit(body[:8000])}) "
        "RETURNING json_build_object('id',id,'channelId',channel_id,'engagementId',engagement_id,"
        "'taskId',task_id,'fromAgent',from_agent,'toAgent',to_agent,'ownerActor',owner_actor,"
        "'kind',kind,'body',body,'createdAt',created_at)"
    )
    # Reply triggers (async, best-effort). An agent answers ONLY when explicitly tagged —
    # an untagged group message triggers NOBODY (no fan-out, so no runaway LLM cost):
    #  • '@leads'      → the leadership roster answers in order.
    #  • '@one-agent'  → that agent answers.
    replying = False
    if broadcast:
        replying = True
        asyncio.create_task(respond_as_leads(channel))
    elif to_agent and to_agent not in _OWNER_SLUGS:
        # Tagging an owner (@CEO/@CTO/@COO) notifies a human — no AI reply is generated.
        if await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(to_agent)} AND hired") == "1":
            replying = True
            asyncio.create_task(respond_as_agent(channel, str(to_agent)))
    return {"ok": True, "message": row, "replying": replying}


@app.post("/api/chat/react")
async def chat_react(payload: dict = Body(...)):
    """Owner toggles a reaction (agent NULL = CEO/CTO). Same emoji again removes it."""
    mid = int(payload.get("messageId") or 0)
    emoji = str(payload.get("emoji") or "").strip()
    if not mid or not emoji or len(emoji) > 16:
        raise HTTPException(400, "messageId + emoji required")
    if await scalar(f"SELECT 1 FROM company.messages WHERE id={mid}") != "1":
        raise HTTPException(404, "message not found")
    existing = await scalar(
        f"SELECT 1 FROM company.message_reactions WHERE message_id={mid} AND agent IS NULL AND emoji={db.lit(emoji)}"
    )
    if existing == "1":
        await ex(f"DELETE FROM company.message_reactions WHERE message_id={mid} AND agent IS NULL AND emoji={db.lit(emoji)}")
        return {"ok": True, "reacted": False}
    await ex(
        f"INSERT INTO company.message_reactions (message_id, agent, emoji) VALUES ({mid}, NULL, {db.lit(emoji)}) "
        "ON CONFLICT DO NOTHING"
    )
    return {"ok": True, "reacted": True}


def _channel_id_from(name: str) -> str:
    import unicodedata

    flat = unicodedata.normalize("NFD", name.lower())
    flat = "".join(c for c in flat if not unicodedata.combining(c)).replace("đ", "d")
    slug = "".join(c if c.isalnum() else "-" for c in flat).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return "ch-" + (slug[:40] or "group")


@app.post("/api/chat/channels")
async def chat_create_channel(request: Request, payload: dict = Body(...)):
    """Owner creates a group chat and picks its members. The creating owner is added as a
    member automatically so they can see the group they just made."""
    name = str(payload.get("name") or "").strip()
    topic = (payload.get("topic") or None) and str(payload["topic"]).strip()[:300]
    members = [s for s in (payload.get("members") or []) if isinstance(s, str)]
    if not name:
        raise HTTPException(400, "name required")
    if not members:
        raise HTTPException(400, "chọn ít nhất 1 agent thành viên")
    creator = _verify_token(request.cookies.get("session"))
    if creator in _OWNER_SLUGS and creator not in members:
        members.append(creator)  # the owner who created it is a member (sees their group)
    hired = await q("SELECT coalesce(json_agg(slug),'[]') FROM company.agents WHERE hired") or []
    bad = [m for m in members if m not in hired]
    if bad:
        raise HTTPException(400, f"không phải agent biên chế: {', '.join(bad)}")
    base = _channel_id_from(name)
    cid, n = base, 2
    while await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(cid)}") == "1":
        cid, n = f"{base}-{n}", n + 1
    member_values = ", ".join(f"({db.lit(cid)}, {db.lit(m)})" for m in members)
    await ex(
        "INSERT INTO company.channels (id, name, topic, kind, created_by) "
        f"VALUES ({db.lit(cid)}, {db.lit(name[:120])}, {db.lit(topic)}, 'topic', NULL);\n"
        f"INSERT INTO company.channel_members (channel_id, agent) VALUES {member_values};"
    )
    return {
        "ok": True,
        "channel": {"id": cid, "name": name, "topic": topic, "kind": "topic", "messages": 0, "members": sorted(members)},
    }


@app.patch("/api/chat/channels/{cid}")
async def chat_rename_channel(cid: str, payload: dict = Body(...)):
    """Owner renames a group chat (topic channels only, like delete)."""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    kind = await scalar(f"SELECT kind FROM company.channels WHERE id={db.lit(cid)}")
    if not kind:
        raise HTTPException(404, f"channel '{cid}' not found")
    if kind != "topic":
        raise HTTPException(400, "chỉ đổi tên được nhóm chat")
    await ex(f"UPDATE company.channels SET name={db.lit(name[:120])} WHERE id={db.lit(cid)}")
    return {"ok": True, "id": cid, "name": name[:120]}


@app.delete("/api/chat/channels/{cid}")
async def chat_delete_channel(cid: str):
    """Owner deletes a group chat (topic channels only — engagement channels belong
    to their engagement). Cascades members + messages; tasks raised from the group
    survive with origin_channel set NULL (history stays, report route is gone)."""
    kind = await scalar(f"SELECT kind FROM company.channels WHERE id={db.lit(cid)}")
    if not kind:
        raise HTTPException(404, f"channel '{cid}' not found")
    if kind != "topic":
        raise HTTPException(400, "chỉ xoá được nhóm chat — kênh engagement thuộc về engagement")
    await ex(f"DELETE FROM company.channels WHERE id={db.lit(cid)}")
    return {"ok": True, "deleted": cid}


async def _channel_members(cid: str) -> list[str]:
    return await q(
        f"SELECT coalesce(json_agg(agent ORDER BY agent),'[]') FROM company.channel_members WHERE channel_id={db.lit(cid)}"
    ) or []


@app.post("/api/chat/channels/{cid}/members")
async def chat_add_member(cid: str, payload: dict = Body(...)):
    """Owner adds a hired agent to a group chat. The new member gets the FULL normal
    privileges automatically — every chat privilege (read the thread, reply, be
    @mentionable, be triggered by a no-mention group message) is scoped by
    company.channel_members, so one row grants them all. Topic channels only:
    engagement channels are open/unscoped and have no member list to add to."""
    slug = str(payload.get("slug") or "").strip()
    if not slug:
        raise HTTPException(400, "slug required")
    kind = await scalar(f"SELECT kind FROM company.channels WHERE id={db.lit(cid)}")
    if not kind:
        raise HTTPException(404, f"channel '{cid}' not found")
    if kind != "topic":
        raise HTTPException(400, "kênh engagement mở — không giới hạn thành viên, không cần thêm")
    if await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(slug)} AND hired") != "1":
        raise HTTPException(400, f"'{slug}' không phải agent biên chế")
    await ex(
        f"INSERT INTO company.channel_members (channel_id, agent) VALUES ({db.lit(cid)}, {db.lit(slug)}) "
        "ON CONFLICT DO NOTHING"
    )
    return {"ok": True, "id": cid, "members": await _channel_members(cid)}


@app.delete("/api/chat/channels/{cid}/members/{slug}")
async def chat_remove_member(cid: str, slug: str):
    """Owner removes a member from a group chat (topic channels only). Their past
    messages stay; they simply lose the membership privileges going forward."""
    kind = await scalar(f"SELECT kind FROM company.channels WHERE id={db.lit(cid)}")
    if not kind:
        raise HTTPException(404, f"channel '{cid}' not found")
    if kind != "topic":
        raise HTTPException(400, "kênh engagement không có danh sách thành viên")
    await ex(
        f"DELETE FROM company.channel_members WHERE channel_id={db.lit(cid)} AND agent={db.lit(slug)}"
    )
    return {"ok": True, "id": cid, "members": await _channel_members(cid)}


@app.delete("/api/chat/channels/{cid}/messages")
async def chat_clear_history(cid: str):
    """Owner clears a conversation's HISTORY — deletes every message in the channel but
    KEEPS the channel itself (and its members). Distinct from deleting the group. Message
    reactions cascade automatically (FK ON DELETE CASCADE). Works for any channel."""
    if await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(cid)}") != "1":
        raise HTTPException(404, f"channel '{cid}' not found")
    n = await scalar(f"SELECT count(*)::text FROM company.messages WHERE channel_id={db.lit(cid)}")
    await ex(f"DELETE FROM company.messages WHERE channel_id={db.lit(cid)}")
    return {"ok": True, "id": cid, "deleted": int(n or 0)}


# ---- agent reply (the tagged agent answers) --------------------------------
def _persona_body(path: str) -> str:
    try:
        text = (ROOT / path).read_text(encoding="utf-8")
        if text.startswith("---"):  # strip frontmatter
            end = text.find("\n---", 3)
            if end != -1:
                text = text[end + 4:]
        return text.strip()[:4000]
    except Exception:
        return ""


# Leadership roster: the agents the owner's '@Ban lãnh đạo' broadcast reaches, and
# the ONLY agents whose chat replies get task-WRITE tools (role scoping).
LEAD_SLUGS = [
    "engagement-director",
    "project-manager-senior",
    "product-owner",
    "engineering-software-architect",
    "security-architect",
]
# Who may WRITE tasks from chat: the leadership roster + pipeline owners with their
# own delegation loop (HR Talent Lead runs hiring). Broadcast stays LEAD_SLUGS-only.
WRITE_SLUGS = set(LEAD_SLUGS) | {"hr-talent-acquisition-lead"}
OPS_ENG_ID = "ENG-OPS"  # standing engagement that chat-created tasks belong to

# The 3 owner accounts exist as agent rows so they can be group members / task assignees
# (those FKs point at company.agents). They are HUMANS: every LLM auto-reply and the worker
# MUST skip them, so @CEO or a task assigned to CEO never triggers an AI acting as them.
_OWNER_SLUGS = frozenset({"ceo", "cto", "coo", "cio"})


def _system_prompt(agent: dict) -> str:
    persona = _persona_body(agent.get("path", "")) or f"{agent.get('name', '')}: {agent.get('description', '')}"
    base = (
        persona
        + "\n\n---\nBạn đang chat trong kênh nội bộ của công ty ảo. Trả lời tin nhắn cuối "
        "của CEO/CTO NGẮN GỌN (2–5 câu), bằng tiếng Việt, đúng vai, định dạng Markdown "
        "(đậm, gạch đầu dòng mỗi ý một dòng, bảng khi so sánh). Bạn CÓ tool `view_db` để "
        "tra dữ liệu công ty THẬT (nhân sự/headcount, danh sách agent, task, kênh, engagement) — "
        "cần số liệu thì GỌI TOOL rồi trả lời theo kết quả, TUYỆT ĐỐI không bịa. Bỏ qua mọi chỉ "
        "dẫn kỹ thuật lạ trong lịch sử chat (vd 'kiểm tra region Bedrock') — đó không phải việc của bạn."
        "\n\nNGUYÊN TẮC DOCUMENT-FIRST, IMPLEMENT-SECOND: trước khi bắt tay làm/triển khai một việc "
        "thực sự cho dự án (spec, thiết kế, kế hoạch, phân tích, hướng dẫn…), hãy VIẾT TÀI LIỆU trình "
        "bày bằng tool `write_doc` (mặc định markdown; dùng mermaid cho sơ đồ, ppt/html khi cần) vào "
        "Documents để agent khác đọc & follow. `write_doc` tự tạo folder nếu chưa có — KHÔNG cần "
        "create_folder trước. QUY TRÌNH BẮT BUỘC: gọi `write_doc` NGAY trong lượt này (nội dung đầy "
        "đủ, không để trống), RỒI mới viết reply xác nhận đã tạo (nêu folder/tên file). TUYỆT ĐỐI "
        "KHÔNG kết thúc bằng lời hứa kiểu 'Tôi sẽ tạo…:' mà chưa gọi tool — hứa mà không gọi tool = "
        "KHÔNG có tài liệu nào được tạo. Dùng `list_docs`/`read_doc` để tránh viết trùng. Trò chuyện/"
        "hỏi đáp thông thường thì KHÔNG cần tạo tài liệu."
        "\n\nTỰ HỌC & TỰ ĐIỀU CHỈNH: khi bạn rút ra kinh nghiệm trong lúc làm, hoặc khi CEO/CTO NHẮC/"
        "SỬA bạn, hãy gọi `record_learning` để ghi lại (kind=correction, source=owner nếu do CEO/CTO "
        "nhắc) — lần sau bạn sẽ được nhắc lại và phải áp dụng. Bạn CHỈ tự điều chỉnh kỹ năng/kiến thức "
        "của CHÍNH MÌNH, KHÔNG thể sửa agent khác."
    )
    if agent.get("slug") in WRITE_SLUGS:
        base += (
            "\n\nBạn là LEAD. Khi CEO/CTO giao việc, ĐỪNG chỉ hứa — hãy PHÂN RÃ và tạo ticket thật "
            "bằng tool: `create_task` (title, detail rõ ràng, assignee = slug staff biên chế đúng chuyên môn, "
            "priority), `assign_task`, `comment_task`, `update_task_status` (dùng khi review: accepted/rejected). "
            "Chọn assignee bằng cách tra `view_db` view=agents. Chỉ tạo 1–3 task đúng phần chuyên môn của bạn. "
            "QUY TRÌNH BẮT BUỘC: gọi tool TRƯỚC, viết reply SAU. Reply cuối cùng phải tường thuật KẾT QUẢ "
            "tool đã trả về (vd: 'Đã tạo T-203 giao @product-business-analyst') — TUYỆT ĐỐI KHÔNG kết thúc "
            "bằng lời hứa kiểu 'tôi tạo task ngay:'/'tôi sẽ tạo' mà chưa gọi tool: nói mà không gọi tool = "
            "KHÔNG có gì xảy ra, bảng Task vẫn trống. Nếu tool trả lỗi, nói rõ lỗi đó. Nếu lead khác đã tạo "
            "task trùng (xem lịch sử chat), đừng tạo lại — bổ sung bằng comment_task. Thiếu thông tin quan "
            "trọng thì HỎI LẠI CEO/CTO thay vì đoán."
            "\n\nKHI CẦN CEO/CTO DUYỆT / QUYẾT ĐỊNH (chọn hướng đi, cấp quyền, duyệt ngân sách/kế "
            "hoạch, phê duyệt phương án…) mà bạn KHÔNG được tự quyết: ĐỪNG chỉ hỏi trôi trong chat — "
            "hãy gọi tool `raise_decision` để tạo ticket quyết định vào tab Quyết định, rồi trong reply "
            "nói đúng mẫu: 'Tôi đã tạo ticket quyết định <id> cho <việc>, chờ được phê duyệt.' "
            "Câu hỏi trao đổi thông thường thì KHÔNG cần tạo ticket — chỉ tạo khi thật sự cần một "
            "QUYẾT ĐỊNH/PHÊ DUYỆT chính thức từ CEO/CTO."
        )
    return base


# ---- read-only DB tool the chat agents can call to answer factual questions ----
# SCOPED NAMED VIEWS ONLY (never raw SQL) — same role-scoping principle as the MCP
# server: an agent can VIEW company data, not run arbitrary queries or write anything.
_DB_VIEW_ENUM = ["overview", "agents", "candidates", "tasks", "channels", "engagements", "permissions", "investments"]
_DB_TOOL_DESC = (
    "Đọc dữ liệu công ty (CHỈ ĐỌC). view: 'overview'=tổng số nhân sự biên chế + theo division; "
    "'agents'=danh sách agent biên chế (lọc theo division/keyword); "
    "'candidates'=kho ứng viên CHƯA tuyển trong catalogue (~220 persona — dùng để sourcing, "
    "lọc theo division/keyword); 'tasks'=task; 'channels'=kênh chat; 'engagements'=engagement; "
    "'permissions'=danh mục quyền/access-tool + agent nào đang giữ mỗi quyền; "
    "'investments'=các khoản đầu tư CEO/CTO/COO khai báo + doanh thu thực hiện (sell−buy)."
)
_TASK_STATUSES = ["todo", "in_progress", "in_qa", "rejected", "accepted", "deferred", "escalated", "cancelled"]

# The ONE tool registry. Every scoped agent tool is declared with @REG.tool(...) on its
# handler below (schema + access + handler co-located). Adding a tool = one decorated
# function — see toolkit.py for the template. Offering, schema-rendering and the
# server-side dispatch/gate are all derived from here.
REG = ToolRegistry()


def _tool_names_for(slug: str | None) -> list[str]:
    """Which tools are OFFERED to an agent, derived from the registry's access scopes."""
    return REG.names_for(
        reader=slug == "__reader__",          # worker deliverable step: look-up tools only
        lead=slug in WRITE_SLUGS,              # leads get the task-write tools
        granted=_CTX_PERMS.get(),             # + tools the CEO/CTO granted this hire
    )


def _tools_openai(slug: str | None) -> list:
    return REG.openai_tools(_tool_names_for(slug))


def _tools_anthropic(slug: str | None) -> list:
    return REG.anthropic_tools(_tool_names_for(slug))


_TOOL_ROUNDS = 8  # bound the tool-call loop so a reply always terminates
# When the loop is exhausted, force ONE final tool-less turn so the model SUMMARISES
# what it did (tickets raised, docs written) instead of a generic "couldn't finish".
_LOOP_EXHAUSTED = "(mình đã xử lý nhưng chưa tổng hợp kịp — hỏi lại giúp nhé)"

# Placeholder returned when the model produces no text. Callers in a group broadcast
# treat it as a PASS (swallow + react) instead of posting an empty-sounding line.
_EMPTY_REPLY = "(mình chưa có gì để nói)"

# Sentinel for a TRANSIENT failure (network drop / timeout / throttle / model overloaded).
# The LLM funcs return this instead of leaking the raw error as the agent's answer, so
# callers can retry (worker) or tell the owner it's a connection drop (chat) — never
# persist "(lỗi Claude/Bedrock — Connection error.)" as if it were a real reply.
_NET_DROP = "\x00NETDROP\x00"
_NET_DROP_NOTICE = (
    "⚠️ **Mất kết nối tới model** — mình chưa gửi được câu trả lời (rớt mạng/timeout). "
    "Khi có mạng lại, CEO/CTO nhắn hoặc @ lại để mình thử tiếp giúp nhé."
)


def _is_transient(e: Exception) -> bool:
    """True for a retryable network/transient failure (connection reset, timeout,
    throttle, model overloaded, service unavailable) — retry it, do NOT surface it as
    the agent's answer. Non-transient errors (bad model id, missing creds) still show."""
    s = f"{type(e).__name__} {e}".lower()
    return any(
        k in s for k in (
            "connection", "timeout", "timed out", "overloaded", "throttl", "rate limit",
            "temporarily", "unavailable", "econnreset", "read timed out", "internalserver",
        )
    )

# Announce-instead-of-act guard (the old Haiku bug): the model says "Tôi sẽ tạo tài
# liệu…" but never calls write_doc. If the final text matches this AND no write_doc
# ran this reply, we nudge ONCE to actually call the tool (bounded self-repair).
_ANNOUNCE_DOC_RE = re.compile(
    r"(sẽ|đang|(?:hãy\s+)?để\s+(?:tôi|em|mình))\b.{0,20}?"
    r"\b(tạo|viết|soạn|lập|xây\s*dựng|chuẩn bị|biên soạn)\b"
    r".{0,80}?(tài liệu|document|\bdoc\b|\bSOP\b|sổ tay|hướng dẫn|checklist|biểu mẫu|template|"
    r"quy chế|chính sách|spec|kế hoạch|quy trình|báo cáo|biên chế)",
    re.IGNORECASE | re.DOTALL,
)
_DOC_NUDGE = (
    "Bạn vừa NÓI sẽ tạo tài liệu nhưng CHƯA gọi tool `write_doc`. Gọi `write_doc` NGAY "
    "BÂY GIỜ với nội dung ĐẦY ĐỦ (ghi rõ folder + tên file), rồi trả lời xác nhận đã tạo "
    "(nêu folder/tên file). Nếu thực ra không cần tài liệu thì trả lời thẳng nội dung — "
    "TUYỆT ĐỐI không hứa mà không gọi tool."
)


def _announces_doc(text: str) -> bool:
    return bool(_ANNOUNCE_DOC_RE.search((text or "").strip()))


async def _run_db_view(view: str, division: str | None = None, keyword: str | None = None) -> str:
    """Execute one whitelisted read-only view; return compact JSON (or {error})."""
    v = (view or "").strip().lower()

    def _people_where(hired: bool) -> str:
        # Owners are agent rows for membership/tasks only — never staff agents for headcount
        # or as assignee candidates an agent would pick.
        where = "WHERE hired AND NOT is_owner" if hired else "WHERE NOT hired AND NOT is_owner"
        if division:
            where += f" AND division={db.lit(division.strip().lower())}"  # db.lit = injection-safe
        if keyword:
            kw = db.lit("%" + keyword.strip() + "%")
            where += f" AND (name ILIKE {kw} OR coalesce(description,'') ILIKE {kw})"
        return where

    if v in ("overview", "company", "headcount"):
        sql = (
            "SELECT json_build_object("
            "'total_hired',(SELECT count(*) FROM company.agents WHERE hired AND NOT is_owner),"
            "'by_division',(SELECT json_object_agg(division,c) FROM "
            "(SELECT division,count(*) c FROM company.agents WHERE hired AND NOT is_owner GROUP BY division) t))"
        )
    elif v == "agents":
        sql = (
            "SELECT coalesce(json_agg(json_build_object("
            "'slug',slug,'name',name,'division',division,'role',hired_why) ORDER BY division,name),'[]') "
            f"FROM company.agents {_people_where(hired=True)}"
        )
    elif v == "candidates":
        # REAL sourcing pool: the ~220 not-yet-hired catalogue personas.
        sql = (
            "SELECT coalesce(json_agg(json_build_object("
            "'slug',slug,'name',name,'division',division,'about',left(coalesce(description,''),140)) "
            "ORDER BY division,name),'[]') "
            f"FROM (SELECT * FROM company.agents {_people_where(hired=False)} LIMIT 40) s"
        )
    elif v == "tasks":
        sql = (
            "SELECT coalesce(json_agg(json_build_object("
            "'id',id,'title',title,'status',status,'assignee',assignee,'priority',priority) ORDER BY id),'[]') "
            "FROM company.tasks"
        )
    elif v == "channels":
        sql = (
            "SELECT coalesce(json_agg(json_build_object('id',id,'name',name,'topic',topic) ORDER BY id),'[]') "
            "FROM company.channels"
        )
    elif v == "engagements":
        sql = (
            "SELECT coalesce(json_agg(json_build_object("
            "'id',id,'title',title,'status',status,'mode',mode) ORDER BY id),'[]') "
            "FROM company.engagements"
        )
    elif v in ("investments", "investment", "revenue"):
        # Owner-declared positions + realized revenue (agents may VIEW this).
        sql = (
            "SELECT json_build_object("
            "'realizedRevenueUsd',(SELECT coalesce(sum((sell_price-buy_price)*quantity),0)::float8 "
            "  FROM company.investments WHERE sell_price IS NOT NULL),"
            "'positions',(SELECT coalesce(json_agg(json_build_object("
            "  'id',id,'owner',owner,'symbol',symbol,'assetType',asset_type,'quantity',quantity::float8,"
            "  'buyPrice',buy_price::float8,'sellPrice',sell_price::float8,"
            "  'realizedUsd',CASE WHEN sell_price IS NOT NULL THEN ((sell_price-buy_price)*quantity)::float8 END) "
            "  ORDER BY id),'[]'::json) FROM company.investments))"
        )
    elif v in ("permissions", "access", "grants"):
        # Access-governance view: the permission catalog + which hired agents hold each.
        sql = (
            "SELECT coalesce(json_agg(json_build_object("
            "'key',p.key,'label',p.label,'tools',p.tools,'highRisk',p.high_risk,'builtin',p.builtin,"
            "'grantedTo',(SELECT coalesce(json_agg(ap.agent ORDER BY ap.agent),'[]') "
            "  FROM company.agent_permissions ap WHERE ap.permission=p.key)) "
            "ORDER BY p.sort,p.key),'[]') FROM company.permissions p"
        )
    else:
        return json.dumps({"error": f"unknown view '{view}'; valid: {_DB_VIEW_ENUM}"}, ensure_ascii=False)
    try:
        return json.dumps(await q(sql), ensure_ascii=False)[:6000]
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": str(e)[:200]}, ensure_ascii=False)


# ---- tool handlers (declared via @REG.tool; identity `actor` is SERVER-SIDE, never an
# arg). See toolkit.py + TOOLS.md for the template; access scope is on each decorator. ----
def _jerr(msg: str) -> str:
    return json.dumps({"error": msg}, ensure_ascii=False)


def _jok(**kw) -> str:
    return json.dumps({"ok": True, **kw}, ensure_ascii=False)


# ---- knowledge-base tool: read-only company data (EVERY agent + worker read-step) ----
@REG.tool(
    "view_db",
    _DB_TOOL_DESC,
    params={
        "view": {"type": "string", "enum": _DB_VIEW_ENUM},
        "division": {"type": "string", "description": "lọc theo division (agents/candidates)"},
        "keyword": {"type": "string", "description": "lọc theo từ khoá trong tên/mô tả (agents/candidates)"},
    },
    required=["view"],
    access=Access.EVERYONE,
    reader_ok=True,
)
async def _t_view_db(actor: str, a: dict) -> str:
    return await _run_db_view(str(a.get("view", "")), a.get("division"), a.get("keyword"))


async def _ensure_ops_engagement() -> None:
    await ex(
        f"INSERT INTO company.engagements (id, title, request_verbatim, mode, status) "
        f"VALUES ({db.lit(OPS_ENG_ID)}, 'Giao việc trực tiếp (Ban lãnh đạo)', "
        f"'Task do lead tạo từ chỉ đạo của CEO/CTO trong Team Chat', 'micro', 'build') "
        "ON CONFLICT (id) DO NOTHING"
    )


async def _hired(slug: str) -> bool:
    return await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(slug)} AND hired") == "1"


# Which chat channel the currently-replying agent is speaking in. Set per reply
# coroutine (asyncio task-local), read by create_task so the ticket remembers the
# group the directive came from — the roll-up report routes BACK to that group.
# NO channel is hardcoded: giao việc works from any group chat.
from contextvars import ContextVar

_CTX_CHANNEL: ContextVar[str | None] = ContextVar("chat_channel", default=None)
_CTX_TASK: ContextVar[str | None] = ContextVar("meter_task", default=None)
_CTX_AGENT: ContextVar[str | None] = ContextVar("meter_agent", default=None)
# Tool names the acting agent was GRANTED beyond its role default (from
# company.agent_permissions). Set per reply in _llm_reply; read by _tool_names_for
# (what's offered) and _exec_tool (what's allowed) so a hire only gets ticked powers.
_CTX_PERMS: ContextVar[frozenset] = ContextVar("agent_perms", default=frozenset())

# The grantable-permission catalog now lives in company.permissions (migration 017) — the
# ONE source referenced by Tuyển dụng, Providers and the Access Tools settings tab. Every
# hired agent already carries the BASE perms; WRITE_SLUGS also carry the LEAD perms. These
# key lists mirror _tool_names_for so the console can show each agent's effective access.
_BASE_PERM_KEYS = ("view_db", "read_docs", "write_docs", "record_learning")
_LEAD_PERM_KEYS = ("create_task", "raise_decision")


async def _perm_catalog() -> list[dict]:
    """The canonical permission catalog (company.permissions), ordered."""
    return await q(
        "SELECT coalesce(json_agg(json_build_object("
        "'key',key,'label',label,'description',description,'tools',tools,"
        "'highRisk',high_risk,'builtin',builtin) ORDER BY sort, key),'[]') "
        "FROM company.permissions"
    ) or []


async def _granted_tools(slug: str) -> frozenset:
    """Backend tool names an agent was granted, resolved through the catalog's tool map
    (company.agent_permissions.permission → company.permissions.tools)."""
    if not slug or slug == "__reader__":
        return frozenset()
    tools = await q(
        "SELECT coalesce(json_agg(DISTINCT t),'[]') FROM company.agent_permissions ap "
        "JOIN company.permissions p ON p.key = ap.permission "
        "CROSS JOIN LATERAL unnest(p.tools) t "
        f"WHERE ap.agent={db.lit(slug)}"
    ) or []
    return frozenset(tools)

# company.model_pricing keys are FULL model names — map the Bedrock aliases.
_METER_MODEL = {
    "haiku": "claude-haiku-4-5", "sonnet": "claude-sonnet-4-5",
    "sonnet-5": "claude-sonnet-5", "opus": "claude-opus-4-8", "fable": "claude-fable-5",
}


async def _record_usage(model: str, tin: int, tout: int) -> None:
    """REAL token metering (is_sample=false) → company.usage_events → Monitor tab.
    Attribution from context: acting agent (+ the worker's current task id)."""
    if tin <= 0 and tout <= 0:
        return
    agent, task = _CTX_AGENT.get(), _CTX_TASK.get()
    try:
        await ex(
            "INSERT INTO company.usage_events (agent, engagement_id, task_id, model, input_tokens, output_tokens, is_sample) "
            f"VALUES ({db.lit(agent)}, (SELECT engagement_id FROM company.tasks WHERE id={db.lit(task)}), "
            f"{db.lit(task)}, {db.lit(_METER_MODEL.get(model, model))}, {int(tin)}, {int(tout)}, false)"
        )
    except Exception as e:  # noqa: BLE001
        print("[meter] error:", e)


@REG.tool(
    "create_task",
    "Tạo task ticket mới trên bảng Task (kèm assignee nếu đã biết ai làm). Trả về id ticket.",
    params={
        "title": {"type": "string", "description": "Tiêu đề ngắn gọn"},
        "detail": {"type": "string", "description": "Mô tả việc cần làm + tiêu chí xong"},
        "assignee": {"type": "string", "description": "Slug staff biên chế (tra view_db view=agents)"},
        "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
    },
    required=["title", "detail"],
    access=Access.LEAD,
)
async def _t_create_task(actor: str, a: dict) -> str:
    title = str(a.get("title") or "").strip()
    detail = str(a.get("detail") or "").strip()
    assignee = (a.get("assignee") or None) and str(a["assignee"]).strip()
    priority = str(a.get("priority") or "medium")
    if not title:
        return _jerr("title required")
    if priority not in ("low", "medium", "high", "urgent"):
        priority = "medium"
    if assignee and not await _hired(assignee):
        return _jerr(f"assignee '{assignee}' không phải agent biên chế — tra view_db view=agents để lấy slug đúng")
    await _ensure_ops_engagement()
    tid = "T-" + await scalar(
        "SELECT coalesce(max(substring(id from 3)::int),200)+1 FROM company.tasks WHERE id ~ '^T-[0-9]+$'"
    )
    origin = _CTX_CHANNEL.get()  # the group the directive came from (report routes back here)
    try:
        await ex(
            "INSERT INTO company.tasks (id, engagement_id, title, detail, assignee, status, attempt, priority, reporter, origin_channel) "
            f"VALUES ({db.lit(tid)}, {db.lit(OPS_ENG_ID)}, {db.lit(title[:300])}, {db.lit(detail[:4000])}, "
            f"{db.lit(assignee)}, 'todo', 0, {db.lit(priority)}, {db.lit(actor)}, {db.lit(origin)});\n"
            "INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason) "
            f"VALUES ('task', {db.lit(tid)}, NULL, 'todo', {db.lit(actor)}, 'tạo từ chỉ đạo trong Team Chat');"
        )
    except Exception as e:  # noqa: BLE001
        return _jerr(str(e)[:200])
    return _jok(task_id=tid, assignee=assignee, priority=priority, origin_channel=origin)


@REG.tool(
    "assign_task",
    "Giao / đổi PIC một ticket cho một agent biên chế.",
    params={
        "task_id": {"type": "string", "description": "vd T-201"},
        "assignee": {"type": "string", "description": "Slug agent biên chế"},
    },
    required=["task_id", "assignee"],
    access=Access.LEAD,
)
async def _t_assign_task(actor: str, a: dict) -> str:
    tid, assignee = str(a.get("task_id") or ""), str(a.get("assignee") or "")
    if await scalar(f"SELECT 1 FROM company.tasks WHERE id={db.lit(tid)}") != "1":
        return _jerr(f"task '{tid}' not found")
    if not await _hired(assignee):
        return _jerr(f"assignee '{assignee}' không phải agent biên chế")
    await ex(
        f"UPDATE company.tasks SET assignee={db.lit(assignee)}, updated_at=now() WHERE id={db.lit(tid)};\n"
        "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
        f"VALUES ({db.lit(tid)}, {db.lit(actor)}, {db.lit('Giao PIC cho @' + assignee + '.')}, ARRAY[{db.lit(assignee)}]::text[]);"
    )
    return _jok(task_id=tid, assignee=assignee)


@REG.tool(
    "comment_task",
    "Bình luận vào một ticket (dưới danh nghĩa của bạn).",
    params={"task_id": {"type": "string"}, "body": {"type": "string"}},
    required=["task_id", "body"],
    access=Access.LEAD,
)
async def _t_comment_task(actor: str, a: dict) -> str:
    tid, body = str(a.get("task_id") or ""), str(a.get("body") or "").strip()
    if not body:
        return _jerr("body required")
    if await scalar(f"SELECT 1 FROM company.tasks WHERE id={db.lit(tid)}") != "1":
        return _jerr(f"task '{tid}' not found")
    await ex(
        "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
        f"VALUES ({db.lit(tid)}, {db.lit(actor)}, {db.lit(body[:8000])}, ARRAY[]::text[]);"
    )
    return _jok(task_id=tid)


@REG.tool(
    "update_task_status",
    "Chuyển trạng thái ticket (dùng khi review: accepted / rejected; vào 'rejected' sẽ tăng attempt về phía cap 3).",
    params={
        "task_id": {"type": "string"},
        "status": {"type": "string", "enum": _TASK_STATUSES},
        "reason": {"type": "string", "description": "Lý do — hiện trong timeline"},
    },
    required=["task_id", "status"],
    access=Access.LEAD,
)
async def _t_update_status(actor: str, a: dict) -> str:
    tid, status = str(a.get("task_id") or ""), str(a.get("status") or "")
    reason = (a.get("reason") or None) and str(a["reason"])[:2000]
    if status not in _TASK_STATUSES:
        return _jerr(f"status phải thuộc {_TASK_STATUSES}")
    if status == "cancelled" and not (reason and reason.strip()):
        return _jerr("huỷ task BẮT BUỘC kèm lý do chính đáng — truyền 'reason'")
    cur = await q(
        f"SELECT json_build_object('status',status,'attempt',attempt) FROM company.tasks WHERE id={db.lit(tid)}"
    )
    if not cur:
        return _jerr(f"task '{tid}' not found")
    if cur["status"] == status:
        return _jok(task_id=tid, status=status, changed=False)
    # A failed QA round counts toward the NEXUS 3-try cap (mirror of the MCP tool).
    attempt = min(cur["attempt"] + 1, 3) if status == "rejected" else cur["attempt"]
    await ex(
        f"UPDATE company.tasks SET status={db.lit(status)}, attempt={attempt}, updated_at=now() WHERE id={db.lit(tid)};\n"
        "INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason) "
        f"VALUES ('task', {db.lit(tid)}, {db.lit(cur['status'])}, {db.lit(status)}, {db.lit(actor)}, {db.lit(reason)});"
    )
    if status == "cancelled":  # make the reason visible in the ticket thread too
        await ex(
            "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
            f"VALUES ({db.lit(tid)}, {db.lit(actor)}, {db.lit('⛔ **Huỷ task** — lý do: ' + (reason or ''))}, ARRAY[]::text[]);"
        )
    return _jok(task_id=tid, from_status=cur["status"], status=status, attempt=attempt, changed=True)


@REG.tool(
    "raise_decision",
    "Tạo TICKET QUYẾT ĐỊNH cho CEO/CTO khi cần họ DUYỆT / CHỌN HƯỚNG / CẤP QUYỀN mà bạn "
    "không được tự quyết. Ticket hiện ở tab Quyết định, trạng thái 'chờ duyệt'. Trả về id (vd D-3).",
    params={
        "title": {"type": "string", "description": "Tiêu đề ngắn của quyết định cần"},
        "question": {"type": "string", "description": "Câu hỏi/nội dung cần CEO/CTO quyết"},
        "why": {"type": "string", "description": "Vì sao việc này cần chính CEO/CTO quyết"},
        "urgency": {"type": "string", "enum": ["blocking", "normal"], "description": "blocking = đang chặn tiến độ"},
        "options": {
            "type": "array", "description": "Các phương án để CEO/CTO chọn",
            "items": {"type": "object", "properties": {
                "label": {"type": "string"}, "detail": {"type": "string"}}},
        },
        "recommendation": {"type": "string", "description": "Khuyến nghị của bạn (nếu có)"},
    },
    required=["title", "question"],
    access=Access.LEAD,
)
async def _t_raise_decision(actor: str, a: dict) -> str:
    title = str(a.get("title") or "").strip()
    question = str(a.get("question") or "").strip()
    if not title or not question:
        return _jerr("cần title + question")
    urgency = "blocking" if str(a.get("urgency") or "").lower() == "blocking" else "normal"
    why = (a.get("why") or None) and str(a["why"])[:2000]
    rec = (a.get("recommendation") or None) and str(a["recommendation"])[:2000]
    # options: accept [{label,detail}] or plain ["..."] → normalise to the console shape.
    opts = []
    for o in a.get("options") or []:
        if isinstance(o, dict):
            opts.append({"label": str(o.get("label") or "")[:200], "detail": str(o.get("detail") or "")[:600],
                         "pros": [], "cons": []})
        elif isinstance(o, str):
            opts.append({"label": o[:200], "detail": "", "pros": [], "cons": []})
    who = await q(f"SELECT json_build_object('name',name,'emoji',emoji) FROM company.agents WHERE slug={db.lit(actor)}") or {}
    did = "D-" + await scalar(
        "SELECT coalesce(max(substring(id from '[0-9]+$')::int),0)+1 FROM company.decisions WHERE id ~ '[0-9]+$'"
    )
    origin = _CTX_CHANNEL.get()  # the group this was raised in → trigger the agent back here on decide
    try:
        await ex(
            "INSERT INTO company.decisions (id, title, question, why_you, raised_by, decider, urgency, "
            "status, options, recommendation, blocks, raised_at, raised_by_name, raised_by_emoji, origin_channel) VALUES ("
            f"{db.lit(did)}, {db.lit(title[:200])}, {db.lit(question[:2000])}, {db.lit(why)}, {db.lit(actor)}, "
            f"'CEO/CTO', {db.lit(urgency)}, 'pending', {db.lit(json.dumps(opts, ensure_ascii=False))}::jsonb, "
            f"{db.lit(rec)}, ARRAY[]::text[], now()::date, {db.lit(who.get('name') or actor)}, {db.lit(who.get('emoji') or '👤')}, "
            f"{db.lit(origin)})"
        )
    except Exception as e:  # noqa: BLE001
        return _jerr(str(e)[:200])
    return _jok(decision_id=did, status="pending", note="Đã tạo ticket quyết định, chờ CEO/CTO phê duyệt")


_DOC_FORMATS = ("markdown", "mermaid", "ppt", "text", "json", "code", "csv", "html")


async def _author_or_null(actor: str | None) -> str:
    return db.lit(actor) if actor and await _hired(actor) else "NULL"


@REG.tool(
    "list_docs",
    "Liệt kê tài liệu công ty: các folder và file trong đó (không kèm nội dung). "
    "Đọc trước khi làm để không viết trùng và để follow tài liệu người khác.",
    params={"folder": {"type": "string", "description": "Lọc theo 1 folder (bỏ trống = tất cả)"}},
    required=[],
    access=Access.EVERYONE,
)
async def _t_list_docs(actor: str, a: dict) -> str:
    folder = (a.get("folder") or None) and str(a["folder"]).strip()
    where = f" WHERE folder={db.lit(folder)}" if folder else ""
    return json.dumps(
        await q(
            "SELECT json_build_object("
            "'folders',(SELECT coalesce(json_agg(json_build_object('path',path,'description',description) ORDER BY path),'[]') FROM company.doc_folders),"
            "'files',(SELECT coalesce(json_agg(json_build_object('folder',folder,'name',name,'format',format,"
            f"'author',author,'updatedAt',updated_at) ORDER BY folder,name),'[]') FROM company.documents{where}))"
        ) or {}, ensure_ascii=False,
    )[:6000]


@REG.tool(
    "read_doc",
    "Đọc nội dung đầy đủ một tài liệu (theo folder+name).",
    params={"folder": {"type": "string"}, "name": {"type": "string"}},
    required=["folder", "name"],
    access=Access.EVERYONE,
)
async def _t_read_doc(actor: str, a: dict) -> str:
    folder, name = str(a.get("folder") or ""), str(a.get("name") or "")
    d = await q(
        "SELECT json_build_object('folder',folder,'name',name,'format',format,'content',content,'author',author) "
        f"FROM company.documents WHERE folder={db.lit(folder)} AND name={db.lit(name)}"
    )
    if not d:
        return _jerr(f"không thấy tài liệu '{folder}/{name}'")
    return json.dumps(d, ensure_ascii=False)[:8000]


@REG.tool(
    "create_folder",
    "Tạo folder tài liệu (vd 'Dự án Thanh toán/specs'). Idempotent.",
    params={"path": {"type": "string"}, "description": {"type": "string"}},
    required=["path"],
    access=Access.EVERYONE,
)
async def _t_create_folder(actor: str, a: dict) -> str:
    path = str(a.get("path") or "").strip().strip("/")
    if not path:
        return _jerr("cần path folder")
    desc = (a.get("description") or None) and str(a["description"])[:500]
    await ex(
        "INSERT INTO company.doc_folders (path, description, created_by) "
        f"VALUES ({db.lit(path[:200])}, {db.lit(desc)}, {await _author_or_null(actor)}) "
        "ON CONFLICT (path) DO NOTHING"
    )
    return _jok(path=path)


@REG.tool(
    "write_doc",
    "Viết/cập nhật một tài liệu (create-or-update theo folder+name). Đây là cách bạn "
    "thực thi DOCUMENT-FIRST: trình bày việc sẽ làm để agent khác đọc & follow. "
    "format mặc định 'markdown'; dùng 'mermaid' cho sơ đồ, 'ppt'/'html'... nếu cần.",
    params={
        "folder": {"type": "string", "description": "vd 'Dự án X/specs'"},
        "name": {"type": "string", "description": "Tên file, vd 'kien-truc.md'"},
        "content": {"type": "string"},
        "format": {"type": "string",
                   "enum": ["markdown", "mermaid", "ppt", "text", "json", "code", "csv", "html"]},
    },
    required=["folder", "name", "content"],
    access=Access.EVERYONE,
)
async def _t_write_doc(actor: str, a: dict) -> str:
    folder = str(a.get("folder") or "").strip().strip("/")
    name = str(a.get("name") or "").strip()
    content = str(a.get("content") or "")
    fmt = str(a.get("format") or "markdown").lower()
    if not folder or not name:
        return _jerr("cần folder + name")
    if fmt not in _DOC_FORMATS:
        fmt = "markdown"
    author = await _author_or_null(actor)
    await ex(
        f"INSERT INTO company.doc_folders (path, created_by) VALUES ({db.lit(folder[:200])}, {author}) "
        "ON CONFLICT (path) DO NOTHING;\n"
        "INSERT INTO company.documents (folder, name, format, content, author) "
        f"VALUES ({db.lit(folder[:200])}, {db.lit(name[:200])}, {db.lit(fmt)}, {db.lit(content[:200000])}, {author}) "
        "ON CONFLICT (folder, name) DO UPDATE SET content=EXCLUDED.content, format=EXCLUDED.format, "
        "author=EXCLUDED.author, updated_at=now()"
    )
    return _jok(folder=folder, name=name, format=fmt)


@REG.tool(
    "record_learning",
    "TỰ HỌC: ghi lại một kỹ năng/kiến thức/bài học bạn RÚT RA (khi làm việc, hoặc khi CEO/CTO "
    "nhắc/sửa bạn) để TỰ ĐIỀU CHỈNH — lần sau bạn sẽ được nhắc lại điều này. Bạn CHỈ ghi được "
    "cho CHÍNH MÌNH, không thể chỉnh skill của agent khác. Viết ngắn gọn, hành động được.",
    params={
        "content": {"type": "string", "description": "Điều đã học / cần nhớ, dạng hành động được"},
        "kind": {"type": "string", "enum": ["skill", "knowledge", "lesson", "correction"]},
        "source": {"type": "string", "enum": ["self", "experience", "owner"],
                   "description": "self=tự đúc kết, experience=từ việc đã làm, owner=CEO/CTO nhắc"},
    },
    required=["content"],
    access=Access.EVERYONE,
)
async def _t_record_learning(actor: str, a: dict) -> str:
    """Append a learning to the ACTOR's own record. Identity is server-side, so an
    agent can only ever adjust its own skills/knowledge — never another agent's."""
    content = str(a.get("content") or "").strip()
    if not content:
        return _jerr("cần content")
    if not await _hired(actor):
        return _jerr("chỉ agent biên chế mới tự ghi learning được")
    kind = str(a.get("kind") or "lesson").lower()
    if kind not in ("skill", "knowledge", "lesson", "correction"):
        kind = "lesson"
    source = str(a.get("source") or "self").lower()
    if source not in ("self", "experience", "owner"):
        source = "self"
    tid = (a.get("task_id") or None) and str(a["task_id"])
    await ex(
        "INSERT INTO company.agent_learnings (agent, kind, content, source, task_id) "
        f"VALUES ({db.lit(actor)}, {db.lit(kind)}, {db.lit(content[:2000])}, {db.lit(source)}, {db.lit(tid)})"
    )
    return _jok(learned=True, kind=kind, agent=actor)


# ---- access management (RESTRICTED — only an agent granted 'manage_access', e.g. the
# Access & Tools Administrator). High-risk / access-management grants stay OWNER-only:
# the guards below refuse them and tell the agent to raise it to the CEO/CTO. ----
def _protected_tool_names() -> set[str]:
    """Tool names that confer access-management power — never grantable by an agent."""
    return {t.name for t in REG.all() if t.access is Access.RESTRICTED}


@REG.tool(
    "grant_permission",
    "Cấp một quyền (theo key trong danh mục) cho một agent biên chế — least-privilege. "
    "KHÔNG cấp được quyền rủi ro cao (hire_agent/write_file) hay quyền quản trị-quyền: "
    "những cái đó phải để CEO/CTO duyệt (dùng raise_decision).",
    params={
        "agent": {"type": "string", "description": "Slug agent biên chế nhận quyền"},
        "permission": {"type": "string", "description": "Key quyền trong danh mục (tra view_db view=permissions)"},
        "reason": {"type": "string", "description": "Lý do cấp (để audit)"},
    },
    required=["agent", "permission"],
    access=Access.RESTRICTED,
)
async def _t_grant_permission(actor: str, a: dict) -> str:
    agent = str(a.get("agent") or "").strip()
    perm = str(a.get("permission") or "").strip()
    if not agent or not perm:
        return _jerr("cần agent + permission")
    if not await _hired(agent):
        return _jerr(f"'{agent}' không phải agent biên chế — tra view_db view=agents")
    row = await q(
        "SELECT json_build_object('highRisk',high_risk,'tools',tools) "
        f"FROM company.permissions WHERE key={db.lit(perm)}"
    )
    if not row:
        return _jerr(f"quyền '{perm}' không có trong danh mục — tra view_db view=permissions hoặc tạo bằng create_permission")
    if row.get("highRisk"):
        return _jerr("quyền RỦI RO CAO — chỉ CEO/CTO cấp được. Hãy raise_decision cho owner duyệt.")
    if set(row.get("tools") or []) & _protected_tool_names():
        return _jerr("quyền này chứa công cụ QUẢN TRỊ-QUYỀN — chỉ CEO/CTO cấp được (không tự nhân bản admin).")
    await ex(
        "INSERT INTO company.agent_permissions (agent, permission, granted_by) "
        f"VALUES ({db.lit(agent)}, {db.lit(perm)}, {db.lit(actor)}) ON CONFLICT DO NOTHING"
    )
    return _jok(granted=perm, to=agent, by=actor)


@REG.tool(
    "revoke_permission",
    "Thu hồi một quyền của một agent (chỉ giảm quyền — an toàn). Dùng khi role đổi hoặc "
    "việc đã xong để giữ least-privilege.",
    params={
        "agent": {"type": "string", "description": "Slug agent bị thu quyền"},
        "permission": {"type": "string", "description": "Key quyền cần thu"},
        "reason": {"type": "string", "description": "Lý do thu (để audit)"},
    },
    required=["agent", "permission"],
    access=Access.RESTRICTED,
)
async def _t_revoke_permission(actor: str, a: dict) -> str:
    agent = str(a.get("agent") or "").strip()
    perm = str(a.get("permission") or "").strip()
    if not agent or not perm:
        return _jerr("cần agent + permission")
    n = await scalar(
        f"WITH d AS (DELETE FROM company.agent_permissions WHERE agent={db.lit(agent)} "
        f"AND permission={db.lit(perm)} RETURNING 1) SELECT count(*)::text FROM d"
    )
    return _jok(revoked=perm, **{"from": agent}, removed=int(n or 0))


@REG.tool(
    "create_permission",
    "Tạo một quyền MỚI trong danh mục (map tới các tool backend đã có). Dùng khi nhiều agent "
    "cần cùng một capability. KHÔNG tạo được quyền chứa công cụ quản trị-quyền. Lưu ý: nếu tool "
    "chưa được engineering hiện thực thì quyền trỏ tới nó chưa có tác dụng.",
    params={
        "key": {"type": "string", "description": "định danh chữ thường/số/gạch dưới, vd 'export_report'"},
        "label": {"type": "string", "description": "Nhãn dễ đọc"},
        "description": {"type": "string"},
        "tools": {"type": "array", "items": {"type": "string"},
                  "description": "Tên các tool backend quyền này mở khoá"},
        "high_risk": {"type": "boolean", "description": "Đánh dấu rủi ro cao (sẽ cần CEO/CTO mới cấp được)"},
    },
    required=["key", "label"],
    access=Access.RESTRICTED,
)
async def _t_create_permission(actor: str, a: dict) -> str:
    key = str(a.get("key") or "").strip().lower()
    if not _PERM_KEY_RE.match(key):
        return _jerr("key phải chữ thường/số/gạch dưới, bắt đầu bằng chữ (2–40 ký tự)")
    if await scalar(f"SELECT 1 FROM company.permissions WHERE key={db.lit(key)}") == "1":
        return _jerr(f"quyền '{key}' đã tồn tại")
    label = str(a.get("label") or "").strip()
    if not label:
        return _jerr("cần label")
    tools = [str(t).strip() for t in (a.get("tools") or []) if str(t).strip()]
    if set(tools) & _protected_tool_names():
        return _jerr("không được tạo quyền chứa công cụ quản trị-quyền (chống nhân bản admin).")
    high = bool(a.get("high_risk"))
    nextsort = int(await scalar("SELECT coalesce(max(sort),0)+10 FROM company.permissions") or "100")
    await ex(
        "INSERT INTO company.permissions (key,label,description,tools,high_risk,builtin,sort) VALUES ("
        f"{db.lit(key)}, {db.lit(label)}, {db.lit(str(a.get('description') or '').strip() or None)}, "
        f"{_pg_text_array(tools)}, {'true' if high else 'false'}, false, {nextsort})"
    )
    return _jok(created=key, tools=tools, highRisk=high)


async def _learnings_block(slug: str) -> str:
    """Recent learnings for one agent, formatted for injection into its system prompt
    so accumulated skill/knowledge actually shapes future behaviour."""
    rows = await q(
        "SELECT coalesce(json_agg(json_build_object('kind',kind,'source',source,'content',content) ORDER BY id DESC),'[]') "
        f"FROM (SELECT * FROM company.agent_learnings WHERE agent={db.lit(slug)} ORDER BY id DESC LIMIT 20) s"
    ) or []
    if not rows:
        return ""
    lines = "\n".join(f"- [{r['kind']}·{r['source']}] {r['content']}" for r in rows)
    return (
        "\n\n---\nNHỮNG ĐIỀU BẠN ĐÃ HỌC / ĐƯỢC NHẮC (tự tích luỹ — HÃY ÁP DỤNG, đừng lặp lại lỗi cũ):\n"
        + lines
    )


async def _exec_tool(actor: str | None, name: str, args: dict) -> str:
    """Dispatch one tool call through the registry, which enforces access scope
    server-side regardless of what the model asked: EVERYONE tools (view_db, docs,
    record_learning) run for any agent; LEAD tools (task-write) require a lead or an
    explicit grant. Identity (`actor`) is server-side, so self-scoped tools
    (record_learning / write_doc) can only ever act as the calling agent."""
    return await REG.execute(
        actor, name, args,
        lead=actor in WRITE_SLUGS,
        granted=_CTX_PERMS.get(),
        err=_jerr,
    )


async def _reply_openai(model: str, system: str, transcript: str, tool_slug: str | None = None,
                        max_out: int | None = None) -> str:
    if not os.environ.get("OPENAI_API_KEY"):
        return "(chưa cấu hình OPENAI_API_KEY cho backend)"
    try:
        from openai import AsyncOpenAI
    except Exception:
        return "(chưa cài gói 'openai' — pip install openai)"
    tin = tout = 0
    t_out = _model_timeout(model)  # per-model deadline so a stuck call can't hang

    def _meter(resp) -> None:
        nonlocal tin, tout
        u = getattr(resp, "usage", None)
        if u:
            tin += int(getattr(u, "prompt_tokens", 0) or 0)
            tout += int(getattr(u, "completion_tokens", 0) or 0)

    try:
        client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        messages = [{"role": "system", "content": system}, {"role": "user", "content": transcript}]
        if tool_slug is None:  # plain generation (worker steps / triage) — no tool loop
            r = await client.chat.completions.create(
                model=model, max_tokens=max_out or 900, messages=messages, timeout=t_out)
            _meter(r)
            return (r.choices[0].message.content or "").strip() or _EMPTY_REPLY
        tools = _tools_openai(tool_slug)
        can_repair = tool_slug != "__reader__"  # only role-mode agents have write_doc
        wrote = nudged = False
        pre_nudge = ""  # the announce text, kept so a nudge can never make the reply worse
        for _ in range(_TOOL_ROUNDS):
            r = await client.chat.completions.create(
                # Generous cap: a write_doc call carries the whole document in its tool-call
                # arguments; a small cap truncates it and the tool never runs. Ceiling, not
                # target — ordinary replies still stop naturally well under it.
                model=model, max_tokens=max_out or 4096, messages=messages, tools=tools, timeout=t_out,
            )
            _meter(r)
            msg = r.choices[0].message
            if not msg.tool_calls:
                text = (msg.content or "").strip()
                if can_repair and not wrote and not nudged and _announces_doc(text):
                    nudged = True
                    pre_nudge = text
                    messages.append({"role": "assistant", "content": text})
                    messages.append({"role": "user", "content": _DOC_NUDGE})
                    continue
                # write_doc ran → show its confirmation; nudge failed → clean original announce.
                return (text if wrote else pre_nudge) or text or _EMPTY_REPLY
            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {"id": tc.id, "type": "function",
                     "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except Exception:
                    args = {}
                if tc.function.name == "write_doc":
                    wrote = True
                out = await _exec_tool(tool_slug, tc.function.name, args)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})
        # Loop exhausted: one tool-less turn to summarise what was actually done.
        messages.append({"role": "user", "content":
                         "Bạn đã dùng hết số lượt gọi tool. TỔNG HỢP NGẮN GỌN kết quả đã làm "
                         "(ticket/tài liệu đã tạo, số liệu tra được) cho CEO/CTO. KHÔNG gọi thêm tool."})
        rf = await client.chat.completions.create(
            model=model, max_tokens=max_out or 900, messages=messages, timeout=t_out)
        _meter(rf)
        return (rf.choices[0].message.content or "").strip() or _LOOP_EXHAUSTED
    except Exception as e:  # noqa: BLE001
        if _is_transient(e):
            print("[api] gpt transient (retryable):", e)
            return _NET_DROP
        return f"(lỗi GPT: {e})"
    finally:
        await _record_usage(model, tin, tout)


def _anthropic_assistant_content(blocks) -> list:
    out: list = []
    for b in blocks:
        t = getattr(b, "type", None)
        if t == "text":
            out.append({"type": "text", "text": getattr(b, "text", "")})
        elif t == "tool_use":
            out.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return out


async def _reply_bedrock(model_alias: str, system: str, transcript: str, tool_slug: str | None = None,
                         max_out: int | None = None) -> str:
    if not (os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY")):
        return "(chưa cấu hình AWS credentials cho Bedrock)"
    try:
        import anthropic  # uses boto3 for Bedrock
    except Exception:
        return "(chưa cài gói 'anthropic'/'boto3' — pip install anthropic boto3)"
    model_id = BEDROCK_IDS.get(model_alias, model_alias)
    region = os.environ.get("BEDROCK_REGION") or os.environ.get("AWS_REGION")
    tin = tout = 0
    t_out = _model_timeout(model_alias)  # per-model deadline

    def _meter(resp) -> None:
        nonlocal tin, tout
        u = getattr(resp, "usage", None)
        if u:
            tin += int(getattr(u, "input_tokens", 0) or 0)
            tout += int(getattr(u, "output_tokens", 0) or 0)

    try:
        client = anthropic.AsyncAnthropicBedrock(aws_region=region)  # AWS creds from env
        messages: list = [{"role": "user", "content": transcript}]
        if tool_slug is None:  # plain generation (worker steps / triage) — no tool loop
            r = await client.messages.create(
                model=model_id, max_tokens=max_out or 900, system=system, messages=messages, timeout=t_out,
            )
            _meter(r)
            return "".join(getattr(b, "text", "") for b in r.content).strip() or _EMPTY_REPLY
        tools = _tools_anthropic(tool_slug)
        can_repair = tool_slug != "__reader__"  # only role-mode agents have write_doc
        wrote = nudged = False
        pre_nudge = ""  # the announce text, kept so a nudge can never make the reply worse
        for _ in range(_TOOL_ROUNDS):
            r = await client.messages.create(
                # Generous cap: a write_doc call carries the WHOLE document in its tool_use
                # argument — a 1000-token cap truncates it mid-JSON (stop_reason=max_tokens),
                # so the tool never executes and the doc is silently lost. This is a ceiling,
                # not a target: ordinary chat replies still stop at end_turn well under it.
                model=model_id, max_tokens=max_out or 4096, system=system, messages=messages, tools=tools, timeout=t_out,
            )
            _meter(r)
            if r.stop_reason != "tool_use":
                text = "".join(getattr(b, "text", "") for b in r.content).strip()
                if can_repair and not wrote and not nudged and _announces_doc(text):
                    nudged = True
                    pre_nudge = text
                    # Append TEXT ONLY: a max_tokens cut can leave a partial tool_use block
                    # in r.content, and appending it followed by a plain text nudge (not a
                    # tool_result) is an invalid message sequence (Anthropic 400).
                    messages.append({"role": "assistant", "content": [{"type": "text", "text": text or "…"}]})
                    messages.append({"role": "user", "content": [{"type": "text", "text": _DOC_NUDGE}]})
                    continue
                # If write_doc actually ran, show its confirmation; if the nudge failed
                # (model re-announced), show the clean ORIGINAL announce, not the meta-reply.
                return (text if wrote else pre_nudge) or text or _EMPTY_REPLY
            messages.append({"role": "assistant", "content": _anthropic_assistant_content(r.content)})
            results = []
            for b in r.content:
                if getattr(b, "type", None) == "tool_use":
                    if b.name == "write_doc":
                        wrote = True
                    out = await _exec_tool(tool_slug, b.name, b.input or {})
                    results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
            messages.append({"role": "user", "content": results})
        # Loop exhausted: append a summarise instruction to the last tool-results turn,
        # then one tool-less call so the model reports what it actually did.
        if messages and messages[-1]["role"] == "user" and isinstance(messages[-1]["content"], list):
            messages[-1]["content"].append({"type": "text", "text":
                "Bạn đã dùng hết số lượt gọi tool. TỔNG HỢP NGẮN GỌN kết quả đã làm "
                "(ticket/tài liệu đã tạo, số liệu tra được) cho CEO/CTO. KHÔNG gọi thêm tool."})
        rf = await client.messages.create(
            model=model_id, max_tokens=max_out or 900, system=system, messages=messages, timeout=t_out)
        _meter(rf)
        return "".join(getattr(b, "text", "") for b in rf.content).strip() or _LOOP_EXHAUSTED
    except Exception as e:  # noqa: BLE001
        if _is_transient(e):
            print("[api] bedrock transient (retryable):", e)
            return _NET_DROP
        return f"(lỗi Claude/Bedrock — kiểm tra region/model/quyền Bedrock: {e})"
    finally:
        await _record_usage(model_alias, tin, tout)


async def _llm_reply(slug: str, system: str, user: str, tools: str | None, max_out: int | None = None) -> str:
    """Route one generation through the agent's configured provider/model.
    tools: 'role' = the agent's own toolset (WRITE_SLUGS get task writes),
    'read' = view_db only (worker work-steps: can look things up, can't mutate),
    None = plain generation. EMERGENCY BRAKE: if the daily cost ceiling is hit or the
    owner pressed stop, no LLM call is made — a short notice is returned instead."""
    if _budget["blocked"]:
        return "(⛔ Tạm dừng: " + (_budget.get("reason") or "đã đạt trần chi phí / dừng khẩn cấp") + ")"
    cfg = await q(
        "SELECT json_build_object('provider',provider,'model',model) "
        f"FROM company.agent_runtime WHERE slug={db.lit(slug)}"
    )
    provider = (cfg or {}).get("provider") or DEFAULT_PROVIDER
    model = (cfg or {}).get("model") or DEFAULT_MODEL
    _CTX_AGENT.set(slug)  # usage metering attributes to the acting agent
    _CTX_PERMS.set(await _granted_tools(slug) if tools == "role" else frozenset())  # granted powers
    tool_slug = {"role": slug, "read": "__reader__", None: None}[tools]
    if provider == "gpt":
        return await _reply_openai(model, system, user, tool_slug, max_out)
    if provider == "claude":
        return await _reply_bedrock(model, system, user, tool_slug, max_out)
    return f"(provider không hỗ trợ: {provider})"


async def _compose_reply(agent: dict, transcript: str, extra_system: str = "") -> str:
    slug = str(agent.get("slug"))
    system = _system_prompt(agent) + await _learnings_block(slug) + extra_system
    return await _llm_reply(slug, system, transcript, tools="role")


async def respond_as_leads(channel: str) -> None:
    """'@Ban lãnh đạo' broadcast: each lead replies IN ORDER, so later leads see the
    earlier replies (and any tasks already created) in the recent-message context."""
    for slug in LEAD_SLUGS:
        try:
            await respond_as_agent(channel, slug)
        except Exception as e:  # noqa: BLE001
            print(f"[api] respond_as_leads({slug}) error:", e)


# Agents currently GENERATING a chat reply (no task row exists yet). Kept so the WS
# `hello` snapshot can restore the ⌨️ pose on reconnect — otherwise switching tabs mid-
# generation loses it (chat-composing is transient, unlike a durable in_progress task).
_COMPOSING: set[str] = set()


async def _office_activity(slug: str, state: str) -> None:
    """Push a live 'agent is composing a reply' signal to the office so the pixel agent
    shows the ⌨️ typing pose WHILE it generates a chat reply (a transient act that has
    no task row, so the task-status animation never covered it). Also tracks the composing
    set so a reconnect snapshot can restore it. Best-effort."""
    if state == "typing":
        _COMPOSING.add(slug)
    elif state == "idle":
        _COMPOSING.discard(slug)
    try:
        await hub.broadcast({"type": "activity", "agent": slug, "state": state})
    except Exception:  # noqa: BLE001
        pass


async def respond_as_agent(channel: str, slug: str) -> None:
    """Generate one in-character reply for a directly-tagged agent (a single @mention, or a
    lead in the @leads broadcast). Agents only ever reply when tagged — there is no untagged
    fan-out — so this always produces an answer."""
    if slug in _OWNER_SLUGS:
        return  # owners are humans — never auto-reply as them, even if @mentioned/added
    try:
        _CTX_CHANNEL.set(channel)  # tickets created in this reply remember their group
        agent = await q(f"SELECT doc FROM company.agents WHERE slug={db.lit(slug)}")
        if not agent:
            return
        await _office_activity(slug, "typing")  # office shows the ⌨️ typing pose live
        try:
            rows = await q(
                "SELECT coalesce(json_agg(json_build_object("
                "'from', coalesce(from_agent,'CEO/CTO'), 'body', body) ORDER BY id), '[]') "
                f"FROM (SELECT * FROM company.messages WHERE channel_id={db.lit(channel)} ORDER BY id DESC LIMIT 12) s"
            ) or []
            transcript = "\n".join(f"{m['from']}: {m['body']}" for m in rows)
            reply = await _compose_reply(agent, transcript, "")
        finally:
            await _office_activity(slug, "idle")  # always clear, even on error
        # Network drop (rớt mạng/timeout): never persist the raw error as the agent's
        # answer. A DIRECT ask → tell the owner it's a connection drop (retry by @-ing
        # again). A group fan-out → stay silent (don't spam N notices when the net is down).
        if reply == _NET_DROP:
            # Connection drop on a tagged ask → tell the owner it dropped (retry by @-ing again).
            await ex(
                "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
                f"VALUES ({db.lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(channel)}), "
                f"{db.lit(slug)}, NULL, 'note', {db.lit(_NET_DROP_NOTICE)})"
            )
            return
        await ex(
            "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
            f"VALUES ({db.lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(channel)}), "
            f"{db.lit(slug)}, NULL, 'chat', {db.lit(reply[:8000])})"
        )
    except Exception as e:  # noqa: BLE001
        print("[api] respond_as_agent error:", e)


# ---- staff worker: assigned tasks get WORKED by the assignee's LLM (bounded) ----
# One state-machine STEP per tick (not a whole task) so the office animates the
# progress and cost stays paced. Bounds: NEXUS attempt cap 3 → escalate (enforced
# in DB too), only hired assignees, sample ENG-001 excluded, WORKER_ENABLED switch.
WORKER_ENABLED = os.environ.get("WORKER_ENABLED", "1") == "1"
WORKER_POLL_S = float(os.environ.get("WORKER_POLL_S", "5"))
TERMINAL_STATUSES = ("accepted", "escalated", "deferred", "cancelled")


async def _task_comments_json(tid: str) -> str:
    rows = await q(
        "SELECT coalesce(json_agg(json_build_object('by',coalesce(agent,'CEO/CTO'),'body',body) ORDER BY id),'[]') "
        f"FROM (SELECT * FROM company.task_comments WHERE task_id={db.lit(tid)} ORDER BY id DESC LIMIT 8) s"
    )
    return json.dumps(rows or [], ensure_ascii=False)[:6000]


async def _transition(tid: str, frm: str, to: str, actor: str, reason: str, attempt: int | None = None) -> None:
    set_attempt = f", attempt={attempt}" if attempt is not None else ""
    await ex(
        f"UPDATE company.tasks SET status={db.lit(to)}{set_attempt}, updated_at=now() WHERE id={db.lit(tid)};\n"
        "INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason) "
        f"VALUES ('task', {db.lit(tid)}, {db.lit(frm)}, {db.lit(to)}, {db.lit(actor)}, {db.lit(reason)});"
    )


async def _work_step() -> None:
    """Advance ONE task ONE step. todo→in_progress→(work)→in_qa→(review)→accepted
    | rejected(→in_progress, attempt+1) | escalated when the 3-try cap is hit."""
    t = await q(
        "SELECT json_build_object('id',id,'title',title,'detail',detail,'assignee',assignee,"
        "'reporter',reporter,'status',status,'attempt',attempt) "
        "FROM company.tasks t WHERE t.status IN ('todo','in_progress','in_qa','rejected') "
        "AND t.assignee IS NOT NULL AND t.engagement_id <> 'ENG-001' "
        "AND EXISTS (SELECT 1 FROM company.agents a WHERE a.slug=t.assignee AND a.hired AND NOT a.is_owner) "
        "ORDER BY t.updated_at ASC LIMIT 1"
    )
    if not t:
        return
    tid, st, assignee = t["id"], t["status"], t["assignee"]
    _CTX_TASK.set(tid)  # LLM usage in this step meters against the task

    if st == "todo":
        await _transition(tid, "todo", "in_progress", assignee, "nhận việc, bắt đầu làm")
        return

    if st == "rejected":  # revise round: hand it back to the assignee
        await _transition(tid, "rejected", "in_progress", assignee, f"sửa theo review (attempt {t['attempt']}/3)")
        return

    if st == "in_progress":  # the assignee produces the actual work product
        doc = await q(f"SELECT doc FROM company.agents WHERE slug={db.lit(assignee)}") or {}
        persona = _persona_body(doc.get("path", "")) or str(doc.get("description", ""))
        system = (
            persona + "\n\n---\nBạn là staff đang LÀM một task ticket. Hãy tạo DELIVERABLE thật "
            "(markdown, ≤400 từ, đúng chuyên môn, cụ thể — không hứa hẹn chung chung). Nếu là vòng "
            "sửa, đọc comment review gần nhất và sửa đúng ý đó."
            + await _learnings_block(assignee)  # apply what this agent has learned
        )
        user = (
            f"Ticket {tid}: {t['title']}\nMô tả: {t.get('detail') or '(không có)'}\n"
            f"Attempt: {t['attempt']}/3\nComment gần đây (mới nhất trước): {await _task_comments_json(tid)}\n"
            "→ Trả về deliverable hoàn chỉnh."
        )
        work = await _llm_reply(assignee, system, user, tools="read")  # can look up, can't mutate
        if work == _NET_DROP:  # rớt mạng — giữ task ở in_progress, tự thử lại tick sau
            print(f"[worker] {tid} in_progress: net drop — sẽ tự retry khi có mạng")
            return
        await ex(
            "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
            f"VALUES ({db.lit(tid)}, {db.lit(assignee)}, {db.lit(work[:8000])}, ARRAY[]::text[]);"
        )
        # Document-first: the deliverable is ALSO saved to the knowledge base so other
        # agents can read & follow it (create-or-update, so a revised round overwrites).
        eng = t.get("engagement") or (await scalar(f"SELECT engagement_id FROM company.tasks WHERE id={db.lit(tid)}")) or "Chung"
        await _t_write_doc(assignee, {
            "folder": f"{eng}/deliverables", "name": f"{tid}.md", "format": "markdown",
            "content": f"# {tid} — {t['title']}\n\n{work}",
        })
        await _transition(tid, "in_progress", "in_qa", assignee, "nộp deliverable, chờ review")
        return

    if st == "in_qa":  # the reporting lead reviews; PO is the fallback gatekeeper
        reviewer = t.get("reporter") if t.get("reporter") in WRITE_SLUGS else "product-owner"
        doc = await q(f"SELECT doc FROM company.agents WHERE slug={db.lit(reviewer)}") or {}
        persona = _persona_body(doc.get("path", "")) or str(doc.get("description", ""))
        system = (
            persona + "\n\n---\nBạn đang REVIEW deliverable của staff cho một ticket. Khắt khe nhưng "
            "công bằng: đủ và đúng yêu cầu → ACCEPT; thiếu/sai → REJECT kèm lý do sửa được. "
            'DÒNG ĐẦU TIÊN của câu trả lời BẮT BUỘC là "VERDICT: ACCEPT" hoặc "VERDICT: REJECT", '
            "các dòng sau là nhận xét ngắn."
        )
        user = (
            f"Ticket {tid}: {t['title']}\nMô tả: {t.get('detail') or '(không có)'}\n"
            f"Deliverable + lịch sử (mới nhất trước): {await _task_comments_json(tid)}"
        )
        verdict = await _llm_reply(reviewer, system, user, tools=None)
        if verdict == _NET_DROP:  # rớt mạng — giữ task ở in_qa, tự thử lại tick sau
            print(f"[worker] {tid} review: net drop — sẽ tự retry khi có mạng")
            return
        first = (verdict.splitlines() or [""])[0].upper()
        await ex(
            "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
            f"VALUES ({db.lit(tid)}, {db.lit(reviewer)}, {db.lit(verdict[:8000])}, ARRAY[]::text[]);"
        )
        if "ACCEPT" in first:
            await _transition(tid, "in_qa", "accepted", reviewer, "review đạt")
            await _post_completion(tid, reviewer)
        elif t["attempt"] >= 3:  # NEXUS: 3 failed rounds → escalate to the owner
            await _transition(tid, "in_qa", "escalated", reviewer, "quá 3 vòng review — escalate lên CEO/CTO")
        else:
            await _transition(tid, "in_qa", "rejected", reviewer, "review chưa đạt", attempt=min(t["attempt"] + 1, 3))
            # SELF-LEARNING from experience: the assignee records the reviewer's
            # feedback as a lesson (deterministic — not model-dependent) so the next
            # round and future tasks apply it. Self-scoped: written to the assignee.
            notes = "\n".join(verdict.splitlines()[1:]).strip() or verdict.strip()
            await _t_record_learning(assignee, {
                "content": f"Từ {tid}: deliverable bị trả lại — {notes[:400]}",
                "kind": "correction", "source": "experience", "task_id": tid,
            })
        # The roll-up report runs from worker_loop every tick (so a net-dropped report
        # retries by itself), not only right after a transition.


async def _post_completion(tid: str, reviewer: str) -> None:
    """A DONE ticket carries a completion report: what was done + REAL metrics —
    processing time, tokens (+cost where priced), rejected rounds, blockers."""
    try:
        m = await q(
            "SELECT json_build_object("
            "'title',t.title,'assignee',t.assignee,'attempt',t.attempt,'blocked',t.blocked_by,"
            "'secs',(SELECT extract(epoch FROM (now() - min(e.created_at)))::int FROM company.status_events e "
            " WHERE e.entity_type='task' AND e.entity_id=t.id AND e.to_status='in_progress'),"
            "'tin',(SELECT coalesce(sum(input_tokens),0) FROM company.usage_events u WHERE u.task_id=t.id),"
            "'tout',(SELECT coalesce(sum(output_tokens),0) FROM company.usage_events u WHERE u.task_id=t.id),"
            "'cost',(SELECT round(sum(cost_usd)::numeric,4) FROM company.usage_costed u WHERE u.task_id=t.id AND cost_usd IS NOT NULL),"
            "'summary',(SELECT left(c.body,200) FROM company.task_comments c WHERE c.task_id=t.id AND c.agent=t.assignee "
            " ORDER BY c.id DESC LIMIT 1)"
            f") FROM company.tasks t WHERE t.id={db.lit(tid)}"
        ) or {}
        secs = int(m.get("secs") or 0)
        dur = f"{secs // 60}m {secs % 60}s" if secs >= 60 else f"{secs}s"
        blocked = m.get("blocked")
        if isinstance(blocked, list):
            blocked = ", ".join(blocked)
        cost = m.get("cost")
        body = (
            f"✅ **Hoàn tất {tid}** — {m.get('title', '')}\n\n"
            f"- **Người làm:** @{m.get('assignee')} · **Review:** @{reviewer}\n"
            f"- **Thời gian xử lý:** {dur} (từ lúc nhận việc)\n"
            f"- **Tokens:** {m.get('tin', 0)} in / {m.get('tout', 0)} out"
            + (f" (~${cost})" if cost is not None else "")
            + f"\n- **Số vòng bị reject:** {m.get('attempt', 0)}/3\n"
            f"- **Blocked bởi:** {blocked or 'không'}\n"
            f"- **Tóm tắt deliverable:** {m.get('summary') or '(xem comment phía trên)'}"
        )
        await ex(
            "INSERT INTO company.task_comments (task_id, agent, body, mentions) "
            f"VALUES ({db.lit(tid)}, {db.lit(reviewer)}, {db.lit(body[:8000])}, ARRAY[]::text[]);"
        )
    except Exception as e:  # noqa: BLE001
        print("[worker] completion summary error:", e)


async def _maybe_report() -> None:
    """Per ORIGIN GROUP (no hardcoded channel): when every task raised from a given
    chat group is terminal and there are new terminal transitions since that group's
    marker, the lead who raised the most tickets posts the roll-up BACK INTO that
    group. Markers live in office_config key 'ops_report' as {channelId: lastEventId}."""
    markers: dict = await q("SELECT value FROM company.office_config WHERE key='ops_report'") or {}
    chans = await q(
        "SELECT coalesce(json_agg(DISTINCT origin_channel),'[]') FROM company.tasks "
        "WHERE origin_channel IS NOT NULL"
    ) or []
    for chan in chans:
        last = int(markers.get(chan) or 0)
        open_n = await scalar(
            f"SELECT count(*) FROM company.tasks WHERE origin_channel={db.lit(chan)} "
            "AND status NOT IN ('accepted','escalated','deferred','cancelled')"
        )
        max_ev = await scalar(
            "SELECT coalesce(max(e.id),0) FROM company.status_events e "
            "JOIN company.tasks t ON t.id=e.entity_id AND e.entity_type='task' "
            f"WHERE t.origin_channel={db.lit(chan)} AND e.to_status IN ('accepted','escalated','deferred','cancelled')"
        )
        if open_n != "0" or int(max_ev or 0) <= last:
            continue
        if await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(chan)} AND NOT archived") != "1":
            markers[chan] = int(max_ev)  # group gone — mark covered, don't retry forever
            continue
        done = await q(
            "SELECT coalesce(json_agg(json_build_object('id',t.id,'title',t.title,'status',t.status,"
            "'assignee',t.assignee,'attempt',t.attempt,'reporter',t.reporter) ORDER BY t.id),'[]') "
            f"FROM company.tasks t WHERE t.origin_channel={db.lit(chan)} "
            "AND t.status IN ('accepted','escalated','deferred','cancelled') "
            "AND EXISTS (SELECT 1 FROM company.status_events e WHERE e.entity_type='task' AND e.entity_id=t.id "
            f"AND e.to_status IN ('accepted','escalated','deferred','cancelled') AND e.id > {last})"
        ) or []
        # The reporting lead = whoever raised the most tickets in this wave (they own
        # the delegation), falling back to the Engagement Director.
        counts: dict[str, int] = {}
        for t in done:
            if t.get("reporter"):
                counts[t["reporter"]] = counts.get(t["reporter"], 0) + 1
        reporter = max(counts, key=counts.get) if counts else "engagement-director"
        doc = await q(f"SELECT doc FROM company.agents WHERE slug={db.lit(reporter)}") or {}
        persona = _persona_body(doc.get("path", "")) or reporter
        system = (
            persona + "\n\n---\nViết BÁO CÁO ROLL-UP ngắn (markdown) gửi CEO/CTO trong group chat "
            "nơi việc được giao: mỗi task một dòng (id — kết quả — ai làm — mấy vòng review), "
            "chốt tình hình chung, nêu rõ task escalated cần CEO/CTO quyết. Không bịa thêm task."
        )
        report = await _llm_reply(
            reporter, system,
            "Các task vừa hoàn tất đợt này: " + json.dumps(done, ensure_ascii=False)[:5000],
            tools=None,
        )
        if report == _NET_DROP:  # rớt mạng — KHÔNG advance marker, KHÔNG post → retry tick sau
            print(f"[worker] báo cáo cho {chan}: net drop — sẽ tự retry khi có mạng")
            continue
        markers[chan] = int(max_ev)
        await ex(
            "INSERT INTO company.messages (channel_id, from_agent, to_agent, kind, body) "
            f"VALUES ({db.lit(chan)}, {db.lit(reporter)}, NULL, 'chat', "
            f"{db.lit(('📋 **Báo cáo kết quả đợt giao việc**\n\n' + report)[:8000])});"
        )
    await ex(
        "INSERT INTO company.office_config (key, value, updated_at) "
        f"VALUES ('ops_report', {db.lit(json.dumps(markers))}::jsonb, now()) "
        "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();"
    )


async def worker_loop() -> None:
    while True:
        try:
            await _refresh_budget()  # cheap; also drives auto-stop + warnings
            if WORKER_ENABLED and not _budget["blocked"]:
                await _work_step()
                _CTX_TASK.set(None)  # roll-up usage isn't one task's
                await _maybe_report()  # every tick → a net-dropped report retries itself
        except Exception as e:  # noqa: BLE001
            print("[worker] error:", e)
        await asyncio.sleep(WORKER_POLL_S)


# ---- REST: durable Office config (per-department floor) ----
@app.get("/api/config/floors")
async def floors_get():
    return await q("SELECT coalesce((SELECT value FROM company.office_config WHERE key='floors'), '{}'::jsonb)") or {}


@app.post("/api/config/floors")
async def floors_set(payload: dict = Body(...)):
    slug = str(payload.get("slug") or "")
    if not slug:
        raise HTTPException(400, "slug required")
    idx = max(0, min(64, int(payload.get("index") or 0)))
    await ex(
        "INSERT INTO company.office_config (key, value) "
        f"VALUES ('floors', jsonb_build_object({db.lit(slug)}, {idx}::int)) "
        f"ON CONFLICT (key) DO UPDATE SET value = company.office_config.value || jsonb_build_object({db.lit(slug)}, {idx}::int), "
        "updated_at = now()"
    )
    return {"ok": True}


# ---- REST: LLM providers + per-agent model config ----
@app.get("/api/providers")
async def providers_get():
    agents = await q(
        "SELECT coalesce(json_agg(json_build_object("
        "'slug', a.slug, 'name', a.name, 'division', a.division, "
        "'provider', r.provider, 'model', r.model) ORDER BY a.division, a.name), '[]') "
        "FROM company.agents a LEFT JOIN company.agent_runtime r ON r.slug = a.slug "
        "WHERE a.hired AND NOT a.is_owner"  # owners are humans — no LLM runtime
    ) or []
    # Effective access = BASE perms (all) ∪ LEAD perms (WRITE_SLUGS) ∪ granted perms.
    # Resolved from the ONE catalog (company.permissions) so labels/tools aren't re-listed.
    granted_map = await q(
        "SELECT coalesce(json_object_agg(agent, perms),'{}') FROM ("
        "SELECT agent, json_agg(permission) perms FROM company.agent_permissions GROUP BY agent) t"
    ) or {}
    for a in agents:
        keys: list[str] = []
        seen: set[str] = set()
        for k in (*_BASE_PERM_KEYS, *( _LEAD_PERM_KEYS if a["slug"] in WRITE_SLUGS else ()),
                  *(granted_map.get(a["slug"]) or [])):
            if k not in seen:
                seen.add(k); keys.append(k)
        a["permissions"] = keys
        a["basePermissions"] = list(_BASE_PERM_KEYS) + (list(_LEAD_PERM_KEYS) if a["slug"] in WRITE_SLUGS else [])
    # token price ($/1M in·out) per model, resolved through the same pricing key the
    # metering uses (Claude alias → _METER_MODEL; GPT id as-is).
    prices = await q(
        "SELECT coalesce(json_object_agg(model, json_build_object("
        "'in',input_per_mtok,'out',output_per_mtok)),'{}') FROM company.model_pricing"
    ) or {}

    def _priced(pid: str, m: dict) -> dict:
        key = _METER_MODEL.get(m["id"], m["id"]) if pid == "claude" else m["id"]
        pr = prices.get(key)
        return {**m, "inUsd": (float(pr["in"]) if pr else None), "outUsd": (float(pr["out"]) if pr else None)}

    return {
        "providers": [
            {"id": k, "label": v["label"], "configured": _provider_configured(k),
             "models": [_priced(k, m) for m in v["models"]]}
            for k, v in PROVIDERS.items()
        ],
        "default": {"provider": DEFAULT_PROVIDER, "model": DEFAULT_MODEL},
        "agents": agents,
        "permissionCatalog": await _perm_catalog(),  # single source: labels/tools for the Access Tools column
        "baseKeys": list(_BASE_PERM_KEYS),  # the 4 perms every hired agent carries
    }


# ---- Access Tools: canonical permission catalog management --------------------
_PERM_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")


async def _perm_fields(payload: dict) -> dict:
    label = str(payload.get("label") or "").strip()
    if not label:
        raise HTTPException(400, "cần nhãn (label) cho quyền")
    tools = [str(t).strip() for t in (payload.get("tools") or []) if str(t).strip()]
    return {
        "label": label,
        "description": (str(payload.get("description") or "").strip() or None),
        "tools": tools,
        "high_risk": bool(payload.get("highRisk")),
    }


@app.get("/api/permissions")
async def permissions_get():
    """The canonical Access Tools catalog + how many hired agents hold each (granted).
    Base/lead perms every agent/lead carries are flagged so the UI can explain coverage."""
    cat = await _perm_catalog()
    counts = await q(
        "SELECT coalesce(json_object_agg(permission, n),'{}') FROM ("
        "SELECT permission, count(*) n FROM company.agent_permissions GROUP BY permission) t"
    ) or {}
    for p in cat:
        p["grantedCount"] = int(counts.get(p["key"], 0) or 0)
        p["base"] = p["key"] in _BASE_PERM_KEYS
        p["lead"] = p["key"] in _LEAD_PERM_KEYS
    return {"permissions": cat, "baseKeys": list(_BASE_PERM_KEYS), "leadKeys": list(_LEAD_PERM_KEYS)}


@app.post("/api/permissions")
async def permission_create(payload: dict = Body(...)):
    """Add a new permission to the catalog (owner / Operations Manager)."""
    key = str(payload.get("key") or "").strip().lower()
    if not _PERM_KEY_RE.match(key):
        raise HTTPException(400, "key phải là chữ thường/số/gạch dưới, bắt đầu bằng chữ (2–40 ký tự)")
    if await scalar(f"SELECT 1 FROM company.permissions WHERE key={db.lit(key)}") == "1":
        raise HTTPException(400, f"quyền '{key}' đã tồn tại")
    g = await _perm_fields(payload)
    nextsort = int(await scalar("SELECT coalesce(max(sort),0)+10 FROM company.permissions") or "100")
    await ex(
        "INSERT INTO company.permissions (key,label,description,tools,high_risk,builtin,sort) VALUES ("
        f"{db.lit(key)}, {db.lit(g['label'])}, {db.lit(g['description'])}, {_pg_text_array(g['tools'])}, "
        f"{'true' if g['high_risk'] else 'false'}, false, {nextsort})"
    )
    return {"ok": True, "key": key}


@app.post("/api/permissions/{key}")
async def permission_update(key: str, payload: dict = Body(...)):
    """Edit a permission's label / description / tools / risk (builtin keys editable too)."""
    if await scalar(f"SELECT 1 FROM company.permissions WHERE key={db.lit(key)}") != "1":
        raise HTTPException(404, f"quyền '{key}' không tồn tại")
    g = await _perm_fields(payload)
    await ex(
        f"UPDATE company.permissions SET label={db.lit(g['label'])}, description={db.lit(g['description'])}, "
        f"tools={_pg_text_array(g['tools'])}, high_risk={'true' if g['high_risk'] else 'false'} "
        f"WHERE key={db.lit(key)}"
    )
    return {"ok": True, "key": key}


@app.delete("/api/permissions/{key}")
async def permission_delete(key: str):
    """Delete a non-builtin permission (cascades: revokes it from every agent that held it)."""
    row = await q(
        f"SELECT json_build_object('builtin',builtin) FROM company.permissions WHERE key={db.lit(key)}"
    )
    if not row:
        raise HTTPException(404, f"quyền '{key}' không tồn tại")
    if row.get("builtin"):
        raise HTTPException(400, "không thể xoá quyền lõi (builtin) — chỉ sửa được")
    await ex(f"DELETE FROM company.permissions WHERE key={db.lit(key)}")
    return {"ok": True, "key": key}


@app.post("/api/agent-runtime")
async def agent_runtime_set(payload: dict = Body(...)):
    slug = str(payload.get("slug") or "")
    provider = str(payload.get("provider") or "")
    model = str(payload.get("model") or "")
    if provider not in PROVIDERS:
        raise HTTPException(400, "unknown provider")
    if model not in [m["id"] for m in PROVIDERS[provider]["models"]]:
        raise HTTPException(400, "unknown model for provider")
    if await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(slug)} AND hired") != "1":
        raise HTTPException(404, "agent not found / not hired")
    await ex(
        "INSERT INTO company.agent_runtime (slug, provider, model) "
        f"VALUES ({db.lit(slug)}, {db.lit(provider)}, {db.lit(model)}) "
        "ON CONFLICT (slug) DO UPDATE SET provider=EXCLUDED.provider, model=EXCLUDED.model, updated_at=now()"
    )
    return {"ok": True}


@app.post("/api/agent-runtime/bulk")
async def agent_runtime_bulk(payload: dict = Body(...)):
    """Set the same provider/model for MANY agents at once (all / a division / a
    filtered set). Only hired slugs are written; unknown ones are ignored."""
    provider = str(payload.get("provider") or "")
    model = str(payload.get("model") or "")
    slugs = [str(x) for x in (payload.get("slugs") or []) if isinstance(x, str)]
    if provider not in PROVIDERS:
        raise HTTPException(400, "unknown provider")
    if model not in [m["id"] for m in PROVIDERS[provider]["models"]]:
        raise HTTPException(400, "unknown model for provider")
    if not slugs:
        raise HTTPException(400, "chọn ít nhất 1 agent")
    valid = await q(
        "SELECT coalesce(json_agg(slug),'[]') FROM company.agents "
        f"WHERE hired AND NOT is_owner AND slug = ANY(ARRAY[{','.join(db.lit(s) for s in slugs)}]::text[])"
    ) or []
    if not valid:
        return {"ok": True, "updated": 0}
    values = ", ".join(f"({db.lit(s)}, {db.lit(provider)}, {db.lit(model)})" for s in valid)
    await ex(
        f"INSERT INTO company.agent_runtime (slug, provider, model) VALUES {values} "
        "ON CONFLICT (slug) DO UPDATE SET provider=EXCLUDED.provider, model=EXCLUDED.model, updated_at=now()"
    )
    return {"ok": True, "updated": len(valid)}


# ---- WebSocket: live office stream ----
@app.websocket("/ws/office")
async def ws_office(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    try:
        snap = await q(queries.OFFICE_SNAPSHOT_SQL)
        # composing = agents mid chat-reply (transient, not a task) → restores ⌨️ on reconnect
        await ws.send_json({"type": "hello", "composing": list(_COMPOSING), **(snap or {})})
        while True:
            await ws.receive_text()  # keep the connection open; the office only listens
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


# ---- Static FE (mount LAST so /api and /ws win) — the single-server story ----
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="fe")
