import { useEffect, useState } from 'react'
import { apiUrl } from '../lib/api'
import { useAuth } from '../lib/auth'
import s from './OwnersStrip.module.css'

interface OwnerUser {
  username: string
  displayName: string
  role: string
  lastLogin: string | null
}

const ROLE_EMOJI: Record<string, string> = { CEO: '👑', CTO: '🛠️', COO: '⚙️', CIO: '🗄️' }

/** "Ban điều hành" — the 3 owner accounts (CEO/CTO/COO). Same permissions, separate
    login identity. Shown at the top of Nhân sự alongside the agent roster. */
export function OwnersStrip() {
  const { user } = useAuth()
  const [users, setUsers] = useState<OwnerUser[] | null>(null)

  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/users'), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && Array.isArray(d)) setUsers(d as OwnerUser[])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!users || users.length === 0) return null

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        Ban điều hành <span className={s.hint}>· {users.length} tài khoản · chung quyền hạn</span>
      </div>
      <div className={s.cards}>
        {users.map((u) => (
          <div key={u.username} className={u.role === user?.role ? `${s.card} ${s.cardMe}` : s.card}>
            <div className={s.avatar}>{ROLE_EMOJI[u.role] ?? '🧑‍💼'}</div>
            <div className={s.info}>
              <div className={s.name}>
                {u.displayName}
                {u.role === user?.role && <span className={s.you}>bạn</span>}
              </div>
              <div className={s.meta}>
                {u.lastLogin ? `Đăng nhập gần nhất: ${u.lastLogin}` : 'Chưa đăng nhập'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
