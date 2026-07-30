import { useCallback, useEffect, useState } from 'react'
import type { InfraCost, Monitor } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { BudgetControls } from '../components/BudgetControls'
import { Icon } from '../components/Icon'
import { Drawer, Section, drawerStyles as d } from '../components/Drawer'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import { useCopy } from '../lib/useCopy'
import { fmtInt, fmtTokens } from '../lib/format'
import { useCurrency } from '../lib/currency'
import s from './MonitorPage.module.css'
import p from '../components/Panel.module.css'

// Valid presets per config key (so Apply can't get a typo'd value terraform would reject).
// Keys mirror infra/variables.tf.
const CONFIG_OPTIONS: Record<string, { value: string; label: string }[]> = {
  task_cpu: [
    { value: '256', label: '256 · 0.25 vCPU' },
    { value: '512', label: '512 · 0.5 vCPU' },
    { value: '1024', label: '1024 · 1 vCPU' },
    { value: '2048', label: '2048 · 2 vCPU' },
  ],
  desired_count: [1, 2, 3].map((v) => ({ value: String(v), label: String(v) })),
  db_instance_class: ['db.t4g.micro', 'db.t4g.small', 'db.t4g.medium', 'db.t3.micro', 'db.t3.small'].map(
    (v) => ({ value: v, label: v }),
  ),
  db_allocated_storage: [20, 50, 100, 200].map((v) => ({ value: String(v), label: `${v} GB` })),
  postgres_version: ['16.4', '16.6', '17.2', '17.4', '17.5'].map((v) => ({ value: v, label: v })),
}
// Fargate requires valid CPU→memory pairs, so task_memory options depend on task_cpu.
const FARGATE_MEM: Record<string, number[]> = {
  '256': [512, 1024, 2048],
  '512': [1024, 2048, 3072, 4096],
  '1024': [2048, 3072, 4096, 6144, 8192],
  '2048': [4096, 6144, 8192, 12288, 16384],
}
function optionsFor(key: string, cfg: Record<string, string>): { value: string; label: string }[] | null {
  if (key === 'task_memory') {
    const mems = FARGATE_MEM[cfg.task_cpu ?? '256'] ?? FARGATE_MEM['256']
    return mems.map((m) => ({ value: String(m), label: `${m} MB` }))
  }
  return CONFIG_OPTIONS[key] ?? null
}

