# Agency OS Backend (FastAPI)

**Một server** cho toàn bộ console: REST (dữ liệu live từ Postgres) + WebSocket
(office stream) + phục vụ FE build sẵn. FE giao tiếp với đây để **lấy thông tin** và
**thao tác trực tiếp** hệ thống.

## Vì sao 1 server là đủ (mount FE vào FastAPI)

FastAPI (Starlette) phục vụ được **static FE + REST + WebSocket** trên **một cổng**.
FE dùng **HashRouter** (`/#/...`) nên server chỉ trả `index.html` ở `/` — không cần rewrite
SPA. Cùng origin → **hết CORS**. Chỉ tách khi: nhiều Uvicorn worker (WS broadcast trong RAM
không share giữa worker → dùng 1 worker hoặc Redis pub/sub), hoặc muốn CDN riêng cho FE.
Không có gì *bắt buộc* tách cho app này.

## Endpoint

| Method | Path | Việc |
|---|---|---|
| GET | `/api/health` | trạng thái + số client WS + cursor |
| GET | `/api/workspace` | engagements / tasks (detail+comments+history) / messages / channels |
| GET | `/api/decisions` | hàng đợi quyết định |
| GET | `/api/monitor` | throughput / token / cost theo agent (giá thật) |
| GET | `/api/agents` | roster + divisions (live từ `company.agents`) |
| GET | `/api/chat` | channels + messages (Team Chat live) |
| POST | `/api/chat/send` | owner gửi tin (`from_agent=NULL`). Có `toAgent` = agent biên chế → agent đó **tự trả lời** (async) |
| GET/POST | `/api/config/floors` | lưu/đọc sàn từng phòng ban (`company.office_config`) |
| GET | `/api/providers` | 2 provider (GPT/Claude) + trạng thái key + model per-agent |
| POST | `/api/agent-runtime` | gán `{slug, provider, model}` cho một agent (`company.agent_runtime`) |
| WS | `/ws/office` | office stream: `hello` snapshot + `message`/`taskStatus`/`comment` live |
| GET | `/*` | FE build sẵn (`company/ui/dist`) |

## Chạy

**Prod (1 server, mount FE):**
```bash
cd company/ui && npm run build          # build FE → dist/
cd ../api
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn main:app --port 8000     # http://localhost:8000  (FE + API + WS)
```

**Dev (2 server cho HMR):** chạy Vite (`npm run dev`) + `uvicorn main:app --reload`, cho Vite
proxy `/api` và `/ws` sang FastAPI (thêm `server.proxy` trong `vite.config`), hoặc để FE gọi
thẳng `http://localhost:8000` (CORS đã mở `*`).

## @mention → agent trả lời

Trong Team Chat, gõ `@` để chọn agent (autocomplete, khớp tên theo **word boundary**).
Gửi `@Talent Acquisition Lead ...` → FE resolve ra slug, POST kèm `toAgent`. Backend chèn
tin của owner rồi **kích hoạt agent đó trả lời** (async): nạp persona của agent + 12 tin gần
nhất trong kênh làm ngữ cảnh, gọi LLM, chèn câu trả lời vào kênh (from_agent = agent). FE
poll `GET /chat` mỗi 3s nên câu trả lời hiện ra.

**Agent có tool đọc DB (`view_db`).** Để trả lời đúng dữ kiện thay vì đoán, responder cấp cho
LLM một tool **chỉ-đọc, scoped** (cả GPT lẫn Claude/Bedrock): `view=overview` (tổng nhân sự +
theo division), `agents` (lọc theo division), `tasks`, `channels`, `engagements`. **KHÔNG** phải
raw SQL — chỉ các named view cố định (cùng nguyên tắc role-scoping như MCP server), nên agent
xem được dữ liệu công ty mà không chạy query tuỳ ý / không ghi. Vòng lặp tool bị chặn ở
`_TOOL_ROUNDS=4` để reply luôn kết thúc. Đã kiểm chứng: hỏi "bao nhiêu nhân sự" → agent gọi tool →
trả **33** đúng breakdown (cả Bedrock Haiku 4.5 lẫn gpt-4o-mini).

