import { useCallback, useEffect, useState } from 'react'
import { StatGrid, type Stat } from '../components/StatCard'
import { apiUrl } from '../lib/api'
import { useCurrency } from '../lib/currency'
import type { Goal, GoalOwnerOption, GoalStatus, GoalsData } from '../types'
import s from './GoalsPage.module.css'
import p from '../components/Panel.module.css'

const URL = apiUrl('/api/goals')

const STATUS: Record<GoalStatus, { cls: string; label: string; fill: string }> = {
  todo: { cls: s.pillTodo, label: 'Chưa bắt đầu', fill: '#c3c8d8' },
  in_progress: { cls: s.pillInProgress, label: 'Đang làm', fill: '#1b8f99' },
  done: { cls: s.pillDone, label: 'Hoàn thành', fill: '#21c286' },
  at_risk: { cls: s.pillAtRisk, label: 'Có rủi ro', fill: '#d93463' },
}
const STATUS_ORDER: GoalStatus[] = ['todo', 'in_progress', 'at_risk', 'done']

export function GoalsPage() {
  const { money, rate } = useCurrency()
  const [data, setData] = useState<GoalsData | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  // null = closed; 'new' = create; a Goal = edit that goal.
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(URL)
      if (!r.ok) return setOnline(false)
      setData((await r.json()) as GoalsData)
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 10000)
    return () => clearInterval(id)
  }, [load])

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để xem &amp; sửa Mục tiêu:{' '}
          <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Trang này đọc/ghi{' '}
          <code>/api/goals</code>.
        </div>
      </div>
    )
  }
  if (!data) return <div className={p.panel}><div className={p.empty}>Đang tải…</div></div>

  const f = data.finance
  // Revenue = REAL realized gains from the owners' declared investments (Σ (sell−buy)×qty)
  // + goal virtual revenue — both VND-native; cost is USD-native (LLM+infra). Compute the P&L
  // in USD so net + margin share one base, then render each value in the chosen unit.
  const investmentVnd = f.investmentRevenue || 0
  const goalVnd = f.revenueEarned || 0
  const revenueRealizedVnd = investmentVnd + goalVnd
  const revenueUsd = revenueRealizedVnd / rate
  const netUsd = revenueUsd - f.costMonthlyUsd
  const margin = revenueUsd > 0 ? Math.round((netUsd / revenueUsd) * 1000) / 10 : null
  const netColor = netUsd >= 0 ? '#21C286' : '#d93463'

  const stats: Stat[] = [
    {
      label: 'Doanh thu đã thu',
      value: money(revenueRealizedVnd, 'vnd'),
      color: '#21C286',
      icon: 'trendingUp',
      foot: (
        <>
          đầu tư (thật) {money(investmentVnd, 'vnd')} · mục tiêu (ảo) {money(goalVnd, 'vnd')}
        </>
      ),
    },
    {
      label: 'Doanh thu dự kiến',
      value: money(f.revenuePipeline, 'vnd'),
      color: '#4E5AE8',
      icon: 'coins',
      foot: <>còn trong pipeline</>,
    },
    {
      label: 'Chi phí thực tế / tháng',
      value: money(f.costMonthlyUsd, 'usd'),
      color: '#F5A93F',
      icon: 'activity',
      foot: (
        <>
          LLM tháng này {money(f.llmCostUsd ?? 0, 'usd')} + hạ tầng {money(f.infraMonthlyUsd ?? 0, 'usd')} · ước tính/tháng
        </>
      ),
    },
    {
      label: netUsd >= 0 ? 'Lãi ròng' : 'Lỗ ròng',
      value: money(netUsd, 'usd'),
      color: netColor,
      icon: 'target',
      foot: margin != null ? <>biên {margin}% · doanh thu (thật+ảo) − chi phí/tháng</> : <>chưa có doanh thu</>,
    },
  ]

  return (
    <>
      <StatGrid stats={stats} />

      <div className={s.note}>
        <b>Doanh thu đã thu = đầu tư (THẬT) + mục tiêu (ảo)</b>: phần <b>thật</b> là lãi/lỗ thực hiện từ các khoản
        đầu tư CEO/CTO/COO tự khai báo (tab Investment: Σ (giá bán − giá mua) × số lượng); phần <b>ảo</b> là doanh thu
        mô phỏng gán cho mục tiêu đã hoàn thành. <b>Chi phí thực tế / tháng = token LLM tháng này</b>{' '}
        (<code>company.usage_costed</code>) <b>+ hạ tầng</b> (<code>company.infra_pricing</code>, ước tính/tháng).
        Lãi/Lỗ = doanh thu − chi phí/tháng → biết công ty đang lời hay lỗ.
      </div>

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Mục tiêu của các agent <span className={p.hint}>· {data.goals.length}</span>
          </h2>
          <button className={s.addBtn} onClick={() => setEditing('new')}>
            ＋ Thêm mục tiêu
          </button>
        </div>
        {data.goals.length === 0 ? (
          <div className={p.empty}>Chưa có mục tiêu nào. Bấm “＋ Thêm mục tiêu” để tạo.</div>
        ) : (
          <div className={s.cards}>
            {data.goals.map((g) => (
              <GoalCard key={g.id} g={g} onEdit={() => setEditing(g)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing}
          agents={data.agents}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </>
  )
}

function GoalCard({ g, onEdit }: { g: Goal; onEdit: () => void }) {
  const { money } = useCurrency()
  const st = STATUS[g.status]
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.gid}>{g.id}</span>
        <span className={`${s.pill} ${st.cls}`}>{st.label}</span>
      </div>

      <div className={s.title}>{g.title}</div>
      {g.description && <div className={s.desc}>{g.description}</div>}

      <div className={s.owner}>
        <span className={s.ownerAvatar}>{g.ownerEmoji ?? '🧑‍💼'}</span>
        <span>
          <span className={s.ownerName}>{g.ownerName || '— chưa gán —'}</span>
          {g.ownerDivision && <> · <span className={s.ownerDiv}>{g.ownerDivision}</span></>}
        </span>
      </div>

      <div className={s.createdBy}>Người tạo: {g.createdBy || 'hệ thống'}</div>

      <div className={s.progWrap}>
        <div className={s.progHead}>
          <span>Tiến độ</span>
          <span className={s.progVal}>{g.progress}%</span>
        </div>
        <div className={s.progTrack}>
          <div className={s.progFill} style={{ width: `${g.progress}%`, background: st.fill }} />
        </div>
      </div>

      <div className={s.foot}>
        <div>
          <div className={s.revLabel}>Doanh thu</div>
          <div className={s.revVal}>{money(g.revenueUsd, 'vnd')}</div>
        </div>
        {g.targetDate && (
          <div className={s.due}>
            hạn chót
            <br />
            <span className={s.dueVal}>{g.targetDate}</span>
          </div>
        )}
      </div>

      <button className={s.editBtn} onClick={onEdit}>
        ✏️ Sửa
      </button>
    </div>
  )
}

function GoalEditor({
  goal,
  agents,
  onClose,
  onSaved,
}: {
  goal: Goal | null
  agents: GoalOwnerOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(goal?.title ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')
  const [owner, setOwner] = useState(goal?.owner ?? '')
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? 'todo')
  const [progress, setProgress] = useState(goal?.progress ?? 0)
  const [revenue, setRevenue] = useState(String(goal?.revenueUsd ?? 0))
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null)
  const [err, setErr] = useState('')

  async function save() {
    if (!title.trim() || busy) return
    setBusy('save')
    setErr('')
    const body = {
      title: title.trim(),
      description: description.trim(),
      owner,
      status,
      progress,
      revenueUsd: Number(revenue) || 0,
      targetDate: targetDate.trim(),
    }
    const url = goal ? apiUrl(`/api/goals/${goal.id}`) : apiUrl('/api/goals')
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) onSaved()
      else setErr(String(d?.detail || 'Không lưu được'))
    } catch {
      setErr('Cần backend chạy')
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!goal || busy) return
    if (!window.confirm(`Xoá mục tiêu ${goal.id}?`)) return
    setBusy('delete')
    try {
      const r = await fetch(apiUrl(`/api/goals/${goal.id}`), { method: 'DELETE' })
      if (r.ok) onSaved()
      else setErr('Không xoá được')
    } catch {
      setErr('Cần backend chạy')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.modalTitle}>{goal ? `Sửa mục tiêu ${goal.id}` : 'Thêm mục tiêu'}</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">
            ✕
          </button>
        </div>

        <div className={s.modalBody}>
          <label className={s.field}>
            <span className={s.flabel}>Tiêu đề</span>
            <input className={s.input} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          <label className={s.field}>
            <span className={s.flabel}>Mô tả</span>
            <textarea className={s.textarea} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </label>

          <label className={s.field}>
            <span className={s.flabel}>Chủ sở hữu (agent)</span>
            <select className={s.input} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">— chưa gán —</option>
              {agents.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.emoji ? `${a.emoji} ` : ''}{a.name}{a.division ? ` · ${a.division}` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.flabel}>Trạng thái</span>
              <select className={s.input} value={status} onChange={(e) => setStatus(e.target.value as GoalStatus)}>
                {STATUS_ORDER.map((k) => (
                  <option key={k} value={k}>{STATUS[k].label}</option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Hạn chót</span>
              <input className={s.input} type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </label>
          </div>

          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.flabel}>Tiến độ</span>
              <div className={s.rangeWrap}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={progress}
                  onChange={(e) => setProgress(Number(e.target.value))}
                />
                <span className={s.rangeVal}>{progress}%</span>
              </div>
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Doanh thu ảo (USD)</span>
              <input
                className={s.input}
                type="number"
                min={0}
                step={1000}
                value={revenue}
                onChange={(e) => setRevenue(e.target.value)}
              />
            </label>
          </div>

          {err && <div className={s.err}>{err}</div>}
        </div>

        <div className={s.modalFoot}>
          {goal && (
            <button className={s.delete} onClick={remove} disabled={busy !== null}>
              {busy === 'delete' ? 'Đang xoá…' : '🗑 Xoá'}
            </button>
          )}
          <button className={s.cancel} onClick={onClose} disabled={busy !== null}>
            Huỷ
          </button>
          <button className={s.save} onClick={save} disabled={busy !== null || !title.trim()}>
            {busy === 'save' ? 'Đang lưu…' : goal ? 'Lưu thay đổi' : 'Tạo mục tiêu'}
          </button>
        </div>
      </div>
    </div>
  )
}
