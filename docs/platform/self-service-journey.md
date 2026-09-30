# Hành trình tự phục vụ của khách (0180)

> Mục tiêu: một người dùng MỚI tự đi hết `Đăng ký → Tạo tổ chức → Mẫu «Thực phẩm đóng gói» → Module → Nhập sản phẩm →
> Chatbot AI → Báo nhóm → Xem trước → Tên miền con → Xuất bản → Mở ERP → Mời nhân viên` bằng giao diện — không SQL, không
> CLI, không sửa mã, không deploy riêng, không người vận hành sửa hộ. Mọi thứ ở đây CHUNG cho mọi tổ chức; không dòng nào
> nhắc tới một khách cụ thể.

## 1. Đăng ký (chế độ có kiểm soát)

Không đổi cơ chế: `/start` chạy khi chế độ hiệu lực = min(trần `PLATFORM_SIGNUP_MODE`, cài đặt `/platform`) là `invite` /
`open` (`launch-gates.md` B). Chế độ «Cần mã mời» ≙ `PUBLIC_SIGNUP_ENABLED=false, INVITE_SIGNUP_ENABLED=true`: người vận
hành bật ở `/platform` (không deploy) và phát mã; người cầm mã TỰ đăng ký tài khoản + tổ chức rồi được đăng nhập ngay.

## 2. Mẫu «Thực phẩm đóng gói» (`lib/blueprints/templates/food-commerce.ts`)

Loại hình mới `food` ở bước Loại hình của `/start` gợi ý mẫu này. Module: khách · sản phẩm · đơn · kho · giao vận · CSKH ·
AI bán hàng (+ lõi, việc). Field sản phẩm: `package_size`, `net_weight`, `selling_unit`, `food_category`,
`storage_instruction`, `usage_instruction`. Vai trò: Bán hàng · Kho · CSKH (Quản trị là vai trò hệ thống). Trang: «Tổng
quan bán hàng», «Báo cáo bán hàng» (Đơn / Sản phẩm / Kho / Khách / AI là trang lõi). Luật dựng sẵn ở NHÁP: đơn chốt ⇒
báo nhóm vận hành; đơn đã chốt bị huỷ ⇒ báo huỷ. GIỮ HÀNG không phải hành động của luật: đơn «Đã xác nhận» tự trừ vào cột
khả dụng của sổ kho (AGENTS.md 3.10), huỷ tự nhả. Mẫu KHÔNG mang sản phẩm, giá, khách hay bí mật nào; không có logic cân ký
lẻ / HSD / lô.

## 3. Sự kiện đơn → luật → gửi tin nhóm

- `lib/records/order-create.ts` phát `order.confirmed` · `order.updated` (chỉ khi đơn ĐÃ chốt đổi dòng hàng / người nhận /
  tiền thu / khách / trạng thái) · `order.cancelled` trong CÙNG giao dịch với lượt ghi; chỉ đơn `erp-` (không bao giờ đơn
  Pancake). Ngay sau lượt ghi, `runWorkflows()` chạy một lượt cho tổ chức hiện hành (cùng hàm của job và của nút trên
  trang) — luật báo nhóm chạy không đợi lịch; không đổi lịch scheduler.
- Đơn tay có «Người nhận / địa chỉ giao» riêng (trống = theo hồ sơ khách); sửa địa chỉ của đơn không sửa hồ sơ khách.
- Hành động luật mới `send_message` (ngoại lệ có chủ đích của tập đóng — `lib/workflow/types.ts`): gửi MỘT tin qua kết nối
  nhắn tin ĐANG BẬT của chính tổ chức. `MessagingProvider` (`lib/messaging/providers.ts`) có bốn bản: Lark webhook, Telegram
  bot, **Zalo bot** (`zalo-bot`, bot.zaloplatforms.com — tin dài hơn 2000 ký tự tách theo dòng), **hộp thử**
  (`sandbox-messaging` — không gọi mạng, không bí mật, trạng thái «CHẾ ĐỘ THỬ»).
- Zalo / Telegram: nút «Tìm chat» ở `/settings/connections` đọc `getUpdates` bằng token đã lưu (chỉ đọc, có nhật ký) —
  nhắn cho bot hoặc @nhắc bot trong nhóm, bấm «Tìm chat», chọn «Dùng», Lưu, Kiểm tra, Bật. Zalo không hiện mã chat cho
  người dùng nên đây là đường duy nhất lấy mã. Nhóm chat của Zalo Bot đang ở giai đoạn thử nghiệm của Zalo.
- Lỗi mạng khi gọi dịch vụ ngoài in NGUYÊN NHÂN (không phân giải tên miền · bị ngắt khi mở · hết thời gian chờ · chứng chỉ)
  thay cho «fetch failed» (`lib/connectors/net-error.ts`). Đo 30/09/2026: máy chủ production KHÔNG mở được kết nối tới
  api.telegram.org (Anthropic, Lark, Zalo thì được) — Telegram ở production cần một đường ra mạng khác.