## Nhóm chat + react + broadcast chọn lọc (008_chat_groups)

- **Tạo nhóm**: `POST /api/chat/channels` `{name, topic?, members[]}` (nút "＋ Nhóm" trong Team
  Chat; id slug hoá tiếng Việt, thành viên phải là agent biên chế → `company.channel_members`).
- **Mention scoped theo nhóm**: kênh CÓ members → autocomplete + resolve chỉ trong members
  (backend chặn 400 nếu tag người ngoài); `@Ban lãnh đạo` chỉ hiện khi đủ 5 lead trong nhóm.
- **Không tag ai = hỏi cả nhóm**: mọi member được trigger TUẦN TỰ, mỗi agent tự quyết —
  đúng chuyên môn thì trả lời, không thì trả `PASS` (bị nuốt, không hiện tin — xét DÒNG ĐẦU
  nên "PASS + giải thích" cũng bị nuốt). Kênh KHÔNG members giữ hành vi cũ (không auto-trigger).
  Verified: hỏi câu thuần QA trong nhóm 2 người → Senior Developer PASS, Reality Checker trả lời.
- **Owner react**: `POST /api/chat/react` `{messageId, emoji}` toggle (agent NULL = CEO/CTO;
  migration 008 bỏ PK cũ vốn ép agent NOT NULL, thay bằng unique index coalesce). FE: hover
  tin → ☺+ palette, bấm chip để thả/bỏ. Verified round-trip on/off.
- **Popup thông tin nhóm** (icon `!` góc phải header, chỉ nhóm `topic`): tên nhóm **sửa được**
  (`PATCH /api/chat/channels/{id}` — kênh engagement 400), danh sách 👥 thành viên (5 hàng
  hiển thị, nhiều hơn thì cuộn), nút 🗑 **xoá nhóm** confirm 2 bước
  (`DELETE /api/chat/channels/{id}`, cascade tin + members). Verified: create→rename→
  reflected in `/api/chat`→delete; rename/delete ENG-001 → 400.
- **KHÔNG hardcode kênh giao việc** (migration `009_task_origin.sql`): ticket lead tạo ghi
  `tasks.origin_channel` = nhóm nơi chỉ đạo được đưa (ContextVar per-reply). Báo cáo roll-up
  đi về **đúng nhóm gốc**, do **lead tạo nhiều ticket nhất trong đợt** viết (fallback Engagement
  Director); marker per-channel trong `office_config.ops_report` = `{channelId: lastEventId}`.
  Xoá nhóm → task giữ lại với origin NULL (không mất lịch sử). Verified: task tạo trong
  `ch-test-flow` → báo cáo về ch-test-flow bởi PM, `ch-leadership` = 0 tin.

## Phanh khẩn cấp — trần chi phí + dừng + timeout (runtime, không cần restart)

Cấu hình sống trong `company.office_config` (đổi qua API, hiệu lực ngay):
- **Trần chi phí + ngưỡng cảnh báo** (`budget` = `{ceilingUsd,warnUsd}`, mặc định env `MAX_DAILY_USD=5`):
  `_refresh_budget()` chạy mỗi tick worker, cộng `usage_costed` hôm nay; **cảnh báo** ở ngưỡng,
  **tự dừng (latch)** khi chạm trần — chỉ resume sạch khi owner bấm Tiếp tục VÀ spend đã dưới trần.
- **Dừng khẩn cấp thủ công** (`worker_paused`, `POST /api/worker/pause|resume`). Cả 2 phanh gate
  **cả worker lẫn mọi chat reply** (`_llm_reply` trả "⛔ Tạm dừng", không gọi LLM).
- **Timeout mỗi model** (`model_timeouts`, đặt `timeout=` trên mỗi call OpenAI/Bedrock) — call
  treo sẽ bị cắt. `GET/POST /api/model-timeouts`.
