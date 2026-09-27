# Phase 3 — Workflow foundation: hợp đồng chung

> Kế hoạch và lý do: `phase-3-plan.md` (W1–W10). Tệp này chốt LƯỢC ĐỒ, KIỂU và CHỮ KÝ để các agent
> làm song song. Agent không tự tạo phiên bản riêng.

## 1. Lược đồ (migration `0160_workflow_foundation`, trong CSDL tổ chức)

```sql
workflow_rules (id text pk, key text unique, name text, description text,
  status text default 'DRAFT' check in ('DRAFT','ACTIVE','PAUSED','ARCHIVED'),
  mode text default 'DRY_RUN' check in ('DRY_RUN','LIVE'),
  trigger jsonb, conditions jsonb, actions jsonb, gate jsonb,       -- gate NULL = không cần duyệt
  version int default 1, created_by, updated_by, activated_by, activated_at, created_at, updated_at)
workflow_runs (id text pk, rule_id text, rule_version int, mode text,
  trigger_kind text, trigger_ref text, subject_type text, subject_id text,
  dedupe_key text UNIQUE,                                           -- rule + nguồn: chạy lại không nhân đôi
  status text check in ('DRY_RUN','PENDING','WAITING_APPROVAL','DONE','SKIPPED','FAILED','REJECTED'),
  steps jsonb default '[]', causation_depth int default 0, approval_request_id text, error text,
  created_at, updated_at, finished_at)
workflow_cursors (key text pk, value text, updated_at)              -- con trỏ tiêu thụ domain_events
-- NỚI (chỉ thêm giá trị) hai CHECK có sẵn:
work_items.creation_source      IN ('AUTO','MANUAL','RECURRING','WORKFLOW')
work_item_events.source         IN ('UI','API','SYSTEM','RECURRENCE','WORKFLOW')
```

## 2. Kiểu (`lib/workflow/types.ts`, client-safe)

```ts
type WorkflowTrigger =
  | { kind: "event"; event: string }                                       // tên trong lib/constants/domain-events.ts
  | { kind: "custom_status"; objectKey: string; fieldKey: string; to: string[]; from?: string[] };  // field custom kiểu status
type WorkflowCondition = { all: WorkflowCondition[] } | { any: WorkflowCondition[] } | { field: FieldRef; op: ListFilterOp; value?: unknown };
type WorkflowAction =
  | { kind: "create_task"; title: string; summary?: string; departmentCode?: string; priority?: "LOW"|"NORMAL"|"HIGH"|"URGENT"; dueInHours?: number }
  | { kind: "notify"; message: string }                                   // thông báo trong ERP cho người có quyền của phòng / quản trị
  | { kind: "set_custom_value"; field: string; value: unknown };           // qua saveCustomValues (kiểm hợp lệ + chuyển trạng thái)
type WorkflowGate = { kind: "approval"; reason: string } | null;
```

Tập ĐÓNG: không `eval`, không SQL do người khai, không HTTP ra ngoài, không đổi trạng thái HỆ THỐNG.

## 3. Nguồn trigger

- `event:` — đọc `domain_events` theo con trỏ `workflow_cursors['domain_events']` (recorded_at, id), tối đa
  200 sự kiện / lượt.
- `custom_status:` — `saveCustomValues` (Phase 2) phát sự kiện miền MỚI `custom_status.changed`
  (subject = bản ghi của đối tượng, payload `{ objectKey, recordId, fieldKey, from, to }`) khi một field
  kiểu `status` đổi giá trị. Tên mới khai đủ ba chỗ: `lib/constants/domain-events.ts`,
  `docs/company-os/shared-contracts.md` mục 2, bài kiểm tên sự kiện.
- Chặn vòng lặp: `set_custom_value` do workflow ghi mang `causation_id = run id`; sự kiện sinh ra có
  `causation_depth` = độ sâu của run + 1; > 3 ⇒ run `FAILED` "vòng lặp".

## 4. Dịch vụ (`lib/workflow/*`, chỉ máy chủ) — chữ ký chốt

