import type { Workspace } from '../types'
import { Icon } from './Icon'
import s from './DecisionTable.module.css'

// The seeded demo engagement. The banner warns only when the sample engagement
// still has sample CONTENT (tasks or messages) — an empty board/chat is real
// (just empty), so don't cry "sample" over it. This lets the sample engagement
// stay for Monitor/Decisions while the Task+Chat tabs read as genuinely cleared.
export const SAMPLE_ENGAGEMENT_ID = 'ENG-001'

export function isSample(workspace: Workspace): boolean {
  if (!workspace.engagements.some((e) => e.id === SAMPLE_ENGAGEMENT_ID)) return false
  const sampleTasks = workspace.tasks.some((t) => t.engagementId === SAMPLE_ENGAGEMENT_ID)
  const sampleMsgs = workspace.messages.some(
    (m) => m.engagementId === SAMPLE_ENGAGEMENT_ID || m.channelId === SAMPLE_ENGAGEMENT_ID,
  )
  return sampleTasks || sampleMsgs
}

export function SampleNotice({ workspace }: { workspace: Workspace }) {
  if (!isSample(workspace)) return null
  return (
    <div className={s.notice}>
      <Icon name="info" size={17} strokeWidth={2} />
      <div>
        <b>Dữ liệu mẫu.</b> Engagement <code>{SAMPLE_ENGAGEMENT_ID}</code> là ví dụ để minh hoạ
        các tab Workspace — dữ liệu thật (từ <code>company.messages</code>, <code>company.tasks</code>)
        sẽ thay thế khi một engagement thật chạy ở Stage 3. Xoá mẫu:{' '}
        <code>DELETE FROM company.engagements WHERE id='{SAMPLE_ENGAGEMENT_ID}'</code> rồi{' '}
        <code>npm run data</code>.
      </div>
    </div>
  )
}
