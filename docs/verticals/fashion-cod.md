# Fashion COD — ERP gốc đóng gói cho shop thời trang online bán COD

Lộ trình chung: `docs/verticals/ROADMAP.md` (Phần A). Tài liệu này ghi từng bước đã làm và cách dùng.

## F1 — Pancake POS của tổ chức (kết nối `pancake-pos-org`)

Shop khách nối Pancake POS **của chính họ** (API key + mã shop) để đơn, khách, sản phẩm, tồn kho, đổi trả về ERP — bằng
**đúng bộ đồng bộ** tổ chức nhà dùng hằng ngày (`lib/integrations/pancake/sync.ts`), không phải một bản thứ hai.

### Cách bật (quản trị shop tự làm)

1. Hệ thống → Kết nối theo tổ chức → dòng «Pancake POS của tổ chức» (nhóm Nguồn đơn): nhập API key + mã shop → Lưu →
   Kiểm tra → Bật. Kiểm tra đòi mã shop nằm trong danh sách shop của khoá — khoá đúng mà sai shop thì không đạt.
2. Khung «Pancake POS của tổ chức — đồng bộ» (đầu trang): chép URL webhook, dán vào Pancake POS → Cấu hình → Webhook
   (chọn Đơn hàng, Khách hàng, Sản phẩm, Tồn kho).
3. Bấm «Đồng bộ ngay»: lần đầu kéo 30 ngày đơn cùng toàn bộ sản phẩm, khách, tồn. Bấm lại bất cứ lúc nào để bù.

### Hệ quả phải nói trước với shop

- **Pancake là NGUỒN đơn / khách / sản phẩm** (`orgHasSyncedSource` — cùng luật với tổ chức nhà): ERP thôi tạo đơn / khách /
  sản phẩm tay, **chatbot ERP thôi lên đơn**. Lý do: một lần mua không được có hai bản. Shop dùng chatbot ERP để chốt đơn
  thì CHƯA nên bật — bot tạo đơn nháp trên Pancake là bước sau.
- Luật kết quả đơn (`ORDER_OUTCOME`, ngưỡng hoàn 50K / 100K) áp như tổ chức nhà. Không có Viettel Post (F2) thì kết quả
  đơn chỉ đọc được từ dữ liệu Pancake đẩy về.

### An toàn

- Khoá mã hoá AES-256-GCM trong CSDL của tổ chức; màn hình chỉ hiện •••• + 4 ký tự cuối.
- Client dựng từ kết nối hỏi **chủ của khoá** trước mỗi request (`assertConnectionOwner`) — dùng nhầm ở tổ chức khác thì
  NÉM trước khi gửi. Địa chỉ API là hằng số (`PANCAKE_POS_API`); câu lỗi đã che khoá.
- Webhook phân giải tổ chức bằng token trong đường dẫn (`URL_SECRET`, HMAC riêng từng tổ chức); sai ⇒ 401, kết nối chưa bật ⇒
  409, không bao giờ rơi về tổ chức nhà.

### Chưa có (cần chủ nền tảng quyết)

- **Lịch đồng bộ định kỳ** cho tổ chức khách (nhà chạy 3 phút / lần). Hôm nay dựa vào webhook + nút «Đồng bộ ngay». Thêm
  lịch là đổi bộ lập lịch trên máy 2 nhân — quyết định hạ tầng (`docs/platform/scale-plan.md`).

### Tệp

`lib/constants/pancake-pos-org.ts` · `lib/integrations/pancake/org.ts` · `lib/integrations/pancake/client.ts`
(`fromOrgConnection`, `withPancakeClient`) · `app/api/webhooks/pancake-org/[token]/[[...event]]/route.ts` ·
`components/connectors/org-pos-panel.tsx` · `components/connectors/org-carrier-panel.tsx` · job `pancake-org` · `tests/pancake-pos-org.test.ts`.

## F2 — Viettel Post của tổ chức (webhook `viettelpost-org`)

Viettel Post không cấp API tra cứu cho shop (chủ shop chốt 24/09/2026) — nguồn tin là **webhook** và **tệp**.

- Hệ thống → Kết nối theo tổ chức → khung «Viettel Post của tổ chức»: chép URL webhook (mang token HMAC riêng của tổ chức),
  đưa vào cấu hình webhook trạng thái đơn trong tài khoản Viettel Post của shop (chưa thấy mục ⇒ gọi CSKH Viettel Post).
  Khung đếm gói tin đã nhận — gói đầu tiên về là bằng chứng đã nối.
- Tệp «Danh sách vận đơn» và bảng kê COD nhập ở /import-vtp (đã chạy theo tổ chức từ trước, quyền `cod:write`).
- Cần bật module Giao vận; chưa bật ⇒ webhook trả 409.
- Route theo tổ chức và route của nhà dùng CHUNG lõi `lib/integrations/viettelpost/webhook-core.ts`: chống trùng theo
  (vận đơn, trạng thái, mốc ĐVVC), mốc ĐVVC mới hơn thì thắng, gói lặp chỉ tăng lần gửi.
- Vận đơn khớp đơn theo mã đơn Pancake — nên F1 (Pancake POS của tổ chức) là điều kiện để kết quả đơn, COD, hoàn có số.

## F3 — Bỏ dấu vết của VNX ở tổ chức khách

- **Trợ lý AI** của shop khách tự giới thiệu bằng tên shop (`copilotSystemPrompt`); tổ chức nhà giữ nguyên lời nhắc để đệm
  prompt không bị làm rỗng.
- **Giả định lợi nhuận**: số mặc định trong mã (45% hoàn, ship 17.000 ₫, cố định 5 triệu…) là mục tiêu chủ shop VNX chốt cho
  VNX. Tổ chức khách chưa khai ⇒ tab Lợi nhuận danh nghĩa in cảnh báo «SỐ MẪU». Không đổi con số mặc định nào — đó là quyết
  định kinh doanh; shop khai số thật ở khung «Giả định» cuối tab.
- **Mẫu «Thời trang»** gợi ý kết nối theo tổ chức (Quảng cáo Meta, nhóm Lark) thay vì module connector của nhà; nguồn đơn /
  ĐVVC không nêu tên ở mẫu (mẫu không mang tên nhà cung cấp) — màn Kết nối liệt kê chúng (`lib/blueprints/integrations.ts` — một hàm tra cho cả bốn nơi đọc gợi ý).

## Kế tiếp

F2 Viettel Post của tổ chức → F3 bỏ mặc định VNX + mẫu «Fashion COD» → F4 quy kết quảng cáo + Pancake Pages → F5 cảnh báo /
SePay (xem ROADMAP).
