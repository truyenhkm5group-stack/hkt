# Kiểm kê tiếp quản — một phiên duy nhất

Ngày 09/09/2026. Từ thời điểm này chỉ **một** phiên tiếp tục làm ERP; các phiên trước coi là
CLOSED/HANDOFF. Nguồn sự thật: kho mã + nhánh remote + CSDL production.

---

## 0. Bốn phiên trước làm việc thế nào

**Không có bốn nhánh riêng.** Cả bốn dùng chung một cây làm việc và commit thẳng vào `main`. Nên
không có gì để "fetch rồi cherry-pick" theo phiên — việc của họ đã nằm xen kẽ trong lịch sử tuyến
tính của `main`. Chữ ký git của cả bốn giống hệt nhau (`hkt77 <truyenhk@vnxcommerce.com>`), nên quy
việc theo **nội dung**, không theo siêu dữ liệu.

Rủi ro thật của mô hình đó **không phải** xung đột gộp nhánh mà là:

1. **commit dở dang** — commit phần giao diện trước phần lõi, `main` đỏ ở khoảng giữa (xảy ra 2 lần);
2. **thao tác git trên cây chung** — `reset` làm văng commit vừa tạo của phiên khác (1 lần, đã khôi
   phục), và commit từ chỉ mục cũ **ghi đè mất việc vừa vào** (1 lần, phát hiện ở mục 3).

## 1. Việc đầu tiên khi tiếp quản: chốt an toàn

- Cây làm việc lúc tiếp quản có 12 mục khác `main`. Đọc kỹ: **hầu hết là bản CŨ nằm lại** sau lệnh
  `reset` trước đó (hoàn tác nhầm `useNavTransition` của phiên hiệu năng, hoàn tác chú thích Profit
  Engine). Không phải việc đang làm dở.
- Vẫn chụp toàn bộ vào nhánh `wip/takeover-snapshot-20260909` (`89b391b`) **trước khi** dọn, rồi mới
  đưa cây về đúng `main`. Không mất gì.
- Từ đó trở đi cây làm việc sạch, và cổng ra chạy trên **worktree riêng dựng từ SHA**, không dùng
  cây chung.

## 2. Kiểm kê nhánh remote

| Nhánh | Commit chưa vào `main` | Kết luận | Rủi ro |
| --- | ---: | --- | --- |
| `claude/erp-data-truth-p0` | 0 | đã gộp hết | — |
| `claude/release-engineering-p0` | 0 | đã gộp hết | — |
| `claude/vtp-direct-fulfillment-p1` | 0 | đã gộp hết; **Direct VTP Fulfillment vẫn PENDING theo lệnh** | — |
| `codex/erp-data-truth-p0` | 0 | đã gộp hết | — |
| `perf/p0-reporting-speed` | 0 | đã gộp qua `ccca775` | — |
| `hotfix/vtp-import-recovery` | 3 | **nội dung đã có trong `main`** dưới SHA khác (`0f3a667`, `659da12`, `8748010`); `main` còn nhiều hơn nhánh | không |
| `claude/mb-bank-transaction-app-3am23s` | 8 | **sản phẩm ĐỘC LẬP** trong thư mục `hkt/` (03–04/09), không phải ERP. Sổ ngân hàng của ERP đã có riêng (`0042_bank_ledger` + `app/(dashboard)/bank`). **Không gộp** — gộp vào là kéo một ứng dụng thứ hai vào kho | không |
| `claude/fashion-erp-poscake-viettelpost-u97pgx` | 2 | **1 commit có việc thật chưa ai làm ⇒ ĐÃ THU HỒI**; 1 commit đã bị `main` phủ | đã xử lý |
| `wip/dirty-snapshot-20260909` | 1 | ảnh chụp cũ, `main` đã vượt qua | không |
| `wip/takeover-snapshot-20260909` | 1 | ảnh chụp lúc tiếp quản, giữ để tra cứu | không |

### Đã thu hồi: đơn Pancake chưa chuẩn hoá địa chỉ

`32f5cec` (07/09) là phần duy nhất trên mọi nhánh cũ **chưa có trong `main`** và **vẫn còn giá trị**.

Pancake chỉ giao được khi ghép được địa chỉ khách vào đơn vị hành chính. Ghép không được thì
`ship_province` rỗng, POS hiện *"Vui lòng cung cấp địa chỉ cần chuẩn hoá"*, đơn nằm im — và ERP
**không hề báo**. Đo lại trên production hôm nay: **386/2.423 đơn trong 60 ngày, 231 đơn còn sống**.

