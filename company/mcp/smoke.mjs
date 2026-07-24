// smoke.mjs — drive the MCP server as two different agents over real MCP/stdio,
// proving create-channel / send / read / react end to end, that identity is
// server-side (an agent posts only as itself), then clean up.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnv, exec, lit } from './db.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'index.mjs')

async function connect(agentSlug) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env: { ...process.env, AGENT_SLUG: agentSlug ?? '' },
  })
  const client = new Client({ name: 'smoke', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content?.[0]?.text ?? '{}'
  const data = JSON.parse(text)
  if (r.isError) throw new Error(`${name} failed: ${data.error}`)
  return data
}

let pass = 0
const check = (cond, label) => {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`  ✓ ${label}`)
  pass++
}

const ed = await connect('engagement-director')
const po = await connect('product-owner')
let channelId

try {
  const me = await call(ed, 'whoami')
  check(me.agent === 'engagement-director', `whoami resolves identity (${me.name})`)

  const agents = await call(ed, 'list_agents')
  check(Array.isArray(agents) && agents.length >= 7, `list_agents returns roster (${agents.length})`)

  const ch = await call(ed, 'create_channel', {
    name: 'SMOKE — kênh thử',
    topic: 'kiểm tra MCP chat',
    kind: 'topic',
  })
  channelId = ch.id
  check(/^ch-/.test(ch.id), `create_channel returns id ${ch.id}`)

  const m1 = await call(ed, 'send_message', {
    channel: channelId,
    body: 'Chào cả nhóm — ai nhận task đầu tiên?',
    kind: 'chat',
  })
  check(typeof m1.id === 'number', `send_message returns id ${m1.id}`)

  // Product Owner replies — different identity, same channel.
  const m2 = await call(po, 'send_message', {
    channel: channelId,
    body: 'Tôi review trước khi giao.',
    kind: 'chat',
    toAgent: 'engagement-director',
  })
  check(m2.from === 'product-owner', `PO posts as itself, not the caller-supplied slug`)

  // PO reacts to the ED message.
  const rx = await call(po, 'react', { messageId: m1.id, emoji: '👍' })
  check(rx.active === true, `react adds 👍`)

  // ED reads the channel — should see both messages + the reaction, in order.
  const read = await call(ed, 'read_channel', { channel: channelId })
  check(read.messages.length === 2, `read_channel returns 2 messages`)
  check(read.messages[0].from === 'engagement-director', `first msg from ED`)
  check(read.messages[1].from === 'product-owner', `second msg from PO`)
  const thumb = read.messages[0].reactions.find((r) => r.emoji === '👍')
  check(
    thumb?.agents.length === 1 && thumb.agents[0] === 'product-owner',
    `reaction shows WHO reacted (product-owner 👍 on ED's message)`,
  )

  // Unread accounting: PO hasn't read, ED has.
  const edCh = (await call(ed, 'list_channels')).find((c) => c.id === channelId)
  const poCh = (await call(po, 'list_channels')).find((c) => c.id === channelId)
  check(edCh.unread === 0, `ED unread=0 after reading`)
  check(poCh.unread === 2, `PO unread=2 (hasn't read)`)

  // Toggle the reaction off.
  const rx2 = await call(po, 'react', { messageId: m1.id, emoji: '👍' })
  check(rx2.active === false, `react toggles 👍 off`)

  // ---- task tickets: a throwaway ticket the tools act on ------------------
  const env0 = loadEnv()
  exec(
    env0,
    `INSERT INTO company.engagements (id,title,request_verbatim,mode,status,opened_by)
       VALUES ('ENG-SMOKE','SMOKE eng','x','micro','build','engagement-director') ON CONFLICT (id) DO NOTHING;
     INSERT INTO company.tasks (id,engagement_id,requirement_id,title,detail,assignee,reporter,status,priority)
       VALUES ('T-SMOKE','ENG-SMOKE','R-0','Smoke ticket','mô tả smoke','engineering-backend-architect','project-manager-senior','todo','medium')
       ON CONFLICT (id) DO NOTHING;`,
  )

  const got = await call(ed, 'get_task', { taskId: 'T-SMOKE' })
  check(got.id === 'T-SMOKE' && got.status === 'todo', `get_task returns ticket detail`)

  const mv1 = await call(ed, 'update_task_status', { taskId: 'T-SMOKE', status: 'in_qa', reason: 'mời QA' })
  check(mv1.from === 'todo' && mv1.status === 'in_qa' && mv1.changed === true, `update_task_status todo→in_qa`)

  const mv2 = await call(po, 'update_task_status', { taskId: 'T-SMOKE', status: 'rejected', reason: 'FAIL' })
  check(mv2.status === 'rejected' && mv2.attempt === 1, `moving into rejected bumps attempt to 1`)

  const cm = await call(po, 'comment_task', {
    taskId: 'T-SMOKE',
    body: 'Còn 1 lượt — @engineering-backend-architect sửa nhé.',
    mentions: ['engineering-backend-architect'],
  })
  check(cm.from === 'product-owner' && typeof cm.id === 'number', `comment_task posts as caller identity`)

  const bad = await ed.callTool({ name: 'comment_task', arguments: { taskId: 'T-SMOKE', body: 'x', mentions: ['nope-not-real'] } })
  check(bad.isError === true, `comment_task rejects unknown mention slug`)

  const asg = await call(ed, 'assign_task', { taskId: 'T-SMOKE', assignee: 'engineering-frontend-developer' })
  check(asg.assignee === 'engineering-frontend-developer' && asg.previous === 'engineering-backend-architect', `assign_task reassigns PIC`)

  const pri = await call(ed, 'set_task_priority', { taskId: 'T-SMOKE', priority: 'urgent' })
  check(pri.previous === 'medium' && pri.priority === 'urgent', `set_task_priority medium→urgent`)

  const got2 = await call(ed, 'get_task', { taskId: 'T-SMOKE' })
  check(got2.priority === 'urgent' && got2.assignee === 'engineering-frontend-developer', `get_task reflects the changes`)
  check(got2.comments.length === 2 && got2.history.length === 2, `ticket has 2 comments (incl assign note) + 2 history events`)
  check(
    got2.comments.some((c) => c.agent === 'product-owner' && c.mentions.includes('engineering-backend-architect')),
    `comment records author + mentions`,
  )

  const mine = await call(ed, 'list_tasks', { engagementId: 'ENG-SMOKE', assignee: 'engineering-frontend-developer' })
  check(mine.length === 1 && mine[0].id === 'T-SMOKE', `list_tasks filters by engagement + assignee`)

  console.log(`\nALL ${pass} CHECKS PASSED`)
} finally {
  await ed.close()
  await po.close()
  const env = loadEnv()
  // Clean up the smoke channel (cascades messages, reactions, reads).
  if (channelId) {
    exec(env, `DELETE FROM company.channels WHERE id = ${lit(channelId)};`)
    console.log('cleaned up smoke channel')
  }
  // status_events has no FK to tasks (loose audit log), so clear it explicitly;
  // deleting the engagement cascades the task + its comments.
  exec(env, `DELETE FROM company.status_events WHERE entity_type='task' AND entity_id='T-SMOKE';`)
  exec(env, `DELETE FROM company.engagements WHERE id='ENG-SMOKE';`)
  console.log('cleaned up smoke task')
}
