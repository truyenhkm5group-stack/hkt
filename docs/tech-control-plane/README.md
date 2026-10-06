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
| Cổng CI + bảo vệ `main` | `gates.yml` (4 job + `gates / gates`), ruleset 1 duyệt người | KHÔNG nới, KHÔNG lách |
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
            │  → cổng → commit → push → PR (App)  │
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
| 1 | Project · Goal · Mission · NEEDS_OWNER · CANCELLED · vòng đời chuẩn · sự kiện + audit · trang Goals/Missions | ĐANG LÀM (PR 1) |
| 2 | Worker · lease · heartbeat · cửa worker · adapter thi hành | |
| 3 | Worktree theo mã việc · PR/CI/deploy chảy về · webhook GitHub · nối (B) | |
| 4 | Rủi ro R0–R4 · ngân sách · watchdog | |
| 5 | Cockpit mobile trên `/tech` | |
| 6 | Sổ năng lực · skill nội bộ · định tuyến vai/model | |
| 7 | Dogfood R0/R1 đầu-cuối | |
| 8 | Gia cố, thử sập/phục hồi | |

Chưa được nói "vận hành tự động sẵn sàng" cho tới khi đủ 16 điểm trong đặc tả của chủ shop (tạo goal/task từ
`/tech` · worker headless · heartbeat · lease · worktree · log về `/tech` · phục hồi khi worker sập · retry ·
PR · CI · deploy · verify · chính sách · ngân sách · NEEDS_OWNER · audit).

## 7. Kế hoạch quay lui

- Mọi migration của sứ mệnh này là CỘNG THÊM (bảng mới, cột nullable, mở rộng CHECK). Quay lui mã = revert PR;
  bảng/cột thừa không ảnh hưởng mã cũ. Migration chỉ đi tới (AGENTS.md mục 4).
- Mở rộng CHECK `tech_tasks_status_check`: nếu revert mã khi đã có dòng `NEEDS_OWNER`/`CANCELLED`, mã cũ đọc
  chúng như trạng thái lạ (nhãn rỗng) nhưng không hỏng; đưa chúng về `BLOCKED` bằng tay trên `/tech` trước khi
  revert.
- Worker/adapter (Pha 2) mặc định TẮT; tắt bằng cách dừng tiến trình worker — hàng đợi vẫn nguyên, lease hết
  hạn tự nhả.

## 9. Hạn chế đã biết (Pha 1)

- Việc vào "Cần chủ shop" từ `OBSERVING` không quay lại được `OBSERVING` / `DONE`: bảng chuyển không cho NEEDS_OWNER
  vào khâu deploy (để không ai lách cổng duyệt deploy). Lối ra hiện tại là `FAILED` / quay lui rồi đi lại đường deploy.
  Sửa đúng cần "quay về đúng khâu đã rời" có kiểm chứng từ nhật ký — để Pha 4 (chính sách).
- Việc vào "Cần chủ shop" từ `DEPLOYING` / `OBSERVING` không HUỶ được (dịch vụ đọc khâu đã rời từ nhật ký) — đúng ý đồ.
- Bỏ mục tiêu / huỷ sứ mệnh không đổi trạng thái các VIỆC bên dưới (việc vẫn hiện, người huỷ từng việc nếu muốn), nhưng
  cổng giao việc cho agent (`dispatch-service`) và hàng đợi worker (Pha 2) đều từ chối việc của sứ mệnh / mục tiêu
  không chạy.
