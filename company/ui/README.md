# Agency OS — Console

Console quản lý công ty ảo. React 19 + TypeScript + Vite, CSS Modules.

## Chạy

```bash
cd company/ui
npm install
npm run dev          # http://localhost:5183
```

| Lệnh | Việc |
|---|---|
| `npm run dev` | sinh data rồi chạy dev server |
| `npm run build` | sinh data → typecheck → build vào `dist/` |
| `npm run preview` | serve bản `dist/` đã build |
| `npm run data` | chỉ sinh lại `src/data/agents.json` |
| `npm run typecheck` | chỉ chạy `tsc` |

`dev` và `build` tự chạy `build.py` trước, nên roster không bao giờ bị cũ.

## Kiến trúc

```
src/
  main.tsx              entry — HashRouter
  App.tsx               shell + routes, giữ state ô tìm kiếm
  types.ts              Agent, Division, Decision…
  data/
    agents.json         GENERATED — gitignored
    decisions.ts        seed thủ công, có type
  components/           Sidebar, Topbar, StatCard, AgentDirectory,
                        DecisionTable, Drawer, AgentDetail, DecisionDetail, Icon
  pages/                AgentsPage, DecisionsPage
  styles/               tokens.css (design token), global.css
  lib/                  color.ts (tint), useCopy.ts
build.py                trích roster từ repo
```

Design token nằm ở `src/styles/tokens.css` — đổi màu/bo góc/shadow ở đó, không sửa rải rác
trong component.

## Trang Nhân sự — hai kiểu hiển thị

Nút gạt **Thẻ / Cây** ở header panel. Mặc định là Thẻ; lựa chọn lưu vào `localStorage`
(`agency-os.directory-view`). Cả hai đều giữ nhóm theo phòng ban — đó chính là sơ đồ tổ chức.

- **Thẻ** — lưới card: avatar tròn, tên, phòng ban, "Xem hồ sơ".
- **Cây** — danh sách dòng, hiện thêm mô tả đầy đủ. Hợp khi cần quét nhanh nhiều agent.

**Chấm trạng thái trên card không phải đèn "online".** Agent không có trạng thái online, nên
chấm đó báo **phân quyền hiệu lực thực tế**:

| Chấm | Nghĩa |
|---|---|
| 🟢 xanh | Có khai `tools:` và runtime thực thi được |
| 🟡 vàng | Có khai `tools:` nhưng runtime hiện tại **bỏ mất** — phân quyền vô hiệu |
| ⚪ xám | Chưa khai `tools:` |

## Biên chế — `company/roster.json`

251 agent trong catalog là **kho ứng viên**, không phải biên chế. `roster.json` liệt kê ai
thực sự được tuyển. Nút gạt **Đã tuyển / Toàn bộ** ở header panel (mặc định "Đã tuyển",
lưu localStorage). Ở chế độ "Toàn bộ", người chưa tuyển bị làm mờ.

Tuyển thêm: thêm slug vào `hired` rồi `npm run data`. `build.py` báo lỗi nếu slug không
khớp file agent nào — tránh tuyển hụt vì gõ sai.

**Không file agent nào bị xoá.** Xoá cả một division sẽ phá đồng bộ `divisions.json` ↔ thư
mục và làm hỏng CI `check-divisions.sh`, đồng thời khiến việc sync upstream về sau rất khổ.
Tuyển/sa thải thì đảo ngược được, xoá thì không.

## Runtime — agent nào chạy trên tool/provider nào

Provider **không phải** thuộc tính của file agent `.md`. Cùng một persona có thể cài vào
nhiều tool; provider là thuộc tính của **nơi cài**. Nên nó nằm ở `company/runtimes.json`
(tầng company), không bao giờ nằm trong frontmatter của catalog.

Claude Code chỉ nhận model Claude ở `model:` (`opus`/`sonnet`/`haiku`/`fable`/`inherit`).
Cho một agent chạy bằng GPT nghĩa là **cài nó vào Codex**, không phải đổi một field.

