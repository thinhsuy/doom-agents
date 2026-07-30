import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocFile, DocFormat, DocsData } from '../types'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import { Icon } from '../components/Icon'
import s from './DocumentsPage.module.css'
import p from '../components/Panel.module.css'

const DOCS_URL = apiUrl('/api/docs')
const COLLAPSE_KEY = 'docs.collapsed'

function time(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const FMT_LABEL: Record<string, string> = {
  markdown: 'MD', mermaid: 'Mermaid', ppt: 'PPT', text: 'TXT',
  json: 'JSON', code: 'CODE', csv: 'CSV', html: 'HTML',
}
const FORMATS: DocFormat[] = ['markdown', 'mermaid', 'ppt', 'text', 'json', 'code', 'csv', 'html']

// file extension → doc format (upload is text-based; binary files aren't supported).
const EXT_FMT: Record<string, DocFormat> = {
  md: 'markdown', markdown: 'markdown', mmd: 'mermaid', mermaid: 'mermaid',
  json: 'json', csv: 'csv', html: 'html', htm: 'html', txt: 'text',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', sql: 'code',
  sh: 'code', yml: 'code', yaml: 'code', go: 'code', rs: 'code', java: 'code',
}
// doc format → download extension (used when the doc name carries none).
const FMT_EXT: Record<DocFormat, string> = {
  markdown: 'md', mermaid: 'mmd', ppt: 'txt', text: 'txt', json: 'json', code: 'txt', csv: 'csv', html: 'html',
}
const UPLOAD_ACCEPT = '.md,.markdown,.mmd,.mermaid,.txt,.json,.csv,.html,.htm,.js,.ts,.tsx,.jsx,.py,.sql,.sh,.yml,.yaml,.go,.rs,.java'

/** Download a document's text content to the device, keeping its extension. */
function downloadDoc(doc: DocFile) {
  const fname = /\.[a-z0-9]+$/i.test(doc.name) ? doc.name : `${doc.name}.${FMT_EXT[doc.format] ?? 'txt'}`
  const url = URL.createObjectURL(new Blob([doc.content], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fname
  a.click()
  URL.revokeObjectURL(url)
}

interface Draft {
  id?: number
  folder: string
  name: string
  format: DocFormat
  content: string
}

// ---- nested folder tree from flat folder paths --------------------------------
interface TreeNode {
  name: string       // this segment
  path: string       // full path from root
  children: TreeNode[]
  files: DocFile[]
}

function buildTree(folders: string[], files: DocFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], files: [] }
  const nodeAt = (path: string): TreeNode => {
    if (!path) return root
    let cur = root
    let acc = ''
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      let child = cur.children.find((c) => c.name === part)
      if (!child) {
        child = { name: part, path: acc, children: [], files: [] }
        cur.children.push(child)
      }
      cur = child
    }
    return cur
  }
  for (const f of folders) nodeAt(f)
  for (const file of files) nodeAt(file.folder).files.push(file)
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.files.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

export function DocumentsPage() {
  const [data, setData] = useState<DocsData>({ folders: [], files: [] })
  const [online, setOnline] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<Draft | null>(null)
  const [moving, setMoving] = useState<DocFile | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'))
    } catch {
      return new Set()
    }
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const { id } = useParams()
  const navigate = useNavigate()
  // A chat doc-link opens /workspace/docs?path=<folder/name>; resolve it to the doc's id.
  const [params] = useSearchParams()
  const pathParam = params.get('path')

  const load = useCallback(async () => {
    try {
      const r = await fetch(DOCS_URL)
      if (!r.ok) return setOnline(false)
      const d = await r.json()
      if (d && Array.isArray(d.files)) {
        setData(d as DocsData)
        setOnline(true)
      }
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const allFolders = useMemo(() => {
    const set = new Set<string>()
    for (const f of data.folders) set.add(f.path)
    for (const f of data.files) set.add(f.folder)
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b))
  }, [data])

  const tree = useMemo(() => buildTree(allFolders, data.files), [allFolders, data.files])

  // Search: when a query is present, show a FLAT list of matching files instead of the tree.
  const matches = useMemo(() => {
    const qq = query.trim().toLowerCase()
    if (!qq) return null
    return data.files
      .filter((f) => f.name.toLowerCase().includes(qq) || f.folder.toLowerCase().includes(qq) || f.content.toLowerCase().includes(qq))
      .sort((a, b) => (a.folder + a.name).localeCompare(b.folder + b.name))
  }, [query, data.files])

  const active = useMemo(() => data.files.find((f) => String(f.id) === id), [data.files, id])

  // Resolve ?path=folder/name → the doc id, then redirect to the id-based view.
  const byPath = useMemo(
    () => (pathParam ? data.files.find((f) => `${f.folder}/${f.name}` === pathParam) : undefined),
    [pathParam, data.files],
  )
  useEffect(() => {
    if (byPath && String(byPath.id) !== id) navigate(`/workspace/docs/${byPath.id}`, { replace: true })
  }, [byPath, id, navigate])
  const pathUnresolved = Boolean(pathParam && !id && data.files.length > 0 && !byPath)

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      return next
    })
  }, [])

  async function del(doc: DocFile) {
    if (!window.confirm(`Xoá tài liệu "${doc.folder}/${doc.name}"? Không thể hoàn tác.`)) return
    try {
      const r = await fetch(apiUrl(`/api/docs/${doc.id}`), { method: 'DELETE' })
      if (r.ok) {
        await load()
        navigate('/workspace/docs')
      }
    } catch {
      /* offline */
    }
  }

  // ---- folder CRUD (calls the new /api/doc-folders endpoints) ----
  async function createFolder() {
    const path = window.prompt('Tên thư mục mới (vd: Dự án X/specs):', '')?.trim()
    if (!path) return
    try {
      const r = await fetch(apiUrl('/api/doc-folders'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
      })
      if (!r.ok) window.alert((await r.json().catch(() => null))?.detail || 'Không tạo được thư mục')
      await load()
    } catch {
      window.alert('Cần backend chạy')
    }
  }

  async function renameFolder(path: string) {
    const newPath = window.prompt('Đổi tên / di chuyển thư mục:', path)?.trim()
    if (!newPath || newPath === path) return
    try {
      const r = await fetch(apiUrl('/api/doc-folders'), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, newPath }),
      })
      if (!r.ok) window.alert((await r.json().catch(() => null))?.detail || 'Không đổi tên được')
      await load()
      if (active && (active.folder === path || active.folder.startsWith(path + '/'))) navigate('/workspace/docs')
    } catch {
      window.alert('Cần backend chạy')
    }
  }

  async function deleteFolder(path: string) {
    const n = data.files.filter((f) => f.folder === path || f.folder.startsWith(path + '/')).length
    if (!window.confirm(`Xoá thư mục "${path}"${n ? ` và ${n} tài liệu bên trong` : ''}? Không thể hoàn tác.`)) return
    try {
      await fetch(apiUrl('/api/doc-folders'), {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
      })
      await load()
      navigate('/workspace/docs')
    } catch {
      window.alert('Cần backend chạy')
    }
  }

  async function moveDoc(doc: DocFile, folder: string) {
    const dest = folder.trim().replace(/^\/+|\/+$/g, '')
    if (!dest || dest === doc.folder) return setMoving(null)
    try {
      const r = await fetch(apiUrl(`/api/docs/${doc.id}`), {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder: dest, name: doc.name }),
      })
      if (!r.ok) window.alert((await r.json().catch(() => null))?.detail || 'Không di chuyển được')
      setMoving(null)
      await load()
    } catch {
      window.alert('Cần backend chạy')
    }
  }

  function onUploadFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const ext = (file.name.split('.').pop() || '').toLowerCase()
      setEditing({
        folder: 'Tải lên',
        name: file.name,
        format: EXT_FMT[ext] ?? 'text',
        content: String(reader.result ?? ''),
      })
    }
    reader.readAsText(file)
  }

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để xem tài liệu: <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>.
          Trang này đọc/ghi <code>/api/docs</code> (company.documents).
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={s.note}>
        <Icon name="info" size={16} />
        <span>
          <b>Kho tài liệu công ty.</b> Agent làm việc theo nguyên tắc <b>document-first, implement-second</b> —
          mọi việc đều được viết tài liệu (mặc định Markdown) để agent khác đọc &amp; follow. Với tư cách
          CEO/CTO bạn có thể <b>tạo thư mục, đổi tên, di chuyển, tải lên/xuống, sửa, xoá</b> tài liệu;
          agent cũng ghi qua tool <code>write_doc</code>.
        </span>
      </div>
      <div className={s.wrap}>
        <div className={s.rail}>
          <div className={s.railHead}>
            <span>Thư mục · {data.files.length} tài liệu</span>
            <div className={s.railActions}>
              <button className={s.railBtn} onClick={createFolder} title="Tạo thư mục mới">🗂 Thư mục</button>
              <button className={s.railBtn} onClick={() => fileRef.current?.click()} title="Tải tài liệu lên từ thiết bị">
                ⬆ Tải lên
              </button>
              <button
                className={s.railBtn}
                onClick={() => setEditing({ folder: '', name: '', format: 'markdown', content: '' })}
                title="Tạo tài liệu mới"
              >
                ＋ Mới
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onUploadFile(f)
                e.target.value = '' // allow re-upload of the same file
              }}
            />
          </div>
          <div className={s.searchRow}>
            <Icon name="search" size={13} />
            <input
              className={s.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tài liệu (tên · thư mục · nội dung)…"
            />
            {query && <button className={s.searchClear} onClick={() => setQuery('')} title="Xoá tìm kiếm">✕</button>}
          </div>
          <div className={s.railScroll}>
            {matches ? (
              matches.length === 0 ? (
                <div className={s.railEmpty}>Không có tài liệu khớp “{query}”.</div>
              ) : (
                matches.map((f) => (
                  <button
                    key={f.id}
                    className={String(f.id) === id ? `${s.file} ${s.fileActive}` : s.file}
                    style={{ paddingLeft: 16 }}
                    onClick={() => navigate(`/workspace/docs/${f.id}`)}
                    title={`${f.folder}/${f.name}`}
                  >
                    <Icon name="file" size={13} />
                    <span className={s.fileName}>
                      {f.name} <span className={s.matchFolder}>· {f.folder}</span>
                    </span>
                    <span className={s.fmt}>{FMT_LABEL[f.format] ?? f.format}</span>
                  </button>
                ))
              )
            ) : tree.children.length === 0 ? (
              <div className={s.railEmpty}>Chưa có tài liệu nào.</div>
            ) : (
              tree.children.map((node) => (
                <FolderNode
                  key={node.path}
                  node={node}
                  depth={0}
                  activeId={id}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  onOpenFile={(fid) => navigate(`/workspace/docs/${fid}`)}
                  onNewDoc={(folder) => setEditing({ folder, name: '', format: 'markdown', content: '' })}
                  onRenameFolder={renameFolder}
                  onDeleteFolder={deleteFolder}
                />
              ))
            )}
          </div>
        </div>

        <div className={s.viewer}>
          {active ? (
            <DocView
              doc={active}
              onEdit={() => setEditing({ ...active })}
              onDelete={() => del(active)}
              onMove={() => setMoving(active)}
              onDownload={() => downloadDoc(active)}
            />
          ) : (
            <div className={s.pickHint}>
              {pathUnresolved
                ? `Không tìm thấy tài liệu “${pathParam}” — có thể đã bị đổi tên/xoá hoặc chưa được đồng bộ.`
                : data.files.length === 0
                  ? 'Chưa có tài liệu — tạo mới, tải lên, hoặc agent sẽ viết vào đây khi làm việc.'
                  : 'Chọn một tài liệu bên trái để đọc.'}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <DocEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={async (savedId) => {
            setEditing(null)
            await load()
            if (savedId) navigate(`/workspace/docs/${savedId}`)
          }}
        />
      )}

      {moving && (
        <MoveDoc doc={moving} folders={allFolders} onClose={() => setMoving(null)} onMove={(dest) => moveDoc(moving, dest)} />
      )}
    </>
  )
}

