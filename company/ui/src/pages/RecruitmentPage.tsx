import { useCallback, useEffect, useMemo, useState } from 'react'
import { StatGrid, type Stat } from '../components/StatCard'
import { apiUrl } from '../lib/api'
import s from './RecruitmentPage.module.css'
import p from '../components/Panel.module.css'

interface Perm {
  key: string
  label: string
}
interface RequestedPerm {
  key: string
  label: string
  why?: string
}
interface ModelInfo {
  id: string
  label: string
}
interface ProviderInfo {
  id: string
  label: string
  models: ModelInfo[]
}
interface Candidate {
  id: string
  sourceSlug: string | null
  name: string
  division: string
  hireGroup: string | null
  brief: string | null
  skills: string[]
  provider: string
  model: string
  requestedPermissions: RequestedPerm[]
  grantedPermissions: string[]
  proposedBy: string | null
  status: 'proposed' | 'approved' | 'rejected'
  decidedAt: string | null
}
interface RecruitmentData {
  candidates: Candidate[]
  permissions: Perm[]
  providers: ProviderInfo[]
}

const URL = apiUrl('/api/recruitment')

export function RecruitmentPage() {
  const [data, setData] = useState<RecruitmentData | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(URL)
      if (!r.ok) return setOnline(false)
      setData((await r.json()) as RecruitmentData)
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để duyệt tuyển dụng:{' '}
          <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Trang này đọc/ghi{' '}
          <code>/api/recruitment</code>.
        </div>
      </div>
    )
  }
  if (!data) return <div className={p.panel}><div className={p.empty}>Đang tải…</div></div>

  const proposed = data.candidates.filter((c) => c.status === 'proposed')
  const approved = data.candidates.filter((c) => c.status === 'approved')
  const done = data.candidates.filter((c) => c.status !== 'proposed')
  const providerLabel = (id: string) => data.providers.find((x) => x.id === id)?.label ?? id
  const open = proposed.find((c) => c.id === openId) ?? null

  const stats: Stat[] = [
    { label: 'Chờ duyệt', value: proposed.length, color: '#F5A93F', icon: 'clock',
      foot: <>ứng viên TAL đề xuất</> },
    { label: 'Đã tuyển', value: approved.length, color: '#21C286', icon: 'checkSquare',
      foot: <>vào biên chế + cấp quyền</> },
    { label: 'Tổng ứng viên', value: data.candidates.length, color: '#4E5AE8', icon: 'users',
      foot: <>trong pipeline tuyển dụng</> },
  ]

  return (
    <>
      <StatGrid stats={stats} />

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Ứng viên chờ duyệt <span className={p.hint}>· {proposed.length}</span>
          </h2>
        </div>
        {proposed.length === 0 ? (
          <div className={p.empty}>Chưa có ứng viên nào chờ duyệt. TAL sẽ đề xuất ứng viên vào đây.</div>
        ) : (
          <div className={s.cards}>
            {proposed.map((c) => (
              <CandidateSummary key={c.id} c={c} providerLabel={providerLabel} onOpen={() => setOpenId(c.id)} />
            ))}
          </div>
        )}
      </div>

      {done.length > 0 && (
        <div className={p.panel}>
          <div className={p.head}>
            <h2 className={p.title}>
              Đã xử lý <span className={p.hint}>· {done.length}</span>
            </h2>
          </div>
          <div className={s.doneList}>
            {done.map((c) => (
              <div key={c.id} className={s.doneRow}>
                <span className={c.status === 'approved' ? s.badgeOk : s.badgeNo}>
                  {c.status === 'approved' ? '✓ Đã tuyển' : '✕ Từ chối'}
                </span>
                <span className={s.doneName}>{c.name}</span>
                <span className={s.doneDiv}>{c.division}</span>
                {c.status === 'approved' && c.grantedPermissions.length > 0 && (
                  <span className={s.donePerms}>{c.grantedPermissions.length} quyền</span>
                )}
                <span className={s.doneAt}>{c.decidedAt}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {open && (
        <CandidateModal
          c={open}
          perms={data.permissions}
          providers={data.providers}
          onClose={() => setOpenId(null)}
          onDone={() => {
            setOpenId(null)
            load()
          }}
        />
      )}
    </>
  )
}

/** Compact summary card — click to open the full review popup. */
function CandidateSummary({
  c,
  providerLabel,
  onOpen,
}: {
  c: Candidate
  providerLabel: (id: string) => string
  onOpen: () => void
}) {
  return (
    <button className={s.sumCard} onClick={onOpen}>
      <div className={s.sumHead}>
        <span className={s.cid}>{c.id}</span>
        <span className={s.sumName}>{c.name}</span>
        {c.sourceSlug ? (
          <span className={s.srcTag} title="Có sẵn trong catalogue">📁 catalogue</span>
        ) : (
          <span className={s.newTag}>✨ persona mới</span>
        )}
      </div>
      {c.proposedBy && <div className={s.by}>Đề xuất bởi {c.proposedBy}</div>}
      {c.brief && <div className={s.sumBrief}>{c.brief}</div>}
      <div className={s.sumChips}>
        <span className={s.chip}>🏢 {c.division}{c.hireGroup ? ` · ${c.hireGroup}` : ''}</span>
        <span className={s.chip}>🤖 {providerLabel(c.provider)}</span>
        {c.skills.length > 0 && <span className={s.chip}>🛠 {c.skills.length} kỹ năng</span>}
        {c.requestedPermissions.length > 0 && (
          <span className={`${s.chip} ${s.chipReq}`}>🔑 {c.requestedPermissions.length} quyền đề xuất</span>
        )}
      </div>
      <div className={s.sumHint}>Bấm để xem đầy đủ &amp; duyệt →</div>
    </button>
  )
}

/** Full review popup: edit every field, tick permissions, approve/reject. */
function CandidateModal({
  c,
  perms,
  providers,
  onClose,
  onDone,
}: {
  c: Candidate
  perms: Perm[]
  providers: ProviderInfo[]
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(c.name)
  const [division, setDivision] = useState(c.division)
  const [group, setGroup] = useState(c.hireGroup ?? '')
  const [brief, setBrief] = useState(c.brief ?? '')
  const [skills, setSkills] = useState(c.skills.join(', '))
  const [provider, setProvider] = useState(c.provider)
  const [model, setModel] = useState(c.model)
  // Permissions pre-ticked with what TAL requested, so the owner just confirms/edits.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(c.requestedPermissions.map((r) => r.key)),
  )
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [err, setErr] = useState('')

  const requestedBy = useMemo(
    () => new Map(c.requestedPermissions.map((r) => [r.key, r.why])),
    [c.requestedPermissions],
  )
  const models = providers.find((x) => x.id === provider)?.models ?? []

  const toggle = (k: string) =>
    setChecked((prev) => {
      const n = new Set(prev)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  async function approve() {
    if (busy) return
    setBusy('approve')
    setErr('')
    try {
      const r = await fetch(apiUrl(`/api/recruitment/${c.id}/approve`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          division,
          hireGroup: group,
          brief,
          skills: skills.split(',').map((x) => x.trim()).filter(Boolean),
          provider,
          model,
          grantedPermissions: [...checked],
        }),
      })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) onDone()
      else setErr(String(d?.detail || 'Không tuyển được'))
    } catch {
      setErr('Cần backend chạy')
    } finally {
      setBusy(null)
    }
  }

  async function reject() {
    if (busy) return
    setBusy('reject')
    try {
      const r = await fetch(apiUrl(`/api/recruitment/${c.id}/reject`), { method: 'POST' })
      if (r.ok) onDone()
    } catch {
      /* offline */
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.cid}>{c.id}</span>
          <span className={s.modalTitle}>{name || 'Ứng viên'}</span>
          {c.sourceSlug ? (
            <span className={s.srcTag} title="Có sẵn trong catalogue">📁 {c.sourceSlug}</span>
          ) : (
            <span className={s.newTag} title="Persona mới — cần orchestrator tạo file">✨ persona mới</span>
          )}
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={s.modalBody}>
          {c.proposedBy && <div className={s.by}>Đề xuất bởi {c.proposedBy}</div>}

          <label className={s.field}>
            <span className={s.flabel}>Tên hiển thị</span>
            <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className={s.field}>
            <span className={s.flabel}>Mô tả / persona</span>
            <textarea className={s.brief} value={brief} onChange={(e) => setBrief(e.target.value)} rows={6} />
          </label>

          <label className={s.field}>
            <span className={s.flabel}>Kỹ năng (phân tách bằng dấu phẩy)</span>
            <input className={s.input} value={skills} onChange={(e) => setSkills(e.target.value)} />
          </label>

          <div className={s.grid3}>
            <label className={s.field}>
              <span className={s.flabel}>Phòng ban</span>
              <input className={s.input} value={division} onChange={(e) => setDivision(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Ban / nhóm</span>
              <input className={s.input} value={group} onChange={(e) => setGroup(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Provider</span>
              <select
                className={s.input}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value)
                  setModel(providers.find((x) => x.id === e.target.value)?.models[0]?.id ?? '')
                }}
              >
                {providers.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.label}</option>
                ))}
              </select>
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Model</span>
              <select className={s.input} value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className={s.field}>
            <span className={s.flabel}>Quyền cấp cho agent (TAL đề xuất các mục ✓ sẵn — tick để cấp)</span>
            <div className={s.perms}>
              {perms.map((perm) => {
                const why = requestedBy.get(perm.key)
                return (
                  <label key={perm.key} className={checked.has(perm.key) ? `${s.perm} ${s.permOn}` : s.perm}>
                    <input type="checkbox" checked={checked.has(perm.key)} onChange={() => toggle(perm.key)} />
                    <span className={s.permBody}>
                      <span className={s.permLabel}>
                        {perm.label}
                        {requestedBy.has(perm.key) && <span className={s.permReq}>TAL đề xuất</span>}
                      </span>
                      {why && <span className={s.permWhy}>{why}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {err && <div className={s.err}>{err}</div>}
        </div>
        <div className={s.modalFoot}>
          <button className={s.reject} onClick={reject} disabled={busy !== null}>
            {busy === 'reject' ? '…' : '✕ Từ chối'}
          </button>
          <button className={s.approve} onClick={approve} disabled={busy !== null || !name.trim()}>
            {busy === 'approve' ? 'Đang tuyển…' : '✓ Duyệt & tuyển vào công ty'}
          </button>
        </div>
      </div>
    </div>
  )
}
