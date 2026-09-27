# Phase 3 — Workflow Engine foundation: kế hoạch

> Điều kiện bắt đầu: Phase 2 (metadata) chạy khoẻ trên production. Khảo sát hạ tầng sẵn có ngày
> 27/09/2026 (chỉ đọc, tệp:dòng trong bản khảo sát của phiên tích hợp). Nguyên tắc: **dùng lại** sổ
> sự kiện, hàng đợi việc, cửa duyệt và job runner đang chạy — KHÔNG xây một engine, một hàng đợi hay
> một hệ duyệt thứ hai.

## 1. Cái đã có, và vai trò của nó trong workflow

| Mắt xích | Tái dùng | Ở đâu |
| --- | --- | --- |
| TRIGGER · sự kiện | `domain_events` (append-only, `dedupe_key`, `causation_id`) — 22 tên LIVE (model, sản xuất, mẫu, hàng hoàn, duyệt…) | `lib/events/emit.ts`, `lib/constants/domain-events.ts` |
| TRIGGER · lịch | khuôn `work_recurrences` (nhịp cố định, sinh lũy đẳng `onConflictDoNothing`) | `lib/work/service.ts::generateRecurringTasks` |
| TRIGGER · trạng thái | khuôn "ứng viên" của cảnh báo (poll điều kiện, tự đóng khi hết) — cho đơn / vận đơn / CSKH vốn KHÔNG phát `domain_events` | `lib/alerts/rules.ts::collectCandidates` |
| CONDITION | ngữ pháp `ListFilter` + field của sổ đối tượng (Phase 2); khớp chữ/khoảng kiểu `bank_rules` | `lib/metadata/types.ts`, `lib/constants/object-registry.ts` |
| ACTION · việc | tạo việc WORK lũy đẳng + `logWorkEvent`; `assignByAuthority`; `planDistribution` (chạy thử) | `lib/work/*` |
| ACTION · báo | `deliverNotifications` / Lark theo tổ chức (có thử lại) | `lib/alerts/*` |
| ACTION · nghiệp vụ | gọi SERVER ACTION của miền (luật 19) — không bao giờ ghi thẳng bảng miền | `lib/actions/*` |
| HUMAN GATE | `approval_requests` + `guardSecondApprovalCore` + `withApprovalExecution` (giữ chỗ → thanh toán); quyền `approvals:decide`; hàng đợi `/work` đã chiếu nguồn APPROVAL | `lib/approvals/*` |
| CHẠY | `JOB_DEFINITIONS` + `runJob` (luôn `withOrganization`, kiểm module) | `lib/sync/*` |

Mẫu trigger→action ĐANG chạy thật: `LIFECYCLE_FOLLOW` / `followModelLifecycle` (actor SYSTEM, có
`sourceEventId`, chỉ đi cạnh tiến, lũy đẳng) — khuôn cho mọi hành động máy.

## 2. Mười quyết định

**W1 — Luật là metadata của tổ chức** (CSDL tổ chức, như Phase 2): `workflow_rules(id, key, name,
status DRAFT|ACTIVE|PAUSED|ARCHIVED, mode DRY_RUN|LIVE, trigger jsonb, conditions jsonb, actions
jsonb, gate jsonb, version, …)` + ảnh chụp xuất bản ở `meta_config_versions`. **Luật mới sinh ra ở
DRAFT + DRY_RUN** (luật 23, 25): không có luật nào tự chạy thật khi vừa tạo.

**W2 — Tập trigger ĐÓNG:** `event:<tên domain_event đã khai>` · `schedule:<nhịp work_recurrences>` ·
`record_changed:<đối tượng trong sổ>` (poll theo `updated_at` + con trỏ) · `custom_status:<đối tượng>.<field status>`
(từ lượt ghi giá trị custom của Phase 2 — nguồn tin tốt nhất cho đối tượng không phát domain_events).

**W3 — Tập điều kiện ĐÓNG:** cây AND/OR của `ListFilter` trên field hệ thống + custom của đối tượng
mang trigger; hàm đánh giá THUẦN (`evaluateCondition`), không `eval`, không SQL người dùng.

**W4 — Tập hành động ĐÓNG** (Phase 3 MVP): `create_task` (việc WORK, nguồn mới `WORKFLOW_TASK`) ·
`notify` (Lark / thông báo theo tổ chức — một tin gom, KHÔNG một tin mỗi bản ghi, luật 26) ·
`set_custom_value` (qua `saveCustomValues` của Phase 2 — vẫn qua kiểm hợp lệ + chuyển trạng thái) ·
`request_approval` (HUMAN GATE). KHÔNG có hành động đổi trạng thái HỆ THỐNG (đơn, vận đơn, COD, kho).

