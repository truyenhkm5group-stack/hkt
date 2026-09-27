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
giao lần nào **Hàng chết → Bình thường** (hàng rời kho mỗi ngày không phải hàng chết — đó là việc của báo cáo hoàn);
hai mẫu đối chứng (không hoàn / không bán) giữ lớp.

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
