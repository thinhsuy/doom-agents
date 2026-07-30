import { useEffect, useState } from 'react'
import { FX_SOURCES, useCurrency } from '../lib/currency'
import { fmtVnd } from '../lib/format'
import { apiUrl } from '../lib/api'
import s from './CurrencyControls.module.css'

const STATUS: Record<string, { dot: string; text: string }> = {
  live: { dot: '#21C286', text: 'trực tiếp' },
  stale: { dot: '#F5A93F', text: 'tạm (cache)' },
  fallback: { dot: '#8A90A8', text: 'mặc định (offline)' },
  loading: { dot: '#4E5AE8', text: 'đang tải…' },
}

// Which API protocol a provider speaks (which SDK the backend uses). `wired` = routing works now.
const PROTOCOLS: { id: string; label: string; sdk: string; wired: boolean }[] = [
  { id: 'openai-chat', label: 'OpenAI Chat Completions', sdk: 'OpenAI SDK', wired: true },
  { id: 'openai-responses', label: 'OpenAI Responses', sdk: 'OpenAI SDK', wired: true },
  { id: 'anthropic-messages', label: 'Anthropic Messages', sdk: 'Anthropic SDK', wired: false },
  { id: 'google-gemini', label: 'Google Gemini', sdk: 'Google GenAI SDK', wired: false },
]

/** Company-wide currency switch + custom LLM provider config. `onProvidersChanged` lets the
    parent (Providers table) reload its provider list after one is added/removed. */
export function CurrencyControls({ onProvidersChanged }: { onProvidersChanged?: () => void }) {
  const { unit, setUnit, source, setSource, rate, asOf, status, refresh } = useCurrency()
  const st = STATUS[status] ?? STATUS.loading

  return (
    <div className={s.card}>
      <div className={s.block}>
        <div className={s.label}>Hiển thị tiền tệ</div>
        <div className={s.toggle}>
          <button className={unit === 'vnd' ? `${s.opt} ${s.optOn}` : s.opt} onClick={() => setUnit('vnd')}>
            ₫ VND
          </button>
          <button className={unit === 'usd' ? `${s.opt} ${s.optOn}` : s.opt} onClick={() => setUnit('usd')}>
            $ USD
          </button>
        </div>
        <div className={s.hint}>Đổi toàn bộ giá trị tiền trong app</div>
      </div>

      <div className={s.block}>
        <div className={s.label}>Nguồn tỷ giá</div>
        <select className={s.select} value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          {FX_SOURCES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <div className={s.rateRow}>
          <span className={s.rate}>
            1&nbsp;$&nbsp;=&nbsp;<b>{fmtVnd(rate)}</b>
          </span>
          <span className={s.status}>
            <span className={s.dot} style={{ background: st.dot }} />
            {st.text}
          </span>
          <button className={s.refresh} onClick={refresh} title="Cập nhật tỷ giá">
            ↻
          </button>
        </div>
        {asOf && <div className={s.asOf}>cập nhật: {asOf}</div>}
      </div>

      <ProviderConfig onChange={onProvidersChanged} />
    </div>
  )
}

interface CustomProvider {
  id: string
  label: string
  baseUrl: string
  protocol: string
  hasKey: boolean
  models: { id: string; label: string }[]
  config?: { maxOutput?: number; maxContext?: number; temperature?: number }
}

/** Add/manage OpenAI-compatible LLM providers (vLLM, Ollama, OpenRouter, HuggingFace TGI…). */
function ProviderConfig({ onChange }: { onChange?: () => void }) {
  const [list, setList] = useState<CustomProvider[]>([])
  const [editing, setEditing] = useState<CustomProvider | 'new' | null>(null)

  const load = () =>
    fetch(apiUrl('/api/custom-providers'))
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setList(Array.isArray(d) ? d : []))
      .catch(() => {})
  useEffect(() => {
    load()
  }, [])

  return (
    <div className={s.block}>
      <div className={s.label}>Cấu hình provider</div>
      <button className={s.provAdd} onClick={() => setEditing('new')}>＋ Thêm provider</button>
      {list.length > 0 && (
        <div className={s.provList}>
          {list.map((p) => (
            <button key={p.id} className={s.provChip} onClick={() => setEditing(p)} title="Sửa">
              {p.label} <span className={s.provId}>{p.id}</span>
            </button>
          ))}
        </div>
      )}
      <div className={s.hint}>Endpoint OpenAI-compatible (vLLM · Ollama · OpenRouter · HF TGI…)</div>
      {editing && (
        <ProviderModal
          prov={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
            onChange?.()
          }}
        />
      )}
    </div>
  )
}

