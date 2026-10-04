# Lộ trình sản phẩm theo ngành (chủ shop chốt hướng 04/10/2026)

Hai việc song song:

1. **Đóng gói ERP gốc thành sản phẩm «Fashion COD»** — ERP cho shop thời trang online bán COD (giao trước, khách trả
   tiền khi nhận). Đây là thứ VNX đã chạy thật hằng ngày; việc còn lại là cho shop KHÁC cắm được dữ liệu của chính họ.
2. **Mỗi ngành khác một bộ module riêng**, dựng từ nỗi đau thật của ngành, trên lõi chung (khách, sản phẩm, đơn, kho, công
   việc, AI, luật tự động, phân quyền, thu phí thuê bao).

Tài liệu này là lộ trình, không phải đặc tả. Mỗi hạng mục khi bắt đầu có tài liệu riêng ở `docs/verticals/` hoặc
`docs/platform/`.

---

## Phần A — Fashion COD: đóng gói ERP gốc

### Đã có (chạy thật ở tổ chức nhà)

Kết quả đơn theo chứng từ ĐVVC (`ORDER_OUTCOME`, luật hoàn 50K/100K), đối soát COD theo bảng kê, tỷ lệ hoàn theo mã /
marketer, sổ kho theo size / màu, chăm sóc đơn giao thất bại, quảng cáo theo tiền thật, lương marketer theo đơn thành
công, sản xuất đặt xưởng, cảnh báo, buồng lái chủ shop.

### Vì sao shop khác chưa dùng được (đo trên main 04/10/2026)

Nền tảng đa tổ chức đã có (CSDL riêng, kết nối mã hoá theo tổ chức, webhook mang mã tổ chức trong URL, lịch chạy theo tổ
chức). Nhưng **bốn đường dữ liệu nuôi mọi màn hình COD chỉ chạy cho tổ chức nhà**:

| # | Chặn | Hệ quả với shop mới | Cỡ | Dùng lại |
|---|---|---|---|---|
| 1 | **Pancake POS theo tổ chức** (đơn, sản phẩm, khách, tồn) — `pancake-pos` là `HOME_ONLY` | Mọi đơn phải gõ tay | L | Ô `perOrganizationClients` của `lib/integrations/pancake/client.ts`; mẫu `meta-ads-org` (kết nối PER_ORG + `fromOrgConnection`); webhook mã tổ chức trong URL (`resolveUrlSecretOrganization`) |
| 2 | **Viettel Post theo tổ chức** (webhook, tra cứu, bảng kê COD) | Vận đơn, COD, hoàn hàng, chăm sóc đơn, sổ kho trống | L | Toàn bộ bộ dịch / đồng bộ VTP giữ nguyên; chỉ thêm khoá tổ chức vào URL webhook + token theo tổ chức |
| 3 | **Lịch chạy cho job kết nối** (Pancake 3 phút, VTP 10 phút, cảnh báo) | Không có dữ liệu mới nếu không ai bấm | M + hạ tầng | Hàng đợi `scheduler-fanout.mjs`; ưu tiên WEBHOOK (đẩy) thay vì hỏi định kỳ để không đè máy 2 nhân |
| 4 | **Quy kết đơn → quảng cáo / marketer** (ad index, fanpage attribution) | ROAS theo mã / marketer «Chưa gán» | M | Client `meta-ads-org`; token page của kết nối `pancake-fanpage` |
| 5 | **Pancake Pages theo tổ chức** (ca CSKH tự động, bot giao thất bại, gửi tin hàng loạt) | CSKH chỉ ca gõ tay | M | Token page + `reply_inbox` của `lib/sales-chatbot/fanpage.ts` |
| 6 | **Cảnh báo / bản tin / lương tự động qua kênh của shop** | Không ai được báo | S–M | `lib/messaging/providers.ts` (Lark / Telegram / Zalo theo tổ chức đã có) |
| 7 | **Bỏ mặc định VNX** (45% hoàn, 17K ship, tên «Hải An Fashion», lời nhắc AI, BM id, quy ước mã SP) | Lợi nhuận sai, tin gửi sai tên shop | S | Khoá `settings` sẵn có |
| 8 | **SePay theo tổ chức + một mẫu «Fashion COD» thống nhất** | Thu tiền chuyển khoản phải nhập sổ tay | S–M | `bank-statement-file` đã PER_ORG; gộp mẫu `fashion-commerce` với `ORG_TEMPLATES` |

### Thứ tự làm

- **F1 — Pancake POS theo tổ chức** qua webhook + nút «Đồng bộ ngay» + đồng bộ đối chiếu mỗi đêm (không hỏi 3 phút / tổ
  chức). Kết nối PER_ORG, khoá API của chính shop. Shop có Pancake ⇒ đơn ĐỒNG BỘ, tắt tạo đơn tay (công tắc
  `SYNCED_SOURCE_MODULE` sẵn có).
- **F2 — Viettel Post theo tổ chức**: URL webhook riêng mỗi tổ chức, token VTP của shop, nhập bảng kê COD / Danh sách vận
  đơn theo tổ chức. Từ đây `ORDER_OUTCOME`, COD, hoàn, chăm sóc đơn có số.
- **F3 — Bỏ mặc định VNX + mẫu «Fashion COD»** + màn khai ngưỡng COD lúc mở tài khoản.
- **F4 — Quy kết quảng cáo + Pancake Pages theo tổ chức.**
- **F5 — Cảnh báo / bản tin / SePay theo tổ chức.**
- **Hạ tầng (CHỦ SHOP QUYẾT):** lịch chạy song song có trần cho job kết nối của khách thuê; tách máy CSDL khi vượt ~10 shop
  COD đồng bộ (docs/platform/scale-plan.md).

