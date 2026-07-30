import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRoster } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { CurrencyControls } from '../components/CurrencyControls'
import { useCurrency } from '../lib/currency'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import s from './ProvidersPage.module.css'
import p from '../components/Panel.module.css'

interface ModelInfo {
  id: string
  label: string
  inUsd?: number | null
  outUsd?: number | null
}
interface ProviderInfo {
  id: string
  label: string
  configured: boolean
  models: ModelInfo[]
}
interface AgentCfg {
  slug: string
  name: string
  division: string
  provider: string | null
  model: string | null
  permissions: string[] // effective permission keys (base ∪ lead ∪ granted)
  basePermissions: string[]
  grantedTools: string[] // direct per-tool grants (agent_tool_grants)
}
interface PermCatalogEntry {
  key: string
  label: string
  description: string | null
  tools: string[]
  highRisk: boolean
  builtin: boolean
}
interface ToolInfo {
  name: string
  description: string
  access: string // lead | restricted | custom
}
interface ProvidersData {
  providers: ProviderInfo[]
  default: { provider: string; model: string }
  agents: AgentCfg[]
  permissionCatalog: PermCatalogEntry[]
  baseKeys: string[]
  toolCatalog: ToolInfo[]
}

const PROV_URL = apiUrl('/api/providers')

