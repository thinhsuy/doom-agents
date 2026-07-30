/** Shapes emitted by build.py and hand-authored in src/data/decisions.ts. */

/**
 * What happens to the tools:/disallowedTools: allowlist on a given runtime.
 * Derived by reading scripts/convert.sh — see company/runtimes.json.
 */
export type ScopingSupport = 'enforced' | 'carried' | 'dropped'

export interface AgentRuntime {
  /** tools.json key, e.g. 'claude-code' | 'codex' | 'gemini-cli'. */
  tool: string
  label: string
  short: string
  accent: string
  provider: string
  scoping: ScopingSupport
  /** Only meaningful on claude-code: opus | sonnet | haiku | fable | inherit. */
  model: string
  /** false = inheriting the company default; true = explicitly assigned. */
  assigned: boolean
  note: string
  /** Declares an allowlist but sits on a runtime that drops it — a real conflict. */
  scopingConflict: boolean
}

export interface Agent {
  /** The .md filename stem — the corpus id runbooks.json references. */
  slug: string
  division: string
  name: string
  description: string
  emoji: string
  color: string
  vibe: string
  /** Explicit tool allowlist from frontmatter; empty means unscoped. */
  tools: string[]
  /** '## ' headings in the body, excluding any inside fenced code blocks. */
  sections: string[]
  path: string
  words: number
  runtime: AgentRuntime
  /** In company/roster.json — i.e. actually on the payroll, not just in the catalog. */
  hired: boolean
  hiredGroup: string
  hiredWhy: string
}

export interface Division {
  slug: string
  label: string
  color: string
  icon: string
  emoji: string
  count: number
}

export interface RuntimeOption {
  tool: string
  label: string
  short: string
  accent: string
  provider: string
  scoping: ScopingSupport
}

export interface AgentRoster {
  generatedFrom: string
  divisions: Division[]
  agents: Agent[]
  /** tools.json key -> how many agents run on it. */
  runtimeCounts: Record<string, number>
  /** Every runtime option for the Providers picker. */
  runtimeCatalog: RuntimeOption[]
  defaultRuntime: string
  stats: {
    agents: number
    divisions: number
    scoped: number
    unscoped: number
    assigned: number
    runtimes: number
    scopingConflicts: number
    hired: number
    hiredScoped: number
    hiredUnscoped: number
  }
}

export type DecisionStatus = 'pending' | 'decided' | 'deferred' | 'cancelled'
export type DecisionUrgency = 'blocking' | 'normal'

export interface DecisionOption {
  label: string
  detail: string
  pros: string[]
  cons: string[]
}

export interface Decision {
  id: string
  title: string
  /** Agent slug — must resolve in the roster. */
  raisedBy: string
  /** Display name + emoji for the raiser, so the UI never hardcodes a role name. */
  raisedByName: string
  raisedByEmoji: string
  raisedAt: string
  status: DecisionStatus
  urgency: DecisionUrgency
  decider: string
  blocks: string[]
  question: string
  whyYou: string
  options: DecisionOption[]
  recommendation: string
  /** Optional — decisions raised live via the `raise_decision` tool don't set it. */
  costOfNotDeciding?: string
  /** Present once status is "decided" — what the owner actually ruled and why. */
  ruling?: string
}

export interface DecisionQueue {
  source: string
  note: string
  decisions: Decision[]
}

// ---- Workspace (from company.engagements / tasks / messages) ----

export interface Engagement {
  id: string
  title: string
  requestVerbatim: string
  mode: 'micro' | 'sprint' | 'full'
  status: 'intake' | 'spec' | 'build' | 'qa' | 'delivered' | 'cancelled'
  decider?: string
  openedBy?: string
  createdAt: string
  updatedAt: string
}

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_qa'
  | 'rejected'
  | 'accepted'
  | 'deferred'
  | 'escalated'
  | 'cancelled'

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

/** A follow-up comment on a task ticket (company.task_comments). */
export interface TaskComment {
  id: number
  /** Agent slug, or null/absent = the owner (CEO/CTO). */
  agent?: string
  body: string
  /** Agent slugs tagged in the comment (@mention). */
  mentions: string[]
  createdAt: string
}

/** One status transition from the audit log (company.status_events). */
export interface TaskHistoryEvent {
  from?: string
  to: string
  /** Agent slug or 'owner'. */
  by?: string
  reason?: string
  at: string
}

export interface Task {
  id: string
  engagementId: string
  requirementId?: string
  title: string
  detail?: string
  /** PIC — the agent doing the work. */
  assignee?: string
  /** Who opened the ticket. */
  reporter?: string
  status: TaskStatus
  priority: TaskPriority
  attempt: number
  blockedBy?: string
  comments: TaskComment[]
  history: TaskHistoryEvent[]
  createdAt: string
  updatedAt: string
}

export type MessageKind = 'chat' | 'handoff' | 'qa_verdict' | 'escalation' | 'ruling' | 'note'

export interface Message {
  id: number
  channelId?: string
  engagementId?: string
  taskId?: string
  /** null/absent = the owner (CEO/CTO); the human is not an agent. */
  fromAgent?: string
  toAgent?: string
  /** For owner-sent messages (no fromAgent): which owner account (CEO/CTO/COO/CIO) sent it. */
  ownerActor?: string
  kind: MessageKind
  body: string
  /** Uploaded image attachments (served by GET /api/attachments/{id}). */
  attachments?: MessageAttachment[]
  /** Tagged documents (folder/name paths) the agent was given to read. */
  docRefs?: string[]
  /** Per-emoji reactor list, present only when the message has reactions. */
  reactions?: MessageReaction[]
  createdAt: string
}
export interface MessageAttachment {
  id: number
  name: string
  mime: string
}

