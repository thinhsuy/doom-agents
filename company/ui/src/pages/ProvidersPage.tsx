import { useEffect, useMemo, useState } from 'react'
import type { AgentRoster } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import s from './ProvidersPage.module.css'
import p from '../components/Panel.module.css'

interface ProviderInfo {
  id: string
  label: string
  configured: boolean
  models: { id: string; label: string }[]
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

  useEffect(() => {
    fetch(PROV_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return setOnline(false)
        setData(d as ProvidersData)
        setOnline(true)
      })
      .catch(() => setOnline(false))
  }, [])

  const byId = useMemo(() => new Map((data?.providers ?? []).map((x) => [x.id, x])), [data])

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
            Model cho từng agent <span className={p.hint}>· agent trả lời chat bằng provider/model này</span>
          </h2>
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Phòng ban</th>
                <th>Provider</th>
                <th>Model</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => {
                const prov = a.provider ?? data.default.provider
                const pi = byId.get(prov)
                const model =
                  a.model ?? (prov === data.default.provider ? data.default.model : pi?.models[0]?.id ?? '')
                const isCustom = Boolean(a.provider)
                const who = agentDisplay(a.slug)
                return (
                  <tr key={a.slug}>
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