- **Triage rẻ cho fan-out**: tin không tag trong nhóm → `_should_answer` (prompt ngắn, không tool,
  ~8 token out) chọn ai có việc, chỉ người đó full reply → rẻ hơn ~6–13× mỗi agent không tham gia.
- UI: card **Phanh chi phí** ở tab Monitor (`BudgetControls`) — thanh spend/ngưỡng/trần, sửa hạn mức,
  nút 🛑 Dừng/▶ Tiếp tục, ô timeout mỗi model. `GET/POST /api/budget`.

## Tự học — agent tự điều chỉnh skill/knowledge (012_agent_learnings.sql)

- Mọi agent có tool `record_learning` — **self-scoped tuyệt đối**: tool KHÔNG có tham số agent,
  actor lấy từ context, nên agent chỉ ghi được learning của CHÍNH MÌNH (không sửa được agent khác).
  `company.agent_learnings` (kind skill|knowledge|lesson|correction, source self|experience|owner).
- Learnings gần nhất được **inject vào system prompt** (`_learnings_block`) ở chat + bước làm việc
  của worker → hành vi thực sự thay đổi theo thời gian.
- 2 nguồn: (1) **deterministic** — task bị QA trả lại → assignee tự ghi feedback thành correction
  (luôn chạy, không phụ thuộc LLM); (2) chat khi CEO/CTO nhắc/sửa (source=owner) — phụ thuộc model.
- Owner xem ở drawer Nhân sự (`🎓 Đã học`, live `/api/agent-learnings/{slug}`). Verified: learning
  của 2 agent tách biệt, non-agent bị từ chối.

## Documents — kho tài liệu + "document-first, implement-second" (011_documents.sql)

- **MỌI agent** (cả staff) có 4 tool: `list_docs`, `read_doc`, `create_folder`, `write_doc`
  (`_DOC_TOOL_NAMES`, mở cho tất cả trong `_exec_tool` — chỉ bước `__reader__` của worker là view_db only).
  `write_doc` create-or-update theo (folder,name), tự tạo folder; format mặc định `markdown`.
- **Rule** trong base system prompt: trước khi làm việc thật → viết tài liệu để agent khác đọc & follow.
- **Cơ chế TIN CẬY = worker**: staff nộp deliverable → backend tự lưu thành
  `<engagement>/deliverables/<taskId>.md` (gọi `_t_write_doc` bằng Python, KHÔNG qua LLM). Verified:
  T-950 → `ENG-OPS/deliverables/T-950.md` xuất hiện đúng lúc chuyển in_qa, author = assignee.
- Chat-driven `write_doc` (agent tự viết doc khi được nhờ trong chat) CÓ nhưng **phụ thuộc model**:
  Haiku 4.5 hay "hứa" thay vì gọi tool → không tin cậy trên model rẻ; đường worker mới là cái chắc chắn.
- FE: tab **Documents** (`/api/docs`, poll 5s), rail folder→file + viewer markdown/raw. Console chỉ đọc.

## Vòng giao việc NEXUS qua chat (@Ban lãnh đạo → task → staff làm → báo cáo)

- **`@Ban lãnh đạo` / `@all`** trong Team Chat → backend fan-out cho 5 lead
  (`LEAD_SLUGS`: engagement-director, project-manager-senior, product-owner,
  engineering-software-architect, security-architect) trả lời **tuần tự** — lead sau thấy
  reply (và task đã tạo) của lead trước trong context. Tin owner lưu `to_agent=NULL`.
- **Lead tạo TICKET QUYẾT ĐỊNH cho CEO/CTO**: tool `raise_decision` (WRITE_SLUGS) → chèn 1
  quyết định `pending` (id `D-<n>`, decider CEO/CTO, urgency blocking/normal, options) vào tab
  Quyết định; prompt bắt lead nói "✅ Đã tạo ticket quyết định D-N … chờ được phê duyệt" trong
  chat. Tab Quyết định giờ **đọc live** (`/api/decisions`, poll 5s). Seed 4 quyết định mock đã
  xoá (seed file rỗng + `seed_decisions` return sớm nên `npm run data` không tái tạo). Verified:
  câu hỏi kiến trúc chiến lược → PM tạo D-1 (blocking, 2 phương án) → hiện trong tab + đúng câu
  báo trong chat.
