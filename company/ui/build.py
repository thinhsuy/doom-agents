#!/usr/bin/env python3
"""
build.py — regenerate the console's agent roster from the repo.

Reads every agent .md in the division directories plus divisions.json, and emits
company/ui/src/data/agents.json, which App code imports directly (Vite resolves
JSON imports at build time, so the roster is bundled — no runtime fetch).

Run via `npm run data`; `npm run dev` and `npm run build` invoke it automatically.
"""

import json
import os
import re
import sys

import dbio

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "company", "ui", "src", "data", "agents.json")

# Presentation only — the authoritative division list comes from divisions.json.
DIVISION_EMOJI = {
    "academic": "🎓", "design": "🎨", "engineering": "⚙️", "finance": "💰",
    "game-development": "🎮", "gis": "🗺️", "healthcare": "🩺", "hr": "🧑‍💼",
    "marketing": "📣", "paid-media": "🎯", "product": "📦", "project-management": "📋",
    "sales": "📈", "security": "🛡️", "spatial-computing": "🥽", "specialized": "✨",
    "support": "🛟", "testing": "🧪",
}

FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def parse_frontmatter(text):
    """Return the frontmatter as a dict, or None if the file has none.

    Values are single-line in this corpus; split on the first ': ' so that
    descriptions containing colons survive intact.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    fields = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields


FENCE_RE = re.compile(r"^(```|~~~)")


def section_headers(text):
    """The '## ' headings in the body — shown in the detail drawer.

    Skips anything inside a fenced code block: agent files embed example
    deliverables that contain their own '##' headings, and those are sample
    content, not sections of the agent document.
    """
    body = FRONTMATTER_RE.sub("", text)
    headers, in_fence = [], False
    for line in body.splitlines():
        if FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            headers.append(m.group(1).strip())
    return headers


def load_runtimes():
    """Join company/runtimes.json with the repo's tools.json.

    runtimes.json owns the company's assignment + scoping facts; tools.json stays the
    single source of truth for a tool's label/short/accent. Returns
    (resolve(slug) -> runtime dict, warnings).
    """
    with open(os.path.join(ROOT, "company", "runtimes.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    with open(os.path.join(ROOT, "tools.json"), encoding="utf-8") as f:
        tools = json.load(f)["tools"]

    warnings = []

    def build(tool_key, model):
        meta = cfg["runtimes"].get(tool_key)
        tool = tools.get(tool_key)
        if meta is None or tool is None:
            missing = "runtimes.json" if meta is None else "tools.json"
            warnings.append(f"runtime '{tool_key}' not found in {missing}")
            return None
        return {
            "tool": tool_key,
            "label": tool["label"],
            "short": tool["short"],
            "accent": tool["accent"],
            "provider": meta["provider"],
            "scoping": meta["scoping"],
            "model": model,
        }

    default = build(cfg["default"]["runtime"], cfg["default"].get("model", "inherit"))
    if default is None:
        raise SystemExit("company/runtimes.json: default runtime does not resolve")

    assignments = {}
    for slug, a in cfg.get("assignments", {}).items():
        r = build(a["runtime"], a.get("model", "inherit"))
        if r is None:
            warnings.append(f"assignment for '{slug}' skipped")
            continue
        r["assigned"] = True
        r["note"] = a.get("note", "")
        assignments[slug] = r

    def resolve(slug):
        if slug in assignments:
            return assignments[slug]
        return {**default, "assigned": False, "note": ""}

    return resolve, assignments, warnings


def load_roster():
    """company/roster.json — which agents are actually hired into the company."""
    with open(os.path.join(ROOT, "company", "roster.json"), encoding="utf-8") as f:
        return json.load(f).get("hired", {})


DECISIONS_OUT = os.path.join(ROOT, "company", "ui", "src", "data", "decisions.json")
WORKSPACE_OUT = os.path.join(ROOT, "company", "ui", "src", "data", "workspace.json")
MONITOR_OUT = os.path.join(ROOT, "company", "ui", "src", "data", "monitor.json")
SEED_DECISIONS = os.path.join(ROOT, "company", "db", "seed", "decisions.json")

# ---- Postgres is the console's source of truth (D1) --------------------------
# The repo .md files + config JSON feed the DB; the console reads back OUT of the
# DB. So the app never hardcodes agent/decision data — it renders a snapshot the
# build exported from Postgres.


def sync_agents(env, agents):
    """Upsert every agent's basic info + full console object into company.agents.
    Agent .md files are the product source, so this is DO UPDATE (files win)."""
    cols = ("slug,name,division,hired,hired_group,hired_why,runtime_tool,"
            "runtime_model,tools,emoji,color,vibe,description,doc,synced_at")
    rows = []
    for a in agents:
        rt = a["runtime"]
        rows.append("(" + ",".join([
            dbio.lit(a["slug"]), dbio.lit(a["name"]), dbio.lit(a["division"]),
            "true" if a["hired"] else "false",
            dbio.lit(a["hiredGroup"] or None), dbio.lit(a["hiredWhy"] or None),
            dbio.lit(rt["tool"]), dbio.lit(rt["model"]), dbio.arr(a["tools"]),
            dbio.lit(a["emoji"] or None), dbio.lit(a["color"] or None),
            dbio.lit(a["vibe"] or None), dbio.lit(a["description"] or None),
            dbio.jlit(a), "now()",
        ]) + ")")
    updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols.split(",") if c != "slug")
    sql = (f"INSERT INTO company.agents ({cols}) VALUES\n" + ",\n".join(rows) +
           f"\nON CONFLICT (slug) DO UPDATE SET {updates};")
    dbio.exec_sql(env, sql)


def seed_decisions(env):
    """Seed the decision queue ONCE. ON CONFLICT DO NOTHING so that a later ruling
    entered directly in the DB is authoritative and a re-run won't clobber it."""
    with open(SEED_DECISIONS, encoding="utf-8") as f:
        seed = json.load(f)
    if not seed.get("decisions"):
        return  # no seed rows — decisions are now raised live by lead agents
    cols = ("id,title,question,why_you,raised_by,decider,urgency,status,options,"
            "recommendation,ruling,raised_at,decided_at,blocks,cost_of_not_deciding,"
            "raised_by_name,raised_by_emoji")
    rows = []
    for d in seed["decisions"]:
        raised = d.get("raisedAt")
        decided = d["status"] == "decided"
        rows.append("(" + ",".join([
            dbio.lit(d["id"]), dbio.lit(d["title"]), dbio.lit(d["question"]),
            dbio.lit(d.get("whyYou")), dbio.lit(d.get("raisedBy")), dbio.lit(d["decider"]),
            dbio.lit(d["urgency"]), dbio.lit(d["status"]), dbio.jlit(d.get("options", [])),
            dbio.lit(d.get("recommendation")), dbio.lit(d.get("ruling")),
            f"{dbio.lit(raised)}::date" if raised else "NULL",
            f"{dbio.lit(raised)}::date::timestamptz" if decided else "NULL",
            dbio.arr(d.get("blocks", [])), dbio.lit(d.get("costOfNotDeciding")),
            dbio.lit(d.get("raisedByName")), dbio.lit(d.get("raisedByEmoji")),
        ]) + ")")
    sql = (f"INSERT INTO company.decisions ({cols}) VALUES\n" + ",\n".join(rows) +
           "\nON CONFLICT (id) DO NOTHING;")
    dbio.exec_sql(env, sql)


