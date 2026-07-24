#!/usr/bin/env node
// office-server — the live backend for the Office tab (the "virtual office").
//
// This is the console's FIRST live backend. Everything else in company/ui is a
// build-time snapshot (`npm run data`); a pixel office that reacts in real time
// needs a running event source + a push channel. This server:
//   1. tails company.* in Postgres (new messages / task status changes / comments)
//      and pushes them over WebSocket, so the office animates as agents actually
//      communicate and move tickets;
//   2. accepts Claude Code hook POSTs (/hook) so a live session's tool-use can
//      drive fine-grained "typing / reading" for whichever agents are running now.
//
// Postgres is reached via the same `docker exec psql` path as company/mcp (host
// 127.0.0.1:5432 is shadowed by a native postgresql@16, so a TCP driver can't
// reach the container). We poll by max(id) every POLL_MS — simple and robust;
// LISTEN/NOTIFY is a future optimization.

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadEnv, queryJson, queryScalar, exec, lit } from '../mcp/db.mjs'

const PORT = Number(process.env.OFFICE_PORT || 5210)
const POLL_MS = Number(process.env.OFFICE_POLL_MS || 1000)
const env = loadEnv()

// ---- broadcast plumbing ---------------------------------------------------
const clients = new Set()
function broadcast(obj) {
  const text = JSON.stringify(obj)
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(text)
  }
}

// ---- snapshot a newly-connected client sees -------------------------------
// The React app already knows the roster/desks (static agents.json); the server
// only supplies the DYNAMIC state: which tickets exist and who is on them, so an
// agent already working shows up seated & typing on load.
function snapshot() {
  return queryJson(
    env,
    `SELECT json_build_object(
       'serverTime', now(),
       'tasks', (SELECT coalesce(json_agg(json_build_object(
           'id', id, 'assignee', assignee, 'status', status, 'priority', priority,
           'engagementId', engagement_id) ORDER BY id), '[]') FROM company.tasks),
       'recentMessages', (SELECT coalesce(json_agg(m ORDER BY (m->>'id')::bigint), '[]') FROM (
           SELECT json_build_object('id', id, 'from', from_agent, 'to', to_agent,
             'kind', kind, 'taskId', task_id) m
           FROM company.messages ORDER BY id DESC LIMIT 12) x)
     )`,
  )
}

// ---- change feed: poll by id, broadcast deltas ----------------------------
const cursor = { message: 0, status: 0, comment: 0 }

function initCursors() {
  const r = queryJson(
    env,
    `SELECT json_build_object(
       'message', coalesce((SELECT max(id) FROM company.messages), 0),
       'status',  coalesce((SELECT max(id) FROM company.status_events), 0),
       'comment', coalesce((SELECT max(id) FROM company.task_comments), 0))`,
  )
  cursor.message = Number(r.message)
  cursor.status = Number(r.status)
  cursor.comment = Number(r.comment)
}

function poll() {
  // New agent-to-agent messages -> "A walks to B / speech bubble".
  const msgs = queryJson(
    env,
    `SELECT coalesce(json_agg(json_build_object(
       'id', id, 'from', from_agent, 'to', to_agent, 'kind', kind,
       'body', left(body, 240), 'taskId', task_id, 'createdAt', created_at
     ) ORDER BY id), '[]')
     FROM company.messages WHERE id > ${cursor.message}`,
  )
  for (const m of msgs) {
    cursor.message = Math.max(cursor.message, Number(m.id))
    broadcast({ type: 'message', ...m })
  }

  // Task status transitions -> celebrate / fail / move animations.
  const evs = queryJson(
    env,
    `SELECT coalesce(json_agg(json_build_object(
       'id', e.id, 'taskId', e.entity_id, 'from', e.from_status, 'to', e.to_status,
       'by', e.changed_by, 'reason', left(e.reason, 240), 'assignee', t.assignee,
       'createdAt', e.created_at
     ) ORDER BY e.id), '[]')
     FROM company.status_events e
     LEFT JOIN company.tasks t ON t.id = e.entity_id
     WHERE e.entity_type = 'task' AND e.id > ${cursor.status}`,
  )
  for (const e of evs) {
    cursor.status = Math.max(cursor.status, Number(e.id))
    broadcast({ type: 'taskStatus', ...e })
  }

  // New ticket comments -> ping the author + any mentioned agents.
  const cmts = queryJson(
    env,
    `SELECT coalesce(json_agg(json_build_object(
       'id', id, 'taskId', task_id, 'agent', agent, 'mentions', mentions,
       'createdAt', created_at
     ) ORDER BY id), '[]')
     FROM company.task_comments WHERE id > ${cursor.comment}`,
  )
  for (const c of cmts) {
    cursor.comment = Math.max(cursor.comment, Number(c.id))
    broadcast({ type: 'comment', ...c })
  }
}

