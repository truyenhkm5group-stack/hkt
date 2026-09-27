# Company OS · Agent V — MỘT tốc độ bán (27/09/2026)

Quyết định: chủ shop giao Tech Lead ("Bạn làm thế nào tốt nhất thì làm") → gộp HAI định nghĩa tốc độ bán về
**định nghĩa của Kế hoạch SX** (tốc độ gửi đi, hàng hoàn trừ tường minh sau độ trễ hoàn). Lý do và công thức:
`docs/inventory-forecast-contract.md` §1–2. **Ngưỡng hàng chậm (`inventory.slowMoving`) không đổi. Không migration.**

## 1. Đã làm gì

| Việc | Tệp |
|---|---|
| MỘT hàm số ngày phủ `coverDaysOf` (tách từ `computePlan`, không đổi một phép tính) + nghịch đảo `qtyForCoverDays` + gộp `pooledPace` + đọc lại từ dòng kế hoạch `paceOfPlanRow` + làm tròn in `roundCoverDays` | `lib/constants/planning.ts` |
| Đường đọc chung `getVariantPaceMap()` (từ `getReplenishmentPlan().rows`) | `lib/queries/planning.ts` |
| Phép xếp lớp thuần `classifyStockRisk` (ngưỡng cũ, thêm đúng một nhánh: gửi đi mà hàng hoàn về bằng hàng đi ⇒ Vốn nằm chết, số ngày in `—`) | `lib/constants/slow-moving.ts` |
| **Hàng chậm** đọc dòng Kế hoạch SX; XOÁ câu bán ròng riêng (`windowSalesSubquery`) | `lib/queries/slow-moving.ts`, `app/(dashboard)/inventory/planning/slow-moving-section.tsx` (cột "Gửi đi/ngày") |
| **Hiệu quả mẫu mã** (và nhãn mẫu mã / tín hiệu mẫu / trang chủ dựng trên nó): thôi tự chia số GIAO ĐƯỢC cho số ngày của kỳ | `lib/queries/product-intelligence.ts` |
| **Tệp khách xả hàng**: thôi tự chia TỒN cho bán ròng 30 ngày (định nghĩa thứ ba, in vô cực khi không bán) | `lib/outreach/build.ts` |
| **Vòng phản hồi tồn** + **dòng tổng mã hàng** ở Kế hoạch SX: thôi chia thẳng khả dụng ÷ tốc độ (bỏ qua độ trễ hoàn) | `lib/constants/stock-feedback.ts`, `lib/queries/stock-feedback.ts`, `lib/queries/inventory-decision.ts` (mang `netVelocity` + `returnLagDays`), `app/(dashboard)/inventory/planning/page.tsx` |
| Quyết định vốn tồn: đã dùng số của Kế hoạch SX từ trước — chỉ đổi sang `roundCoverDays` | `lib/queries/inventory-decision.ts` |
| Ops đo trước/sau `velocity-compare` (CHỈ ĐỌC, CHỈ SỐ ĐẾM) | `scripts/velocity-compare.ts`, `.github/workflows/ops-vps.yml` |
| Kiểm thử | `tests/velocity-unify.test.ts` (đăng ký sau Agent W trong `tests/sync-fixtures.test.ts`), sửa `tests/product-intelligence.test.ts`, helper `tests/company-os-stock-feedback.test.ts` |

Ngoại lệ còn lại, đã khai trong hợp đồng: **đối chứng lịch sử** (`backtestInventoryDecisions`) vẫn dựng tốc độ tại
mốc cắt quá khứ — ước tính có nhãn, không có GTC / độ trễ hoàn của thời điểm đó. Bài kiểm đếm đúng 1 phép chia của nó.

## 2. Hướng dịch lớp (đã khai, có kiểm thử)

Tốc độ gửi đi ≥ tốc độ ròng cũ (thêm đơn hoàn + hàng tặng) ⇒ số ngày phủ **ngắn lại** ⇒ lớp dịch **về phía Bình
thường**. Khi đo được độ trễ hoàn, phần tồn vượt `tốc độ × độ trễ` hao theo nhịp ròng nên mức dịch nhỏ hơn.
Mẫu mã không hoàn, không tặng: tốc độ cũ = mới; lớp chỉ đổi nếu độ trễ hoàn đo được kéo dài số ngày phủ
(script in riêng dòng "đổi lớp mà tốc độ gửi đi = tốc độ ròng cũ").

Bộ dữ liệu dựng riêng (PGlite): nhiều hoàn **Vốn nằm chết → Bình thường** (140 → 1,7 ngày); mọi đơn đều hoàn, chưa
giao lần nào **Hàng chết → Hoàn gần hết** (xem mục 5 — bản đầu để nó rơi vào Bình thường, SAI); đang đi chưa kết
luận không gắn nhãn; hai mẫu đối chứng (không hoàn / không bán) giữ lớp.

## 3. Đo TRƯỚC khi deploy — lệnh cho Tech Lead

Script chạy được NGAY sau khi gộp vào `main`, KHÔNG cần deploy: ops lấy script từ `main`, và script chỉ import tên
đã có trên ảnh đang chạy (`computeVelocity`, `getReplenishmentPlan`, `loadPlanningAssumptions`,
`resolveSlowMovingRules`, `SLOW_MOVING_KEY`, `ORDER_OUTCOME_FAST`, `PRIMARY_ATTEMPT`, `chayKhongJit`, `rowsOf`).
Giả định: ảnh đang chạy ≥ 25/09/2026 (có `resolveSlowMovingRules` / `SLOW_MOVING_KEY` của Agent D).