export interface MessageReaction {
  emoji: string
  /** Agent slugs who reacted with this emoji (count = agents.length). */
  agents: string[]
}

export interface Channel {
  id: string
  name: string
  kind: 'engagement' | 'topic' | 'dm'
  topic?: string
  engagementId?: string
  createdBy?: string
  messages: number
  /** Agent slugs in this group. Empty/absent = unscoped channel (anyone is mentionable).
      In every channel, a message that tags no one triggers no agent — replies need a tag. */
  members?: string[]
  createdAt?: string
}

export interface Workspace {
  engagements: Engagement[]
  channels: Channel[]
  tasks: Task[]
  messages: Message[]
}

// ---- Documents (company knowledge base, from company.documents / doc_folders) ----

export interface DocFolder {
  path: string
  description?: string
  createdBy?: string
}

export type DocFormat = 'markdown' | 'mermaid' | 'ppt' | 'text' | 'json' | 'code' | 'csv' | 'html'

export interface DocFile {
  id: number
  folder: string
  name: string
  format: DocFormat
  content: string
  author?: string
  engagementId?: string
  createdAt: string
  updatedAt: string
}

export interface DocsData {
  folders: DocFolder[]
  files: DocFile[]
}

// ---- Monitor (from company.usage_events × company.model_pricing) ----

export interface ModelPrice {
  model: string
  provider: string
  inputPerMtok: number
  outputPerMtok: number
  note?: string | null
  source: string
}

export interface AgentUsage {
  slug: string
  name: string
  division?: string
  hired: boolean
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Priced from real model_pricing; null if any model is unpriced. */
  costUsd: number
  models: string[]
  sample: boolean
  priceUnknown: boolean
}

/** One line item of estimated monthly AWS infrastructure cost (company.infra_pricing). */
export interface InfraCost {
  key: string
  service: string
  spec?: string | null
  monthlyUsd: number
  note?: string | null
  /** Tunable values (keys mirror infra/variables.tf) shown in the drawer. */
  config?: Record<string, string | number>
  lastDeployAt?: string | null
}

export interface Monitor {
  note: string
  sample: boolean
  models: ModelPrice[]
  /** Estimated monthly infra cost line items + total (AWS stack in infra/). */
  infra?: InfraCost[]
  infraMonthlyUsd?: number
  agents: AgentUsage[]
  totals: {
    requests: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number
    agents: number
  }
}

/** A company objective ("Mục tiêu") an agent owns, carrying a VIRTUAL revenue figure. */
export type GoalStatus = 'todo' | 'in_progress' | 'done' | 'at_risk'
export interface Goal {
  id: string
  title: string
  description: string | null
  owner: string | null
  ownerName: string
  ownerEmoji: string | null
  ownerDivision: string | null
  status: GoalStatus
  progress: number
  revenueUsd: number
  targetDate: string | null
  createdBy: string | null
}
export interface GoalFinance {
  revenueEarned: number
  revenuePipeline: number
  revenueTotal: number
  /** REAL revenue: realized gains from owners' declared investments (Σ (sell−buy)×qty), VND. */
  investmentRevenue: number
  goalsDone: number
  goalsTotal: number
  /** Real cost = LLM usage (to-date) + infra (monthly estimate). */
  costMonthlyUsd: number
  /** Real LLM usage cost to-date (company.usage_costed). */
  llmCostUsd?: number
  /** Estimated monthly infra cost (company.infra_pricing). */
  infraMonthlyUsd?: number
  /** Virtual revenue earned − real cost. */
  netRealized: number
  profitable: boolean
  /** null when nothing earned yet. */
  marginPct: number | null
}
/** Hired agent, minimal shape for the goal owner picker. */
export interface GoalOwnerOption {
  slug: string
  name: string
  emoji: string | null
  division: string | null
}
export interface GoalsData {
  goals: Goal[]
  finance: GoalFinance
  agents: GoalOwnerOption[]
}

/** An owner-declared investment position → the company's REAL revenue source. */
export type AssetType = 'stock' | 'etf' | 'crypto' | 'bond' | 'fund' | 'other'
export interface Investment {
  id: string
  owner: string
  ownerName: string
  symbol: string
  name?: string | null
  assetType: AssetType
  quantity: number
  buyPrice: number
  sellPrice?: number | null
  buyDate?: string | null
  sellDate?: string | null
  note?: string | null
  investedUsd: number
  /** (sell − buy) × qty, only once sold. */
  realizedUsd?: number | null
  sold: boolean
}
export interface InvestmentSummary {
  realizedRevenueUsd: number
  investedUsd: number
  openInvestedUsd: number
  positions: number
  openPositions: number
  soldPositions: number
}
export interface InvestmentEvent {
  id: number
  investmentId: string | null
  action: 'create' | 'update' | 'sell' | 'delete'
  actor: string | null
  actorName: string | null
  symbol: string | null
  summary: string
  /** Money figure behind the event (native VND): invested capital on create/delete,
      realized P&L on sell. Null for plain updates. */
  amount?: number | null
  createdAt: string
}

export interface InvestmentData {
  items: Investment[]
  summary: InvestmentSummary
  /** Recent Action History (who declared/updated/sold/deleted), newest first. */
  history?: InvestmentEvent[]
}
