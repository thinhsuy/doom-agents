# Agency MCP

MCP server làm **nơi các agent staff làm việc với nhau**: (1) kênh giao tiếp — tạo group
chat, gửi tin, react, đọc chat; (2) thao tác **task ticket** — đổi status, comment, tag
agent, giao PIC, đổi ưu tiên. Tất cả ghi vào `company.*` trong Postgres.

Đây là câu trả lời cho "agent liên lạc với nhau bằng gì" (D2): thay vì mailbox tạm của
Agent Teams (không sống sót qua session), kênh chat này **bền vững trong Postgres** và
mọi tin đều là bản ghi kiểm toán được.

## Vì sao dùng MCP, không phải cho agent chạy `psql`

Từng cân nhắc: cho agent `Bash` + psql là mất phân quyền role (agent chạy được SQL bất kỳ,
kể cả xoá tin của agent khác). MCP server bọc các thao tác thành **tool có phạm vi** —
agent chỉ làm được đúng những gì tool cho phép.

## Danh tính ở phía server — không giả mạo được

Agent đang thao tác được đọc từ biến môi trường **`AGENT_SLUG`**, KHÔNG phải từ tham số
tool. Nên một agent không thể gửi/react dưới danh nghĩa agent khác. Mỗi agent chạy một
instance server riêng với `AGENT_SLUG` của mình. `AGENT_SLUG` để trống = owner (CEO/CTO).

Đã kiểm chứng end-to-end: `npm run smoke` (24 check, hai danh tính chat + thao tác task ticket).

## Tool

**Chat — giao tiếp giữa agent**

| Tool | Việc |
|---|---|
| `whoami` | Trả về danh tính đang thao tác |
| `list_agents` | Roster agent biên chế để nhắn tin (slug + tên + nhóm) |
| `list_channels` | Kênh đang mở + số tin + số chưa đọc (theo bạn) |
| `create_channel` | Tạo group chat dự án → trả về channel id |
| `read_channel` | Đọc tin mới nhất (kèm reaction + AI/staff nào đã react) + đánh dấu đã đọc |
| `send_message` | Gửi tin vào kênh (kind: chat/handoff/qa_verdict/escalation/ruling/note) |
| `react` | Bật/tắt reaction emoji trên một tin |

**Task ticket — agent theo dõi & thao tác công việc**

| Tool | Việc |
|---|---|
| `list_tasks` | Liệt kê ticket (lọc theo engagement/status/assignee; `mine=true` = ticket của bạn) |
| `get_task` | Chi tiết đầy đủ 1 ticket: PIC, reporter, status, priority, mô tả, comment, lịch sử |
| `update_task_status` | Đổi status; ghi vào audit log là bạn. Vào `rejected` (QA fail) → +1 lượt thử (cap 3) |
| `comment_task` | Thêm comment vào ticket; `mentions` để **tag agent** (vd tag manager) |
| `assign_task` | Giao lại PIC cho một agent (kèm ghi chú) |
| `set_task_priority` | Đổi ưu tiên (low/medium/high/urgent) |

Status change ghi vào `company.status_events` (nhật ký hoạt động), comment vào
`company.task_comments`. Danh tính người đổi/comment luôn là `AGENT_SLUG` — không mạo danh được.

## Chạy

```bash
cd company/mcp
npm install
AGENT_SLUG=engagement-director npm start   # stdio MCP server, đóng vai Engagement Director
npm run smoke                              # kiểm thử end-to-end (tự dọn)
```

Kết nối DB **qua `docker exec psql`** vào container `ocb_ai_assistant-db-1` (đọc từ
`company/.env.local`). Lý do: DB nằm trong container của project khác, và host `127.0.0.1:5432`
đang bị một postgresql@16 native chiếm — nên `pg` driver TCP không tới được container; docker
exec là đường đi hoạt động (giống `dbio.py`).

## Gắn vào một agent (Stage 2)

Trong `.claude/agents/<slug>.md`, khai MCP server với `AGENT_SLUG` của chính agent đó —
đây là chỗ danh tính được cố định:

```yaml
---
name: Engagement Director
tools: Read, Write, Edit, Grep, Glob, WebSearch, WebFetch
mcpServers:
  agency-chat:
    command: node
    args: ["/Users/thinhsuyluy/Desktop/ThinhSuyLuy/doom-agents/company/mcp/index.mjs"]
    env:
      AGENT_SLUG: engagement-director
---
```

Mỗi agent một khối như vậy, chỉ khác `AGENT_SLUG`. Khi đó agent gọi được `send_message`,
`react`, `read_channel`… và không thể mạo danh agent khác.

## Console chỉ là snapshot

MCP server ghi **trực tiếp** vào Postgres (live). Console (`company/ui`) là trang tĩnh đọc
snapshot sinh lúc `npm run data`. Sau khi agent chat, chạy lại `npm run data` để console
hiện tin/kênh/reaction mới. Muốn console live thì cần backend — ngoài phạm vi hiện tại.
