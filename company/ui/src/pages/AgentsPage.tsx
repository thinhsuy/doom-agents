import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { AgentRoster, Decision } from '../types'
import { StatGrid, type Stat } from '../components/StatCard'
import { AgentDirectory } from '../components/AgentDirectory'
import { Drawer } from '../components/Drawer'
import {
  AgentDetail,
  AgentDetailFooter,
  agentSubtitle,
  agentTitle,
} from '../components/AgentDetail'

interface Props {
  roster: AgentRoster
  decisions: Decision[]
  query: string
  onQueryChange: (q: string) => void
}

export function AgentsPage({ roster, decisions, query, onQueryChange }: Props) {
  const navigate = useNavigate()
  const { slug } = useParams<{ slug: string }>()

  const agent = useMemo(
    () => (slug ? roster.agents.find((a) => a.slug === slug) : undefined),
    [roster.agents, slug],
  )
  const division = useMemo(
    () => (agent ? roster.divisions.find((d) => d.slug === agent.division) : undefined),
    [roster.divisions, agent],
  )

  const pending = decisions.filter((d) => d.status === 'pending').length

  const stats: Stat[] = [
    {
      label: 'Nhân sự biên chế',
      value: roster.stats.hired,
      color: '#4E5AE8',
      icon: 'users',
      foot: (
        <>
          trên <b>{roster.stats.agents}</b> ứng viên trong kho
        </>
      ),
    },
    {
      label: 'Runtime đang dùng',
      value: roster.stats.runtimes,
      color: '#38BFC9',
      icon: 'grid',
      foot:
        roster.stats.assigned > 0 ? (
          <>
            <b style={{ color: '#4E5AE8' }}>{roster.stats.assigned}</b> agent gán riêng
          </>
        ) : (
          <>Tất cả theo mặc định công ty</>
        ),
    },
    {
      label: 'Đã phân quyền tool',
      value: roster.stats.hiredScoped,
      color: roster.stats.scopingConflicts > 0 ? '#F5A93F' : '#21C286',
      icon: 'shield',
      foot:
        roster.stats.scopingConflicts > 0 ? (
          <>
            <b style={{ color: '#F5A93F' }}>{roster.stats.scopingConflicts}</b> mất hiệu lực do
            runtime
          </>
        ) : (
          <>
            <b style={{ color: '#F2547D' }}>{roster.stats.hiredUnscoped}</b> người trong biên chế
            chưa khai <code>tools:</code>
          </>
        ),
    },
    {
      label: 'Chờ bạn quyết',
      value: pending,
      color: '#F5A93F',
      icon: 'clock',
      foot: <>Chặn Stage 1 của kế hoạch</>,
    },
  ]

  return (
    <>
      <StatGrid stats={stats} />
      <AgentDirectory
        divisions={roster.divisions}
        agents={roster.agents}
        query={query}
        onQueryChange={onQueryChange}
        selectedSlug={agent?.slug}
        forceOpen={agent?.division}
        onSelect={(s) => navigate(`/agents/${s}`)}
      />

      <Drawer
        open={Boolean(agent)}
        title={agent ? agentTitle(agent) : ''}
        subtitle={agent ? agentSubtitle(agent, division) : undefined}
        footer={agent ? <AgentDetailFooter agent={agent} /> : undefined}
        onClose={() => navigate('/agents')}
      >
        {agent && <AgentDetail agent={agent} />}
      </Drawer>
    </>
  )
}
