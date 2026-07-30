import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Task, TaskStatus, Workspace } from '../types'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import { StatGrid, type Stat } from '../components/StatCard'
import { SampleNotice } from '../components/SampleNotice'
import { Drawer } from '../components/Drawer'
import { TaskDetail, TaskDetailFooter, priorityMeta } from '../components/TaskDetail'
import s from './TasksPage.module.css'
import p from '../components/Panel.module.css'

// Jira-like columns. rejected sits in the review column (it loops back to QA);
// escalated + deferred share an "off the board" column so they don't vanish.
// `drop` = the canonical status a drag-drop INTO this column sets (the "off" column
// holds 3 statuses, so a drop there defaults to deferred/hoãn — cancel needs a reason
// so it stays in the detail drawer).
const COLUMNS: { key: string; label: string; color: string; statuses: TaskStatus[]; drop: TaskStatus }[] = [
  { key: 'todo', label: 'Cần làm', color: '#8A90A8', statuses: ['todo'], drop: 'todo' },
  { key: 'doing', label: 'Đang làm', color: '#4E5AE8', statuses: ['in_progress'], drop: 'in_progress' },
  { key: 'review', label: 'Đang review', color: '#F5A93F', statuses: ['in_qa', 'rejected'], drop: 'in_qa' },
  { key: 'done', label: 'Xong', color: '#21C286', statuses: ['accepted'], drop: 'accepted' },
  { key: 'off', label: 'Hoãn / Huỷ / Escalate', color: '#F2547D', statuses: ['deferred', 'escalated', 'cancelled'], drop: 'deferred' },
]

