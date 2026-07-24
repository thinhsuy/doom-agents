import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Channel, Message, MessageKind, MessageReaction, Workspace } from '../types'
import { agentDisplay, hiredAgents, LEAD_SLUGS, LEADS_MENTION, resolveMention, type MentionAgent } from '../lib/agents'
import { apiUrl } from '../lib/api'
import s from './TeamChatPage.module.css'
import p from '../components/Panel.module.css'

const KIND_STYLE: Record<MessageKind, { cls: string; label: string }> = {
  chat: { cls: s.kindChat, label: 'chat' },
  handoff: { cls: s.kindHandoff, label: 'bàn giao' },
  qa_verdict: { cls: s.kindQa, label: 'QA' },
  escalation: { cls: s.kindEscalation, label: 'escalate' },
  ruling: { cls: s.kindRuling, label: 'phán quyết' },
  note: { cls: s.kindNote, label: 'ghi chú' },
}

function time(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const CHAT_URL = apiUrl('/api/chat')

// Owner's per-channel last-read message id (Messenger-style unread badges).
// localStorage like the Thẻ/Cây toggle — per-browser UX state, not company data.
export const READS_KEY = 'agencyos-chat-reads'
export function loadReads(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(READS_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

export function TeamChatPanel({ workspace }: { workspace: Workspace }) {
  // Start from the static snapshot; go live off the office-server if it's running.
  const [messages, setMessages] = useState<Message[]>(workspace.messages)
  const [channels, setChannels] = useState<Channel[]>(workspace.channels)
  const [online, setOnline] = useState(false)
  const [active, setActive] = useState<string>(workspace.channels[0]?.id ?? '')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mention, setMention] = useState<{ at: number; query: string; matches: MentionAgent[]; index: number } | null>(null)
  const [reads, setReads] = useState<Record<string, number>>(loadReads)
  // Drill-in navigation (the panel is narrow): channel LIST → pick one → THREAD.
  const [view, setView] = useState<'list' | 'thread'>('list')
  // create-group modal
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTopic, setNewTopic] = useState('')
  const [newMembers, setNewMembers] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pendingRef = useRef<Set<number>>(new Set()) // ids the owner just sent, awaiting server echo

  // Live view: pull channels + messages from the FastAPI backend and keep polling
  // (every 3s) so the owner's sent messages AND agent replies show without a rebuild.
  const fetchChat = useCallback(async () => {
    try {
      const r = await fetch(CHAT_URL)
      if (!r.ok) return
      const d = await r.json()
      setOnline(true)
      if (Array.isArray(d.channels) && d.channels.length) setChannels(d.channels as Channel[])
      if (Array.isArray(d.messages)) {
        const server = d.messages as Message[]
        const serverIds = new Set(server.map((m) => m.id))
        // once the server echoes a just-sent message, stop tracking it as pending
        for (const id of [...pendingRef.current]) if (serverIds.has(id)) pendingRef.current.delete(id)
        setMessages((prev) => {
          // Server is AUTHORITATIVE when online: keep only genuinely-pending optimistic
          // sends, NOT stale rows from the static snapshot — otherwise deleted messages
          // (DB cleared) would linger on screen forever. `messages` before first fetch is
          // the offline snapshot; the first successful poll replaces it.
          const pend = prev.filter((m) => pendingRef.current.has(m.id) && !serverIds.has(m.id))
          return [...server, ...pend]
        })
      }
    } catch {
      /* backend offline — keep the snapshot; sending stays disabled */
    }
  }, [])

  useEffect(() => {
    fetchChat()
    const id = setInterval(fetchChat, 3000)
    return () => clearInterval(id)
  }, [fetchChat])

  const channelList = useMemo(() => {
    // Messenger-style: badge = UNREAD messages from AGENTS (id newer than the owner's
    // last-read cursor; the owner's own sends don't count). Purpose: nudge the CEO/CTO
    // that a staff agent replied — not a total-message count.
    const unread = new Map<string, number>()
    const present = new Set<string>()
    for (const m of messages) {
      const key = m.channelId ?? '—'
      present.add(key)
      if (m.fromAgent && m.id > (reads[key] ?? 0)) unread.set(key, (unread.get(key) ?? 0) + 1)
    }
    const list = channels.map((c) => ({ id: c.id, title: c.name, unread: unread.get(c.id) ?? 0 }))
    if (present.has('—')) list.push({ id: '—', title: 'Chung', unread: unread.get('—') ?? 0 })
    return list
  }, [messages, channels, reads])

  useEffect(() => {
    if (!channelList.find((c) => c.id === active) && channelList[0]) setActive(channelList[0].id)
  }, [channelList, active])

  const thread = useMemo(
    () =>
      messages
        .filter((m) => (m.channelId ?? '—') === active)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [messages, active],
  )
  const activeChannel = channelList.find((c) => c.id === active)
  const canSend = online && !!active && active !== '—'

  // Group scoping: with members, only members are mentionable; '@Ban lãnh đạo'
  // only where the whole leadership roster is present (or the channel is unscoped).
  const activeFull = useMemo(() => channels.find((c) => c.id === active), [channels, active])
  const activeMembers = useMemo(
    () => (activeFull?.members?.length ? activeFull.members : null),
    [activeFull],
  )
  const [confirmDel, setConfirmDel] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [editName, setEditName] = useState('')
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    setConfirmDel(false)
    setShowInfo(false)
  }, [active])
  // Prefill the rename box; a poll returning the same name won't clobber typing.
  useEffect(() => setEditName(activeFull?.name ?? ''), [activeFull?.id, activeFull?.name])

  async function renameGroup() {
    const name = editName.trim()
    if (!activeFull || !name || name === activeFull.name || renaming) return
    setRenaming(true)
    try {
      const r = await fetch(apiUrl(`/api/chat/channels/${activeFull.id}`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (r.ok) setChannels((prev) => prev.map((c) => (c.id === activeFull.id ? { ...c, name } : c)))
    } catch {
      /* backend offline */
    } finally {
      setRenaming(false)
    }
  }
  const mentionPool = useMemo(() => {
    const base = activeMembers ? hiredAgents.filter((a) => activeMembers.includes(a.slug)) : hiredAgents
    const withLeads = !activeMembers || LEAD_SLUGS.every((s) => activeMembers.includes(s))
    return withLeads ? [LEADS_MENTION, ...base] : base
  }, [activeMembers])
  const target = resolveMention(input, mentionPool) // who this message goes directly to

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [thread.length])

  // Viewing a channel marks it read: remember the highest message id on screen, so the
  // list badge for the open channel drops to 0 and stays 0 across reloads. Only while
  // the THREAD is actually on screen — sitting on the channel list must not eat unread.
  useEffect(() => {
    if (view !== 'thread') return
    const maxId = thread.reduce((m, x) => Math.max(m, x.id), 0)
    if (!active || maxId === 0) return
    setReads((r) => {
      if ((r[active] ?? 0) >= maxId) return r
      const next = { ...r, [active]: maxId }
      try {
        localStorage.setItem(READS_KEY, JSON.stringify(next))
        window.dispatchEvent(new Event('chat-reads-changed'))
      } catch {
        /* storage full — badges still correct for this session */
      }
      return next
    })
  }, [view, active, thread])

  // ---- @mention autocomplete ----
  function updateMention(value: string, caret: number) {
    const upto = value.slice(0, caret)
    const at = upto.lastIndexOf('@')
    // Trigger only if '@' is at a word boundary (start or after whitespace/punct).
    if (at === -1 || (at > 0 && /[\p{L}\p{N}_]/u.test(upto[at - 1]))) return setMention(null)
    const query = upto.slice(at + 1)
    if (query.includes('\n')) return setMention(null)
    const ql = query.toLowerCase()
    // Scoped to the group's members ('@Ban lãnh đạo' first where available).
    const matches = mentionPool
      .filter((a) => a.name.toLowerCase().includes(ql) || (a.slug === '@leads' && 'all'.includes(ql)))
      .sort((a, b) => (a.slug === '@leads' ? -1 : b.slug === '@leads' ? 1 : a.name.localeCompare(b.name)))
      .slice(0, 7)
    setMention(matches.length ? { at, query, matches, index: 0 } : null)
  }

  function selectMention(agent: MentionAgent) {
    if (!mention) return
    const before = input.slice(0, mention.at)
    const after = input.slice(mention.at + 1 + mention.query.length)
    const inserted = `${before}@${agent.name} ${after}`
    setInput(inserted)
    setMention(null)
    requestAnimationFrame(() => {
      const el = inputRef.current
      const pos = `${before}@${agent.name} `.length
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention) {
      const n = mention.matches.length
      if (e.key === 'ArrowDown') return (e.preventDefault(), setMention({ ...mention, index: (mention.index + 1) % n }))
      if (e.key === 'ArrowUp') return (e.preventDefault(), setMention({ ...mention, index: (mention.index - 1 + n) % n }))
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), selectMention(mention.matches[mention.index]))
      if (e.key === 'Escape') return (e.preventDefault(), setMention(null))
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  async function send() {
    const body = input.trim()
    if (!body || !canSend || sending) return
    const to = resolveMention(body)
    setSending(true)
    setMention(null)
    try {
      const r = await fetch(`${CHAT_URL}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: active, body, toAgent: to?.slug }),
      })
      const d = await r.json()
      if (r.ok && d.message) {
        const msg = d.message as Message
        pendingRef.current.add(msg.id) // keep it visible until the server echoes it back
        setMessages((prev) => [...prev, msg])
        setInput('')
        if (d.replying) setTimeout(fetchChat, 1500) // pull the agent's reply sooner
      }
    } catch {
      /* ignore network error */
    } finally {
      setSending(false)
    }
  }

  // Compose box grows with content up to ~5 lines (then scrolls inside), so the
  // owner can draft multi-line markdown before sending (Shift+Enter = newline).
  const COMPOSER_MAX = 118 // px ≈ 5 lines
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX)}px`
  }, [input, view])

  // Owner toggles a reaction; the ~300ms refresh pulls the authoritative state.
  async function react(messageId: number, emoji: string) {
    if (!online) return
    try {
      await fetch(apiUrl('/api/chat/react'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId, emoji }),
      })
      fetchChat()
    } catch {
      /* backend offline */
    }
  }

  async function deleteGroup() {
    if (!activeFull || activeFull.kind !== 'topic') return
    try {
      const r = await fetch(apiUrl(`/api/chat/channels/${activeFull.id}`), { method: 'DELETE' })
      if (r.ok) {
        const gone = activeFull.id
        setChannels((prev) => prev.filter((c) => c.id !== gone))
        setMessages((prev) => prev.filter((m) => m.channelId !== gone))
        setConfirmDel(false)
        setShowInfo(false)
        setView('list') // active falls back to the first remaining channel via effect
      }
    } catch {
      /* backend offline */
    }
  }

  async function createGroup() {
    if (!newName.trim() || newMembers.size === 0 || creating) return
    setCreating(true)
    setCreateErr('')
    try {
      const r = await fetch(apiUrl('/api/chat/channels'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          topic: newTopic.trim() || undefined,
          members: [...newMembers],
        }),
      })
      const d = await r.json()
      if (r.ok && d.channel) {
        setChannels((prev) => [...prev, d.channel as Channel])
        setActive(d.channel.id)
        setShowNew(false)
        setNewName('')
        setNewTopic('')
        setNewMembers(new Set())
      } else {
        setCreateErr(String(d.detail || 'không tạo được nhóm'))
      }
    } catch {
      setCreateErr('Cần backend chạy để tạo nhóm')
    } finally {
      setCreating(false)
    }
  }

  if (channelList.length === 0) {
    return (
      <div className={s.panel}>
        <div className={p.empty}>
          Chưa có kênh chat nào. Team Chat đọc từ <code>company.channels</code> / <code>messages</code>.
        </div>
      </div>
    )
  }

  return (
    <div className={s.panel}>
      {view === 'list' ? (
        <div className={s.listView}>
          <div className={s.railHead}>
            <span>Kênh</span>
            <button
              className={s.newBtn}
              onClick={() => setShowNew(true)}
              disabled={!online}
              title={online ? 'Tạo nhóm chat mới' : 'Cần backend chạy để tạo nhóm'}
            >
              ＋ Nhóm
            </button>
          </div>
          <div className={s.channelScroll}>
            {channelList.map((c) => (
              <button
                key={c.id}
                className={s.channel}
                onClick={() => {
                  setActive(c.id)
                  setView('thread')
                }}
              >
                <span className={s.hash}>#</span>
                <span className={s.channelBody}>
                  <span className={c.unread ? `${s.channelName} ${s.channelNameUnread}` : s.channelName}>
                    {c.title}
                  </span>
                  <span className={s.channelSub}>{c.id}</span>
                </span>
                {c.unread > 0 && <span className={s.channelUnread}>{c.unread > 99 ? '99+' : c.unread}</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={s.thread}>
          <div className={s.threadHead}>
            <div className={s.threadHeadTop}>
              <button className={s.backBtn} onClick={() => setView('list')} title="Về danh sách kênh">
                ←
              </button>
              <div className={s.threadHeadMain}>
                <div className={s.threadTitle}># {activeChannel?.title ?? active}</div>
                <div className={s.threadSub}>
                  {thread.length} tin nhắn
                  {activeMembers ? <> · 👥 {activeMembers.length} thành viên</> : <> · bạn (CEO/CTO) và các agent</>}
                </div>
              </div>
              {activeFull && active !== '—' && (
                <div className={s.groupPopWrap}>
                  <button
                    className={showInfo ? `${s.infoBtn} ${s.infoBtnOn}` : s.infoBtn}
                    onClick={() => {
                      setShowInfo((v) => !v)
                      setConfirmDel(false)
                    }}
                    title={activeFull.kind === 'topic' ? 'Thông tin nhóm' : 'Thông tin kênh'}
                  >
                    !
                  </button>
                  {showInfo && (
                    <>
                      <div
                        className={s.popBackdrop}
                        onClick={() => {
                          setShowInfo(false)
                          setConfirmDel(false)
                        }}
                      />
                      <div className={s.groupPop}>
                        {activeFull.kind === 'topic' ? (
                          <>
                            <div className={s.popTitle}>Thông tin nhóm</div>
                            <div className={s.popLabel}>Tên nhóm</div>
                            <div className={s.renameRow}>
                              <input
                                className={s.popInput}
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                disabled={!online}
                              />
                              <button
                                className={s.popSave}
                                onClick={renameGroup}
                                disabled={!online || renaming || !editName.trim() || editName.trim() === activeFull.name}
                              >
                                {renaming ? '…' : 'Lưu'}
                              </button>
                            </div>
                            <div className={s.popLabel}>👥 Thành viên ({activeMembers?.length ?? 0})</div>
                            <div className={s.popMembers}>
                              {(activeMembers ?? []).map((slug) => {
                                const who = agentDisplay(slug)
                                return (
                                  <div key={slug} className={s.popMember} title={slug}>
                                    <span className={s.memberChipEmoji}>{who.emoji}</span>
                                    <span className={s.popMemberName}>{who.name}</span>
                                  </div>
                                )
                              })}
                              {!activeMembers && <div className={s.popEmpty}>Nhóm chưa có thành viên.</div>}
                            </div>
                            <div className={s.popDanger}>
                              {confirmDel ? (
                                <div className={s.threadActions}>
                                  <button className={s.delConfirm} onClick={deleteGroup} disabled={!online}>
                                    Xoá vĩnh viễn nhóm + tin nhắn?
                                  </button>
                                  <button className={s.delCancel} onClick={() => setConfirmDel(false)}>Huỷ</button>
                                </div>
                              ) : (
                                <button className={s.delBtn} onClick={() => setConfirmDel(true)} disabled={!online}>
                                  🗑 Xoá nhóm
                                </button>
                              )}
                            </div>
                          </>
                        ) : (
                          // Engagement channel: read-only — its name/lifecycle belong to
                          // the engagement record, and it has no member scoping.
                          <>
                            <div className={s.popTitle}>Thông tin kênh</div>
                            <div className={s.popLabel}>Tên kênh</div>
                            <input className={s.popInput} value={activeFull.name} disabled />
                            <div className={s.popEngNote}>
                              Kênh của engagement <b>{activeFull.engagementId ?? activeFull.id}</b> — tên và
                              vòng đời quản lý theo engagement, không đổi tên/xoá tại đây.
                            </div>
                            <div className={s.popLabel}>👥 Thành viên</div>
                            <div className={s.popEmpty}>
                              Kênh mở — không giới hạn thành viên: tag được mọi agent biên chế; tin không
                              tag sẽ không tự trigger ai.
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className={s.stream} ref={streamRef}>
            {thread.length === 0 ? (
              <div className={s.threadEmpty}>Chưa có tin trong kênh này — gõ bên dưới để bắt đầu.</div>
            ) : (
              thread.map((m) => <ChatMessage key={m.id} message={m} onReact={online ? react : undefined} />)
            )}
          </div>
          <div className={s.composer}>
            {canSend ? (
              <div className={s.composerBox}>
                {mention && mention.matches.length > 0 && (
                  <div className={s.mentionMenu}>
                    {mention.matches.map((a, i) => (
                      <button
                        key={a.slug}
                        className={i === mention.index ? `${s.mentionItem} ${s.mentionOn}` : s.mentionItem}
                        onMouseDown={(e) => {
                          e.preventDefault() // keep input focus so the menu doesn't blur-close first
                          selectMention(a)
                        }}
                      >
                        <span className={s.mentionAvatar} style={{ background: `${a.color}22` }}>{a.emoji}</span>
                        <span className={s.mentionName}>{a.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className={s.composerRow}>
                  <textarea
                    ref={inputRef}
                    className={s.composerInput}
                    value={input}
                    rows={1}
                    onChange={(e) => {
                      setInput(e.target.value)
                      updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={`Nhắn vào #${activeChannel?.title ?? ''} · @ tag agent · Shift+Enter xuống dòng`}
                    disabled={sending}
                  />
                  <button className={s.composerSend} onClick={send} disabled={sending || !input.trim()}>
                    {sending ? '…' : 'Gửi'}
                  </button>
                </div>
                {target ? (
                  <div className={s.composerTarget}>
                    {target.slug === '@leads' ? (
                      <>→ giao việc cho <b>cả Ban lãnh đạo</b> · từng lead sẽ phân tích, tạo task và trả lời</>
                    ) : (
                      <>→ gửi thẳng tới <b>@{target.name}</b> · agent sẽ trả lời bạn</>
                    )}
                  </div>
                ) : activeMembers && input.trim() ? (
                  <div className={s.composerTarget}>
                    → không tag ai = hỏi <b>cả nhóm</b> ({activeMembers.length} thành viên) · ai có thông tin sẽ trả lời
                  </div>
                ) : null}
              </div>
            ) : (
              <div className={s.composerOffline}>
                {active === '—'
                  ? 'Chọn một kênh thật để nhắn.'
                  : 'Chạy backend để gửi tin: cd company/api && ./.venv/bin/uvicorn main:app --port 8000'}
              </div>
            )}
          </div>
        </div>
      )}

      {showNew && (
        <div className={s.overlay} onClick={() => setShowNew(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalTitle}>Tạo nhóm chat</div>
            <input
              className={s.modalInput}
              placeholder="Tên nhóm (vd: Squad thanh toán)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <input
              className={s.modalInput}
              placeholder="Chủ đề (tuỳ chọn)"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
            />
            <div className={s.memberHead}>
              Thành viên · {newMembers.size} đã chọn — chỉ mention & trigger được người trong nhóm
            </div>
            <div className={s.memberList}>
              {[...hiredAgents]
                .sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name))
                .map((a) => (
                  <label key={a.slug} className={s.memberItem}>
                    <input
                      type="checkbox"
                      checked={newMembers.has(a.slug)}
                      onChange={(e) => {
                        setNewMembers((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(a.slug)
                          else next.delete(a.slug)
                          return next
                        })
                      }}
                    />
                    <span className={s.memberAvatar} style={{ background: `${a.color}22` }}>{a.emoji}</span>
                    <span className={s.memberName}>{a.name}</span>
                    <span className={s.memberDiv}>{a.division}</span>
                  </label>
                ))}
            </div>
            {createErr && <div className={s.modalErr}>{createErr}</div>}
            <div className={s.modalActions}>
              <button className={s.modalGhost} onClick={() => setShowNew(false)}>Huỷ</button>
              <button
                className={s.modalPrimary}
                onClick={createGroup}
                disabled={creating || !newName.trim() || newMembers.size === 0}
              >
                {creating ? 'Đang tạo…' : 'Tạo nhóm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const REACT_EMOJI = ['👍', '✅', '❤️', '😂', '🎉', '👀', '🚀']

const TIP_W = 200 // must match .tip max-width so clamping keeps it on-screen

/** A reaction chip whose "who reacted" tooltip is portalled to <body> with
    position:fixed, so the scrollable message list can't clip it (the bug: an
    absolute tooltip on a top message was cut off by .stream's overflow). It
    flips below the chip when there isn't room above. */
function ReactionChip({ reaction, onToggle }: { reaction: MessageReaction; onToggle?: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null)

  function open() {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = r.top < 220 // not enough room above → drop below the chip
    const x = Math.max(8, Math.min(r.left, window.innerWidth - TIP_W - 8))
    setTip({ x, y: below ? r.bottom + 8 : r.top - 8, below })
  }
  const close = () => setTip(null)

  return (
    <span
      ref={ref}
      className={s.reactionWrap}
      tabIndex={0}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      <span
        className={tip ? `${s.reaction} ${s.reactionOn}` : s.reaction}
        onClick={onToggle}
        style={onToggle ? { cursor: 'pointer' } : undefined}
        title={onToggle ? 'Bấm để thả/bỏ cảm xúc này' : undefined}
      >
        {reaction.emoji} {reaction.agents.length}
      </span>
      {tip &&
        createPortal(
          <div
            className={tip.below ? `${s.tip} ${s.tipBelow}` : s.tip}
            style={{ left: tip.x, top: tip.y }}
            role="tooltip"
          >
            <span className={s.tipEmoji}>{reaction.emoji}</span>
            <span className={s.tipList}>
              {reaction.agents.map((slug) => {
                const who = agentDisplay(slug)
                return (
                  <span key={slug} className={s.tipAgent}>
                    <span className={s.tipAvatar}>{who.emoji}</span>
                    {who.name}
                  </span>
                )
              })}
              <span className={s.tipVerb}>đã react</span>
            </span>
          </div>,
          document.body,
        )}
    </span>
  )
}

function ChatMessage({
  message,
  onReact,
}: {
  message: Message
  onReact?: (id: number, emoji: string) => void
}) {
  const from = agentDisplay(message.fromAgent)
  const to = agentDisplay(message.toAgent)
  const kind = KIND_STYLE[message.kind]
  const [palette, setPalette] = useState(false)
  return (
    <div className={s.msg}>
      <div className={s.msgAvatar} style={{ background: `${from.color}22` }}>
        {from.emoji}
      </div>
      <div className={s.msgBody}>
        <div className={s.msgTop}>
          <span className={s.msgFrom}>{from.name}</span>
          <span className={s.msgTo}>→ {to.name}</span>
          <span className={`${s.kind} ${kind.cls}`}>{kind.label}</span>
          <span className={s.msgTime}>{time(message.createdAt)}</span>
        </div>
        <div className={s.msgText}>
          {/* Agents reply in markdown (bold, lists, tables) — render it instead of
              showing raw **stars**. react-markdown emits React elements (no
              innerHTML), so message content stays XSS-safe by construction. */}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
        </div>
        {message.taskId && <span className={s.msgTask}>↳ {message.taskId}</span>}
        {(message.reactions || onReact) && (
          <div className={s.reactions}>
            {message.reactions?.map((r) => (
              <ReactionChip
                key={r.emoji}
                reaction={r}
                onToggle={onReact ? () => onReact(message.id, r.emoji) : undefined}
              />
            ))}
            {onReact && (
              <span className={s.reactAddWrap}>
                <button
                  className={s.reactAdd}
                  onClick={() => setPalette((p) => !p)}
                  title="Thả cảm xúc"
                >
                  ☺+
                </button>
                {palette && (
                  <span className={s.palette}>
                    {REACT_EMOJI.map((e) => (
                      <button
                        key={e}
                        className={s.paletteBtn}
                        onClick={() => {
                          onReact(message.id, e)
                          setPalette(false)
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
