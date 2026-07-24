# Virtual Company — Implementation Plan

Turning the NEXUS doctrine in `strategy/` from prose into a running organization.

**Owner role:** CEO + CTO (human). You are the team lead — in Claude Code the top-level
session *is* the executive. Your job is intake, gate approval, and escalation rulings.

**Design premise (verified against Claude Code docs):** subagents cannot spawn subagents
and share no context. Therefore the org chart lives in a **script**, the memory lives on
**disk**, and the roles are **permission-scoped subagents**. Agents do not chat their way
to a plan; they execute a process that is already encoded.

---

## Stage 0 — Decisions needed from the owner

These block Stage 1. Nothing should be built until they are answered.

| # | Decision | Options | Why it matters |
|---|----------|---------|----------------|
| D1 | Where does `company/` state live? | (a) this repo (b) a separate private repo (c) gitignored local dir | Engagement data may contain client-confidential material. This repo has a public upstream. |
| D2 | Orchestration mechanism | (a) Workflow script only — stable (b) Workflow + Agent Teams — experimental, gives real inter-agent mailbox | Teams is `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, one team per session, does not survive resume. |
| D3 | First thin-slice engagement | a real customer request, or a synthetic one | Needed to validate the loop end-to-end. Prefer a real, small, already-understood request. |
| D4 | Which tool is the target? | Claude Code only, or also Cursor/Codex via `convert.sh` | Role scoping via `tools:`/`disallowedTools:` is Claude-Code-specific; other tools drop it. |

---

## Stage 1 — Foundation

**Goal:** the pieces exist and are installable. No orchestration yet.

- [x] Author the three missing roles — BA, PO, Engagement Director
- [x] Verify against all four CI gates (lint, originality, divisions, tools, runbooks)
- [ ] **Decide D1**, then create the state layer:
  ```
  company/
    intake/        ENG-<id>.md      engagement briefs (Engagement Director)
    specs/         SPEC-<id>.md     functional specs (Business Analyst)
    backlog/       backlog.md       ordered tasks (Sprint Prioritizer)
    tickets/       T-<id>.md        one file per task, carries its own state
    decisions/     D-<id>.md        rulings — PO and owner
    evidence/      <task-id>/       QA artifacts
    ledger.md                       estimate vs actual, per engagement
  ```
- [ ] Write `company/DEFINITION-OF-DONE.md` (v1) — the PO agent's deliverable template has a starting version
- [ ] Write `company/HANDOFF-SCHEMA.md` — port `strategy/coordination/handoff-templates.md` from a
      *human form* into a **file schema agents read and write**. This is the single highest-value
      conversion in the whole plan.
- [ ] Add `.gitignore` rules if D1 = (c)

**Done when:** a human can read `company/` and understand the state of a fictional engagement.

---

## Stage 2 — Role installation and scoping

**Goal:** the personas become real, permission-scoped subagents.

- [ ] Promote the thin-slice roster into `.claude/agents/` — start with **7 agents only**:
      `engagement-director`, `product-business-analyst`, `product-owner`,
      `project-manager-senior`, `engineering-backend-architect`,
      `engineering-frontend-developer`, `testing-evidence-collector`
- [ ] Add role scoping to each — this is the part the catalog has never used:

  | Role | `tools` / `disallowedTools` | Rationale |
  |---|---|---|
  | Engagement Director | no `Bash`, no `Edit` on source | frames work, never builds |
  | Business Analyst | no `Bash` | writes specs, not code |
  | Product Owner | `Read, Grep, Glob, Write` only | must not fix what it judges |
  | Evidence Collector | `disallowedTools: Edit, Write` on source | QA must not repair its own findings |
  | Devs | full toolset | they build |

- [ ] Set `memory: project` on Engagement Director and PO — they are the two roles that benefit
      from cross-session learning (sizing calibration, escaped-defect patterns)
- [ ] **Never** use `permissionMode: bypassPermissions` — role scoping is the entire point
- [ ] Verify each agent loads and respects its scope with a one-line smoke test

**Done when:** the Evidence Collector provably *cannot* edit source, and the PO provably
cannot fix a defect it rejected.

---

## Stage 3 — Thin slice (NEXUS-Micro, end to end)

**Goal:** prove one full loop closes. Do not proceed past this until it does.

Target flow, on the D3 request:

```
owner request
  → engagement-director       → company/intake/ENG-001.md
  → product-business-analyst → company/specs/SPEC-001.md + ambiguity register
  → product-owner        → approves spec, publishes DoD          [GATE 1]
  → project-manager-senior → company/backlog/ + tickets/T-001.md
  → engineering-*        → implementation
  → testing-evidence-collector → company/evidence/T-001/
  → product-owner        → accept / reject verdict               [GATE 2]
       ↳ reject → back to dev, max 3 attempts → escalate to owner
  → delivery
```

- [ ] Run it **manually first** — you play orchestrator, dispatching each role by hand.
      This surfaces schema gaps cheaply, before any script exists.
- [ ] Record every place a handoff lost context — those are `HANDOFF-SCHEMA.md` defects
- [ ] Confirm the ambiguity register actually blocks a task (deliberately leave one open)
- [ ] Confirm a rejection produces a *targeted* fix, not exploratory rework
- [ ] Confirm the state survives: close the session, reopen, resume from `company/` alone

**Done when:** the loop completes with a real deliverable, and a fresh session can pick it
up from disk with no conversation history.

---

## Stage 4 — Encode the process

**Goal:** the manual loop becomes a re-runnable script. Only now.

- [ ] Write `company/workflows/nexus-micro.js` — a Workflow script encoding:
      phases as `phase()`, the Dev↔QA retry loop as a bounded `while`, gates as
      hard stops that return to the owner
- [ ] The script owns control flow; agents own judgment. Retry counts, gate order, and
      escalation thresholds must be **deterministic**, not re-improvised per run
- [ ] Gate stops must be real stops — a script that auto-approves its own gates is theatre
- [ ] Re-run the Stage 3 engagement through the script; output must match the manual run
- [ ] Only then write `nexus-sprint.js`

**Done when:** the same request produces the same process twice.

---

## Stage 5 — Wire finance and scale

- [ ] Connect the budget envelope: Engagement Director sets it, PO prices change requests against it,
      `company/ledger.md` records estimate vs actual per engagement
- [ ] Feed the ledger back into Engagement Director sizing (this is what `memory: project` is for)
- [ ] Expand the roster one division at a time, re-running the thin slice after each
- [ ] Add the remaining NEXUS phases (0, 4, 5, 6) once Build+QA is stable

---

## Anti-goals

Things that will look tempting and are traps:

- **Do not** try to make agents delegate recursively. It is not supported, and simulating it
  with prose instructions produces agents that *claim* to have delegated.
- **Do not** start at NEXUS-Full. The roster is 60+ agents; a broken handoff schema at that
  scale is undebuggable.
- **Do not** let agents self-report success. Every gate needs an artifact a human or a
  differently-scoped agent can inspect. This is why QA cannot hold `Edit`.
- **Do not** build the workflow script before the manual run. The script will encode the
  schema gaps you have not found yet.
- **Do not** put client-confidential engagement data in a repo with a public upstream
  before answering D1.
