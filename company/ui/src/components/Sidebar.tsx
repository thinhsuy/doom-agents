import { NavLink } from 'react-router-dom'
import { Icon } from './Icon'
import { useAuth } from '../lib/auth'
import s from './Sidebar.module.css'

const ROLE_EMOJI: Record<string, string> = { CEO: '👑', CTO: '🛠️', COO: '⚙️', CIO: '🗄️' }

interface Props {
  pendingCount: number
  recruitCount: number
  taskCount: number
  messageCount: number
}

export function Sidebar({ pendingCount, recruitCount, taskCount, messageCount }: Props) {
  const { user, logout } = useAuth()
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
        <NavLink to="/goals" className={linkClass}>
          <Icon name="target" />
          Mục tiêu
        </NavLink>
        <NavLink to="/investment" className={linkClass}>
          <Icon name="trendingUp" />
          Investment
        </NavLink>
        <NavLink to="/decisions" className={linkClass}>
          <Icon name="checkSquare" />
          Quyết định
          {pendingCount > 0 && <span className={s.badge}>{pendingCount}</span>}
        </NavLink>
      </nav>

      <div className={s.navLabel}>AGENT RESOURCES</div>
      <nav className={s.nav}>
        <NavLink to="/agents" className={linkClass}>
          <Icon name="users" />
          Nhân sự
        </NavLink>
        <NavLink to="/recruitment" className={linkClass}>
          <Icon name="userPlus" />
          Tuyển dụng
          {recruitCount > 0 && <span className={s.badge} title="ứng viên chờ duyệt">{recruitCount}</span>}
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
          {taskCount > 0 && <span className={s.badge} title="task đang escalated — cần CEO/CTO xử lý">{taskCount}</span>}
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
        <NavLink to="/access-tools" className={linkClass}>
          <Icon name="key" />
          Access Tools
        </NavLink>
        <NavLink to="/monitor" className={linkClass}>
          <Icon name="activity" />
          Monitor
        </NavLink>
      </nav>

      <div className={s.spacer} />
      {user && (
        <div className={s.account}>
          <div className={s.accountAvatar}>{ROLE_EMOJI[user.role] ?? '🧑‍💼'}</div>
          <div className={s.accountInfo}>
            <div className={s.accountName}>{user.displayName}</div>
            <div className={s.accountRole}>Đang đăng nhập</div>
          </div>
        </div>
      )}
      <nav className={s.nav}>
        <button className={s.item} onClick={() => void logout()}>
          <Icon name="logout" />
          Đăng xuất
        </button>
      </nav>
    </aside>
  )
}
