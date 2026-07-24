import type { Decision } from '../types'
import { Section, drawerStyles as s } from './Drawer'
import { useCopy } from '../lib/useCopy'

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

      {decision.ruling && (
        <Section label="Quyết định của owner">
          <div className={s.rec}>
            <strong>Đã chốt</strong>
            {decision.ruling}
          </div>
        </Section>
      )}

      <Section label="Khuyến nghị">
        <div className={s.rec}>
          <strong>{decision.raisedByName} đề xuất</strong>
          {decision.recommendation}
        </div>
      </Section>

      <Section label="Chi phí nếu chưa quyết">
        <div className={s.cost}>{decision.costOfNotDeciding}</div>
      </Section>

      <Section label="Đang chặn">
        <div className={s.chips}>
          {decision.blocks.map((b) => (
            <span key={b} className="chip">
              {b}
            </span>
          ))}
        </div>
      </Section>
    </>
  )
}

/**
 * A ready-to-paste decision record. The console cannot write to disk, so this is
 * the honest handoff — no fake "Approve" button that silently does nothing.
 */
export function decisionRecord(d: Decision): string {
  return [
    `# ${d.id} — ${d.title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Raised by | ${d.raisedBy} |`,
    `| Raised at | ${d.raisedAt} |`,
    `| Decider | ${d.decider} |`,
    '| Decided at | <YYYY-MM-DD> |',
    '',
    '## Question',
    d.question,
    '',
    '## Options considered',
    d.options.map((o) => `- **${o.label}** — ${o.detail}`).join('\n'),
    '',
    '## Recommendation given',
    d.recommendation,
    '',
    '## RULING',
    '<option chosen + reasoning — fill in>',
    '',
    '## Unblocks',
    d.blocks.map((b) => `- ${b}`).join('\n'),
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
        Console chỉ đọc — dán vào
        <br />
        <code>company/decisions/{decision.id}.md</code>
      </div>
    </>
  )
}
