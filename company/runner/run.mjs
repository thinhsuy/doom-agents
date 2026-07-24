#!/usr/bin/env node
// run.mjs — the orchestration runtime slice. Drives task(s) through the REAL
// NEXUS Dev↔QA loop, writing state to company.tasks + status_events (+ handoff
// messages), so the Office (with office-server running) shows agents actually
// working continuously — not a one-shot animation.
//
// This is the state machine + DB integration of the runtime. Each phase is timed
// here as a stand-in; wiring real dev/QA subagents = replace the sleeps with agent
// calls, the transitions stay the same.
//
// BOUNDED so nothing runs forever (and the bounds are deliberately not too low):
//   • 3 QA rejections → escalate (the NEXUS retry cap)
//   • a per-task time budget → escalate
//   • a global run budget → stop
//   • one task per agent at a time (per-assignee sequential)
//
// Usage:
//   node run.mjs                 drive runnable tasks in ENG-001 (the sample)
//   node run.mjs ENG-001         drive a specific engagement
//   node run.mjs T-102           drive a single task
//   node run.mjs --reset         reset the ENG-001 sample tasks to a fresh start

import { loadEnv, exec, queryJson, lit } from '../mcp/db.mjs'

const env = loadEnv()
const QA_AGENT = 'testing-evidence-collector'

// ---- limits (env-overridable; defaults chosen with headroom) ---------------
const int = (k, d) => Math.max(0, Math.trunc(Number(process.env[k] ?? d)))
const MAX_ATTEMPTS = int('RUN_MAX_ATTEMPTS', 3) // NEXUS retry cap → escalate
const WORK_MS = int('RUN_WORK_MS', 12000) // dev works (in_progress)
const QA_MS = int('RUN_QA_MS', 7000) // QA reviews (in_qa)
const RETRY_MS = int('RUN_RETRY_MS', 2500) // pause before a retry
const MAX_TASK_MS = int('RUN_MAX_TASK_MS', 300000) // 5 min/task → escalate
const MAX_RUN_MS = int('RUN_MAX_MS', 1800000) // 30 min global stop

const num = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d)
const PASS_BASE = num('RUN_PASS_BASE', 0.55) // QA pass chance on the first attempt
const PASS_STEP = num('RUN_PASS_STEP', 0.25) // ...rising each retry (set both 0 to force fails)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[runner] ${m}`)

// Quality improves each retry so the loop converges within the cap; the cap is
// the hard backstop if it doesn't.
function qaPass(attempt) {
  return Math.random() < Math.min(0.98, PASS_BASE + PASS_STEP * attempt)
}

function setStatus(taskId, from, to, by, reason, attempt) {
  exec(
    env,
    `UPDATE company.tasks SET status = ${lit(to)}, attempt = ${attempt}, updated_at = now()
       WHERE id = ${lit(taskId)};
     INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason)
       VALUES ('task', ${lit(taskId)}, ${lit(from)}, ${lit(to)}, ${lit(by)}, ${lit(reason)});`,
  )
}

let msgSeq = 0
function postMsg(task, from, to, kind, body) {
  if (!from || !to) return
  exec(
    env,
    `INSERT INTO company.messages (channel_id, engagement_id, task_id, from_agent, to_agent, kind, body, idempotency_key)
     VALUES ((SELECT id FROM company.channels WHERE engagement_id = ${lit(task.engagementId)} AND NOT archived LIMIT 1),
             ${lit(task.engagementId)}, ${lit(task.id)}, ${lit(from)}, ${lit(to)}, ${lit(kind)}, ${lit(body)},
             ${lit(`run-${task.id}-${Date.now()}-${msgSeq++}`)})
     ON CONFLICT (idempotency_key) DO NOTHING;`,
  )
}

