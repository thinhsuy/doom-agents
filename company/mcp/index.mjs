#!/usr/bin/env node
// Agency chat MCP server — the communication channel between agent staff.
//
// Exposes chat tools (create channel, send, react, read, list) over MCP/stdio,
// backed by company.* in Postgres. IDENTITY IS SERVER-SIDE: the acting agent is
// read from the AGENT_SLUG env var, never from a tool argument — so one agent
// cannot post or react as another. Launch one instance per agent, each with its
// own AGENT_SLUG (see company/mcp/README.md). AGENT_SLUG unset = the owner.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { loadEnv, exec, lit, arr, queryJson, queryScalar } from './db.mjs'

const env = loadEnv()
const ME = process.env.AGENT_SLUG || null // server-side identity; null = owner

// Fail fast if a bogus identity was configured — better than silently posting
// as an agent that doesn't exist.
if (ME) {
  const ok = queryScalar(env, `SELECT 1 FROM company.agents WHERE slug = ${lit(ME)}`)
  if (ok !== '1') throw new Error(`AGENT_SLUG='${ME}' is not an agent in company.agents`)
}

const MSG_KINDS = ['chat', 'handoff', 'qa_verdict', 'escalation', 'ruling', 'note']
const TASK_STATUSES = ['todo', 'in_progress', 'in_qa', 'rejected', 'accepted', 'deferred', 'escalated', 'cancelled']
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent']

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
const fail = (msg) => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true })

function channelExists(id) {
  return queryScalar(env, `SELECT 1 FROM company.channels WHERE id = ${lit(id)} AND NOT archived`) === '1'
}

function agentExists(slug) {
  return queryScalar(env, `SELECT 1 FROM company.agents WHERE slug = ${lit(slug)}`) === '1'
}

/** Full ticket detail (fields + comments + history), the shape the console uses. */
function taskDetail(id) {
  return queryJson(
    env,
    `SELECT json_build_object(
       'id', t.id, 'engagementId', t.engagement_id, 'requirementId', t.requirement_id,
       'title', t.title, 'detail', t.detail, 'assignee', t.assignee, 'reporter', t.reporter,
       'status', t.status, 'priority', t.priority, 'attempt', t.attempt, 'blockedBy', t.blocked_by,
       'createdAt', t.created_at, 'updatedAt', t.updated_at,
       'comments', (SELECT coalesce(json_agg(json_build_object(
           'id', c.id, 'agent', c.agent, 'body', c.body, 'mentions', c.mentions,
           'createdAt', c.created_at) ORDER BY c.created_at), '[]'::json)
         FROM company.task_comments c WHERE c.task_id = t.id),
       'history', (SELECT coalesce(json_agg(json_build_object(
           'from', e.from_status, 'to', e.to_status, 'by', e.changed_by,
           'reason', e.reason, 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::json)
         FROM company.status_events e WHERE e.entity_type = 'task' AND e.entity_id = t.id)
     )
     FROM company.tasks t WHERE t.id = ${lit(id)}`,
  )
}

const server = new McpServer({ name: 'agency-chat', version: '0.1.0' })

// ---- who am I -------------------------------------------------------------
server.registerTool(
  'whoami',
  {
    title: 'Who am I',
    description: 'Return the identity this chat connection posts as, and where it connects.',
    inputSchema: {},
  },
  async () => {
    const name = ME
      ? queryScalar(env, `SELECT name FROM company.agents WHERE slug = ${lit(ME)}`)
      : 'CEO / CTO (owner)'
    return ok({ agent: ME, name, database: env.PGDATABASE, container: env.PGCONTAINER })
  },
)

// ---- who can I talk to ----------------------------------------------------
server.registerTool(
  'list_agents',
  {
    title: 'List agent staff',
    description: 'List hired agents you can message (slug + name + group).',
    inputSchema: {},
  },
  async () =>
    ok(
      queryJson(
        env,
        `SELECT coalesce(json_agg(json_build_object('slug',slug,'name',name,'group',hired_group) ORDER BY name),'[]')
         FROM company.agents WHERE hired`,
      ),
    ),
)