def export_decisions(env):
    """Read the decision queue back OUT of the DB in the exact console shape."""
    source = "Postgres · doom_agents.company.decisions"
    note = ("Dữ liệu sinh từ Postgres lúc build (npm run data). Sửa một quyết định thì "
            "cập nhật DB rồi build lại — không sửa trong mã nguồn.")
    sql = f"""
    SELECT json_build_object(
      'source', {dbio.lit(source)},
      'note', {dbio.lit(note)},
      'decisions', coalesce(json_agg(d ORDER BY did), '[]'::json)
    )
    FROM (
      SELECT id AS did, json_strip_nulls(json_build_object(
        'id', id, 'title', title, 'question', question, 'whyYou', why_you,
        'raisedBy', raised_by, 'raisedByName', raised_by_name,
        'raisedByEmoji', raised_by_emoji, 'raisedAt', to_char(raised_at,'YYYY-MM-DD'),
        'decider', decider, 'urgency', urgency, 'status', status, 'options', options,
        'recommendation', recommendation, 'costOfNotDeciding', cost_of_not_deciding,
        'blocks', blocks, 'ruling', ruling
      )) AS d
      FROM company.decisions
    ) s
    """
    return dbio.query_json(env, sql)


def export_workspace(env):
    """Read the Workspace tabs' data (engagements / tasks / messages) out of the DB.
    Empty tables export as empty arrays — the console shows honest empty states."""
    sql = """
    SELECT json_build_object(
      'engagements', (SELECT coalesce(json_agg(e ORDER BY eid), '[]'::json) FROM (
        SELECT id AS eid, json_strip_nulls(json_build_object(
          'id', id, 'title', title, 'requestVerbatim', request_verbatim,
          'mode', mode, 'status', status, 'decider', decider, 'openedBy', opened_by,
          'createdAt', created_at, 'updatedAt', updated_at
        )) e FROM company.engagements) x),
      'channels', (SELECT coalesce(json_agg(c ORDER BY cid), '[]'::json) FROM (
        SELECT id AS cid, json_strip_nulls(json_build_object(
          'id', id, 'name', name, 'kind', kind, 'topic', topic,
          'engagementId', engagement_id, 'createdBy', created_by,
          'messages', (SELECT count(*) FROM company.messages m WHERE m.channel_id = channels.id),
          'createdAt', created_at
        )) c FROM company.channels WHERE NOT archived) cc),
      'tasks', (SELECT coalesce(json_agg(t ORDER BY tid), '[]'::json) FROM (
        SELECT id AS tid, json_strip_nulls(json_build_object(
          'id', id, 'engagementId', engagement_id, 'requirementId', requirement_id,
          'title', title, 'detail', detail, 'assignee', assignee, 'reporter', reporter,
          'status', status, 'priority', priority, 'attempt', attempt, 'blockedBy', blocked_by,
          'createdAt', created_at, 'updatedAt', updated_at,
          'comments', (SELECT coalesce(json_agg(json_build_object(
              'id', c.id, 'agent', c.agent, 'body', c.body, 'mentions', c.mentions,
              'createdAt', c.created_at) ORDER BY c.created_at), '[]'::json)
            FROM company.task_comments c WHERE c.task_id = tasks.id),
          'history', (SELECT coalesce(json_agg(json_build_object(
              'from', e.from_status, 'to', e.to_status, 'by', e.changed_by,
              'reason', e.reason, 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::json)
            FROM company.status_events e
            WHERE e.entity_type = 'task' AND e.entity_id = tasks.id)
        )) t FROM company.tasks) y),
      'messages', (SELECT coalesce(json_agg(m ORDER BY mid), '[]'::json) FROM (
        SELECT id AS mid, json_strip_nulls(json_build_object(
          'id', id, 'channelId', channel_id, 'engagementId', engagement_id, 'taskId', task_id,
          'fromAgent', from_agent, 'toAgent', to_agent, 'kind', kind, 'body', body,
          'reactions', (SELECT json_agg(json_build_object('emoji', emoji, 'agents', agents) ORDER BY emoji)
              FROM (SELECT emoji, json_agg(agent ORDER BY agent) AS agents
                    FROM company.message_reactions r WHERE r.message_id = messages.id
                    GROUP BY emoji) rr),
          'createdAt', created_at
        )) m FROM company.messages) z)
    )
    """
    return dbio.query_json(env, sql)


