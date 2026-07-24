// smoke.mjs — prove the live pipe end to end: spawn the server, connect a real
// WebSocket client, insert a row into company.messages, and assert the client
// receives it as a 'message' event. Then clean up. No mocks.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { loadEnv, exec, queryScalar, lit } from '../mcp/db.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 5211
const env = loadEnv()
const KEY = 'office-smoke-1'

let pass = 0
const check = (cond, label) => {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
  pass++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Clean any leftover from a previous aborted run.
exec(env, `DELETE FROM company.messages WHERE idempotency_key = ${lit(KEY)};`)

const server = spawn('node', [join(HERE, 'index.mjs')], {
  env: { ...process.env, OFFICE_PORT: String(PORT), OFFICE_POLL_MS: '250' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

let ws
let evId
try {
  // Wait for the server to listen.
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start in 8s')), 8000)
    server.stdout.on('data', (d) => {
      if (String(d).includes('office-server')) {
        clearTimeout(to)
        resolve()
      }
    })
    server.on('exit', (c) => reject(new Error(`server exited early (${c})`)))
  })

  const events = []
  ws = new WebSocket(`ws://localhost:${PORT}/office`)
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws connect timeout')), 5000)
  })
  ws.on('message', (buf) => events.push(JSON.parse(String(buf))))

  await sleep(300)
  const hello = events.find((e) => e.type === 'hello')
  check(!!hello, 'client receives hello snapshot on connect')
  check(Array.isArray(hello.tasks), `hello carries current task state (${hello.tasks.length} tasks)`)

  // Insert a real agent-to-agent message; the poll loop should stream it.
  const id = queryScalar(
    env,
    `INSERT INTO company.messages (engagement_id, from_agent, to_agent, kind, body, idempotency_key)
     VALUES (NULL, 'engagement-director', 'product-owner', 'chat',
             'office smoke: A nói với B', ${lit(KEY)}) RETURNING id;`,
  )
  check(Number(id) > 0, `inserted message id ${id}`)

  // Wait for it to arrive over the socket.
  let got
  for (let i = 0; i < 30 && !got; i++) {
    got = events.find((e) => e.type === 'message' && Number(e.id) === Number(id))
    if (!got) await sleep(200)
  }
  check(!!got, 'message streamed to the client over WebSocket')
  check(got.from === 'engagement-director' && got.to === 'product-owner', 'event carries from -> to (drives the A→B animation)')

  // A task status transition should stream with the assignee resolved (the
  // character the animation targets). T-103's PIC is the frontend developer.
  evId = queryScalar(
    env,
    `INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason)
     VALUES ('task', 'T-103', 'in_progress', 'in_qa', 'engineering-frontend-developer', 'office smoke')
     RETURNING id;`,
  )
  let st
  for (let i = 0; i < 30 && !st; i++) {
    st = events.find((e) => e.type === 'taskStatus' && Number(e.id) === Number(evId))
    if (!st) await sleep(200)
  }
  check(!!st, 'task status change streamed to the client')
  check(st.taskId === 'T-103' && st.assignee === 'engineering-frontend-developer', 'taskStatus resolves assignee for the animation')

  console.log(`\nALL ${pass} CHECKS PASSED`)
} finally {
  if (ws) ws.close()
  server.kill('SIGTERM')
  exec(env, `DELETE FROM company.messages WHERE idempotency_key = ${lit(KEY)};`)
  if (evId) exec(env, `DELETE FROM company.status_events WHERE id = ${lit(evId)};`)
  console.log('cleaned up smoke message + status event')
}
