"""Read queries, ported 1:1 from company/ui/build.py so the API returns the exact
shapes the console expects — but LIVE from Postgres instead of a build snapshot.
"""

DECISIONS_SQL = """
SELECT json_build_object(
  'source', 'Postgres · doom_agents.company.decisions',
  'note', 'Dữ liệu đọc trực tiếp từ Postgres qua API. Sửa một quyết định thì cập nhật DB — không sửa mã nguồn.',
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

WORKSPACE_SQL = """
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

MONITOR_SQL = """
SELECT json_build_object(
  'note', 'Cost = usage × giá token thật (company.model_pricing). Throughput/token là dữ liệu MẪU cho tới khi agent chạy thật.',
  'sample', coalesce(bool_or(is_sample), false),
  'models', (SELECT coalesce(json_agg(json_build_object(
      'model', model, 'provider', provider,
      'inputPerMtok', input_per_mtok, 'outputPerMtok', output_per_mtok,
      'note', note, 'source', source) ORDER BY input_per_mtok), '[]'::json)
    FROM company.model_pricing),
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

# Live Team Chat (channels + messages), same shape as workspace.json.
CHAT_SQL = """
SELECT json_build_object(
  'channels', (SELECT coalesce(json_agg(c ORDER BY cid), '[]') FROM (
    SELECT id AS cid, json_strip_nulls(json_build_object(
      'id', id, 'name', name, 'kind', kind, 'topic', topic, 'engagementId', engagement_id,
      'createdBy', created_by,
      'messages', (SELECT count(*) FROM company.messages m WHERE m.channel_id = channels.id),
      'members', (SELECT coalesce(json_agg(cm.agent ORDER BY cm.agent), '[]')
                  FROM company.channel_members cm WHERE cm.channel_id = channels.id),
      'createdAt', created_at)) c FROM company.channels WHERE NOT archived) cc),
  'messages', (SELECT coalesce(json_agg(m ORDER BY (m->>'id')::bigint), '[]') FROM (
    SELECT json_strip_nulls(json_build_object(
      'id', id, 'channelId', channel_id, 'engagementId', engagement_id, 'taskId', task_id,
      'fromAgent', from_agent, 'toAgent', to_agent, 'kind', kind, 'body', body,
      'reactions', (SELECT json_agg(json_build_object('emoji', emoji, 'agents', agents) ORDER BY emoji)
          FROM (SELECT emoji, json_agg(agent ORDER BY agent) AS agents
                FROM company.message_reactions r WHERE r.message_id = messages.id GROUP BY emoji) rr),
      'createdAt', created_at)) m FROM company.messages) mm)
)
"""

# Office WS snapshot sent on connect.
OFFICE_SNAPSHOT_SQL = """
SELECT json_build_object(
  'serverTime', now(),
  'tasks', (SELECT coalesce(json_agg(json_build_object(
     'id', id, 'assignee', assignee, 'reporter', reporter, 'status', status, 'priority', priority,
     'engagementId', engagement_id) ORDER BY id), '[]') FROM company.tasks)
)
"""
