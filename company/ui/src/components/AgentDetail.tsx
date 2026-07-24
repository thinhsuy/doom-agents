import type { Agent, Division } from '../types'
import { Section, drawerStyles as s } from './Drawer'
import { useCopy } from '../lib/useCopy'

export function AgentDetail({ agent }: { agent: Agent }) {
  return (
    <>
      <Section label="Mô tả vai trò">
        <div className={s.text}>{agent.description}</div>
      </Section>

      <Section label="Biên chế">
        {agent.hired ? (
          <>
            <div className={s.text}>
              <b>{agent.hiredGroup}</b> — {agent.hiredWhy}
            </div>
            <div className={`${s.note} ${s.noteOk}`}>
              Đã tuyển. Agent này nằm trong company/roster.json và sẽ được cài ở Stage 2.
            </div>
          </>
        ) : (
          <div className={`${s.note} ${s.noteWarn}`}>
            Chưa tuyển — vẫn nằm trong kho ứng viên, không được cài, không tốn gì. Thêm slug vào
            company/roster.json rồi chạy <code>npm run data</code> nếu cần dùng.
          </div>
        )}
      </Section>

      <RuntimeSection agent={agent} />

      {agent.vibe && (
        <Section label="Phong cách">
          <div className={`${s.text} ${s.quote}`}>“{agent.vibe}”</div>
        </Section>
      )}

      <Section label="Quyền tool">
        {agent.tools.length > 0 ? (
          <div className={s.chips}>
            {agent.tools.map((t) => (
              <span key={t} className="chip chipMono">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <div className={`${s.text} ${s.warn}`}>
            Chưa khai <code>tools:</code> — agent này hiện thừa hưởng toàn bộ quyền. Stage 2 của kế
            hoạch sẽ phân quyền lại.
          </div>
        )}
      </Section>

      {agent.sections.length > 0 && (
        <Section label={`Cấu trúc hồ sơ (${agent.sections.length} mục)`}>
          <div className={s.secList}>
            {agent.sections.map((sec, i) => (
              <div key={`${sec}-${i}`} className={s.secItem}>
                <span>—</span>
                {sec}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section label="Nguồn">
        <dl className={s.meta}>
          <dt>File</dt>
          <dd>
            <span className="chip chipMono">{agent.path}</span>
          </dd>
          <dt>Slug</dt>
          <dd>
            <span className="chip chipMono">{agent.slug}</span>
          </dd>
          <dt>Độ dài</dt>
          <dd>{agent.words.toLocaleString('vi-VN')} từ</dd>
        </dl>
      </Section>
    </>
  )
}

/**
 * Where this agent actually runs. Provider is a property of the installation, not of
 * the .md — the same persona can be installed into several tools. The scoping line is
 * the consequence that matters: only claude-code enforces the tool allowlist, and
 * scripts/convert.sh provably drops it for most other formats.
 */
function RuntimeSection({ agent }: { agent: Agent }) {
  const { runtime, tools } = agent

  const scoping =
    runtime.scopingConflict
      ? {
          cls: s.noteBad,
          text: `Xung đột: agent khai ${tools.length} tool, nhưng scripts/convert.sh không xuất tools: cho ${runtime.label}. Phân quyền role KHÔNG có hiệu lực trên runtime này.`,
        }
      : runtime.scoping === 'enforced'
        ? {
            cls: s.noteOk,
            text: `${runtime.label} thực thi tools:/disallowedTools: — phân quyền role có hiệu lực.`,
          }
        : runtime.scoping === 'carried'
          ? {
              cls: s.noteWarn,
              text: `${runtime.label} có nhận field tools:, nhưng chưa xác minh nó có thực thi hay không. Đừng dựa vào đây để cách ly quyền.`,
            }
          : {
              cls: s.noteWarn,
              text: `scripts/convert.sh không xuất tools: cho ${runtime.label}. Agent này chưa khai tool nào nên chưa mất gì — nhưng nếu sau này khai thì sẽ không có tác dụng.`,
            }

  return (
    <Section label="Runtime">
      <div className={s.runtimeHead}>
        <span className={s.runtimeMark} style={{ background: runtime.accent }} />
        <span className={s.runtimeName}>{runtime.label}</span>
        <span className={s.runtimeSource}>
          {runtime.assigned ? 'đã gán riêng' : 'mặc định công ty'}
        </span>
      </div>

      <dl className={s.meta}>
        <dt>Provider</dt>
        <dd>{runtime.provider}</dd>
        {runtime.tool === 'claude-code' && (
          <>
            <dt>Model</dt>
            <dd>{runtime.model}</dd>
          </>
        )}
      </dl>

      {runtime.note && <div className={`${s.note} ${s.noteWarn}`}>{runtime.note}</div>}
      <div className={`${s.note} ${scoping.cls}`}>{scoping.text}</div>
    </Section>
  )
}

export function AgentDetailFooter({ agent }: { agent: Agent }) {
  const [state, copy] = useCopy()
  return (
    <>
      <button className={`${s.btn} ${s.btnGhost}`} onClick={() => copy(agent.path)}>
        {state === 'ok' ? '✓ Đã sao chép' : state === 'fail' ? 'Không sao chép được' : 'Sao chép đường dẫn'}
      </button>
      <div className={s.footNote}>
        Hồ sơ nhân sự đọc trực tiếp
        <br />
        từ file .md trong repo
      </div>
    </>
  )
}

export function agentTitle(agent: Agent) {
  return `${agent.emoji ? agent.emoji + '  ' : ''}${agent.name}`
}

export function agentSubtitle(agent: Agent, division?: Division) {
  return `${division?.label ?? agent.division} · ${agent.slug}`
}