def load_runtime_catalog():
    """The runtime options for the Providers tab: every tool in runtimes.json,
    joined with tools.json for label/short/accent. Provider is a property of the
    install target (see company/runtimes.json), so this is where the picker's
    choices come from."""
    with open(os.path.join(ROOT, "company", "runtimes.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    with open(os.path.join(ROOT, "tools.json"), encoding="utf-8") as f:
        tools = json.load(f)["tools"]
    catalog = []
    for tool_key, meta in cfg["runtimes"].items():
        t = tools.get(tool_key, {})
        catalog.append({
            "tool": tool_key,
            "label": t.get("label", tool_key),
            "short": t.get("short", tool_key),
            "accent": t.get("accent", "#8A90A8"),
            "provider": meta["provider"],
            "scoping": meta["scoping"],
        })
    catalog.sort(key=lambda c: (c["scoping"] != "enforced", c["label"].lower()))
    return catalog, cfg["default"]["runtime"]


def export_monitor(env):
    """Per-agent throughput / tokens / estimated cost, priced from the DB's real
    model_pricing table. Empty usage exports zeroed totals honestly."""
    note = ("Cost = usage × giá token thật (company.model_pricing, nguồn Anthropic docs "
            "2026-06-24). Throughput/token là dữ liệu MẪU tied vào ENG-001 cho tới khi "
            "agent chạy thật và metering ghi vào company.usage_events.")
    sql = f"""
    SELECT json_build_object(
      'note', {dbio.lit(note)},
      'sample', coalesce(bool_or(is_sample), false),
      'models', (SELECT coalesce(json_agg(json_build_object(
          'model', model, 'provider', provider,
          'inputPerMtok', input_per_mtok, 'outputPerMtok', output_per_mtok,
          'note', note, 'source', source) ORDER BY input_per_mtok), '[]'::json)
        FROM company.model_pricing),
      'infra', (SELECT coalesce(json_agg(json_build_object(
          'key', key, 'service', service, 'spec', spec,
          'monthlyUsd', est_monthly_usd::float8, 'note', note) ORDER BY sort, key), '[]'::json)
        FROM company.infra_pricing),
      'infraMonthlyUsd', (SELECT coalesce(sum(est_monthly_usd), 0)::float8 FROM company.infra_pricing),
      'agents', (SELECT coalesce(json_agg(a ORDER BY cost DESC NULLS LAST), '[]'::json) FROM (
        SELECT sum(cost_usd) AS cost, json_build_object(
          'slug', u.agent, 'name', coalesce(ag.name, u.agent),
          'division', ag.division, 'hired', coalesce(ag.hired, false),
          'requests', count(*),
          'inputTokens', sum(u.input_tokens), 'outputTokens', sum(u.output_tokens),
          'cacheReadTokens', sum(u.cache_read_tokens), 'cacheWriteTokens', sum(u.cache_write_tokens),
          'costUsd', round(sum(u.cost_usd)::numeric, 4),
          'models', (SELECT json_agg(DISTINCT m) FROM unnest(array_agg(u.model)) m),
          'sample', bool_or(u.is_sample), 'priceUnknown', bool_or(u.price_unknown)
        ) AS a
        FROM company.usage_costed u
        LEFT JOIN company.agents ag ON ag.slug = u.agent
        GROUP BY u.agent, ag.name, ag.division, ag.hired
      ) t),
      'totals', json_build_object(
        'requests', count(*),
        'inputTokens', coalesce(sum(input_tokens), 0),
        'outputTokens', coalesce(sum(output_tokens), 0),
        'cacheReadTokens', coalesce(sum(cache_read_tokens), 0),
        'cacheWriteTokens', coalesce(sum(cache_write_tokens), 0),
        'costUsd', round(coalesce(sum(cost_usd), 0)::numeric, 4),
        'agents', count(DISTINCT agent))
    )
    FROM company.usage_costed
    """
    return dbio.query_json(env, sql)


def build_payload(agents, divisions_meta):
    """Assemble agents.json from the DB-exported agent docs."""
    counts = {}
    for a in agents:
        counts[a["division"]] = counts.get(a["division"], 0) + 1

    divisions = []
    for slug in sorted(divisions_meta):
        m = divisions_meta[slug]
        divisions.append({
            "slug": slug, "label": m["label"], "color": m["color"],
            "icon": m["icon"], "emoji": DIVISION_EMOJI.get(slug, "•"),
            "count": counts.get(slug, 0),
        })

    runtime_counts = {}
    for a in agents:
        rt = a["runtime"]["tool"]
        runtime_counts[rt] = runtime_counts.get(rt, 0) + 1

    catalog, default_runtime = load_runtime_catalog()
    return {
        "generatedFrom": "Postgres company.agents (synced from repo .md + config)",
        "divisions": divisions,
        "agents": agents,
        "runtimeCounts": runtime_counts,
        "runtimeCatalog": catalog,
        "defaultRuntime": default_runtime,
        "stats": {
            "agents": len(agents),
            "divisions": len([d for d in divisions if d["count"] > 0]),
            "scoped": len([a for a in agents if a["tools"]]),
            "unscoped": len([a for a in agents if not a["tools"]]),
            "assigned": len([a for a in agents if a["runtime"]["assigned"]]),
            "runtimes": len(runtime_counts),
            "scopingConflicts": len([a for a in agents if a["runtime"]["scopingConflict"]]),
            "hired": len([a for a in agents if a["hired"]]),
            "hiredScoped": len([a for a in agents if a["hired"] and a["tools"]]),
            "hiredUnscoped": len([a for a in agents if a["hired"] and not a["tools"]]),
        },
    }


def main():
    with open(os.path.join(ROOT, "divisions.json"), encoding="utf-8") as f:
        divisions_meta = json.load(f)["divisions"]

    resolve_runtime, assignments, runtime_warnings = load_runtimes()
    hired = load_roster()

    divisions, agents, skipped = [], [], []

    for division_slug in sorted(divisions_meta):
        meta = divisions_meta[division_slug]
        dir_path = os.path.join(ROOT, division_slug)
        if not os.path.isdir(dir_path):
            skipped.append(f"{division_slug}/ (directory missing)")
            continue

        count = 0
        for filename in sorted(os.listdir(dir_path)):
            if not filename.endswith(".md"):
                continue
            path = os.path.join(dir_path, filename)
            with open(path, encoding="utf-8") as f:
                text = f.read()

            fm = parse_frontmatter(text)
            if not fm or "name" not in fm:
                skipped.append(f"{division_slug}/{filename} (no frontmatter name)")
                continue

            word_count = len(FRONTMATTER_RE.sub("", text).split())
            tools = [t.strip() for t in fm.get("tools", "").split(",") if t.strip()]
            slug = filename[:-3]
            runtime = resolve_runtime(slug)

            # A declared allowlist on a runtime whose converter drops tools: is a real
            # conflict, not a cosmetic one — surface it rather than showing a green tick.
            runtime["scopingConflict"] = bool(tools) and runtime["scoping"] == "dropped"

            agents.append({
                "slug": slug,                  # the corpus id used by runbooks.json
                "division": division_slug,
                "name": fm["name"],
                "description": fm.get("description", ""),
                "emoji": fm.get("emoji", ""),
                "color": fm.get("color", ""),
                "vibe": fm.get("vibe", ""),
                "tools": tools,
                "sections": section_headers(text),
                "path": f"{division_slug}/{filename}",
                "words": word_count,
                "runtime": runtime,
                "hired": slug in hired,
                "hiredGroup": hired.get(slug, {}).get("group", ""),
                "hiredWhy": hired.get(slug, {}).get("why", ""),
            })
            count += 1

        divisions.append({
            "slug": division_slug,
            "label": meta["label"],
            "color": meta["color"],
            "icon": meta["icon"],
            "emoji": DIVISION_EMOJI.get(division_slug, "•"),
            "count": count,
        })

    # Two agents sharing a `name:` collide when installed into ~/.claude/agents —
    # one silently shadows the other. lint-agents.sh does not check this, and the
    # originality check compares CONTENT, so a same-name/different-content pair
    # passes every existing gate. Catch it here.
    seen_names = {}
    name_collisions = []
    for a in agents:
        prev = seen_names.get(a["name"])
        if prev:
            name_collisions.append((a["name"], prev, a["path"]))
        else:
            seen_names[a["name"]] = a["path"]

    # A roster entry that matches no agent file is a typo that would silently
    # under-staff the company — fail loudly rather than quietly hiring 30 of 31.
    known = {a["slug"] for a in agents}
    unresolved = sorted(set(hired) - known)

    # ---- push to Postgres, then read the console's data back out of it --------
    try:
        env = dbio.load_env()
        dbio.ping(env)
    except dbio.DbUnavailable as e:
        print("ERROR: cannot reach the company database.\n  " + str(e), file=sys.stderr)
        return 1

    sync_agents(env, agents)          # repo .md -> DB (files win: DO UPDATE)
    seed_decisions(env)               # seed once; DB owns rulings thereafter
    # Owner rows (is_owner) exist only so the 3 executives can be group members / task
    # assignees (those FKs point at company.agents). They have no persona doc and must NOT
    # appear in the agent directory/office/stats — exclude them from the export.
    db_agents = dbio.query_json(
        env,
        "SELECT coalesce(json_agg(doc ORDER BY division, name), '[]') FROM company.agents "
        "WHERE NOT coalesce(is_owner, false)",
    ) or []
    decisions_payload = export_decisions(env)
    workspace_payload = export_workspace(env)
    monitor_payload = export_monitor(env)

    payload = build_payload(db_agents, divisions_meta)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(DECISIONS_OUT, "w", encoding="utf-8") as f:
        json.dump(decisions_payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(WORKSPACE_OUT, "w", encoding="utf-8") as f:
        json.dump(workspace_payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(MONITOR_OUT, "w", encoding="utf-8") as f:
        json.dump(monitor_payload, f, ensure_ascii=False, indent=1)
        f.write("\n")

    print(f"synced {len(agents)} agents -> company.agents")
    print(f"exported {OUT} ({len(db_agents)} agents from DB)")
    print(f"exported {DECISIONS_OUT} ({len(decisions_payload['decisions'])} decisions from DB)")
    print(f"exported {WORKSPACE_OUT} "
          f"({len(workspace_payload['engagements'])} eng, {len(workspace_payload['tasks'])} tasks, "
          f"{len(workspace_payload['messages'])} messages from DB)")
    print(f"exported {MONITOR_OUT} "
          f"({monitor_payload['totals']['requests']} usage rows, "
          f"${monitor_payload['totals']['costUsd']} from DB)")
    print(f"  {payload['stats']['scoped']} declare tools:, {payload['stats']['unscoped']} do not")
    print(f"  roster: {payload['stats']['hired']} hired / {len(db_agents)} in catalog")
    if unresolved:
        print(f"  ERROR: {len(unresolved)} roster slug(s) match no agent file:")
        for u in unresolved:
            print(f"    - {u}")
    runtime_summary = ", ".join(f"{k}={v}" for k, v in sorted(payload["runtimeCounts"].items()))
    print(f"  runtimes: {runtime_summary}  ({len(assignments)} explicit assignment(s))")
    if payload["stats"]["scopingConflicts"]:
        print(
            f"  WARNING: {payload['stats']['scopingConflicts']} agent(s) declare tools: on a "
            "runtime whose converter drops them — role scoping will not apply"
        )
    for w in runtime_warnings:
        print(f"  runtime warning: {w}")
    if name_collisions:
        print(f"  ERROR: {len(name_collisions)} duplicate agent name(s) — one will shadow the other:")
        for name, first, second in name_collisions:
            print(f"    - '{name}': {first}  vs  {second}")
    if skipped:
        print(f"  skipped {len(skipped)}:")
        for s in skipped:
            print(f"    - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
