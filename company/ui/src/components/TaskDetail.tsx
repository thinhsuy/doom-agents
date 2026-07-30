import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Task, TaskComment, TaskHistoryEvent, TaskPriority, TaskStatus } from '../types'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Section, drawerStyles as d } from './Drawer'
import { useCopy } from '../lib/useCopy'
import s from './TaskDetail.module.css'

const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: 'Cần làm', color: '#8A90A8' },
  in_progress: { label: 'Đang làm', color: '#4E5AE8' },
  in_qa: { label: 'Đang review (QA)', color: '#F5A93F' },
  rejected: { label: 'Bị trả lại', color: '#F2547D' },
  accepted: { label: 'Đã chấp nhận', color: '#21C286' },
  deferred: { label: 'Đã hoãn', color: '#8A90A8' },
  escalated: { label: 'Đã escalate', color: '#F2547D' },
  cancelled: { label: 'Đã huỷ', color: '#6b7280' },
}

const PRIORITY: Record<TaskPriority, { label: string; color: string }> = {
  urgent: { label: 'Khẩn', color: '#F2547D' },
  high: { label: 'Cao', color: '#F5A93F' },
  medium: { label: 'Trung bình', color: '#4E5AE8' },
  low: { label: 'Thấp', color: '#8A90A8' },
}

function time(iso: string): string {
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function Person({ slug }: { slug?: string | null }) {
  const who = agentDisplay(slug)
  return (
    <span className={s.person}>
      <span className={s.personAvatar} style={{ background: `${who.color}22` }}>
        {who.emoji}
      </span>
      {who.name}
    </span>
  )
}

export function priorityMeta(priority: TaskPriority) {
  return PRIORITY[priority] ?? PRIORITY.medium
}

export function TaskDetail({ task }: { task: Task }) {
  const st = STATUS[task.status]
  const pr = priorityMeta(task.priority)
  const nearCap = task.attempt >= 2 && task.status !== 'accepted'

  return (
    <>
      <div className={s.badges}>
        <span className={s.badge} style={{ background: `${st.color}1f`, color: st.color }}>
          {st.label}
        </span>
        <span className={s.badge} style={{ background: `${pr.color}1f`, color: pr.color }}>
          ⚑ {pr.label}
        </span>
        {task.attempt > 0 && (
          <span
            className={s.badge}
            style={
              nearCap
                ? { background: 'var(--amber-soft)', color: '#c77c12' }
                : { background: 'var(--bg)', color: '#6e7590' }
            }
          >
            Lượt thử {task.attempt}/3
          </span>
        )}
        {task.blockedBy && (
          <span className={s.badge} style={{ background: 'var(--red-soft)', color: '#d93463' }}>
            ⛔ Chặn bởi {task.blockedBy}
          </span>
        )}
      </div>

      <Section label="Thông tin">
        <dl className={d.meta}>
          <dt>PIC (phụ trách)</dt>
          <dd>
            <Person slug={task.assignee} />
          </dd>
          <dt>Reporter</dt>
          <dd>
            <Person slug={task.reporter} />
          </dd>
          {task.requirementId && (
            <>
              <dt>Yêu cầu</dt>
              <dd>
                <code>{task.requirementId}</code>
              </dd>
            </>
          )}
          <dt>Engagement</dt>
          <dd>
            <code>{task.engagementId}</code>
          </dd>
        </dl>
      </Section>

      {task.detail && (
        <Section label="Mô tả công việc">
          {/* Same markdown treatment as comments — leads write descriptions in markdown. */}
          <div className={s.commentMd}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.detail}</ReactMarkdown>
          </div>
        </Section>
      )}

      <Section label={`Trao đổi (${task.comments.length})`}>
        {task.comments.length === 0 ? (
          <div className={s.empty}>Chưa có trao đổi nào trên ticket này.</div>
        ) : (
          <div className={s.comments}>
            {task.comments.map((c) => (
              <CommentRow key={c.id} comment={c} />
            ))}
          </div>
        )}
      </Section>

      <Section label={`Lịch sử trạng thái (${task.history.length})`}>
        {task.history.length === 0 ? (
          <div className={s.empty}>Chưa có thay đổi trạng thái nào được ghi lại.</div>
        ) : (
          <ol className={s.timeline}>
            {task.history.map((h, i) => (
              <HistoryRow key={i} event={h} />
            ))}
          </ol>
        )}
      </Section>
    </>
  )
}

