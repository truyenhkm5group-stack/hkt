# Chi phí, giá, bảng kê

## 1. Sổ chi phí — một khoản một nguồn

| Khoản | Nguồn | Phân bổ |
|---|---|---|
| AI nền tảng trả (`PLATFORM` + `HOME`) | `platform_ai_usage.cost_usd` × `FACEBOOK_USD_VND` | trực tiếp theo workspace + sản phẩm của `feature` |
| AI khoá của khách (`BYOK`) | `platform_ai_usage` | KHÔNG phải chi phí nền tảng — in riêng |
| Hạ tầng / hỗ trợ NỀN theo tháng | `platform_settings['platform.economics.costs']` (0203, khai ở `/platform/saas`) | chia đều mọi workspace đang chạy, KỂ CẢ nhà |
| API ngoài, tin nhắn, lưu trữ, hạ tầng riêng, khác | `platform_cost_entries` (0224) | căn cứ khai trên dòng: trực tiếp · chia đều · theo tỷ trọng AI |

`allocateCosts()` (thuần): tổng phân bổ bằng ĐÚNG số khai (dư đồng lẻ dồn về đầu); chưa khai ⇒ `null`; không căn cứ để
chia ⇒ để ở `unallocated`, không chia đều lặng lẽ.

## 2. Bộ máy giá → bảng kê (`lib/saas/statement.ts`)

Một hàm thuần cho cả hai cách lập chứng từ:

- **EXTERNAL_INVOICE**: gói (gộp: một lần / workspace; riêng: theo thuê bao) · mua thêm · vượt hạn mức (khi gói khai đơn
  giá vượt). Dùng thử = 0 THẬT. Gói không niêm yết giá ⇒ dòng chưa biết.
- **INTERNAL_CHARGEBACK**: như trên theo giá gói nếu có khai (gói `internal` chưa có giá ⇒ chưa biết) CỘNG chi phí biến đổi
  thật (AI nền tảng trả, phân bổ, trực tiếp).
- Tổng = tổng các dòng biết số, luôn kèm số dòng chưa biết.

## 3. Kinh tế đơn vị

Doanh thu = phần khách trả (gói · mua thêm · vượt) của khách ngoài. Chi phí = AI nền tảng trả + phân bổ + trực tiếp.
Lãi gộp, biên % theo tài khoản (danh sách khách), theo sản phẩm (doanh thu gói RIÊNG — gói gộp không chia được trung
thực về sản phẩm, màn hình nói ra), theo workspace (trang khách). Khách nội bộ: biên **N/A**, chi phí in đủ. Cảnh báo
«Đang lỗ gộp» khi lãi gộp < 0.

## 4. Chốt kỳ

Nháp tính lúc đọc. «Chốt kỳ» (kỳ đã qua, một lần, có lý do) đóng băng dòng + kinh tế + phiên bản bộ máy vào
`platform_billing_statements` — sửa công thức sau không đổi kỳ đã chốt. Giới hạn v1: bảng kê dựng bằng tình trạng thuê
bao lúc chốt (không lịch sử thay đổi trong kỳ) — chốt ngay đầu tháng sau.

Thu tiền khách ngoài vẫn đi đường 0187 (`platform_invoices`, VietQR, khớp sổ ngân hàng nhà, `BillingProvider` #612).
Bảng kê không tạo lệnh thu thứ hai. Thu tiền phần vượt cần chủ nền tảng chốt đơn giá + kỳ thu (`PLAN.md`).
