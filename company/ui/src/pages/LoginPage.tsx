import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Icon } from '../components/Icon'
import s from './LoginPage.module.css'

const ACCOUNTS = [
  { username: 'ceo', label: 'CEO', emoji: '👑' },
  { username: 'cto', label: 'CTO', emoji: '🛠️' },
  { username: 'coo', label: 'COO', emoji: '⚙️' },
  { username: 'cio', label: 'CIO', emoji: '🗄️' },
]

export function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('ceo')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setErr('')
    const msg = await login(username, password)
    if (msg) setErr(msg)
    setBusy(false)
  }

  return (
    <div className={s.screen}>
      <form className={s.card} onSubmit={submit}>
        <div className={s.brand}>
          <div className={s.mark}>
            <Icon name="layout" size={20} color="#fff" strokeWidth={2.2} />
          </div>
          <div>
            <div className={s.name}>AGENCY OS</div>
            <div className={s.sub}>Virtual Company Console</div>
          </div>
        </div>

        <div className={s.title}>Đăng nhập</div>
        <div className={s.hint}>Chọn tài khoản điều hành của bạn</div>

        <div className={s.accounts}>
          {ACCOUNTS.map((a) => (
            <button
              key={a.username}
              type="button"
              className={username === a.username ? `${s.acct} ${s.acctOn}` : s.acct}
              onClick={() => setUsername(a.username)}
            >
              <span className={s.acctEmoji}>{a.emoji}</span>
              <span className={s.acctLabel}>{a.label}</span>
            </button>
          ))}
        </div>

        <label className={s.field}>
          <span className={s.flabel}>Mật khẩu</span>
          <input
            className={s.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoFocus
            autoComplete="current-password"
          />
        </label>

        {err && <div className={s.err}>{err}</div>}

        <button className={s.submit} type="submit" disabled={busy || !password}>
          {busy ? 'Đang đăng nhập…' : `Đăng nhập với vai trò ${username.toUpperCase()}`}
        </button>

        <div className={s.foot}>
          4 tài khoản (CEO · CTO · COO · CIO) dùng chung quyền hạn — chỉ tách biệt danh tính đăng nhập.
          Mật khẩu đặt qua <code>AUTH_&lt;ROLE&gt;_PASSWORD</code> trong <code>company/.env.local</code>.
        </div>
      </form>
    </div>
  )
}