// ---- HTTP: health + config + Claude Code hook intake ----------------------
// Live Team Chat: channels + messages in the console's workspace.json shape.
function readChat() {
  return (
    queryJson(
      env,
      `SELECT json_build_object(
         'channels', (SELECT coalesce(json_agg(c ORDER BY cid), '[]') FROM (
           SELECT id AS cid, json_strip_nulls(json_build_object(
             'id', id, 'name', name, 'kind', kind, 'topic', topic, 'engagementId', engagement_id,
             'createdBy', created_by,
             'messages', (SELECT count(*) FROM company.messages m WHERE m.channel_id = channels.id),
             'createdAt', created_at)) c FROM company.channels WHERE NOT archived) cc),
         'messages', (SELECT coalesce(json_agg(m ORDER BY (m->>'id')::bigint), '[]') FROM (
           SELECT json_strip_nulls(json_build_object(
             'id', id, 'channelId', channel_id, 'engagementId', engagement_id, 'taskId', task_id,
             'fromAgent', from_agent, 'toAgent', to_agent, 'kind', kind, 'body', body,
             'reactions', (SELECT json_agg(json_build_object('emoji', emoji, 'agents', agents) ORDER BY emoji)
                 FROM (SELECT emoji, json_agg(agent ORDER BY agent) AS agents
                       FROM company.message_reactions r WHERE r.message_id = messages.id GROUP BY emoji) rr),
             'createdAt', created_at)) m FROM company.messages) mm)
       )`,
    ) || { channels: [], messages: [] }
  )
}

// Read the browser-side floor picks (division slug -> floor index 0..8).
function readFloors() {
  return (
    queryJson(env, `SELECT coalesce((SELECT value FROM company.office_config WHERE key = 'floors'), '{}'::jsonb)`) ||
    {}
  )
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

const http = createServer((req, res) => {
  // The console is a different origin (Vite dev), so allow cross-origin reads/writes.
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, clients: clients.size, cursor }))
    return
  }

  // Team Chat: live channels + messages, and the owner (CEO/CTO) sending a message.
  if (req.method === 'GET' && req.url === '/chat') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(readChat()))
    return
  }
  if (req.method === 'POST' && req.url === '/chat/send') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e5) req.destroy()
    })
    req.on('end', () => {
      try {
        const { channel, body: text, toAgent, kind } = JSON.parse(body || '{}')
        const msg = String(text ?? '').trim()
        if (typeof channel !== 'string' || !channel || !msg) throw new Error('channel + body required')
        if (queryScalar(env, `SELECT 1 FROM company.channels WHERE id = ${lit(channel)} AND NOT archived`) !== '1')
          throw new Error(`channel '${channel}' not found`)
        // Owner (CEO/CTO) posts as from_agent = NULL.
        const row = queryJson(
          env,
          `INSERT INTO company.messages (channel_id, engagement_id, from_agent, to_agent, kind, body)
           VALUES (${lit(channel)}, (SELECT engagement_id FROM company.channels WHERE id = ${lit(channel)}),
                   NULL, ${lit(toAgent ?? null)}, ${lit(kind ?? 'chat')}, ${lit(msg.slice(0, 8000))})
           RETURNING json_build_object('id', id, 'channelId', channel_id, 'engagementId', engagement_id,
             'taskId', task_id, 'fromAgent', from_agent, 'toAgent', to_agent, 'kind', kind, 'body', body,
             'createdAt', created_at);`,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: row }))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      }
    })
    return
  }

  // Durable Office config: per-department floor choices (survive across sessions).
  if (req.method === 'GET' && req.url === '/config/floors') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(readFloors()))
    return
  }
  if (req.method === 'POST' && req.url === '/config/floors') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e5) req.destroy()
    })
    req.on('end', () => {
      try {
        const { slug, index } = JSON.parse(body || '{}')
        const idx = Math.max(0, Math.min(64, Math.trunc(Number(index))))
        if (typeof slug !== 'string' || !slug || !Number.isFinite(idx)) throw new Error('bad payload')
        // Merge one key into the floors object (create the row if absent).
        exec(
          env,
          `INSERT INTO company.office_config (key, value)
           VALUES ('floors', jsonb_build_object(${lit(slug)}, ${idx}::int))
           ON CONFLICT (key) DO UPDATE SET
             value = company.office_config.value || jsonb_build_object(${lit(slug)}, ${idx}::int),
             updated_at = now();`,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, floors: readFloors() }))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      }
    })
    return
  }
  // Claude Code hooks POST tool-use events here (Stage-4 wiring). Body:
  //   { agent: "<slug>", phase: "start"|"done", tool: "Write"|"Grep"|..., needsInput?: bool }
  // We just fan it out; the office maps tool -> typing/reading for that agent.
  if (req.method === 'POST' && req.url === '/hook') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        const ev = JSON.parse(body || '{}')
        if (ev.agent) broadcast({ type: 'tool', ...ev })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"ok":false}')
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/office' })
wss.on('connection', (ws) => {
  clients.add(ws)
  try {
    ws.send(JSON.stringify({ type: 'hello', ...snapshot() }))
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', error: String(e.message || e) }))
  }
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

initCursors()
const timer = setInterval(() => {
  try {
    poll()
  } catch (e) {
    console.error('[office-server] poll error:', e.message || e)
  }
}, POLL_MS)
timer.unref?.()

http.listen(PORT, () => {
  console.log(`[office-server] ws://localhost:${PORT}/office  (poll ${POLL_MS}ms, db ${env.PGDATABASE})`)
})
