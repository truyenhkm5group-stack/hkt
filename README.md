# Shop Control ERP — Quản trị nội bộ shop thời trang online

Hệ thống ERP nội bộ đồng bộ **đơn hàng, khách hàng, sản phẩm, tồn kho, đổi/trả** từ **Pancake POS** và **trạng thái vận đơn, COD** từ **Viettel Post**, rồi gom về một chỗ để vận hành, đối soát tiền và tính lợi nhuận thực.

```
Pancake POS ──(API + webhook)──▶  ERP  ◀──(API + webhook)── Viettel Post
                                   │
   Tổng quan · Đơn hàng · Vận đơn · Đối soát COD · Sản phẩm & tồn kho · Nhật ký kho
   Khách hàng · Đổi/trả · Chi phí & quảng cáo · Báo cáo lợi nhuận · Kết nối dữ liệu · Người dùng · Nhật ký
```

## Tính năng chính

| Module | Nội dung |
|---|---|
| **Tổng quan** | KPI doanh thu/giao thành công/COD chờ về/lợi nhuận ước tính, biểu đồ theo ngày, luồng trạng thái đơn, kênh bán, vận đơn & COD, sản phẩm bán chạy, việc cần xử lý. Tự làm mới khi có webhook (realtime). |
| **Đơn hàng** | Toàn bộ đơn Pancake (mọi trạng thái, kể cả đã xoá) với sản phẩm, khách, ĐVVC, mã vận đơn, COD; lọc theo kỳ/trạng thái/kênh/ĐVVC/nhân viên; tìm theo mã đơn, SĐT, tên, mã vận đơn, SKU; chi tiết đơn với lịch sử trạng thái, hành trình vận đơn, lãi gộp từng đơn; xuất CSV. |
| **Vận đơn** | Vận đơn từ Pancake + Viettel Post (kể cả đơn tạo trực tiếp trên Viettel Post), hành trình đầy đủ (webhook/tra cứu), giao thất bại, hoàn, quá hạn; cập nhật từ Viettel Post theo lô hoặc từng đơn; lịch sử đẩy webhook & gửi lại. |
| **Đối soát COD** | Chưa thu → đã thu → ĐVVC đã đối soát → đã về ngân hàng → chênh lệch; tạo đợt nhận tiền, đánh dấu hàng loạt, xuất CSV. **Danh sách vận đơn Viettel Post** (Quản lý vận đơn → Xuất Excel → tải lên): cập nhật trạng thái thật từng vận đơn (Đã trả = COD đã về ngân hàng, Giao thành công, Chờ phát lại, Chuyển hoàn…) và cước; chỉ nâng trạng thái COD, không hạ. **Bảng kê Viettel Post**: dán bảng “Tiền hàng đã trả” (mã bảng kê · ngày đối soát · tiền COD · cước/dư nợ · tiền thu về) hoặc tải file chi tiết một bảng kê → ghép vận đơn, đánh dấu đã về ngân hàng, ghi cước thực tế; số thu về đi thẳng vào báo cáo Dòng tiền thực. |
| **Sản phẩm & tồn kho** | Mẫu mã (màu/size), giá bán, giá vốn, tồn khả dụng/thực tế **theo từng kho**, bán 30 ngày, giá trị tồn, sắp hết/hết hàng; chi tiết sản phẩm + nhật ký xuất nhập kho. |
| **Ghi nhận đơn theo fanpage & % LN theo mã** | Đơn, doanh thu, lợi nhuận của mỗi mã ghi nhận cho marketer theo **fanpage phát sinh đơn** (khai báo page → marketer ở Lương & hoa hồng; page chưa gán thì chia theo tỷ trọng QC, không QC thì về chủ mã). Mỗi mã khai chủ mã + X% (chủ mã hưởng từ đơn của mình, còn lại shop giữ) + Y% (người chạy cùng hưởng từ đơn mình tạo, 100 − Y về chủ mã); LN âm người tạo đơn chịu. Áp dụng cho LN1/LN2 và LN danh nghĩa theo marketer (bấm tên để xem chi tiết từng mã). |
| **Thao tác Viettel Post trên ERP** | Trang vận đơn có nút **Phát tiếp, Duyệt hoàn, Gửi lại, Duyệt đơn, Huỷ vận đơn** (API `order/UpdateOrder`) và **Sửa đơn VTP** (người nhận, SĐT, địa chỉ, tiền thu hộ, ghi chú — API `order/edit`), kèm ghi chú cho bưu cục; kết quả ghi vào hành trình vận đơn và nhật ký, tra lại trạng thái ngay sau đó. Quyền `shipments:manage`. Tài khoản Viettel Post cấu hình trong ERP phải là chủ vận đơn (cùng mã khách hàng với tài khoản Pancake dùng để tạo đơn). |
| **Đơn landing page** | Khách điền form → Google Sheet → ERP đọc CSV export mỗi 10 phút (job `landing-sheet`, sheet chia sẻ “Bất kỳ ai có liên kết – Người xem”): tự dò cột theo tiêu đề (ghi đè được), khoá theo dòng nên không nhập trùng; ghép mẫu mã Pancake theo mã hàng / tên / size / màu (chọn tay nếu chưa ghép); **cảnh báo trùng SĐT** (landing khác hoặc đơn Pancake trong N ngày) và **rủi ro hoàn** theo lịch sử khách (cùng quy tắc đơn rủi ro); nhân viên xác nhận / huỷ, bấm **Gửi POS** tạo đơn nháp (trạng thái Mới) trên Pancake kèm ghi chú rủi ro; ERP tự ghép đơn Pancake cùng SĐT để theo dõi chưa gửi → đang giao → giao thành công / hoàn / huỷ (kết quả ưu tiên Viettel Post). Quyền `landing:view / manage / config`. |
| **Phân quyền chi tiết** | 8 vai trò (thêm **Trưởng nhóm**) và ~40 quyền theo module: đơn hàng xem / xuất CSV; Cần xử lý xem / cấu hình; CSKH xem / xử lý / quy tắc & mẫu tin; Chăm sóc & bán chéo xem / gửi / kịch bản; kế hoạch SX xem / lập bảng; BCLN tách **theo đơn giao thành công / dòng tiền thực / danh nghĩa / tỷ lệ hoàn / sửa giả định**; Lương **xem của mình / xem toàn bộ / khai báo**; kết nối dữ liệu xem / cấu hình. Cấu hình cũ tự suy ra quyền mới. “Lương: xem của mình” chỉ hiện dòng của nhân sự khớp email đăng nhập (khai trong hồ sơ nhân sự) hoặc trùng tên. Trưởng nhóm mặc định xem lương cả nhóm và BCLN danh nghĩa, không xem dòng tiền thực. |
| **Kết quả đơn (ORDER_OUTCOME)** | Dùng chung cho mọi báo cáo, **ưu tiên trạng thái vận đơn Viettel Post** trước trạng thái Pancake: vận đơn hoàn → hoàn; vận đơn đã giao → giao thành công (trừ quy tắc phát hiện hoàn: COD thu < 50K); vận đơn đang đi → đang giao; chưa có trạng thái vận đơn mới xét theo Pancake. |
| **Lương & hoa hồng** | Cơ chế lương = lương cứng + % lợi nhuận tổng + % lợi nhuận cá nhân + % doanh thu cá nhân; mặc định tính trên **lợi nhuận dòng tiền thực** (tiền vào − tiền ra trong kỳ; LN cá nhân = LN danh nghĩa cá nhân × tỷ lệ dòng tiền/danh nghĩa), có thể chuyển sang cơ sở danh nghĩa; marketer nhận diện tự động theo tên chiến dịch / tài khoản QC. |
| **Cần xử lý & thông báo** | Quét mỗi 10 phút và ngay sau webhook: đơn chờ xử lý quá N giờ, vận đơn giao thất bại chờ phát lại, vận đơn treo không cập nhật N ngày, đang chuyển hoàn, case CSKH mới → chuông thông báo trên mọi trang, trang “Cần xử lý” lọc theo loại, gửi vào nhóm **Lark Suite** (Custom Bot webhook) và/hoặc Telegram; mỗi vấn đề báo một lần, tự đóng khi đã xử lý. |
| **Giao không thành · nhắn khách tự động** | Vận đơn Viettel Post giao thất bại trong 3 ngày gần nhất: đọc ghi chú bưu tá để phân loại lý do (hẹn phát lại kèm giờ hẹn, không liên lạc được, đi vắng, từ chối, sai địa chỉ, COD/kiểm hàng, shop lên sai địa chỉ) và soạn tin riêng theo lý do kèm tên & SĐT bưu tá. Đọc ngữ cảnh trước khi nhắn: đang chuyển hoàn, đã có đơn gửi lại, khách hoặc shop đã trao đổi trong chat → không nhắn. Mỗi lần thất bại chỉ nhắn một lần (khoá duy nhất giữ chỗ trước khi gửi). Mỗi vận đơn mở một case CSKH ghi rõ ✅ đã nhắn hoặc ⛔ chưa xử lý được (đơn từ landing page / sheet không có hội thoại) để gọi tay; case lên chuông và Lark. Mẫu tin chỉnh trong settings `cs.rules`. |
| **Xác nhận SĐT & xin số phụ** | Đơn đã xác nhận chưa gửi ĐVVC (3 ngày gần nhất) → bot nhắn khách qua Pancake xác nhận SĐT đúng chưa và xin số phụ khi: nhân viên gắn thẻ “SĐT mới” / “xác nhận SĐT” trên đơn Pancake; hoặc khách rủi ro (hoàn / cảnh báo cao theo ngưỡng Cảnh báo); hoặc (tuỳ chọn, mặc định tắt) SĐT chưa có đơn nào tại shop — tắt vì số GTC/hoàn Pancake hiển thị cạnh SĐT là lịch sử toàn hệ thống Pancake mà Open API không trả về. Đọc chat trước: shop đã hỏi → chờ khách; khách đã trả lời số / “đúng rồi” → đóng case; không đọc được chat → không nhắn. Đơn không có hội thoại → case ⛔ để gọi tay. Banner xanh trên chi tiết đơn nhắc kiểm tra màu SĐT trên Pancake; cấu hình `phoneVerifyAuto/phoneVerifyRisky/phoneVerifyNewPhone/phoneVerifyTags/phoneVerifyTemplate` trong `cs.rules`; job `phone-verify` (`--cancel=1` huỷ case cũ). |
| **Đơn rủi ro · xin cọc** | Mỗi đơn chưa gửi ĐVVC được chấm rủi ro theo số liệu khách trên Pancake (giao thành công / hoàn / bị chặn) và lịch sử vận đơn cùng SĐT trong ERP; khách hoàn ≥ 2 đơn và tỷ lệ hoàn ≥ 40% (chỉnh được) → thông báo + Lark cho CSKH xin cọc, banner đỏ trên chi tiết đơn, tự đóng khi đơn đã gửi hoặc huỷ. |
| **CSKH** | Case đổi size / đổi màu / sai địa chỉ / sai SĐT / trả hàng / khiếu nại / tư vấn size chưa đúng / chốt sai giá / khách giục giao hàng: tự phát hiện từ thẻ đơn, ghi chú đơn, phiếu đổi trả và **hội thoại chat Pancake** (Pages API với `PANCAKE_ACCESS_TOKEN`, 15 phút/lần, chỉ đọc tin khách gửi; từ khoá chỉnh được), hoặc nhập tay; trạng thái, người phụ trách, kết quả xử lý; mở nhanh đơn và hội thoại Pancake. |
| **Khách hàng** | Hồ sơ khách từ Pancake, số đơn/thành công/hoàn, lịch sử mua. |
| **Đổi / trả** | Phiếu đổi trả từ Pancake. |
| **Chi phí & quảng cáo** | Chi phí vận hành theo nhóm, chi tiêu quảng cáo theo nền tảng (ROAS, CPO). **Nhập sao kê MB Bank** (JSON/CSV xuất từ app “Quản lý giao dịch”): xem trước, tự đoán nhóm chi phí (nhãn sao kê → tên nhân sự → từ khoá → ≥ 5 triệu = nhập hàng), chỉ nhập chi phí vận hành (bỏ qua tiền vào, chuyển nội bộ, trả nợ gốc; quảng cáo đã lấy từ tài khoản QC và nhập hàng đã nằm trong giá vốn mặc định không nhập), chống trùng theo mã giao dịch; hoặc `npm run import:bank -- file.csv` / ops `import-bank-ledger`, `bank-ledger-prune`. |
| **Tỷ lệ hoàn theo mã hàng** | Tỷ lệ hoàn từng SKU theo quy tắc: vận đơn Viettel Post giao thành công nhưng COD thu < 50.000đ (khách không nhận, chỉ trả tiền ship / phí xem hàng; trừ đơn đã chuyển khoản trước) = đơn hoàn, áp dụng cho mọi báo cáo; bấm mã xem danh sách đơn; xuất CSV. |
| **Chăm sóc khách băn khoăn & bán chéo** | Lập danh sách mỗi sáng (08:30) và theo yêu cầu: (1) khách đã nhắn Pancake trong 2 ngày nhưng chưa có đơn → tin hỏi thăm băn khoăn; (2) khách nhận hàng thành công 3–14 ngày → tin cảm ơn kèm gợi ý mã phối cùng (bảng gợi ý theo mã đã mua hoặc top bán chạy khách chưa mua). Bán chéo gửi kèm ảnh/video sản phẩm gợi ý (ảnh Pancake hoặc URL cấu hình theo mã), ưu đãi khách cũ (mặc định 50K) và ưu đãi “giá siêu hời” (100K) cho mã hoàn cao & tồn nhiều (tự nhận diện theo tỷ lệ hoàn và số ngày tồn, hoặc chọn tay). Mẫu tin có biến `{ten} {san_pham} {goi_y} {giam} {shop} {uu_dai}`, xem trước, sửa từng tin, tích chọn gửi hàng loạt qua inbox Pancake (giới hạn tin/ngày, không nhắn lại cùng khách trong 14 ngày); khách không có hội thoại → xuất CSV nhắn Zalo/SMS. |
| **Kiểm tra nhất quán dữ liệu** | Job `data-check` (fix=1 để tự sửa): COD đã về mà vận đơn chưa giao, hoàn mà còn COD, giao xong thiếu ngày giao; báo cáo vận đơn treo lâu, đơn Pancake giao nhưng Viettel Post hoàn, giao xong quá 14 ngày chưa có bảng kê. Dữ liệu Viettel Post (webhook, danh sách vận đơn, bảng kê) luôn ưu tiên hơn bản sao trên Pancake. |
| **Hiệu quả quảng cáo theo Marketer & mã hàng** | Trong tab Chi phí & quảng cáo: bảng xếp hạng marketer và mã hàng theo chi QC, tin nhắn, đơn, CPO, doanh số, ROAS, lợi nhuận, tỷ lệ hoàn; đánh giá Tốt / Trung bình / Kém so với ROAS trung bình shop (cùng số liệu với Báo cáo lợi nhuận và Lương). |
| **Ngưỡng thanh toán tài khoản quảng cáo** | Đọc dư nợ, trạng thái, nguồn thanh toán của mọi tài khoản QC trong Business Manager (Marketing API, 30 phút/lần). Ngưỡng thanh toán nhập tay từ Trung tâm thanh toán Meta hoặc tự học từ lần thu tiền gần nhất. Cảnh báo vào nhóm Lark riêng (hoặc nhóm vận hành) khi dư nợ ≥ N% ngưỡng (mặc định 80%) hoặc tài khoản bị vô hiệu hoá / chưa thanh toán; bảng theo dõi trong tab Quảng cáo. |
| **Bảng chốt đặt hàng gửi xưởng** | Từ kế hoạch đặt hàng, tạo bảng chốt số lượng theo mã: ma trận màu × size (tiêu đề tô theo màu), số khởi tạo theo đề xuất ERP, sửa từng ô, ảnh mẫu theo màu, xưởng, ngày cần hàng, ghi chú; lưu mã PO, in / lưu PDF, sao chép văn bản gửi Zalo, trạng thái nháp → đã gửi xưởng → đã nhận hàng. |
| **Kế hoạch đặt hàng sản xuất** | Cảnh báo thiếu hàng (hết / hết trước khi sản xuất xong / sắp thiếu) và lượng đặt tối ưu từng mẫu mã = tốc độ bán ròng × (thời gian SX + số ngày đủ bán) + tồn an toàn − (tồn ERP − đơn đã chốt chưa gửi); giả định chỉnh được, thời gian SX riêng theo mã; đối chiếu tồn Pancake; xuất CSV; mẫu mã thiếu lên chuông & Lark. Lộ trình hoàn thiện: `docs/LO-TRINH-HOAN-THIEN.md`. |
| **Nhập hàng & kiểm kê** | Phiếu nhập hàng / điều chỉnh kiểm kê theo mẫu mã; tồn khả dụng ERP = Nhập − Giao thật − Đang giao (hoàn coi như về kho); giá nhập cập nhật giá vốn. |
| **Facebook Ads** | Tự kéo chi tiêu theo ngày × chiến dịch của mọi tài khoản quảng cáo trong Business Manager (token System User), ghép mã hàng theo tên chiến dịch. Bộ lọc kỳ / tài khoản QC / marketer / mã hàng áp dụng cho KPI, biểu đồ, bảng ghép chiến dịch và danh sách chi tiêu; tích chọn nhiều chiến dịch để gán mã hàng & marketer hàng loạt; thêm marketer ngay tại chỗ. |
| **Báo cáo lợi nhuận** | Giá vốn tính “sống” theo giá nhập trên phiếu nhập ERP gần nhất (→ giá vốn Pancake trên đơn → giá nhập mẫu mã) cho mọi báo cáo, tổng quan và chi tiết đơn. 3 tab: theo đơn giao thành công; dòng tiền thực (COD về ngân hàng, tiền nhập hàng, cước, QC, vận hành); danh nghĩa theo mã hàng (đơn lên × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − CPQC, bảng theo ngày từng mã, giả định chỉnh được; kèm LN ròng = trừ thêm vận hành đã nhập phân bổ theo doanh số, **đóng hàng/đơn gửi, nhân viên vận đơn = đơn × đơn giá + đơn giao thất bại cứu được GTC × thưởng, chi phí cố định/tháng (văn phòng, điện nước) quy đổi theo số ngày của kỳ**, dự phòng rủi ro tồn kho % hàng nhập, thuế % doanh thu, chi phí khác % QC; cước gửi tính cho mọi đơn gửi đi, đơn hoàn cộng thêm phí hoàn về — mặc định 17K gửi / 34K đơn hoàn, sửa ở “Giả định”). LN danh nghĩa theo marketer: đơn & doanh thu của mã chia theo tỷ trọng tiền QC, bấm tên để xổ chi tiết từng mã hàng có số liệu. Bảng kết quả kinh doanh (doanh thu giao thành công − giá vốn − phí ship − phí hoàn − phí sàn − quảng cáo − vận hành), so sánh kỳ trước, tiền thực về, theo kênh/nhân viên/sản phẩm/ngày, tỷ lệ hoàn huỷ, xuất CSV. |
| **Kết nối dữ liệu** | Trạng thái kết nối, kiểm tra API key, URL webhook + hướng dẫn cấu hình, chạy từng job đồng bộ, lịch sử đồng bộ, webhook đã nhận, lịch tự động. |
| **Người dùng & nhật ký** | Đăng nhập, vai trò (Quản trị / Quản lý / Kế toán / Kho / CSKH / Marketing / Chỉ xem) là mẫu quyền khởi điểm; ma trận quyền × vai trò chỉnh được; phân quyền riêng từng người theo 19 quyền chia theo module (xem/sửa); menu và trang gác theo quyền; nhật ký thao tác. |