// roster kept for the prop signature; live data comes from the backend.
export function ProvidersPage(_props: { roster: AgentRoster }) {
  const { money } = useCurrency()
  const [data, setData] = useState<ProvidersData | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkProvider, setBulkProvider] = useState('')
  const [bulkModel, setBulkModel] = useState('')
  const [applying, setApplying] = useState(false)
  const [editPerms, setEditPerms] = useState<AgentCfg | null>(null)
  const [divFilter, setDivFilter] = useState<Set<string>>(new Set())

  const load = () =>
    fetch(PROV_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return setOnline(false)
        setData(d as ProvidersData)
        setOnline(true)
      })
      .catch(() => setOnline(false))
  useEffect(() => {
    fetch(PROV_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return setOnline(false)
        setData(d as ProvidersData)
        setOnline(true)
        setBulkProvider(d.default.provider)
        setBulkModel(d.default.model)
      })
      .catch(() => setOnline(false))
  }, [])

  const byId = useMemo(() => new Map((data?.providers ?? []).map((x) => [x.id, x])), [data])
  const catMap = useMemo(
    () => new Map((data?.permissionCatalog ?? []).map((c) => [c.key, c])),
    [data],
  )
  const baseKeys = useMemo(() => new Set(data?.baseKeys ?? []), [data])

  // Agents sorted A→Z by name; then filtered by the search box (name/division/slug).
  const sorted = useMemo(
    () => [...(data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    [data],
  )
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sorted
    if (divFilter.size) list = list.filter((a) => divFilter.has(a.division))
    if (q)
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || a.division.toLowerCase().includes(q) || a.slug.includes(q),
      )
    return list
  }, [sorted, query, divFilter])
  const divisions = useMemo(
    () => [...new Set((data?.agents ?? []).map((a) => a.division))].sort(),
    [data],
  )

  async function save(slug: string, provider: string, model: string) {
    setData((d) =>
      d ? { ...d, agents: d.agents.map((a) => (a.slug === slug ? { ...a, provider, model } : a)) } : d,
    )
    try {
      await fetch(apiUrl('/api/agent-runtime'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, provider, model }),
      })
    } catch {
      /* backend offline — optimistic value reconciles on reload */
    }
  }

  async function applyBulk() {
    const slugs = [...selected]
    if (slugs.length === 0 || !bulkProvider || !bulkModel || applying) return
    setApplying(true)
    // optimistic
    setData((d) =>
      d
        ? { ...d, agents: d.agents.map((a) => (selected.has(a.slug) ? { ...a, provider: bulkProvider, model: bulkModel } : a)) }
        : d,
    )
    try {
      await fetch(apiUrl('/api/agent-runtime/bulk'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slugs, provider: bulkProvider, model: bulkModel }),
      })
      setSelected(new Set())
    } catch {
      /* offline — optimistic reconciles on reload */
    } finally {
      setApplying(false)
    }
  }

  // Owner grants/revokes an agent's permission bundles + individual tools (base perms stay
  // implicit). Optimistic: effective perms = base ∪ keys; grantedTools = the chosen tools.
  async function savePerms(slug: string, keys: string[], tools: string[]) {
    setData((d) =>
      d
        ? {
            ...d,
            agents: d.agents.map((a) =>
              a.slug === slug
                ? { ...a, permissions: Array.from(new Set([...a.basePermissions, ...keys])), grantedTools: tools }
                : a,
            ),
          }
        : d,
    )
    try {
      await fetch(apiUrl(`/api/agents/${slug}/permissions`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: keys, tools }),
      })
    } catch {
      /* offline — optimistic value reconciles on reload */
    }
  }

  const toggle = (slug: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(slug) ? n.delete(slug) : n.add(slug)
      return n
    })
  const allShownSelected = shown.length > 0 && shown.every((a) => selected.has(a.slug))

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để cấu hình provider:{' '}
          <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Trang này
          đọc/ghi <code>/api/providers</code> + <code>/api/agent-runtime</code>.
        </div>
      </div>
    )
  }
  if (!data) return <div className={p.panel}><div className={p.empty}>Đang tải…</div></div>

  const custom = data.agents.filter((a) => a.provider)
  const stats: Stat[] = [
    { label: 'Provider đã cấu hình', value: data.providers.filter((x) => x.configured).length,
      color: '#21C286', icon: 'shield', foot: <>trên {data.providers.length} (GPT · Claude)</> },
    { label: 'Mặc định công ty', value: `${data.default.provider}/${data.default.model}`,
      color: '#4E5AE8', icon: 'server', foot: <>agent chưa chỉnh dùng cái này</> },
    { label: 'Agent chỉnh riêng', value: custom.length, color: custom.length ? '#F5A93F' : '#8A90A8',
      icon: 'activity', foot: <>đã gán provider/model riêng</> },
  ]

  return (
    <>
      <StatGrid stats={stats} />

      <CurrencyControls onProvidersChanged={load} />

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Model cho từng agent <span className={p.hint}>· {shown.length}/{data.agents.length} agent</span>
          </h2>
          <input
            className={s.search}
            placeholder="🔎 Tìm agent theo tên / phòng ban…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Bulk apply: chọn tất cả (đang lọc) / theo phòng ban / từng dòng → áp 1 provider+model */}
        <div className={s.bulkBar}>
          <label className={s.bulkChk}>
            <input
              type="checkbox"
              checked={allShownSelected}
              onChange={(e) =>
                setSelected((prev) => {
                  const n = new Set(prev)
                  shown.forEach((a) => (e.target.checked ? n.add(a.slug) : n.delete(a.slug)))
                  return n
                })
              }
            />
            Chọn tất cả ({shown.length})
          </label>
          <DivFilter divisions={divisions} selected={divFilter} onChange={setDivFilter} />
          {selected.size > 0 && (
            <button className={s.clearSel} onClick={() => setSelected(new Set())}>
              Bỏ chọn ({selected.size})
            </button>
          )}

          <div className={s.bulkApply}>
            <span className={s.bulkLabel}>Đặt cho {selected.size} agent:</span>
            <select
              className={s.select}
              value={bulkProvider}
              onChange={(e) => {
                const np = e.target.value
                setBulkProvider(np)
                setBulkModel(byId.get(np)?.models[0]?.id ?? '')
              }}
            >
              {data.providers.map((pr) => (
                <option key={pr.id} value={pr.id}>{pr.label}{pr.configured ? '' : ' (thiếu key)'}</option>
              ))}
            </select>
            <select className={s.select} value={bulkModel} onChange={(e) => setBulkModel(e.target.value)}>
              {(byId.get(bulkProvider)?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button
              className={s.applyBtn}
              onClick={applyBulk}
              disabled={selected.size === 0 || applying}
            >
              {applying ? 'Đang áp…' : 'Áp dụng'}
            </button>
          </div>
        </div>

        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.chkCol}></th>
                <th>Agent</th>
                <th>Phòng ban</th>
                <th>Provider</th>
                <th>Model</th>
                <th className={s.priceCol}>Giá /1M (in&nbsp;/&nbsp;out)</th>
                <th className={s.accessCol}>Access Tools</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => {
                const prov = a.provider ?? data.default.provider
                const pi = byId.get(prov)
                const model =
                  a.model ?? (prov === data.default.provider ? data.default.model : pi?.models[0]?.id ?? '')
                const mi = pi?.models.find((m) => m.id === model)
                const isCustom = Boolean(a.provider)
                const who = agentDisplay(a.slug)
                return (
                  <tr key={a.slug} className={selected.has(a.slug) ? s.rowSel : undefined}>
                    <td className={s.chkCol}>
                      <input type="checkbox" checked={selected.has(a.slug)} onChange={() => toggle(a.slug)} />
                    </td>
                    <td>
                      <div className={s.who}>
                        <span className={s.avatar} style={{ background: `${who.color}22` }}>{who.emoji}</span>
                        <span style={{ fontWeight: 500 }}>{a.name}</span>
                      </div>
                    </td>
                    <td className={s.div}>{a.division}</td>
                    <td>
                      <select
                        className={isCustom ? `${s.select} ${s.changed}` : s.select}
                        value={prov}
                        onChange={(e) => {
                          const np = e.target.value
                          const npi = byId.get(np)
                          const nm = np === data.default.provider ? data.default.model : npi?.models[0]?.id ?? ''
                          save(a.slug, np, nm)
                        }}
                      >
                        {data.providers.map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.label}
                            {pr.configured ? '' : ' (thiếu key)'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className={s.modelCell}>
                        <select
                          className={isCustom ? `${s.select} ${s.changed}` : s.select}
                          value={model}
                          onChange={(e) => save(a.slug, prov, e.target.value)}
                        >
                          {(pi?.models ?? []).map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                        {!isCustom && <span className={s.defaultTag}>mặc định</span>}
                      </div>
                    </td>
                    <td className={s.priceCol}>
                      {mi && mi.inUsd != null ? (
                        <span className={s.price}>
                          <span className={s.priceIn}>{money(mi.inUsd, 'usd')}</span>
                          <span className={s.priceSep}>/</span>
                          <span className={s.priceOut}>{money(mi.outUsd ?? 0, 'usd')}</span>
                        </span>
                      ) : (
                        <span className={s.priceNa}>—</span>
                      )}
                    </td>
                    <td
                      className={`${s.accessCol} ${s.accessEditable}`}
                      onClick={() => setEditPerms(a)}
                      title="Bấm để cấp / thu quyền"
                    >
                      <AccessCell agent={a} catMap={catMap} baseKeys={baseKeys} />
                      <span className={s.accessEdit}>✏️ sửa quyền</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editPerms && (
        <AgentPermsEditor
          agent={editPerms}
          catalog={data.permissionCatalog}
          toolCatalog={data.toolCatalog}
          onClose={() => setEditPerms(null)}
          onSave={(keys, tools) => {
            savePerms(editPerms.slug, keys, tools)
            setEditPerms(null)
          }}
        />
      )}
    </>
  )
}

/** Multi-select department FILTER (filters the table; does not tick checkboxes). Pick one or
    more phòng ban; the table shows only those agents. Combine with the search box. */
function DivFilter({
  divisions,
  selected,
  onChange,
}: {
  divisions: string[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const toggle = (d: string) => {
    const n = new Set(selected)
    n.has(d) ? n.delete(d) : n.add(d)
    onChange(n)
  }
  return (
    <div className={s.divFilter} ref={ref}>
      <button
        className={selected.size ? `${s.divFilterBtn} ${s.divFilterOn}` : s.divFilterBtn}
        onClick={() => setOpen((o) => !o)}
      >
        🏷 {selected.size ? `Lọc: ${selected.size} phòng ban` : 'Lọc theo phòng ban'} <span className={s.caret}>▾</span>
      </button>
      {open && (
        <div className={s.divFilterPop}>
          {divisions.map((d) => (
            <label key={d} className={s.divFilterRow}>
              <input type="checkbox" checked={selected.has(d)} onChange={() => toggle(d)} />
              {d}
            </label>
          ))}
          {selected.size > 0 && (
            <button className={s.divFilterClear} onClick={() => onChange(new Set())}>
              Bỏ lọc ({selected.size})
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Owner grants/revokes a staff agent's permissions. Base perms (every agent has them) are
    hidden; the rest of the catalog is checkboxes — checked = explicitly granted. */
function AgentPermsEditor({
  agent,
  catalog,
  toolCatalog,
  onClose,
  onSave,
}: {
  agent: AgentCfg
  catalog: PermCatalogEntry[]
  toolCatalog: ToolInfo[]
  onClose: () => void
  onSave: (keys: string[], tools: string[]) => void
}) {
  const baseSet = useMemo(() => new Set(agent.basePermissions), [agent])
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(agent.permissions.filter((k) => !baseSet.has(k))),
  )
  const [checkedTools, setCheckedTools] = useState<Set<string>>(() => new Set(agent.grantedTools))
  // Tools already unlocked by a checked OR auto (base/lead) permission bundle — so the detail
  // section doesn't ask to grant them again.
  const coveredByPerm = useMemo(() => {
    const set = new Set<string>()
    for (const c of catalog) if (checked.has(c.key) || baseSet.has(c.key)) (c.tools || []).forEach((t) => set.add(t))
    return set
  }, [catalog, checked, baseSet])
  const toggle = (k: string) =>
    setChecked((prev) => {
      const n = new Set(prev)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })
  const toggleTool = (t: string) =>
    setCheckedTools((prev) => {
      const n = new Set(prev)
      n.has(t) ? n.delete(t) : n.add(t)
      return n
    })
  const who = agentDisplay(agent.slug)
  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.avatar} style={{ background: `${who.color}22` }}>{who.emoji}</span>
          <span className={s.modalTitle}>Quyền của {agent.name}</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={s.modalHint}>
          Tick để <b>cấp</b> / bỏ tick để <b>thu</b>. Nhóm <b>cơ bản/lead</b> (mọi agent — hoặc lead — tự động có)
          hiện <b>mờ &amp; luôn bật</b>, không thu được; tick các nhóm còn lại để cấp/thu.
        </div>
        <div className={s.permList}>
          <div className={s.permSection}>Nhóm quyền (mở khoá nhiều tool)</div>
          {catalog.map((c) => {
            const isAuto = baseSet.has(c.key) // base (mọi agent) or lead — always on for this agent
            return (
              <label key={c.key} className={s.permRow}>
                <input
                  type="checkbox"
                  checked={isAuto || checked.has(c.key)}
                  disabled={isAuto}
                  onChange={() => toggle(c.key)}
                />
                <div className={s.permInfo}>
                  <div className={s.permTop}>
                    <span className={s.permLabel}>{c.label}</span>
                    {c.highRisk && <span className={s.riskTag}>rủi ro cao</span>}
                    {isAuto && <span className={s.permKey}>tự động · luôn bật</span>}
                    <span className={s.permKey}>{c.key}</span>
                  </div>
                  {c.description && <div className={s.permDesc}>{c.description}</div>}
                  {c.tools.length > 0 && <div className={s.permTools}>tool: {c.tools.join(', ')}</div>}
                </div>
              </label>
            )
          })}

          <div className={s.permSection}>Cấp từng tool riêng lẻ (chi tiết)</div>
          {toolCatalog.map((t) => {
            const viaPerm = coveredByPerm.has(t.name)
            return (
              <label key={t.name} className={s.permRow}>
                <input
                  type="checkbox"
                  checked={viaPerm || checkedTools.has(t.name)}
                  disabled={viaPerm}
                  onChange={() => toggleTool(t.name)}
                />
                <div className={s.permInfo}>
                  <div className={s.permTop}>
                    <span className={`${s.permLabel} ${s.mono}`}>{t.name}</span>
                    {t.access === 'restricted' && <span className={s.riskTag}>hạn chế</span>}
                    {t.access === 'custom' && <span className={s.permKey}>tuỳ chỉnh</span>}
                    {viaPerm && <span className={s.permKey}>đã có qua nhóm quyền</span>}
                  </div>
                  {t.description && <div className={s.permDesc}>{t.description}</div>}
                </div>
              </label>
            )
          })}
        </div>
        <div className={s.modalFoot}>
          <button className={s.cancel} onClick={onClose}>Huỷ</button>
          <button className={s.saveBtn} onClick={() => onSave([...checked], [...checkedTools])}>Lưu quyền</button>
        </div>
      </div>
    </div>
  )
}

/** The Access Tools cell: distinguishing perms (lead/granted) as chips + one muted chip
    for the universal base perms. Labels/tools come from the catalog — nothing re-listed. */
function AccessCell({
  agent,
  catMap,
  baseKeys,
}: {
  agent: AgentCfg
  catMap: Map<string, PermCatalogEntry>
  baseKeys: Set<string>
}) {
  const special = agent.permissions.filter((k) => !baseKeys.has(k))
  const base = agent.permissions.filter((k) => baseKeys.has(k))
  const baseTip = base.map((k) => catMap.get(k)?.label ?? k).join(' · ')
  return (
    <div className={s.access}>
      {special.map((k) => {
        const c = catMap.get(k)
        const tip = c?.tools.length ? `Tools: ${c.tools.join(', ')}` : 'Quyền ghi nhận (thực thi qua orchestrator)'
        return (
          <span
            key={k}
            className={c?.highRisk ? `${s.permChip} ${s.permHigh}` : s.permChip}
            title={`${c?.label ?? k}${c?.description ? ' — ' + c.description : ''}\n${tip}`}
          >
            {c?.label ?? k}
          </span>
        )
      })}
      {base.length > 0 && (
        <span className={`${s.permChip} ${s.permBase}`} title={`Mọi agent đều có: ${baseTip}`}>
          cơ bản · {base.length}
        </span>
      )}
    </div>
  )
}
