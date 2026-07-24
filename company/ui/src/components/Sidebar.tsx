import { NavLink } from 'react-router-dom'
import { Icon } from './Icon'
import { useCopy } from '../lib/useCopy'
import s from './Sidebar.module.css'

interface Props {
  pendingCount: number
  taskCount: number
  messageCount: number
}

/** Docs aren't routes — the console can't open a repo file, so it copies the path. */
const DOCS = [
  { label: 'Kế hoạch', path: 'company/IMPLEMENTATION-PLAN.md', icon: 'info' },
  { label: 'NEXUS', path: 'strategy/nexus-strategy.md', icon: 'settings' },
] as const

/** Own useCopy per button so feedback lands on the one that was clicked. */
function DocButton({ label, path, icon }: { label: string; path: string; icon: 'info' | 'settings' }) {
  const [state, copy] = useCopy()
  return (
    <button className={s.item} onClick={() => copy(path)} title={`Sao chép đường dẫn ${path}`}>
      <Icon name={icon} />
      {state === 'ok' ? 'Đã sao chép' : state === 'fail' ? 'Không sao chép được' : label}
    </button>
  )
}

export function Sidebar({ pendingCount, taskCount, messageCount }: Props) {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${s.item} ${s.active}` : s.item

  return (
    <aside className={s.sidebar}>
      <div className={s.brand}>
        <div className={s.brandMark}>
          <Icon name="layout" size={17} color="#fff" strokeWidth={2.2} />
        </div>
        <div>
          <div className={s.brandName}>AGENCY OS</div>
          <div className={s.brandSub}>Virtual Company Console</div>
        </div>
      </div>

      <div className={s.minimize}>
        <Icon name="chevronLeft" size={13} strokeWidth={2.4} />
        Minimize
      </div>

      <div className={s.navLabel}>MAIN MENU</div>
      <nav className={s.nav}>
        <NavLink to="/agents" className={linkClass}>
          <Icon name="users" />
          Nhân sự
        </NavLink>
        <NavLink to="/decisions" className={linkClass}>
          <Icon name="checkSquare" />
          Quyết định
          {pendingCount > 0 && <span className={s.badge}>{pendingCount}</span>}
        </NavLink>
      </nav>

      <div className={s.navLabel}>WORKSPACE</div>
      <nav className={s.nav}>
        <NavLink to="/workspace/office" className={linkClass}>
          <Icon name="building" />
          Office
          {messageCount > 0 && <span className={`${s.badge} ${s.badgeSoft}`}>{messageCount}</span>}
        </NavLink>
        <NavLink to="/workspace/tasks" className={linkClass}>
          <Icon name="kanban" />
          Tasks
          {taskCount > 0 && <span className={`${s.badge} ${s.badgeSoft}`}>{taskCount}</span>}
        </NavLink>
        <NavLink to="/workspace/docs" className={linkClass}>
          <Icon name="file" />
          Documents
        </NavLink>
      </nav>

      <div className={s.navLabel}>SETTING &amp; MONITOR</div>
      <nav className={s.nav}>
        <NavLink to="/providers" className={linkClass}>
          <Icon name="server" />
          Providers
        </NavLink>
        <NavLink to="/monitor" className={linkClass}>
          <Icon name="activity" />
          Monitor
        </NavLink>
      </nav>

      <div className={s.navLabel}>HELP &amp; SUPPORT</div>
      <nav className={s.nav}>
        {DOCS.map((d) => (
          <DocButton key={d.path} label={d.label} path={d.path} icon={d.icon} />
        ))}
      </nav>

      <div className={s.spacer} />
      <nav className={s.nav}>
        <button className={s.item}>
          <Icon name="logout" />
          Log Out
        </button>
      </nav>
    </aside>
  )
}