// ---- channels -------------------------------------------------------------
server.registerTool(
  'list_channels',
  {
    title: 'List channels',
    description: 'List active chat channels with message and unread counts (unread is relative to you).',
    inputSchema: {},
  },
  async () =>
    ok(
      queryJson(
        env,
        `SELECT coalesce(json_agg(json_build_object(
           'id', c.id, 'name', c.name, 'kind', c.kind, 'topic', c.topic,
           'engagementId', c.engagement_id,
           'messages', (SELECT count(*) FROM company.messages m WHERE m.channel_id = c.id),
           'unread', (SELECT count(*) FROM company.messages m WHERE m.channel_id = c.id
                        AND m.id > coalesce((SELECT last_read_message_id FROM company.channel_reads r
                                             WHERE r.channel_id = c.id AND r.agent = ${lit(ME)}), 0))
         ) ORDER BY c.created_at), '[]')
         FROM company.channels c WHERE NOT c.archived`,
      ),
    ),
)

server.registerTool(
  'create_channel',
  {
    title: 'Create channel',
    description: 'Create a project group chat. Returns the new channel id to use with send_message.',
    inputSchema: {
      name: z.string().min(1).max(120).describe('Channel name, e.g. "Thanh toán Q3"'),
      topic: z.string().max(500).optional().describe('What the channel is for'),
      engagementId: z.string().optional().describe('Link to an engagement id (e.g. ENG-001), if any'),
      kind: z.enum(['topic', 'engagement', 'dm']).optional().describe('Default "topic"'),
    },
  },
  async ({ name, topic, engagementId, kind }) => {
    const id = 'ch-' + randomUUID().slice(0, 8)
    const engRef = engagementId
      ? `(SELECT id FROM company.engagements WHERE id = ${lit(engagementId)})`
      : 'NULL'
    try {
      exec(
        env,
        `INSERT INTO company.channels (id, name, topic, kind, engagement_id, created_by)
         VALUES (${lit(id)}, ${lit(name)}, ${lit(topic ?? null)}, ${lit(kind ?? 'topic')},
                 ${engRef}, ${lit(ME)});`,
      )
    } catch (e) {
      return fail(String(e.message || e))
    }
    return ok({ id, name, kind: kind ?? 'topic', topic: topic ?? null, engagementId: engagementId ?? null })
  },
)

