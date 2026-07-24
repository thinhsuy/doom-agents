import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { tint } from '../lib/color'
import s from './StatCard.module.css'

export interface Stat {
  label: string
  value: ReactNode
  color: string
  icon: IconName
  foot: ReactNode
}

export function StatGrid({ stats }: { stats: Stat[] }) {
  return (
    <div className={s.grid}>
      {stats.map((stat) => (
        <StatCard key={stat.label} {...stat} />
      ))}
    </div>
  )
}

function StatCard({ label, value, color, icon, foot }: Stat) {
  return (
    <div className={s.stat}>
      <div className={s.top}>
        <div className={s.bar} style={{ background: color }} />
        <div className={s.body}>
          <div className={s.label}>{label}</div>
          <div className={s.value}>{value}</div>
        </div>
        <div className={s.icon} style={{ background: tint(color, 0.12) }}>
          <Icon name={icon} size={18} color={color} strokeWidth={2} />
        </div>
      </div>
      <div className={s.foot}>{foot}</div>
    </div>
  )
}
