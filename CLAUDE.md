# CLAUDE.md

## What this repo is

**The Agency** (`agency-agents`) — a catalog of ~300 AI agent personas written as
plain Markdown, plus shell tooling that converts and installs them into 16 different
AI coding tools (Claude Code, Codex, Cursor, Gemini CLI, Copilot, opencode, Windsurf,
Aider, Kimi, Qwen, Osaurus, Antigravity, OpenClaw, Hermes, Mistral Vibe, ZCode).

There is **no application code** — no build, no test suite, no package manager.
The product *is* the Markdown. Everything else is bash + JSON catalogs + CI linting.

## Architecture

```
<division>/<division>-<agent-slug>.md   # source agents (the actual product)
divisions.json                          # source of truth: 17 divisions -> label/icon/color
tools.json                              # source of truth: 16 tools -> install contract
scripts/convert.sh                      # renders source agents -> per-tool formats
scripts/install.sh                       # installs rendered output to ~/.<tool>/...
scripts/lint-agents.sh                   # frontmatter + section linting
scripts/check-{divisions,tools,runbooks}.sh   # keeps JSON catalogs in sync with bash arrays
scripts/check-agent-originality.sh       # 8-word shingle overlap vs. whole roster
integrations/<tool>/                     # convert.sh OUTPUT — gitignored except README.md
strategy/, examples/                     # playbooks/runbooks, not agents
```

**Key data flow:** source `.md` → `convert.sh` (one `convert_<tool>()` per format) →
`integrations/<tool>/` → `install.sh` → user's tool directory.

**Duplicated-truth pattern:** `divisions.json` / `tools.json` describe the catalog, but
`convert.sh` and `install.sh` carry their own `AGENT_DIRS` / `ALL_TOOLS` bash arrays.
The `check-*.sh` scripts (run in CI) exist purely to fail the build when these drift apart.

## Agent file contract

```markdown
---
name: Frontend Developer            # REQUIRED — human-readable, Title Case
description: One-line summary       # REQUIRED
color: cyan                         # REQUIRED
emoji: 🖥️                            # optional
vibe: Short punchy tagline.         # optional
---

# <Name> Agent Personality

## 🧠 Your Identity & Memory        <- recommended (Identity)
## 🎯 Your Core Mission             <- recommended (Core Mission)
## 🚨 Critical Rules You Must Follow <- recommended (Critical Rules)
## 📋 Your Technical Deliverables
## 🔄 Your Workflow Process
## 💭 Your Communication Style
## 🎯 Your Success Metrics
```

`convert.sh` splits sections by header keyword: headers matching
`identity | learning.*memory | communication | style | critical.rule` route to
`SOUL.md`, everything else routes to `AGENTS.md` (OpenClaw format). Renaming a
section header can silently change what a converted agent contains.

## Rules

1. **Filename convention is per-division, not universal.** 195/248 agents use
   `<division>-<slug>.md`; `specialized/`, `spatial-computing/` and `game-development/`
   are mostly *un*prefixed (`specialized/operations-manager.md`). Match the directory
   you are adding to. Nothing enforces this — but `runbooks.json` references agents by
   **slug** (the filename stem), so renaming a file breaks rosters silently.
2. **LF line endings only.** CRLF is a hard lint error (`.gitattributes` enforces it).
3. **Never commit anything under `integrations/<tool>/` except its `README.md`.**
   Converted output is generated locally and gitignored.
4. **Adding a division** → create dir, add to `divisions.json`, then update the
   `AGENT_DIRS` arrays in `convert.sh` *and* `lint-agents.sh`, plus the path filters
   in `.github/workflows/lint-agents.yml`. Run `scripts/check-divisions.sh` to verify.
5. **Adding a tool** → add to `tools.json`, add a `convert_<tool>()` in `convert.sh`
   (or reuse an existing `format`), add `install_<tool>()` in `install.sh`, add a
   `.gitignore` rule for its output, and add `integrations/<tool>/README.md`.
   Run `scripts/check-tools.sh` to verify.
6. **Before proposing a new agent**, run `./scripts/check-agent-originality.sh <file>`.
   ≥40% shingle overlap with an existing agent fails CI — new agents must be genuinely
   new specialists, not find-replace re-skins.
7. **Prefer one-file PRs.** New/improved agents and doc fixes are always welcome;
   new tooling, new directories, or bulk edits across many agents need a Discussion first.
8. **Don't bulk-reformat existing agents** — it creates merge conflicts for other
   contributors and gets closed.

## Project goal: the "virtual company" (owner's vision)

The repo owner (acting as **CEO + CTO**) wants to turn this catalog into a running
**virtual company**: a customer request comes in at the top, and the agents themselves
decompose it, assign tasks to each other, and deliver through a real corporate process
(PM, BA, PO, Devs, QA, Finance, …). The owner supplies direction and approval; the
agents supply execution.

### Critical: NEXUS already exists — do not rebuild it

