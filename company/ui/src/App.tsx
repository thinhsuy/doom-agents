import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import rosterJson from './data/agents.json'
import workspaceJson from './data/workspace.json'
import monitorJson from './data/monitor.json'
import { decisionQueue } from './data/decisions'
import { apiUrl } from './lib/api'
import { loadReads } from './pages/TeamChatPage'
import type { AgentRoster, DecisionQueue, Monitor, Workspace } from './types'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { AgentsPage } from './pages/AgentsPage'
import { DecisionsPage } from './pages/DecisionsPage'
import { TasksPage } from './pages/TasksPage'
import { OfficePage } from './pages/OfficePage'
import { DocumentsPage } from './pages/DocumentsPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { MonitorPage } from './pages/MonitorPage'
import s from './App.module.css'

const roster = rosterJson as AgentRoster
const staticWorkspace = workspaceJson as Workspace
const monitor = monitorJson as Monitor

/** Workspace (tasks/messages/channels) LIVE from the backend, so tasks the leads
    create appear on the board without a rebuild. Static snapshot is the offline
    fallback; polls every 5s while the backend is up. */
function useLiveWorkspace(): Workspace {
  const [ws, setWs] = useState<Workspace>(staticWorkspace)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(apiUrl('/api/workspace'))
        if (!r.ok) return
        const d = await r.json()
        if (alive && d && Array.isArray(d.tasks)) setWs(d as Workspace)
      } catch {
        /* backend offline — keep the snapshot */
      }
    }
    load()
    const id = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  return ws
}

/** Decision queue LIVE from the backend, so tickets a lead raises via `raise_decision`
    appear in the Quyết định tab without a rebuild. Static snapshot is the fallback. */
function useLiveDecisions(): DecisionQueue {
  const [dq, setDq] = useState<DecisionQueue>(decisionQueue)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(apiUrl('/api/decisions'))
        if (!r.ok) return
        const d = await r.json()
        if (alive && d && Array.isArray(d.decisions)) setDq(d as DecisionQueue)
      } catch {
        /* backend offline — keep the snapshot */
      }
    }
    load()
    const id = setInterval(load, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  return dq
}

/** Total UNREAD messages FROM AGENTS across all channels (id newer than the owner's
    per-channel read cursor) — same rule as the in-panel channel badges. Recomputes on
    new messages and whenever a channel is marked read (custom event + cross-tab storage). */
function useUnreadCount(messages: Workspace['messages']): number {
  const [reads, setReads] = useState(loadReads)
  useEffect(() => {
    const refresh = () => setReads(loadReads())
    window.addEventListener('chat-reads-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('chat-reads-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return useMemo(
    () => messages.filter((m) => m.fromAgent && m.id > (reads[m.channelId ?? '—'] ?? 0)).length,
    [messages, reads],
  )
}

export function App() {
  // One search box in the topbar drives whichever view is showing.
  const [query, setQuery] = useState('')
  const workspace = useLiveWorkspace()
  const unread = useUnreadCount(workspace.messages)
  const liveDecisions = useLiveDecisions()
  const pending = liveDecisions.decisions.filter((d) => d.status === 'pending').length
  // Active tasks (not accepted/deferred) and total messages drive the sidebar counts.
  const activeTasks = workspace.tasks.filter(
    (t) => !['accepted', 'deferred', 'cancelled'].includes(t.status),
  ).length

  return (
    <div className={s.shell}>
      <Sidebar pendingCount={pending} taskCount={activeTasks} messageCount={unread} />
      <div className={s.main}>
        <Topbar query={query} onQueryChange={setQuery} />
        <main className={s.content}>
          <Routes>
            <Route path="/" element={<Navigate to="/agents" replace />} />
            <Route
              path="/agents"
              element={
                <AgentsPage
                  roster={roster}
                  decisions={liveDecisions.decisions}
                  query={query}
                  onQueryChange={setQuery}
                />
              }
            />
            <Route
              path="/agents/:slug"
              element={
                <AgentsPage
                  roster={roster}
                  decisions={liveDecisions.decisions}
                  query={query}
                  onQueryChange={setQuery}
                />
              }
            />
            <Route path="/decisions" element={<DecisionsPage queue={liveDecisions} query={query} />} />
            <Route
              path="/decisions/:id"
              element={<DecisionsPage queue={liveDecisions} query={query} />}
            />
            {/* Team Chat now lives INSIDE the Office screen (right panel). */}
            <Route path="/workspace/chat" element={<Navigate to="/workspace/office" replace />} />
            <Route path="/workspace/office" element={<OfficePage workspace={workspace} />} />
            <Route path="/workspace/tasks" element={<TasksPage workspace={workspace} />} />
            <Route path="/workspace/tasks/:id" element={<TasksPage workspace={workspace} />} />
            <Route path="/workspace/docs" element={<DocumentsPage />} />
            <Route path="/workspace/docs/:id" element={<DocumentsPage />} />
            <Route path="/providers" element={<ProvidersPage roster={roster} />} />
            <Route path="/monitor" element={<MonitorPage monitor={monitor} />} />
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
