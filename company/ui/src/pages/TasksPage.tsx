import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Task, TaskStatus, Workspace } from '../types'
import { agentDisplay } from '../lib/agents'
import { StatGrid, type Stat } from '../components/StatCard'
import { SampleNotice } from '../components/SampleNotice'
import { Drawer } from '../components/Drawer'
import { TaskDetail, TaskDetailFooter, priorityMeta } from '../components/TaskDetail'
import s from './TasksPage.module.css'
import p from '../components/Panel.module.css'

// Jira-like columns. rejected sits in the review column (it loops back to QA);
// escalated + deferred share an "off the board" column so they don't vanish.
const COLUMNS: { key: string; label: string; color: string; statuses: TaskStatus[] }[] = [
  { key: 'todo', label: 'Cần làm', color: '#8A90A8', statuses: ['todo'] },
  { key: 'doing', label: 'Đang làm', color: '#4E5AE8', statuses: ['in_progress'] },
  { key: 'review', label: 'Đang review', color: '#F5A93F', statuses: ['in_qa', 'rejected'] },
  { key: 'done', label: 'Xong', color: '#21C286', statuses: ['accepted'] },
  { key: 'off', label: 'Hoãn / Huỷ / Escalate', color: '#F2547D', statuses: ['deferred', 'escalated', 'cancelled'] },
]

export function TasksPage({ workspace }: { workspace: Workspace }) {
  const { tasks } = workspace
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

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
              <div key={col.key} className={s.col}>
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
        footer={openTask ? <TaskDetailFooter task={openTask} /> : undefined}
        onClose={() => navigate('/workspace/tasks')}
      >
        {openTask && <TaskDetail task={openTask} />}
      </Drawer>
    </>
  )
}

function TaskCard({ task, selected, onOpen }: { task: Task; selected: boolean; onOpen: () => void }) {
  const who = agentDisplay(task.assignee)
  const nearCap = task.attempt >= 2 && task.status !== 'accepted'
  const pr = priorityMeta(task.priority)
  return (
    <button
      className={selected ? `${s.card} ${s.cardSelected}` : s.card}
      onClick={onOpen}
      aria-label={`Mở chi tiết ${task.id}`}
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