`strategy/` is not miscellaneous docs. It is **NEXUS** ("Network of EXperts, Unified in
Strategy"), a complete multi-agent operating model that already specifies most of the
above. Read `strategy/nexus-strategy.md` (1110 lines) before designing anything.

What NEXUS already defines:

| Concern | Where |
|---|---|
| Org chart / command structure | `nexus-strategy.md` §2.2 — Orchestrator → Studio Producer / Project Shepherd / Senior PM → division leads |
| 7-phase pipeline (Discovery → Strategy → Foundation → Build → Hardening → Launch → Operate) | `strategy/playbooks/phase-0..6-*.md` |
| Dev↔QA loop, 3-retry-then-escalate | `phase-3-build.md`, `nexus-strategy.md` §6.1 |
| Quality gates blocking phase advance | one per phase playbook |
| Agent-to-agent handoff contract | `strategy/coordination/handoff-templates.md` |
| Copy-paste activation prompts | `strategy/coordination/agent-activation-prompts.md` |
| Team sizing modes (Full / Sprint / Micro) | `nexus-strategy.md` §2.3 |
| Pre-built team rosters, machine-readable | `strategy/runbooks.json` + `strategy/runbooks/scenario-*.md` |
| Pipeline controller persona | `specialized/agents-orchestrator.md` |

`runbooks.json` is the most execution-ready artifact: each runbook maps to an ordered
roster of agent **slugs** (`.md` filename stem, NOT the display name — stems are not
always division-prefixed, e.g. `agents-orchestrator`), grouped by activation phase.

### The actual gap (this is what needs building)

NEXUS is **doctrine, not a runtime**. It is prose written for a human to read and
copy-paste. Specifically missing:

1. **Execution layer** — nothing runs. Activation prompts are manual copy-paste.
2. **System of record** — handoffs are Markdown *templates for a human to fill in*.
   There is no ticket/task store, no state, no way to resume a half-done project.
3. **Delegation wiring** — agent files do not know each other exists. The orchestrator
   persona *describes* delegating but has no mechanism to actually dispatch.
4. **Intake surface** — no defined path for "customer request → decomposed backlog".
5. **Missing org roles** — no distinct BA, PO, CEO/CTO-interface agent. Closest existing:
   `product/product-manager.md`, `project-management/project-manager-senior.md`,
   `product/product-sprint-prioritizer.md` (acts as PO). `finance/` exists but is not
   wired into delivery (no budget, no cost-per-task).

### Platform constraints (verified against Claude Code docs, 2026-07)

These are hard limits — the architecture must be designed around them, not against them.

- **Subagents cannot spawn subagents.** Delegation is one level deep. Even in Agent
  Teams: *"teammates cannot spawn their own teammates. Only the lead can manage the
  team."* → A recursive org tree (PM → Dev → QA, each dispatching the next) **does not
  work natively**. The hierarchy must be flattened.
- **Subagents inherit no conversation context.** They get project context (CLAUDE.md,
  skills, MCP) + the spawn prompt only, and return a *single summarized result*. There
  is no shared memory between them. → **The filesystem must be the system of record.**
- **Agent Teams** (experimental, needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) does
  provide a mailbox (`~/.claude/teams/{team}/inboxes/{agent}.json`) + a shared task list
  with dependencies and self-claiming — the closest native fit to "agents assign work to
  each other". But: one team per session, does not survive session resume. Not a
  foundation to build a company on yet.
- **Workflows** are the stable orchestration primitive (JS script holds the loop,
  parallelism, and intermediate state; scales to hundreds of agents; re-runnable).
- Subagent frontmatter supports far more than this repo uses: `tools`, `disallowedTools`,
  `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`
  (`user`/`project`/`local` — cross-session learning), `background`, `effort`,
  `isolation: worktree`, `initialPrompt`. Today only `tools:` appears, on a minority of
  agents. Do **not** use `permissionMode: bypassPermissions` for company roles — role
  scoping is the entire point.

### Chosen architecture — three layers

**The CEO/CTO (human) is the team lead.** This is not a workaround: in Claude Code the
top-level session *is* the executive. Owner's job = intake, approve quality gates,
arbitrate escalations. Agents do not need to recursively spawn each other — a real
company doesn't work that way either. The process is *encoded*, and roles execute in it.

1. **Process layer — Workflow scripts.** NEXUS's 7 phases, quality gates, and the
   3-retry Dev↔QA loop are deterministic control flow → they belong in a JS workflow
   script (`phase()`, `pipeline()`, loops), not re-improvised by an LLM each run.
   One workflow per `runbooks.json` runbook.
2. **State layer — `company/` directory, git-tracked.** Mandatory, because subagents
   share nothing else. Suggested: `company/intake/`, `backlog/`, `tickets/<id>.md`,
   `decisions/`, `evidence/`. NEXUS's `handoff-templates.md` becomes the *file schema*
   instead of a form a human fills in. Git history = audit trail; survives sessions.
   `integrations/mcp-memory/` is the alternative/complement for cross-session recall.
3. **Role layer — real subagent definitions in `.claude/agents/`.** Promote the existing
   personas, adding `tools:` / `disallowedTools:` / `model:` / `memory: project` per
   role (Finance must not `Write` source; QA must not `Edit`; Devs get full tools).

**Roles authored for this (2026-07-21):**
- `product/product-business-analyst.md` — request → testable spec, ambiguity register,
  traceability matrix. Never invents a requirement.
- `product/product-owner.md` — sole accept/reject authority, owns Definition of Done,
  guards scope, signs quality gates. Binary verdicts only, evidence required.
- `specialized/engagement-director.md` — the owner's interface: intake → engagement brief,
  NEXUS sizing, roster from `runbooks.json`, escalations as decision-ready memos.

**HR team + hiring pipeline (2026-07-22):** a new **`hr/` division** (18th; wired through
divisions.json + convert.sh/lint-agents.sh AGENT_DIRS + lint-agents.yml + build.py
DIVISION_EMOJI + office `DIVISION_CHAR`; `check-divisions.sh` PASS) with two hired agents —
`hr/hr-talent-acquisition-lead.md` (owns hiring: role need → new agent on the payroll) and
`hr/hr-agent-sourcer.md` (web-searches skills/agent templates + scans the catalogue, returns a
ranked shortlist). Their **pipeline**: CEO/CTO describes a role → bench check → Sourcer searches
web + catalogue for the closest **skill/agent template** → Talent Lead drafts a new persona
(default `claude-code` runtime) or promotes an existing candidate → owner approves → add to
`company/roster.json` + `npm run data` → the hire appears on the org chart (Nhân sự) **and gets
a desk in the Office automatically** (both read the roster). A standing **HR group chat**
(`company.channels` id `ch-hr`, owner↔HR) is seeded with a demo of this pipeline
(`company/db/seed/sample_hr_chat.sql`) and shows in Team Chat. **Boundary:** the setup + demo are
built; the pipeline *executes* when the HR agent is actually run (Claude Code / orchestrator) —
creating a hire = write the agent `.md` + roster entry + rebuild, the repo's normal add-an-agent
path, not a console button.

No new finance role was added: `specialized/chief-financial-officer.md` and
`finance/finance-fpa-analyst.md` already cover the personas. What is missing is
**wiring** (budget envelope → cost per task), not another agent.

Implementation plan lives at `company/IMPLEMENTATION-PLAN.md`.

**Console UI** at `company/ui/` — read-only management console (Nhân sự tree +
Quyết định queue), styled after a Deskboard-style dashboard the owner supplied.
React 19 + TypeScript + Vite + CSS Modules. `cd company/ui && npm install && npm run dev`
(port 5183). Notes:

- `src/data/agents.json` is **generated** by `build.py` from the repo's own agent files
  and is gitignored. `npm run dev` / `npm run build` run it automatically; use
  `npm run data` after adding or renaming an agent.
- `build.py` must skip `##` headings inside fenced code blocks — agent files embed
  example deliverables with their own headings. Without that filter Engagement Director
  reports 25 sections instead of 8.
- Design tokens live in `src/styles/tokens.css`; don't scatter colours in components.
- The Nhân sự page has a Thẻ/Cây (card/tree) toggle, persisted to `localStorage`. Both
  keep the division grouping — that grouping *is* the org chart. The card's status dot is
  **not** an online light: green = scoping effective, amber = declares `tools:` on a
  runtime that drops them, grey = unscoped.

### System of record — Postgres (`company/db/`)

State lives in Postgres, not the filesystem (owner's call, 2026-07-21). Database
`doom_agents`, schema `company`, inside the owner's **existing** Docker container
`ocb_ai_assistant-db-1` (postgres:17.9, port 5432). Credentials in `company/.env.local`
(chmod 600, gitignored — verified the password appears nowhere else in the tree).

Tables: `agents`, `engagements`, `sessions`, `tasks`, `task_comments`, `messages`,
`status_events`, `decisions`, `evidence`. Migrations `company/db/00*.sql` are idempotent.

**Sidebar has a SETTING & MONITOR group** (Providers / Monitor).
- **Providers** — the runtime catalog (all 16 tools with provider + scoping badge) plus a
  per-hired-agent picker. Read-only, so changing a pick generates the `runtimes.json`
  `assignments` snippet to copy-paste (same honest pattern as the decision-record button);
  it flags when a pick moves a tool-scoped agent to a `dropped` runtime.
- **Monitor** — per-agent throughput / tokens / **estimated cost**. Cost = usage × **real**
  published prices (`company.model_pricing`, verified 2026-06-24 via the claude-api skill —
  Opus $5/$25, Sonnet $3/$15, Haiku $1/$5, Fable $10/$50 per MTok; cache read 0.1×). The DB
  view `company.usage_costed` does the pricing so a price correction reprices history.
  **Metering is REAL since 2026-07-23** (`010_cancelled_usage.sql` + backend): every LLM call
  (chat responder + worker, both providers) accumulates usage per reply and inserts
  `usage_events` rows (`is_sample=false`, agent/task attribution via ContextVars; Claude
  aliases map to pricing keys `claude-haiku-4-5`/`claude-sonnet-4-5`, GPT models are unpriced
  → cost NULL until a verified pricing row is added). Verified: one haiku call → 26in/4out,
  `usage_costed.cost_usd` $0.000092. The Monitor tab reads the build-time snapshot — run
  `npm run data` to refresh it. Task lifecycle: **accepted posts a deterministic completion
  report** into the ticket (processing time from first `in_progress` event, tokens+cost,
  reject rounds, blocked-by, deliverable summary); **`cancelled`** joined the status enum
  (DB CHECK + chat tool + MCP + board's "Hoãn / Huỷ / Escalate" column) and REQUIRES a
  `reason` (rejected without one at both tool layers), logged to the timeline + a ⛔ comment.

**Sidebar has a WORKSPACE group** (Office / Tasks — **Team Chat merged INTO the Office screen
2026-07-23**, owner's call: watch agent animation and chat on ONE screen instead of tab-switching).
`OfficePage` is now a split: pixel office left (flex, its ResizeObserver re-packs rooms to the
narrower width), `TeamChatPanel` right (`clamp(340px, 30vw, 420px)`; stacks vertically under
1100px). The panel uses DRILL-IN navigation (channel list → pick → thread with a ← back button)
because the narrow width can't fit the old two-column rail; ALL chat features carried over
(mention scoping, reactions, groups CRUD via the (!) popup, unread badges — which now only
mark-read while the thread view is actually on screen, sitting on the list doesn't eat unread).
`/workspace/chat` redirects to `/workspace/office`; the sidebar Office entry carries the old
message badge. Team Chat renders
`company.messages` as agent-to-agent threads (channel = engagement; from/to null = owner).
**The owner can chat**: Team Chat pulls live channels+messages from the office-server
(`GET /chat`) when it's running and has a composer that sends as owner (`POST /chat/send`,
`from_agent = NULL`) — so the CEO/CTO's message persists in Postgres and shows without a
rebuild; the office animates it on the next poll. Offline, it falls back to the static
snapshot and disables the composer with a hint. Agents chat via the MCP server, not this
endpoint. Two standing **command channels** are seeded (topic channels, show in Team Chat
on their own): `ch-hr` (owner↔HR hiring) and **`ch-leadership`** ("Ban lãnh đạo · Giao việc",
`company/db/seed/sample_leadership_chat.sql`) — the CEO/CTO's directive group. Its demo walks
the delegation loop the owner asked for: **CEO/CTO giao việc cho lead/manager → lead phân task
cho staff (ticket, attempt cap 3, QA gác cổng) → lead báo cáo (roll-up) lại CEO/CTO trong chính
group này**. Leads = engagement-director / project-manager-senior / product-owner /
engineering-software-architect / security-architect (`LEAD_SLUGS` in `company/api/main.py`).
**The delegation loop now EXECUTES for real in the FastAPI backend** (verified end-to-end
2026-07-23 on Bedrock Haiku 4.5): `@Ban lãnh đạo`/`@all` in Team Chat fans out to the 5 leads
SEQUENTIALLY (later leads see earlier replies); leads carry role-scoped WRITE tools
(`create_task`/`assign_task`/`comment_task`/`update_task_status`/`raise_decision`, enforced
server-side in `_exec_tool` — staff only get `view_db`; `WRITE_SLUGS` = the 5 leads + `hr-talent-acquisition-lead`
so the HR hiring pipeline can raise tickets too; `view_db` also has a `candidates` view over the
~220 un-hired catalogue personas with division/keyword filter = real sourcing data; worker
work-steps get read-only `view_db`; web-search is NOT in the chat runtime — an agent promising
"searching the web" is speaking in character); chat-created tasks live under standing engagement
**ENG-OPS**; a **worker loop** (`WORKER_ENABLED`, one state-machine step per `WORKER_POLL_S`)
has the assignee's LLM produce the deliverable as a task comment, the reporting lead reviews
with a `VERDICT: ACCEPT|REJECT` first line, rejected bumps attempt toward the NEXUS cap 3 →
escalated; the roll-up report is NOT hardcoded to any channel
(migration `009_task_origin.sql`): `create_task` records `tasks.origin_channel` = the group
the directive came from (asyncio ContextVar set per reply), and when every task from that
group is terminal, the lead who raised the most tickets posts the 📋 roll-up BACK INTO that
group (per-channel dedup markers in `office_config.ops_report` = `{channelId: lastEventId}`)
— so giao việc works from ANY group chat, verified end-to-end on a throwaway group. The sample engagement's
channel was renamed **"Dự án mẫu (demo)"** (its old name was the sample project title, which
read like nonsense) and a standing OPEN channel **`ch-general` "Toàn công ty"** exists — no
members on purpose: any agent can be @tagged there, but an untagged message triggers nobody
(an all-members general channel would fire ~33 LLM calls per untagged message).
Group management lives in an
**info popup** (the `!` icon top-right of the thread header, topic channels only): editable
group name (`PATCH /api/chat/channels/{id}`), the 👥 member list (5 rows then scroll), and a
two-step 🗑 delete (`DELETE /api/chat/channels/{id}`) — engagement channels reject both with
400; deleting keeps the group's tasks (origin set NULL). Leads genuinely ask the CEO to
clarify before acting (observed live). Gotcha found in test: `view_db` agents view MUST
return `slug` or leads fabricate wrong slugs. The Tasks tab reads `/api/workspace` LIVE
(5s poll, static fallback) so lead-created tickets appear without a rebuild.
Remove the channel with `DELETE FROM company.channels WHERE id='ch-leadership';`.
**Group chat (migration `008_chat_groups.sql`):** channels can have MEMBERS
(`company.channel_members`; owner creates groups via "＋ Nhóm" → `POST /api/chat/channels`,
Vietnamese-slugified ids). Mention autocomplete/resolve is scoped to members (backend 400s
out-of-group tags); a NO-mention owner message in a member channel triggers every member IN
ORDER and each agent answers only if it has relevant expertise, else returns `PASS` which is
swallowed (judged on the reply's FIRST LINE — decorated passes count) — verified: QA question
in a 2-member group → Senior Developer passed silently, Reality Checker answered. Channels
without members keep the quiet old behavior. The OWNER can react to messages
(`POST /api/chat/react` toggle; 008 made `message_reactions.agent` nullable — NULL = owner —
replacing the PK that forbade it); FE has hover ☺+ palette and click-to-toggle chips.
Tasks is a Jira-style board over `company.tasks` (Cần làm / Đang làm / Đang review = in_qa+
rejected / Xong = accepted / Hoãn-Escalate; cards show priority spine/label, attempt n/3,
comment count and blocked-by). **Clicking a card opens a detail drawer** (route
`/workspace/tasks/:id`, reusing `Drawer`): PIC/assignee, reporter, status, priority,
description, a comment thread with @mentions, and a status-history timeline read from
`company.status_events`. Migration `005_tasks.sql` added `priority` + `reporter` columns and
the `company.task_comments` table (with a `mentions text[]`); sample detail/comments/history
seed from `company/db/seed/sample_tasks.sql`. Office is the **realtime pixel office** (see
below). Tabs read `src/data/workspace.json` (exported from the DB). **All sample data was
purged 2026-07-23** (owner's call: work is real from here): the sample engagement `ENG-001`
("Khôi phục mật khẩu tự phục vụ", renamed "Dự án mẫu (demo)" shortly before deletion) was
DELETED — cascading its channel, 13 sample usage rows and 1 sample session; the 4 decisions
survived (they were engagement-unlinked, verified before deleting). The `sample_*.sql` seed
files remain on disk as restore scripts but NOTHING re-runs them (`build.py` only exports).
Only engagement `ENG-OPS` (real chat-task infra) remains; `SampleNotice` stays in code as a
guard should a sample ever be re-seeded.

**The console reads its data OUT of Postgres — no more hardcoding.** `build.py`
(`npm run data`) now: (1) upserts agents into `company.agents` (files win, DO UPDATE);
(2) seeds `company.decisions` from `company/db/seed/decisions.json` **once**
(`ON CONFLICT DO NOTHING` — the DB owns rulings thereafter, a re-run won't clobber);
(3) exports `src/data/agents.json` + `src/data/decisions.json` back out of the DB (both
gitignored). `decisions.ts` no longer hardcodes — it imports the generated JSON. To change
a decision, `UPDATE company.decisions` then `npm run data`. Verified by round-trip: a direct
DB edit flows to the console without touching source, and the seed file is not the authority.
**All 4 seeded decisions were purged 2026-07-24** (owner's call — no more mock): the seed file
`decisions.json` is now an empty array and `seed_decisions` returns early on empty (so a
`npm run data` won't re-insert). Decisions are now RAISED LIVE by lead agents: the
`raise_decision` tool (WRITE_SLUGS only) inserts a `pending`/`CEO/CTO`-decider ticket
(id `D-<n>`, options normalised to the console shape) when a lead needs owner approval, and the
lead's chat reply says "✅ Đã tạo ticket quyết định D-N … chờ được phê duyệt" (prompt rule).
The **Quyết định tab is now LIVE** (`useLiveDecisions` fetches `/api/decisions` every 5s, static
fallback) so a raised ticket appears without a rebuild. Verified end-to-end on Bedrock: a
strategic architecture question → PM raised D-1 (blocking, 2 options) → appeared in the tab.
`build.py` now requires the DB up (via `docker exec`, reading `PGCONTAINER` etc. from
`.env.local`) and fails loudly if unreachable. Plumbing lives in `company/ui/dbio.py`
(psql-via-docker, no driver dependency; single-quote-escaped literals + `::jsonb` casts).

**Invariants are CHECK constraints, not conventions** — each verified by negative control:
`messages.idempotency_key` UNIQUE (retry can't duplicate a handoff), `tasks.attempt`
0–3 (the NEXUS retry cap), `decided_has_ruling` (no decision recorded without reasoning),
`agents_hired_name_uniq` (partial index — two hired agents can't share a display name).

**Isolation:** role `doom_agents` cannot connect to the neighbouring `ocb_ai` database
(`REVOKE CONNECT ... FROM PUBLIC`, verified: *permission denied*). The `ocb_ai` app uses
the `postgres` superuser and still reaches all 22 of its tables — checked after the revoke.

**Agents work through one MCP server** — `company/mcp/` exposes scoped tools over two
surfaces: (1) **chat** — `create_channel`, `send_message`, `react`, `read_channel`,
`list_channels`, `list_agents`, `whoami` (backed by `company.channels` / `messages` /
`message_reactions` / `channel_reads`, migration `004_chat.sql`); (2) **task tickets** —
`list_tasks`, `get_task`, `update_task_status`, `comment_task` (mentions tag agents),
`assign_task` (set PIC), `set_task_priority` (backed by `company.tasks` / `task_comments` /
`status_events`, migration `005_tasks.sql`). `update_task_status` writes an append-only
`status_events` row and bumps `attempt` toward the NEXUS 3-try cap when a ticket enters
`rejected` (a failed QA round). This is the "MCP server with scoped tools" path — chosen over
granting agents `Bash`+psql (which would let any agent run arbitrary SQL and defeat role
scoping). **Identity is server-side**: the acting agent comes from the `AGENT_SLUG` env var,
never a tool argument, so one agent cannot post/react/change-status as another — each agent's
`.claude/agents/*.md` declares the server with its own `AGENT_SLUG`. The server connects via
`docker exec psql` (like `dbio.py`) because host `127.0.0.1:5432` is shadowed by a native
postgresql@16 and the container isn't host-routable on Docker Desktop Mac — verified, not
assumed. `npm run smoke` in `company/mcp` proves it end-to-end (two identities converse **and
act on a task ticket**; 24 checks, self-cleaning). This is a more durable answer to D2 than
Agent Teams' mailbox: chat and task state live in Postgres and survive session resume. Console
shows a build-time snapshot (still no live backend); re-run `npm run data` after agents act.

Other DB writes (evidence) still prefer the orchestrator owning them (subagents return data,
main loop persists) until they get their own scoped MCP tools too.

**The Office tab is a realtime pixel office — and the console's FIRST live backend.**
Everything else in `company/ui` is a static `npm run data` snapshot; a pixel office that
reacts as agents work needs a running event source + push channel. `company/office-server/`
(Node + `ws`, ~1 dep) tails `company.messages` / `status_events` / `task_comments` by `id`
(poll every `OFFICE_POLL_MS`, default 1s, via the same `docker exec psql` path — host
`127.0.0.1:5432` is shadowed) and pushes deltas over WebSocket `ws://localhost:5210/office`;
it also accepts Claude Code hook POSTs at `/hook` (`{agent,phase,tool}`) so a live session's
tool-use can drive fine-grained typing/reading (the "cả hai" source choice). It only READS to
broadcast — writes stay on the scoped MCP path. `npm run smoke` proves the pipe: real Postgres
INSERT → real WebSocket client receives it with `from→to` and `assignee` (7 checks, self-clean).
The front-end renderer (`company/ui/src/office/`: `sprites.ts` / `layout.ts` / `engine.ts` /
`useOfficeSocket.ts`, hosted by `pages/OfficePage.tsx`) is a Canvas 2D game loop: one room per
division (that grouping = the org chart), a stable desk per hired agent, a per-agent state
machine (idle/typing/reading/walking/talking). Message A→B → A walks to B + speech bubble;
task status → ✅/❌/🔍 bubbles; comment/mention → ping. An agent does **one task at a
time**: a working agent shows a persistent **⌨️** badge, and when another agent arrives to
hand off to a busy target it **stands and waits** (**⏳** badge, `waitFor` step in the state
machine) until the target's task leaves `in_progress`, then delivers. This is the *visual* of
the single-task/serialized model — actual task serialization is an orchestration-layer concern. Offline still renders the static office
+ a hint to start the backend. **Pixel sprites are vendored from Pixel Agents**
(https://github.com/pixel-agents-hq/pixel-agents, **MIT © Pablo De Lucca**) under
`company/ui/public/office/` with `LICENSE-pixel-agents.txt` + `ATTRIBUTION.md` kept alongside —
only the image assets are reused; the renderer is ours. Sheet layout (needed if sprites change):
`char_N.png` 112×96 = rows DOWN/UP/RIGHT × 7 frames 16×32; walk `[0,1,2,1]`, typing `[3,4]`,
reading `[5,6]`, LEFT = flipped RIGHT. The reference clone lives only in the session scratchpad,
never committed. **Realtime is opt-in** — run `cd company/office-server && npm install && npm start`.
Rooms are packed masonry-style (columns from available width, tallest room first into the
shortest column) so the layout fills width instead of leaving side gutters; each room reserves
a wall band (top) and floor band (bottom) for vendored decor (bookshelf/painting/clock/plants,
same MIT set, `public/office/decor/`) that never collides with desks. A **"▶ Chạy thử flow"**
button on the Office bar plays a scripted NEXUS interaction (intake→spec→ruling→build→QA
fail-then-pass) straight into the office animation — client-side only, no DB writes, for
previewing how agents walk-to-talk and hand off. Each room's nameplate has a **floor-picker
dropdown** (choose one of 9 floor textures per department); the choice persists **durably in
Postgres** (`company.office_config` key `floors`, migration `006_office_config.sql`) via the
office-server's `GET`/`POST /config/floors` (CORS-enabled), with `localStorage` as the instant
offline fallback — so DB > localStorage > default. This is the console's first *write-back* to
the DB from the browser (via the office-server), complementing the read-only WS stream.

**Board ↔ Office parity (2026-07-23):** every task status maps 1:1 to animation — `todo` 📋
bubble on the assignee, `in_progress` = persistent ⌨️ + typing pose, `in_qa` = persistent 🔍 +
reading pose on the REVIEWER (reporting lead, PO fallback — `reviewerOf()` in engine.ts mirrors
the worker's rule; `reporter` now travels in the WS hello snapshot AND taskStatus events),
`accepted` ✅ / `rejected` ❌ / `deferred` ⏸️ / `escalated` 🚨 / `cancelled` ⛔ bubbles, and ANY
non-in_progress transition clears the assignee's ⌨️ (previously a mid-work cancel left the badge
stuck). The hello snapshot re-derives both working and reviewing sets on reconnect.
**The office MIRRORS real state; it is not the work.** The rAF render loop pauses when the
tab is hidden (browser throttling) — that is fine because the *working* state is a durable
DB fact (a task in `in_progress`), not the animation. `setInitial` (the WS `hello`) is
**authoritative**: an agent shows the ⌨️ badge iff it currently holds an `in_progress` task,
so a stale badge clears on reconnect. **Actual continuous work** is produced by the runtime
slice **`company/runner/`** (`node run.mjs`): it drives task(s) through the real NEXUS Dev↔QA
loop, writing `company.tasks` + `status_events` + handoff `messages` until `accepted` or
`escalated`, which office-server streams so the office animates real, ongoing work. It is
**bounded** so nothing runs forever: the NEXUS **3-retry cap → escalate** (verified with
`RUN_PASS_BASE=0`), a per-task time budget, a global budget, and **one task per agent at a
time** (per-assignee sequential). Timings/limits are env-tunable and deliberately not too low.
The phases are timed stand-ins today; wiring real dev/QA subagents = replace the sleeps, the
transitions and bounds stay. `npm run smoke` in `company/runner` proves a throwaway task reaches
a bounded terminal state with real DB writes (self-cleaning).

**FastAPI backend — `company/api/` (Python).** One server for the whole console: REST live from
Postgres (`/api/workspace|decisions|monitor|agents`), interactive (`/api/chat` GET + `/chat/send`
POST as owner, `/api/config/floors` GET/POST), a WebSocket `/ws/office` (poll → broadcast, ports
office-server's stream), and it **mounts the built FE** (`company/ui/dist`) so a **single deploy
serves FE + API + WS** — verified end-to-end (uvicorn: REST returns real data, `/` serves the FE,
owner POST inserts, WS `hello` + broadcasts a real insert). Single-server works because the FE
uses HashRouter (no SPA rewrite) and same-origin kills CORS; you'd only split for multi-worker WS
(in-memory broadcast → 1 worker or Redis) or a CDN. DB access is `db.py` = the same `docker exec
psql` path (host 5432 shadowed), wrapped in `asyncio.to_thread`; swap to `asyncpg` = rewrite one
file. **Docker Desktop's exec API on Mac intermittently 500s/hangs under bursts of concurrent
`docker exec`** (poll every 1s × 3 queries + worker + chat + token metering all share this
transport) → surfaces as `[api] poll error` / `[worker] error` in logs. These are TRANSIENT and
self-healing (both loops catch + skip the tick). `db.py._psql` retries ONCE on a fast transport
500 (docker failed before psql ran → nothing committed → safe) but does NOT retry on a 30s
TimeoutExpired (a write may have partially committed → a retry could double-insert; let the loop
recover instead). Real SQL errors (`ERROR:`/`psql:`) raise immediately, no wasted retry. The
durable fix is moving off docker-exec to a reachable TCP endpoint + `asyncpg`; not urgent while
these stay transient. **The FE's live/interactive surface now targets FastAPI** (not office-server): Team Chat
uses `/api/chat` + `/api/chat/send`, Office uses `/ws/office` + `/api/config/floors`, via
**relative URLs** (`src/lib/api.ts`) — same-origin in prod (FastAPI serves the FE), and a Vite
`server.proxy` forwards `/api` + `/ws` to `:8000` in dev, so the same URLs work in both. So to
chat/see-live, run the **FastAPI** backend, not office-server (now redundant for the FE; the
runner still writes to the DB and FastAPI streams it). **Still on static JSON:** the read-only
data pages (Nhân sự/agents, Decisions, Tasks, Monitor) import the bundled `src/data/*.json`
(build.py exports); switching them to fetch `/api/agents|decisions|monitor|workspace` needs
`/api/agents` to return the full `AgentRoster` shape (runtimeCatalog etc.) — a later increment.

**@mention → agent replies (two-way chat).** The Team Chat composer has `@` autocomplete over
hired agents (`lib/agents.ts` `hiredAgents` + `resolveMention`, matched by **word boundary** so
`@Talent Acquisition Lead` resolves the multi-word name and `me@x.com` doesn't). Sending resolves
`toAgent` and POSTs it; `/api/chat/send` inserts the owner message then **triggers that agent to
reply** async (`respond_as_agent`): loads the agent's persona (`.md` body via the doc `path`) +
the last 12 channel messages as context, calls Claude, inserts the reply as `from_agent=<slug>`.
Team Chat **polls `GET /chat` every 3s** so the reply appears. The responder gives the LLM a
**read-only, scoped `view_db` tool** (both GPT and Claude/Bedrock) so agents answer factual
questions from real data instead of hallucinating — whitelisted named views only (`overview`
= hired headcount + division breakdown, `agents`/`tasks`/`channels`/`engagements`), never raw
SQL (same role-scoping principle as the MCP server), tool loop bounded at `_TOOL_ROUNDS=4`.
Verified: "how many staff" → agent calls the tool → answers **33** with the correct division
breakdown, on both Bedrock Haiku 4.5 and gpt-4o-mini. Which LLM answers is **per-agent, two providers**: **GPT** (OpenAI, `OPENAI_API_KEY`) and
**Claude** (AWS Bedrock, `AWS_ACCESS_KEY_ID/SECRET/REGION`) — stored in `company.agent_runtime`
(migration `007_agent_runtime.sql`), edited on the **Providers tab** (`GET /api/providers` +
`POST /api/agent-runtime`); agents without a row use `DEFAULT_PROVIDER`/`DEFAULT_MODEL` (default
`claude`/`haiku` → Bedrock). The responder routes by provider: GPT → OpenAI SDK, Claude → the anthropic
SDK's `AnthropicBedrock` (Claude aliases `haiku`/`sonnet` → Bedrock IDs via `BEDROCK_HAIKU/SONNET`,
override for your region). The backend auto-loads `company/.env.local` into its env. No key /
model error → a short honest fallback message. **Verified live (both):** `gpt-4o-mini` and **Bedrock
Claude Haiku 4.5** both returned real, in-character replies through `/api/chat/send`. Bedrock gotcha:
newer Claude is only reachable via a **cross-region inference profile** (`global.`/`apac.` prefix),
not the raw model id — raw id → `invalid model identifier`; and the region must be a real AWS region
(`ap-southeast-1`, via `BEDROCK_REGION` so it's separate from `AWS_REGION` used by S3). Verified
config: account `203918858918`, `ap-southeast-1`, `BEDROCK_HAIKU=global.anthropic.claude-haiku-4-5-20251001-v1:0`.
`requirements.txt` adds `openai` + `boto3` (+ `anthropic`). Mention word-boundary
resolution (`resolveMention`) tested; the Providers page is now live (fetch/save via the API),
replacing the old runtime-catalog snippet page.

**Lifecycle risk:** the container belongs to the `ocb_ai_assistant` compose stack. A
`docker compose down -v` there destroys `doom_agents` too. Flag this before real data lands.

**What Postgres does NOT fix:** Agent Teams still does not survive session resume — its
mailbox is Claude Code's own `~/.claude/teams/{team}/inboxes/*.json` and the docs say the
team isn't restored. The DB gives a durable *record*, not a resurrected live team.

### Hiring roster — `company/roster.json`

The catalog's 251 agents are a **candidate pool**, not the payroll. `roster.json` lists
who is actually hired (33 as of 2026-07-22, incl. the 2 `hr/` agents). Owner's criteria: tech products, hands-on
delivery, **no marketing and no sales** — 8 divisions are excluded wholesale (marketing,
gis, sales, paid-media, academic, spatial-computing, game-development, healthcare).

**Nothing is deleted.** Un-hired agents stay in the repo because (a) deleting a whole
division breaks `divisions.json` ↔ directory sync and the `check-divisions.sh` CI gate,
(b) it makes upstream fork sync painful, (c) hiring is reversible and deletion isn't.

**Unused agents cost nothing** — verified 2026-07-21: neither `~/.claude/agents` nor
`.claude/agents` exists, so no agent is installed. Files in the repo are inert. Cost
begins at install (Stage 2) and at invocation. Whether *installed-but-unused* subagents
carry a standing context cost is **not documented** — the context-window breakdown lists
skill descriptions and MCP tool names but has no row for subagent definitions. Treat it
as unknown and install only the roster.

`build.py` fails loudly if a roster slug matches no agent file, and stats like
`hiredScoped`/`hiredUnscoped` are computed over the payroll, not the catalog.

### Duplicate agent names are a real hazard

Two agents sharing a `name:` collide when installed — one silently shadows the other.
`lint-agents.sh` does not check this, and `check-agent-originality.sh` compares *content*,
so a same-name/different-content pair passes every existing gate. This bit us once:
a new `specialized/chief-of-staff.md` collided with the pre-existing
`specialized/specialized-chief-of-staff.md`; the new one was renamed to
`specialized/engagement-director.md` ("Engagement Director"), which is also a more
accurate name for what it does. `company/ui/build.py` now reports duplicates.

### Runtime assignment — `company/runtimes.json`

**Provider is a property of where an agent is installed, not of its `.md`.** The same
persona can be installed into several tools. Claude Code's subagent `model:` accepts only
Claude models (`opus`/`sonnet`/`haiku`/`fable`/`inherit`) — running an agent on GPT means
installing it into Codex via `scripts/convert.sh`, not changing a field. So runtime lives
in the company layer; never add a `provider:` field to catalog frontmatter.

Company default is `claude-code`; per-agent overrides go in `assignments` (slug → runtime).
`build.py` joins this with `tools.json` for label/short/accent, so tool metadata is never
duplicated.

**Verified from `scripts/convert.sh` (re-check if converters change):** only
`convert_qwen` and `convert_zcode` emit a `tools:` field. The other 14 converters drop it,
so assigning an agent with a tool allowlist to codex/gemini-cli/cursor/etc. **silently
voids its role scoping**. `build.py` prints a warning and the UI flags it (amber dot +
red block in the drawer). This is the evidence behind D4's recommendation: keep the
gate-keeping roles (Product Owner, Evidence Collector) on `claude-code`.
- `HashRouter`, and the drawer is route state (`#/agents/:slug`, `#/decisions/:id`) so
  records are linkable and browser-back closes the drawer.
- It cannot write to disk, so decision actions copy a ready-to-paste record rather than
  faking an approve button. Keep it that way until Stage 1 wires the state layer.

**Build order:** prove a NEXUS-Micro thin slice end-to-end first — one customer request
→ intake → BA spec → one dev task → QA gate → delivery — before attempting Full.

### Repo-hygiene constraints

- This is a personal fork (`thinhsuy/doom-agents`), not upstream `msitarzewski/agency-agents`.
  `CONTRIBUTING.md`'s "open a Discussion before adding tooling" is therefore social, not binding.
- Runtime/generated state must stay gitignored (except deliberate system-of-record files).
- Whatever gets built must not break the four CI checks (see below).

## Verifying a change

```bash
./scripts/lint-agents.sh <file>              # frontmatter + section check
./scripts/check-agent-originality.sh <file>  # duplicate detection
./scripts/check-divisions.sh                 # only if divisions changed
./scripts/check-tools.sh                     # only if tools changed
./scripts/convert.sh                         # smoke-test rendering (output is gitignored)
```

These four `check-*` / `lint-*` scripts are exactly what CI runs
(`.github/workflows/*.yml`). There is nothing else to run.
