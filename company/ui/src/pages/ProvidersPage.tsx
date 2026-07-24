import { useEffect, useMemo, useState } from 'react'
import type { AgentRoster } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
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
}
interface ProvidersData {
  providers: ProviderInfo[]
  default: { provider: string; model: string }
  agents: AgentCfg[]
}

const PROV_URL = apiUrl('/api/providers')

// roster kept for the prop signature; live data comes from the backend.
export function ProvidersPage(_props: { roster: AgentRoster }) {
  const [data, setData] = useState<ProvidersData | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkProvider, setBulkProvider] = useState('')
  const [bulkModel, setBulkModel] = useState('')
  const [applying, setApplying] = useState(false)

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

  // Agents sorted A→Z by name; then filtered by the search box (name/division/slug).
  const sorted = useMemo(
    () => [...(data?.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'vi')),
    [data],
  )
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (a) => a.name.toLowerCase().includes(q) || a.division.toLowerCase().includes(q) || a.slug.includes(q),
    )
  }, [sorted, query])
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

      <div className={s.providerCards}>
        {data.providers.map((pr) => (
          <div key={pr.id} className={s.providerCard}>
            <div className={s.providerTop}>
              <span className={s.providerName}>{pr.label}</span>
              <span className={pr.configured ? s.ok : s.missing}>
                {pr.configured ? '● đã cấu hình' : '○ thiếu key'}
              </span>
            </div>
            <div className={s.providerModels}>
              {pr.models.map((m) => (
                <span key={m.id} className={s.modelChip}>{m.label}</span>
              ))}
            </div>
            {!pr.configured && (
              <div className={s.providerHint}>
                {pr.id === 'gpt'
                  ? 'Đặt OPENAI_API_KEY trong company/.env.local'
                  : 'Đặt AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION'}
              </div>
            )}
          </div>
        ))}
      </div>

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
          <select
            className={s.bulkDiv}
            value=""
            onChange={(e) => {
              const div = e.target.value
              if (!div) return
              setSelected((prev) => {
                const n = new Set(prev)
                sorted.filter((a) => a.division === div).forEach((a) => n.add(a.slug))
                return n
              })
            }}
          >
            <option value="">+ Chọn theo phòng ban…</option>
            {divisions.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
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
                          <span className={s.priceIn}>${mi.inUsd}</span>
                          <span className={s.priceSep}>/</span>
                          <span className={s.priceOut}>${mi.outUsd}</span>
                        </span>
                      ) : (
                        <span className={s.priceNa}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
