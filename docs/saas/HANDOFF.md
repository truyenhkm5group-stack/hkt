# Bàn giao sau nền móng SaaS Control Plane — Phase A–F

> Viết 07/10/2026 bởi Delivery Controller, sau khi #612 (giá & thu phí, 0223) và #615 (Control Plane, 0224) đã lên production.
> **Master Mission CHƯA XONG.** Nền móng đã chạy; sáu phase dưới đây là phần còn lại, mỗi phase một sứ mệnh trong sổ điều
> phối (`npm run ai -- board`).

## 1. Đã lên production (bằng chứng)

| Mục | Kết quả đo |
|---|---|
| Deploy | #612 → `5529f717` (run 37489937226), #615 → `0b5ec24f` (run 37496420935); hậu kiểm ĐẠT cả hai |
| Migration | 0223 + 0224 áp an toàn; tổ chức nhà 225 dòng = sổ 224 + 1 dòng lịch sử |
| Smoke có phiên | 0 trang đỏ; `/platform/customers`, `/platform/products`, `/platform/saas`, `/platform`, `/chatbot` mở được |
| Sổ thương mại | `vnxcommerce` INTERNAL · INTERNAL_CHARGEBACK; 6 khách EXTERNAL; 7/7 workspace gắn tài khoản; ERP + Chốt Đơn ACTIVE cho cả 7 |
| Khách hiện có | Mọi job fan-out của 6 tổ chức khách trả 200 sau deploy (mở đúng CSDL của từng tổ chức) |
| Sổ dùng / chi phí / bảng kê | 0 dòng — ĐÚNG thiết kế: số dùng đọc từ sổ AI + sổ dùng theo ngày (USAGE.md), chi phí do người vận hành khai, bảng kê lập theo kỳ |

Sửa trong lúc tích hợp (review độc lập): huỷ thuê bao của workspace NHÀ / tài khoản nội bộ bị chặn (trước đó một cú bấm tắt
~26 module của `vnx`); «Tạo khách» trên workspace đã có bị chặn ở mọi nhánh (trước đó tạo thêm quản trị ADMIN trong CSDL khách).

## 2. Phase còn lại

| Phase | Sứ mệnh | Trạng thái | Ai quyết | Việc |
|---|---|---|---|---|
| A | `saas-a-vnx-runtime` | ĐANG LÀM | Kỹ thuật → **chủ shop duyệt từng page** | Gỡ 4 chặn kỹ thuật ở OWNERSHIP §4 (ghi đơn POS, webhook nhà, lịch job nhà, nguồn AI của nhà) với `ai_sales` nhà vẫn TẮT; sau đó bóng MỘT page → so hội thoại vàng → chủ shop duyệt → chuyển từng page → tắt container bot cũ |
| B | `saas-b-internal-special-cases` | ĐANG LÀM | Kỹ thuật | Gỡ nhánh `isHome` THƯƠNG MẠI (nhà đọc gói `internal` qua cùng đường khách ngoài), giữ nhánh isHome AN TOÀN; bài kiểm so trước/sau |
| C | `saas-c-shared-identity` | ĐANG THIẾT KẾ | Kỹ thuật + **chủ shop duyệt đổi quyền** | User toàn nền tảng + membership nhiều workspace; thiết kế + bất biến SECURITY §3 ở `docs/saas/IDENTITY.md` trước khi viết mã |
| D | `saas-d-pricing-overage` | CHẶN — chờ chủ shop | **Chủ shop** | Chốt bảng giá: giá tháng/năm từng gói, hạn mức, đơn giá phần vượt, kỳ thu. Kỹ thuật gieo vào `platform_plans.commercial`, không tự đặt số (luật 38) |
| E | `saas-e-customer-portal` | SẴN SÀNG | Kỹ thuật | Cổng khách: tự đổi gói theo sản phẩm, API key, tên miền theo sản phẩm (PLAN Phase 12) |
| F | `saas-f-legacy-cleanup` | CHẶN — sau A + B | Kỹ thuật | Dọn di sản khi nguồn sự thật mới đã chứng minh an toàn: container bot cũ, nhánh `/chatbot` cũ, đặc cách còn sót |

## 3. Luật cho phiên tiếp tục

- Mỗi phase làm trong cây + nhánh riêng, `claim` trước khi sửa, `handoff` khi xong — Delivery Controller mở PR, chạy cổng, gộp,
  deploy, hậu kiểm. PR đụng bảng `platform_*` / thu phí bị xếp CRITICAL ⇒ chủ shop tự gộp.
- Không bật `ai_sales` cho workspace nhà, không chuyển page nào, không bật trần cứng nào nếu chủ shop chưa nói.
- Nhánh `feat/saas-platform-restructure` của phiên thực hiện đã bị đẩy thêm commit tích hợp (c90097bb + merge) trước khi
  chuyển sang `integ/saas-platform` — phiên đó `git pull` hoặc bắt đầu cây mới từ `origin/main` trước khi làm tiếp.