- Sổ `messaging_deliveries`: dòng chèn TRƯỚC khi gọi nhà cung cấp, `dedupe_key` UNIQUE (`workflow:<lượt>:<vị trí>`) ⇒ chạy
  lại / bấm lại không gửi tin thứ hai; dòng `PENDING` bỏ dở ⇒ `UNKNOWN`, không tự gửi lại.
- `/settings/notifications` («Automation preset: When Order Confirmed → Send Order to Operations Group»): chọn kênh, nơi
  nhận, mẫu tin cho ba sự kiện, «Gửi thử». Lưu = `saveRule` → `ACTIVE` → `LIVE` trên ba luật khoá cố định
  (`bao_nhom_don_*`, trùng khoá luật của mẫu ⇒ nâng luật của mẫu, không đẻ luật thứ hai).

## 4. Chatbot bán hàng theo tổ chức (`lib/sales-chatbot/*`, module `ai_sales`)

- `/ai/sales-chatbot`: khoá AI BYOK của chính tổ chức (`anthropic-byok` / `openai-byok`), model, giọng, lời chào, giờ làm
  việc, chuyển nhân viên, chính sách chốt (luôn đọc lại tóm tắt và chờ khách đồng ý), phí ship cố định (trống ⇒ «nhân viên
  báo sau», không bịa số), công cụ được dùng, field sản phẩm bot được đọc.
- Mười công cụ: `search_products` · `get_product` · `get_current_price` · `check_inventory` · `calculate_cart` ·
  `create_customer` · `create_draft_order` · `update_draft_order` · `confirm_order` · `handoff_to_human`. Giá / tồn luôn đọc
  từ ERP lúc gọi (lời nhắc KHÔNG có giá); đơn giá của đơn do ERP điền; tồn chưa có phiếu nhập ⇒ «chưa biết», không 0.
- `confirm_order` chỉ chạy khi `customer_confirmation` là nguyên văn một đoạn trong câu CUỐI của khách, giá không đổi kể từ
  lúc tóm tắt, không dòng nào vượt tồn khả dụng đã biết. Chốt ⇒ `order.confirmed` ⇒ luật báo nhóm.
- **Khung thử** (kênh `TEST`, trong ERP): đọc thật, GHI MÔ PHỎNG — không khách / đơn / tin nhóm thật.
- **Trang chat công khai** `https://<slug>.<miền gốc>/chat` (kênh `WEB`): chỉ tổ chức ĐÃ XUẤT BẢN có bot đang bật; tổ chức
  lấy từ host, mọi truy vấn trong `withOrganization` tường minh (không bao giờ rơi về nhà); hội thoại khoá theo cookie
  khách truy cập (băm); trần 20 tin / 10 phút / khách, 500 lượt / ngày / tổ chức.
- Mỗi lượt khách một dòng `platform_ai_usage` (feature `sales_chatbot`, nguồn `BYOK`). Trần LƯỢT/ngày của gói chỉ đếm AI
  Builder + Copilot; trần TIỀN USD tháng đếm mọi tính năng.
- Đơn / khách do bot ghi mang tác nhân `AGENT` (luật 36): `raw.createdBy = null`, `raw.agent = "Chatbot bán hàng"`.

## 5. Xem trước · tên miền con · xuất bản (`lib/platform/publish.ts`, `/setup`)

- Tổ chức tạo qua `/start` là **BẢN NHÁP** (`publish_state = DRAFT`, thanh vàng ở đầu mọi trang). ERP đang dùng chính là bản
  xem trước; `/setup` in thêm menu / module / trang / form / thương hiệu sẽ hiện ra.
- Tên miền con: chữ thường không dấu, số, gạch; 2–31 ký tự; không dành riêng; không trùng (UNIQUE ở CSDL). Đổi được tới lúc
  xuất bản, khoá sau đó.
- Xuất bản: kiểm lại (module đủ phụ thuộc · cấu hình dữ liệu hợp lệ · luật đang bật còn tham chiếu · còn quản trị · tên
  miền) → `PUBLISHED` + mốc + người → xoá đệm → nhật ký nền tảng `ORG_PUBLISH`. Không git, không build, không deploy.
- «MỞ ERP CỦA TÔI» mở `https://<slug>.<miền gốc>/login`. Trên tên miền con: đăng nhập gắn cứng tổ chức (không ô mã tổ
  chức, không chữ VNX), phiên của tổ chức khác bị từ chối (`HOST_MISMATCH`), tên miền con chưa xuất bản / không tồn tại ⇒
  «Không có ERP ở địa chỉ này». Liên kết trong tin nhóm và liên kết mời đi theo tên miền con.

### Hạ tầng MỘT LẦN cho cả nền tảng (không phải việc của từng khách)

1. DNS: bản ghi `*.<ERP_DOMAIN>` (A) trỏ về IP máy chủ.
2. GitHub Variable `PLATFORM_BASE_DOMAIN` = `<ERP_DOMAIN>` → deploy (workflow → `install-vps.sh` ghi `.env`).
3. `deploy/Caddyfile` đã có khối `*.{$ERP_DOMAIN}` với on-demand TLS; Caddy chỉ xin chứng chỉ khi
   `/api/platform/domain-allowed?domain=<host>` trả 200 (chỉ tổ chức đã xuất bản).