Mặc định công ty là `claude-code`. Gán riêng bằng cách thêm vào `assignments`:

```json
"assignments": {
  "marketing-growth-hacker": { "runtime": "codex", "note": "lý do" },
  "engineering-data-engineer": { "runtime": "gemini-cli" },
  "product-owner": { "runtime": "claude-code", "model": "opus" }
}
```

Rồi `npm run data`. Card sẽ hiện chip runtime (loại gán riêng tô đậm hơn mặc định), drawer
có mục **Runtime** với provider, model và hệ quả phân quyền.

### Cảnh báo phân quyền — đọc từ `scripts/convert.sh`

| Nhóm | Runtime | Điều gì xảy ra với `tools:` |
|---|---|---|
| `enforced` | claude-code | Thực thi thật (theo tài liệu Claude Code) |
| `carried` | qwen, zcode, copilot | Field được giữ, **chưa xác minh** tool có thực thi |
| `dropped` | codex, gemini-cli, cursor, vibe, kimi, opencode, aider, windsurf, openclaw, osaurus, antigravity, hermes | `convert.sh` **không xuất** `tools:` — phân quyền mất |

Chỉ 2/16 converter xuất `tools:` (`convert_qwen`, `convert_zcode`). Nếu một agent khai
`tools:` mà bị gán vào runtime nhóm `dropped`, `build.py` in cảnh báo và console tô chấm
vàng + hiện khối đỏ trong drawer. Kiểm lại bảng này nếu converter thay đổi.

## Data

`src/data/agents.json` là **file sinh ra**, đã gitignore. `build.py` đọc mọi `.md` trong 17
thư mục division cộng `divisions.json`, trích frontmatter (name, description, emoji, color,
vibe, tools) và danh sách section header.

Nó **bỏ qua heading nằm trong fenced code block** — các file agent nhúng ví dụ deliverable
có `##` riêng; đó là nội dung mẫu chứ không phải section của tài liệu. Không lọc thì
Engagement Director hiện 25 mục thay vì 8.

Chạy lại sau khi thêm/sửa/xoá agent:

```bash
npm run data
```

## Route

Dùng `HashRouter` để bản build chạy được ở bất kỳ đường dẫn tĩnh nào mà không cần
rewrite rule phía server.

| Route | Mở |
|---|---|
| `#/agents` | tab Nhân sự |
| `#/agents/:slug` | hồ sơ nhân sự, vd `#/agents/engagement-director` |
| `#/decisions` | tab Quyết định |
| `#/decisions/:id` | chi tiết quyết định, vd `#/decisions/D1` |
| `#/workspace/chat` | Team Chat — tin nhắn giữa agent (`company.messages`) |
| `#/workspace/office` | Office — placeholder, build sau |
| `#/workspace/tasks` | Tasks — bảng kiểu Jira (`company.tasks`) |
| `#/providers` | Providers — gán runtime/provider cho agent |
| `#/monitor` | Monitor — throughput + tokens + estimate cost |

Drawer là trạng thái route, không phải state cục bộ — nên link chia sẻ được, và nút
back của trình duyệt đóng drawer đúng như mong đợi.

## Workspace — nơi agent làm việc với nhau

Ba tab đọc từ `src/data/workspace.json` (sinh từ Postgres: `company.engagements` +
`tasks` + `messages`).

- **Team Chat** — kênh = engagement; luồng tin nhắn có avatar agent, from→to, loại tin
  (bàn giao / phán quyết / QA / escalate / chat), tham chiếu task. from/to `null` = owner.
- **Tasks** — bảng Jira: Cần làm / Đang làm / Đang review (`in_qa`+`rejected`) / Xong
  (`accepted`) / Hoãn-Escalate. Thẻ hiện ưu tiên (spine màu + nhãn ⚑), attempt `n/3`
  (vàng khi ≥2), số comment và badge chặn. **Bấm thẻ → drawer chi tiết**: PIC (assignee),
  reporter, status, priority, mô tả, luồng trao đổi (comment + @mention), và timeline lịch
  sử trạng thái (đọc từ `company.status_events`). Agent thao tác ticket qua MCP (đổi status,
  comment, tag agent, giao PIC, đổi ưu tiên) — xem `company/mcp/README.md`.
