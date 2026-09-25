# Bàn giao · Agent G · Mặt phẳng điều khiển (migration 0134)

Nhánh `claude/cos-g-control-plane`, dựng trên `origin/main` 5a3a7ee6.

## 1. Đã dựng

| # | Việc | Ở đâu |
|---|---|---|
| 1 | Duyệt hai bước **hoàn tất được**: lời duyệt được TIÊU THỤ đúng một lần (`EXECUTED` + `executed_at`) khi người xin làm lại ĐÚNG việc (dấu vân tay sha256 của JSON chuẩn hoá: nhóm · thao tác · thực thể · payload) trong `APPROVAL_VALID_HOURS` = 72 giờ. Tiêu thụ là `UPDATE … WHERE id = ? AND status = 'APPROVED' RETURNING`. Bấm lại việc đang CHỜ không đẻ yêu cầu thứ hai (chỉ mục duy nhất một phần). Quá hạn ⇒ `EXPIRED`, ghi **khi chạm** (người xin gọi lại cổng cho nhóm đó) — không có job mới; điều kiện hạn nằm ngay trong phép tiêu thụ nên không bao giờ sai dù cột `status` chưa kịp lật. Quyết định (`decideApprovalCore`) lật có điều kiện `status = 'PENDING'`. | `lib/approvals/service.ts` (lõi, không `"use server"`), `lib/actions/approvals.ts` (lớp mỏng), `lib/constants/approval.ts` |
| 1b | **LỖI THẬT tìm ra khi làm**: `settings.value` là TEXT, cổng cũ đưa CHUỖI JSON vào `isEnforced()` ⇒ cưỡng chế KHÔNG BAO GIỜ bật được, kể cả khi ai đó đã ghi khoá. Nay parse (`parseEnforceConfig`). | `lib/constants/approval.ts`, `lib/approvals/service.ts` |
| 2 | Công tắc `approval.enforce` theo nhóm, CHỈ ADMIN, bật phải xác nhận bằng chữ, `audit()` trước/sau. Chỉ bật được nhóm đã nối (`APPROVAL_GROUPS_WIRED`; `ADS_BUDGET_MUTATION`, `COD_CORRECTION`, `LOGISTICS_OVERRIDE` không bật được). **Không bật nhóm nào.** | `/alerts` → `approval-enforce-panel.tsx` + `approval-enforce-toggle.tsx` |
| 3 | Quyền `approvals:decide` thay điều kiện theo vai. Tập người giữ NGUYÊN: ADMIN, MANAGER (theo VAI — production có mảng ghi đè MANAGER không chứa khoá mới) và ai có `settings:manage` luôn có nó (`withDerivedApprovalDecide`, gọi ở `resolvePermissions` và nhánh vai tuỳ chỉnh của `grantedPermissions`). Vai trò tuỳ chỉnh KHÔNG cấp được (`ROLE_BUILDER_FORBIDDEN`). | `lib/auth/permissions.ts`, `lib/auth/access.ts`, `lib/constants/access-scope.ts`, `lib/validation/access.ts` (câu thông báo) |
| 4 | Nguồn việc `APPROVAL` (SOURCE, phép chiếu `approval_requests` PENDING; phòng `MANAGEMENT`; hạn `null` — không có hằng số hạn duyệt nào đang chạy để lấy lại, luật 22; chủ shop đặt được khoá `APPROVAL` / `APPROVAL:<nhóm>`). Chỉ nút `OPEN_SOURCE` → `/alerts`; đóng DUY NHẤT qua `decideApproval`. Tiền = `MONEY_UNKNOWN` (số tiền xin là quy mô việc, không phải tiền đang treo). Một truy vấn chung cho `/alerts` và `/work`: `lib/queries/approvals.ts`. Không trùng độ mịn cảnh báo nào ⇒ không thêm vào `ALERT_KINDS_OWNED_ELSEWHERE`. | `lib/constants/work-sources.ts`, `work-sla.ts`, `work-ownership.ts`, `lib/queries/work-adapters.ts::adaptApprovals` |
| 5 | `audit_logs.actor_kind` (CHECK USER/SYSTEM/AGENT/WEBHOOK hoặc NULL) · `correlation_id` (chỉ mục một phần) · `reason`. `audit()` ghi cả ba, VẪN ghi `detail` như cũ. Suy loại: khai tường minh → có `userId` ⇒ USER → trong job nền ⇒ SYSTEM → email `job:`/`script:` ⇒ SYSTEM → NULL (chưa biết). Lỗi ghi nhật ký: `console.error`, không ném. `/audit` hiện loại tác nhân, lý do, mã lần chạy. Dòng cũ KHÔNG backfill. | `lib/audit.ts`, `lib/constants/audit-actor.ts`, `app/(dashboard)/audit/columns.tsx` |
| 6 | Bọc `alerts`, `work-recurrence`, `work-escalation`, `work-snapshot`, `dashboard-warm` bằng `runSyncJob` với `observeOnly: true` (ghi `sync_runs`, KHÔNG làm cũ đệm, KHÔNG phát sự kiện `sync`). Chỉ ném lỗi thật mới thành FAILED; "kỳ chưa đóng", "đã gửi hôm nay", lỗi giữ ấm từng kỳ nằm ở `detail` ⇒ không sinh sự cố giả cho `tech-incident-watch`. Gửi Lark/Telegram hỏng ⇒ PARTIAL (không phải FAILED). | `lib/sync/jobs.ts`, `lib/sync/runner.ts` |