function CommentRow({ comment }: { comment: TaskComment }) {
  const who = agentDisplay(comment.agent)
  // Deliverables/verdicts are long markdown — collapse to a 2-line preview by
  // default; expanding renders full markdown inside a scrollable box.
  const isLong = comment.body.length > 220 || comment.body.split('\n').length > 4
  const [open, setOpen] = useState(false)
  return (
    <div className={s.comment}>
      <span className={s.commentAvatar} style={{ background: `${who.color}22` }}>
        {who.emoji}
      </span>
      <div className={s.commentBody}>
        <div className={s.commentTop}>
          <span className={s.commentName}>{who.name}</span>
          <span className={s.commentTime}>{time(comment.createdAt)}</span>
        </div>
        {isLong && !open ? (
          <button className={s.commentPreview} onClick={() => setOpen(true)}>
            <span className={s.commentClamp}>{comment.body}</span>
            <span className={s.commentMore}>▾ Xem đầy đủ · {comment.body.length.toLocaleString('vi-VN')} ký tự</span>
          </button>
        ) : (
          <>
            <div className={s.commentMd}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
            </div>
            {isLong && (
              <button className={s.commentLess} onClick={() => setOpen(false)}>
                ▴ Thu gọn
              </button>
            )}
          </>
        )}
        {comment.mentions.length > 0 && (
          <div className={s.mentions}>
            {comment.mentions.map((m) => (
              <span key={m} className={s.mention}>
                @{agentDisplay(m).name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function HistoryRow({ event }: { event: TaskHistoryEvent }) {
  const to = STATUS[event.to as TaskStatus]
  const from = event.from ? STATUS[event.from as TaskStatus] : undefined
  return (
    <li className={s.tl}>
      <span className={s.tlDot} style={{ background: to?.color ?? '#8A90A8' }} />
      <div className={s.tlBody}>
        <div className={s.tlTop}>
          {from && <span className={s.tlFrom}>{from.label}</span>}
          <span className={s.tlArrow}>→</span>
          <span className={s.tlTo} style={{ color: to?.color }}>
            {to?.label ?? event.to}
          </span>
          <span className={s.tlTime}>{time(event.at)}</span>
        </div>
        <div className={s.tlMeta}>
          <Person slug={event.by === 'owner' ? null : event.by} />
          {event.reason && <span className={s.tlReason}>· {event.reason}</span>}
        </div>
      </div>
    </li>
  )
}

/**
 * A ready-to-paste ticket snapshot. The console is read-only — agents act on the
 * ticket through the MCP task tools (update_task_status / comment_task / …), which
 * write straight to Postgres. This copy is the honest owner-side handoff.
 */
export function taskRecord(t: Task): string {
  return [
    `# ${t.id} — ${t.title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Status | ${STATUS[t.status].label} |`,
    `| Priority | ${priorityMeta(t.priority).label} |`,
    `| PIC | ${agentDisplay(t.assignee).name} (${t.assignee ?? 'owner'}) |`,
    `| Reporter | ${agentDisplay(t.reporter).name} (${t.reporter ?? 'owner'}) |`,
    `| Requirement | ${t.requirementId ?? '—'} |`,
    `| Attempt | ${t.attempt}/3 |`,
    `| Blocked by | ${t.blockedBy ?? '—'} |`,
    '',
    '## Mô tả',
    t.detail ?? '—',
    '',
  ].join('\n')
}

export function TaskDetailFooter({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  const [state, copy] = useCopy()
  const { user } = useAuth()
  const [deleting, setDeleting] = useState(false)
  // Only the CEO may delete a ticket (not CTO/COO/CIO); the backend enforces it too.
  const canDelete = user?.username === 'ceo'

  async function remove() {
    if (deleting) return
    if (!window.confirm(`Xoá vĩnh viễn ticket ${task.id} — ${task.title}?\nMất luôn trao đổi + lịch sử, không hoàn tác được.`)) return
    setDeleting(true)
    try {
      const r = await fetch(apiUrl(`/api/tasks/${task.id}`), { method: 'DELETE', credentials: 'include' })
      if (r.ok) onDeleted?.()
      else {
        const dd = await r.json().catch(() => null)
        window.alert(String(dd?.detail || 'Không xoá được ticket'))
      }
    } catch {
      window.alert('Cần backend chạy')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <button className={`${d.btn} ${d.btnPrimary}`} onClick={() => copy(taskRecord(task))}>
        {state === 'ok'
          ? '✓ Đã sao chép'
          : state === 'fail'
            ? 'Không sao chép được'
            : 'Sao chép ticket'}
      </button>
      {canDelete && (
        <button className={`${d.btn} ${s.deleteBtn}`} onClick={remove} disabled={deleting}>
          {deleting ? 'Đang xoá…' : '🗑 Xoá ticket'}
        </button>
      )}
      <div className={d.footNote}>
        Console chỉ đọc — agent thao tác
        <br />
        ticket qua MCP (<code>update_task_status</code>…)
      </div>
    </>
  )
}