Đã cherry-pick, đổi hai định danh tiếng Việt sang tiếng Anh theo `AGENTS.md` §1, thêm assertion khoá
hai điều (đếm khớp đơn còn sống; nhãn bộ lọc không đếm chính tập vừa lọc ra). Commit `c0085bc`.

## 3. Việc bị mất do thao tác git — đã khôi phục

| Việc | Chuyện gì xảy ra | Xử lý |
| --- | --- | --- |
| Biên bản Session 3 + bản đóng băng Session 1 | một phiên chạy `reset` về `origin/main`, hai commit vừa tạo rơi khỏi `main` | commit lại nguyên nội dung và thông điệp gốc (`f91cb50`, `586205e`) |
| **Bộ lọc + dải chip theo BỘ PHẬN** trên trang Cần xử lý | commit `d8d6593` (phiên hiệu năng) ghi đè `alerts/page.tsx` và `queue-filters.tsx` từ một bản nền cũ. Lõi `CASE_TEAM`/`byTeam` vẫn còn trong `lib` nhưng **giao diện biến mất** — `byTeam` được tính ra rồi không ai nhìn thấy, bộ lọc theo bộ phận không bấm tới được | khôi phục ở `02368eb` |

Đây là loại hỏng khó thấy nhất: không đỏ typecheck, không đỏ kiểm thử, chỉ là một tính năng lặng lẽ
biến mất khỏi màn hình.

## 4. Kiểm kê theo mảng

| Mảng | Ở đâu | Đã ở `main`? | Sạch? | Migration | Cần tích hợp? | Rủi ro |
| --- | --- | :-: | :-: | --- | :-: | --- |
| Release engineering | `.github/workflows/deploy-vps.yml`, `scripts/smoke.ts`, `scripts/final-gate.ts` | ✓ | ✓ | — | không | thấp — SHA đã ghim, xem §5 |
| Hiệu năng / UX chờ | `lib/perf/*`, `components/nav-progress.tsx`, `loading.tsx` từng trang | ✓ | ✓ | `0041` | không | **đã gây mất tính năng khác** (mục 3) |
| Phân bổ & thẩm quyền chi phí | `lib/constants/cost-authority.ts`, `lib/queries/cost-engine.ts`, `cost-allocation.ts` | ✓ | ✓ | `0036`, `0044` | không | thấp |
| Sổ ngân hàng | `lib/queries/bank.ts`, `app/(dashboard)/bank/*` | ✓ | ✓ | `0042` | không | thấp |
| Kiểm đếm hàng hoàn | `lib/returns/inspection.ts`, `app/(dashboard)/inventory/returns` | ✓ | ✓ | `0043` | không | thấp |
| Hàng đợi việc | `lib/constants/action-queue.ts`, `lib/queries/action-queue.ts` | ✓ | ✓ | `0037`, `0045` | không | trung bình — xem §6 |
| Mua hàng & xưởng | `lib/queries/purchasing.ts` | ✓ | ✓ | — | không | **số liệu chưa đối chiếu production** |
| Giữ chân khách / CRM | `lib/queries/crm.ts` | ✓ | ✓ | — | không | **số liệu chưa đối chiếu production** |
| Mô phỏng kịch bản | `lib/queries/scenario.ts` | ✓ | ✓ | — | không | thấp — chỉ đọc, có kiểm thử khoá |
| Phân quyền | `lib/auth/permissions.ts`, `tests/access-control.test.ts` | ✓ | ✓ | — | không | **đổi hành vi thật**: vài vai trò mất quyền tải CSV |
| Tóm tắt quản trị | `lib/queries/business-brief.ts` | ✓ | ✓ | — | không | thấp — deterministic, có kiểm thử |
| Quy kết quảng cáo | `lib/constants/ads-identity.ts`, `ads-attribution-link.ts` | ✓ | ✓ | `0038` | không | **trần thật ~49%**, xem §7 |
| Máy khuyến nghị quảng cáo | — | ✗ | — | — | **CHẶN** | thiếu độ phủ, xem §7 |
| Máy duyệt / workflow | — | ✗ | — | — | **CHỜ CHỦ SHOP** | xem §8 |
| Điều hướng / menu | `components/app-sidebar.tsx` | ✓ | ✓ | — | **đã sửa** | 3 trang từng không có lối vào |
| Tài liệu & kiểm thử | `docs/`, `tests/` | ✓ | ✓ | — | không | thấp |

## 5. Kỹ thuật phát hành — đã đạt

- Workflow ghim `ref: ${{ github.sha }}`, truyền `ERP_DEPLOY_SHA` sang VPS, bootstrap tải đúng SHA
  đó, và **có bước đối chiếu** `/api/health` với SHA mong đợi. Không deploy "`main` mới nhất".
