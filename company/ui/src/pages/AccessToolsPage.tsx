import { useCallback, useEffect, useState } from 'react'
import { StatGrid, type Stat } from '../components/StatCard'
import { apiUrl } from '../lib/api'
import s from './AccessToolsPage.module.css'
import p from '../components/Panel.module.css'

interface Perm {
  key: string
  label: string
  description: string | null
  tools: string[]
  highRisk: boolean
  builtin: boolean
  grantedCount: number
  base: boolean
  lead: boolean
  createdBy: string | null
  isBase: boolean
  isLead: boolean
}
interface Data {
  permissions: Perm[]
  baseKeys: string[]
  leadKeys: string[]
}
interface ToolCfg {
  name: string
  label: string
  description: string
  category: string
  status: 'proposed' | 'active' | 'rejected'
  createdBy: string | null
}

const STATUS_STYLE: Record<string, { bg: string; c: string; t: string }> = {
  proposed: { bg: '#fff5e6', c: '#95610c', t: 'chờ duyệt' },
  active: { bg: '#e7f8f0', c: '#149467', t: 'đang bật' },
  rejected: { bg: '#f3f4f8', c: '#8a90a8', t: 'từ chối' },
}

// Access level of an individual tool → badge (who has it by default).
const ACCESS_BADGE: Record<string, { cls: string; label: string }> = {
  everyone: { cls: s.tagBase, label: 'mọi agent' },
  lead: { cls: s.tagBuiltin, label: 'lead' },
  restricted: { cls: s.tagHigh, label: 'hạn chế · cấp riêng' },
  custom: { cls: s.tagCustom, label: 'tuỳ chỉnh' },
}

const URL = apiUrl('/api/permissions')