Luật nghiệp vụ (`ORDER_OUTCOME`, `RETURN_RULE`) GIỮ NGUYÊN và dùng chung — đúng cho shop thời trang COD nói chung, và
contract test khoá chúng. Ngưỡng riêng từng shop chỉ khi chủ nền tảng quyết đưa nó thành cài đặt theo tổ chức.

---

## Phần B — Ngành khác: nỗi đau → module riêng

Nỗi đau dưới đây là GIẢ THUYẾT từ cách ngành vận hành, cần một khách thử xác nhận trước khi dựng sâu. Cột «Đã có» là
phần lõi dùng lại ngay; cột «Module riêng» là thứ làm nên lý do khách trả tiền.

| Ngành | Nỗi đau chính | Đã có | Module riêng cần dựng | Cỡ |
|---|---|---|---|---|
| **Thực phẩm / hải sản (HSLC)** | Hàng có HẠN DÙNG, hao hụt hàng tươi; bán theo cân (cân lại khi đóng); khách sỉ nợ | Mẫu thực phẩm + hải sản, bảng giá sỉ, công nợ, nhắc mua lại, chatbot | **Lô & hạn dùng (xuất trước hết hạn trước), cảnh báo cận date**; **bán theo cân** (số lượng thập phân + cân lại) | M + M |
| **Gia dụng online** | Hàng cồng kềnh dễ vỡ khi giao; BẢO HÀNH theo serial, đổi trả lỗi kỹ thuật; combo + phụ kiện | Toàn bộ chuỗi COD của Fashion (sau F1–F2) | **Bảo hành & đổi trả theo serial**: phiếu bảo hành, tra theo SĐT / serial, ca lỗi → đổi / sửa / trả nhà cung cấp | M |
| **Spa / làm đẹp** | Khách không tới; liệu trình; hoa hồng kỹ thuật viên; vật tư tiêu hao theo dịch vụ | Lịch hẹn, liệu trình, chatbot đặt lịch, nhắc lịch | **Hoa hồng kỹ thuật viên theo buổi** (luật 16) + **định mức vật tư theo dịch vụ** + nhắc tự động (cần duyệt lịch chạy + Zalo OA) | M |
| **Nhà hàng / quán ăn** | Gọi món chậm, sai món giữa phục vụ và bếp; thất thoát nguyên liệu; đặt bàn | Mẫu nhà hàng, đặt bàn qua chat | **POS theo bàn + màn hình bếp + định lượng nguyên liệu** | L — cần quán thử |
| **Dịch vụ tại nhà** (sửa chữa, vệ sinh, lắp đặt) | Điều thợ ngoài hiện trường; báo giá → làm → nghiệm thu → thu tiền theo đợt; bảo hành dịch vụ | Mẫu dịch vụ (hợp đồng, dự án), công việc, lịch hẹn | **Phiếu công việc hiện trường**: báo giá, giao thợ, ảnh trước / sau, khách ký nghiệm thu, thu theo đợt | M |
| **Bất động sản** (sàn / môi giới) | Giỏ hàng căn bị nhiều sale giữ chồng; lead rơi; lịch dẫn khách; cọc; hoa hồng chia nhiều tầng | Khách hàng, công việc, lịch hẹn, phân quyền theo phạm vi | **Giỏ hàng & giữ chỗ căn** (khoá có hạn, không giữ trùng) + **phễu lead** + **cọc & hoa hồng nhiều tầng** | L |
| **Airbnb / homestay** | Trùng phòng giữa Airbnb / Booking / khách lẻ; dọn phòng giữa hai lượt; doanh thu–chi phí theo căn, chia chủ nhà | Lõi khách, công việc, thu phí | **Lịch phòng đa kênh qua iCal** (Airbnb / Booking xuất iCal công khai — không cần API đối tác) + **việc dọn phòng tự sinh** + **báo cáo chủ nhà theo căn** | L |

### Thứ tự đề xuất sau Fashion COD

1. **Gia dụng** — dùng lại gần trọn chuỗi COD; chỉ thêm bảo hành theo serial. **ĐÃ CÓ** (#519, module `warranty`, mẫu
   `household` — `docs/verticals/household.md`).
2. **Airbnb / homestay** — nỗi đau rõ (trùng phòng = mất tiền ngay), iCal không cần đối tác, cạnh tranh ít ở thị trường
   Việt. **ĐÃ CÓ bản đầu** (module `stays`, mẫu `homestay` — `docs/verticals/homestay.md`): nhập lịch kênh bằng tệp, ERP phát
   lịch cho kênh tự tải; tự tải lịch kênh định kỳ chờ chủ shop duyệt (gọi ra ngoài + lịch chạy).
3. **Thực phẩm: lô & hạn dùng** — đã có khách thử HSLC. **ĐÃ CÓ bản đầu** (module `lots`, 0199, mẫu thực phẩm / hải sản
   1.1.0 — `docs/verticals/food-lots.md`): lô gắn lên phiếu nhập, «còn» là ước tính, không đổi sổ kho.
4. **Dịch vụ tại nhà**, rồi **Bất động sản**.
5. **Spa / nhà hàng** — đào sâu khi có khách thử thật.

Mỗi ngành mới: một mẫu (`lib/blueprints/templates/*`) + module riêng (bật / tắt theo tổ chức như mọi module) + tài liệu
`docs/verticals/<ngành>.md` + loại hình ở `/start` + bài kiểm. Không ngành nào được sửa luật chung của ngành khác.