// ---- read + send + react --------------------------------------------------
server.registerTool(
  'read_channel',
  {
    title: 'Read a channel',
    description: 'Read the latest messages in a channel (with reactions) and mark it read for you.',
    inputSchema: {
      channel: z.string().describe('Channel id (from list_channels)'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
  },
  async ({ channel, limit }) => {
    if (!channelExists(channel)) return fail(`channel '${channel}' not found`)
    const rows = queryJson(
      env,
      `SELECT coalesce(json_agg(x ORDER BY (x->>'id')::bigint), '[]') FROM (
         SELECT json_build_object(
           'id', m.id, 'from', m.from_agent, 'to', m.to_agent, 'kind', m.kind,
           'body', m.body, 'taskId', m.task_id, 'createdAt', m.created_at,
           'reactions', (SELECT coalesce(json_agg(json_build_object('emoji', emoji, 'agents', agents) ORDER BY emoji), '[]'::json)
                         FROM (SELECT emoji, json_agg(agent ORDER BY agent) AS agents
                               FROM company.message_reactions r WHERE r.message_id = m.id GROUP BY emoji) e)
         ) AS x
         FROM (SELECT * FROM company.messages WHERE channel_id = ${lit(channel)}
               ORDER BY id DESC LIMIT ${Math.trunc(limit ?? 50)}) m
       ) t`,
    )
    // Mark read (only meaningful for a real agent identity).
    if (ME) {
      exec(
        env,
        `INSERT INTO company.channel_reads (channel_id, agent, last_read_message_id, updated_at)
         VALUES (${lit(channel)}, ${lit(ME)},
                 (SELECT max(id) FROM company.messages WHERE channel_id = ${lit(channel)}), now())
         ON CONFLICT (channel_id, agent) DO UPDATE SET
           last_read_message_id = EXCLUDED.last_read_message_id, updated_at = now();`,
      )
    }
    return ok({ channel, messages: rows })
  },
)

server.registerTool(
  'send_message',
  {
    title: 'Send a message',
    description: 'Post a message to a channel as yourself. kind marks intent (chat/handoff/qa_verdict/escalation/ruling/note).',
    inputSchema: {
      channel: z.string().describe('Channel id (from list_channels / create_channel)'),
      body: z.string().min(1).max(8000).describe('Message text'),
      kind: z.enum(MSG_KINDS).optional().describe('Default "chat"'),
      toAgent: z.string().optional().describe('Direct this at an agent slug (null = whole channel)'),
      taskId: z.string().optional().describe('Reference a task id (e.g. T-102)'),
    },
  },
  async ({ channel, body, kind, toAgent, taskId }) => {
    if (!channelExists(channel)) return fail(`channel '${channel}' not found`)
    try {
      const id = queryScalar(
        env,
        `INSERT INTO company.messages
           (channel_id, engagement_id, task_id, from_agent, to_agent, kind, body)
         VALUES (${lit(channel)},
                 (SELECT engagement_id FROM company.channels WHERE id = ${lit(channel)}),
                 ${lit(taskId ?? null)}, ${lit(ME)}, ${lit(toAgent ?? null)},
                 ${lit(kind ?? 'chat')}, ${lit(body)})
         RETURNING id;`,
      )
      return ok({ id: Number(id), channel, from: ME, kind: kind ?? 'chat' })
    } catch (e) {
      return fail(String(e.message || e))
    }
  },
)

server.registerTool(
  'react',
  {
    title: 'React to a message',
    description: 'Toggle an emoji reaction on a message as yourself.',
    inputSchema: {
      messageId: z.number().int().describe('Message id (from read_channel)'),
      emoji: z.string().min(1).max(16).describe('An emoji, e.g. 👍 ✅ 🔥'),
    },
  },
  async ({ messageId, emoji }) => {
    if (!ME) return fail('reacting requires an agent identity (set AGENT_SLUG)')
    const mid = Math.trunc(messageId)
    try {
      // Toggle: remove if present, else add.
      const removed = queryScalar(
        env,
        `WITH d AS (DELETE FROM company.message_reactions
                    WHERE message_id = ${mid} AND agent = ${lit(ME)} AND emoji = ${lit(emoji)}
                    RETURNING 1)
         SELECT count(*) FROM d;`,
      )
      if (removed === '0') {
        exec(
          env,
          `INSERT INTO company.message_reactions (message_id, agent, emoji)
           VALUES (${mid}, ${lit(ME)}, ${lit(emoji)}) ON CONFLICT DO NOTHING;`,
        )
      }
      return ok({ messageId: mid, emoji, active: removed === '0' })
    } catch (e) {
      return fail(String(e.message || e))
    }
  },
)

// ---- task tickets ---------------------------------------------------------
// The board agents actually work from. Identity is server-side: a status change
// or comment is always attributed to AGENT_SLUG, never a caller-supplied name.

server.registerTool(
  'list_tasks',
  {
    title: 'List task tickets',
    description: 'List task tickets, optionally filtered. Use mine=true for tickets assigned to you.',
    inputSchema: {
      engagementId: z.string().optional().describe('Filter to one engagement (e.g. ENG-001)'),
      status: z.enum(TASK_STATUSES).optional().describe('Filter by status'),
      assignee: z.string().optional().describe('Filter by PIC agent slug'),
      mine: z.boolean().optional().describe('Only tickets assigned to you (overrides assignee)'),
    },
  },
  async ({ engagementId, status, assignee, mine }) => {
    const where = []
    if (engagementId) where.push(`engagement_id = ${lit(engagementId)}`)
    if (status) where.push(`status = ${lit(status)}`)
    const pic = mine ? ME : assignee
    if (mine && !ME) return fail('mine=true requires an agent identity (set AGENT_SLUG)')
    if (pic) where.push(`assignee = ${lit(pic)}`)
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return ok(
      queryJson(
        env,
        `SELECT coalesce(json_agg(json_build_object(
           'id', id, 'title', title, 'status', status, 'priority', priority,
           'assignee', assignee, 'reporter', reporter, 'requirementId', requirement_id,
           'attempt', attempt, 'blockedBy', blocked_by, 'engagementId', engagement_id,
           'comments', (SELECT count(*) FROM company.task_comments c WHERE c.task_id = tasks.id)
         ) ORDER BY id), '[]')
         FROM company.tasks ${clause}`,
      ),
    )
  },
)

server.registerTool(
  'get_task',
  {
    title: 'Get a task ticket',
    description: 'Full ticket detail: PIC, reporter, status, priority, description, comments, and status history.',
    inputSchema: { taskId: z.string().describe('Task id, e.g. T-102') },
  },
  async ({ taskId }) => {
    const detail = taskDetail(taskId)
    if (!detail) return fail(`task '${taskId}' not found`)
    return ok(detail)
  },
)

server.registerTool(
  'update_task_status',
  {
    title: 'Change task status',
    description:
      'Move a ticket to a new status. Records the transition in the audit log as you. ' +
      'Moving INTO "rejected" (a failed QA round) bumps the attempt toward the 3-try cap.',
    inputSchema: {
      taskId: z.string().describe('Task id, e.g. T-105'),
      status: z.enum(TASK_STATUSES).describe('New status'),
      reason: z.string().max(2000).optional().describe('Why — shown in the history timeline'),
    },
  },
  async ({ taskId, status, reason }) => {
    if (status === 'cancelled' && !(reason && reason.trim()))
      return fail('huỷ task BẮT BUỘC kèm lý do chính đáng (reason)')
    const cur = queryJson(
      env,
      `SELECT json_build_object('status', status, 'attempt', attempt)
       FROM company.tasks WHERE id = ${lit(taskId)}`,
    )
    if (!cur) return fail(`task '${taskId}' not found`)
    if (cur.status === status) return ok({ taskId, status, attempt: cur.attempt, changed: false })
    // A failed QA round counts against the NEXUS 3-try cap; other moves keep attempt.
    const attempt = status === 'rejected' ? Math.min(cur.attempt + 1, 3) : cur.attempt
    try {
      exec(
        env,
        `UPDATE company.tasks SET status = ${lit(status)}, attempt = ${attempt}, updated_at = now()
           WHERE id = ${lit(taskId)};
         INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason)
           VALUES ('task', ${lit(taskId)}, ${lit(cur.status)}, ${lit(status)}, ${lit(ME ?? 'owner')}, ${lit(reason ?? null)});`,
      )
    } catch (e) {
      return fail(String(e.message || e))
    }
    return ok({ taskId, from: cur.status, status, attempt, changed: true })
  },
)

server.registerTool(
  'comment_task',
  {
    title: 'Comment on a task',
    description: 'Add a follow-up comment to a ticket as yourself. Use mentions to tag agents (e.g. a manager).',
    inputSchema: {
      taskId: z.string().describe('Task id, e.g. T-102'),
      body: z.string().min(1).max(8000).describe('Comment text'),
      mentions: z.array(z.string()).optional().describe('Agent slugs to tag, e.g. ["project-manager-senior"]'),
    },
  },
  async ({ taskId, body, mentions }) => {
    if (queryScalar(env, `SELECT 1 FROM company.tasks WHERE id = ${lit(taskId)}`) !== '1')
      return fail(`task '${taskId}' not found`)
    const tags = mentions ?? []
    const unknown = tags.filter((m) => !agentExists(m))
    if (unknown.length) return fail(`unknown agent slug(s) in mentions: ${unknown.join(', ')}`)
    try {
      const id = queryScalar(
        env,
        `INSERT INTO company.task_comments (task_id, agent, body, mentions)
         VALUES (${lit(taskId)}, ${lit(ME)}, ${lit(body)}, ${arr(tags)}) RETURNING id;`,
      )
      return ok({ id: Number(id), taskId, from: ME, mentions: tags })
    } catch (e) {
      return fail(String(e.message || e))
    }
  },
)

server.registerTool(
  'assign_task',
  {
    title: 'Assign a task (set PIC)',
    description: 'Reassign the PIC of a ticket to an agent. Records the change in the audit log.',
    inputSchema: {
      taskId: z.string().describe('Task id, e.g. T-104'),
      assignee: z.string().describe('Agent slug to make PIC'),
    },
  },
  async ({ taskId, assignee }) => {
    const prev = queryScalar(env, `SELECT coalesce(assignee,'') FROM company.tasks WHERE id = ${lit(taskId)}`)
    if (prev === '') {
      if (queryScalar(env, `SELECT 1 FROM company.tasks WHERE id = ${lit(taskId)}`) !== '1')
        return fail(`task '${taskId}' not found`)
    }
    if (!agentExists(assignee)) return fail(`assignee '${assignee}' is not an agent`)
    try {
      exec(
        env,
        `UPDATE company.tasks SET assignee = ${lit(assignee)}, updated_at = now() WHERE id = ${lit(taskId)};
         INSERT INTO company.task_comments (task_id, agent, body, mentions)
           VALUES (${lit(taskId)}, ${lit(ME)},
                   ${lit(`Giao PIC cho @${assignee}.`)}, ${arr([assignee])});`,
      )
    } catch (e) {
      return fail(String(e.message || e))
    }
    return ok({ taskId, assignee, previous: prev || null })
  },
)

server.registerTool(
  'set_task_priority',
  {
    title: 'Set task priority',
    description: 'Change a ticket priority (low / medium / high / urgent).',
    inputSchema: {
      taskId: z.string().describe('Task id'),
      priority: z.enum(TASK_PRIORITIES).describe('New priority'),
    },
  },
  async ({ taskId, priority }) => {
    const prev = queryScalar(env, `SELECT priority FROM company.tasks WHERE id = ${lit(taskId)}`)
    if (!prev) return fail(`task '${taskId}' not found`)
    if (prev === priority) return ok({ taskId, priority, changed: false })
    try {
      exec(env, `UPDATE company.tasks SET priority = ${lit(priority)}, updated_at = now() WHERE id = ${lit(taskId)};`)
    } catch (e) {
      return fail(String(e.message || e))
    }
    return ok({ taskId, priority, previous: prev, changed: true })
  },
)

server.registerTool(
  'create_task',
  {
    title: 'Create a task ticket',
    description:
      'Create a new ticket (goes on the Task board, engagement ENG-OPS) with you as reporter. ' +
      'Optionally set the PIC right away.',
    inputSchema: {
      title: z.string().min(1).max(300).describe('Short title'),
      detail: z.string().max(4000).optional().describe('What to do + done criteria'),
      assignee: z.string().optional().describe('Hired agent slug to make PIC'),
      priority: z.enum(TASK_PRIORITIES).optional().describe('Default medium'),
    },
  },
  async ({ title, detail, assignee, priority }) => {
    if (assignee && !agentExists(assignee)) return fail(`assignee '${assignee}' is not an agent`)
    try {
      exec(
        env,
        `INSERT INTO company.engagements (id, title, request_verbatim, mode, status)
           VALUES ('ENG-OPS', 'Giao việc trực tiếp (Ban lãnh đạo)',
                   'Task do lead tạo từ chỉ đạo của CEO/CTO', 'micro', 'build')
           ON CONFLICT (id) DO NOTHING;`,
      )
      const id = queryScalar(
        env,
        `SELECT 'T-'||(coalesce(max(substring(id from 3)::int),200)+1) FROM company.tasks WHERE id ~ '^T-[0-9]+$'`,
      )
      exec(
        env,
        `INSERT INTO company.tasks (id, engagement_id, title, detail, assignee, status, attempt, priority, reporter)
           VALUES (${lit(id)}, 'ENG-OPS', ${lit(title)}, ${lit(detail ?? null)}, ${lit(assignee ?? null)},
                   'todo', 0, ${lit(priority ?? 'medium')}, ${lit(ME)});
         INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason)
           VALUES ('task', ${lit(id)}, NULL, 'todo', ${lit(ME ?? 'owner')}, 'created');`,
      )
      return ok({ taskId: id, assignee: assignee ?? null, reporter: ME })
    } catch (e) {
      return fail(String(e.message || e))
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