export function AccessToolsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<Perm | 'new' | null>(null)
  const [toolCfgs, setToolCfgs] = useState<ToolCfg[]>([])
  // The full tool list (built-in + active custom): the permission editor picks from it, and
  // the "Tool riêng lẻ" panel lists it.
  const [toolOptions, setToolOptions] = useState<{ name: string; description?: string; access: string }[]>([])

  const load = useCallback(async () => {
    try {
      const r = await fetch(URL)
      if (!r.ok) return setOnline(false)
      setData((await r.json()) as Data)
      setOnline(true)
      const rt = await fetch(apiUrl('/api/tools'))
      if (rt.ok) {
        const td = await rt.json()
        const custom = (td.custom ?? []) as ToolCfg[]
        setToolCfgs(custom)
        setToolOptions([
          ...((td.builtin ?? []) as { name: string; description?: string; access: string }[]),
          ...custom
            .filter((c) => c.status === 'active')
            .map((c) => ({ name: c.name, description: c.description, access: 'custom' })),
        ])
      }
    } catch {
      setOnline(false)
    }
  }, [])

  async function setToolStatus(name: string, status: string) {
    await fetch(apiUrl(`/api/tools/${name}/status`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    load()
  }
  async function deleteTool(name: string) {
    if (!window.confirm(`Xoá tool "${name}" khỏi danh mục?`)) return
    await fetch(apiUrl(`/api/tools/${name}`), { method: 'DELETE' })
    load()
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 8000)
    return () => clearInterval(id)
  }, [load])

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để quản lý quyền:{' '}
          <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Trang này đọc/ghi{' '}
          <code>/api/permissions</code>.
        </div>
      </div>
    )
  }
  if (!data) return <div className={p.panel}><div className={p.empty}>Đang tải…</div></div>

  const custom = data.permissions.filter((x) => !x.builtin)
  const stats: Stat[] = [
    { label: 'Tổng quyền', value: data.permissions.length, color: '#4E5AE8', icon: 'key',
      foot: <>danh mục quyền/tool của công ty</> },
    { label: 'Quyền lõi', value: data.permissions.length - custom.length, color: '#21C286', icon: 'shield',
      foot: <>builtin — sửa được, không xoá</> },
    { label: 'Tool agent đề xuất', value: toolCfgs.length,
      color: toolCfgs.some((t) => t.status === 'proposed') ? '#F5A93F' : '#8A90A8', icon: 'settings',
      foot: <>{toolCfgs.filter((t) => t.status === 'proposed').length} chờ duyệt · {toolCfgs.filter((t) => t.status === 'active').length} đang bật</> },
  ]

  return (
    <>
      <StatGrid stats={stats} />

      <div className={s.note}>
        Đây là <b>danh mục quyền / access-tools duy nhất</b> của công ty (bảng <code>company.permissions</code>).
        Tab <b>Providers</b> và <b>Tuyển dụng</b> đều tham chiếu tới đây — sửa ở một nơi, áp dụng mọi nơi.
        Phụ trách nghiệp vụ: <b>Access &amp; Tools Administrator</b> 🔑 — agent này cấp/thu quyền cho nhân viên và
        tạo quyền mới (least-privilege); quyền rủi ro cao vẫn phải CEO/CTO duyệt. Xoá một quyền sẽ tự thu hồi
        khỏi mọi agent đang được cấp.
      </div>

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Nhóm quyền (access-tools){' '}
            <span className={p.hint}>· {data.permissions.length} · mỗi dòng là 1 nhóm — bấm ✏️ Sửa để chỉnh tool mở khoá</span>
          </h2>
          <button className={s.addBtn} onClick={() => setEditing('new')}>＋ Thêm nhóm quyền</button>
        </div>

        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Quyền</th>
                <th>Mô tả</th>
                <th>Tools mở khoá</th>
                <th>Đang cấp</th>
                <th>Người tạo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.permissions.map((perm) => (
                <tr key={perm.key}>
                  <td>
                    <div className={s.permName}>
                      {perm.label}
                      {perm.builtin ? <span className={`${s.tag} ${s.tagBuiltin}`}>lõi</span>
                        : <span className={`${s.tag} ${s.tagCustom}`}>tuỳ chỉnh</span>}
                      {perm.highRisk && <span className={`${s.tag} ${s.tagHigh}`}>rủi ro cao</span>}
                      {perm.base && <span className={`${s.tag} ${s.tagBase}`}>mọi agent</span>}
                      {perm.lead && <span className={`${s.tag} ${s.tagBase}`}>lead</span>}
                    </div>
                    <span className={s.key}>{perm.key}</span>
                  </td>
                  <td><div className={s.desc}>{perm.description || '—'}</div></td>
                  <td>
                    {perm.tools.length === 0 ? (
                      <span className={s.toolNone}>không có tool LLM (grant qua orchestrator)</span>
                    ) : (
                      <div className={s.tools}>
                        {perm.tools.map((t) => <span key={t} className={s.toolChip}>{t}</span>)}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className={s.granted}>
                      {perm.grantedCount} agent
                      {perm.base && <div className={s.grantedSub}>+ mọi agent (cơ bản)</div>}
                    </div>
                  </td>
                  <td>
                    <span className={s.key}>{perm.builtin ? 'hệ thống' : perm.createdBy || '—'}</span>
                  </td>
                  <td>
                    <div className={s.rowActions}>
                      <button className={s.iconBtn} onClick={() => setEditing(perm)}>✏️ Sửa</button>
                      <button
                        className={`${s.iconBtn} ${s.iconDanger}`}
                        onClick={() => setEditing(perm)}
                        disabled={perm.builtin}
                        title={perm.builtin ? 'Quyền lõi không xoá được' : 'Sửa/Xoá'}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Tool riêng lẻ (quyền nguyên tử) <span className={p.hint}>· {toolOptions.length}</span>
          </h2>
        </div>
        <div className={s.note} style={{ margin: '0 0 12px' }}>
          Đây là <b>đơn vị quyền nhỏ nhất</b> — mỗi tool là một khả năng. <b>Nhóm quyền</b> ở trên gom nhiều tool lại
          để cấp một lần; còn ở tab <b>Providers</b> bạn cấp <b>từng tool này</b> cho từng agent. Tool <b>built-in</b> là
          code (chỉ xem, không tạo/xoá được ở đây); tool <b>tuỳ chỉnh</b> do agent đề xuất — duyệt ở panel dưới.
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Mô tả</th>
                <th>Thuộc nhóm quyền</th>
              </tr>
            </thead>
            <tbody>
              {toolOptions.map((t) => {
                const groups = data.permissions.filter((pp) => (pp.tools || []).includes(t.name))
                const b = ACCESS_BADGE[t.access] ?? ACCESS_BADGE.custom
                return (
                  <tr key={t.name}>
                    <td>
                      <div className={s.permName}>
                        <span className={s.key}>{t.name}</span>
                        <span className={`${s.tag} ${b.cls}`}>{b.label}</span>
                      </div>
                    </td>
                    <td><div className={s.desc}>{t.description || '—'}</div></td>
                    <td>
                      {groups.length === 0 ? (
                        <span className={s.toolNone}>
                          {t.access === 'everyone' ? 'mọi agent có sẵn' : 'chưa thuộc nhóm nào'}
                        </span>
                      ) : (
                        <div className={s.tools}>
                          {groups.map((g) => <span key={g.key} className={s.toolChip}>{g.label}</span>)}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Tool do agent đề xuất <span className={p.hint}>· {toolCfgs.length}</span>
          </h2>
        </div>
        <div className={s.note} style={{ margin: '0 0 12px' }}>
          Staff agent tự tạo tool bằng công cụ <code>create_tool</code> (lưu ở trạng thái <b>chờ duyệt</b>). Đây là{' '}
          <b>định nghĩa khai báo</b>, KHÔNG phải code chạy tuỳ ý — khi <b>kích hoạt</b>, tool được mời cho agent và mỗi
          lần gọi sẽ được <b>ghi nhận</b> để orchestrator thực thi. Kích hoạt/từ chối tại đây, hoặc để{' '}
          <b>Access &amp; Tools Administrator</b> duyệt (tool <code>set_tool_status</code>).
        </div>
        {toolCfgs.length === 0 ? (
          <div className={p.empty}>Chưa có tool nào do agent đề xuất.</div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Mô tả</th>
                  <th>Người tạo</th>
                  <th>Trạng thái</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {toolCfgs.map((t) => {
                  const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.proposed
                  return (
                    <tr key={t.name}>
                      <td>
                        <div className={s.permName}>
                          {t.label}
                          <span className={`${s.tag} ${s.tagCustom}`}>{t.category}</span>
                        </div>
                        <span className={s.key}>{t.name}</span>
                      </td>
                      <td><div className={s.desc}>{t.description || '—'}</div></td>
                      <td><span className={s.key}>{t.createdBy || '—'}</span></td>
                      <td><span className={s.tag} style={{ background: st.bg, color: st.c }}>{st.t}</span></td>
                      <td>
                        <div className={s.rowActions}>
                          {t.status === 'proposed' && (
                            <>
                              <button className={s.iconBtn} onClick={() => setToolStatus(t.name, 'active')}>✓ Kích hoạt</button>
                              <button className={s.iconBtn} onClick={() => setToolStatus(t.name, 'rejected')}>✕ Từ chối</button>
                            </>
                          )}
                          {t.status === 'active' && (
                            <button className={s.iconBtn} onClick={() => setToolStatus(t.name, 'proposed')}>Tạm ngưng</button>
                          )}
                          {t.status === 'rejected' && (
                            <button className={s.iconBtn} onClick={() => setToolStatus(t.name, 'proposed')}>Khôi phục</button>
                          )}
                          <button className={`${s.iconBtn} ${s.iconDanger}`} onClick={() => deleteTool(t.name)} title="Xoá">🗑</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <PermEditor
          perm={editing === 'new' ? null : editing}
          toolOptions={toolOptions}
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

function PermEditor({
  perm,
  toolOptions,
  onClose,
  onSaved,
}: {
  perm: Perm | null
  toolOptions: { name: string; description?: string }[]
  onClose: () => void
  onSaved: () => void
}) {
  const [key, setKey] = useState(perm?.key ?? '')
  const [label, setLabel] = useState(perm?.label ?? '')
  const [description, setDescription] = useState(perm?.description ?? '')
  const [tools, setTools] = useState<Set<string>>(() => new Set(perm?.tools ?? []))
  const [highRisk, setHighRisk] = useState(perm?.highRisk ?? false)
  const [isBase, setIsBase] = useState(perm?.isBase ?? false)
  const [isLead, setIsLead] = useState(perm?.isLead ?? false)
  const toggleTool = (t: string) =>
    setTools((prev) => {
      const n = new Set(prev)
      n.has(t) ? n.delete(t) : n.add(t)
      return n
    })
  // Any tools the perm already lists that aren't in the known catalog (e.g. a not-yet-built
  // tool) — keep them selectable so editing doesn't silently drop them.
  const knownNames = new Set(toolOptions.map((t) => t.name))
  const extraTools = [...tools].filter((t) => !knownNames.has(t))
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null)
  const [err, setErr] = useState('')

  async function save() {
    if (!label.trim() || busy) return
    if (!perm && !/^[a-z][a-z0-9_]{1,39}$/.test(key.trim())) {
      setErr('Key phải chữ thường/số/gạch dưới, bắt đầu bằng chữ (2–40 ký tự)')
      return
    }
    setBusy('save')
    setErr('')
    const body = {
      key: key.trim(),
      label: label.trim(),
      description: description.trim(),
      tools: [...tools],
      highRisk,
      isBase,
      isLead,
    }
    const url = perm ? apiUrl(`/api/permissions/${perm.key}`) : apiUrl('/api/permissions')
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
    if (!perm || perm.builtin || busy) return
    if (!window.confirm(`Xoá quyền "${perm.label}" (${perm.key})? Thu hồi khỏi ${perm.grantedCount} agent.`)) return
    setBusy('delete')
    try {
      const r = await fetch(apiUrl(`/api/permissions/${perm.key}`), { method: 'DELETE' })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) onSaved()
      else setErr(String(d?.detail || 'Không xoá được'))
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
          <span className={s.modalTitle}>{perm ? `Sửa quyền · ${perm.key}` : 'Thêm quyền mới'}</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>

        <div className={s.modalBody}>
          {!perm && (
            <label className={s.field}>
              <span className={s.flabel}>Key (định danh, không đổi sau khi tạo)</span>
              <input
                className={`${s.input} ${s.mono}`}
                placeholder="vd: export_report"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus
              />
            </label>
          )}
          <label className={s.field}>
            <span className={s.flabel}>Nhãn</span>
            <input className={s.input} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus={!!perm} />
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Mô tả</span>
            <input className={s.input} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Tools mở khoá ({tools.size})</span>
            <div className={s.toolPicker}>
              {toolOptions.map((t) => (
                <label key={t.name} className={s.toolPick} title={t.description || ''}>
                  <input type="checkbox" checked={tools.has(t.name)} onChange={() => toggleTool(t.name)} />
                  <span className={s.mono}>{t.name}</span>
                </label>
              ))}
              {extraTools.map((t) => (
                <label key={t} className={s.toolPick} title="chưa có trong danh mục tool">
                  <input type="checkbox" checked onChange={() => toggleTool(t)} />
                  <span className={s.mono}>{t}</span>
                  <span className={s.toolExtra}>chưa hiện thực</span>
                </label>
              ))}
            </div>
            <span className={s.fieldHint}>
              Tick các tool mà nhóm quyền này mở khoá. Không tick tool nào = quyền ghi nhận, thực thi qua
              orchestrator (như hire_agent / write_file), không có tool LLM.
            </span>
          </label>
          <div className={s.field}>
            <span className={s.flabel}>Tuỳ chọn</span>
            <table className={s.optTable}>
              <tbody>
                <tr className={s.optRow} onClick={() => setHighRisk(!highRisk)}>
                  <td className={s.optChk}><input type="checkbox" checked={highRisk} readOnly /></td>
                  <td className={s.optName}>Rủi ro cao</td>
                  <td className={s.optDesc}>
                    Hiện chip đỏ ở cột Access Tools + form tuyển dụng; quyền rủi ro cao chỉ CEO/CTO mới cấp được.
                  </td>
                </tr>
                <tr className={s.optRow} onClick={() => setIsBase(!isBase)}>
                  <td className={s.optChk}><input type="checkbox" checked={isBase} readOnly /></td>
                  <td className={s.optName}>Cơ bản (mọi agent)</td>
                  <td className={s.optDesc}>
                    Bật thì <b>MỌI agent tự động có</b> nhóm quyền này + toàn bộ tool nó mở khoá, không cần cấp riêng.
                  </td>
                </tr>
                <tr className={s.optRow} onClick={() => setIsLead(!isLead)}>
                  <td className={s.optChk}><input type="checkbox" checked={isLead} readOnly /></td>
                  <td className={s.optName}>Lead (mọi lead)</td>
                  <td className={s.optDesc}>
                    Bật thì <b>MỌI lead</b> (Ban lãnh đạo/quản lý) <b>tự động có</b> nhóm quyền + tool này.
                  </td>
                </tr>
                {perm && (
                  <tr className={s.optInfo}>
                    <td className={s.optChk}><input type="checkbox" checked={perm.builtin} disabled /></td>
                    <td className={s.optName}>{perm.builtin ? 'Lõi (hệ thống)' : 'Tuỳ chỉnh'}</td>
                    <td className={s.optDesc}>
                      {perm.builtin
                        ? 'Nhóm hệ thống — chỉ SỬA được, không xoá. (Không đổi được thành tuỳ chỉnh.)'
                        : 'Nhóm do bạn tạo — sửa/xoá thoải mái.'}{' '}
                      Đây là trạng thái tự động, không phải tuỳ chọn.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {err && <div className={s.err}>{err}</div>}
        </div>

        <div className={s.modalFoot}>
          {perm && !perm.builtin && (
            <button className={s.cancel} onClick={remove} disabled={busy !== null} style={{ marginLeft: 0, color: '#d93463' }}>
              {busy === 'delete' ? 'Đang xoá…' : '🗑 Xoá quyền'}
            </button>
          )}
          <button className={s.cancel} onClick={onClose} disabled={busy !== null}>Huỷ</button>
          <button className={s.save} onClick={save} disabled={busy !== null || !label.trim()}>
            {busy === 'save' ? 'Đang lưu…' : perm ? 'Lưu thay đổi' : 'Tạo quyền'}
          </button>
        </div>
      </div>
    </div>
  )
}
