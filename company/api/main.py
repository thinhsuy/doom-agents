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
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import db
import queries

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
    task = asyncio.create_task(poll_loop())
    worker = asyncio.create_task(worker_loop())  # staff agents work assigned tasks
    try:
        yield
    finally:
        task.cancel()
        worker.cancel()


app = FastAPI(title="Agency OS API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ---- REST: live data ----
@app.get("/api/health")
async def health():
    return {"ok": True, "clients": len(hub.clients), "cursor": cursor}


@app.get("/api/workspace")
async def workspace():
    return await q(queries.WORKSPACE_SQL)


@app.get("/api/decisions")
async def decisions():
    return await q(queries.DECISIONS_SQL)


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


@app.get("/api/agents")
async def agents():
    docs = await q("SELECT coalesce(json_agg(doc ORDER BY division, name), '[]') FROM company.agents") or []
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
async def chat_get():
    return await q(queries.CHAT_SQL)


@app.post("/api/chat/send")
async def chat_send(payload: dict = Body(...)):
    channel = str(payload.get("channel") or "")
    body = str(payload.get("body") or "").strip()
    to_agent = payload.get("toAgent")
    kind = payload.get("kind") or "chat"
    if not channel or not body:
        raise HTTPException(400, "channel + body required")
    if await scalar(f"SELECT 1 FROM company.channels WHERE id={db.lit(channel)} AND NOT archived") != "1":
        raise HTTPException(404, f"channel '{channel}' not found")
    members: list[str] = await q(
        f"SELECT coalesce(json_agg(agent ORDER BY agent),'[]') FROM company.channel_members WHERE channel_id={db.lit(channel)}"
    ) or []
    # '@leads' is a broadcast, not an agent row — store to_agent NULL (group message).
    broadcast = to_agent == "@leads"
    if broadcast and members and not set(LEAD_SLUGS) <= set(members):
        raise HTTPException(400, "nhóm này không có đủ Ban lãnh đạo — tag từng người hoặc gửi không tag")
    if to_agent and not broadcast and members and to_agent not in members:
        raise HTTPException(400, f"'{to_agent}' không phải thành viên nhóm này")
    stored_to = None if broadcast else to_agent
    row = await q(
        "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
        f"VALUES ({db.lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(channel)}), "
        f"NULL, {db.lit(stored_to)}, {db.lit(kind)}, {db.lit(body[:8000])}) "
        "RETURNING json_build_object('id',id,'channelId',channel_id,'engagementId',engagement_id,"
        "'taskId',task_id,'fromAgent',from_agent,'toAgent',to_agent,'kind',kind,'body',body,'createdAt',created_at)"
    )
    # Reply triggers (async, best-effort):
    #  • '@leads'      → the leadership roster answers in order.
    #  • '@one-agent'  → that agent answers.
    #  • NO mention in a channel WITH members → real-office behavior: every member is
    #    triggered IN ORDER, each may answer or silently PASS (only those with real
    #    input speak). Channels without members keep the old quiet behavior.
    replying = False
    if broadcast:
        replying = True
        asyncio.create_task(respond_as_leads(channel))
    elif to_agent:
        if await scalar(f"SELECT 1 FROM company.agents WHERE slug={db.lit(to_agent)} AND hired") == "1":
            replying = True
            asyncio.create_task(respond_as_agent(channel, str(to_agent)))
    elif members:
        replying = True
        asyncio.create_task(respond_as_members(channel, members))
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
async def chat_create_channel(payload: dict = Body(...)):
    """Owner creates a group chat and picks its agent members."""
    name = str(payload.get("name") or "").strip()
    topic = (payload.get("topic") or None) and str(payload["topic"]).strip()[:300]
    members = [s for s in (payload.get("members") or []) if isinstance(s, str)]
    if not name:
        raise HTTPException(400, "name required")
    if not members:
        raise HTTPException(400, "chọn ít nhất 1 agent thành viên")
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
_DB_VIEW_ENUM = ["overview", "agents", "candidates", "tasks", "channels", "engagements"]
_DB_TOOL_DESC = (
    "Đọc dữ liệu công ty (CHỈ ĐỌC). view: 'overview'=tổng số nhân sự biên chế + theo division; "
    "'agents'=danh sách agent biên chế (lọc theo division/keyword); "
    "'candidates'=kho ứng viên CHƯA tuyển trong catalogue (~220 persona — dùng để sourcing, "
    "lọc theo division/keyword); 'tasks'=task; 'channels'=kênh chat; 'engagements'=engagement."
)
# Tool schemas as (name, description, properties, required) — rendered per provider.
_TASK_STATUSES = ["todo", "in_progress", "in_qa", "rejected", "accepted", "deferred", "escalated", "cancelled"]
_TOOL_DEFS = {
    "view_db": (
        _DB_TOOL_DESC,
        {
            "view": {"type": "string", "enum": _DB_VIEW_ENUM},
            "division": {"type": "string", "description": "lọc theo division (agents/candidates)"},
            "keyword": {"type": "string", "description": "lọc theo từ khoá trong tên/mô tả (agents/candidates)"},
        },
        ["view"],
    ),
    # ---- write tools (LEADS ONLY — see _tool_names_for) ----
    "create_task": (
        "Tạo task ticket mới trên bảng Task (kèm assignee nếu đã biết ai làm). Trả về id ticket.",
        {
            "title": {"type": "string", "description": "Tiêu đề ngắn gọn"},
            "detail": {"type": "string", "description": "Mô tả việc cần làm + tiêu chí xong"},
            "assignee": {"type": "string", "description": "Slug staff biên chế (tra view_db view=agents)"},
            "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
        },
        ["title", "detail"],
    ),
    "assign_task": (
        "Giao / đổi PIC một ticket cho một agent biên chế.",
        {
            "task_id": {"type": "string", "description": "vd T-201"},
            "assignee": {"type": "string", "description": "Slug agent biên chế"},
        },
        ["task_id", "assignee"],
    ),
    "comment_task": (
        "Bình luận vào một ticket (dưới danh nghĩa của bạn).",
        {
            "task_id": {"type": "string"},
            "body": {"type": "string"},
        },
        ["task_id", "body"],
    ),
    "update_task_status": (
        "Chuyển trạng thái ticket (dùng khi review: accepted / rejected; vào 'rejected' sẽ tăng attempt về phía cap 3).",
        {
            "task_id": {"type": "string"},
            "status": {"type": "string", "enum": _TASK_STATUSES},
            "reason": {"type": "string", "description": "Lý do — hiện trong timeline"},
        },
        ["task_id", "status"],
    ),
    "raise_decision": (
        "Tạo TICKET QUYẾT ĐỊNH cho CEO/CTO khi cần họ DUYỆT / CHỌN HƯỚNG / CẤP QUYỀN mà bạn "
        "không được tự quyết. Ticket hiện ở tab Quyết định, trạng thái 'chờ duyệt'. Trả về id (vd D-3).",
        {
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
        ["title", "question"],
    ),
    # ---- knowledge base (EVERY agent — document-first, implement-second) ----
    "list_docs": (
        "Liệt kê tài liệu công ty: các folder và file trong đó (không kèm nội dung). "
        "Đọc trước khi làm để không viết trùng và để follow tài liệu người khác.",
        {"folder": {"type": "string", "description": "Lọc theo 1 folder (bỏ trống = tất cả)"}},
        [],
    ),
    "read_doc": (
        "Đọc nội dung đầy đủ một tài liệu (theo folder+name).",
        {"folder": {"type": "string"}, "name": {"type": "string"}},
        ["folder", "name"],
    ),
    "create_folder": (
        "Tạo folder tài liệu (vd 'Dự án Thanh toán/specs'). Idempotent.",
        {"path": {"type": "string"}, "description": {"type": "string"}},
        ["path"],
    ),
    "write_doc": (
        "Viết/cập nhật một tài liệu (create-or-update theo folder+name). Đây là cách bạn "
        "thực thi DOCUMENT-FIRST: trình bày việc sẽ làm để agent khác đọc & follow. "
        "format mặc định 'markdown'; dùng 'mermaid' cho sơ đồ, 'ppt'/'html'... nếu cần.",
        {
            "folder": {"type": "string", "description": "vd 'Dự án X/specs'"},
            "name": {"type": "string", "description": "Tên file, vd 'kien-truc.md'"},
            "content": {"type": "string"},
            "format": {"type": "string",
                       "enum": ["markdown", "mermaid", "ppt", "text", "json", "code", "csv", "html"]},
        },
        ["folder", "name", "content"],
    ),
    # ---- self-learning (EVERY agent — writes to ITS OWN learnings only) ----
    "record_learning": (
        "TỰ HỌC: ghi lại một kỹ năng/kiến thức/bài học bạn RÚT RA (khi làm việc, hoặc khi CEO/CTO "
        "nhắc/sửa bạn) để TỰ ĐIỀU CHỈNH — lần sau bạn sẽ được nhắc lại điều này. Bạn CHỈ ghi được "
        "cho CHÍNH MÌNH, không thể chỉnh skill của agent khác. Viết ngắn gọn, hành động được.",
        {
            "content": {"type": "string", "description": "Điều đã học / cần nhớ, dạng hành động được"},
            "kind": {"type": "string", "enum": ["skill", "knowledge", "lesson", "correction"]},
            "source": {"type": "string", "enum": ["self", "experience", "owner"],
                       "description": "self=tự đúc kết, experience=từ việc đã làm, owner=CEO/CTO nhắc"},
        },
        ["content"],
    ),
}

_DOC_TOOL_NAMES = ["list_docs", "read_doc", "create_folder", "write_doc"]
_SELF_TOOL_NAMES = ["record_learning"]  # open to every real agent, self-scoped


def _tool_names_for(slug: str | None) -> list[str]:
    if slug == "__reader__":
        return ["view_db"]  # worker deliverable step: look up only, no tool writes
    base = ["view_db", *_DOC_TOOL_NAMES, *_SELF_TOOL_NAMES]  # KB + self-learning for every real agent
    if slug in WRITE_SLUGS:
        return [*base, "create_task", "assign_task", "comment_task", "update_task_status", "raise_decision"]
    return base


def _tools_openai(slug: str | None) -> list:
    return [
        {"type": "function", "function": {
            "name": n, "description": _TOOL_DEFS[n][0],
            "parameters": {"type": "object", "properties": _TOOL_DEFS[n][1], "required": _TOOL_DEFS[n][2]},
        }}
        for n in _tool_names_for(slug)
    ]


def _tools_anthropic(slug: str | None) -> list:
    return [
        {"name": n, "description": _TOOL_DEFS[n][0],
         "input_schema": {"type": "object", "properties": _TOOL_DEFS[n][1], "required": _TOOL_DEFS[n][2]}}
        for n in _tool_names_for(slug)
    ]


_TOOL_ROUNDS = 6  # bound the tool-call loop so a reply always terminates


async def _run_db_view(view: str, division: str | None = None, keyword: str | None = None) -> str:
    """Execute one whitelisted read-only view; return compact JSON (or {error})."""
    v = (view or "").strip().lower()

    def _people_where(hired: bool) -> str:
        where = "WHERE hired" if hired else "WHERE NOT hired"
        if division:
            where += f" AND division={db.lit(division.strip().lower())}"  # db.lit = injection-safe
        if keyword:
            kw = db.lit("%" + keyword.strip() + "%")
            where += f" AND (name ILIKE {kw} OR coalesce(description,'') ILIKE {kw})"
        return where

    if v in ("overview", "company", "headcount"):
        sql = (
            "SELECT json_build_object("
            "'total_hired',(SELECT count(*) FROM company.agents WHERE hired),"
            "'by_division',(SELECT json_object_agg(division,c) FROM "
            "(SELECT division,count(*) c FROM company.agents WHERE hired GROUP BY division) t))"
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
    else:
        return json.dumps({"error": f"unknown view '{view}'; valid: {_DB_VIEW_ENUM}"}, ensure_ascii=False)
    try:
        return json.dumps(await q(sql), ensure_ascii=False)[:6000]
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": str(e)[:200]}, ensure_ascii=False)


# ---- task write tools (leads only; actor identity is SERVER-SIDE, never an arg) ----
def _jerr(msg: str) -> str:
    return json.dumps({"error": msg}, ensure_ascii=False)


def _jok(**kw) -> str:
    return json.dumps({"ok": True, **kw}, ensure_ascii=False)


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
    try:
        await ex(
            "INSERT INTO company.decisions (id, title, question, why_you, raised_by, decider, urgency, "
            "status, options, recommendation, blocks, raised_at, raised_by_name, raised_by_emoji) VALUES ("
            f"{db.lit(did)}, {db.lit(title[:200])}, {db.lit(question[:2000])}, {db.lit(why)}, {db.lit(actor)}, "
            f"'CEO/CTO', {db.lit(urgency)}, 'pending', {db.lit(json.dumps(opts, ensure_ascii=False))}::jsonb, "
            f"{db.lit(rec)}, ARRAY[]::text[], now()::date, {db.lit(who.get('name') or actor)}, {db.lit(who.get('emoji') or '👤')})"
        )
    except Exception as e:  # noqa: BLE001
        return _jerr(str(e)[:200])
    return _jok(decision_id=did, status="pending", note="Đã tạo ticket quyết định, chờ CEO/CTO phê duyệt")


_DOC_FORMATS = ("markdown", "mermaid", "ppt", "text", "json", "code", "csv", "html")


async def _author_or_null(actor: str | None) -> str:
    return db.lit(actor) if actor and await _hired(actor) else "NULL"


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


async def _t_read_doc(actor: str, a: dict) -> str:
    folder, name = str(a.get("folder") or ""), str(a.get("name") or "")
    d = await q(
        "SELECT json_build_object('folder',folder,'name',name,'format',format,'content',content,'author',author) "
        f"FROM company.documents WHERE folder={db.lit(folder)} AND name={db.lit(name)}"
    )
    if not d:
        return _jerr(f"không thấy tài liệu '{folder}/{name}'")
    return json.dumps(d, ensure_ascii=False)[:8000]


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
    """Dispatch one tool call. view_db + doc tools + record_learning are open to
    EVERY agent (document-first + self-learning culture); task-write tools stay
    LEAD-only — all enforced here, server-side, regardless of what the model asks.
    record_learning/write_doc are self-scoped: actor comes from context, never args."""
    if name == "view_db":
        return await _run_db_view(str(args.get("view", "")), args.get("division"), args.get("keyword"))
    open_impl = {
        "list_docs": _t_list_docs, "read_doc": _t_read_doc,
        "create_folder": _t_create_folder, "write_doc": _t_write_doc,
        "record_learning": _t_record_learning,
    }.get(name)
    if open_impl:
        try:
            return await open_impl(actor or "", args or {})
        except Exception as e:  # noqa: BLE001
            return _jerr(str(e)[:300])
    if actor not in WRITE_SLUGS:
        return _jerr("tool này chỉ dành cho lead")
    impl = {
        "create_task": _t_create_task,
        "assign_task": _t_assign_task,
        "comment_task": _t_comment_task,
        "update_task_status": _t_update_status,
        "raise_decision": _t_raise_decision,
    }.get(name)
    if not impl:
        return _jerr(f"unknown tool '{name}'")
    try:
        return await impl(actor, args or {})
    except Exception as e:  # noqa: BLE001
        return _jerr(str(e)[:300])


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
            return (r.choices[0].message.content or "").strip() or "(mình chưa có gì để nói)"
        tools = _tools_openai(tool_slug)
        for _ in range(_TOOL_ROUNDS):
            r = await client.chat.completions.create(
                model=model, max_tokens=600, messages=messages, tools=tools, timeout=t_out,
            )
            _meter(r)
            msg = r.choices[0].message
            if not msg.tool_calls:
                return (msg.content or "").strip() or "(mình chưa có gì để nói)"
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
                out = await _exec_tool(tool_slug, tc.function.name, args)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})
        return "(mình đã tra cứu nhưng chưa kịp chốt — hỏi lại giúp nhé)"
    except Exception as e:  # noqa: BLE001
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
            return "".join(getattr(b, "text", "") for b in r.content).strip() or "(mình chưa có gì để nói)"
        tools = _tools_anthropic(tool_slug)
        for _ in range(_TOOL_ROUNDS):
            r = await client.messages.create(
                model=model_id, max_tokens=600, system=system, messages=messages, tools=tools, timeout=t_out,
            )
            _meter(r)
            if r.stop_reason != "tool_use":
                return "".join(getattr(b, "text", "") for b in r.content).strip() or "(mình chưa có gì để nói)"
            messages.append({"role": "assistant", "content": _anthropic_assistant_content(r.content)})
            results = []
            for b in r.content:
                if getattr(b, "type", None) == "tool_use":
                    out = await _exec_tool(tool_slug, b.name, b.input or {})
                    results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
            messages.append({"role": "user", "content": results})
        return "(mình đã tra cứu nhưng chưa kịp chốt — hỏi lại giúp nhé)"
    except Exception as e:  # noqa: BLE001
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


async def respond_as_agent(channel: str, slug: str, may_pass: bool = False) -> None:
    """Generate one in-character reply. may_pass=True (group broadcast, no one tagged):
    the agent is told to answer ONLY if it genuinely has relevant input, else return
    the literal token PASS — which we swallow (no message row), like a colleague who
    just reads along. A directly-@mentioned agent always answers."""
    try:
        _CTX_CHANNEL.set(channel)  # tickets created in this reply remember their group
        agent = await q(f"SELECT doc FROM company.agents WHERE slug={db.lit(slug)}")
        if not agent:
            return
        rows = await q(
            "SELECT coalesce(json_agg(json_build_object("
            "'from', coalesce(from_agent,'CEO/CTO'), 'body', body) ORDER BY id), '[]') "
            f"FROM (SELECT * FROM company.messages WHERE channel_id={db.lit(channel)} ORDER BY id DESC LIMIT 12) s"
        ) or []
        transcript = "\n".join(f"{m['from']}: {m['body']}" for m in rows)
        extra = ""
        if may_pass:
            extra = (
                "\n\nTin cuối của CEO/CTO KHÔNG tag riêng ai (gửi cả nhóm). Quy tắc văn phòng: "
                "CHỈ trả lời nếu bạn thực sự có thông tin/chuyên môn liên quan hoặc việc thuộc vai bạn. "
                "Nếu không (hoặc đồng nghiệp đã trả lời đủ trong lịch sử) → trả về DUY NHẤT chữ: PASS "
                "— không kèm giải thích, không kèm gì khác."
            )
        reply = await _compose_reply(agent, transcript, extra)
        # A pass may still arrive decorated ("PASS\n---\n(vì...)"): judge the first line.
        first_line = (reply.strip().splitlines() or [""])[0].strip().strip("*").strip().upper().rstrip(".!")
        if may_pass and first_line == "PASS":
            return  # reads along, says nothing
        await ex(
            "INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body) "
            f"VALUES ({db.lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id={db.lit(channel)}), "
            f"{db.lit(slug)}, NULL, 'chat', {db.lit(reply[:8000])})"
        )
    except Exception as e:  # noqa: BLE001
        print("[api] respond_as_agent error:", e)


async def _should_answer(slug: str, channel: str, last_msg: str) -> bool:
    """CHEAP triage (short prompt, no tools, ~8 tokens out) so a no-member fan-out
    doesn't pay a FULL reply for every agent that has nothing to say — only opt-ins
    then do the real reply. ~6–13× cheaper per non-answering member."""
    who = await q(f"SELECT json_build_object('name',name,'desc',description) FROM company.agents WHERE slug={db.lit(slug)}") or {}
    system = (
        f"Bạn là {who.get('name', slug)} — {who.get('desc', '')}. Dưới đây là 1 tin nhắn trong "
        "kênh nhóm. Bạn CÓ chuyên môn/thông tin liên quan hoặc việc thuộc vai bạn để trả lời KHÔNG? "
        "Chỉ đáp DUY NHẤT một từ: CO hoặc KHONG."
    )
    ans = await _llm_reply(slug, system, f"Tin: {last_msg}", tools=None, max_out=8)
    a = ans.strip().upper().replace("Ó", "O").replace("Ô", "O")
    return a.startswith("CO") or a.startswith("YES") or a.startswith("C ")


async def respond_as_members(channel: str, members: list[str]) -> None:
    """No-mention broadcast: PHASE 1 cheap triage picks who has something to say,
    PHASE 2 only those reply in full (in order, so later ones see earlier answers)."""
    if _budget["blocked"]:
        return
    last = await scalar(
        f"SELECT coalesce((SELECT body FROM company.messages WHERE channel_id={db.lit(channel)} "
        "ORDER BY id DESC LIMIT 1),'')"
    )
    opted: list[str] = []
    for slug in members:
        try:
            if await _should_answer(slug, channel, last[:1500]):
                opted.append(slug)
        except Exception as e:  # noqa: BLE001
            print(f"[api] triage({slug}) error:", e)
    for slug in opted:
        try:
            await respond_as_agent(channel, slug, may_pass=True)  # PASS still possible as a backstop
        except Exception as e:  # noqa: BLE001
            print(f"[api] respond_as_members({slug}) error:", e)


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
        "AND EXISTS (SELECT 1 FROM company.agents a WHERE a.slug=t.assignee AND a.hired) "
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
        _CTX_TASK.set(None)  # the roll-up report is not one task's usage
        await _maybe_report()


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
        "FROM company.agents a LEFT JOIN company.agent_runtime r ON r.slug = a.slug WHERE a.hired"
    ) or []
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
    }


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
        f"WHERE hired AND slug = ANY(ARRAY[{','.join(db.lit(s) for s in slugs)}]::text[])"
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
        await ws.send_json({"type": "hello", **(snap or {})})
        while True:
            await ws.receive_text()  # keep the connection open; the office only listens
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(ws)


# ---- Static FE (mount LAST so /api and /ws win) — the single-server story ----
if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="fe")