- **Office** — **văn phòng pixel thời gian thực**. Canvas 2D (`src/office/`): mỗi division
  = 1 phòng (đúng cách nhóm ở Nhân sự = sơ đồ tổ chức), mỗi agent biên chế = 1 bàn cố định;
  state machine ngồi/gõ/đọc/đi/nói. Nhận sự kiện **trực tiếp** từ `company/office-server`
  (WebSocket): agent nhắn nhau → đi tới bàn nhau + bong bóng; đổi status task → anim ✅/❌/🔍;
  comment/mention → ping. Offline vẫn hiện văn phòng tĩnh (agent ngồi tại bàn) + hướng dẫn chạy
  backend. Sprite pixel tái dùng từ **Pixel Agents** (MIT, © Pablo De Lucca) — xem
  `public/office/ATTRIBUTION.md` + `LICENSE-pixel-agents.txt`. Bật realtime:
  `cd company/office-server && npm install && npm start`.

**Dữ liệu mẫu:** engagement `ENG-001` được seed để minh hoạ; banner "Dữ liệu mẫu" hiện
khi nó có mặt. Xoá: `DELETE FROM company.engagements WHERE id='ENG-001'` rồi `npm run data`.
Seed lại từ `company/db/seed/sample_engagement.sql` (+ `sample_tasks.sql` cho priority /
comment / lịch sử ticket).

## Setting & Monitor

- **Providers** — catalog 16 runtime (provider + scoping từ `company/runtimes.json` + tools.json),
  và bảng gán runtime cho từng nhân sự biên chế. Console chỉ đọc: đổi lựa chọn → nút "Sao chép
  cấu hình" tạo snippet `assignments` để dán vào `company/runtimes.json` rồi `npm run data`.
  Cảnh báo khi gán agent có `tools:` vào runtime nhóm `dropped`.
- **Monitor** — throughput / token / **chi phí ước tính** theo nhân sự. Chi phí = usage × **giá
  token thật** (`company.model_pricing`, xác minh 2026-06-24 từ claude-api skill). Usage là **mẫu**
  (`is_sample`, gắn ENG-001, `company/db/seed/sample_usage.sql`) cho tới khi agent chạy thật và
  metering ghi vào `company.usage_events`. View `company.usage_costed` tính giá — sửa giá là
  reprice toàn bộ. Model chưa có giá (provider ngoài Anthropic) hiện "—", không đoán.

## Giới hạn hiện tại

Console **chỉ đọc**. Nút "Sao chép decision record" tạo sẵn markdown vào clipboard để bạn
dán vào `company/decisions/`. Đây là lựa chọn có chủ đích: một nút "Duyệt" trông như thật
nhưng không ghi gì cả thì tệ hơn là không có nút.

`src/data/decisions.ts` hiện seed thủ công từ 4 quyết định D1–D4 trong
`company/IMPLEMENTATION-PLAN.md`. Khi Stage 1 xong, file này sẽ thành output sinh ra từ
`company/decisions/` giống `agents.json`.

## Phụ thuộc ngoài

Font **Be Vietnam Pro** (sans) + **JetBrains Mono** (mono) nạp từ Google Fonts trong
`index.html` — cả hai có đầy đủ dấu tiếng Việt (Poppins cũ thiếu, nên dấu chồng ậ/ọ/ừ
rơi về font hệ thống nhìn vỡ). Mất mạng thì rơi về font hệ thống (`-apple-system` hỗ trợ
tiếng Việt) — bố cục không vỡ. Muốn bỏ hẳn phụ thuộc: tải font về `public/` + `@font-face`.