Thiếu 1–2 thì tổ chức vẫn xuất bản được, ERP mở bằng `APP_URL` + ô «Mã tổ chức».

## 6. Mời người dùng (`lib/users/invites.ts`)

`/settings/users` → «Mời người dùng»: email + vai trò hệ thống hoặc vai trò tuỳ chỉnh đang bật → MỘT liên kết
`/join/<mã tổ chức>/<mã>` (hạn 7 ngày, dùng một lần, CSDL chỉ giữ băm). Người được mời tự đặt tên + mật khẩu, được tạo tài
khoản qua ĐÚNG đường ghi người dùng, đăng nhập bằng `verifyLogin`. Lời mời chưa dùng tính vào ghế của gói.

## 7. Nhập sản phẩm (`/products/import`)

CSV / XLSX → xem trước → ghép cột (tự đoán) → kiểm (chạy thử, không ghi) → nhập. Mỗi sản phẩm qua `createProductCore`; SKU
thiếu thì tự sinh; cột khớp field tuỳ biến của sản phẩm (quy cách, đơn vị…) ghi vào field đó; tồn đầu ⇒ MỘT phiếu NHẬP
HÀNG. Nhập lại cùng tệp ⇒ «đã có», không bản thứ hai.

## 8. Chấp nhận: E2E trình duyệt bằng tài khoản MỚI (29/09/2026, máy chạy thử)

CSDL trắng (chỉ seed tổ chức nhà + dữ liệu mẫu VNX), `next start` bản build production, `PLATFORM_BASE_DOMAIN=localhost:3471`,
mỗi bước một ngữ cảnh trình duyệt sạch, chỉ bấm giao diện — 0 SQL, 0 script ghi CSDL, 0 sửa mã, 0 deploy riêng.
Người vận hành chỉ bật «Cần mã mời» và phát MỘT mã trên `/platform`. Tổ chức sinh ra: `hslc-w4cuc`.

| Bước | Kết quả đo |
|---|---|
| Đăng ký + tạo tổ chức | mã mời → `/start` → loại hình «Thực phẩm đóng gói» → mẫu `food-commerce` → xem trước → tạo; thanh BẢN NHÁP, không chữ VNX |
| Nhập sản phẩm | CSV 6 dòng HSLC: tự ghép 5 cột (tên · quy cách · giá · đơn vị · tồn đầu) → 6 đã tạo · 0 lỗi · SKU tự sinh · 1 phiếu nhập 50/mã |
| Chatbot (khung THỬ, model Anthropic thật) | «Chả mực bao nhiêu?» → 400.000 ₫; 2 × 400.000 + 1 × 350.000 = 1.150.000 ₫, ship 30.000, COD 1.180.000; hỏi tên / SĐT / địa chỉ / ghi chú; đọc lại đơn; chốt ⇒ «Đơn đã chốt (thử)» |
| Nhóm thông báo | Hộp thử = `TEST_MODE`, gửi thử được; bật sẵn 3 luật đơn chốt / sửa / huỷ ⇒ «CHẠY THẬT» |
| Tên miền con + xuất bản | tên dành riêng bị chặn; `hslc-w4cuc` dùng được; 8/8 mục kiểm trước đạt; XUẤT BẢN; «MỞ ERP CỦA TÔI» ⇒ `http://hslc-w4cuc.localhost:3471/login` (không ô mã tổ chức) |
| Khách chat trang `/chat` công khai | đơn thật `#CC8FDBA9` CONFIRMED, «bởi Chatbot bán hàng»; tin nhóm có số đơn · khách · SĐT · địa chỉ · từng dòng · ship · COD · liên kết ERP |
| Sửa / tồn / huỷ | sửa SL ⇒ tin CẬP NHẬT (COD 1.580.000); tồn Chả mực 50 · giữ 3 · khả dụng 47; huỷ ⇒ tin HUỶ kèm lý do |
| Mời nhân viên kho | liên kết `/join/…` trên tên miền con → tự đặt mật khẩu → vào được `/inventory` `/orders` `/products`; `/settings/users` `/ai/sales-chatbot` bị chặn |
| Xuyên tổ chức | tài khoản HSLC ở miền chính · tài khoản nhà ở tên miền HSLC: không vào được; phiên HSLC mở đơn VNX và ngược lại: không thấy; tên miền con lạ và `/chat` ở miền chính: «Không tìm thấy ERP» |

### Production (30/09/2026)

Chạy lại đủ 12 bước trên `https://erp.vnxcommerce.com` (commit `c9696b97`) bằng mã mời người vận hành phát, trình duyệt /
email / tài khoản / tổ chức mới: tổ chức `hslc-vgcnj` → `https://hslc-vgcnj.erp.vnxcommerce.com` (chứng chỉ cấp ngay lần
mở đầu). 12/12 ĐẠT, cùng số liệu như bảng trên (đơn thật `#E895B553`). Tên miền con CHƯA xuất bản ⇒ Caddy không cấp chứng
chỉ ⇒ trình duyệt báo lỗi TLS — đúng thiết kế. UAT và go-live: `hslc-uat.md`.

