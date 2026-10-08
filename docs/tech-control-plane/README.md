# Company AI Tech Control Plane — kiến trúc, kiểm kê và lộ trình

*06/10/2026 · sứ mệnh `tech-control-plane` (sổ chung `ai-control/registry`) · nhánh `feat/company-ai-tech-control-plane`.*

Mục tiêu: `/tech` (đã có) trở thành **mặt phẳng điều khiển DUY NHẤT** của cả công ty cho việc phát triển
phần mềm — chủ shop giao MỤC TIÊU, hệ thống tự đi:

```
Goal → Mission → Task → chọn năng lực → Worker (lease) → worktree riêng → mã → kiểm thử
     → PR → cổng CI → gộp theo chính sách → deploy → hậu kiểm → học / lập lại kế hoạch → việc kế tiếp
```

VS Code / phiên Claude tương tác trở thành **cửa thoát hiểm** (break-glass), không phải giao diện vận hành.

**Không** có `/tech-v2`, không có Tech Room thứ hai, không viết lại `/tech`. Mọi thứ dưới đây là MỞ RỘNG
từng bước trên nền đang chạy production.

---

## 1. Hiện trạng — hai mặt phẳng điều khiển chưa nói chuyện với nhau

| | (A) `/tech` trong ERP | (B) AI Tech Room (`npm run ai`) |
|---|---|---|
| Nơi lưu | PostgreSQL (`tech_*`) | nhánh git `ai-control/registry` + `.ai/missions/*.json` |
| Ai dùng | chủ shop trên web/điện thoại | phiên Claude Code trên máy dev |
| Có | Task 13 trạng thái + phép chuyển, rủi ro R0–R2 + duyệt, agent registry (12 vai), lượt chạy agent qua GitHub Actions, phép chiếu PR/CI, sổ deploy + đối chiếu commit, sự cố tự mở, AI CTO đề xuất kế hoạch, 7 job canh | Mission + DAG việc, `owns` (phạm vi ghi), lease có hạn + mã phiên, nhịp tim, intake chống trùng, giữ chỗ migration, hàng đợi gộp, deploy-plan, verify production |
| Thiếu | Goal/Mission/Project, hàng đợi có lease, worker có danh tính + nhịp tim, ngân sách nhiều cấp, luồng sự kiện chung | Không có giao diện cho chủ shop, không có CSDL, không daemon — mọi thứ chạy khi có phiên đang mở |