- **Lead có tool GHI task** (`WRITE_SLUGS` = 5 lead + `hr-talent-acquisition-lead` (chủ pipeline
  tuyển) — enforce server-side trong `_exec_tool`):
  `create_task` / `assign_task` / `comment_task` / `update_task_status` (mirror semantics MCP:
  `status_events`, vào `rejected` tăng attempt về cap 3). Task chat-created thuộc engagement
  chờ **`ENG-OPS`** (tự tạo idempotent). Staff thường chỉ có `view_db`. `view_db` có thêm view
  **`candidates`** (kho ~220 persona CHƯA tuyển, lọc division/keyword) — HR sourcing chạy trên
  dữ liệu catalogue THẬT; bước làm-việc của worker được cấp `view_db` (đọc, không ghi).
  Web-search cho HR: **chưa có** trong chat runtime — agent nào hứa "search web" là nói trong vai.
- **Worker loop** (`worker_loop`, bật qua `WORKER_ENABLED=1`, poll `WORKER_POLL_S=5`s):
  mỗi tick tiến **một bước** cho **một** task có PIC biên chế (trừ ENG-001 mẫu):
  `todo→in_progress` → staff LLM sinh deliverable (comment) `→in_qa` → **reporter lead** (fallback
  Product Owner) review LLM với dòng đầu `VERDICT: ACCEPT|REJECT` → `accepted`, hoặc `rejected`
  (attempt+1, quay lại làm) — quá **3 vòng → `escalated`** (NEXUS cap). Mọi transition ghi
  `status_events` nên Office animate theo thời gian thực.
- **Báo cáo roll-up**: khi mọi task ENG-OPS đạt trạng thái cuối và có transition mới kể từ
  marker (`company.office_config` key `ops_report`), Engagement Director soạn báo cáo và post
  vào `ch-leadership` — badge unread nhắc CEO/CTO.
- FE: Tab **Task đọc live** từ `/api/workspace` (poll 5s, offline fallback snapshot) nên
  ticket lead tạo hiện ngay không cần rebuild.

**Vòng đời ticket + số liệu thật (migration `010_cancelled_usage.sql`):** lead tạo → `todo`;
worker: `todo→in_progress→in_qa` → lead review → `accepted` / `rejected` (cap 3 → `escalated`).
Khi **accepted**, hệ thống post **báo cáo hoàn tất** vào ticket (deterministic, số thật, không
LLM): thời gian xử lý (từ event `in_progress` đầu tiên), **tokens in/out + chi phí** (từ
metering), số vòng bị reject, blocked-by, tóm tắt deliverable. Trạng thái **`cancelled`** có
thêm trong enum (DB CHECK + tool + MCP + board cột "Hoãn / Huỷ / Escalate") — huỷ **bắt buộc
kèm `reason`** (chặn ở cả chat-tool lẫn MCP), lý do ghi vào timeline + comment ⛔.
**Metering THẬT:** mọi call LLM (chat + worker, cả 2 provider) cộng dồn usage per-reply và ghi
`company.usage_events` (`is_sample=false`; agent từ context, task từ worker-context; model ghi
theo key giá `claude-haiku-4-5`/`claude-sonnet-4-5`, GPT ghi raw id — chưa có giá nên cost
NULL). Verified: 1 call haiku → row 26in/4out, `usage_costed` = $0.000092; báo cáo hoàn tất
render đủ metric. Monitor tab đọc snapshot — chạy `npm run data` để cập nhật số mới.