```ts
// rules.ts
listRules(): Promise<WorkflowRule[]>; getRule(id);
saveRule(input: unknown, actor): Promise<{ ok: true; rule } | { ok: false; code; errors: FieldError[] }>;   // luôn DRAFT; kiểm trigger/điều kiện/hành động
setRuleStatus(id, status: "ACTIVE"|"PAUSED"|"ARCHIVED", actor): Promise<…>;                                 // ACTIVE ⇒ ảnh chụp meta_config_versions (kind WORKFLOW)
setRuleMode(id, mode: "DRY_RUN"|"LIVE", actor): Promise<…>;
// evaluate.ts (THUẦN)
evaluateCondition(cond: WorkflowCondition | null, subject: Record<string, unknown>): boolean;   // subject: "system:<k>" / "custom:<k>"
// engine.ts
runWorkflows(opts?: { limit?: number }): Promise<{ events: number; runs: number; executed: number; waiting: number; failed: number }>;
previewRule(ruleId, subject: { objectKey; recordId }): Promise<{ matched: boolean; wouldDo: WorkflowStepPreview[] }>;   // chạy thử, KHÔNG ghi
listRuns(opts): Promise<WorkflowRunRow[]>;
```

- Chạy ké job `alerts` (sau `reservation-sweep`), trong `withOrganization` sẵn có của runJob. KHÔNG thêm lịch.
- `DRY_RUN`: ghi run trạng thái `DRY_RUN` với `steps` = việc SẼ làm; không tạo việc, không thông báo, không ghi giá trị.
- Cửa duyệt: nhóm `WORKFLOW` trong `APPROVAL_GROUPS`; `requested_by = NULL` (máy xin), payload `{ runId, ruleId, reason }`;
  run `WAITING_APPROVAL`. Lượt chạy sau: APPROVED ⇒ thực thi ĐÚNG MỘT LẦN (UPDATE … WHERE status='WAITING_APPROVAL'
  RETURNING) rồi đánh dấu yêu cầu EXECUTED; REJECTED/EXPIRED ⇒ run `REJECTED`.
- `create_task`: việc WORK nguồn `WORKFLOW_TASK` (khai ở `work-sources.ts`, SLA, phòng sở hữu),
  `creation_source = 'WORKFLOW'`, `source_key = run id` ⇒ lũy đẳng.

## 5. Quyền & giao diện

- Khoá `workflow:manage` (ADMIN; loại khỏi MANAGER; vai trò tuỳ chỉnh không cấp) — module `core`.
- `/settings/workflows`: danh sách luật · form luật (trigger / điều kiện / hành động / cửa duyệt — ô chọn, không
  vẽ sơ đồ) · chạy thử trên một bản ghi · bật ACTIVE · chuyển LIVE (xác nhận) · bảng lượt chạy gần đây.

## 6. Phase 3.1 — hardening (bổ sung, không đổi chữ ký cũ)

- **Lượt chạy có hạn giữ** (migration `0162_workflow_run_lease`, CHỈ THÊM cột): `workflow_runs.attempt int default 0`,
  `lease_until timestamptz`, `last_heartbeat_at timestamptz`. Chiếm lượt = `claimRun` (một câu `UPDATE … WHERE
  attempt < 3 AND (status='WAITING_APPROVAL' OR PENDING-quá-hạn) RETURNING`); lượt không cửa duyệt sinh ra đã chiếm
  sẵn. Mỗi bước xong ghi `steps` + gia hạn, chỉ khi `attempt` còn là của mình. Lượt thử lại bỏ qua bước `DONE`.
- **Lũy đẳng khai từng hành động** (`ACTION_RETRY_SAFETY` trong `lib/workflow/actions.ts`): `create_task` theo khoá
  `WORKFLOW_TASK:<run>:<i>`, `notify` theo `notifications.dedupe_key = workflow:<run>`, `set_custom_value` cùng giá trị
  ⇒ không đổi gì, không phát sự kiện. Hành động chưa chứng minh được ⇒ lượt treo chứa nó KHÔNG tự thử lại (FAILED).
- **Trần**: quá 3 lần chiếm ⇒ FAILED "Treo quá số lần thử", lời duyệt thanh toán BẰNG LỖI (không tính là đã làm).
- **Chẩn đoán**: `listStaleRuns()` (`lib/workflow/stale.ts`) — bốn loại `LEASE_EXPIRED` · `DECISION_NOT_APPLIED` ·
  `UNSETTLED_APPROVAL` · `STUCK_FAILED`; cùng câu hỏi ở dòng cảnh báo `/settings/workflows` (`?view=stale`) và cột
  "Lượt luật treo" của `npm run platform:diagnostics`.
- `runWorkflows()` trả thêm `recovered` (số lượt treo đã chiếm lại trong lượt này).