```
Actions → "Vận hành ERP trên VPS" → Run workflow
  action = velocity-compare
  arg    = (để trống)
```

hoặc `gh workflow run ops-vps.yml -f action=velocity-compare -f arg=` . Đọc khối **"Tóm tắt do script tự khai"**
(≈ 10 dòng `[ops:tom-tat]`): số mẫu mã mỗi lớp CŨ / MỚI, `ĐỔI LỚP: k/N — DEAD→HEALTHY … · EXCESS→SLOW …`, tốc độ
mới > / = / < cũ, số ngày phủ ngắn / dài hơn. Chép các dòng đó vào commit/PR (AGENTS.md 6.5).

Vế CŨ là bản sao đo lường DUY NHẤT được phép của câu bán ròng (chép từ `lib/queries/slow-moving.ts` tại `main`
f84be840) — vì sau deploy `getSlowMoving` trên ảnh đã là định nghĩa mới. Vế MỚI gọi thẳng `getReplenishmentPlan()`
của ảnh (định nghĩa thắng, không đổi trong bản gộp) thay vì chép SQL của nó: chép cả thang bậc GTC theo mã, độ trễ
hoàn và tỷ lệ nhập lại được bằng SQL là dựng bản sao thứ hai của đúng thứ đang gộp. Kiểm thử khẳng định vế MỚI trùng
`getSlowMoving()` mới trên TỪNG mẫu mã.

Sau deploy chạy lại một lần: vế MỚI phải ra đúng các con số của bảng "Vốn đang nằm chết" trên `/inventory/planning`.

## 4. Chưa làm / cần người quyết

- Chưa đo production (phiên này không có quyền) — số trước/sau nằm ở lượt `velocity-compare` đầu tiên.
- Đối chứng lịch sử vẫn là ước tính riêng (mục 1). Muốn gộp nốt thì cần dựng GTC / độ trễ hoàn TẠI mốc cắt — việc riêng.

## 5. Bản vá "Hoàn gần hết" (nhánh `claude/cos-hoan-gan-het`, 27/09/2026)

Đo production (ops `velocity-compare`, run 36306328239, 28 mẫu mã, TRƯỚC deploy #312): 7 mẫu đổi lớp —
SLOW→EXCESS 4 (do trừ hàng hoàn tương lai — chấp nhận), HEALTHY→EXCESS 1, HEALTHY→SLOW 1, **DEAD→HEALTHY 1 — sai**:
mẫu gửi đi mà khách hoàn gần hết không bao giờ được đọc "Bình thường". Chủ shop duyệt bản vá.

| Việc | Tệp |
|---|---|
| Lớp `RETURNED_OUT` "Hoàn gần hết / gửi đi không giao được" trong phép xếp lớp DUY NHẤT; nhãn · màu · việc nên làm · câu ⓘ | `lib/constants/slow-moving.ts` |
| Hai sự kiện cửa sổ (món gửi đi / món hoàn trong `deadDays`) đọc chung câu "lần cuối giao được"; tồn của lớp này toàn bộ là vượt mức | `lib/queries/slow-moving.ts` |
| Bảng Hàng chậm: nhãn + ⓘ "vì sao" (lý do có số + định nghĩa lớp) | `app/(dashboard)/inventory/planning/slow-moving-section.tsx` |
| Quyết định vốn tồn: cờ `returnedOut` từ lớp của Hàng chậm ⇒ **Nên xả**, 0 đề xuất đặt | `lib/constants/inventory-decision.ts`, `lib/queries/inventory-decision.ts` |
| Vòng phản hồi tồn: PUSH_STOCK có mẫu hoàn gần hết ⇒ việc chính "Xem lý do hoàn của mã" (`/reports/returns?period=90d&product=<mã>`), lý do "khách hoàn gần hết — xem lại chất lượng / mô tả trước khi đẩy thêm"; creative / khách cũ thành lối khác; khoá đề xuất mang `RETURNED_OUT:<mẫu>` | `lib/constants/stock-feedback.ts`, `lib/queries/stock-feedback.ts` |
| Tệp khách xả hàng: nhịp của mẫu hoàn gần hết không vào "đủ bán" (như hàng chết) | `lib/outreach/build.ts` |
| Bản tin kinh doanh: rủi ro tồn gồm cả lớp mới | `lib/queries/business-brief.ts` |
| Ops `velocity-compare`: vế MỚI tự xếp lớp mới (bản sao thuần `xepLop` + câu SQL chỉ đọc `deadWindowFacts`, vì `classifyStockRisk` mới chưa có trên ảnh); vế CŨ `xepLopCu` nguyên văn f84be840; dòng mới `HOÀN GẦN HẾT (mới …): n mẫu mã — lớp CŨ của chúng: …` | `scripts/velocity-compare.ts` |

Lệch so với lời giao (có lý do): lời giao nói "không giao thành công + có gửi đi". Bản vá đòi THÊM **có ít nhất một
món đã kết luận hoàn** — đơn còn đang đi là CHƯA BIẾT; không có vế này, một mẫu mới toàn đơn đang giao sẽ bị gắn
"hoàn gần hết". Kiểm thử có đúng ca đó (v6).

**Đo lại (không cần deploy):** chạy lại `action = velocity-compare`, `arg` để trống. Kỳ vọng: cặp `DEAD→HEALTHY`
thành `DEAD→RETURNED_OUT` (hoặc biến mất), dòng `HOÀN GẦN HẾT (mới …)` ≥ 1 và `CŨ Hàng chết → MỚI Bình thường: 0`.