export function TasksPage({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  // Optimistic status overrides for owner drag-drop, applied on top of the live
  // workspace and cleared once the 5s poll confirms the server caught up.
  const [override, setOverride] = useState<Record<string, TaskStatus>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)

  const tasks = useMemo(
    () => workspace.tasks.map((t) => (override[t.id] ? { ...t, status: override[t.id]! } : t)),
    [workspace.tasks, override],
  )

  useEffect(() => {
    setOverride((prev) => {
      if (!Object.keys(prev).length) return prev
      const next = { ...prev }
      let changed = false
      for (const t of workspace.tasks) {
        if (next[t.id] && next[t.id] === t.status) {
          delete next[t.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [workspace.tasks])

  async function moveTo(col: (typeof COLUMNS)[number]) {
    const id = dragId
    setDragId(null)
    setOverCol(null)
    if (!id) return
    const t = tasks.find((x) => x.id === id)
    if (!t || t.status === col.drop) return
    setOverride((prev) => ({ ...prev, [id]: col.drop })) // optimistic
    try {
      const r = await fetch(apiUrl(`/api/tasks/${id}/status`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: col.drop }),
      })
      if (!r.ok) throw new Error()
    } catch {
      setOverride((prev) => {
        const n = { ...prev }
        delete n[id]
        return n
      }) // rollback
    }
  }

  const openTask = useMemo(
    () => (id ? tasks.find((t) => t.id === id) : undefined),
    [tasks, id],
  )

  const byColumn = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const col of COLUMNS) map.set(col.key, [])
    for (const t of tasks) {
      const col = COLUMNS.find((c) => c.statuses.includes(t.status))
      if (col) map.get(col.key)!.push(t)
    }
    return map
  }, [tasks])

  const active = tasks.filter((t) => !['accepted', 'deferred', 'cancelled'].includes(t.status)).length
  const nearCap = tasks.filter((t) => t.attempt >= 2 && !['accepted', 'cancelled'].includes(t.status)).length

  const stats: Stat[] = [
    { label: 'Tổng task', value: tasks.length, color: '#4E5AE8', icon: 'checkSquare',
      foot: <>trong {workspace.engagements.length} engagement</> },
    { label: 'Đang chạy', value: active, color: '#F5A93F', icon: 'clock',
      foot: <>chưa xong / chưa hoãn</> },
    { label: 'Xong', value: byColumn.get('done')!.length, color: '#21C286', icon: 'shield',
      foot: <>đã được PO chấp nhận</> },
    { label: 'Gần hết lượt thử', value: nearCap, color: nearCap > 0 ? '#F2547D' : '#21C286', icon: 'users',
      foot: <>attempt ≥ 2 / 3</> },
  ]

  return (
    <>
      <SampleNotice workspace={workspace} />
      <StatGrid stats={stats} />

      {tasks.length === 0 ? (
        <div className={p.panel}>
          <div className={p.empty}>
            Chưa có task nào. Task sẽ xuất hiện khi một engagement được phân rã (Stage 3).
          </div>
        </div>
      ) : (
        <div className={s.board}>
          {COLUMNS.map((col) => {
            const list = byColumn.get(col.key)!
            return (
              <div
                key={col.key}
                className={overCol === col.key ? `${s.col} ${s.colOver}` : s.col}
                onDragOver={(e) => {
                  if (dragId) {
                    e.preventDefault()
                    if (overCol !== col.key) setOverCol(col.key)
                  }
                }}
                onDragLeave={(e) => {
                  // only clear when the pointer actually leaves the column box
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol((c) => (c === col.key ? null : c))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  moveTo(col)
                }}
              >
                <div className={s.colHead}>
                  <span className={s.colDot} style={{ background: col.color }} />
                  <span className={s.colName}>{col.label}</span>
                  <span className={s.colCount}>{list.length}</span>
                </div>
                <div className={s.cards}>
                  {list.length === 0 ? (
                    <div className={s.colEmpty}>—</div>
                  ) : (
                    list.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        selected={t.id === openTask?.id}
                        dragging={dragId === t.id}
                        onDragStart={() => setDragId(t.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setOverCol(null)
                        }}
                        onOpen={() => navigate(`/workspace/tasks/${t.id}`)}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Drawer
        open={Boolean(openTask)}
        title={openTask ? `${openTask.id} — ${openTask.title}` : ''}
        subtitle={openTask ? `Reporter ${agentDisplay(openTask.reporter).name} · PIC ${agentDisplay(openTask.assignee).name}` : undefined}
        footer={openTask ? <TaskDetailFooter task={openTask} onDeleted={() => navigate('/workspace/tasks')} /> : undefined}
        onClose={() => navigate('/workspace/tasks')}
      >
        {openTask && <TaskDetail task={openTask} />}
      </Drawer>
    </>
  )
}

function TaskCard({
  task,
  selected,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: Task
  selected: boolean
  dragging: boolean
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const who = agentDisplay(task.assignee)
  const nearCap = task.attempt >= 2 && task.status !== 'accepted'
  const pr = priorityMeta(task.priority)
  const cls = [s.card, selected && s.cardSelected, dragging && s.cardDragging].filter(Boolean).join(' ')
  return (
    <button
      className={cls}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', task.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      aria-label={`Mở chi tiết ${task.id}`}
      title="Kéo để đổi trạng thái · bấm để mở chi tiết"
    >
      <span className={s.priorityBar} style={{ background: pr.color }} title={`Ưu tiên: ${pr.label}`} />
      <div className={s.cardTop}>
        <span className={s.tid}>{task.id}</span>
        {task.requirementId && <span className={s.req}>{task.requirementId}</span>}
        <span className={s.prio} style={{ color: pr.color }} title={`Ưu tiên: ${pr.label}`}>
          ⚑ {pr.label}
        </span>
      </div>
      <div className={s.cardTitle}>{task.title}</div>
      <div className={s.cardFoot}>
        <div className={s.assignee}>
          <span className={s.avatar} style={{ background: `${who.color}22` }}>
            {who.emoji}
          </span>
          <span className={s.assigneeName}>{who.name}</span>
        </div>
        <div className={s.meta}>
          {task.comments.length > 0 && <span className={s.comments}>💬 {task.comments.length}</span>}
          {task.blockedBy && <span className={s.blocked}>⛔ {task.blockedBy}</span>}
          {task.status === 'rejected' && <span className={s.blocked}>FAIL</span>}
          {task.attempt > 0 && (
            <span className={nearCap ? `${s.attempt} ${s.attemptWarn}` : `${s.attempt} ${s.attemptOk}`}>
              {task.attempt}/3
            </span>
          )}
        </div>
      </div>
    </button>
  )
}
