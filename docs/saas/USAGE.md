# Đo dùng — sổ thô, gộp lúc đọc, một chỉ số một nguồn

| Nguồn | Bảng | Ghi bằng | Dùng cho |
|---|---|---|---|
| `AI_LEDGER` | `platform_ai_usage` | `recordAiUsage` (đường duy nhất; khoá sự kiện từ #612) | lượt gọi model, token, chi phí AI, theo `feature` ⇒ sản phẩm (`ProductDef.aiFeatures`) |
| `DAILY_SNAPSHOT` | `platform_tenant_usage_daily` | `captureUsage` (0204, đếm chứng từ trong CSDL workspace) | hội thoại mới, tin khách, tin AI, đơn AI |
| `EVENT_LEDGER` | `platform_usage_events` (0224) | `recordUsage` / SDK `recordProductUsage` | chỉ số sản phẩm tự ghi |

- Mỗi `ProductMetric` khai ĐÚNG một nguồn; `recordUsage` từ chối chỉ số nguồn khác (chỉ số AI không ghi lần hai).
- Idempotent: khoá duy nhất (workspace, `event_key`). Tài khoản + thuê bao gắn vào dòng do MÁY CHỦ tra.
- Thô ≠ gộp: sổ sự kiện chỉ thêm; `readProductUsage(period)` gộp lúc đọc theo kỳ tháng giờ VN.
- Chỉ số `EVENT_LEDGER` chưa có đường ghi production khai `emitterLive: false` ⇒ đọc ra `—` (chưa đo), không phải 0. Hôm
  nay ERP và Chốt Đơn chưa khai chỉ số `EVENT_LEDGER` nào: mọi số dùng của hai sản phẩm đọc từ hai sổ đã có.
- Đọc chỉ số kinh doanh sâu (hội thoại phân biệt cả kỳ, fanpage đang chạy) cho hạn mức: `readPeriodUsage` (#612).
- Hỏng một nguồn ⇒ chỉ số của nguồn đó `null` + lý do.

## Khách AI — đồng hồ thu chính (0226 · `PRICING_V1.md` §II.2)

- `chotdon.ai_customers` (`EVENT_LEDGER`, `emitterLive: true`) ghi tại điểm gửi thành công của `lib/sales-chatbot`
  (`markWaitingForCustomer` → `lib/pricing/ai-customer.ts::noteAiCustomerReply`). Khoá `ai_customer:<YYYY-MM>:<kênh>:<page>:<khách>`
  ⇒ một khách một kỳ một dòng.
- Đọc kèm ĐỘ PHỦ (`readAiCustomerUsage`): runtime cũ `chatbot/` ⇒ `null` (chưa đo); đồng hồ bật giữa kỳ ⇒ cận dưới. Sổ dùng chung
  không còn trả 0 cho workspace chưa đo (`loadCommercialSnapshot` thay số đọc thô bằng số có độ phủ).
- Hội thoại mới / tin AI gửi không còn `billable` (fair-use).
