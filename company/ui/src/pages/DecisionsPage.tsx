import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { DecisionQueue } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { DecisionTable, ReadOnlyNotice } from '../components/DecisionTable'
import { Drawer } from '../components/Drawer'
import { DecisionDetail, DecisionDetailFooter } from '../components/DecisionDetail'

interface Props {
  queue: DecisionQueue
  query: string
}

export function DecisionsPage({ queue, query }: Props) {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const decision = useMemo(
    () => (id ? queue.decisions.find((d) => d.id === id) : undefined),
    [queue.decisions, id],
  )

  const pending = queue.decisions.filter((d) => d.status === 'pending').length
  const decided = queue.decisions.filter((d) => d.status === 'decided').length
  const blocking = queue.decisions.filter((d) => d.urgency === 'blocking').length

  const stats: Stat[] = [
    {
      label: 'Chờ quyết định',
      value: pending,
      color: '#F5A93F',
      icon: 'clock',
      foot: <>Tất cả đều đang chặn tiến độ</>,
    },
    {
      label: 'Đã quyết',
      value: decided,
      color: '#21C286',
      icon: 'checkSquare',
      foot: <>Đích lưu: company.decisions</>,
    },
    {
      label: 'Đang chặn tiến độ',
      value: blocking,
      color: '#F2547D',
      icon: 'shield',
      foot: <>Đề xuất bởi {queue.decisions[0]?.raisedByName ?? 'agent'}</>,
    },
  ]

  return (
    <>
      <ReadOnlyNotice note={queue.note} source={queue.source} />
      <StatGrid stats={stats} />
      <DecisionTable
        decisions={queue.decisions}
        query={query}
        selectedId={decision?.id}
        onSelect={(i) => navigate(`/decisions/${i}`)}
      />

      <Drawer
        open={Boolean(decision)}
        title={decision ? `${decision.id} — ${decision.title}` : ''}
        subtitle={decision ? `Đề xuất bởi ${decision.raisedByName} · ${decision.raisedAt}` : undefined}
        footer={decision ? <DecisionDetailFooter decision={decision} /> : undefined}
        onClose={() => navigate('/decisions')}
      >
        {decision && <DecisionDetail decision={decision} />}
      </Drawer>
    </>
  )
}
