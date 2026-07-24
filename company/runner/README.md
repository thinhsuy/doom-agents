# Task Runner — orchestration runtime slice

Đây là **lát cắt runtime** của NEXUS: một tiến trình chạy vòng **Dev↔QA thật**, ghi
trạng thái vào Postgres (`company.tasks` + `status_events` + `messages`) cho tới khi
task **`accepted`** hoặc **`escalated`**. Khi bật cùng `office-server`, tab Office sẽ
hiển thị agent **làm việc liên tục thật sự** — không phải animation một lần.

Đây là **state machine + tích hợp DB** của runtime. Mỗi pha đang được *tính giờ* thay cho
LLM thật; muốn agent thật làm việc: thay `sleep` bằng lời gọi subagent, các transition giữ nguyên.

## Có GIỚI HẠN (không chạy vô hạn, và không quá thấp)

| Giới hạn | Mặc định | Env |
|---|---|---|
| Số lượt QA fail → **escalate** (cap NEXUS) | 3 | `RUN_MAX_ATTEMPTS` |
| Thời gian "làm" mỗi lượt (in_progress) | 12s | `RUN_WORK_MS` |
| Thời gian QA mỗi lượt (in_qa) | 7s | `RUN_QA_MS` |
| Nghỉ trước khi retry | 2.5s | `RUN_RETRY_MS` |
| **Hạn thời gian mỗi task** → escalate | 5 phút | `RUN_MAX_TASK_MS` |
| **Hạn thời gian toàn cục** → dừng | 30 phút | `RUN_MAX_MS` |
| Xác suất QA đạt (lượt 0, +mỗi retry) | 0.55, +0.25 | `RUN_PASS_BASE` / `RUN_PASS_STEP` |

**1 task / 1 agent tại một thời điểm:** task gom theo assignee, chạy tuần tự trong nhóm,
các agent khác nhau chạy song song — khớp mô hình "đợi agent đang bận" của Office.

Task **bị chặn** (`blocked_by`) hoặc đã ở trạng thái cuối (accepted/escalated/deferred) sẽ **bỏ qua**.

## Chạy

```bash
cd company/runner
node run.mjs               # chạy các task chạy được trong ENG-001 (sample)
node run.mjs ENG-001       # một engagement cụ thể
node run.mjs T-102         # một task cụ thể
node run.mjs --reset       # reset task sample ENG-001 về đầu để demo lại
npm run smoke              # kiểm thử (task throwaway → terminal, tự dọn)
```

Để **thấy live**: mở 2 tiến trình — `office-server` (stream DB → WS) và `runner` (sinh việc):

```bash
# terminal 1
cd company/office-server && npm start
# terminal 2
cd company/runner && node run.mjs
# rồi mở tab Office trong console → agent làm việc, đi QA, fail/retry, đến accepted
```

Kết nối DB **qua `docker exec psql`** (dùng chung `company/mcp/db.mjs`), như office-server.

## Kiểm chứng

`npm run smoke` (4 check): task throwaway chạy tới trạng thái cuối, attempt trong cap,
status_events + message được ghi, tự dọn. Nhánh **escalate** (QA fail liên tục →
`escalated` attempt 3) đã kiểm bằng `RUN_PASS_BASE=0 RUN_PASS_STEP=0`.