export function MonitorPage({ monitor }: { monitor: Monitor }) {
  const { money, unitSymbol } = useCurrency()
  const { totals, agents } = monitor
  // Infra LIVE from /api/infra so edits reflect without a rebuild; static monitor.json fallback.
  const [liveInfra, setLiveInfra] = useState<InfraCost[] | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const loadInfra = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/infra'))
      if (r.ok) {
        const dd = await r.json()
        if (Array.isArray(dd)) setLiveInfra(dd as InfraCost[])
      }
    } catch {
      /* offline — use the static snapshot */
    }
  }, [])
  useEffect(() => {
    loadInfra()
  }, [loadInfra])

  const infra = liveInfra ?? monitor.infra ?? []
  const infraTotal = infra.reduce((sum, i) => sum + i.monthlyUsd, 0)
  const selected = infra.find((i) => i.key === selKey) ?? null
  const maxCost = Math.max(1e-9, ...agents.map((a) => a.costUsd))

  const stats: Stat[] = [
    { label: 'Chi phí ước tính', value: money(totals.costUsd, 'usd'), color: '#F5A93F', icon: 'coins',
      foot: <>usage × giá token thật</> },
    { label: 'Lượt gọi model', value: fmtInt(totals.requests), color: '#4E5AE8', icon: 'activity',
      foot: <>throughput qua {totals.agents} agent</> },
    { label: 'Token vào / ra', value: `${fmtTokens(totals.inputTokens)} / ${fmtTokens(totals.outputTokens)}`,
      color: '#38BFC9', icon: 'server', foot: <>+{fmtTokens(totals.cacheReadTokens)} cache read</> },
    { label: 'Agent có hoạt động', value: totals.agents, color: '#21C286', icon: 'users',
      foot: <>đang ghi vào usage_events</> },
  ]

  return (
    <>
      <BudgetControls />

      {monitor.sample && (
        <div className={s.notice}>
          <Icon name="info" size={17} strokeWidth={2} />
          <div>
            <b>Chi phí thật, usage mẫu.</b> {monitor.note}
          </div>
        </div>
      )}

      <StatGrid stats={stats} />

      {/* Infra cost — estimated monthly spend of the AWS stack (infra/ Terraform) */}
      <div className={p.panel} style={{ marginBottom: 20 }}>
        <div className={p.head}>
          <h2 className={p.title}>
            Chi phí hạ tầng <span className={p.hint}>· ước tính {unitSymbol}/tháng · AWS ap-southeast-1 (stack tối thiểu)</span>
          </h2>
          <span className={s.infraTotal}>≈ {money(infraTotal, 'usd')}/tháng</span>
        </div>
        {infra.length === 0 ? (
          <div className={p.empty}>
            Chưa có dữ liệu giá hạ tầng. Chạy <code>npm run data</code> sau khi seed{' '}
            <code>company.infra_pricing</code>.
          </div>
        ) : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Dịch vụ</th>
                  <th>Cấu hình</th>
                  <th className={s.num}>{unitSymbol}/tháng</th>
                  <th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {infra.map((i) => (
                  <tr
                    key={i.key}
                    className={`${s.row} ${s.rowClickable}`}
                    onClick={() => setSelKey(i.key)}
                    title="Mở chi tiết & cấu hình"
                  >
                    <td style={{ fontWeight: 600 }}>
                      {i.service} <span className={s.chevron}>›</span>
                    </td>
                    <td className={s.sub}>{i.spec}</td>
                    <td className={`${s.num} ${s.cost}`}>{money(i.monthlyUsd, 'usd')}</td>
                    <td className={s.sub}>{i.note}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={s.tfoot}>
                  <td>Tổng</td>
                  <td />
                  <td className={s.num}>{money(infraTotal, 'usd')}</td>
                  <td className={s.sub}>ước tính · sửa trong company.infra_pricing</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Per-agent usage */}
      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>Throughput &amp; chi phí theo nhân sự</h2>
        </div>
        {agents.length === 0 ? (
          <div className={p.empty}>
            Chưa có usage nào. Bảng này đầy khi agent chạy thật và metering ghi vào{' '}
            <code>company.usage_events</code>.
          </div>
        ) : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Nhân sự</th>
                  <th className={s.num}>Lượt gọi</th>
                  <th className={s.num}>Token vào</th>
                  <th className={s.num}>Token ra</th>
                  <th className={s.num}>Chi phí</th>
                  <th>Tỷ trọng</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const who = agentDisplay(a.slug)
                  return (
                    <tr key={a.slug} className={s.row}>
                      <td>
                        <div className={s.who}>
                          <span className={s.avatar} style={{ background: `${who.color}22` }}>
                            {who.emoji}
                          </span>
                          <div>
                            <div style={{ fontWeight: 500 }}>{a.name}</div>
                            <div className={s.sub}>
                              {a.models.map((m) => (
                                <span key={m} className={s.modelChip}>
                                  {m.replace('claude-', '')}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={s.num}>{fmtInt(a.requests)}</td>
                      <td className={s.num}>{fmtTokens(a.inputTokens)}</td>
                      <td className={s.num}>{fmtTokens(a.outputTokens)}</td>
                      <td className={`${s.num} ${s.cost}`}>
                        {a.priceUnknown ? '—' : money(a.costUsd, 'usd')}
                      </td>
                      <td className={s.barCell}>
                        <div className={s.bar}>
                          <div
                            className={s.barFill}
                            style={{ width: `${Math.max(3, (a.costUsd / maxCost) * 100)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className={s.tfoot}>
                  <td>Tổng</td>
                  <td className={s.num}>{fmtInt(totals.requests)}</td>
                  <td className={s.num}>{fmtTokens(totals.inputTokens)}</td>
                  <td className={s.num}>{fmtTokens(totals.outputTokens)}</td>
                  <td className={s.num}>{money(totals.costUsd, 'usd')}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <Drawer
        open={Boolean(selected)}
        title={selected ? selected.service : ''}
        subtitle={selected?.spec ?? undefined}
        onClose={() => setSelKey(null)}
      >
        {selected && <InfraDetail item={selected} totals={totals} onSaved={loadInfra} />}
      </Drawer>
    </>
  )
}

/** Right-side drawer: a component's config (editable), cost, usage, plus Save + a Deploy
    action that hands back the exact `terraform apply` command (the console never runs
    terraform — infra apply is privileged and there are no AWS creds in the app). */
function InfraDetail({
  item,
  totals,
  onSaved,
}: {
  item: InfraCost
  totals: Monitor['totals']
  onSaved: () => void
}) {
  const { toUsd, toCurrentUnit, unitSymbol } = useCurrency()
  const original = item.config ?? {}
  const [cfg, setCfg] = useState<Record<string, string>>(
    () => Object.fromEntries(Object.entries(original).map(([k, v]) => [k, String(v)])),
  )
  const [spec, setSpec] = useState(item.spec ?? '')
  // Cost is stored USD (AWS bills USD); the drawer edits it in the current display unit
  // (× live rate), converted back to USD on save.
  const [monthly, setMonthly] = useState(String(Math.round(toCurrentUnit(item.monthlyUsd))))
  const [note, setNote] = useState(item.note ?? '')
  const [busy, setBusy] = useState<null | 'save' | 'deploy'>(null)
  const [msg, setMsg] = useState('')
  const [cmd, setCmd] = useState<string | null>(null)
  const [copyState, copy] = useCopy()

  // Preserve each config value's original type (number stays number) when saving.
  const buildConfig = () =>
    Object.fromEntries(
      Object.entries(cfg).map(([k, v]) => [k, typeof original[k] === 'number' ? Number(v) : v]),
    )

  async function persist(): Promise<boolean> {
    const r = await fetch(apiUrl(`/api/infra/${item.key}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec, note, monthlyUsd: toUsd(Number(monthly) || 0), config: buildConfig() }),
    })
    return r.ok
  }

  async function save() {
    setBusy('save')
    setMsg('')
    try {
      if (await persist()) {
        setMsg('Đã lưu cấu hình.')
        onSaved()
      } else setMsg('Không lưu được.')
    } catch {
      setMsg('Cần backend chạy.')
    } finally {
      setBusy(null)
    }
  }

  // Deploy = persist the edits, then hand back the terraform command that applies them.
  async function deploy() {
    setBusy('deploy')
    setMsg('')
    try {
      if (!(await persist())) {
        setMsg('Không lưu được cấu hình.')
        return
      }
      onSaved()
      const r = await fetch(apiUrl(`/api/infra/${item.key}/deploy`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const dd = await r.json().catch(() => null)
      if (r.ok && dd?.ok) setCmd(dd.command as string)
      else setMsg('Không tạo được lệnh apply.')
    } catch {
      setMsg('Cần backend chạy.')
    } finally {
      setBusy(null)
    }
  }

  const cfgKeys = Object.keys(cfg)

  // Set a config key; changing task_cpu snaps task_memory to a valid Fargate pairing.
  const setCfgKey = (k: string, v: string) =>
    setCfg((prev) => {
      const next = { ...prev, [k]: v }
      if (k === 'task_cpu') {
        const memOpts = (FARGATE_MEM[v] ?? []).map(String)
        if (memOpts.length && !memOpts.includes(next.task_memory)) next.task_memory = memOpts[0]
      }
      return next
    })

  return (
    <>
      <Section label="Cấu hình">
        {cfgKeys.length === 0 ? (
          <div className={d.text}>Thành phần này không có tham số điều chỉnh trong Terraform tối thiểu.</div>
        ) : (
          cfgKeys.map((k) => {
            const opts = optionsFor(k, cfg)
            return (
              <label key={k} className={s.field}>
                <span className={s.fieldLabel}>{k}</span>
                {opts ? (
                  <select className={s.fieldInput} value={cfg[k]} onChange={(e) => setCfgKey(k, e.target.value)}>
                    {/* keep a current value that isn't in the preset list selectable */}
                    {!opts.some((o) => o.value === cfg[k]) && <option value={cfg[k]}>{cfg[k]} (hiện tại)</option>}
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={s.fieldInput}
                    value={cfg[k]}
                    onChange={(e) => setCfgKey(k, e.target.value)}
                  />
                )}
              </label>
            )
          })
        )}
        <label className={s.field}>
          <span className={s.fieldLabel}>spec (mô tả cấu hình)</span>
          <input className={s.fieldInput} value={spec} onChange={(e) => setSpec(e.target.value)} />
        </label>
      </Section>

      <Section label="Chi phí">
        <label className={s.field}>
          <span className={s.fieldLabel}>Ước tính {unitSymbol}/tháng</span>
          <input
            className={s.fieldInput}
            type="number"
            min={0}
            step="0.01"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </label>
        <label className={s.field}>
          <span className={s.fieldLabel}>Ghi chú</span>
          <input className={s.fieldInput} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </Section>

      <Section label="Usage / throughput">
        {item.key === 'ecs_fargate' ? (
          <div className={d.text}>
            Ứng dụng chạy trên container này: <b>{fmtInt(totals.requests)}</b> lượt gọi ·{' '}
            {fmtTokens(totals.inputTokens)}/{fmtTokens(totals.outputTokens)} token (từ metering LLM).
          </div>
        ) : (
          <div className={d.text}>
            Số liệu usage thời gian thực (CPU / RAM / kết nối / request) cần tích hợp{' '}
            <b>AWS CloudWatch</b> — chưa nối. Hiện chỉ có chi phí ước tính ở trên.
          </div>
        )}
        {item.lastDeployAt && <div className={s.sub}>Lần apply gần nhất: {item.lastDeployAt}</div>}
      </Section>

      <div className={s.infraActions}>
        <button className={s.saveBtn} onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Đang lưu…' : 'Lưu cấu hình'}
        </button>
        <button className={s.deployBtn} onClick={deploy} disabled={busy !== null}>
          {busy === 'deploy' ? 'Đang tạo lệnh…' : '🚀 Apply'}
        </button>
      </div>
      {msg && <div className={s.sub} style={{ padding: '0 2px' }}>{msg}</div>}

      {cmd && (
        <div className={s.cmdBox}>
          <div className={s.cmdHead}>
            Lệnh apply (chạy trong <code>infra/</code>)
            <button className={s.copyBtn} onClick={() => copy(cmd)}>
              {copyState === 'ok' ? '✓ đã copy' : 'Copy'}
            </button>
          </div>
          <pre className={s.cmdPre}>{cmd}</pre>
          <div className={s.cmdNote}>
            Console <b>không tự chạy terraform</b> (thao tác hạ tầng đặc quyền, app không giữ AWS
            credentials). Copy lệnh này và chạy để áp dụng thay đổi.
          </div>
        </div>
      )}
    </>
  )
}
