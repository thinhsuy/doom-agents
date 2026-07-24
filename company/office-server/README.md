# Office Server — live backend for the "virtual office"

Đây là **backend sống đầu tiên** của console. Mọi thứ khác trong `company/ui` là
snapshot tĩnh sinh lúc build (`npm run data`). Một văn phòng pixel phản ứng **thời gian
thực** thì cần nguồn sự kiện đang chạy + kênh push — đó là server này.

## Làm gì

1. **Tail Postgres** — poll `company.messages` / `company.status_events` /
   `company.task_comments` theo `id` (mỗi `OFFICE_POLL_MS`, mặc định 1s) và đẩy delta
   qua **WebSocket** `ws://localhost:5210/office`. Office animate theo: agent nhắn nhau →
   đi tới bàn nhau + bong bóng; đổi status task → anim ✅/❌/🔍; comment/mention → ping.
2. **Nhận Claude Code hooks** — `POST /hook` với `{agent, phase, tool}` để tool-use của
   session đang chạy điều khiển "đang gõ / đang đọc" mịn cho agent đó (nguồn thứ 2).
3. **Lưu config Office bền** — `GET /config/floors` trả về map `{division: floorIndex}`,
   `POST /config/floors {slug, index}` upsert vào `company.office_config`. Đây là chỗ lựa
   chọn sàn từng phòng ban được ghi vào DB (sống qua session/máy khác). CORS `*` để console
   (origin Vite) đọc/ghi được.
4. **Team Chat cho owner** — `GET /chat` trả về `{channels, messages}` live (đúng shape
   workspace.json); `POST /chat/send {channel, body, toAgent?, kind?}` chèn một tin **as owner**
   (`from_agent = NULL` = CEO/CTO). Đây là cách chủ công ty chat trong tab Team Chat mà không
   cần rebuild. Agent thì chat qua MCP (`company/mcp`), không qua endpoint này.

Front-end chỉ dùng WS cho **trạng thái động**; sơ đồ bàn/nhân sự lấy từ `agents.json` tĩnh
đã bundle sẵn — nên server này gọn.

## Chạy

```bash
cd company/office-server
npm install      # chỉ 1 dependency: ws
npm start        # ws://localhost:5210/office  (+ GET /health, POST /hook)
npm run smoke    # kiểm thử end-to-end: insert Postgres → nhận qua WebSocket (tự dọn)
```

Biến môi trường: `OFFICE_PORT` (5210), `OFFICE_POLL_MS` (1000).

## Vì sao poll qua `docker exec psql`

Giống `company/mcp` và `dbio.py`: host `127.0.0.1:5432` bị một postgresql@16 native chiếm,
container không route được trên Docker Desktop Mac → driver TCP không tới. `docker exec psql`
là đường đi hoạt động. Poll theo `max(id)` đơn giản và chắc; `LISTEN/NOTIFY` là tối ưu sau.

## Kiểm chứng

`npm run smoke` (7 check): spawn server thật → client WebSocket thật → INSERT
`company.messages` và `company.status_events` → khẳng định nhận đúng event kèm `from→to`
và `assignee` (thứ animation cần), rồi xoá sạch. Không mock.

## Bảo mật / phạm vi

Chỉ **đọc** company.* để phát; ghi vẫn qua MCP có phân quyền (`company/mcp`). `/hook` chỉ
fan-out event, không ghi DB. Đây là công cụ dev nội bộ — chưa có auth trên WS/HTTP; đừng
expose ra ngoài localhost.
