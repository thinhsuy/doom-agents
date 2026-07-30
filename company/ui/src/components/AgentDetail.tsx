import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Agent, Division } from '../types'
import { Section, drawerStyles as s } from './Drawer'
import { useCopy } from '../lib/useCopy'
import { apiUrl } from '../lib/api'
import pe from './PersonaEditor.module.css'

interface Learning {
  id: number
  kind: 'skill' | 'knowledge' | 'lesson' | 'correction'
  source: 'self' | 'experience' | 'owner'
  content: string
  taskId?: string
  createdAt: string
}
const KIND_VI: Record<string, string> = {
  skill: 'Kỹ năng', knowledge: 'Kiến thức', lesson: 'Bài học', correction: 'Chỉnh sửa',
}
const SRC_VI: Record<string, string> = {
  self: 'tự đúc kết', experience: 'từ công việc', owner: 'CEO/CTO nhắc',
}

export function AgentDetail({ agent }: { agent: Agent }) {
  const [editing, setEditing] = useState(false)
  return (
    <>
      {editing && <PersonaEditor slug={agent.slug} name={agent.name} onClose={() => setEditing(false)} />}
      <Section label="Mô tả vai trò">
        <div className={s.text}>{agent.description}</div>
      </Section>

      {agent.hired && <LearningsSection slug={agent.slug} />}

      <Section label="Biên chế">
        {agent.hired ? (
          <>
            <div className={s.text}>
              <b>{agent.hiredGroup}</b> — {agent.hiredWhy}
            </div>
            <div className={`${s.note} ${s.noteOk}`}>
              Đã tuyển. Agent này nằm trong company/roster.json và sẽ được cài ở Stage 2.
            </div>
          </>
        ) : (
          <div className={`${s.note} ${s.noteWarn}`}>
            Chưa tuyển — vẫn nằm trong kho ứng viên, không được cài, không tốn gì. Thêm slug vào
            company/roster.json rồi chạy <code>npm run data</code> nếu cần dùng.
          </div>
        )}
      </Section>

      <RuntimeSection agent={agent} />

      {agent.vibe && (
        <Section label="Phong cách">
          <div className={`${s.text} ${s.quote}`}>“{agent.vibe}”</div>
        </Section>
      )}

      <Section label="Quyền tool">
        {agent.tools.length > 0 ? (
          <div className={s.chips}>
            {agent.tools.map((t) => (
              <span key={t} className="chip chipMono">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <div className={`${s.text} ${s.warn}`}>
            Chưa khai <code>tools:</code> — agent này hiện thừa hưởng toàn bộ quyền. Stage 2 của kế
            hoạch sẽ phân quyền lại.
          </div>
        )}
      </Section>

      {agent.sections.length > 0 && (
        <Section label={`Cấu trúc hồ sơ (${agent.sections.length} mục)`}>
          <div className={s.secList}>
            {agent.sections.map((sec, i) => (
              <div key={`${sec}-${i}`} className={s.secItem}>
                <span>—</span>
                {sec}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section label="Nguồn">
        <dl className={s.meta}>
          <dt>File</dt>
          <dd>
            <button className={pe.srcLink} onClick={() => setEditing(true)} title="Mở & sửa nội dung persona">
              {agent.path} ✎
            </button>
          </dd>
          <dt>Slug</dt>
          <dd>
            <button className={pe.srcLink} onClick={() => setEditing(true)} title="Mở & sửa nội dung persona">
              {agent.slug} ✎
            </button>
          </dd>
          <dt>Độ dài</dt>
          <dd>{agent.words.toLocaleString('vi-VN')} từ</dd>
        </dl>
        <div className={pe.srcHint}>Bấm File/Slug để xem &amp; sửa nội dung persona (knowledge/skill).</div>
      </Section>
    </>
  )
}

/** What the agent has taught ITSELF — live from company.agent_learnings. Only the
 * agent can write its own learnings (record_learning, server-side identity); this
 * is the read-only owner view. Empty until the agent actually learns something. */
function LearningsSection({ slug }: { slug: string }) {
  const [items, setItems] = useState<Learning[] | null>(null)
  useEffect(() => {
    let alive = true
    fetch(apiUrl(`/api/agent-learnings/${slug}`))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => alive && setItems(Array.isArray(d) ? (d as Learning[]) : []))
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [slug])

  if (!items || items.length === 0) return null // hide when nothing learned yet
  return (
    <Section label={`🎓 Đã học & tự điều chỉnh (${items.length})`}>
      <ul className={s.learnList}>
        {items.map((l) => (
          <li key={l.id} className={s.learnItem}>
            <div className={s.learnTop}>
              <span className={`${s.learnKind} ${s[`kind_${l.kind}`] ?? ''}`}>{KIND_VI[l.kind] ?? l.kind}</span>
              <span className={s.learnSrc}>· {SRC_VI[l.source] ?? l.source}</span>
              {l.taskId && <span className={s.learnTask}>{l.taskId}</span>}
            </div>
            <div className={s.learnText}>{l.content}</div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * Where this agent actually runs. Provider is a property of the installation, not of
 * the .md — the same persona can be installed into several tools. The scoping line is
 * the consequence that matters: only claude-code enforces the tool allowlist, and
 * scripts/convert.sh provably drops it for most other formats.
 */
function RuntimeSection({ agent }: { agent: Agent }) {
  const { runtime, tools } = agent

  const scoping =
    runtime.scopingConflict
      ? {
          cls: s.noteBad,
          text: `Xung đột: agent khai ${tools.length} tool, nhưng scripts/convert.sh không xuất tools: cho ${runtime.label}. Phân quyền role KHÔNG có hiệu lực trên runtime này.`,
        }
      : runtime.scoping === 'enforced'
        ? {
            cls: s.noteOk,
            text: `${runtime.label} thực thi tools:/disallowedTools: — phân quyền role có hiệu lực.`,
          }
        : runtime.scoping === 'carried'
          ? {
              cls: s.noteWarn,
              text: `${runtime.label} có nhận field tools:, nhưng chưa xác minh nó có thực thi hay không. Đừng dựa vào đây để cách ly quyền.`,
            }
          : {
              cls: s.noteWarn,
              text: `scripts/convert.sh không xuất tools: cho ${runtime.label}. Agent này chưa khai tool nào nên chưa mất gì — nhưng nếu sau này khai thì sẽ không có tác dụng.`,
            }

  return (
    <Section label="Runtime">
      <div className={s.runtimeHead}>
        <span className={s.runtimeMark} style={{ background: runtime.accent }} />
        <span className={s.runtimeName}>{runtime.label}</span>
        <span className={s.runtimeSource}>
          {runtime.assigned ? 'đã gán riêng' : 'mặc định công ty'}
        </span>
      </div>

      <dl className={s.meta}>
        <dt>Provider</dt>
        <dd>{runtime.provider}</dd>
        {runtime.tool === 'claude-code' && (
          <>
            <dt>Model</dt>
            <dd>{runtime.model}</dd>
          </>
        )}
      </dl>

      {runtime.note && <div className={`${s.note} ${s.noteWarn}`}>{runtime.note}</div>}
      <div className={`${s.note} ${scoping.cls}`}>{scoping.text}</div>
    </Section>
  )
}

export function AgentDetailFooter({ agent }: { agent: Agent }) {
  const [state, copy] = useCopy()
  return (
    <>
      <button className={`${s.btn} ${s.btnGhost}`} onClick={() => copy(agent.path)}>
        {state === 'ok' ? '✓ Đã sao chép' : state === 'fail' ? 'Không sao chép được' : 'Sao chép đường dẫn'}
      </button>
      <div className={s.footNote}>
        Hồ sơ nhân sự đọc trực tiếp
        <br />
        từ file .md trong repo
      </div>
    </>
  )
}

export function agentTitle(agent: Agent) {
  return `${agent.emoji ? agent.emoji + '  ' : ''}${agent.name}`
}

export function agentSubtitle(agent: Agent, division?: Division) {
  return `${division?.label ?? agent.division} · ${agent.slug}`
}

/** View + edit an agent's persona (knowledge/skills). Loads the effective body (DB override
    or the repo .md), saves an override that survives redeploy and takes effect on next reply. */
function PersonaEditor({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const [isOverride, setIsOverride] = useState(false)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'revert' | null>(null)
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    fetch(apiUrl(`/api/agents/${slug}/persona`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setBody(d.body ?? '')
          setIsOverride(Boolean(d.isOverride))
          setPath(d.path ?? '')
        } else setErr('Không tải được persona')
      })
      .catch(() => setErr('Cần backend chạy'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [slug])

  async function save() {
    if (busy || !body.trim()) return
    setBusy('save')
    setErr('')
    try {
      const r = await fetch(apiUrl(`/api/agents/${slug}/persona`), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
      })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) onClose()
      else setErr(String(d?.detail || 'Không lưu được'))
    } catch {
      setErr('Cần backend chạy')
    } finally {
      setBusy(null)
    }
  }

  async function revert() {
    if (busy) return
    if (!window.confirm('Khôi phục persona về bản gốc trong repo (.md)? Bản chỉnh sửa sẽ bị bỏ.')) return
    setBusy('revert')
    try {
      const r = await fetch(apiUrl(`/api/agents/${slug}/persona`), { method: 'DELETE' })
      if (r.ok) load()
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div className={pe.overlay} onClick={onClose}>
      <div className={pe.modal} onClick={(e) => e.stopPropagation()}>
        <div className={pe.head}>
          <div className={pe.headText}>
            <span className={pe.title}>Sửa persona · {name}</span>
            <span className={pe.path}>{path}</span>
          </div>
          {isOverride && <span className={pe.badge}>đã chỉnh sửa</span>}
          <button className={pe.close} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={pe.body}>
          {loading ? (
            <div className={pe.loading}>Đang tải…</div>
          ) : (
            <textarea className={pe.textarea} value={body} onChange={(e) => setBody(e.target.value)}
              spellCheck={false} placeholder="Nội dung persona (Markdown)…" />
          )}
          {err && <div className={pe.err}>{err}</div>}
          <div className={pe.note}>
            Chỉnh sửa lưu vào DB (override) — <b>sống qua redeploy</b> và có hiệu lực ở lần trả lời kế tiếp.
            File gốc trong repo không đổi. Bộ nhớ tự học (🎓 Đã học) là cơ chế riêng.
          </div>
        </div>
        <div className={pe.foot}>
          {isOverride && (
            <button className={pe.revert} onClick={revert} disabled={busy !== null}>
              {busy === 'revert' ? '…' : '↺ Khôi phục bản gốc'}
            </button>
          )}
          <button className={pe.cancel} onClick={onClose} disabled={busy !== null}>Đóng</button>
          <button className={pe.save} onClick={save} disabled={busy !== null || loading || !body.trim()}>
            {busy === 'save' ? 'Đang lưu…' : 'Lưu chỉnh sửa'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
