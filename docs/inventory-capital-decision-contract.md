# Hợp đồng: Quyết định vốn tồn kho

Đọc kèm `docs/inventory-forecast-contract.md` (tồn/tốc độ/số nên đặt) và
`docs/business-rules/ORDER_OUTCOME.md`. Cài đặt: `lib/constants/inventory-decision.ts` (mô hình
thuần) + `lib/queries/inventory-decision.ts` (ghép dữ liệu). Kiểm thử khoá:
`tests/inventory-decision.test.ts`. Giao diện: `/inventory/decisions`.

## 1. Câu hỏi trang này trả lời

ERP đã nói được *tồn bao nhiêu* và *cần đặt bao nhiêu*. Trang này trả lời câu tiếp theo của chủ
shop: **với từng mẫu mã, nên làm gì với TIỀN** — đặt thêm (và cần bao nhiêu vốn), giữ nguyên, hay
xả để giải phóng bao nhiêu vốn — kèm lý do và mức tin cậy cho từng kết luận.

## 2. Không có phép đo mới

Bộ máy này **chỉ ghép** các nguồn đã có, không tính lại gì:

| Con số | Nguồn duy nhất | Ghi chú |
|---|---|---|
| Tồn thực tế / khả dụng / đã chốt / đang ở ngoài / chờ hoàn | `getReplenishmentPlan` → sổ kho (`lib/queries/stock.ts`) | phiếu kho − sự kiện Viettel Post |
| Tốc độ bán (chống nhiễu), số nên đặt, ngày hết hàng | `computePlan` / `computeVelocity` (`lib/constants/planning.ts`) | cùng số với trang Kế hoạch SX |
| Ngưỡng hàng chậm / hàng chết / mức tồn lành mạnh | `SLOW_MOVING_RULES` (`lib/constants/slow-moving.ts`) | không chép số |
| Ngưỡng tỷ lệ hoàn đáng lo | `VERDICT_RULES.riskReturnRatePct` | không chép số |
| Tỷ lệ hoàn theo mẫu mã | `delivered`/`returned` của PlanRow (ORDER_OUTCOME) | ≥ 20 đơn kết thúc mới dùng số riêng, không thì dùng số toàn shop và NÓI RA |
| Hàng đã đặt xưởng chưa nhận | `production_orders` trạng thái `SENT` | thứ Kế hoạch SX KHÔNG trừ — trang này trừ |
| Giá vốn | giá phiếu nhập gần nhất → giá nhập Pancake | 0 ⇒ CHƯA BIẾT (`null`), không phải 0đ |
| Tuổi mẫu mã | phiếu `RECEIPT` đầu tiên | mẫu mới không bị kết tội hàng chết |

## 3. Sáu kết luận, thứ tự xét cố định

```
1. Chưa có phiếu nhập            → DATA_INSUFFICIENT   (tồn CHƯA BIẾT thì không phán)
2. Tồn âm + không có nhịp bán    → DATA_INSUFFICIENT   (sổ lệch — kiểm kê, không phải đặt hàng)
3. Hết hàng / hết trước khi SX kịp → STOCKOUT_RISK     (tồn âm nhưng vẫn bán: vẫn báo, tin cậy THẤP)
4. Còn thiếu sau khi trừ MỌI nguồn cung → REORDER      (nguồn cung gồm cả hàng đã đặt xưởng)
5. Không bán: mẫu mới → HOLD; im ắng ≥ 60 ngày → CLEARANCE_CANDIDATE
6. Tồn vượt 120 ngày bán → OVERSTOCK; còn lại → HOLD
```

Mỗi kết luận bắt buộc kèm: `reason` (câu tiếng Việt), `notes` (khoảng trống dữ liệu), `confidence`
(HIGH/MEDIUM/LOW theo đúng quy ước `lib/constants/recommendation.ts`), số đề xuất, tiền vốn.

## 4. Tiền

- **Vốn cần** = số nên đặt (đã trừ tồn khả dụng + hàng sắp quay về + **hàng đã đặt xưởng**) × giá
  nhập gần nhất. Thiếu giá nhập ⇒ `null`, giao diện ghi "chưa có giá nhập".
- **Vốn giải phóng được** = phần tồn vượt mức đủ bán 45 ngày (hàng chết: toàn bộ tồn) × giá nhập.
  Đây là tiền ĐÃ BỎ RA đang nằm trong kho, không phải doanh thu sẽ thu khi xả.
- **Ước lãi gộp mất** (chỉ STOCKOUT_RISK) = tốc độ × số ngày trống hàng × (giá bán − giá nhập) ×
  (1 − tỷ lệ hoàn). Chỉ tính khi biết CẢ giá bán lẫn giá nhập; **luôn mang nhãn ước tính**.

## 5. Mức tin cậy — hạ vì lý do cụ thể, không hạ chung chung

Mỗi khoảng trống dữ liệu ghi một dòng vào `notes` và kéo tin cậy xuống: thiếu giá nhập · tốc độ đã
cắt ngày đột biến (livestream) · thời gian SX là giả định chung (chưa khai riêng cho mã) · tỷ lệ
hoàn dùng số toàn shop · bán 30 ngày < 5 món · tỷ lệ hoàn riêng ≥ 40%. Tồn âm ⇒ tin cậy THẤP
tuyệt đối.

## 6. Đối chứng lịch sử (backtest) — proxy, nói trước giới hạn

Chạy lại bộ máy tại mốc 30 ngày trước trên dữ liệu dựng lại (phiếu kho + mốc rời kho
`picked_up_at`), rồi so với chân trời sau đó: dự báo hết hàng ↔ tồn dựng lại có thật sự về ≤ 0;
dự báo chôn vốn ↔ có còn vượt ngưỡng; dự báo nên xả ↔ có tiếp tục không bán. Giới hạn: tồn quá khứ
không gồm "đã chốt chưa gửi", tốc độ không cắt đột biến, nhu cầu mất vì trống hàng không nguồn nào
ghi được. Toàn bộ mang nhãn ƯỚC TÍNH.

## 7. Cấm

1. **Chỉ đề xuất.** Không tự tạo đơn sản xuất, không sửa tồn, không ghi bất cứ gì.
2. **CHƯA BIẾT ≠ 0**: thiếu giá nhập / phiếu nhập / lead time thì hiện chưa biết, không lấy 0.
3. Không đo lại tồn/tốc độ/kết quả đơn — mọi thay đổi công thức phải sửa ở nguồn
   (`planning.ts`, `stock.ts`, `slow-moving.ts`), trang này tự khớp theo.
4. Không kết tội "hàng chết" cho mẫu dưới 14 ngày tuổi.
5. Ngưỡng riêng của bộ máy chỉ sửa ở `DECISION_RULE`; không hard-code nơi khác.
