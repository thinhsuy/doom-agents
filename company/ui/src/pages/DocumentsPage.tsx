import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocFile, DocsData } from '../types'
import { agentDisplay } from '../lib/agents'
import { apiUrl } from '../lib/api'
import { Icon } from '../components/Icon'
import s from './DocumentsPage.module.css'
import p from '../components/Panel.module.css'

const DOCS_URL = apiUrl('/api/docs')

function time(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const FMT_LABEL: Record<string, string> = {
  markdown: 'MD', mermaid: 'Mermaid', ppt: 'PPT', text: 'TXT',
  json: 'JSON', code: 'CODE', csv: 'CSV', html: 'HTML',
}

export function DocumentsPage() {
  const [data, setData] = useState<DocsData>({ folders: [], files: [] })
  const [online, setOnline] = useState<boolean | null>(null)
  const { id } = useParams()
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(DOCS_URL)
        if (!r.ok) return
        const d = await r.json()
        if (alive && d && Array.isArray(d.files)) {
          setData(d as DocsData)
          setOnline(true)
        }
      } catch {
        if (alive) setOnline(false)
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // Group files by folder, keeping empty folders from doc_folders visible.
  const tree = useMemo(() => {
    const byFolder = new Map<string, DocFile[]>()
    for (const f of data.folders) byFolder.set(f.path, [])
    for (const file of data.files) {
      if (!byFolder.has(file.folder)) byFolder.set(file.folder, [])
      byFolder.get(file.folder)!.push(file)
    }
    return [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, files]) => ({ folder, files: files.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [data])

  const active = useMemo(() => data.files.find((f) => String(f.id) === id), [data.files, id])

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để xem tài liệu: <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>.
          Trang này đọc <code>/api/docs</code> (company.documents).
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
          mọi việc đều được viết tài liệu (mặc định Markdown) để agent khác đọc &amp; follow. Console chỉ đọc;
          agent tạo/sửa qua tool <code>write_doc</code>.
        </span>
      </div>
      <div className={s.wrap}>
        <div className={s.rail}>
          <div className={s.railHead}>
            Thư mục · {data.files.length} tài liệu
          </div>
          <div className={s.railScroll}>
            {tree.length === 0 ? (
              <div className={s.railEmpty}>Chưa có tài liệu nào.</div>
            ) : (
              tree.map(({ folder, files }) => (
                <div key={folder} className={s.folderBlock}>
                  <div className={s.folderName} title={folder}>
                    <Icon name="layout" size={13} /> {folder}
                  </div>
                  {files.length === 0 ? (
                    <div className={s.fileEmpty}>(trống)</div>
                  ) : (
                    files.map((f) => (
                      <button
                        key={f.id}
                        className={String(f.id) === id ? `${s.file} ${s.fileActive}` : s.file}
                        onClick={() => navigate(`/workspace/docs/${f.id}`)}
                      >
                        <Icon name="file" size={13} />
                        <span className={s.fileName}>{f.name}</span>
                        <span className={s.fmt}>{FMT_LABEL[f.format] ?? f.format}</span>
                      </button>
                    ))
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className={s.viewer}>
          {active ? (
            <DocView doc={active} />
          ) : (
            <div className={s.pickHint}>
              {data.files.length === 0
                ? 'Chưa có tài liệu — agent sẽ viết vào đây khi làm việc.'
                : 'Chọn một tài liệu bên trái để đọc.'}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function DocView({ doc }: { doc: DocFile }) {
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
        </div>
      </div>
      <div className={s.viewerBody}>
        {doc.format === 'markdown' ? (
          <div className={s.md}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
          </div>
        ) : (
          // mermaid / json / code / csv / text / ppt / html → show source (readable);
          // markdown covers the default case with rich rendering.
          <pre className={s.raw}>{doc.content}</pre>
        )}
      </div>
    </>
  )
}
