# Hệ vận hành theo ngày — tiến độ theo từng khâu

Sổ theo dõi sống. Kiểm và số liệu: `docs/measured-daily-operating-system-report.md`.
Định nghĩa: `docs/operating-funnel-metric-contract.md`.

`✅` đo được và có việc để làm · `⚠️` nguồn thiếu một phần · `⬜` chưa có nguồn / chưa có luật phát hiện

| # | Khâu | Đo | Tuổi việc | Hạn xử lý | Tiền | Chủ | Tra ngược |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Quảng cáo · kéo khách | ✅ | ✅ | ✅ | ⬜ không tra được tiền theo việc | ✅ | `/ads` |
| 2 | Khách nhắn / tiềm năng | ⚠️ | ✅ | ✅ | ⬜ chưa có mô hình nối hội thoại với doanh thu | ✅ | `/cs` |
| 3 | Đơn đã lên | ✅ | ✅ | ✅ | ✅ | ✅ | `/orders` |
| 4 | Chờ xác nhận | ✅ | ✅ | ✅ | ✅ | ✅ | `/orders?stage=NEW` |
| 5 | Soát rủi ro trước gửi | ✅ | ✅ | ✅ | ✅ | ✅ | `/alerts?type=RISKY_ORDER` |
| 6 | Chờ bàn giao ĐVVC | ✅ | ✅ | ✅ | ✅ | ✅ | `/orders?stage=CONFIRMED` |
| 7 | Đã bàn giao ĐVVC | ✅ | ✅ | ⬜ cố ý không đặt hạn | ✅ | ✅ | `/shipments` |
| 8 | Đang giao / giao hụt | ✅ | ✅ | ✅ | ✅ | ✅ | `/shipments?stage=DELIVERY_FAILED` |
| 9 | Giao thành công | ⬜ khâu đích, không có việc tồn | — | — | ✅ | ✅ | `/reports/returns` |
| 10 | Hoàn về | ✅ | ✅ | ⬜ cố ý không đặt hạn | ✅ | ✅ | `/reports/returns` |
| 11 | COD chờ về | ✅ | ✅ | ✅ | ✅ | ✅ | `/cod?recon=unproven` |
| 12 | Tiền đã về | ⚠️ sổ ngân hàng trống | — | — | ✅ | ✅ | `/cod` |
| 13 | Hàng hoàn chờ kiểm đếm | ⚠️ xem §7 báo cáo | ✅ | ✅ | ✅ | ✅ | `/inventory/returns` |
| 14 | Tồn kho & vốn | ⚠️ 2 phiếu nhập | ✅ | ✅ | ✅ | ✅ | `/products` |
| 15 | Sản xuất / nhập hàng | ⬜ 0 lệnh sản xuất | — | — | — | ✅ | `/inventory/planning` |
| 16 | Mua lại / chăm sóc | ✅ | ✅ | ✅ | ✅ | ✅ | `/customers/retention` |

## Còn nợ, có chủ đích

| Việc | Chặn ở đâu |
| --- | --- |
| Ước tính tiền thu hồi | Cần ca **có người bấm đóng** để đo tỷ lệ thật. Hiện 0 ca. Tự bật khi đội bắt đầu dùng hàng đợi. |
| Tốc độ phản hồi lead | Nguồn không có mốc phản hồi đầu tiên cho từng hội thoại. |
| Tỷ lệ chuyển giữa các khâu | `conversion` đã có trong hợp đồng, chưa cắm số — `getSalesFunnel` mới phủ 5/16 khâu. |
| "Cứu được" của COD quá hạn / hàng hoàn chờ đếm | Cần định nghĩa riêng (tiền về / hàng vào tồn), không dùng chung định nghĩa giao thành công. |
| 471 kiện hoàn vs 16 việc trong hàng đợi | Cần chủ shop chốt luật phát hiện — xem §7 báo cáo. |