// Drive one task through the loop. Returns the terminal status.
async function runTask(task, globalDeadline) {
  const t0 = Date.now()
  const dev = task.assignee
  let status = task.status
  let attempt = Number(task.attempt) || 0
  log(`${task.id} (${dev ?? 'no-PIC'}) start — status=${status} attempt=${attempt}`)

  while (true) {
    if (Date.now() > globalDeadline || Date.now() - t0 > MAX_TASK_MS) {
      setStatus(task.id, status, 'escalated', 'runner', 'Quá hạn thời gian — cần owner', attempt)
      log(`${task.id} → escalated (hết thời gian)`)
      return 'escalated'
    }

    // Dev works.
    setStatus(task.id, status, 'in_progress', dev, attempt === 0 ? 'Bắt đầu làm' : `Sửa lại (lượt ${attempt + 1})`, attempt)
    status = 'in_progress'
    await sleep(WORK_MS)

    // Submit to QA.
    postMsg(task, dev, QA_AGENT, 'handoff', `${task.id} xong, mời QA (lượt ${attempt + 1})`)
    setStatus(task.id, status, 'in_qa', dev, 'Nộp QA', attempt)
    status = 'in_qa'
    await sleep(QA_MS)

    // Verdict.
    if (qaPass(attempt)) {
      postMsg(task, QA_AGENT, dev, 'qa_verdict', `${task.id} PASS ✅`)
      setStatus(task.id, 'in_qa', 'accepted', QA_AGENT, 'QA đạt', attempt)
      log(`${task.id} → accepted (sau ${attempt + 1} lượt)`)
      return 'accepted'
    }

    const next = Math.min(attempt + 1, MAX_ATTEMPTS)
    postMsg(task, QA_AGENT, dev, 'qa_verdict', `${task.id} FAIL ${next}/${MAX_ATTEMPTS}`)
    setStatus(task.id, 'in_qa', 'rejected', QA_AGENT, `QA chưa đạt (lượt ${next})`, next)
    status = 'rejected'
    attempt = next
    if (attempt >= MAX_ATTEMPTS) {
      setStatus(task.id, 'rejected', 'escalated', 'runner', `Hết ${MAX_ATTEMPTS} lượt QA — cần owner`, attempt)
      log(`${task.id} → escalated (hết lượt thử)`)
      return 'escalated'
    }
    await sleep(RETRY_MS)
  }
}

function loadRunnable(arg) {
  // A blocked task (blocked_by set) waits on a decision — skip it. Final states skip too.
  const where =
    arg && /^T-/i.test(arg)
      ? `id = ${lit(arg)}`
      : `engagement_id = ${lit(arg && /^ENG-/i.test(arg) ? arg : 'ENG-001')}`
  return (
    queryJson(
      env,
      `SELECT coalesce(json_agg(json_build_object(
         'id', id, 'engagementId', engagement_id, 'assignee', assignee, 'status', status, 'attempt', attempt
       ) ORDER BY id), '[]')
       FROM company.tasks
       WHERE ${where}
         AND status NOT IN ('accepted','escalated','deferred')
         AND blocked_by IS NULL`,
    ) || []
  )
}

function resetSample() {
  exec(
    env,
    `UPDATE company.tasks
       SET status = CASE WHEN status = 'deferred' THEN 'deferred' ELSE 'todo' END,
           attempt = 0, updated_at = now()
     WHERE engagement_id = 'ENG-001';`,
  )
  log('reset: ENG-001 tasks → todo (deferred kept), attempt 0')
}

// ---- main ------------------------------------------------------------------
const arg = process.argv[2]
if (arg === '--reset') {
  resetSample()
  process.exit(0)
}

const tasks = loadRunnable(arg)
if (!tasks.length) {
  log('không có task nào chạy được (đã xong/escalate/deferred/blocked). Thử: node run.mjs --reset')
  process.exit(0)
}

log(
  `chạy ${tasks.length} task, cap ${MAX_ATTEMPTS} lượt QA, ` +
    `work ${WORK_MS / 1000}s / QA ${QA_MS / 1000}s, hạn ${MAX_TASK_MS / 1000}s/task`,
)

// One task per agent at a time: group by assignee, sequential within a group,
// groups in parallel. Different agents work concurrently; the same agent never
// works two tasks at once (matches the office's "wait for a busy agent" model).
const byAssignee = new Map()
for (const t of tasks) {
  const k = t.assignee ?? '_owner'
  if (!byAssignee.has(k)) byAssignee.set(k, [])
  byAssignee.get(k).push(t)
}

const globalDeadline = Date.now() + MAX_RUN_MS
await Promise.all(
  [...byAssignee.values()].map(async (group) => {
    for (const task of group) {
      if (Date.now() > globalDeadline) break
      await runTask(task, globalDeadline)
    }
  }),
)

log('xong.')
