import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiUrl } from './api'
import { fmtUsd, fmtVnd, USD_VND } from './format'

// Global display currency. Costs (LLM/infra/budget) are USD-native; user-declared amounts
// (investments, goal revenue) are VND-native — money() takes the value's NATIVE unit and
// renders it in whatever the user has toggled, using a LIVE rate from a no-key FX API
// (backend /api/fx, cached). Rounded both ways so the UI never overflows.

export type Unit = 'usd' | 'vnd'
export type FxSource = 'open-er-api' | 'vietcombank' | 'fawaz'
type Native = 'usd' | 'vnd'
type Status = 'loading' | 'live' | 'stale' | 'fallback'

export const FX_SOURCES: { id: FxSource; label: string }[] = [
  { id: 'open-er-api', label: 'open.er-api.com · thị trường' },
  { id: 'vietcombank', label: 'Vietcombank · giá bán' },
  { id: 'fawaz', label: 'fawazahmed0 · thị trường' },
]

interface Ctx {
  unit: Unit
  setUnit: (u: Unit) => void
  toggleUnit: () => void
  source: FxSource
  setSource: (s: FxSource) => void
  rate: number // USD → VND
  asOf: string | null
  status: Status
  refresh: () => void
  /** Format an amount (in its NATIVE currency) in the currently-selected display unit. */
  money: (amount: number, native?: Native) => string
  /** An amount typed in the current unit → USD (for saving USD-native edits). */
  toUsd: (amountInCurrentUnit: number) => number
  /** A USD amount → the current display unit (for pre-filling USD-native edit inputs). */
  toCurrentUnit: (usd: number) => number
  unitSymbol: string
}

const C = createContext<Ctx | null>(null)
const LS_UNIT = 'agency.currency.unit'
const LS_SRC = 'agency.currency.source'
const LS_RATE = 'agency.currency.rate'

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [unit, setUnitState] = useState<Unit>(() => (localStorage.getItem(LS_UNIT) as Unit) || 'vnd')
  const [source, setSourceState] = useState<FxSource>(
    () => (localStorage.getItem(LS_SRC) as FxSource) || 'open-er-api',
  )
  // Seed from the last-known rate (instant on reload), then refresh from the API.
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem(LS_RATE)) || USD_VND)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  function load(src: FxSource) {
    setStatus('loading')
    fetch(apiUrl(`/api/fx?source=${src}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.usdVnd) {
          setStatus('fallback')
          return
        }
        setRate(d.usdVnd)
        setAsOf(d.asOf ?? null)
        setStatus(d.fallback ? 'fallback' : d.stale ? 'stale' : 'live')
        localStorage.setItem(LS_RATE, String(d.usdVnd))
      })
      .catch(() => setStatus('fallback'))
  }
  useEffect(() => {
    load(source)
  }, [source])

  const value = useMemo<Ctx>(() => {
    const setUnit = (u: Unit) => {
      setUnitState(u)
      localStorage.setItem(LS_UNIT, u)
    }
    const setSource = (srv: FxSource) => {
      setSourceState(srv)
      localStorage.setItem(LS_SRC, srv)
    }
    const money = (amount: number, native: Native = 'usd') => {
      const usd = native === 'vnd' ? amount / rate : amount
      return unit === 'usd' ? fmtUsd(usd) : fmtVnd(usd * rate)
    }
    return {
      unit,
      setUnit,
      toggleUnit: () => setUnit(unit === 'vnd' ? 'usd' : 'vnd'),
      source,
      setSource,
      rate,
      asOf,
      status,
      refresh: () => load(source),
      money,
      toUsd: (amt: number) => (unit === 'vnd' ? amt / rate : amt),
      toCurrentUnit: (usd: number) => (unit === 'vnd' ? usd * rate : usd),
      unitSymbol: unit === 'vnd' ? '₫' : '$',
    }
  }, [unit, source, rate, asOf, status])

  return <C.Provider value={value}>{children}</C.Provider>
}

export function useCurrency(): Ctx {
  const c = useContext(C)
  if (!c) throw new Error('useCurrency must be used within CurrencyProvider')
  return c
}
