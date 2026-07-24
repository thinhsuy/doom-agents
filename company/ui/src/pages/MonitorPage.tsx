import type { Monitor } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { Icon } from '../components/Icon'
import { agentDisplay } from '../lib/agents'
import { fmtInt, fmtTokens, fmtUsd } from '../lib/format'
import s from './MonitorPage.module.css'
import p from '../components/Panel.module.css'

export function MonitorPage({ monitor }: { monitor: Monitor }) {
  const { totals, agents, models } = monitor
  const maxCost = Math.max(1e-9, ...agents.map((a) => a.costUsd))

  const stats: Stat[] = [
    { label: 'Chi phí ước tính', value: fmtUsd(totals.costUsd), color: '#F5A93F', icon: 'coins',
      foot: <>usage × giá token thật</> },
    { label: 'Lượt gọi model', value: fmtInt(totals.requests), color: '#4E5AE8', icon: 'activity',
      foot: <>throughput qua {totals.agents} agent</> },
    { label: 'Token vào / ra', value: `${fmtTokens(totals.inputTokens)} / ${fmtTokens(totals.outputTokens)}`,
      color: '#38BFC9', icon: 'server', foot: <>+{fmtTokens(totals.cacheReadTokens)} cache read</> },
    { label: 'Agent có hoạt động', value: totals.agents, color: '#21C286', icon: 'users',
      foot: <>đang ghi vào usage_events</> },
  ]

  return (
    <>
      {monitor.sample && (
        <div className={s.notice}>
          <Icon name="info" size={17} strokeWidth={2} />
          <div>
            <b>Chi phí thật, usage mẫu.</b> {monitor.note}
          </div>
        </div>
      )}

      <StatGrid stats={stats} />

      {/* Pricing reference — the real cost model */}
      <div className={p.panel} style={{ marginBottom: 20 }}>
        <div className={p.head}>
          <h2 className={p.title}>
            Bảng giá model <span className={p.hint}>· $/1M token · {models[0]?.source}</span>
          </h2>
        </div>
        <div className={s.prices}>
          {models.map((m) => (
            <div key={m.model} className={s.price}>
              <div className={s.priceModel}>{m.model}</div>
              <div className={s.priceRow}>
                <span>Input</span>
                <b>${m.inputPerMtok}</b>
              </div>
              <div className={s.priceRow}>
                <span>Output</span>
                <b>${m.outputPerMtok}</b>
              </div>
              {m.note && <div className={s.priceNote}>{m.note}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Per-agent usage */}
      <div className={p.panel}>
        <div className={p.head}>
          <h2 className={p.title}>Throughput &amp; chi phí theo nhân sự</h2>
        </div>
        {agents.length === 0 ? (
          <div className={p.empty}>
            Chưa có usage nào. Bảng này đầy khi agent chạy thật và metering ghi vào{' '}
            <code>company.usage_events</code>.
          </div>
        ) : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Nhân sự</th>
                  <th className={s.num}>Lượt gọi</th>
                  <th className={s.num}>Token vào</th>
                  <th className={s.num}>Token ra</th>
                  <th className={s.num}>Chi phí</th>
                  <th>Tỷ trọng</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => {
                  const who = agentDisplay(a.slug)
                  return (
                    <tr key={a.slug} className={s.row}>
                      <td>
                        <div className={s.who}>
                          <span className={s.avatar} style={{ background: `${who.color}22` }}>
                            {who.emoji}
                          </span>
                          <div>
                            <div style={{ fontWeight: 500 }}>{a.name}</div>
                            <div className={s.sub}>
                              {a.models.map((m) => (
                                <span key={m} className={s.modelChip}>
                                  {m.replace('claude-', '')}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={s.num}>{fmtInt(a.requests)}</td>
                      <td className={s.num}>{fmtTokens(a.inputTokens)}</td>
                      <td className={s.num}>{fmtTokens(a.outputTokens)}</td>
                      <td className={`${s.num} ${s.cost}`}>
                        {a.priceUnknown ? '—' : fmtUsd(a.costUsd)}
                      </td>
                      <td className={s.barCell}>
                        <div className={s.bar}>
                          <div
                            className={s.barFill}
                            style={{ width: `${Math.max(3, (a.costUsd / maxCost) * 100)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className={s.tfoot}>
                  <td>Tổng</td>
                  <td className={s.num}>{fmtInt(totals.requests)}</td>
                  <td className={s.num}>{fmtTokens(totals.inputTokens)}</td>
                  <td className={s.num}>{fmtTokens(totals.outputTokens)}</td>
                  <td className={s.num}>{fmtUsd(totals.costUsd)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
