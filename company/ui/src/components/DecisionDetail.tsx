import { useState } from 'react'
import type { Decision } from '../types'
import { Section, drawerStyles as s } from './Drawer'
import { useCopy } from '../lib/useCopy'
import { apiUrl } from '../lib/api'
import d from './DecisionDetail.module.css'

export function DecisionDetail({ decision }: { decision: Decision }) {
  return (
    <>
      <Section label="Cần quyết điều gì">
        <div className={s.text}>{decision.question}</div>
      </Section>

      <Section label="Vì sao cần đến bạn">
        <div className={s.text}>{decision.whyYou}</div>
      </Section>

      <Section label="Các lựa chọn">
        {decision.options.map((o) => (
          <div key={o.label} className={s.opt}>
            <div className={s.optLabel}>{o.label}</div>
            <div className={s.optDetail}>{o.detail}</div>
            {o.pros.map((p) => (
              <div key={p} className={`${s.pc} ${s.pro}`}>
                <span className={s.pcMark}>+</span>
                {p}
              </div>
            ))}
            {o.cons.map((c) => (
              <div key={c} className={`${s.pc} ${s.con}`}>
                <span className={s.pcMark}>−</span>
                {c}
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section label="Khuyến nghị">
        <div className={s.rec}>
          <strong>{decision.raisedByName} đề xuất</strong>
          {decision.recommendation}
        </div>
      </Section>

      {/* Owner's ruling: recorded ruling once decided, a cancel note once cancelled,
          the interactive form while still pending. */}
      {decision.status === 'decided' && decision.ruling ? (
        <Section label="Quyết định của owner">
          <div className={s.rec}>
            <strong>Đã chốt</strong>
            {decision.ruling}
          </div>
        </Section>
      ) : decision.status === 'cancelled' ? (
        <Section label="Quyết định của owner">
          <div className={d.cancelled}>
            <strong>⛔ Đã huỷ</strong>
            {decision.ruling ? decision.ruling : 'Owner đã huỷ quyết định này (không kèm lý do).'}
          </div>
        </Section>
      ) : (
        <Section label="Ra quyết định của bạn">
          <DecideForm decision={decision} />
        </Section>
      )}

      {decision.costOfNotDeciding && (
        <Section label="Chi phí nếu chưa quyết">
          <div className={s.cost}>{decision.costOfNotDeciding}</div>
        </Section>
      )}

      {decision.blocks.length > 0 && (
        <Section label="Đang chặn">
          <div className={s.chips}>
            {decision.blocks.map((b) => (
              <span key={b} className="chip">
                {b}
              </span>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** The CEO/CTO fills in their ruling (optionally picking one of the proposed options)
    and submits. On success the backend marks the decision decided AND triggers the
    agent that raised it to continue in the group it came from. */
function DecideForm({ decision }: { decision: Decision }) {
  const [option, setOption] = useState('')
  const [ruling, setRuling] = useState('')
  const [busy, setBusy] = useState<null | 'decide' | 'cancel'>(null)
  const [done, setDone] = useState<null | { kind: 'decided'; replying: boolean; raiser: string } | { kind: 'cancelled' }>(null)
  const [err, setErr] = useState('')
  // Cancel is a two-step affordance (expand → confirm) so a decision can't be dropped
  // by an accidental click; the message it carries is optional.
  const [cancelling, setCancelling] = useState(false)
  const [cancelMsg, setCancelMsg] = useState('')

  async function submit() {
    const text = ruling.trim()
    if (!text || busy) return
    setBusy('decide')
    setErr('')
    try {
      const r = await fetch(apiUrl(`/api/decisions/${decision.id}/decide`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruling: text, option }),
      })
      const data = await r.json().catch(() => null)
      if (r.ok && data?.ok) {
        setDone({ kind: 'decided', replying: Boolean(data.replying), raiser: decision.raisedByName })
      } else {
        setErr(String(data?.detail || 'Không gửi được quyết định'))
      }
    } catch {
      setErr('Cần backend chạy để gửi quyết định')
    } finally {
      setBusy(null)
    }
  }

  async function cancel() {
    if (busy) return
    setBusy('cancel')
    setErr('')
    try {
      const r = await fetch(apiUrl(`/api/decisions/${decision.id}/cancel`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: cancelMsg.trim() }),
      })
      const data = await r.json().catch(() => null)
      if (r.ok && data?.ok) {
        setDone({ kind: 'cancelled' })
      } else {
        setErr(String(data?.detail || 'Không huỷ được quyết định'))
      }
    } catch {
      setErr('Cần backend chạy để huỷ quyết định')
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    if (done.kind === 'cancelled') {
      return (
        <div className={d.cancelled}>
          <strong>⛔ Đã huỷ quyết định.</strong>
          {`Đã báo cho ${decision.raisedByName} trong group liên quan — không cần xử lý tiếp.`}
        </div>
      )
    }
    return (
      <div className={d.done}>
        <strong>✅ Đã chốt quyết định.</strong>
        {done.replying
          ? `Đã kích hoạt ${done.raiser} tiếp tục xử lý theo quyết định của bạn.`
          : `Đã lưu quyết định (không kích hoạt được ${done.raiser} — kiểm tra agent còn trong biên chế).`}
      </div>
    )
  }

  return (
    <div className={d.form}>
      {decision.options.length > 0 && (
        <div className={d.optRadios}>
          {decision.options.map((o) => (
            <label key={o.label} className={option === o.label ? `${d.optRadio} ${d.optRadioOn}` : d.optRadio}>
              <input
                type="radio"
                name={`opt-${decision.id}`}
                checked={option === o.label}
                onChange={() => setOption(o.label)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
      <textarea
        className={d.input}
        placeholder="Nhập quyết định + lý do của bạn (agent sẽ đọc và làm tiếp theo cái này)…"
        value={ruling}
        onChange={(e) => setRuling(e.target.value)}
      />
      {err && <div className={d.err}>{err}</div>}
      <button className={d.submit} onClick={submit} disabled={!ruling.trim() || busy !== null}>
        {busy === 'decide' ? 'Đang gửi…' : '✅ Gửi quyết định & kích hoạt agent'}
      </button>
      <div className={d.hint}>
        Sau khi gửi: quyết định lưu vào <code>company.decisions</code> và <b>{decision.raisedByName}</b> được
        kích hoạt tiếp tục xử lý trong group đã tạo ticket.
      </div>

      {/* Cancel: drop the decision instead of ruling on it (two-step, optional note). */}
      {!cancelling ? (
        <button className={d.cancelLink} onClick={() => setCancelling(true)} disabled={busy !== null}>
          Hoặc huỷ quyết định này
        </button>
      ) : (
        <div className={d.cancelBox}>
          <textarea
            className={d.cancelInput}
            placeholder="Lý do huỷ (không bắt buộc) — agent sẽ thấy trong group…"
            value={cancelMsg}
            onChange={(e) => setCancelMsg(e.target.value)}
          />
          <div className={d.cancelActions}>
            <button
              className={d.cancelBack}
              onClick={() => {
                setCancelling(false)
                setCancelMsg('')
              }}
              disabled={busy !== null}
            >
              Quay lại
            </button>
            <button className={d.cancelConfirm} onClick={cancel} disabled={busy !== null}>
              {busy === 'cancel' ? 'Đang huỷ…' : '⛔ Xác nhận huỷ'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A ready-to-paste decision record — kept as a secondary export (e.g. for the git-tracked
 * decision log). The live ruling now goes through the form above.
 */
export function decisionRecord(dc: Decision): string {
  return [
    `# ${dc.id} — ${dc.title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Raised by | ${dc.raisedBy} |`,
    `| Raised at | ${dc.raisedAt} |`,
    `| Decider | ${dc.decider} |`,
    `| Status | ${dc.status} |`,
    '',
    '## Question',
    dc.question,
    '',
    '## Options considered',
    dc.options.map((o) => `- **${o.label}** — ${o.detail}`).join('\n'),
    '',
    '## Recommendation given',
    dc.recommendation,
    '',
    '## RULING',
    dc.ruling ?? '<option chosen + reasoning — fill in>',
    '',
    '## Unblocks',
    dc.blocks.map((b) => `- ${b}`).join('\n'),
    '',
  ].join('\n')
}

export function DecisionDetailFooter({ decision }: { decision: Decision }) {
  const [state, copy] = useCopy()
  return (
    <>
      <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => copy(decisionRecord(decision))}>
        {state === 'ok'
          ? '✓ Đã sao chép'
          : state === 'fail'
            ? 'Không sao chép được'
            : 'Sao chép decision record'}
      </button>
      <div className={s.footNote}>
        Bản ghi để lưu vào
        <br />
        <code>company/decisions/{decision.id}.md</code>
      </div>
    </>
  )
}