Quyết định: **(A) là nguồn sự thật** (chủ shop đã chốt "PostgreSQL là nguồn sự thật, Control Plane là nơi
giữ sự thật"). (B) giữ vai CÔNG CỤ THI HÀNH của phiên dev và được NỐI vào (A) (Pha 3) — không bị xoá, vì
nó đang là đường giao hàng đang chạy (`gates`, `deploy-plan`, `verify`).

---

## 2. Kiểm kê — KEEP / EXTEND / REFACTOR / DEPRECATE / MISSING

### KEEP (giữ nguyên, dùng lại)

| Thành phần | Ở đâu | Vì sao giữ |
|---|---|---|
| Vòng đời Task + bảng phép chuyển + cổng duyệt R2 + chặn agent tự đưa sang deploy | `lib/constants/tech.ts` `TECH_TASK_TRANSITIONS`, `lib/tech/service.ts::setTechTaskStatus` | Đã là máy trạng thái tất định, một đường ghi duy nhất |
| Nhật ký việc append-only, ba loại người làm | `tech_task_events` | Dòng thời gian từng việc đã có, CHECK tách người/agent/máy |
| Agent registry | `tech_agents` (12 vai, mặc định TẮT, `allowedRisks`, cờ quyền) | Là "AgentDefinition" |
| Lượt chạy agent | `tech_agent_runs` (+ `heartbeat_at`, `external_ref` idempotent, 4 cổng đo bằng exit code, chi phí trong `metadata.chiPhi`) | Là "AgentRun" |
| Đường thi hành qua GitHub Actions | `agent-run.yml` + `lib/agents/runner.ts` + `agent-open-pr.yml` (GitHub App `erp-agent`, không có quyền merge/approve) | Đã chạy thật (PR #82, TECH-4/7/9/10) |
| Cửa máy | `GET /api/tech/agent-task`, `POST /api/tech/agent-run` (khoá `AGENT_INGEST_SECRET`) | Mẫu cho cửa worker |
| Phép chiếu PR/CI | `lib/integrations/github/pull-requests.ts` (4 chiều PR · CI · review · merge) | Đúng bẫy `[]` / `mergeable=null` / review cũ |
| Sổ deploy + đối chiếu commit | `tech_deployments` (UNKNOWN/VERIFIED/SUPERSEDED/MISMATCH) | "Workflow xanh ≠ máy chủ chạy bản đó" |
| Sự cố tự mở | `tech-incident-watch`, `ai-incident-watch` | Watchdog tầng nghiệp vụ |
| Bộ lập lịch | `scripts/scheduler.mjs` → `/api/sync/<job>` + `sync_runs` | Đủ cho watchdog, không cần dịch vụ mới |
| Nhật ký kiểm toán | `audit()` → `audit_logs` | |
| Luồng sự kiện miền | `emitDomainEvent` → `domain_events` (append-only, dedupe, causation/correlation) | Dùng cho Goal/Mission/Worker — không tạo bảng sự kiện thứ hai |
| Cổng CI + bảo vệ `main` | `gates.yml` (4 job + `gates / gates`), ruleset `main`: PR bắt buộc + `gates / gates`, **0 lượt duyệt** (từ 25/09/2026 — câu "1 duyệt người" cũ đã sai) | KHÔNG nới, KHÔNG lách |
| Deploy + smoke | `deploy-vps.yml` (dùng lại lượt cổng xanh đúng SHA, `flock` trên VPS, smoke `/api/health`) | |
| Ngân sách AI theo ngày | `lib/ai/budget.ts` (trần ngày trong `settings`) · `platform_ai_usage` | Nền cho ngân sách API |

### EXTEND (mở rộng tại chỗ)

| Thành phần | Mở rộng | Pha |
|---|---|---|
| `tech_tasks.status` | thêm `NEEDS_OWNER` (kèm loại leo thang + việc chủ shop phải làm) và `CANCELLED` (kết thúc, chỉ người) | 1 |
| `tech_tasks` | `mission_id`, `project_id` | 1 |
| Từ vựng vòng đời | **vòng đời chuẩn** (BACKLOG · READY · CLAIMED · RUNNING · REVIEW · TESTING · DEPLOYING · VERIFYING · DONE + BLOCKED · FAILED · NEEDS_OWNER · CANCELLED) là PHÉP CHIẾU tất định của trạng thái đang lưu + lease + phụ thuộc — không cột thứ hai | 1 |
| `tech_tasks.depends_on` | được ĐÁNH GIÁ: việc còn phụ thuộc chưa xong không bao giờ READY / không claim được | 1–2 |
| `tech_agents.capabilities` | từ jsonb tự do thành khoá trong SỔ NĂNG LỰC đóng | 6 |
| `tech_agent_runs` | `worker_id`, `provider` (`SUBSCRIPTION_CLAUDE_CODE` · `ANTHROPIC_API` · `GITHUB_ACTIONS`), `lease_generation`, nhật ký có trần | 2 |
| `dispatch-service` | thành MỘT adapter trong lớp adapter thi hành | 2 |
| `github-pr-sync` / `github-deployments` | phát `tech.pr.*` · `tech.ci.*` · `tech.deploy.*` và đẩy việc theo luật | 3 |
| Trang `/tech` | Tổng quan (Running · Queued · Blocked · Failed · Needs Owner · PR · Deploy · Health · API spend), Goals, Missions, Workers, Needs Owner — mobile-first | 1 (Goals/Missions) · 5 |

### REFACTOR

| Thành phần | Vấn đề | Hướng |
|---|---|---|
| Rủi ro R0–R2 (ERP) ↔ LOW/MEDIUM/HIGH/CRITICAL (AI Tech Room) | Hai thang nói về cùng một thứ | Một bảng quy đổi trong `lib/constants/tech-control-plane.ts`; thang chính sách R0–R4 ở Pha 4 |
| Trạng thái sứ mệnh ở (B) | Sống trên nhánh git, không ai ngoài phiên dev đọc được | `tech_missions.registry_id` nối hai bên; `ai-tech.ts` đẩy nhịp tim/trạng thái vào ERP (Pha 3) |
| PR chỉ nối qua `branch` | Một lượt chạy không biết PR của nó | Lượt chạy mang `pr_number` khi bộ đồng bộ PR ghép được (Pha 3) |

### DEPRECATE (không xoá ngay)

| Thành phần | Thay bằng | Khi nào |
|---|---|---|
| Dispatch không lease (`audit_logs` đếm quota) | Hàng đợi có lease + ngân sách | Sau khi Pha 2 chạy thật ≥ 2 tuần |
| Ghi tay `tech_deployments` | Đồng bộ GitHub + nối deploy → task | Pha 3 |

### MISSING (dựng mới)

| Khái niệm | Thiết kế | Pha |
|---|---|---|
| Project/Product | `tech_projects` (ERP · ChotDonTuDong · HSLC · SaaS Platform; thêm được không cần deploy) | 1 |
| Goal | `tech_goals` — trạng thái QUYẾT ĐỊNH (DRAFT · ACTIVE · PAUSED · ACHIEVED · ABANDONED), tiến độ SUY RA | 1 |
| Mission | `tech_missions` — trạng thái QUYẾT ĐỊNH (PLANNING · ACTIVE · PAUSED · DONE · CANCELLED), trạng thái THI HÀNH suy ra từ việc | 1 |
| Worker | `tech_workers`: danh tính, máy, provider, năng lực, nhịp tim, phiên bản | 2 |
| Lease | trên `tech_tasks` (`lease_worker_id`, `lease_token_hash`, `lease_expires_at`, `lease_generation` = fencing token), claim bằng `FOR UPDATE SKIP LOCKED` | 2 |
| Adapter thi hành | `SUBSCRIPTION_CLAUDE_CODE` · `ANTHROPIC_API` (+ `GITHUB_ACTIONS` đã có) — ranh giới credential cứng | 2 |
| Ngân sách | `tech_budgets` theo phạm vi (COMPANY · PROJECT · GOAL · MISSION · TASK) | 4 |
| Chính sách rủi ro R0–R4 | một tệp hằng thuần + một hàm quyết định | 4 |
| Watchdog | job `tech-watchdog` (lease hết hạn, worker mất nhịp tim, retry vượt trần, CI đỏ lặp, chi API bất thường) | 4 |
| Sổ năng lực | `lib/constants/tech-capabilities.ts` | 6 |
| Webhook GitHub | `POST /api/tech/github-webhook` (HMAC) — bổ sung, polling vẫn là lưới an toàn | 3 |

---

## 3. Mô hình miền

```
tech_projects ─┬─< tech_goals ─┬─< tech_missions ─┬─< tech_tasks ─┬─< tech_agent_runs ─> (commit · PR)
               │               │                  │               ├─< tech_task_events
               │               │                  │               └── PR/CI (phép chiếu GitHub)
               │               │                  └── registry_id ↔ ai-control/registry (B)
               └───────────────┴──────────────────── domain_events (tech.goal.* · tech.mission.* · tech.worker.* …)
tech_deployments ─> tech_tasks       tech_incidents ─> tech_tasks / tech_deployments
```

Truy vết bắt buộc: **Goal → Mission → Task → AgentRun → commit → PR → CI → Deployment → Verification**.
Mỗi mũi tên là một khoá (không đoán bằng chữ trong tiêu đề — luật đã có ở `pull-requests.ts`).

### 3.1 Trạng thái lưu vs trạng thái suy ra

Repo này có một bài học lặp đi lặp lại: **hai nơi giữ một sự thật thì lệch nhau** (AGENTS.md 19, 26, 32).
Nên:

- **Goal / Mission chỉ lưu QUYẾT ĐỊNH của người** (bắt đầu, tạm dừng, chốt xong, huỷ). Tiến độ, "đang chạy",
  "đang chờ chủ shop", "có việc đỏ" là HÀM THUẦN của các việc bên dưới, tính lúc đọc
  (`deriveMissionExecution`). Không job nào ghi lại chúng, nên chúng không bao giờ cũ.
- **Task vẫn lưu `status`** (máy trạng thái đã có, đã kiểm thử). Vòng đời chuẩn mà chủ shop đặt ra là
  PHÉP CHIẾU tất định (`canonicalTaskState`) của `status` + lease + phụ thuộc:

| Lưu (`tech_tasks.status`) | Chuẩn | Ghi chú |
|---|---|---|
| NEW · TRIAGED | BACKLOG | |
| SPEC_READY | READY → CLAIMED (có lease còn hạn) | còn phụ thuộc chưa xong ⇒ BACKLOG |
| BUILDING | RUNNING | |
| REVIEW | REVIEW | |
| QA | TESTING | |
| READY_TO_DEPLOY · DEPLOYING | DEPLOYING | READY_TO_DEPLOY = đã qua cổng, chờ lượt deploy |
| OBSERVING | VERIFYING | |
| DONE | DONE | |
| BLOCKED | BLOCKED | |
| FAILED · ROLLED_BACK | FAILED | |
| NEEDS_OWNER | NEEDS_OWNER | MỚI — kèm loại leo thang + đúng việc chủ shop phải làm |
| CANCELLED | CANCELLED | MỚI — kết thúc, chỉ NGƯỜI huỷ được |

Không đổi tên hay ghi lại dữ liệu cũ: production không có lượt `UPDATE` hàng loạt nào.

### 3.2 NEEDS_OWNER

Vào: bất kỳ trạng thái mở nào, bởi người / máy / agent, BẮT BUỘC kèm một trong chín loại
(`APPROVAL_REQUIRED` · `CREDENTIAL_REQUIRED` · `PAYMENT_REQUIRED` · `EXTERNAL_AUTH_REQUIRED` ·
`IRREVERSIBLE_BUSINESS_DECISION` · `PRODUCTION_INCIDENT` · `SECURITY_INCIDENT` · `POLICY_CONFLICT` ·
`UNKNOWN_HIGH_RISK_STATE` — cùng danh sách `OWNER_ESCALATIONS` của AI Tech Room) và một câu hướng dẫn cụ thể
(CHECK ở CSDL). Ra: **chỉ NGƯỜI**, kèm câu quyết định. Worker headless gặp OAuth / quyền / dữ liệu nhập tay
⇒ vào NEEDS_OWNER thay vì chờ mãi hay tắt bảo mật.

---

## 4. Thi hành (Pha 2–3)

```
            ┌──────────── ERP (VPS) ─────────────┐
 chủ shop → │ /tech  ·  tech_* (PostgreSQL)      │ ← scheduler: watchdog · pr-sync · deploy-sync
            │ /api/tech/worker/{register,claim,  │
            │   heartbeat,progress,complete}     │
            └───────────────▲────────────────────┘
                            │ HTTPS + khoá worker (không bao giờ DATABASE_URL)
            ┌───────────────┴────────────────────┐
            │ worker daemon (máy dev / VPS build) │  npm run tech:worker
            │  claim → worktree tech/<CODE>-<n>  │
            │  → adapter: SUBSCRIPTION_CLAUDE_CODE│  env KHÔNG có ANTHROPIC_API_KEY
            │           | ANTHROPIC_API           │  env có khoá, ngân sách bắt buộc
            │  → cổng → NỘP bộ thay đổi ─────────┼→ máy chủ ghi nhánh + PR (App)
            └─────────────────────────────────────┘
```

- **Hàng đợi = PostgreSQL**: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING` —
  không Redis/Kafka: quy mô là vài chục việc/ngày, một bảng có chỉ mục là đủ và kiểm thử được bằng PGlite.
- **Lease có fencing token** (`lease_generation`): worker chết ⇒ lease hết hạn ⇒ watchdog nhả ⇒ việc về READY
  (đếm `attempts`); worker cũ sống lại gửi kết quả với generation cũ ⇒ bị từ chối. Không thực thi hai lần.
- **Ranh giới thanh toán**: adapter subscription dựng môi trường con từ DANH SÁCH CHO PHÉP và xoá mọi
  `ANTHROPIC_*`; adapter API chỉ chạy khi ngân sách phạm vi còn chỗ và ghi lý do. Không bao giờ tự rơi từ
  subscription sang API.
- **Không phụ thuộc vĩnh viễn vào chế độ headless của subscription**: mọi logic đi qua adapter; adapter nào
  không khả dụng ⇒ việc nằm lại kèm lý do, không đổi đường thanh toán.

## 5. Chính sách (Pha 4) — một chỗ, không rải trong prompt

R0 tài liệu/kiểm thử · R1 mã thường qua PR + cổng · R2 deploy staging / thao tác hoàn tác được · R3 nhạy cảm
production có chính sách · R4 = NEEDS_OWNER. Luôn R4: xoá dữ liệu production, secret, DNS, xác thực, thanh
toán, chi lớn, thao tác không hoàn tác, tắt bảo vệ, lách CI / branch protection.

## 6. Pha và trạng thái

| Pha | Nội dung | Trạng thái |
|---|---|---|
| 0 | Kiểm kê (tài liệu này) | XONG |
| 1 | Project · Goal · Mission · NEEDS_OWNER · CANCELLED · vòng đời chuẩn · sự kiện + audit · trang Goals/Missions | XONG — đã vào `main` (#623, migration 0226) và đã deploy |
| 2 | Worker · lease · heartbeat · cửa worker · adapter thi hành · sổ năng lực tối thiểu · trang Worker | XONG (migration 0229) — mục 8 |
| 3 | Nhánh / cây theo mã việc · PR qua cầu nối bot · CI đỏ ⇒ việc sửa · nối deploy · hậu kiểm | XONG — mục 10 |
| 4 | Chính sách R0–R4 · ngân sách · watchdog | XONG (migration 0230) — mục 11 |
| 5 | Buồng lái mobile trên `/tech` | XONG — mục 12 |
| 6 | Sổ năng lực · định tuyến model | XONG — mục 13 |
| 7 | Dogfood R0/R1 đầu-cuối | XONG CỤC BỘ (07/10/2026) — mục 14; chưa chạy trên production |
| 8 | Gia cố, thử sập/phục hồi | MỘT PHẦN: sập worker / lease hết hạn / fencing / nộp muộn đã khoá bằng bài kiểm; cô lập ĐỌC và credential cần tài khoản hệ điều hành riêng (mục 14) |

Pha 2–6 nằm trên nhánh `feat/tech-control-plane-policy`, gộp SAU nhánh Pha 1. Review độc lập 5 lượt, PASS @ `2c9ba494`.

Chưa được nói "vận hành tự động sẵn sàng" cho tới khi đủ 16 điểm trong đặc tả của chủ shop. Tình trạng 07/10/2026:

| Điểm | Mã | Đã chạy thật trên production |
|---|---|---|
| Tạo goal / task từ `/tech` | có | chưa (chưa gộp) |
| Worker headless · heartbeat · lease · worktree | có | chưa — dogfood cục bộ đạt |
| Log về `/tech` | có | chưa — dogfood cục bộ đạt (38 dòng) |
| Phục hồi khi worker sập · retry | có, khoá bằng bài kiểm | chưa |
| PR | có (cầu nối bot `agent-open-pr.yml`) | chưa — dogfood cục bộ không có cấu hình GitHub |
| CI · deploy · verify | có | chưa |
| Chính sách · ngân sách · NEEDS_OWNER · audit | có | chưa |

Kết luận: MÃ đủ cả 16 điểm, nhưng chưa điểm nào CHẠY trên production — chưa được tuyên bố sẵn sàng.

## 7. Kế hoạch quay lui

- Mọi migration của sứ mệnh này là CỘNG THÊM (bảng mới, cột nullable, mở rộng CHECK). Quay lui mã = revert PR;
  bảng/cột thừa không ảnh hưởng mã cũ. Migration chỉ đi tới (AGENTS.md mục 4).
- Mở rộng CHECK `tech_tasks_status_check`: nếu revert mã khi đã có dòng `NEEDS_OWNER`/`CANCELLED`, mã cũ đọc
  chúng như trạng thái lạ (nhãn rỗng) nhưng không hỏng; đưa chúng về `BLOCKED` bằng tay trên `/tech` trước khi
  revert.
- Worker/adapter (Pha 2) mặc định TẮT; tắt bằng cách dừng tiến trình worker — hàng đợi vẫn nguyên, lease hết
  hạn tự nhả.

## 8. Pha 2 — worker headless (đã dựng)

| Mảnh | Tệp |
|---|---|
| Luật thuần (lease 5′, nhịp tim 30′′, 3 lần thử, lùi dần 5′→60′, 10 lá chắn nhận việc, kết cục → bước kế, tên nhánh tất định, ranh giới thanh toán) | `lib/constants/tech-worker.ts` |
| Sổ năng lực (15 năng lực, mỗi dòng trỏ tệp có thật; worker chỉ được khai năng lực `autonomous`) | `lib/constants/tech-capabilities.ts` |
| Hàng đợi PostgreSQL: nhận việc `UPDATE … (SELECT … FOR UPDATE OF c SKIP LOCKED)`, fencing `lease_generation`, thu hồi lười | `lib/tech/worker-service.ts` |
| Cửa worker `POST /api/tech/worker/{hello,heartbeat,claim,start,complete}` — khoá RIÊNG từng worker, CSDL giữ băm | `app/api/tech/worker/[op]/route.ts` |
| Worker daemon + adapter (`SUBSCRIPTION_CLAUDE_CODE` · `ANTHROPIC_API`, cùng CLI Claude Code, khác đúng môi trường) | `scripts/tech-worker.ts`, `scripts/tech-worker/*` |
| Trang | `/tech/workers` (tạo worker + bộ cài một nút — mục 15; bật/tắt, thu hồi lease, lượt chạy + nhật ký có trần) |

Cài một worker: **/tech/workers → «Tạo worker» → «Cài worker trên máy Windows này» → bấm đúp tệp tải về** (mục 15).
Khoá worker không còn hiện ra màn hình và không ai phải gõ biến môi trường. Chạy tay (máy dev, không qua bộ cài) vẫn
được — đặt `TECH_WORKER_URL` / `TECH_WORKER_TOKEN` / `TECH_WORKER_REPO` rồi `npm run tech:worker -- --check`; khoá lấy
bằng cách chạy bộ cài một lần hoặc đổi mã ghi danh qua `POST /api/tech/worker/enroll` (mã trong thân request).

**Chế độ dogfood an toàn** (lượt production đầu tiên) — không cần mã mới, chỉ cấu hình:

| Ràng buộc | Cách đặt |
|---|---|
| Chỉ R0 | mặc định của trần chính sách (không khai `tech.worker-policy-ceiling`) |
| Một việc một lúc | đăng ký worker với số lượt song song = 1; ngân sách công ty `maxConcurrentRuns = 1` |
| Không thử lại vô hạn | `max_attempts` của việc (3) ∧ ngân sách `maxAttempts = 1` cho sứ mệnh dogfood |
| Không rơi sang tiền API | chỉ đăng ký worker `SUBSCRIPTION_CLAUDE_CODE`; không đặt `TECH_WORKER_ANTHROPIC_API_KEY` |
| Chỉ việc tài liệu | worker khai đúng một năng lực `write-docs` |
| Không đụng production | worker không giữ secret production; deploy vẫn do người / Delivery Controller; năng lực deploy / migration `autonomous = false` |
| Không lách nhánh bảo vệ | PR mở bằng bot `agent-open-pr.yml`, gộp qua `gates / gates` (ruleset hiện 0 lượt duyệt — người gộp là chốt chặn) |
| CI đỏ trên PR của worker | NGƯỜI sửa tay. Việc `ci-debug` máy tự tạo là loại BUGFIX ⇒ chính sách R1 ⇒ KHÔNG được nhận dưới trần R0; nó nằm SPEC_READY và việc gốc đứng ở REVIEW (không tự FAILED, không chi tiền). Huỷ việc `ci-debug` đó trên `/tech` sau khi sửa tay |

Bất biến đã khoá bằng bài kiểm (`tests/tech-worker.test.ts`): hai worker không nhận trùng · phụ thuộc chưa DONE /
R2 / sứ mệnh hoặc mục tiêu không chạy ⇒ không bao giờ nhận, và bản TypeScript `claimBlockers` nói đúng điều câu SQL
làm · nhịp tim gia hạn lease, nhật ký có trần · thất bại còn lượt ⇒ về hàng đợi sau lùi dần, hết lượt ⇒ `FAILED` ·
worker chết ⇒ lease hết hạn ⇒ thu hồi ⇒ việc về hàng đợi · fencing chặn worker cũ sống lại · người huỷ / chuyển
"Cần chủ shop" giữa chừng ⇒ worker nhận lệnh DỪNG ở nhịp tim kế, kết quả nộp muộn không đè quyết định của người ·
worker gói thuê bao không bao giờ thấy `ANTHROPIC_API_KEY` / `DATABASE_URL` / token · tiền của lượt gói thuê bao
ghi `estimated: true`.

Từ mục 15: worker KHÔNG giữ bất kỳ quyền ghi GitHub nào và không `git push` — nó nộp bộ thay đổi, máy chủ tự ghi nhánh bằng
bot rồi dispatch `agent-open-pr.yml` (PR mang danh tính bot).
## 9. Hạn chế đã biết (Pha 1)

- Việc vào "Cần chủ shop" từ `OBSERVING` không quay lại được `OBSERVING` / `DONE`: bảng chuyển không cho NEEDS_OWNER
  vào khâu deploy (để không ai lách cổng duyệt deploy). Lối ra hiện tại là `FAILED` / quay lui rồi đi lại đường deploy.
  Sửa đúng cần "quay về đúng khâu đã rời" có kiểm chứng từ nhật ký — để Pha 4 (chính sách).
- Việc đã TỪNG vào `DEPLOYING` không HUỶ được từ bất kỳ trạng thái nào (dịch vụ đọc nhật ký) — đúng ý đồ.
- Bỏ mục tiêu / huỷ sứ mệnh không đổi trạng thái các VIỆC bên dưới (việc vẫn hiện, người huỷ từng việc nếu muốn), nhưng
  cổng giao việc cho agent (`dispatch-service`) và hàng đợi worker (Pha 2) đều từ chối việc của sứ mệnh / mục tiêu
  không chạy.

## 10. Pha 3 — đường giao hàng: PR → CI → gộp → deploy → hậu kiểm (đã dựng)

Luật thuần: `lib/constants/tech-delivery.ts`. Đọc/ghi + GitHub: `lib/tech/delivery.ts`. Không thêm lịch chạy: móc vào
`github-pr-sync` (sự kiện PR/CI) và `task-advance-watch` (nối deploy + hậu kiểm), cả hai đã có lịch 15′.

| Bước | Ai quyết | Chứng cứ |
|---|---|---|
| Máy chủ ghi nhánh `ai/worker/<MÃ>-a<n>` từ bộ thay đổi worker nộp (mục 15) · lượt THÀNH CÔNG | máy chủ dispatch **`agent-open-pr.yml`** (cầu nối bot đã có, chạy trên `main`) | PR mang tên `erp-agent-vnx[bot]` ⇒ chủ shop duyệt được |
| PR / CI đổi | `github-pr-sync` ghi `pr.opened` · `ci.passed` · `ci.failed` · `pr.merged` · `pr.closed` (khoá chống trùng gắn PR + SHA) | phép chiếu PR đã có |
| CI đỏ trên PR worker | mở MỘT việc con `ci-debug` trên CHÍNH nhánh đó (worker sửa, đẩy lên, PR tự cập nhật); tối đa `CI_FIX_MAX = 2`, hết ⇒ việc gốc `FAILED` | `ci.fix_requested` · `ci.retry_exhausted` |
| Gộp | NGƯỜI duyệt PR + Delivery Controller gộp theo `queue` (không đổi) | `REVIEW → QA` (task-advance, đã có) |
| Lên production | lượt deploy do người / Delivery Controller dispatch (không đổi) | máy chỉ GHI LẠI: deploy THÀNH CÔNG + ĐÃ ĐỐI CHIẾU mà commit đang chạy **chứa** commit gộp (GitHub `compare`, không đoán theo giờ) ⇒ `QA → READY_TO_DEPLOY → DEPLOYING → OBSERVING`; R2 chưa duyệt đứng yên |
| Hậu kiểm | ≥ 30′ quan sát, 0 sự cố SEV0/SEV1 mở sau mốc deploy ⇒ ghi bằng chứng xác minh rồi `DONE`; có sự cố nặng ⇒ `NEEDS_OWNER` (PRODUCTION_INCIDENT) | `verification.passed` · `verification.failed` |

Thay đổi so với Nấc 4 cũ ("máy không bao giờ tự đặt READY_TO_DEPLOY / DONE"): luật đó vẫn đúng cho
`task-advance` (đẩy theo PR). Đường giao hàng là đường KHÁC: nó không quyết deploy, chỉ ghi lại một lượt deploy ĐÃ
xảy ra và đã đối chiếu commit; `DONE` chỉ sau khi bằng chứng xác minh được ghi (cùng cổng `setTechTaskStatus`).
Việc vào OBSERVING bằng tay (không có sự kiện `deploy.reached`) máy KHÔNG đụng.

## 11. Pha 4 — chính sách R0–R4 · ngân sách · watchdog (đã dựng)

- **Chính sách** (`lib/constants/tech-policy.ts::classifyTechPolicy`): dẫn xuất từ máy xếp rủi ro + loại việc + từ khoá
  nguy hiểm; chỉ NÂNG, mọi lần nâng có lý do. Lưu `tech_tasks.policy_level` lúc GHI (tạo việc, đè rủi ro, nút
  "Xếp lại chính sách"). `NULL` (việc trước 0230) = không tự động — đóng khi thiếu, không backfill ngầm. Worker chỉ
  nhận tới TRẦN `settings["tech.worker-policy-ceiling"]` — mặc định **chỉ R0** (chế độ dogfood an toàn), chủ shop mở R1
  bằng `set-setting tech.worker-policy-ceiling {"maxPolicy":"R1"}`, giá trị lạ rơi về R0 (SQL + `claimBlockers` cùng luật); R3/R4 bật cổng duyệt người; R4 = luật SECRETS · ACCESS · DATA_FIX ·
  SCHEDULER, loại SECURITY / DATA_FIX, hoặc nhắc xoá dữ liệu / DNS / thanh toán / lách cổng / mật khẩu / OAuth.
- **Ngân sách** (`tech_budgets`, `lib/tech/budget.ts`): công ty → dự án → mục tiêu → sứ mệnh, tầng hẹp đè TỪNG Ô; ô
  trống = chưa khai. Tiền API chưa khai trần ngày ⇒ worker API không chạy; chạm trần ngày / tổng ⇒ dừng; trần
  đồng thời cấp công ty; trần phút / lượt gửi xuống worker (biến môi trường chỉ được hạ thêm). Tiền API đếm từ sổ
  lượt chạy (`billing = API`); ước tính của gói thuê bao in riêng, KHÔNG cộng vào tiền API.
- **Watchdog** (`lib/tech/watchdog.ts`, trong `task-advance-watch` — không thêm lịch): thu hồi lease hết hạn, ghi
  `worker.lost` khi worker giữ việc mà mất nhịp tim, `budget.warning` (≥ 80%) / `budget.exceeded` (chạm trần) —
  mỗi sự việc MỘT dòng (khoá chống trùng). Vòng thử vô hạn không tồn tại: `max_attempts` · `CI_FIX_MAX` · trần tiền.

## 12. Pha 5 — buồng lái trên `/tech` (đã dựng)

`lib/queries/tech-cockpit.ts` + `app/(dashboard)/tech/cockpit.tsx`, đứng đầu trang `/tech`, lưới 2 cột trên điện thoại:
Cần bạn · Đang chạy (worker sống) · Đang chờ (sẵn sàng / tồn đọng) · Đường giao hàng · Bị chặn · Thất bại · Pull
request (CI đỏ · xanh chờ duyệt) · Chi API hôm nay (trần, tháng). Dưới đó: mỗi lượt đang chạy với việc · năng lực ·
worker · provider · model · thời gian chạy · nhịp tim · bước · % · PR/nhánh · 5 dòng nhật ký cuối. Tab mới:
Cần chủ shop · Mục tiêu · Sứ mệnh · Worker (ngân sách công ty ở trang Worker, ngân sách sứ mệnh ở trang sứ mệnh).

## 13. Pha 6 — định tuyến model + sổ năng lực (đã dựng)

- Sổ năng lực: `lib/constants/tech-capabilities.ts` (15 năng lực, mỗi dòng trỏ tệp có thật — bài kiểm mở từng tệp;
  `autonomous = false` cho deploy / migration / review an ninh / e2e — worker không khai được). Vai PLANNER · DEV ·
  QA · REVIEWER · OPS là nhóm năng lực, không phải tiến trình thường trực.
- Định tuyến model: `lib/constants/tech-routing.ts` — bốn HẠNG (`cheap` · `coding` · `reasoning` · `critical`) theo
  năng lực; mặc định là BÍ DANH của Claude Code (`sonnet` / `opus`), đè ở `settings["tech.model-routing"]` không cần
  deploy; chuỗi đè sai hình dạng bị bỏ. Máy chủ chọn ở lượt nhận việc, worker truyền `--model`. Lý do có thật: lượt
  dogfood đầu tiên (việc tài liệu R0) chạy mặc định bằng model mạnh nhất, ước tính $4,19 / lượt.

## 14. Dogfood đầu-cuối đầu tiên (07/10/2026, cục bộ)

Mặt phẳng điều khiển chạy cục bộ (Next dev + PGlite, mã của nhánh Pha 4), worker chạy headless bằng Claude Code gói
thuê bao trên máy dev — không VS Code, không người can thiệp giữa chừng:

```
GOAL-1 (ACTIVE) → MIS-1 (ACTIVE) → TECH-1 "Viết runbook vận hành worker headless" (R0 · chính sách R0 · SPEC_READY)
→ worker dogfood-local-1 nhận việc qua hàng đợi (lease, lần 1/3) → cây riêng wt-tech-tech-1-a1 từ origin/main
→ npm ci → Claude Code headless (môi trường cho-phép, không khoá API) → cổng typecheck ✅ lint ✅
→ worker commit + đẩy ai/worker/TECH-1-a1 (1 tệp, 254 dòng) → complete SUCCEEDED → TECH-1 REVIEW, lease nhả
→ yêu cầu PR: pr.request_failed "chưa có ERP_GITHUB_REPO" (đúng: ERP cục bộ không có cấu hình GitHub)
```

16 phút · 38 dòng nhật ký · tiền ước tính $4,19 (gói thuê bao, `estimated: true`, không cộng vào tiền API).
Ba lỗi dogfood lộ ra và đã sửa: `cod` khớp nhầm "Claude **Cod**e" (máy xếp rủi ro khớp theo từ), một nhịp tim
lọt ra sau khi nộp kết quả, model mặc định là loại mạnh nhất cho việc tài liệu (định tuyến model).

Hạn chế đã biết (Pha 8): Claude Code đọc được tệp NGOÀI cây làm việc (lượt dogfood đọc mã worker ở cây khác vì
`origin/main` chưa có nó). Cô lập GHI đã giữ (diff đúng 1 tệp trong cây), cô lập ĐỌC cần chạy worker dưới tài khoản
hệ điều hành / container riêng chỉ thấy bản clone của worker.

Credential Git: cổng (`npm ci` / typecheck / lint / test chạy mã của nhánh) đã bị cắt khỏi cấu hình Git HỆ THỐNG và
TOÀN CỤC (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` trỏ tệp tạm, tắt lời nhắc, HOME tạm) nên không gọi được Git
Credential Manager QUA cấu hình Git (đo 07/10/2026 trên máy dev: `credential.helper=manager` của
`C:/Program Files/Git/etc/gitconfig` không còn thấy dưới env của cổng). Mã chạy dưới CÙNG người dùng hệ điều hành vẫn
gọi THẲNG được tệp chạy của GCM. **Đã thay (mục 15, review bảo mật PR #631):** worker không còn `git push` và không cần
credential GitHub nào — máy chủ tự ghi nhánh. Máy chạy worker KHÔNG nên có credential GitHub nào trong Credential Manager
(nhất là tài khoản quản trị kho của chủ shop): mã agent trong cổng chạy dưới cùng tài khoản và gọi thẳng được GCM.

## 15. Cài worker một nút cho chủ shop không kỹ thuật (07/10/2026, migration 0236)

Chủ shop không phải lập trình viên: không clone kho, không sửa biến môi trường, không dán khoá vào PowerShell, không chạy
npm, không cấu hình Windows service. Bốn bước hiện trên `/tech/workers`:

| Bước | Chủ shop làm | Máy làm |
|---|---|---|
| 1 Tạo worker | «Tạo worker» — lần đầu điền sẵn `dogfood-1`, gói thuê bao, chỉ «Viết tài liệu», 1 việc / lúc | `createTechWorkerAction` tạo worker và **không trả khoá** |
| 2 Tải bộ cài | «Cài worker trên máy Windows này», bấm đúp `cai-worker-<mã>.cmd` | tạo MÃ GHI DANH (một lần, 30′, CSDL chỉ giữ băm) nhúng trong tệp — tệp đi về trong thân phản hồi Server Action, không có URL tải |
| 3 Đăng nhập Claude nếu được hỏi | đăng nhập một lần trong cửa sổ hiện ra | bộ cài đọc `claude auth status --json`; chưa đăng nhập / đăng nhập Console (tiền API) ⇒ mở `claude auth login --claudeai` |
| 4 Worker Online | không gì — trang tự làm mới | bộ cài tự kiểm, khởi động worker; nhịp tim đầu ⇒ «Đang sống» |

| Mảnh | Tệp |
|---|---|
| Luật thuần (mã ghi danh, lệnh sửa đóng, chẩn đoán + che secret, sẵn sàng xin việc, ranh giới thanh toán lúc khởi động, trần + phạm vi bộ thay đổi worker nộp (`lib/constants/tech-worker-submit.ts`), bốn bước) | `lib/constants/tech-worker-onboarding.ts` |
| Đổi mã · xoay khoá · tạo lại token · gỡ · chẩn đoán · lệnh sửa · token đẩy | `lib/tech/worker-onboarding.ts` |
| Bộ cài / trình khởi động / tệp gỡ (hàm thuần sinh chuỗi) | `lib/tech/worker-installer.ts` |
| Cửa ghi danh (không cần khoá, mã chỉ từ THÂN, mọi thất bại cùng một `401`) | `app/api/tech/worker/enroll/route.ts` |
| Nhịp tim mang chẩn đoán + nhận lệnh sửa; `submit-changes` (máy chủ ghi nhánh) | `app/api/tech/worker/[op]/route.ts` |
| Server Action (quyền `tech:manage` + audit, không ghi mã / khoá) | `lib/actions/tech-worker-onboarding.ts` |

**Khoá worker không bao giờ đi qua người.** Bộ cài đổi mã ⇒ máy chủ XOAY khoá (khoá cũ — kể cả khoá đã lộ — chết ngay),
bật lại worker, trả khoá mới MỘT lần trong thân phản hồi. «Tạo lại token» = khoá hiện tại chết ngay + bộ cài mới. «Gỡ worker»
= tắt + thu hồi khoá + huỷ mã đang chờ + thu hồi lease (qua đúng bộ thu hồi của hàng đợi) + tệp `go-worker-<mã>.cmd` xoá
Scheduled Task, khoá đã cất và thư mục trên máy. Mọi thất bại xác thực rơi về phía HẸP.

**Cất khoá: DPAPI theo người dùng Windows** (`ConvertFrom-SecureString`, không `-Key`), tệp
`%LOCALAPPDATA%\VNX\tech-worker\<mã>\worker-credential.dpapi`, ACL chỉ chính người dùng. Chọn thay Credential Manager vì
Windows PowerShell 5.1 không có cmdlet cho Credential Manager (phải cài module hoặc `Add-Type` biên dịch C# lúc chạy —
hay bị AMSI chặn); cả hai cùng dựa trên DPAPI nên cùng mức bảo vệ. Trình khởi động `start-worker.ps1` giải khoá vào biến
môi trường CỦA TIẾN TRÌNH worker, không ghi tệp thường, không `.env`. Giới hạn thật (như Credential Manager): tiến trình
cùng tài khoản Windows giải được — việc R1 trở lên vẫn cần tài khoản Windows riêng (mục 14).

**Không rơi sang tiền API — ba lớp:** trình khởi động gỡ mọi biến `API_BILLING_ENV` khỏi tiến trình worker gói thuê bao;
worker TỪ CHỐI CHẠY nếu vẫn thấy một biến như thế (`workerStartupBlockers`, thoát mã 4, báo lý do lên trang); và worker
KHÔNG xin việc khi Claude Code đăng nhập bằng Console (tiền API) hoặc chưa đọc được trạng thái đăng nhập
(`workerReadiness`). Đường Anthropic API vẫn chọn được ở form, kèm cảnh báo tiền + ô xác nhận; bộ cài hỏi khoá API
riêng bằng `Read-Host -AsSecureString` (không hiện, không vào lịch sử) và cất DPAPI; worker API vẫn chỉ chạy khi đã khai
trần chi API / ngày.

**Chẩn đoán + «Sửa lỗi tự động».** Nhịp tim mang báo cáo tự kiểm (kết nối · đăng nhập Claude · kho · Claude Code chạy được
· phiên bản · ANTHROPIC_API_KEY vắng mặt · cách đẩy nhánh · lỗi gần nhất); máy chủ lọc trường, che chuỗi giống secret
(`tw_` · `twe_` · `sk-ant-` · `gh*_` · `Bearer` · `*_TOKEN=` · chuỗi dài ≥ 33 ký tự) và giữ ≤ 4 KB. Lệnh sửa là danh sách
ĐÓNG có CHECK ở CSDL: `RERUN_SELF_CHECK` · `REFRESH_REPO` (fetch + đặt lại bản clone RIÊNG của worker về `origin/main`,
`npm ci` nếu lockfile đổi, khởi động lại) · `PRUNE_WORKTREES` (chỉ khi có `TECH_WORKER_ROOT`; chỉ cây trong `git worktree
list` của CHÍNH kho worker, nằm dưới gốc đó, tên `wt-tech-*`, nhánh `ai/worker/*`, không đang chạy, SẠCH và không còn commit
chưa đẩy; gỡ bằng `git worktree remove` không `--force`, không bao giờ xoá đệ quy — review PR #631: gốc mặc định cũ là thư
mục cha của kho, nơi có cây của người) · `RESTART_LOOP`. Giao đúng một lần ở nhịp tim kế; lệnh cần thoát tiến trình hoãn tới khi worker rảnh. Không có
lệnh tuỳ ý, không tham số.

**Worker KHÔNG giữ bất kỳ quyền ghi GitHub nào — máy chủ tự ghi nhánh.** Review bảo mật PR #631 (lượt 2): mã agent chạy
trong cổng (`eslint.config.mjs`, `tests/*.ts`) dưới ĐÚNG tài khoản Windows của worker giải được khoá worker (DPAPI), gọi
được mọi cửa của worker — nên mọi credential ghi GitHub xuống tới máy worker, dù ngắn hạn hay có trần, đều lấy trộm được,
và token `contents: write` gộp được PR xanh vào `main`. Cửa `push-credential` đã BỎ HẲN. Đường hiện tại:

- Worker xong cổng ⇒ `POST /api/tech/worker/submit-changes` (khoá worker + đúng lease + `leaseGeneration`): danh sách tệp
  `{đường dẫn, nội dung base64 | xoá, chế độ}` + thông điệp commit. KHÔNG gửi tên nhánh. Commit gốc là `base_commit` worker
  báo lúc `start` — máy chủ KHÔNG tin nó: chốt chặn là GitHub phải xác nhận gốc nằm trên `main` (hoặc là đỉnh nhánh).
- Máy chủ kiểm (`validateSubmission`, không tin worker): trần 200 tệp / 1 MB mỗi tệp / 5 MB tổng; đường dẫn chuẩn hoá — cấm
  tuyệt đối, `..`, `.`, đoạn rỗng, `\`, `.git`, `AGENT_FORBIDDEN_PATHS` (`.github/`, `drizzle/`, `package.json`, mã worker…),
  script deploy / cài đặt, Dockerfile, `.gitmodules`; chỉ chế độ 100644 / 100755 (symlink 120000, submodule 160000 ⇒ từ
  chối); tệp chỉ dẫn agent ở MỌI độ sâu theo tên (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, thư mục `.claude` / `.cursor` / `.codex`
  / `.github` / `.husky`, không phân biệt hoa thường, cả ghi lẫn xoá); PHẠM VI theo năng lực của VIỆC (`write-docs` ⇒ chỉ
  `docs/**` + `*.md`, trừ `public/**`) và chính sách (R0 ⇒ chỉ tài liệu / kiểm thử).
- Máy chủ ghi bằng GitHub Git Data API (`commitAgentChanges`): commit gốc → blobs → tree (`base_tree`) → commit (cha = gốc)
  → ref. Nhánh = `ai/worker/<MÃ>-a<n>` lấy từ lượt chạy ở CSDL; gốc = `base_commit` ghi lúc `start`, và GitHub phải xác nhận
  nó nằm trên `main` (nhánh mới) hoặc đúng là đỉnh nhánh (việc sửa CI — cập nhật không force). Token cài đặt riêng của lượt
  ghi (`contents: write`, một kho) không bao giờ rời hàm và bị THU HỒI trong `finally`.
- Idempotent: gửi lại đúng bộ đó ⇒ trả commit cũ, không commit thứ hai; bộ khác cùng lượt ⇒ từ chối. Mỗi lần ghi: sự kiện
  `worker.branch_written` + audit `TECH_WORKER_BRANCH_WRITTEN` (nhánh · gốc · SHA · số tệp · byte — không nội dung).
- Đường `TECH_WORKER_ALLOW_MACHINE_GIT` đã gỡ: worker không còn lệnh `git push` nào.

Rủi ro còn lại, nói thẳng: ruleset `main` hiện 0 lượt duyệt — PR do bot mở từ nhánh worker gộp được khi `gates / gates`
xanh nếu có NGƯỜI (hoặc Delivery Controller) bấm gộp. Phạm vi ghi theo năng lực giới hạn thứ một lượt worker ghi được, nhưng
người gộp vẫn là chốt chặn cuối. Máy chủ chưa có danh tính bot ⇒ worker dừng `BLOCKED` kèm câu chỉ đúng việc (ops
`apply-agent-env`). Không bao giờ hỏi PAT.

**Thu hồi khoá lộ của `dogfood-1` (0236).** Khoá đó đã hiện ra màn hình qua đường "dán vào PowerShell" cũ — đường này đã
gỡ (`registerTechWorkerAction`). Migration đặt băm của một chuỗi ngẫu nhiên không ai giữ + `secret_revoked_at` + tắt worker
+ lý do «Khoá cũ có thể đã lộ — tạo lại bằng bộ cài», ghi một sự kiện `worker.secret_revoked`; điều kiện chặt
(`key = 'dogfood-1'`, chưa từng ghi danh qua bộ cài, chưa thu hồi, tạo trước mốc deploy — KHÔNG xét nhịp tim: khoá đã hiện
ra màn hình là lộ dù đã dùng hay chưa), chạy lại không đổi gì,
không xoá dòng. Sau deploy: chủ shop bấm «Cài worker trên máy Windows này» cho `dogfood-1`.

Chủ shop vẫn phải tự làm: bấm đúp tệp (Windows SmartScreen có thể hỏi «vẫn chạy?» vì tệp tải từ web); đăng nhập Claude
một lần nếu được hỏi; trả lời có / không cho «tự chạy khi đăng nhập Windows». Máy không có winget thì phải tự cài Git /
Node LTS (bộ cài nói rõ). Máy worker không cần (và không nên có) credential GitHub nào. Tắt worker cũng huỷ bộ cài đang chờ (đổi mã sẽ bật lại worker). Bộ cài / tệp gỡ chỉ dừng tiến
trình theo tệp PID khi dòng lệnh của nó chứa thư mục của chính worker (PID có thể đã được Windows cấp lại). Kiểm thử:
`tests/tech-worker-onboarding.test.ts` (phân tích tĩnh bộ cài, không cần Windows; git THẬT trên kho tạm cho lượt đẩy và bộ
dọn cây).