// ---- one folder node (recursive) ---------------------------------------------
function FolderNode({
  node,
  depth,
  activeId,
  collapsed,
  onToggle,
  onOpenFile,
  onNewDoc,
  onRenameFolder,
  onDeleteFolder,
}: {
  node: TreeNode
  depth: number
  activeId?: string
  collapsed: Set<string>
  onToggle: (path: string) => void
  onOpenFile: (id: number) => void
  onNewDoc: (folder: string) => void
  onRenameFolder: (path: string) => void
  onDeleteFolder: (path: string) => void
}) {
  const isOpen = !collapsed.has(node.path)
  const indent = 8 + depth * 13
  return (
    <div className={s.folderBlock}>
      <div className={s.folderRow} style={{ paddingLeft: indent }} title={node.path}>
        <button className={s.folderName} onClick={() => onToggle(node.path)}>
          <span className={isOpen ? `${s.chev} ${s.chevOpen}` : s.chev}>▸</span>
          <Icon name="layout" size={13} />
          <span className={s.folderLabel}>{node.name}</span>
        </button>
        <div className={s.folderActions}>
          <button className={s.fAct} title="Tài liệu mới trong thư mục này" onClick={() => onNewDoc(node.path)}>＋</button>
          <button className={s.fAct} title="Đổi tên / di chuyển thư mục" onClick={() => onRenameFolder(node.path)}>✎</button>
          <button className={`${s.fAct} ${s.fActDanger}`} title="Xoá thư mục" onClick={() => onDeleteFolder(node.path)}>🗑</button>
        </div>
      </div>
      {isOpen && (
        <>
          {node.children.map((child) => (
            <FolderNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onNewDoc={onNewDoc}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
          {node.files.length === 0 && node.children.length === 0 ? (
            <div className={s.fileEmpty} style={{ paddingLeft: indent + 16 }}>(trống)</div>
          ) : (
            node.files.map((f) => (
              <button
                key={f.id}
                className={String(f.id) === activeId ? `${s.file} ${s.fileActive}` : s.file}
                style={{ paddingLeft: indent + 18 }}
                onClick={() => onOpenFile(f.id)}
                title={f.name}
              >
                <Icon name="file" size={13} />
                <span className={s.fileName}>{f.name}</span>
                <span className={s.fmt}>{FMT_LABEL[f.format] ?? f.format}</span>
              </button>
            ))
          )}
        </>
      )}
    </div>
  )
}

function DocView({
  doc,
  onEdit,
  onDelete,
  onMove,
  onDownload,
}: {
  doc: DocFile
  onEdit: () => void
  onDelete: () => void
  onMove: () => void
  onDownload: () => void
}) {
  const who = agentDisplay(doc.author)
  return (
    <>
      <div className={s.viewerHead}>
        <div className={s.viewerTitle}>{doc.name}</div>
        <div className={s.viewerMeta}>
          <span className={s.crumb}>{doc.folder}</span>
          <span className={s.fmtBig}>{FMT_LABEL[doc.format] ?? doc.format}</span>
          {doc.author && (
            <span className={s.by}>
              <span className={s.byEmoji}>{who.emoji}</span> {who.name}
            </span>
          )}
          <span className={s.upd}>cập nhật {time(doc.updatedAt)}</span>
          <div className={s.viewerActions}>
            <button className={s.docBtn} onClick={onDownload} title="Tải tài liệu về máy">⬇ Tải</button>
            <button className={s.docBtn} onClick={onMove} title="Di chuyển sang thư mục khác">📁 Di chuyển</button>
            <button className={s.docBtn} onClick={onEdit}>✏️ Sửa</button>
            <button className={`${s.docBtn} ${s.docBtnDanger}`} onClick={onDelete}>🗑 Xoá</button>
          </div>
        </div>
      </div>
      <div className={s.viewerBody}>
        {doc.format === 'markdown' ? (
          <div className={s.md}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className={s.raw}>{doc.content}</pre>
        )}
      </div>
    </>
  )
}

// ---- move a document to another folder ---------------------------------------
function MoveDoc({
  doc,
  folders,
  onClose,
  onMove,
}: {
  doc: DocFile
  folders: string[]
  onClose: () => void
  onMove: (dest: string) => void
}) {
  const [dest, setDest] = useState(doc.folder)
  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.modalTitle}>Di chuyển “{doc.name}”</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={s.modalBody}>
          <label className={s.field}>
            <span className={s.flabel}>Thư mục đích</span>
            <input
              className={s.input}
              list="doc-folders"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="chọn hoặc gõ thư mục mới"
              autoFocus
            />
            <datalist id="doc-folders">
              {folders.map((f) => <option key={f} value={f} />)}
            </datalist>
          </label>
        </div>
        <div className={s.modalFoot}>
          <button className={s.cancel} onClick={onClose}>Huỷ</button>
          <button className={s.save} onClick={() => onMove(dest)} disabled={!dest.trim() || dest.trim() === doc.folder}>
            Di chuyển
          </button>
        </div>
      </div>
    </div>
  )
}

function DocEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: Draft
  onClose: () => void
  onSaved: (id?: number) => void
}) {
  const [folder, setFolder] = useState(draft.folder)
  const [name, setName] = useState(draft.name)
  const [format, setFormat] = useState<DocFormat>(draft.format)
  const [content, setContent] = useState(draft.content)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isEdit = draft.id != null

  async function save() {
    if (!folder.trim() || !name.trim() || busy) return
    setBusy(true)
    setErr('')
    const body = { folder: folder.trim(), name: name.trim(), format, content }
    try {
      const r = isEdit
        ? await fetch(apiUrl(`/api/docs/${draft.id}`), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch(apiUrl('/api/docs'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) onSaved(d.id ?? draft.id)
      else setErr(String(d?.detail || 'Không lưu được'))
    } catch {
      setErr('Cần backend chạy')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.modalTitle}>{isEdit ? `Sửa tài liệu` : 'Tài liệu mới'}</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={s.modalBody}>
          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.flabel}>Thư mục</span>
              <input className={s.input} value={folder} onChange={(e) => setFolder(e.target.value)}
                placeholder="vd: Dự án X/specs" autoFocus={!isEdit} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Tên file</span>
              <input className={s.input} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="vd: kien-truc.md" />
            </label>
          </div>
          <label className={s.field}>
            <span className={s.flabel}>Định dạng</span>
            <select className={s.input} value={format} onChange={(e) => setFormat(e.target.value as DocFormat)}>
              {FORMATS.map((f) => <option key={f} value={f}>{FMT_LABEL[f]} · {f}</option>)}
            </select>
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Nội dung</span>
            <textarea className={s.editArea} value={content} onChange={(e) => setContent(e.target.value)}
              placeholder="Nội dung tài liệu…" spellCheck={false} />
          </label>
          {err && <div className={s.err}>{err}</div>}
        </div>
        <div className={s.modalFoot}>
          <button className={s.cancel} onClick={onClose} disabled={busy}>Huỷ</button>
          <button className={s.save} onClick={save} disabled={busy || !folder.trim() || !name.trim()}>
            {busy ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo tài liệu'}
          </button>
        </div>
      </div>
    </div>
  )
}
