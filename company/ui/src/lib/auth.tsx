import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiUrl } from './api'

/** One of the 3 owner accounts. All share the same permissions — this is identity, not RBAC. */
export interface AuthUser {
  username: string
  displayName: string
  role: string
}

interface AuthCtx {
  user: AuthUser | null
  loading: boolean
  /** Returns an error message on failure, or null on success. */
  login: (username: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' })
      setUser(r.ok ? ((await r.json()) as AuthUser) : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const r = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      })
      const d = await r.json().catch(() => null)
      if (r.ok && d?.ok) {
        setUser(d.user as AuthUser)
        return null
      }
      return String(d?.detail || 'Đăng nhập thất bại')
    } catch {
      return 'Không kết nối được backend'
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' })
    } catch {
      /* offline — clear locally anyway */
    }
    setUser(null)
  }, [])

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth must be used within <AuthProvider>')
  return c
}
