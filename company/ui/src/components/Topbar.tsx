import { Icon } from './Icon'
import s from './Topbar.module.css'

interface Props {
  query: string
  onQueryChange: (q: string) => void
}

export function Topbar({ query, onQueryChange }: Props) {
  return (
    <header className={s.topbar}>
      <h1 className={s.greeting}>Chào CEO &amp; CTO 👋</h1>

      <div className={s.search}>
        <Icon name="search" size={15} color="#a8aec4" strokeWidth={2.2} />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Tìm nhân sự, quyết định…"
          aria-label="Tìm kiếm"
        />
      </div>

      <div className={s.divider} />
      <button className={s.iconBtn} title="Tin nhắn" aria-label="Tin nhắn">
        <Icon name="message" />
      </button>
      <button className={s.iconBtn} title="Thông báo" aria-label="Thông báo">
        <Icon name="bell" />
      </button>

      <div className={s.user}>
        <div className={s.avatar}>CT</div>
        <div className={s.userName}>CEO / CTO</div>
        <Icon name="chevronDown" size={12} color="#8a90a8" strokeWidth={2.6} />
      </div>
    </header>
  )
}