- Smoke test phân loại được kết quả và **ký lại phiên trước từng trang**, nên `307` không còn bị báo
  nhầm thành lỗi ứng dụng.
- `tests/repo-integrity.test.ts` chặn tệp được tham chiếu mà chưa vào kho.

## 6. Đã sửa trong phiên này — "đã đóng" không phải "đã làm"

Production có **3.896 việc đã đóng** và không ai trả lời được bao nhiêu là công của đội: cột
`resolved_at` gộp *người làm xong* · *điều kiện tự hết* · *thôi theo dõi*.

Đã tách bằng `resolution` (MANUAL · AUTO · STALE · UNKNOWN) + `resolved_by`, ràng buộc CHECK ở mức
CSDL. 3.896 dòng lịch sử ghi `UNKNOWN` — **không suy đoán ngược**, và không tính vào tỷ lệ nào.

Cùng lúc phát hiện một lỗi im lặng: vòng tự đóng chỉ chạm loại cảnh báo **đang bật**, nên tắt một
loại đi là việc cũ của nó nằm lại hàng đợi vĩnh viễn. Nay đóng với nhãn `STALE`.

## 7. Quy kết quảng cáo — trần thật, không làm đẹp

Đo trên production: **49,2%** (1.172 đơn qua `ad_id`; đường nối bài viết thêm ~17 đơn).

Khuyến nghị cũ *"tách mỗi bài về một chiến dịch để lên 78%"* **đã rút lại**: chủ shop nêu rõ nghiệp
vụ marketing scale một bài ra nhiều quảng cáo → nhóm → chiến dịch → tài khoản, và ngược lại. Quan hệ
bài ↔ chiến dịch là **nhiều–nhiều theo thiết kế**.

Cách duy nhất tăng độ phủ mà không bịa số: gắn mã theo dõi riêng cho từng mẩu quảng cáo (`ref`/`utm`)
để đơn mang được `ad_id` thật. Đó là quyết định về cách chạy quảng cáo, không phải việc phần mềm.

⇒ **Máy khuyến nghị quảng cáo (SCALE/CUT) tiếp tục BỊ CHẶN**, trả `DATA_INSUFFICIENT` cho phần dưới
ngưỡng. Không bật khuyến nghị trên tập thiếu quy kết.

## 8. Máy duyệt / workflow — chờ chủ shop quyết, không tự áp

Yêu cầu §10 là chèn một tầng **PENDING_APPROVAL → APPROVED** trước các thao tác nhạy cảm (điều chỉnh
tồn, đề xuất sản xuất, đề xuất mua, sửa COD, sửa dữ liệu).

Phần **an toàn** của yêu cầu đó ERP đã có đủ:

- lớp tư vấn **không được ghi** — khoá ở mức mã nguồn, 13 module, `tests/advisory-safety.test.ts`;
- không tự đổi ngân sách quảng cáo, không tự tạo đơn mua, không tự sửa tồn;
- mọi thao tác ghi đều qua `requireUser` + `can()` + `audit()`, và `audit()` đã ghi đủ **sáu câu**:
  ai · làm gì · trên cái gì · trước ra sao · sau ra sao · vì sao, kèm `correlationId`.

Phần **còn thiếu** là bắt buộc có NGƯỜI THỨ HAI duyệt. Đó không phải thay đổi kỹ thuật mà là **thay
đổi cách làm việc hằng ngày** của kho và kế toán — thêm một bước chờ vào mỗi lần điều chỉnh tồn.
`AGENTS.md` §7 buộc hỏi chủ shop trước khi đổi quyền/vai trò/quy trình. Nên:

```
WORKFLOW_APPROVAL_ENGINE = BLOCKED_ON_OWNER_DECISION
```

Câu cần chủ shop trả lời: **thao tác nào phải có người thứ hai duyệt, và ai là người duyệt?** Có câu
trả lời là làm được ngay — bảng, vòng đời và nhật ký chuyển trạng thái đều đã có sẵn nền.

## 9. Việc còn nợ, đã ghi nhận

| # | Việc | Trạng thái |
| --- | --- | --- |
| 1 | Đối chiếu số Mua hàng & xưởng, Giữ chân khách trên production sau deploy | **cần làm sau deploy** |
| 2 | Máy duyệt / workflow | `BLOCKED_ON_OWNER_DECISION` |
| 3 | Máy khuyến nghị quảng cáo | `DATA_INSUFFICIENT` cho tới khi có mã theo dõi từng mẩu |
| 4 | Direct VTP Fulfillment | **PENDING theo lệnh** — không mở |
| 5 | Vài vai trò mất quyền tải CSV sau khoá quyền API | đúng chủ đích; mở lại thì cấp thêm khoá quyền, không bỏ kiểm tra |