**W5 — HUMAN GATE dùng `approval_requests`**, thêm: nhóm duyệt `WORKFLOW` trong `APPROVAL_GROUPS`,
người xin = MÁY (`requested_by` NULL + `actor_kind SYSTEM`, ghi `workflow_rule_id`), và **bên thực
thi sau khi APPROVED** (hiện chưa có — cổng chỉ mở khoá khi người xin bấm lại): lượt chạy kế tiếp của
job thấy yêu cầu APPROVED ⇒ thực thi hành động còn lại qua `withApprovalExecution` (đúng một lần).
REJECTED/EXPIRED ⇒ lượt chạy dừng, lý do ghi lại.

**W6 — Sổ lượt chạy** `workflow_runs(id, rule_id, rule_version, trigger_ref, dedupe_key UNIQUE,
status PENDING|WAITING_APPROVAL|DONE|SKIPPED|FAILED|DRY_RUN, steps jsonb, causation_depth, error, …)`.
`dedupe_key = rule_id + nguồn (event id | bản ghi + kỳ)` ⇒ chạy lại không bao giờ nhân đôi.

**W7 — Chặn vòng lặp:** hành động của workflow ghi `causation_id`; độ sâu > 3 ⇒ dừng + FAILED; luật
KHÔNG được nghe tên sự kiện `workflow.*` do chính workflow phát (kiểm lúc lưu luật).

**W8 — Chạy ké job `alerts` (10 phút)** như `reservation-sweep` đã làm — KHÔNG thêm mục lịch
(đổi lịch scheduler là việc phải hỏi chủ shop, AGENTS.md §7). Mỗi lượt có trần số bản ghi / số hành
động; quá trần ⇒ để lượt sau, ghi rõ. Chạy trong `withOrganization` (runJob); fan-out cho tổ chức
khác theo cờ `SCHEDULER_FANOUT` đã có.

**W9 — Nguồn việc `WORKFLOW_TASK`** (authority WORK) khai đủ ở `work-sources.ts`, SLA, phòng sở hữu;
mở rộng CHECK `creation_source` (+`WORKFLOW`) và `work_item_events.source` (+`WORKFLOW`) bằng
migration CHỈ NỚI ràng buộc. Kiểm `ALERT_KINDS_OWNED_ELSEWHERE` để không đếm hai lần.

**W10 — Quyền `workflow:manage`** (ADMIN; loại khỏi MANAGER; vai trò tuỳ chỉnh không cấp). Chuyển
luật sang LIVE là lượt ghi có nhật ký + (nếu luật có hành động `set_custom_value` trên tiền) đi cửa duyệt.

## 3. Thứ tự làm (mỗi bước một PR, mỗi bước chạy thử trước)

1. Lược đồ `workflow_rules` + `workflow_runs` + nới CHECK; kiểu + bộ đánh giá điều kiện thuần + bài kiểm.
2. Trigger `event:` + `custom_status:` + hành động `create_task`/`notify` ở DRY_RUN; job ké `alerts`.
3. HUMAN GATE (nhóm `WORKFLOW`, bên thực thi sau duyệt) + `set_custom_value`.
4. Giao diện cấu hình luật dạng form (KHÔNG vẽ sơ đồ kéo-thả) + màn hình lượt chạy (chạy thử ⇒ xem
   kết quả giả định ⇒ bật LIVE).
5. Trigger `schedule:` + `record_changed:`.

## 4. Kiểm chấp nhận Phase 3

Tổ chức A tạo luật "khách chuyển sang trạng thái nghiệp vụ `vip` ⇒ tạo việc gọi chăm sóc cho phòng
Bán hàng, cần quản lý duyệt": DRY_RUN cho thấy việc SẼ tạo mà không tạo; bật LIVE ⇒ đổi trạng thái khách
⇒ yêu cầu duyệt xuất hiện ở `/work` ⇒ người khác duyệt ⇒ lượt chạy kế tiếp tạo đúng MỘT việc; chạy lại
không nhân đôi; tổ chức B không thấy luật / lượt chạy / việc của A; không deploy giữa các bước.

## 5. Không làm ở Phase 3

Trình vẽ workflow kéo-thả, luật viết bằng mã / biểu thức tự do, hành động gọi HTTP ra ngoài tuỳ ý,
đổi trạng thái hệ thống (đơn, vận đơn, COD, kho) bằng luật.
