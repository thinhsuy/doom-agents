import { useEffect, useState } from 'react'
import { apiUrl } from '../lib/api'
import { useCurrency } from '../lib/currency'
import s from './BudgetControls.module.css'

interface Budget {
  spent: number
  spentMonth: number
  spentQuarter: number
  spentYear: number
  ceiling: number
  warn: number
  over: boolean
  manual: boolean
  blocked: boolean
  reason?: string | null
}

/** Emergency brakes: daily cost ceiling + warning threshold + one-click emergency
    stop + per-model LLM timeout. Live from the FastAPI backend. */
export function BudgetControls() {
  const { money, toUsd, toCurrentUnit, unit, unitSymbol } = useCurrency()
  const [b, setB] = useState<Budget | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [ceilingIn, setCeilingIn] = useState('')
  const [warnIn, setWarnIn] = useState('')
  const [timeouts, setTimeouts] = useState<Record<string, number>>({})
  const [tModels, setTModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const loadBudget = async () => {
    try {
      const r = await fetch(apiUrl('/api/budget'))
      if (!r.ok) return
      const d = (await r.json()) as Budget
      setB(d)
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }

  useEffect(() => {
    loadBudget()
    fetch(apiUrl('/api/model-timeouts'))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setTimeouts(d.timeouts ?? {})
          setTModels(d.models ?? Object.keys(d.timeouts ?? {}))
        }
      })
      .catch(() => {})
    const t = setInterval(loadBudget, 5000)
    return () => clearInterval(t)
  }, [])

  // The budget is a USD cost control (vendors bill USD); the UI edits it in the current
  // display unit (× live rate) and converts back to USD on save. Seed once when budget
  // first arrives — don't clobber typing on the 5s poll.
  useEffect(() => {
    if (b && ceilingIn === '') setCeilingIn(String(Math.round(toCurrentUnit(b.ceiling))))
    if (b && warnIn === '') setWarnIn(String(Math.round(toCurrentUnit(b.warn))))
  }, [b]) // eslint-disable-line react-hooks/exhaustive-deps
  // Re-seed the inputs when the display unit flips (else they show old-unit numbers).
  useEffect(() => {
    if (!b) return
    setCeilingIn(String(Math.round(toCurrentUnit(b.ceiling))))
    setWarnIn(String(Math.round(toCurrentUnit(b.warn))))
  }, [unit]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveBudget() {
    const ceilingUsd = toUsd(Number(ceilingIn))
    const warnUsd = toUsd(Number(warnIn))
    if (!(ceilingUsd > 0)) return
    setBusy(true)
    try {
      const r = await fetch(apiUrl('/api/budget'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ceilingUsd, warnUsd }),
      })
      if (r.ok) setB((await r.json()) as Budget)
    } finally {
      setBusy(false)
    }
  }

  async function toggleStop() {
    setBusy(true)
    try {
      const path = b?.blocked ? '/api/worker/resume' : '/api/worker/pause'
      await fetch(apiUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      await loadBudget()
    } finally {
      setBusy(false)
    }
  }

  async function saveTimeouts() {
    setBusy(true)
    try {
      const r = await fetch(apiUrl('/api/model-timeouts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeouts }),
      })
      if (r.ok) setTimeouts((await r.json()).timeouts ?? timeouts)
    } finally {
      setBusy(false)
    }
  }

  if (online === false) {
    return (
      <div className={s.offline}>
        Cần chạy backend để dùng phanh chi phí / dừng khẩn cấp:{' '}
        <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>.
      </div>
    )
  }
  if (!b) return null

  const pct = Math.min(100, (b.spent / Math.max(1e-9, b.ceiling)) * 100)
  const level = b.blocked ? 'stop' : b.spent >= b.warn ? 'warn' : 'ok'

  // Estimated period ceilings = daily × N (simple projection, as requested).
  const periods = [
    { label: 'Ngày', spent: b.spent, cap: b.ceiling },
    { label: 'Tháng', spent: b.spentMonth, cap: b.ceiling * 30 },
    { label: 'Quý', spent: b.spentQuarter, cap: b.ceiling * 90 },
    { label: 'Năm', spent: b.spentYear, cap: b.ceiling * 365 },
  ]

  return (
    <div className={`${s.card} ${s[level]}`}>
      <div className={s.top}>
        <div>
          <div className={s.label}>Phanh chi phí — hôm nay</div>
          <div className={s.big}>
            {money(b.spent, 'usd')} <span className={s.of}>/ trần {money(b.ceiling, 'usd')}</span>
          </div>
        </div>
        <div className={s.actions}>
          <button className={s.gearBtn} onClick={() => setShowSettings(true)} title="Cài đặt trần & timeout">
            ⚙️ Cài đặt
          </button>
          <button className={b.blocked ? s.resumeBtn : s.stopBtn} onClick={toggleStop} disabled={busy}>
            {b.blocked ? '▶ Tiếp tục' : '🛑 Dừng khẩn cấp'}
          </button>
        </div>
      </div>

      <div className={s.bar}>
        <div className={s.warnMark} style={{ left: `${Math.min(100, (b.warn / Math.max(1e-9, b.ceiling)) * 100)}%` }} />
        <div className={`${s.fill} ${s[`fill_${level}`]}`} style={{ width: `${pct}%` }} />
      </div>

      <div className={s.state}>
        {b.blocked ? (
          <span className={s.stopText}>⛔ ĐÃ DỪNG — {b.reason || 'agent không tiêu tốn LLM tới khi Tiếp tục'}</span>
        ) : b.spent >= b.warn ? (
          <span className={s.warnText}>⚠️ Đã vượt ngưỡng cảnh báo {money(b.warn, 'usd')} — sẽ tự dừng khi chạm trần</span>
        ) : (
          <span className={s.okText}>Đang chạy bình thường · cảnh báo ở {money(b.warn, 'usd')}, tự dừng ở {money(b.ceiling, 'usd')}</span>
        )}
      </div>

      {/* Chi phí theo kỳ — trần tháng/quý/năm ước tính = ngày × 30/90/365 */}
      <div className={s.periods}>
        {periods.map((p) => (
          <div key={p.label} className={s.period}>
            <div className={s.pLabel}>{p.label}</div>
            <div className={s.pSpent}>{money(p.spent, 'usd')}</div>
            <div className={s.pCap}>/ ~{money(p.cap, 'usd')}{p.label !== 'Ngày' && ' ước tính'}</div>
          </div>
        ))}
      </div>

      {showSettings && (
        <div className={s.overlay} onClick={() => setShowSettings(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalHead}>
              <span className={s.modalTitle}>⚙️ Cài đặt phanh chi phí</span>
              <button className={s.close} onClick={() => setShowSettings(false)}>✕</button>
            </div>

            <div className={s.group}>
              <div className={s.groupLabel}>Trần chi phí (theo ngày)</div>
              <div className={s.settings}>
                <label className={s.field}>
                  Trần ({unitSymbol}/ngày)
                  <input className={s.num} value={ceilingIn} onChange={(e) => setCeilingIn(e.target.value)} inputMode="decimal" />
                </label>
                <label className={s.field}>
                  Ngưỡng cảnh báo ({unitSymbol}/ngày)
                  <input className={s.num} value={warnIn} onChange={(e) => setWarnIn(e.target.value)} inputMode="decimal" />
                </label>
                <button className={s.save} onClick={saveBudget} disabled={busy || !(Number(ceilingIn) > 0)}>
                  Lưu trần
                </button>
              </div>
              <div className={s.hint}>Trần tháng/quý/năm ước tính = trần ngày × 30 / 90 / 365.</div>
            </div>

            {tModels.length > 0 && (
              <div className={s.group}>
                <div className={s.groupLabel}>Timeout mỗi model (giây)</div>
                <div className={s.timeouts}>
                  {tModels.map((m) => (
                    <label key={m} className={s.toField}>
                      {m}
                      <input
                        className={s.toNum}
                        value={String(timeouts[m] ?? '')}
                        onChange={(e) => setTimeouts((prev) => ({ ...prev, [m]: Number(e.target.value) || 0 }))}
                        inputMode="numeric"
                      />
                    </label>
                  ))}
                  <button className={s.save} onClick={saveTimeouts} disabled={busy}>
                    Lưu timeout
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