Công nghệ: Next.js 15 · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Drizzle ORM · PostgreSQL 16 (hoặc PGlite nhúng để chạy thử không cần cài Postgres).

---

## 1. Chạy thử trên máy cá nhân

### Cách A — Docker Desktop (khuyên dùng, giống môi trường thật)

Yêu cầu: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
# file .env đã được điền sẵn API key Pancake / Viettel Post và các khoá bí mật ngẫu nhiên (xem mục 2)
docker compose up -d --build
```

Mở http://localhost:3000 — đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env` (mặc định `admin@shop.local` / `Admin@12345`, **đổi ngay sau khi đăng nhập** tại *Người dùng*).

Docker Compose chạy 3 dịch vụ: `db` (PostgreSQL), `app` (ERP, cổng 3000) và `scheduler` (đồng bộ tự động theo lịch). Dữ liệu nằm trong volume `erp_pgdata`.

### Cách B — Chỉ cần Node.js (không cần Docker/Postgres)

Yêu cầu: [Node.js 22+](https://nodejs.org).

```bash
# .env mặc định đã đặt DATABASE_URL="pglite://./data/pglite"
npm install
npm run dev              # http://localhost:3000 (bảng được tạo tự động lần đầu)
```

Chế độ PGlite lưu dữ liệu trong thư mục `data/pglite` và **chỉ cho phép một tiến trình mở cùng lúc**: muốn chạy lệnh `npm run sync` / `npm run seed:demo` thì dừng server (Ctrl+C) trước, hoặc dùng các nút trên giao diện. Khi dùng thật, hãy chuyển sang PostgreSQL (cách A).

### Xem thử với dữ liệu mẫu

```bash
npm run seed:demo        # ~1.100 đơn, 71 mẫu mã, vận đơn Viettel Post, chi phí, quảng cáo
npm run demo:clear       # xoá dữ liệu mẫu (giữ nguyên dữ liệu thật)
```

---

### Cách C — Triển khai thật lên VPS + tên miền (HTTPS tự động)

```bash
git clone <repo> erp && cd erp
sudo bash scripts/install-vps.sh     # cài Docker, tạo .env, chạy db + app + scheduler + Caddy (Let's Encrypt)
```

Chi tiết (trỏ DNS trên name.com, sao lưu, cập nhật): `docs/TRIEN-KHAI-VPS.md`.

---

## 2. Cấu hình `.env`

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | `postgresql://...` (Docker Compose tự đặt) hoặc `pglite://./data/pglite` |
| `AUTH_SECRET` | Chuỗi ngẫu nhiên ≥ 32 ký tự để ký phiên đăng nhập (`openssl rand -hex 32`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Tài khoản quản trị tạo lần đầu (khi chưa có người dùng nào) |
| `CRON_SECRET` | Khoá để scheduler/cron gọi API đồng bộ |
| `APP_URL` | Địa chỉ công khai của ERP (dùng để hiển thị URL webhook) |
| `PANCAKE_API_KEY`, `PANCAKE_SHOP_ID` | API key Pancake POS (*Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → API Key*) và ID shop (số trong URL `pos.pancake.vn/shop/<ID>/...`) |
| `PANCAKE_WEBHOOK_SECRET` | Chuỗi bí mật gắn vào URL webhook Pancake |
| `PANCAKE_BACKFILL_DAYS` | Số ngày lịch sử đơn cần kéo lần đầu (mặc định 365) |
| `VIETTELPOST_API_KEY` | Token bí mật tạo tại https://viettelpost.vn/cau-hinh-tai-khoan → *Thêm mới token* → *Sao chép token* (xác thực OTP). ERP đổi token này lấy token đối tác qua API `loginVTP` và tự làm mới khi hết hạn. |
| `VIETTELPOST_USERNAME`, `VIETTELPOST_PASSWORD` | Tài khoản đối tác Viettel Post (SĐT + mật khẩu đăng nhập partner.viettelpost.vn) để lấy token dài hạn 1 năm (`Login` → `ownerconnect`). Nên điền cả hai cách; ERP tự chọn cách nào hoạt động. |
| `VIETTELPOST_WEBHOOK_SECRET` | "Tham số bí mật" bạn khai báo trong phần webhook của Viettel Post |
| `LARK_BILLING_WEBHOOK_URL` | (tuỳ chọn) Webhook Lark nhóm nhận cảnh báo ngưỡng thanh toán QC; có thể đặt trong ERP → Cần xử lý → Cấu hình thay vì env |
| `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_BUSINESS_ID` | Token System User của Business Manager (quyền `ads_read`, `business_management`, không hết hạn) và ID BM chứa các tài khoản quảng cáo |
| `SYNC_*_EVERY_MINUTES` | Chu kỳ đồng bộ tự động của scheduler |

Kiểm tra API key trước khi đồng bộ:

```bash
npm run check:integrations
```

Lệnh này gọi thử Pancake (shop, đơn, sản phẩm, kho, khách) và Viettel Post (token, kho gửi, tra cứu một vận đơn, danh sách vận đơn) và in kết quả ✓/✗ kèm gợi ý sửa.

---

## 3. Đồng bộ dữ liệu lần đầu

Vào **Kết nối dữ liệu** → *Đồng bộ toàn bộ Pancake (lịch sử)* → chọn số ngày → chạy. Hoặc bằng dòng lệnh:

```bash
npm run sync -- pancake-all --backfill        # kho → sản phẩm → đơn (lịch sử) → khách → đổi trả → nhật ký kho
npm run sync -- vtp-tracking                  # tra cứu trạng thái các vận đơn Viettel Post chưa kết thúc
npm run sync -- vtp-import --days=30          # kéo cả vận đơn tạo trực tiếp trên Viettel Post
npm run sync                                  # liệt kê tất cả job
```

Đồng bộ lịch sử chia theo cửa sổ 7 ngày, có thể chạy lại để tiếp tục nếu bị ngắt. Pancake giới hạn ~10.000 dòng/truy vấn nên cửa sổ lớn được tự chia nhỏ. Mọi lần chạy đều ghi vào *Lịch sử đồng bộ*.

## 4. Đồng bộ tự động & realtime

Có **3 lớp** để dữ liệu luôn mới:

1. **Webhook (tức thì)** — Pancake gửi đơn/khách/sản phẩm/tồn kho, Viettel Post gửi hành trình vận đơn ngay khi có thay đổi. ERP trả lời 200 ngay và xử lý nền; giao diện đang mở tự làm mới (SSE).
2. **Scheduler (định kỳ)** — service `scheduler` gọi các job: đơn mới cập nhật mỗi 3 phút, trạng thái Viettel Post mỗi 10 phút, sản phẩm/tồn kho mỗi 30 phút, khách hàng & nhật ký kho mỗi 60 phút, đối chiếu lại 3 ngày gần nhất lúc 02:15 hằng ngày. Đây là lưới an toàn khi webhook bị lỡ.
3. **Thủ công** — nút *Đồng bộ ngay* trên các trang, *Tải lại từ Pancake* trên từng đơn, *Cập nhật từ Viettel Post* trên từng vận đơn.

### Để webhook hoạt động, ERP cần một địa chỉ HTTPS công khai

Pancake và Viettel Post phải gọi được vào ERP của bạn, nên `localhost` không nhận được webhook. Có 2 lựa chọn:

- **Chạy thử:** tạo tunnel tạm, ví dụ `cloudflared tunnel --url http://localhost:3000` (hoặc ngrok), lấy địa chỉ `https://xxxx.trycloudflare.com` đặt vào `APP_URL` và dùng làm URL webhook.
- **Dùng thật:** triển khai lên VPS có tên miền + HTTPS (xem `docs/TRIEN-KHAI-VPS.md`).

**Pancake POS:** *Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API → tab Webhook URL* → bật, dán `https://<domain>/api/webhooks/pancake/<PANCAKE_WEBHOOK_SECRET>`, tick *Đơn hàng*, *Khách hàng*, *Tồn kho* → Lưu. Pancake không ký chữ ký webhook nên bí mật nằm trong URL; ERP sau khi nhận webhook đơn sẽ tải lại đơn từ API để lấy dữ liệu chuẩn.

**Viettel Post:** đăng nhập https://partner.viettelpost.vn → *Cấu hình tài khoản → Thông tin nhận hành trình* → API URL = `https://<domain>/api/webhooks/viettelpost`, Tham số bí mật = `VIETTELPOST_WEBHOOK_SECRET` → Cập nhật. **Viettel Post cần duyệt webhook**: liên hệ đội tích hợp (b2b@viettelpost.com.vn · 0862 235 888) sau khi cấu hình. Trong lúc chờ duyệt, ERP vẫn cập nhật trạng thái qua job tra cứu định kỳ.

Trang **Kết nối dữ liệu** hiển thị sẵn cả hai URL, nút kiểm tra kết nối và danh sách webhook đã nhận để bạn xác nhận.

## 5. Vận hành hằng ngày

- **Cần xử lý** trên Tổng quan: đơn mới chờ xác nhận, vận đơn giao thất bại/đang hoàn, vận đơn quá 4 ngày chưa giao, COD chờ về tài khoản, mẫu mã sắp hết.
- **Đối soát COD:** khi Viettel Post chuyển tiền, vào *Đối soát COD* → chọn các vận đơn trong bảng kê → *Đánh dấu đã về ngân hàng* (tạo đợt nhận tiền có mã bảng kê, ngày nhận). Lệch tiền → đánh dấu *Có chênh lệch*.
- **Chi phí & quảng cáo:** nhập chi phí vận hành và chi tiêu quảng cáo mỗi ngày/tuần để báo cáo lợi nhuận đúng.
- **Báo cáo lợi nhuận:** chọn kỳ, so sánh kỳ trước, xuất CSV theo ngày.

Công thức lợi nhuận ròng = Doanh thu đơn giao thành công − Giá vốn (giá nhập gần nhất × số lượng) − Phí vận chuyển ĐVVC − Phí hoàn − Phí sàn − Chi phí quảng cáo − Chi phí vận hành.

## 6. Cấu trúc mã nguồn

```
app/(dashboard)/<module>/      # trang giao diện (Server Components) + bảng/columns (Client)
app/api/sync/[job]             # chạy job đồng bộ (scheduler / cron / nút bấm)
app/api/webhooks/pancake/...   # nhận webhook Pancake  (POST <secret>/<orders|customers|products|...>)
app/api/webhooks/viettelpost   # nhận webhook Viettel Post ({DATA, TOKEN})
app/api/events                 # SSE realtime cho giao diện
lib/integrations/pancake/      # client API, mapper (chuẩn hoá dữ liệu), sync (đồng bộ), webhook
lib/integrations/viettelpost/  # client API (token loginVTP/ownerconnect), sync (tra cứu, nhập, áp trạng thái)
lib/queries/, lib/actions/     # truy vấn báo cáo & server actions (có kiểm tra quyền + nhật ký)
db/schema.ts, drizzle/         # schema & migration
scripts/                       # scheduler.mjs, sync.ts, check-integrations.ts, seed-demo.ts
docs/                          # CONVENTIONS.md, TRIEN-KHAI-VPS.md, API-PANCAKE-VIETTELPOST.md
```

Checklist đưa vào vận hành và bật realtime: `docs/CHECKLIST-DONG-BO-REALTIME.md`.

Lệnh hữu ích: `npm run typecheck`, `npm run lint`, `npm test` (kiểm thử luồng đồng bộ với dữ liệu mẫu), `npm run db:migrate`, `npm run db:studio`.

## 7. Bảo mật & lưu ý

- Đổi mật khẩu quản trị mặc định, đặt `AUTH_SECRET`, `CRON_SECRET`, `PANCAKE_WEBHOOK_SECRET`, `VIETTELPOST_WEBHOOK_SECRET` bằng chuỗi ngẫu nhiên.
- API key chỉ nằm trong `.env` trên server, không lưu vào DB, giao diện chỉ hiện dạng che.
- ERP **chỉ đọc** từ Pancake và Viettel Post — không sửa đơn, không tạo vận đơn; Pancake vẫn là nơi lên đơn và đẩy đơn cho ĐVVC.
- Sao lưu định kỳ volume `erp_pgdata` (hoặc `pg_dump`).
- Token Viettel Post lấy từ token bí mật có thể có thời hạn ngắn; ERP tự đổi lại khi hết hạn. Nếu Viettel Post đổi cơ chế, điền thêm `VIETTELPOST_USERNAME/PASSWORD`.

## 8. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| "Pancake: HTTP 403" | Sai API key hoặc key không có quyền với shop. Tạo key mới trên Pancake, kiểm tra `PANCAKE_SHOP_ID`. `npm run check:integrations` |
| "ViettelPost: không lấy được token" | ERP thử lần lượt `loginVTP` → dùng thẳng token bí mật làm header `Token` → `Login/ownerconnect`. Token sai/hết hạn: tạo token mới tại viettelpost.vn/cau-hinh-tai-khoan; hoặc điền tài khoản đối tác. |
| Webhook không về | Chưa có HTTPS công khai / sai secret / Viettel Post chưa duyệt. Xem *Kết nối dữ liệu → Webhook đã nhận*. |
| Tồn kho lệch với Pancake | Chạy job *Sản phẩm & tồn kho*; webhook tồn kho chỉ cập nhật mẫu mã đã có trong ERP. |
| PGlite báo "đang được tiến trình khác sử dụng" | Dừng server trước khi chạy lệnh CLI, hoặc chuyển sang PostgreSQL. |
| Cổng 3000 bận | Đổi `ports` trong `docker-compose.yml` hoặc `PORT`. |