function ProviderModal({
  prov,
  onClose,
  onSaved,
}: {
  prov: CustomProvider | null
  onClose: () => void
  onSaved: () => void
}) {
  const [id, setId] = useState(prov?.id ?? '')
  const [label, setLabel] = useState(prov?.label ?? '')
  const [protocol, setProtocol] = useState(prov?.protocol ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(prov?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('') // blank = keep existing on edit
  const [models, setModels] = useState((prov?.models ?? []).map((m) => m.id).join(', '))
  const [maxOutput, setMaxOutput] = useState(prov?.config?.maxOutput != null ? String(prov.config.maxOutput) : '')
  const [maxContext, setMaxContext] = useState(prov?.config?.maxContext != null ? String(prov.config.maxContext) : '')
  const [temperature, setTemperature] = useState(prov?.config?.temperature != null ? String(prov.config.temperature) : '')
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null)
  const [err, setErr] = useState('')

  async function save() {
    if (busy) return
    if (!prov && !/^[a-z][a-z0-9_-]{1,39}$/.test(id.trim())) {
      setErr('id: chữ thường/số/gạch (- hoặc _), bắt đầu bằng chữ, 2–40 ký tự')
      return
    }
    if (!label.trim() || !baseUrl.trim()) {
      setErr('Cần tên + base URL')
      return
    }
    setBusy('save')
    setErr('')
    try {
      const r = await fetch(apiUrl('/api/custom-providers'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: id.trim(),
          label: label.trim(),
          protocol,
          baseUrl: baseUrl.trim(),
          apiKey,
          models: models.split(',').map((x) => x.trim()).filter(Boolean),
          maxOutput: maxOutput.trim(),
          maxContext: maxContext.trim(),
          temperature: temperature.trim(),
        }),
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
    if (!prov || busy) return
    if (!window.confirm(`Xoá provider "${prov.label}"? Agent đang dùng sẽ về provider mặc định.`)) return
    setBusy('delete')
    try {
      await fetch(apiUrl(`/api/custom-providers/${prov.id}`), { method: 'DELETE' })
      onSaved()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHead}>
          <span className={s.modalTitle}>{prov ? `Sửa provider · ${prov.id}` : 'Thêm provider'}</span>
          <button className={s.modalClose} onClick={onClose}>✕</button>
        </div>
        <div className={s.modalBody}>
          {!prov && (
            <label className={s.field}>
              <span className={s.flabel}>id (định danh, không đổi)</span>
              <input className={`${s.input} ${s.mono}`} placeholder="vd: ollama-local" value={id}
                onChange={(e) => setId(e.target.value)} autoFocus />
            </label>
          )}
          <label className={s.field}>
            <span className={s.flabel}>Tên hiển thị</span>
            <input className={s.input} placeholder="vd: Ollama (local)" value={label}
              onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Protocol (SDK backend dùng để gọi)</span>
            <select className={s.input} value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {PROTOCOLS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.sdk}{p.wired ? '' : ' (sắp nối)'}
                </option>
              ))}
            </select>
            <span className={s.fieldHint}>
              {PROTOCOLS.find((p) => p.id === protocol)?.wired
                ? 'Gọi được ngay qua OpenAI SDK.'
                : 'Đã khai báo — mình nối routing khi bạn thêm endpoint thật.'}
            </span>
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Base URL (endpoint — chỉ là ví dụ, điền sau cũng được)</span>
            <input className={`${s.input} ${s.mono}`}
              placeholder="vd: https://openrouter.ai/api/v1 · http://localhost:11434/v1"
              value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className={s.field}>
            <span className={s.flabel}>API key {prov && <span className={s.flabelHint}>(để trống = giữ key cũ)</span>}</span>
            <input className={`${s.input} ${s.mono}`} type="password"
              placeholder={prov?.hasKey ? '•••••• (đã có, để trống nếu giữ)' : 'trống nếu endpoint không cần key'}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          </label>
          <label className={s.field}>
            <span className={s.flabel}>Models (phân tách bằng dấu phẩy)</span>
            <input className={`${s.input} ${s.mono}`} placeholder="vd: llama3.1, qwen2.5-coder"
              value={models} onChange={(e) => setModels(e.target.value)} />
            <span className={s.fieldHint}>id model đúng như endpoint yêu cầu. Agent chọn provider + model này ở bảng dưới.</span>
          </label>
          <div className={s.row3}>
            <label className={s.field}>
              <span className={s.flabel}>Max output</span>
              <input className={`${s.input} ${s.mono}`} type="number" min={1} placeholder="vd: 4096"
                value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Max context</span>
              <input className={`${s.input} ${s.mono}`} type="number" min={1} placeholder="vd: 128000"
                value={maxContext} onChange={(e) => setMaxContext(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Temperature</span>
              <input className={`${s.input} ${s.mono}`} type="number" min={0} max={2} step="0.1" placeholder="vd: 0.7"
                value={temperature} onChange={(e) => setTemperature(e.target.value)} />
            </label>
          </div>
          <span className={s.fieldHint}>
            Max output (max_tokens) + temperature áp cho mọi lần gọi provider này. Max context là thông tin
            tham khảo. Để trống = dùng mặc định.
          </span>
          {err && <div className={s.err}>{err}</div>}
        </div>
        <div className={s.modalFoot}>
          {prov && (
            <button className={s.delBtn} onClick={remove} disabled={busy !== null}>
              {busy === 'delete' ? 'Đang xoá…' : '🗑 Xoá'}
            </button>
          )}
          <button className={s.cancel} onClick={onClose} disabled={busy !== null}>Huỷ</button>
          <button className={s.saveBtn} onClick={save} disabled={busy !== null}>
            {busy === 'save' ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  )
}
