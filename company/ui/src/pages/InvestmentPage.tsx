import { useCallback, useEffect, useState } from 'react'
import { StatGrid, type Stat } from '../components/StatCard'
import { apiUrl } from '../lib/api'
import { useAuth } from '../lib/auth'
import { agentDisplay } from '../lib/agents'
import { useCurrency } from '../lib/currency'
import type { AssetType, Investment, InvestmentData } from '../types'
import s from './InvestmentPage.module.css'
import p from '../components/Panel.module.css'

const URL = apiUrl('/api/investments')

const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

const ASSET_TYPES: AssetType[] = ['stock', 'etf', 'crypto', 'bond', 'fund', 'other']
const ASSET_LABEL: Record<AssetType, string> = {
  stock: 'Cổ phiếu', etf: 'ETF', crypto: 'Crypto', bond: 'Trái phiếu', fund: 'Quỹ', other: 'Khác',
}

const ACTION_ICON: Record<string, string> = { create: '📈', update: '✏️', sell: '💰', delete: '🗑' }

function fmtTime(iso: string): string {
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime())
    ? ''
    : dt.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function InvestmentPage() {
  const { money } = useCurrency()
  const [data, setData] = useState<InvestmentData | null>(null)
  const [online, setOnline] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<Investment | 'new' | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(URL, { credentials: 'include' })
      if (!r.ok) return setOnline(false)
      setData((await r.json()) as InvestmentData)
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 10000)
    return () => clearInterval(id)
  }, [load])

  if (online === false) {
    return (
      <div className={p.panel}>
        <div className={p.empty}>
          Cần chạy backend để khai báo đầu tư:{' '}
          <code>cd company/api &amp;&amp; ./.venv/bin/uvicorn main:app --port 8000</code>. Trang này đọc/ghi{' '}
          <code>/api/investments</code>.
        </div>
      </div>
    )
  }
  if (!data) return <div className={p.panel}><div className={p.empty}>Đang tải…</div></div>

  const sm = data.summary
  const revColor = sm.realizedRevenueUsd >= 0 ? '#21C286' : '#d93463'
  const stats: Stat[] = [
    {
      label: sm.realizedRevenueUsd >= 0 ? 'Doanh thu thực hiện' : 'Lỗ thực hiện',
      value: money(sm.realizedRevenueUsd, 'vnd'),
      color: revColor,
      icon: 'trendingUp',
      foot: <>từ {sm.soldPositions} vị thế đã bán · <b>thật</b></>,
    },
    {
      label: 'Vốn đã đầu tư',
      value: money(sm.investedUsd, 'vnd'),
      color: '#4E5AE8',
      icon: 'coins',
      foot: <>{sm.positions} vị thế tổng</>,
    },
    {
      label: 'Đang nắm giữ',
      value: money(sm.openInvestedUsd, 'vnd'),
      color: '#38BFC9',
      icon: 'activity',
      foot: <>{sm.openPositions} vị thế mở (chưa bán)</>,
    },
    {
      label: 'Số vị thế',
      value: sm.positions,
      color: '#F5A93F',
      icon: 'grid',
      foot: <>CEO · CTO · COO khai báo</>,
    },
  ]

  return (
    <>
      <StatGrid stats={stats} />

      <div className={s.note}>
        <b>Doanh thu công ty = số THẬT</b> từ các khoản đầu tư CEO/CTO/COO tự khai báo:{' '}
        <b>doanh thu thực hiện = Σ (giá bán − giá mua) × số lượng</b> trên các vị thế đã bán (có thể lãi hoặc lỗ).
        Vị thế chưa bán chỉ tính vào vốn đang nắm giữ. Agent được <b>xem</b> dữ liệu này (view_db).
      </div>

      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>
            Danh mục đầu tư <span className={p.hint}>· {data.items.length}</span>
          </h2>
          <button className={s.addBtn} onClick={() => setEditing('new')}>＋ Khai báo đầu tư</button>
        </div>
        {data.items.length === 0 ? (
          <div className={p.empty}>Chưa có khoản đầu tư nào. Bấm “＋ Khai báo đầu tư” để thêm.</div>
        ) : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Người khai</th>
                  <th>Mã</th>
                  <th>Loại</th>
                  <th className={s.num}>Số lượng</th>
                  <th className={s.num}>Giá mua</th>
                  <th className={s.num}>Giá bán</th>
                  <th className={s.num}>Lãi/Lỗ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => {
                  const who = agentDisplay(it.owner)
                  return (
                    <tr
                      key={it.id}
                      className={`${s.row} ${s.rowClickable}`}
                      onClick={() => setEditing(it)}
                      title="Sửa giao dịch (thêm giá bán / ngày bán để chốt doanh thu)"
                    >
                      <td>
                        <span className={s.who}>
                          <span className={s.avatar}>{who.emoji}</span>
                          {who.name}
                        </span>
                      </td>
                      <td>
                        <b>{it.symbol}</b>
                        {it.name && <div className={s.sub}>{it.name}</div>}
                      </td>
                      <td className={s.sub}>{ASSET_LABEL[it.assetType]}</td>
                      <td className={s.num}>{num.format(it.quantity)}</td>
                      <td className={s.num}>{money(it.buyPrice, 'vnd')}</td>
                      <td className={s.num}>
                        {it.sold ? money(it.sellPrice ?? 0, 'vnd') : <span className={s.holding}>đang giữ</span>}
                      </td>
                      <td className={`${s.num} ${it.sold ? ((it.realizedUsd ?? 0) >= 0 ? s.gain : s.loss) : ''}`}>
                        {it.sold ? money(it.realizedUsd ?? 0, 'vnd') : '—'}
                      </td>
                      <td className={s.actionCell}>
                        {it.sold ? (
                          <button className={s.editBtn} onClick={(e) => { e.stopPropagation(); setEditing(it) }}>
                            ✏️ Sửa
                          </button>
                        ) : (
                          <button className={s.sellBtn} onClick={(e) => { e.stopPropagation(); setEditing(it) }}>
                            ＋ Bán
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className={s.tfoot}>
                  <td colSpan={6}>Doanh thu thực hiện (tổng)</td>
                  <td className={`${s.num} ${sm.realizedRevenueUsd >= 0 ? s.gain : s.loss}`}>
                    {money(sm.realizedRevenueUsd, 'vnd')}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {data.history && data.history.length > 0 && (
        <div className={p.panel}>
          <div className={p.head}>
            <h2 className={p.title}>
              Lịch sử thao tác <span className={p.hint}>· {data.history.length}</span>
            </h2>
          </div>
          <div className={s.history}>
            {data.history.map((e) => {
              const who = agentDisplay(e.actor)
              return (
                <div key={e.id} className={s.hrow}>
                  <span className={s.hicon}>{ACTION_ICON[e.action] ?? '•'}</span>
                  <span className={s.hwho}>
                    <span className={s.havatar} style={{ background: `${who.color}22` }}>{who.emoji}</span>
                    {who.name}
                  </span>
                  <span className={s.hsummary}>{e.summary}</span>
                  <span
                    className={
                      e.amount == null
                        ? s.hamount
                        : e.action === 'sell'
                          ? `${s.hamount} ${e.amount >= 0 ? s.gain : s.loss}`
                          : s.hamount
                    }
                    title={e.action === 'sell' ? 'lãi/lỗ đã chốt' : e.action === 'delete' ? 'vốn đã xoá' : 'vốn'}
                  >
                    {e.amount == null
                      ? ''
                      : `${e.action === 'sell' && e.amount >= 0 ? '+' : ''}${money(e.amount, 'vnd')}`}
                  </span>
                  <span className={s.htime}>{fmtTime(e.createdAt)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {editing && (
        <InvestmentEditor
          item={editing === 'new' ? null : editing}
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

function InvestmentEditor({
  item,
  onClose,
  onSaved,
}: {
  item: Investment | null
  onClose: () => void
  onSaved: () => void
}) {
  const [symbol, setSymbol] = useState(item?.symbol ?? '')
  const [name, setName] = useState(item?.name ?? '')
  const [assetType, setAssetType] = useState<AssetType>(item?.assetType ?? 'stock')
  const [quantity, setQuantity] = useState(String(item?.quantity ?? ''))
  const [buyPrice, setBuyPrice] = useState(String(item?.buyPrice ?? ''))
  const [sellPrice, setSellPrice] = useState(item?.sellPrice != null ? String(item.sellPrice) : '')
  const [buyDate, setBuyDate] = useState(item?.buyDate ?? '')
  const [sellDate, setSellDate] = useState(item?.sellDate ?? '')
  const [note, setNote] = useState(item?.note ?? '')
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null)
  const [err, setErr] = useState('')
  const { user } = useAuth()
  // Authorship guard: only the owner who declared a position may delete it.
  const canDelete = Boolean(item && item.owner === user?.username)

  async function save() {
    if (!symbol.trim() || !quantity || !buyPrice || busy) return
    setBusy('save')
    setErr('')
    const body = {
      symbol, name, assetType, quantity: Number(quantity), buyPrice: Number(buyPrice),
      sellPrice: sellPrice === '' ? null : Number(sellPrice),
      buyDate: buyDate.trim(), sellDate: sellDate.trim(), note,
    }
    const url = item ? apiUrl(`/api/investments/${item.id}`) : apiUrl('/api/investments')
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
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
    if (!item || busy) return
    if (!window.confirm(`Xoá khoản đầu tư ${item.symbol} (${item.id})?`)) return
    setBusy('delete')
    try {
      const r = await fetch(apiUrl(`/api/investments/${item.id}`), { method: 'DELETE', credentials: 'include' })
      if (r.ok) onSaved()
      else setErr('Không xoá được')
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
          <span className={s.modalTitle}>{item ? `Sửa ${item.symbol}` : 'Khai báo đầu tư'}</span>
          <button className={s.modalClose} onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className={s.modalBody}>
          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.flabel}>Mã (ticker)</span>
              <input className={s.input} value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="vd: AAPL, VNM" autoFocus={!item} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Loại</span>
              <select className={s.input} value={assetType} onChange={(e) => setAssetType(e.target.value as AssetType)}>
                {ASSET_TYPES.map((t) => <option key={t} value={t}>{ASSET_LABEL[t]}</option>)}
              </select>
            </label>
          </div>
          <label className={s.field}>
            <span className={s.flabel}>Tên (tuỳ chọn)</span>
            <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Apple Inc." />
          </label>
          <div className={s.row3}>
            <label className={s.field}>
              <span className={s.flabel}>Số lượng</span>
              <input className={s.input} type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Giá mua (₫)</span>
              <input className={s.input} type="number" min={0} step="any" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Giá bán (₫)</span>
              <input
                className={s.input}
                type="number"
                min={0}
                step="any"
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
                autoFocus={Boolean(item) && !item?.sold}
              />
            </label>
          </div>
          <div className={s.row2}>
            <label className={s.field}>
              <span className={s.flabel}>Ngày mua</span>
              <input className={s.input} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.flabel}>Ngày bán</span>
              <input className={s.input} type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
            </label>
          </div>
          <label className={s.field}>
            <span className={s.flabel}>Ghi chú</span>
            <input className={s.input} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {err && <div className={s.err}>{err}</div>}
        </div>
        <div className={s.modalFoot}>
          {canDelete && (
            <button className={s.deleteBtn} onClick={remove} disabled={busy !== null}>
              {busy === 'delete' ? 'Đang xoá…' : '🗑 Xoá'}
            </button>
          )}
          {item && !canDelete && (
            <span className={s.ownerLock}>🔒 chỉ {agentDisplay(item.owner).name} (người khai) xoá được</span>
          )}
          <button className={s.cancel} onClick={onClose} disabled={busy !== null}>Huỷ</button>
          <button className={s.save} onClick={save} disabled={busy !== null || !symbol.trim() || !quantity || !buyPrice}>
            {busy === 'save' ? 'Đang lưu…' : item ? 'Lưu' : 'Khai báo'}
          </button>
        </div>
      </div>
    </div>
  )
}
