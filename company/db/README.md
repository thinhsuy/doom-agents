# company/db — system of record

Postgres 17 trong container Docker **có sẵn** của bạn (`ocb_ai_assistant-db-1`).
Database: `doom_agents`, schema: `company`.

## Kết nối

Thông tin nằm ở `company/.env.local` (chmod 600, đã gitignore). Nạp bằng:

```bash
set -a && . company/.env.local && set +a
psql "$DATABASE_URL" -c '\dt company.*'
```

Hoặc qua container:

```bash
docker exec -it -e PGPASSWORD="$PGPASSWORD" ocb_ai_assistant-db-1 \
  psql -U doom_agents -h 127.0.0.1 -d doom_agents
```

## Cách ly

Role `doom_agents` **không kết nối được** vào `ocb_ai` — đã `REVOKE CONNECT ... FROM PUBLIC`
và kiểm chứng bằng test thật (`permission denied for database "ocb_ai"`). Nếu sau này agent
được cấp quyền chạy SQL, chúng vẫn không chạm được dữ liệu của project kia.

App `ocb_ai` kết nối bằng role `postgres` (superuser) nên **không bị ảnh hưởng** — đã xác
minh còn truy cập đủ 22 bảng sau khi revoke.

## Bảng

| Bảng | Vai trò |
|---|---|
| `agents` | Ảnh chụp roster, đồng bộ từ `company/roster.json` + catalog |
| `engagements` | ENG-xxx — yêu cầu khách hàng, giữ nguyên văn lời owner |
| `sessions` | Mỗi phiên Claude Code chạm vào engagement — thứ làm việc resume được |
| `tasks` | T-xxx — status, PIC (assignee), reporter, priority, số lần thử, mô tả |
| `task_comments` | Comment theo dõi trên ticket (kèm `mentions[]` để tag agent) |
| `messages` | **Giao tiếp giữa agent**: chat, handoff, QA verdict, escalation, ruling |
| `status_events` | Nhật ký append-only mọi lần đổi trạng thái (task/engagement/decision) |
| `decisions` | D-xxx — quyết định của CEO/CTO |
| `evidence` | Bằng chứng QA gắn với task (file vẫn nằm trên đĩa, đây chỉ là con trỏ) |
| `channels` | Group chat: engagement channel + kênh ad-hoc do agent tạo qua MCP |
| `message_reactions` | Reaction emoji trên tin (message, agent, emoji) |
| `channel_reads` | Con trỏ đã-đọc theo agent/kênh — để đếm chưa đọc |
| `model_pricing` | Giá token thật theo model (nguồn Anthropic docs) |
| `usage_events` | Metering: mỗi lượt gọi model của agent (cost tính qua view `usage_costed`) |
| `office_config` | Config console bền (key-value jsonb) — vd sàn từng phòng ban ở tab Office |

**Kênh chat + task cho agent:** MCP server `company/mcp/` cho agent (a) tạo channel / gửi /
react / đọc, (b) thao tác task ticket: đổi status, comment (tag agent), giao PIC, đổi ưu tiên
— xem `company/mcp/README.md`. Ghi trực tiếp vào `company.channels` / `messages` /
`message_reactions` / `tasks` / `task_comments` / `status_events`. Danh tính server-side
(`AGENT_SLUG`), không mạo danh được.

## Invariant được ép ở tầng schema

Không phải quy ước — là ràng buộc, đã test bằng negative control:

| Ràng buộc | Chặn điều gì |
|---|---|
| `messages.idempotency_key UNIQUE` | Writer retry làm nhân đôi handoff |
| `tasks.attempt BETWEEN 0 AND 3` | Vượt quy tắc 3 lần thử của NEXUS |
| `decided_has_ruling` | Quyết định `decided` mà không ghi lý do — cổng "trông như đã qua" |
| `agents_hired_name_uniq` | Hai agent biên chế trùng tên (một cái che cái kia khi cài) |
| `engagement_closed_has_time` | Đóng engagement mà không có mốc thời gian |

## Console đọc từ DB, không hardcode

`company/ui/build.py` (`npm run data`) giờ chạy hai chiều:

1. **Sync lên DB** — đọc file `.md` + `roster.json` + `runtimes.json`, upsert vào
   `company.agents` (`ON CONFLICT DO UPDATE` — file là nguồn của agent).
2. **Seed decisions** — nạp `company/db/seed/decisions.json` vào `company.decisions`
   **một lần** (`ON CONFLICT DO NOTHING`). Sau đó **DB là nguồn quyền lực**: sửa ruling
   thẳng trong DB, chạy lại build sẽ KHÔNG ghi đè.
3. **Export từ DB** — đọc ngược ra `src/data/agents.json` và `src/data/decisions.json`
   cho console (đã gitignore). Console là trang tĩnh nên hiển thị snapshot lúc build.

Đã kiểm chứng bằng round-trip: `UPDATE company.decisions SET title=...` → `npm run data`
→ `decisions.json` phản ánh thay đổi, seed file vẫn nguyên. DB, không phải mã nguồn, là
nguồn của quyết định.

**Sửa một quyết định:**

```bash
set -a && . company/.env.local && set +a
docker exec -e PGPASSWORD="$PGPASSWORD" ocb_ai_assistant-db-1 \
  psql -U doom_agents -d doom_agents \
  -c "UPDATE company.decisions SET status='decided', ruling='...', decided_at=now() WHERE id='D2'"
(cd company/ui && npm run data)   # xuất lại snapshot cho console
```

`build.py` cần DB chạy — nếu không tới được, nó dừng và báo lỗi thay vì xuất dữ liệu cũ.

## Migration

Đánh số tăng dần, idempotent, chạy lại được:

```bash
set -a && . company/.env.local && set +a
for f in company/db/0*.sql; do
  docker exec -i -e PGPASSWORD="$PGPASSWORD" ocb_ai_assistant-db-1 \
    psql -U doom_agents -d doom_agents -v ON_ERROR_STOP=1 -q < "$f"
done
```

Bảng `company.schema_migrations` ghi version đã áp (`001_init`, `002_console_source`,
`003_monitor`, `004_chat`, `005_tasks`, `006_office_config`).
`company/db/seed/` chứa dữ liệu seed (được commit); `src/data/*.json` là output sinh ra
(gitignore).

## Chưa làm — agent chưa ghi được vào đây

Subagent **không tự truy cập Postgres được** trừ khi được cấp công cụ. Ba hướng:

1. **Orchestrator giữ toàn quyền ghi** (khuyến nghị cho Stage 3) — subagent trả kết quả,
   vòng lặp chính ghi DB. Subagent không cần `Bash`, giữ nguyên phân quyền role.
2. **MCP server cho Postgres** — agent nhận tool có phạm vi (`create_message`,
   `update_task_status`) thay vì SQL tuỳ ý. Đúng hướng lâu dài.
3. **Bash + psql** — nhanh nhất nhưng agent chạy được SQL bất kỳ, kể cả xoá bản ghi của
   agent khác. Phá vỡ mục đích phân quyền role. Không khuyến nghị.

## Lưu ý về vòng đời

Container này thuộc compose stack của project `ocb_ai_assistant`. Nếu bạn
`docker compose down -v` ở project đó, **volume bị xoá và mất luôn `doom_agents`**.
Cân nhắc tách stack riêng, hoặc thêm backup định kỳ, trước khi đưa dữ liệu thật vào.
