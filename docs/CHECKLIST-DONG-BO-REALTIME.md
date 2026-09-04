# Checklist đưa ERP vào vận hành & đồng bộ realtime

Làm theo thứ tự. Mỗi bước có cách kiểm tra để biết đã xong.

## 1. Chạy ERP lần đầu (máy cá nhân)

1. Tạo file `.env` từ `.env.example`, điền:
   - `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID=408063069`
   - `VIETTELPOST_API_KEY` (token bí mật tạo tại viettelpost.vn → Cấu hình tài khoản → Thêm mới token)
   - `AUTH_SECRET`, `CRON_SECRET`, `PANCAKE_WEBHOOK_SECRET`, `VIETTELPOST_WEBHOOK_SECRET`: chuỗi ngẫu nhiên (`openssl rand -hex 24`)
2. `npm install` → `npm run check:integrations`
   - Cả hai mục ✓ → sang bước 3.
   - Pancake ✗ HTTP 403: API key sai hoặc key không có quyền với shop 408063069 → tạo lại key trong Pancake (Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → API Key).
   - Viettel Post ✗ "không lấy được token": ERP đã thử lần lượt `loginVTP`, dùng thẳng token, rồi `Login/ownerconnect`. Tạo token mới trên viettelpost.vn, hoặc điền `VIETTELPOST_USERNAME` / `VIETTELPOST_PASSWORD` (tài khoản đối tác partner.viettelpost.vn).
3. `npm run dev` → http://localhost:3000 → đăng nhập `ADMIN_EMAIL` / `ADMIN_PASSWORD` → đổi mật khẩu.
4. **Kết nối dữ liệu** → *Đồng bộ toàn bộ Pancake (lịch sử)* → chọn số ngày (mặc định 365) → chạy. Sau đó *Trạng thái vận đơn Viettel Post* và *Nhập vận đơn từ Viettel Post* (30 ngày).
   - Kiểm tra: Tổng quan hiện đúng số đơn; Đơn hàng có mã vận đơn; Vận đơn có hành trình.

## 2. Đưa lên máy chủ có HTTPS (bắt buộc để realtime)

Pancake và Viettel Post chỉ gửi webhook tới địa chỉ **HTTPS công khai**. Localhost không nhận được.

- Dùng thật với `erp.vnxcommerce.com`: mua VPS Ubuntu, trỏ bản ghi A `erp` trên name.com về IP VPS, rồi chạy `sudo bash scripts/install-vps.sh` (chi tiết: `docs/TRIEN-KHAI-VPS.md`). Script tự cài Docker, tạo `.env`, bật HTTPS và in 2 URL webhook.
- Thử nhanh trên máy cá nhân: `cloudflared tunnel --url http://localhost:3000` → lấy `https://xxxx.trycloudflare.com` đặt vào `APP_URL`.

Kiểm tra: mở `https://erp.vnxcommerce.com/api/health` trả về `{"ok":true}`.

## 3. Bật webhook Pancake POS

1. Pancake POS → Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → tab **Webhook URL**.
2. Dán `https://<domain>/api/webhooks/pancake/<PANCAKE_WEBHOOK_SECRET>` (trang Kết nối dữ liệu có nút sao chép sẵn).
3. Tick **Đơn hàng**, **Khách hàng**, **Tồn kho** → Lưu.
4. Kiểm tra: sửa một đơn bất kỳ trên Pancake → trong 5 giây, Kết nối dữ liệu → *Webhook đã nhận* có dòng mới trạng thái PROCESSED và trang Đơn hàng tự làm mới.

## 4. Bật webhook Viettel Post (cần Viettel Post duyệt)

1. Đăng nhập https://partner.viettelpost.vn → Cấu hình tài khoản → **Thông tin nhận hành trình**.
2. API URL = `https://<domain>/api/webhooks/viettelpost`; Tham số bí mật = giá trị `VIETTELPOST_WEBHOOK_SECRET` trong `.env` → Cập nhật.
3. Liên hệ đội tích hợp Viettel Post để duyệt webhook: b2b@viettelpost.com.vn · 0862 235 888 (nói rõ tên đăng nhập đối tác và URL đã khai báo).
4. Trong lúc chờ duyệt, ERP vẫn cập nhật trạng thái mỗi 10 phút qua job `vtp-tracking` (scheduler). Có thể bấm *Cập nhật từ Viettel Post* trên từng vận đơn.
5. Kiểm tra sau khi duyệt: vận đơn → *Lịch sử đẩy webhook* có bản ghi; *Webhook đã nhận* có nguồn VIETTELPOST.

## 4b. Kết nối Facebook Ads (tự động lấy chi phí quảng cáo)

1. Vào https://business.facebook.com → Business Settings → Users → **System Users** → Add (loại Admin).
2. Chọn System User → **Assign Assets** → Ad Accounts → tick tất cả tài khoản quảng cáo của BM.
3. **Generate New Token** → chọn app (tạo app nếu chưa có) → quyền `ads_read`, `business_management` → thời hạn *Never expire* → copy token.
4. Thêm Secret `FACEBOOK_ACCESS_TOKEN` trên GitHub (Settings → Secrets → Actions) rồi chạy workflow *Deploy ERP to VPS*; hoặc thêm vào `.env` trên VPS và `docker compose -f docker-compose.prod.yml up -d`.
5. Kiểm tra: Kết nối dữ liệu → thẻ Facebook Ads → *Kiểm tra kết nối* → chạy job *Chi tiêu quảng cáo Facebook* (days=90 để kéo lịch sử). Đặt tên chiến dịch có mã hàng (VD “Q002 – Đầm …”) để ERP ghép vào báo cáo lợi nhuận theo mã.

## 5. Vận hành hằng ngày

- Scheduler tự chạy: đơn mới mỗi 3 phút, Viettel Post mỗi 10 phút, sản phẩm/tồn kho 30 phút, khách hàng & sổ kho 60 phút, đối chiếu lại 3 ngày gần nhất lúc 02:15.
- Nhập chi phí & quảng cáo để báo cáo lợi nhuận đúng.
- Khi Viettel Post chuyển tiền COD: Đối soát COD → chọn vận đơn trong bảng kê → *Đánh dấu đã về ngân hàng*.
- Sao lưu: `docker exec erp-db pg_dump -U erp erp > backup.sql` (hằng ngày).

## Những thứ ERP KHÔNG tự làm được (cần bạn cung cấp / quyết định)

| Cần gì | Vì sao |
|---|---|
| VPS (tên miền vnxcommerce.com đã có) | Webhook chỉ gửi tới HTTPS công khai; ERP cần một máy chủ chạy 24/7 |
| Viettel Post duyệt webhook | Chính sách của Viettel Post, không tự bật được |
| Tài khoản đối tác Viettel Post (username/password) | Chỉ khi token bí mật không đổi được token API |
| Giá vốn trên Pancake | Lợi nhuận tính từ giá nhập gần nhất của mẫu mã; chưa nhập giá vốn thì lợi nhuận = doanh thu |
| Chi phí vận hành, ngân sách quảng cáo | Không có API nào cung cấp; nhập tay trong Chi phí & quảng cáo |
