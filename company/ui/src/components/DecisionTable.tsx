import type { Decision, DecisionStatus, DecisionUrgency } from '../types'
import { Icon } from './Icon'
import s from './DecisionTable.module.css'
import p from './Panel.module.css'

const STATUS: Record<DecisionStatus, { cls: string; label: string }> = {
  pending: { cls: 'pillPending', label: 'Chờ quyết định' },
  decided: { cls: 'pillDecided', label: 'Đã quyết' },
  deferred: { cls: 'pillDeferred', label: 'Hoãn' },
}

const URGENCY: Record<DecisionUrgency, { cls: string; label: string }> = {
  blocking: { cls: 'pillBlocking', label: 'Đang chặn' },
  normal: { cls: 'pillNormal', label: 'Bình thường' },
}

interface Props {
  decisions: Decision[]
  selectedId?: string
  onSelect: (id: string) => void
  query: string
}

export function DecisionTable({ decisions, selectedId, onSelect, query }: Props) {
  const q = query.trim().toLowerCase()
  const rows = q
    ? decisions.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.question.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q),
      )
    : decisions

  return (
    <div className={p.panel}>
      <div className={p.head}>
        <h2 className={p.title}>
          Chờ CEO / CTO quyết <span className={p.hint}>· {rows.length} mục</span>
        </h2>
        <button className={p.button}>
          <Icon name="filter" size={14} strokeWidth={2} />
          Filter
        </button>
      </div>

      {rows.length === 0 ? (
        <div className={p.empty}>Không có quyết định nào khớp “{query.trim()}”.</div>
      ) : (
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>No</th>
                <th>Mã</th>
                <th>Nội dung</th>
                <th>Người đề xuất</th>
                <th>Người quyết</th>
                <th>Mức độ</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => {
                const status = STATUS[d.status]
                const urgency = URGENCY[d.urgency]
                return (
                  <tr
                    key={d.id}
                    className={d.id === selectedId ? `${s.row} ${s.rowActive}` : s.row}
                    onClick={() => onSelect(d.id)}
                  >
                    <td>{i + 1}</td>
                    <td>
                      <span className="chip chipMono">{d.id}</span>
                    </td>
                    <td>
                      <div className={s.title}>{d.title}</div>
                      <div className={s.sub}>{d.question}</div>
                    </td>
                    <td>
                      <div className={s.who}>
                        <div className={s.whoAvatar}>{d.raisedByEmoji}</div>
                        {d.raisedByName}
                      </div>
                    </td>
                    <td>{d.decider}</td>
                    <td>
                      <span className={`pill ${urgency.cls}`}>{urgency.label}</span>
                    </td>
                    <td>
                      <span className={`pill ${status.cls}`}>{status.label}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function ReadOnlyNotice({ note, source }: { note: string; source: string }) {
  return (
    <div className={s.notice}>
      <Icon name="info" size={17} strokeWidth={2} />
      <div>
        <b>Nguồn dữ liệu: <code>{source}</code>.</b> {note} Console là trang tĩnh nên hiển thị
        snapshot đã xuất lúc build — nó <b>đọc</b> từ DB nhưng chưa <b>ghi</b> trực tiếp. Nút “Sao
        chép decision record” tạo sẵn bản ghi để dán vào DB.
      </div>
    </div>
  )
}
