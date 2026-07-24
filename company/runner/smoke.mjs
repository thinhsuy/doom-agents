// smoke.mjs — drive a THROWAWAY task through the runner (fast timings), assert it
// reaches a bounded terminal state with real DB writes, then clean up. No ENG-001.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnv, exec, queryJson, queryScalar } from '../mcp/db.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = loadEnv()
let pass = 0
const check = (c, l) => {
  if (!c) throw new Error(`FAIL: ${l}`)
  console.log(`  ✓ ${l}`)
  pass++
}

exec(
  env,
  `INSERT INTO company.engagements (id,title,request_verbatim,mode,status,opened_by)
     VALUES ('ENG-RUNSMOKE','runner smoke','x','micro','build','engagement-director') ON CONFLICT (id) DO NOTHING;
   INSERT INTO company.tasks (id,engagement_id,requirement_id,title,assignee,status,priority,attempt)
     VALUES ('T-RUNSMOKE','ENG-RUNSMOKE','R-0','runner smoke task','engineering-backend-architect','todo','medium',0)
     ON CONFLICT (id) DO NOTHING;`,
)

try {
  await new Promise((resolve, reject) => {
    const p = spawn('node', [join(HERE, 'run.mjs'), 'T-RUNSMOKE'], {
      env: {
        ...process.env,
        RUN_WORK_MS: '150', RUN_QA_MS: '120', RUN_RETRY_MS: '80',
        RUN_MAX_ATTEMPTS: '3', RUN_MAX_TASK_MS: '20000', RUN_MAX_MS: '20000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stdout.on('data', (d) => process.stdout.write(d))
    p.stderr.on('data', (d) => process.stderr.write(d))
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`runner exit ${c}`))))
    setTimeout(() => reject(new Error('runner timeout')), 30000)
  })

  const t = queryJson(
    env,
    `SELECT json_build_object('status', status, 'attempt', attempt) FROM company.tasks WHERE id = 'T-RUNSMOKE'`,
  )
  check(['accepted', 'escalated'].includes(t.status), `task reached a terminal status (${t.status})`)
  check(Number(t.attempt) <= 3, `attempt stayed within the 3-retry cap (${t.attempt}/3)`)
  const ev = Number(
    queryScalar(env, `SELECT count(*) FROM company.status_events WHERE entity_type='task' AND entity_id='T-RUNSMOKE'`),
  )
  check(ev >= 2, `status transitions written to the audit log (${ev})`)
  const msgs = Number(queryScalar(env, `SELECT count(*) FROM company.messages WHERE task_id='T-RUNSMOKE'`))
  check(msgs >= 2, `handoff/verdict messages written for the office to animate (${msgs})`)

  console.log(`\nALL ${pass} CHECKS PASSED`)
} finally {
  exec(env, `DELETE FROM company.status_events WHERE entity_type='task' AND entity_id='T-RUNSMOKE';`)
  exec(env, `DELETE FROM company.engagements WHERE id='ENG-RUNSMOKE';`) // cascades task + messages
  console.log('cleaned up runner smoke')
}