Migration `drizzle/0134_company_os_control_plane.sql` (viết tay, idempotent), sổ `_journal.json` idx 134,
`when` 1790002828245. `origin/main` đang dừng ở 0130 ⇒ không trùng; 0131–0133 là của A/D/F.

## 2. Lệch khỏi đề bài / hợp đồng — và vì sao

1. **Sửa `lib/sync/runner.ts`** (không nằm trong vùng sở hữu): thêm tuỳ chọn `observeOnly`. Không có nó
   thì bọc `dashboard-warm` sẽ `staleMemo()` ngay sau khi vừa làm ấm (tự triệt tiêu), và cả năm job sẽ
   phát sự kiện `sync` làm MỌI trình duyệt dựng lại trang — tức là đổi việc job làm. Thay đổi cộng thêm,
   mặc định giữ nguyên hành vi mọi job khác.
2. **Sửa `lib/auth/access.ts` + `lib/constants/access-scope.ts` + `lib/validation/access.ts`**: luật 28 bắt
   phép tính quyền ở đúng `access.ts`; nhánh vai tuỳ chỉnh không suy thì một MANAGER gán vai tuỳ chỉnh mất
   quyền duyệt. `ROLE_BUILDER_FORBIDDEN` thêm `approvals:decide` (luật 31).
3. **`inferActorKind` đặt `userId` TRƯỚC cờ job nền** (đề bài liệt kê job nền trước): `dangTrongJobNen()`
   là bộ đếm TOÀN CỤC của tiến trình, nên trong 60 giây `dashboard-warm` chạy, mọi thao tác của người dùng
   cũng thấy cờ bật. Job nền trong kho ghi nhật ký với `userId = null`, nên không mất nhãn SYSTEM.
4. **`APPROVAL_VALID_HOURS = 72`** là một giá trị MỚI (chưa có hằng số nào để lấy lại). Chủ shop cần xác nhận.
5. Cấp tường minh `approvals:decide` cho một người (quyền riêng, do người có `users:manage`) VẪN được — đó
   là nghĩa của một khoá quyền; hôm nay không ai có khoá này nên tập người lúc deploy khớp đúng luật cũ.

## 3. Kiểm thử

