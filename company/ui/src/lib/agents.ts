import rosterJson from '../data/agents.json'
import type { AgentRoster } from '../types'

const roster = rosterJson as AgentRoster
const bySlug = new Map(roster.agents.map((a) => [a.slug, a]))

export interface MentionAgent {
  slug: string
  name: string
  emoji: string
  color: string
  division: string
}

/** Hired agents you can @mention in chat (longest name first for greedy matching). */
export const hiredAgents: MentionAgent[] = roster.agents
  .filter((a) => a.hired)
  .map((a) => ({ slug: a.slug, name: a.name, emoji: a.emoji || '👤', color: a.color || '#8A90A8', division: a.division }))
  .sort((a, b) => b.name.length - a.name.length)

/** The 3 owner accounts (CEO/CTO/COO) are also staff members: addable to groups,
    @mentionable, and task-assignable. They are HUMANS — the backend never auto-replies
    or auto-works as them. Slugs mirror company.users / the owner agent rows. */
export const OWNER_MEMBERS: MentionAgent[] = [
  { slug: 'ceo', name: 'CEO', emoji: '👑', color: '#4E5AE8', division: 'Ban điều hành' },
  { slug: 'cto', name: 'CTO', emoji: '🛠️', color: '#4E5AE8', division: 'Ban điều hành' },
  { slug: 'coo', name: 'COO', emoji: '⚙️', color: '#4E5AE8', division: 'Ban điều hành' },
  { slug: 'cio', name: 'CIO', emoji: '🗄️', color: '#4E5AE8', division: 'Ban điều hành' },
]
const OWNER_SLUGS = new Set(OWNER_MEMBERS.map((o) => o.slug))
export const isOwnerSlug = (slug?: string | null): boolean => !!slug && OWNER_SLUGS.has(slug)

/** Everyone who can be a group member / @mentioned / assigned a task: owners + agents. */
export const allMembers: MentionAgent[] = [...OWNER_MEMBERS, ...hiredAgents].sort(
  (a, b) => b.name.length - a.name.length,
)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Broadcast mention: '@Ban lãnh đạo' (or '@all') → every lead replies in turn.
    slug '@leads' is a backend keyword, not an agent row. */
export const LEADS_MENTION: MentionAgent = {
  slug: '@leads',
  name: 'Ban lãnh đạo',
  emoji: '👑',
  color: '#4E5AE8',
  division: 'tất cả lead/manager',
}

/** Mirror of the backend LEAD_SLUGS (the '@Ban lãnh đạo' roster). */
export const LEAD_SLUGS = [
  'engagement-director',
  'project-manager-senior',
  'product-owner',
  'engineering-software-architect',
  'security-architect',
]

/** Resolve the FIRST @<agent name> mention in text (word-bounded) to an agent.
    `pool` scopes what can be mentioned (e.g. a group's members). */
export function resolveMention(
  text: string,
  pool: MentionAgent[] = [LEADS_MENTION, ...allMembers],
): MentionAgent | null {
  let best: { agent: MentionAgent; index: number } | null = null
  for (const a of pool) {
    // '@Name' followed by end-of-string or a non-word char (word boundary after).
    const m = text.match(new RegExp(`@${escapeRe(a.name)}(?![\\p{L}\\p{N}_])`, 'iu'))
    if (m && m.index !== undefined && (best === null || m.index < best.index)) {
      best = { agent: a, index: m.index }
    }
  }
  if (!best && pool.includes(LEADS_MENTION)) {
    // '@all' shorthand for the leadership broadcast.
    const m = text.match(/@all(?![\p{L}\p{N}_])/iu)
    if (m) return LEADS_MENTION
  }
  return best?.agent ?? null
}

/** Resolve ALL distinct @<agent name> mentions in text (word-bounded), in order of
    appearance — so tagging several agents triggers each of them. */
export function resolveMentions(
  text: string,
  pool: MentionAgent[] = [LEADS_MENTION, ...allMembers],
): MentionAgent[] {
  const hits: { agent: MentionAgent; index: number }[] = []
  for (const a of pool) {
    const m = text.match(new RegExp(`@${escapeRe(a.name)}(?![\\p{L}\\p{N}_])`, 'iu'))
    if (m && m.index !== undefined) hits.push({ agent: a, index: m.index })
  }
  if (pool.includes(LEADS_MENTION) && !hits.some((h) => h.agent === LEADS_MENTION)) {
    const m = text.match(/@all(?![\p{L}\p{N}_])/iu)
    if (m && m.index !== undefined) hits.push({ agent: LEADS_MENTION, index: m.index })
  }
  hits.sort((x, y) => x.index - y.index)
  const seen = new Set<string>()
  return hits.filter((h) => (seen.has(h.agent.slug) ? false : seen.add(h.agent.slug))).map((h) => h.agent)
}

export interface Display {
  name: string
  emoji: string
  color: string
}

const OWNER: Display = { name: 'CEO / CTO', emoji: '🧑‍💼', color: '#4E5AE8' }
const OWNER_BY_SLUG = new Map(OWNER_MEMBERS.map((o) => [o.slug, o]))

/** Resolve an agent slug for display. No slug = the generic owner; an owner slug
    (ceo/cto/coo) = that specific human; otherwise the agent. */
export function agentDisplay(slug?: string | null): Display {
  if (!slug) return OWNER
  const owner = OWNER_BY_SLUG.get(slug)
  if (owner) return { name: owner.name, emoji: owner.emoji, color: owner.color }
  const a = bySlug.get(slug)
  if (!a) return { name: slug, emoji: '👤', color: '#8A90A8' }
  return { name: a.name, emoji: a.emoji || '👤', color: a.color || '#8A90A8' }
}
