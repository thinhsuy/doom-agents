import { useEffect, useMemo, useState } from 'react'
import type { Agent, Division } from '../types'
import { Icon } from './Icon'
import { tint } from '../lib/color'
import s from './AgentDirectory.module.css'
import p from './Panel.module.css'

/** Roles authored specifically for the virtual company — flagged in the directory. */
export const NEW_ROLES = new Set(['product-business-analyst', 'product-owner', 'engagement-director'])

export type DirectoryView = 'cards' | 'tree'
export type DirectoryScope = 'hired' | 'all'
const VIEW_KEY = 'agency-os.directory-view'
const SCOPE_KEY = 'agency-os.directory-scope'

interface Props {
  divisions: Division[]
  agents: Agent[]
  query: string
  onQueryChange: (q: string) => void
  selectedSlug?: string
  onSelect: (slug: string) => void
  /** Division forced open regardless of local toggle state (e.g. deep link target). */
  forceOpen?: string
}

export function AgentDirectory({
  divisions,
  agents,
  query,
  onQueryChange,
  selectedSlug,
  onSelect,
  forceOpen,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [expandAll, setExpandAll] = useState(false)
  const [view, setView] = useState<DirectoryView>(() => {
    const saved = localStorage.getItem(VIEW_KEY)
    return saved === 'tree' || saved === 'cards' ? saved : 'cards'
  })

  const [scope, setScope] = useState<DirectoryScope>(() => {
    const saved = localStorage.getItem(SCOPE_KEY)
    return saved === 'all' || saved === 'hired' ? saved : 'hired'
  })

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  useEffect(() => {
    localStorage.setItem(SCOPE_KEY, scope)
  }, [scope])

  const hiredCount = useMemo(() => agents.filter((a) => a.hired).length, [agents])

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, Agent[]>()
    for (const a of agents) {
      if (scope === 'hired' && !a.hired) continue
      if (
        q &&
        !a.name.toLowerCase().includes(q) &&
        !a.description.toLowerCase().includes(q) &&
        !a.slug.toLowerCase().includes(q)
      ) {
        continue
      }
      const list = map.get(a.division)
      if (list) list.push(a)
      else map.set(a.division, [a])
    }
    return map
  }, [agents, query, scope])

  const searching = query.trim().length > 0
  const visible = divisions.filter((d) => (grouped.get(d.slug)?.length ?? 0) > 0)
  const matched = visible.reduce((n, d) => n + (grouped.get(d.slug)?.length ?? 0), 0)

  function toggle(slug: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  function toggleAll() {
    const next = !expandAll
    setExpandAll(next)
    setOpen(next ? new Set(divisions.map((d) => d.slug)) : new Set())
  }

  return (
    <div className={p.panel}>
      <div className={p.head}>
        <h2 className={p.title}>
          Sơ đồ tổ chức{' '}
          <span className={p.hint}>
            · {matched} nhân sự{searching ? ` khớp “${query.trim()}”` : ''}
          </span>
        </h2>

        <div className={s.toggle} role="group" aria-label="Phạm vi">
          <button
            className={scope === 'hired' ? `${s.toggleBtn} ${s.toggleActive}` : s.toggleBtn}
            onClick={() => setScope('hired')}
            aria-pressed={scope === 'hired'}
          >
            Đã tuyển {hiredCount}
          </button>
          <button
            className={scope === 'all' ? `${s.toggleBtn} ${s.toggleActive}` : s.toggleBtn}
            onClick={() => setScope('all')}
            aria-pressed={scope === 'all'}
          >
            Toàn bộ {agents.length}
          </button>
        </div>

        <div className={p.search}>
          <Icon name="search" size={14} color="#a8aec4" strokeWidth={2.2} />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Lọc theo tên hoặc mô tả…"
            aria-label="Lọc nhân sự"
          />
        </div>

        <div className={s.toggle} role="group" aria-label="Kiểu hiển thị">
          <button
            className={view === 'cards' ? `${s.toggleBtn} ${s.toggleActive}` : s.toggleBtn}
            onClick={() => setView('cards')}
            aria-pressed={view === 'cards'}
          >
            <Icon name="grid" size={14} strokeWidth={2} />
            Thẻ
          </button>
          <button
            className={view === 'tree' ? `${s.toggleBtn} ${s.toggleActive}` : s.toggleBtn}
            onClick={() => setView('tree')}
            aria-pressed={view === 'tree'}
          >
            <Icon name="filter" size={14} strokeWidth={2} />
            Cây
          </button>
        </div>

        <button className={p.button} onClick={toggleAll}>
          {expandAll ? 'Đóng tất cả' : 'Mở tất cả'}
        </button>
      </div>

      <div className={s.tree}>
        {visible.length === 0 && (
          <div className={p.empty}>
            {searching
              ? `Không có nhân sự nào khớp “${query.trim()}”${scope === 'hired' ? ' trong biên chế — thử “Toàn bộ”.' : '.'}`
              : 'Chưa tuyển nhân sự nào — xem company/roster.json.'}
          </div>
        )}

        {visible.map((div) => {
          const list = grouped.get(div.slug) ?? []
          // A search or an incoming deep link opens the group without touching local state.
          const isOpen = searching || open.has(div.slug) || forceOpen === div.slug

          return (
            <div key={div.slug} className={s.division}>
              <button
                className={s.divisionRow}
                onClick={() => toggle(div.slug)}
                aria-expanded={isOpen}
              >
                <Icon
                  name="chevronRight"
                  size={16}
                  strokeWidth={2.4}
                  className={isOpen ? `${s.chev} ${s.chevOpen}` : s.chev}
                />
                <div className={s.chip} style={{ background: tint(div.color, 0.13) }}>
                  {div.emoji}
                </div>
                <div className={s.divisionName}>{div.label}</div>
                <div className={s.count}>{list.length}</div>
              </button>

              {isOpen &&
                (view === 'cards' ? (
                  <div className={s.cardGrid}>
                    {list.map((a) => (
                      <AgentCard
                        key={a.slug}
                        agent={a}
                        division={div}
                        selected={a.slug === selectedSlug}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={s.agents}>
                    {list.map((a) => (
                      <AgentRow
                        key={a.slug}
                        agent={a}
                        selected={a.slug === selectedSlug}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ItemProps {
  agent: Agent
  selected: boolean
  onSelect: (slug: string) => void
}

/**
 * Not an "online" light — agents have no online state. It reports EFFECTIVE scoping:
 * green = allowlist declared and the runtime honours it, amber = declared but this
 * runtime drops it, grey = nothing declared.
 */
function scopeDot(agent: Agent): { cls: string; title: string } {
  if (agent.runtime.scopingConflict) {
    return {
      cls: s.dotConflict,
      title: `Khai ${agent.tools.length} tool nhưng ${agent.runtime.label} bỏ mất tools: — phân quyền không có hiệu lực`,
    }
  }
  if (agent.tools.length > 0) {
    return { cls: s.dotScoped, title: `Đã phân quyền ${agent.tools.length} tool` }
  }
  return { cls: s.dotOpen, title: 'Chưa phân quyền tool' }
}

function AgentCard({ agent, division, selected, onSelect }: ItemProps & { division: Division }) {
  const dot = scopeDot(agent)
  const { runtime } = agent
  const cls = [s.card, selected && s.cardActive, !agent.hired && s.cardMuted]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} onClick={() => onSelect(agent.slug)}>
      {NEW_ROLES.has(agent.slug) && <span className={s.cardBadge}>MỚI</span>}

      <div className={s.cardAvatar} style={{ background: tint(division.color, 0.13) }}>
        {agent.emoji || '👤'}
        <span className={`${s.dot} ${dot.cls}`} title={dot.title} />
      </div>

      <div className={s.cardBody}>
        <div className={s.cardName} title={agent.name}>
          {agent.name}
        </div>
        <div className={s.cardRole}>{division.label}</div>
        <div className={s.cardFoot}>
          <span className={s.cardLink}>Xem hồ sơ</span>
          <span
            className={runtime.assigned ? `${s.runtime} ${s.runtimeAssigned}` : s.runtime}
            title={
              `${runtime.label} · ${runtime.provider}` +
              (runtime.assigned ? ' · đã gán riêng' : ' · mặc định công ty')
            }
          >
            <span className={s.runtimeMark} style={{ background: runtime.accent }} />
            {runtime.short}
          </span>
        </div>
      </div>
    </button>
  )
}

function AgentRow({ agent, selected, onSelect }: ItemProps) {
  return (
    <button
      className={selected ? `${s.agentRow} ${s.agentRowActive}` : s.agentRow}
      onClick={() => onSelect(agent.slug)}
    >
      <div className={s.avatar}>{agent.emoji || '👤'}</div>
      <div className={s.agentMain}>
        <div className={s.agentName}>{agent.name}</div>
        <div className={s.agentDesc}>{agent.description}</div>
      </div>
      <AgentTag agent={agent} />
    </button>
  )
}

function AgentTag({ agent }: { agent: Agent }) {
  if (NEW_ROLES.has(agent.slug)) return <span className={`${s.tag} ${s.tagNew}`}>MỚI</span>
  if (agent.tools.length)
    return <span className={`${s.tag} ${s.tagScoped}`}>{agent.tools.length} tool</span>
  return <span className={`${s.tag} ${s.tagOpen}`}>chưa phân quyền</span>
}