`tests/company-os-control-plane.test.ts` (đăng ký sau `testApproval` trong `tests/sync-fixtures.test.ts`):
tiêu thụ một lần · lần hai phải xin lại · hai lượt đồng thời chỉ một thắng (cả trực tiếp lẫn qua cổng) ·
khác payload / khác người không tiêu thụ · người xin không tự duyệt, không quyền không duyệt, từ chối cần lý
do · quá hạn không tiêu thụ (cả khi chưa ghi EXPIRED) và ghi EXPIRED khi chạm · cưỡng chế tắt ⇒ không đụng
lời duyệt · cấu hình TEXT đọc được · `approvals:decide` = luật cũ ở 80 ca (10 kịch bản × 8 vai) · nguồn
`APPROVAL` hiện/biến mất/hiện DONE trong cửa sổ đã đóng · ba cột audit + CHECK + `console.error` · năm job
chạy thật qua `runJob` và có dòng `sync_runs` SUCCESS/PARTIAL · `observeOnly` không làm cũ đệm (job thường
thì có) · `APPROVAL_GROUPS_WIRED` khớp mã nguồn. `tests/migration-upgrade-path.test.ts`: thêm 0134 vào `MOI`,
dòng cũ ở NULL, CHECK chặn, chỉ mục chống trùng chặn.

**Đột biến (17/17 bị bắt)**: bỏ canh `status` khi tiêu thụ · bỏ so dấu vân tay · bỏ so người xin · bỏ canh
hạn trong phép tiêu thụ (lần đầu KHÔNG bị bắt vì bước EXPIRED che mất — đã thêm kiểm trực tiếp) · đọc chuỗi
thô · bỏ suy quyền ở `resolvePermissions` · bỏ suy quyền ở vai tuỳ chỉnh · cho vai tuỳ chỉnh cấp quyền duyệt
· `observeOnly` vẫn làm cũ đệm · không ghi `actor_kind` · bỏ chống trùng yêu cầu chờ · bỏ nguồn `APPROVAL` ·
nuốt lỗi audit · đảo thứ tự `userId`/job · tiêu thụ khi cưỡng chế tắt · không ghi EXPIRED · WIRED lệch.

Cổng: xem báo cáo cuối của phiên (typecheck · lint · test · build).

## 4. Còn lại (chưa làm, cố ý)

- **Lời duyệt tiêu thụ TRƯỚC thao tác ghi**: thao tác hỏng sau đó ⇒ lời duyệt đã mất, phải xin lại. Nối
  `execution_error` cần sửa từng lời gọi cổng (tệp của D và các miền khác) — để lại.
- `coNguoiDuyetKhac` vẫn đếm vai ADMIN/MANAGER; người có `settings:manage` hoặc được cấp tường minh không
  được đếm ⇒ có thể báo "không có người duyệt" sai về phía CHẶN.
- `approval.executed` (domain event) RESERVED — nối khi sổ sự kiện của Agent A vào `main`.
- Yêu cầu APPROVED đã quá hạn mà người xin không bao giờ thử lại vẫn đọc `APPROVED` trong CSDL (không mở
  khoá gì). Nếu cần sổ sạch: thêm lật EXPIRED vào một job có sẵn — không làm ở bản này.
- `dangTrongJobNen()` toàn cục (lib/cache.ts) — nên chuyển sang AsyncLocalStorage; ngoài phạm vi.
- `/work` hiện tóm tắt yêu cầu duyệt cho phòng MANAGEMENT; `/alerts` đã hiện cho mọi người có `alerts:view` — không đổi mức lộ.

## 5. CỔNG NGƯỜI (HUMAN GATE)

1. **Trước deploy**: `select value from settings where key = 'approval.enforce'` trên production. Nếu có
   dòng, bản này làm nó BẮT ĐẦU có hiệu lực (lỗi đọc TEXT đã sửa) — chủ shop phải biết trước.
2. Chủ shop xác nhận hạn hiệu lực lời duyệt 72 giờ.
3. Bật cưỡng chế nhóm nào là quyết định của chủ shop (production 10/09 chỉ có 2 tài khoản; bật là tự chặn mình
   nếu người duyệt thứ hai không có mặt).
4. Sau deploy: `sync_runs` sẽ nhận thêm ~360 dòng/ngày từ `dashboard-warm` (4 phút/lượt) + ~144 từ `alerts`.