**Đã kiểm chứng end-to-end (2026-07-23, Bedrock Haiku 4.5):** CEO giao việc `@Ban lãnh đạo`
→ 5 lead trả lời tuần tự và **hỏi lại CEO khi thiếu thông tin** (clarify loop hoạt động) → CEO
xác nhận → PM gọi `create_task` thật (T-201, PIC engineering-technical-writer) → worker:
staff viết one-pager markdown thật → PM review `VERDICT: ACCEPT` → `accepted` → Engagement
Director post 📋 báo cáo roll-up (bảng markdown) vào `ch-leadership`. Toàn bộ transition có
trong `status_events` với đúng actor. Lưu ý đã sửa trong test: view `agents` phải trả về
**slug** (thiếu slug → lead bịa slug sai).

## Providers & model per-agent

Hai provider, chọn model cho **từng agent** ở tab Providers (lưu vào `company.agent_runtime`;
agent chưa chỉnh dùng mặc định công ty `DEFAULT_PROVIDER`/`DEFAULT_MODEL`, mặc định `claude`/`haiku`):

- **GPT (OpenAI)** — key `OPENAI_API_KEY`. Model: `gpt-4o-mini`, `gpt-4o`.
- **Claude (AWS Bedrock)** — creds `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, region `BEDROCK_REGION`
  (tách khỏi `AWS_REGION` của S3). **5 model** (ACTIVE trên account): `haiku` Haiku 4.5, `sonnet` Sonnet 4.5,
  `sonnet-5` Sonnet 5, `opus` **Opus 4.8**, `fable` Fable 5 (account còn Opus 4.7/4.6/4.5, Sonnet 4.6 nếu cần).
  Alias → inference-profile ID trong `BEDROCK_IDS` (env `BEDROCK_HAIKU/SONNET/SONNET5/OPUS/FABLE`).
  Claude đời mới trên Bedrock **chỉ gọi qua cross-region inference profile** (prefix `global.`/`apac.`),
  KHÔNG dùng raw model id (raw id → `invalid model identifier`). Tra profile:
  `aws bedrock list-inference-profiles --region <r>`.

Backend nạp `company/.env.local` vào env lúc khởi động, nên chỉ cần điền key ở đó là xong.
Responder route theo provider của agent: GPT → OpenAI SDK, Claude → `AnthropicBedrock` (dùng
AWS creds). Thiếu key/model lỗi → trả lời fallback honest (báo cần cấu hình).

Đã kiểm chứng **cả hai**: GPT (`gpt-4o-mini`) và **Bedrock Claude Haiku 4.5** (`global.anthropic.claude-haiku-4-5-20251001-v1:0`,
`ap-southeast-1`, account `203918858918`) đều trả lời **thật, đúng vai** qua đúng đường `/api/chat/send`.

## Lớp DB

`db.py` nối Postgres **qua `docker exec psql`** (như mcp / office-server / build.py) vì host
`127.0.0.1:5432` bị postgresql@16 native chiếm, container không route thẳng được trên máy này.
Mọi thứ blocking chạy trong `asyncio.to_thread` để không chặn event loop. Muốn dùng `asyncpg`
(nhanh hơn) thì cho backend một endpoint TCP tới được (đổi port host / chạy trong docker
network) và **viết lại đúng 1 file `db.py`** — phần còn lại giữ nguyên.

## Đã kiểm chứng

Khởi động uvicorn thật → REST trả đúng dữ liệu DB (workspace 6 task, agents 253/33 hired,
decisions 4, monitor $2.12), FE phục vụ tại `/` (HTTP 200), POST owner chèn tin thật,
WebSocket `hello` + broadcast một tin insert thật tới client — tất cả tự dọn.

## Chưa làm (bước kế)

FE hiện **import JSON tĩnh** (`src/data/*.json` do `build.py` sinh). Để FE dùng backend này,
cần đổi FE sang **fetch `/api/*`** (thay các import tĩnh) + trỏ WS về `/ws/office`. Backend đã
sẵn sàng; đây là refactor phía FE, làm riêng.
