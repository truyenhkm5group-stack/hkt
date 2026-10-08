# TUÂN THỦ PHÁP LUẬT VIỆT NAM — CHỐT ĐƠN TỰ ĐỘNG (VNXcommerce)

> **Phase 1 — NGHIÊN CỨU · KIỂM KÊ · PHÂN TÍCH KHOẢNG TRỐNG.** Soạn 08/10/2026 trên `origin/main` `fd89b295`.
> Tài liệu này KHÔNG phải ý kiến pháp lý và KHÔNG tuyên bố «đã tuân thủ». Nó trả lời ba câu: luật nào chạm tới sản
> phẩm, sản phẩm hôm nay làm được gì, và ai phải làm gì tiếp (kỹ thuật · tài liệu · chủ sở hữu · luật sư · cơ quan nhà
> nước · kế toán). Mọi dòng mang nhãn **LEGAL COUNSEL REQUIRED** là kết luận pháp lý chưa có — không được coi là đã có.
>
> Đọc kèm: `DATA_PROCESSING_REGISTER.md` (sổ xử lý dữ liệu) · `DATA_FLOW_MAP.md` (luồng dữ liệu) ·
> `SUBPROCESSOR_REGISTER.md` (bên xử lý phụ) · `LEGAL_LAUNCH_GATE.md` (cổng ra mắt) ·
> `TECH_HANDOFF_LEGAL.md` (bàn giao cho Tech Lead). Văn bản khách hàng đã công bố: `privacy-policy.md`,
> `terms-of-service.md`, `README.md` cùng thư mục.

## 0. Bảy loại việc — KHÔNG gộp

| Mã | Loại | Nghĩa | Ai đóng |
|---|---|---|---|
| A | TECHNICAL COMPLIANCE | Mã nguồn làm đúng điều luật đòi (và có bài kiểm) | Tech Lead |
| B | DOCUMENTATION | Văn bản nội bộ / công khai đã viết, có phiên bản | Kỹ thuật + chủ sở hữu |
| C | CORPORATE / LEGAL FILING | Hồ sơ doanh nghiệp, bổ nhiệm, hợp đồng đã ký | Chủ sở hữu |
| D | GOVERNMENT APPROVAL / CERTIFICATE | Cơ quan nhà nước đã cấp / tiếp nhận | Cơ quan + chủ sở hữu |
| E | ACCOUNTING / TAX | Kế toán, hoá đơn, thuế đã khai | Kế toán / tư vấn thuế |
| F | OWNER DECISION | Quyết định kinh doanh chủ sở hữu phải ra | Chủ sở hữu |
| G | EXTERNAL LEGAL COUNSEL CONFIRMATION | Luật sư ngoài xác nhận bằng văn bản | Luật sư |

Một mục chỉ được ghi **COMPLIANT** khi đủ mọi loại mà nó cần. Mã xanh không chứng minh loại D hay G.

## 1. Tóm tắt điều hành

**LEGAL READINESS: ~21 % (LEGAL-P0) — KHÔNG THỂ «COMMERCIAL READY».** Cách chấm ở `LEGAL_LAUNCH_GATE.md` §1.

Ba điều quyết định toàn bộ lộ trình, cả ba đều chưa có câu trả lời pháp lý:

1. **Chốt Đơn Tự Động có phải «kinh doanh dịch vụ xử lý dữ liệu cá nhân» (NĐ 356 Điều 21–25) không?** Sản phẩm thu
   tiền để nhận hội thoại Messenger của khách hàng cuối, trích SĐT / địa chỉ, phân tích bằng AI và tự tạo đơn — khớp
   mô tả «cung cấp hệ thống tự động» và «xử lý bằng AI» trong Điều 21. Nếu CÓ: phải có **Giấy chứng nhận đủ điều kiện
   do Bộ Công an cấp** (Điều 22–25) TRƯỚC khi cung cấp dịch vụ, và VNXcommerce **mất** quyền hoãn 5 năm dành cho doanh
   nghiệp nhỏ / khởi nghiệp (DPIA + bộ phận bảo vệ DLCN phải có ngay). Đây là giấy phép bắt buộc để cung cấp dịch vụ
   hợp pháp ⇒ theo luật của chính brief này, **chưa giải quyết thì không được đánh dấu READY FOR PAYING CUSTOMER**.
   → **LEGAL COUNSEL REQUIRED (G) + OWNER DECISION (F)**.
2. **Bot đang được thiết kế để KHÔNG cho khách biết mình là AI.** Lời nhắc hệ thống mở đầu «Bạn là «botName»,
   **nhân viên bán hàng** qua chat của shop» (`lib/sales-chatbot/engine.ts:156`; tên mặc định «Trợ lý bán hàng»,
   `config.ts:208`); `followup.ts:58` ghi «không nhắc rằng mình là AI hay tin tự động»; trang chat web chỉ ghi «Chat
   với {botName}» (`app/chat/page.tsx:29`); quyết định chủ shop HSLC 05/10/2026 bỏ mọi câu báo máy (bộ nhớ dự án
   `hslc-bot-im-lang-va-tin-don-nhanh-pr570-575`). **Luật Trí tuệ nhân tạo 134/2025/QH15 Điều 11 khoản 1** đòi hệ
   thống AI tương tác trực tiếp với con người phải để người dùng **nhận biết** mình đang tương tác với AI. Bot ra mắt
   sau 01/03/2026 nên lộ trình chuyển tiếp 12 tháng (Điều 35) **có thể không áp dụng**. → **OWNER DECISION (F)**: hoặc
   đổi thiết kế, hoặc có ý kiến luật sư về ngoại lệ «pháp luật quy định khác» (chưa thấy ngoại lệ nào cho bán hàng).
3. **Dữ liệu cá nhân đang đi ra nước ngoài ở ít nhất bốn đường mà chưa có hồ sơ nào**: Google Gemini (nội dung hội
   thoại — `chatbot/src/gemini.js:5`, `lib/sales-chatbot/vision.ts`), Google Drive (bản sao lưu đã mã hoá —
   `scripts/erp-backup.sh`), Telegram / Lark (tin đơn mới **kèm tên · SĐT · địa chỉ** khách —
   `lib/sales-chatbot/new-order-alert.ts:29-52`), Meta (bản chất kênh). **Vùng xử lý của Google Gemini, Telegram,
   Lark và Meta: UNKNOWN — BLOCKER** (không đoán). Hồ sơ đánh giá tác động chuyển xuyên biên giới (NĐ 356 Điều 18)
   phải nộp Bộ Công an trong 60 ngày kể từ khi bắt đầu chuyển; bot HSLC đã chạy thật từ đầu tháng 10/2026 ⇒ đồng hồ
   **có thể đã chạy**. Mức phạt riêng cho chuyển xuyên biên giới trái luật: tới 5 % doanh thu năm trước (Luật 91 Điều 8).

Những gì ĐÃ có và đúng hướng (không phải «đã tuân thủ»): máy chủ VNPT tại Việt Nam; mỗi tổ chức một CSDL riêng có bài
kiểm cô lập; token page mã hoá AES-256-GCM; Chính sách quyền riêng tư 1.1 + Điều khoản 1.1 đã công bố và phiên bản chấp
thuận được ghi vào nhật ký tổ chức; xuất dữ liệu CSV tự phục vụ; xoá workspace có chạy thử; sổ chi phí AI không lưu
nội dung prompt; giá không hard-code thuế (`tax_mode = 'UNDECLARED'`); Số dư AI là tín dụng dịch vụ, không có rút tiền /
chuyển ngang.

### 1.1 Bảng FIRST OUTPUT

| Hạng mục | Nội dung |
|---|---|
| **LEGAL READINESS %** | **~18 %** trên 11 mục LEGAL-P0 (2,0 / 11) sau OWNER OVERRIDE 08/10 (bản đầu: 21 % / 12 mục). Chi tiết `LEGAL_LAUNCH_GATE.md` §2 |
| **LEGAL P0** (chỉ MANDATORY hoặc COUNSEL thuộc lớp giấy phép) | P0-1 phân loại dịch vụ xử lý DLCN + giấy chứng nhận · P0-2 DPIA · P0-3 hồ sơ chuyển xuyên biên giới + vùng xử lý · P0-4 công bố AI mức tối thiểu · P0-5 DPA (phụ lục Điều khoản) · P0-6 nơi lưu dữ liệu · P0-7 thông báo TMĐT · P0-8 khả năng thông báo sự cố 72 giờ · P0-9 khả năng đáp yêu cầu chủ thể trong hạn (quy trình tay) · P0-10 Số dư AI ≠ trung gian thanh toán · P0-11 hoá đơn đúng khi thu tiền |
| **LEGAL P1** | Chính sách nêu đủ bên thứ ba · số công bố khớp mã · nhật ký đăng nhập 12 tháng · bộ phận bảo vệ DLCN · chính sách khiếu nại · ghi sổ chấp thuận backend (không checkbox) · sổ đồng ý backend (không popup) · từ chối nhận tin backend · sổ AI · ATTT / MFA · retention · bằng chứng đơn · bài kiểm tín dụng · công cụ DSR · bảng sự cố · danh mục thuế · chân trang TMĐT. **DEFER**: checkbox / màn chặn đồng ý lại · che SĐT trong tin đơn · tối thiểu hoá prompt · OTP trước workspace · `/platform/compliance` (`LEGAL_LAUNCH_GATE.md` §4) |
| **LAWS / ARTICLES** | §2 (14 văn bản, có mức tin cậy từng số điều) |
| **CURRENT GAP** | §4–§15, mỗi mục có cột «Hôm nay» trỏ tệp:dòng |
| **OWNER ACTION** | §16.F |
| **LEGAL COUNSEL ACTION** | §16.G |
| **ENGINEERING ACTION** | `TECH_HANDOFF_LEGAL.md` (bounded missions, không mega PR) |
| **DOCUMENT ACTION** | §14 bộ 12 văn bản — trạng thái từng bản |
| **GOVERNMENT FILING ACTION** | §16.D |
| **BLOCKED / UNKNOWN** | §16.U — vùng xử lý Gemini / Meta / Telegram / Lark / Google Drive; phạm vi NĐ 333; phân loại dịch vụ xử lý DLCN; AI có trong Danh mục rủi ro cao không (Thủ tướng chưa ban hành theo nguồn đã đọc); SaaS + AI có là «dịch vụ phần mềm» miễn thuế GTGT không |

## 2. Khung pháp lý đã kiểm tra (08/10/2026)

Mỗi dòng ghi: văn bản · hiệu lực · nguồn đã đọc · điều khoản dùng trong tài liệu này · mức tin cậy của số điều.
Mức tin cậy: **GỐC** = đọc từ toàn văn trên cổng chính thống / bản dịch toàn văn; **THỨ CẤP** = đọc qua bản tóm tắt của
công ty luật / trang pháp luật, số điều phải được luật sư đối chiếu bản gốc trước khi trích vào văn bản gửi cơ quan.

| # | Văn bản | Ban hành → hiệu lực | Nguồn đã đọc | Điều khoản dùng | Tin cậy |
|---|---|---|---|---|---|
| L1 | **Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15** | 26/06/2025 → **01/01/2026** | vanban.bocongan.gov.vn (chỉ PDF), luatvietnam, EY, lexnovum, datasecurity.vn | Phân loại DLCN cơ bản / nhạy cảm; quyền chủ thể (biết · đồng ý · truy cập · sửa · xoá · rút đồng ý · hạn chế · phản đối · khiếu nại); Bên Kiểm soát / Bên Xử lý / Bên thứ ba; DPIA; chuyển xuyên biên giới; kinh doanh dịch vụ xử lý DLCN; xử phạt **Điều 8**: tới 3 tỷ đồng, mua bán DLCN tới 10 lần khoản thu, chuyển xuyên biên giới trái luật tới **5 % doanh thu năm liền trước**; **chuyển tiếp**: DN nhỏ · khởi nghiệp được hoãn 5 năm nghĩa vụ DPIA + bộ phận bảo vệ DLCN, hộ kinh doanh · DN siêu nhỏ được miễn — **TRỪ** bên kinh doanh dịch vụ xử lý DLCN, xử lý DLCN nhạy cảm, hoặc số lượng lớn (ngưỡng ~100.000 chủ thể theo tóm tắt NĐ 356) | THỨ CẤP (toàn văn chỉ có PDF, chưa trích được số điều cho từng quyền) |
| L2 | **Nghị định 356/2025/NĐ-CP** quy định chi tiết Luật BVDLCN | 31/12/2025 → **01/01/2026**, thay NĐ 13/2023 | caa.gov.vn (bản ký), luatvietnam (toàn văn), EY | **Điều 10** xử lý tự động / AI: thông báo, giải thích nguyên tắc, quyền không tham gia, quyền sửa / ẩn danh / xoá hồ sơ nhận dạng · **Điều 13–16** chuyên gia / bộ phận bảo vệ DLCN (cao đẳng + 2 năm + đào tạo; tổ chức dịch vụ ≥ 3 nhân sự) · **Điều 18** hồ sơ chuyển xuyên biên giới: nộp Bộ Công an trong **60 ngày** kể từ khi chuyển, Mẫu 09, thẩm định 15 ngày, hoàn thiện 30 ngày · **Điều 19** hồ sơ đánh giá tác động xử lý: nộp trong **60 ngày** kể từ khi xử lý, Mẫu 10 · **Điều 21** chín loại hình dịch vụ xử lý DLCN (gồm *cung cấp hệ thống tự động*, *phân tích dữ liệu lớn*, *xử lý bằng AI*, *thu thập từ web / mạng xã hội*…) · **Điều 22** điều kiện: pháp nhân Việt Nam, người đứng đầu là công dân VN thường trú, ≥ 3 nhân sự đủ năng lực, hạ tầng phù hợp, DPIA đạt · **Điều 24** Bộ Công an cấp Giấy chứng nhận (Mẫu 05) · **Điều 25** hồ sơ + thẩm định 30 ngày · **Điều 28–29** thông báo vi phạm (dữ liệu vị trí / sinh trắc: ≤ 72 giờ; thời hạn chung cần đối chiếu) · quyền chủ thể: phản hồi 2 ngày làm việc, thực hiện 10 / 15 / 20 ngày tuỳ quyền · **Điều 42** hiệu lực | THỨ CẤP (hai nguồn lệch nhau về «60 ngày» vs «15 ngày» — phải đối chiếu bản ký) |
| L3 | **Luật An ninh mạng 116/2025/QH15** (thay Luật ANM 2018 + Luật ATTT mạng 2015) | 10/12/2025 → **01/07/2026** | luatvietnam (toàn văn) | **Điều 25 khoản 3**: DN trong nước và nước ngoài cung cấp dịch vụ trên mạng viễn thông / Internet / giá trị gia tăng phải **lưu tại Việt Nam** thông tin cá nhân, dữ liệu về mối quan hệ của người dùng, dữ liệu do người dùng tạo ra, thời hạn do Chính phủ quy định · **Điều 25 khoản 2**: xác thực thông tin người dùng; cung cấp thông tin theo yêu cầu 24 giờ (khẩn 3 giờ); gỡ nội dung 24 giờ (khẩn 6 giờ); lưu nhật ký hệ thống · **Điều 16** bảo vệ trẻ em · **Điều 57–58** hiệu lực | GỐC |
| L4 | **Nghị định 333/2026/NĐ-CP** hướng dẫn Luật ANM (thay NĐ 53/2022) | **19/08/2026**, hiệu lực ngay | luatvietnam (bảng so sánh — trả phí), vacif, tapsanluatsunoibo | Lưu dữ liệu tại VN **tối thiểu 24 tháng**; nhật ký hệ thống (tài khoản, giờ vào / ra, IP, cổng nguồn) **tối thiểu 12 tháng**; **xác thực tài khoản số** bằng số điện thoại di động VN hoặc định danh cá nhân / định danh điện tử; đáp ứng yêu cầu 24 h / 3 h / 6 h | THỨ CẤP — **phạm vi đối tượng (mọi DN trong nước hay chỉ khi có yêu cầu) chưa rõ, mốc bắt đầu 24 tháng chưa rõ** ⇒ LEGAL COUNSEL REQUIRED |
| L5 | **Luật Trí tuệ nhân tạo 134/2025/QH15** | 10/12/2025 → **01/03/2026** | english.luatvietnam.vn (toàn văn bản dịch), thuvienphapluat, ixcert | **Điều 3**: nhà phát triển (3) · **nhà cung cấp** (4: đưa hệ thống AI ra thị trường / vào sử dụng dưới tên, thương hiệu của mình) · **bên triển khai** (5: dùng hệ thống AI dưới quyền kiểm soát của mình trong hoạt động kinh doanh / dịch vụ) · người sử dụng (6) · **Điều 7** hành vi cấm (che giấu thông tin bắt buộc, cản trở giám sát con người, thu thập dữ liệu trái luật…) · **Điều 9** ba mức rủi ro: cao / **trung bình = «có khả năng gây nhầm lẫn, tác động hoặc thao túng người dùng»** / thấp · **Điều 11 khoản 1**: hệ thống AI tương tác trực tiếp với con người phải được thiết kế, vận hành sao cho **người dùng nhận biết được mình đang tương tác với AI**, trừ khi pháp luật quy định khác · Điều 11 khoản 3: thông báo rõ khi đưa ra công chúng văn bản / âm thanh / hình ảnh do AI tạo nếu có thể gây nhầm lẫn · **Điều 12**: mọi bên bảo đảm an toàn, phát hiện và khắc phục sự cố · **Điều 13 khoản 4**: Thủ tướng ban hành Danh mục AI rủi ro cao · **Điều 14** nghĩa vụ rủi ro cao (quản lý rủi ro, hồ sơ kỹ thuật, nhật ký vận hành, giám sát con người, giải trình) · **Điều 15** rủi ro trung bình: minh bạch theo Điều 11 + giải thích khi cơ quan yêu cầu · **Điều 29** bồi thường (bên triển khai bồi thường khi AI rủi ro cao gây thiệt hại dù vận hành đúng) · **Điều 35** chuyển tiếp: hệ thống đang vận hành có **12 tháng kể từ 01/03/2026** (y tế · giáo dục · tài chính: 18 tháng) | GỐC |
| L6 | **Luật Dữ liệu 60/2024/QH15** + NĐ 165/2025/NĐ-CP | hiệu lực 01/07/2025 | hoilhpn.angiang (PDF), digitalpolicyalert | Dữ liệu **quan trọng** / **cốt lõi** theo danh mục Thủ tướng; chuyển xuyên biên giới dữ liệu đó phải được phê duyệt. Dữ liệu của ChotDonTuDong (hội thoại bán lẻ, đơn hàng) **không** nằm trong danh mục đã công bố theo những gì đọc được ⇒ áp dụng gián tiếp | THỨ CẤP |
| L7 | **Luật Thương mại điện tử 122/2025/QH15** | 10/12/2025 → **01/07/2026** | congbao.chinhphu.vn, bizconsult, luatvietnam | Bốn loại nền tảng TMĐT: kinh doanh trực tiếp · trung gian · mạng xã hội có TMĐT · tích hợp. Nền tảng **kinh doanh trực tiếp có chức năng đặt hàng trực tuyến** ⇒ **THÔNG BÁO**; ba loại còn lại ⇒ **ĐĂNG KÝ** với Bộ Công Thương; thủ tục qua Cổng Dịch vụ công quốc gia; nghĩa vụ công bố chủ sở hữu, giá, điều kiện giao dịch, chính sách bảo vệ thông tin cá nhân | THỨ CẤP (số điều chưa trích được) |
| L8 | **Nghị định 248/2026/NĐ-CP** hướng dẫn Luật TMĐT | 30/06/2026 → **01/07/2026** (xác thực người bán bằng định danh điện tử từ 01/01/2027) | luatvietnam, hatinh.dms.gov.vn, tapchicongthuong | Điều 18 (nền tảng trung gian cung cấp thông tin vi phạm), Điều 26 (nhân sự TMĐT chuyên trách; cơ chế dòng tiền / đối soát khi có đặt hàng trực tuyến); gỡ nội dung vi phạm 24 giờ | THỨ CẤP |
| L9 | **Luật Giao dịch điện tử 20/2023/QH15** | hiệu lực 01/07/2024 | kiến thức nền, chưa tra lại toàn văn | Giá trị pháp lý của thông điệp dữ liệu, hợp đồng điện tử, chữ ký điện tử ⇒ cơ sở cho «chấp thuận điện tử» Điều khoản | KHÔNG KIỂM LẠI TRONG LƯỢT NÀY |
| L10 | **Luật Bảo vệ quyền lợi người tiêu dùng 19/2023/QH15** | hiệu lực 01/07/2024 | kiến thức nền | Hợp đồng theo mẫu, điều kiện giao dịch chung, bảo vệ thông tin người tiêu dùng, giao dịch từ xa / trên không gian mạng | KHÔNG KIỂM LẠI TRONG LƯỢT NÀY |
| L11 | **Nghị định 52/2024/NĐ-CP** thanh toán không dùng tiền mặt | hiệu lực 01/07/2024 | vneconomy, thitruongtaichinhtiente, div.gov.vn | Dịch vụ **ví điện tử** (nạp · rút · thanh toán) và **thu hộ chi hộ**, **cổng thanh toán** là dịch vụ trung gian thanh toán, vốn tối thiểu 50 tỷ, giấy phép NHNN. Tiền điện tử chỉ được lưu ở ví điện tử / thẻ trả trước do tổ chức được cấp phép | THỨ CẤP |
| L12 | **Nghị định 123/2020/NĐ-CP** + **NĐ 70/2025/NĐ-CP** hoá đơn | NĐ 70 hiệu lực 01/06/2025 | ketoananpha, ihoadon, sapo | Thời điểm lập hoá đơn dịch vụ = khi hoàn thành cung cấp dịch vụ, **không phụ thuộc đã thu tiền**; thu tiền trước / trong khi cung cấp dịch vụ thì lập hoá đơn lúc thu tiền (trừ một số trường hợp đặt cọc). Hoá đơn điện tử bắt buộc | THỨ CẤP — kế toán / tư vấn thuế quyết áp dụng cho «Số dư AI» |
| L13 | **Luật Thuế GTGT 48/2024/QH15** + NĐ 181/2025 | hiệu lực 01/07/2025 | misa, gonnapass, tapchikinhtetaichinh | **Khoản 21 Điều 5**: sản phẩm phần mềm và dịch vụ phần mềm theo quy định pháp luật **không chịu thuế GTGT**; Luật Công nghiệp công nghệ số 2025 + NĐ 353/2025 định nghĩa lại sản phẩm / dịch vụ phần mềm từ 01/01/2026. SaaS + AI theo lượt có được coi là «dịch vụ phần mềm» hay không ⇒ **kế toán / tư vấn thuế quyết**, không hard-code | THỨ CẤP |
| L14 | **Nghị định 91/2020/NĐ-CP** chống tin nhắn / thư / cuộc gọi rác | hiệu lực 01/10/2020 | qtsc.com.vn (PDF), hethongphapluat | Tin nhắn / thư / cuộc gọi quảng cáo chỉ khi có **đồng ý trước**; tôn trọng Danh sách không quảng cáo (DoNotCall); phải có cơ chế từ chối; phân biệt tin quảng cáo với tin dịch vụ | THỨ CẤP (áp cho SMS / email / gọi; Messenger và Zalo do chính sách nền tảng + Luật BVDLCN) |

Nguồn thứ cấp đã dùng: luatvietnam.vn · thuvienphapluat.vn · EY Việt Nam · Lexnovum · Bizconsult · Vacif · Tạp san Luật sư nội bộ ·
ixcert. Nguồn chính thống đã mở được: vanban.bocongan.gov.vn (Luật 91 — PDF), caa.gov.vn (NĐ 356 — bản ký PDF),
congbao.chinhphu.vn (Luật 122), hatinh.dms.gov.vn (NĐ 248). Hai trang thuvienphapluat trả 403 trong lượt này.

## 3. Sản phẩm thật sự làm gì (căn cứ kiểm kê mã nguồn)

Đọc từ worktree `fd89b295`. Chi tiết bảng / cột ở `DATA_PROCESSING_REGISTER.md`; luồng ở `DATA_FLOW_MAP.md`.

- **Kênh vào**: Facebook Messenger qua app Meta của nền tảng (`lib/sales-chatbot/messenger.ts`; quyền xin duyệt:
  `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` —
  `docs/meta-app-review/01-quyen-va-dieu-kien.md:20-40`), Pancake Pages (fanpage qua Pancake), Zalo OA (BYO app của shop
  — `lib/integrations/zalo/oa.ts:5`), chat web `<tên>.erp.vnxcommerce.com/chat` (`lib/sales-chatbot/public.ts`).
- **Dữ liệu khách hàng cuối**: PSID / mã người gửi (`sales_chat_inbound.sender_id`, `from_id`), tên hiển thị
  (`customer_name`), nội dung tin (`text`), ảnh khách gửi (`image_urls`, chỉ địa chỉ trên CDN Facebook / Pancake —
  `lib/sales-chatbot/vision.ts`), SĐT và cấp độ khách (`sales_chat_conversations.customer_phone`, `customer_level`),
  hồ sơ khách (`customers`: tên, SĐT, địa chỉ, giới tính, ngày sinh, `fb_id`), đơn (`orders`: tên, SĐT, địa chỉ giao).
- **AI**: khoá nền tảng (`platform`, mặc định; provider `gemini` hoặc `anthropic` theo `PLATFORM_AI_PROVIDER`, model
  mặc định `gemini-3.5-flash-lite` — `lib/ai-usage/platform-ai.ts:25-58`; **giá trị thật trên production: UNKNOWN**)
  hoặc BYOK của shop (`anthropic-byok` · `openai-byok` · `gemini-byok`, `lib/sales-chatbot/config.ts:65`). Endpoint:
  `generativelanguage.googleapis.com/v1beta` · `api.anthropic.com` · `api.openai.com` (`lib/ai-builder/providers.ts:25-26,187`).
  Prompt gồm: hồ sơ shop, sổ tay, bài học, **khối «khách cũ» (tên, SĐT, địa chỉ, đơn cũ, tin cũ — `returning.ts:326-340`)**,
  tên Facebook của khách (`engine.ts:296-298`), 40 tin gần nhất (`engine.ts:882`), ảnh khách gửi dạng base64 (tối đa 3
  — `vision.ts`). Luồng SaaS **không gửi ghi âm** (`fanpage.ts:505`); bot cũ của tổ chức nhà (`chatbot/`) **có** chép ghi
  âm giọng khách qua Gemini (`chatbot/src/voice.js`). **Nội dung prompt / câu trả lời KHÔNG lưu ở sổ chi phí**
  (`platform_ai_usage` chỉ có provider · model · token · chi phí · modality — `db/schema.ts:5071`), nhưng toàn bộ hội
  thoại kể cả kết quả công cụ LƯU ở `sales_chat_messages` (`db/schema.ts:11090`). Bot có công cụ `handoff_to_human`
  (`engine.ts:194`); ba chế độ hội thoại AUTO / COPILOT / HUMAN (`conversation-control-shared.ts`); nhân viên gõ tay thì
  bot nhường (`ai-hold-shared.ts:105`); tắt AI theo page (`org_channel_pages.ai_enabled`). Bot **không** tự xưng là AI (§1.2).
- **Tự tạo đơn**: nháp từ công cụ AI (`sc/tools.ts:181-213`), chốt khi khách đồng ý bằng lời (cổng «nguyên văn» yếu —
  `docs/saas/ORDER_CANDIDATE.md` §1), máy ghi đơn từ hội thoại nhân viên (`sc/order-sync.ts`: khách tự gửi SĐT + địa
  chỉ = chốt, quyết định chủ shop 05/10), công tắc «đơn đủ thông tin = đã xác nhận» (`lib/records/order-create.ts:452`).
- **Thu tiền**: gói V1 (`docs/saas/PRICING_V1.md`), chuyển khoản theo mã + VietQR, đối soát SePay webhook
  (`app/api/webhooks/sepay/route.ts`), Số dư AI trả trước (`docs/saas/AI_BALANCE_V1.md`), hoá đơn VAT ghi tay số đã
  xuất (`docs/platform/billing.md` §8), `tax_mode = 'UNDECLARED'`.
- **Đăng ký**: `/start` (chế độ `PLATFORM_SIGNUP_MODE`, đang `open` — `docs/saas/LAUNCH_GATE.md` §8), đăng nhập email +
  mật khẩu, Google / Facebook OAuth (`scope: openid email profile` / `email,public_profile` — `lib/auth/oauth.ts:110-113`),
  OTP Zalo ZNS **mặc định tắt** (`lib/onboarding/phone-otp.ts:22`).
- **Hạ tầng**: MỘT VPS tại Việt Nam — **hai nguồn nói hai tên**: `docs/TRIEN-KHAI-VPS.md:9` ghi **Vietnix** (IP
  `14.225.198.146`, 2 vCPU · 2 GB), trang chính sách công bố **VNPT** (`app/chinh-sach-bao-mat/page.tsx:96`), comment
  `deploy/places-relay/relay.js:6` ghi «VNPT TP.HCM» ⇒ **phải xác định bên ký hợp đồng hạ tầng** (F). Docker: Postgres 16
  + app + scheduler + bot + Caddy (`docker-compose.prod.yml`), mỗi tổ chức một CSDL `erp_org_<mã>` trên cùng cụm, không
  RLS, không cột tổ chức trong bảng nghiệp vụ (`db/schema.ts:4817-4822`); sao lưu `pg_dump` trên VPS + Google Drive
  qua rclone crypt + PITR (`docs/platform/backup-recovery.md` §2); cảnh báo Lark / Telegram / Zalo Bot, Telegram có thể
  đi qua **relay Cloudflare Worker ngoài Việt Nam** (`deploy/telegram-relay-worker.js`, bật bằng `TELEGRAM_API_BASE`);
  mã nguồn, CI, image (GHCR) trên GitHub (kho **PUBLIC**); **không có** kênh email, SMS, Sentry, analytics bên thứ ba,
  Redis, vector DB, CDN (grep sạch — `SUBPROCESSOR_REGISTER.md` §5).

## 4. P0 — Phân loại «dịch vụ xử lý dữ liệu cá nhân» (NĐ 356 Điều 21–25)

| # | Câu hỏi | Phân tích | Kết luận | Loại |
|---|---|---|---|---|
| 4.1 | Có thuộc «dịch vụ xử lý DLCN» không? | Điều 21 liệt kê 9 loại hình, trong đó (theo tóm tắt luatvietnam / EY): cung cấp **hệ thống tự động** xử lý DLCN, **phân tích dữ liệu lớn**, **xử lý bằng AI**, thu thập từ **mạng xã hội**, định vị, mã hoá, chấm điểm tín dụng, y tế, giáo dục. Chốt Đơn Tự Động thu phí để tự động thu nhận hội thoại Messenger (mạng xã hội), trích SĐT / địa chỉ, phân tích bằng AI, tạo đơn. Lập luận ngược: VNX là **Bên Xử lý** theo chỉ dẫn của khách thuê (Chính sách 1.1 §1), bán *phần mềm* chứ không bán *dịch vụ xử lý*. Ranh giới «SaaS = công cụ» vs «dịch vụ xử lý» chưa có hướng dẫn chính thức mà lượt này tìm thấy | **CHƯA KẾT LUẬN ĐƯỢC. Rủi ro áp dụng: CAO.** | G |
| 4.2 | Mục Điều 21 nào có khả năng áp dụng | «Cung cấp hệ thống tự động xử lý DLCN» · «xử lý DLCN bằng AI» · «thu thập DLCN từ trang web / mạng xã hội» (nếu nhập lịch sử hội thoại — `sales_chat_conversations.history_imported_at`) | 3 mục khả dĩ | G |
| 4.3 | Điều 22 — đã / chưa đạt | (a) Pháp nhân VN: **ĐẠT** — Công ty cổ phần VNXcommerce, MST 0109872760 (`lib/constants/company.ts:5-8`). (b) Người đứng đầu phụ trách là công dân VN thường trú: **chưa xác nhận bằng văn bản** (C). (c) ≥ 3 nhân sự cao đẳng trở lên, 2 năm kinh nghiệm, đã đào tạo bảo vệ DLCN: **UNKNOWN / có khả năng CHƯA** (C). (d) Hạ tầng, trang thiết bị, công nghệ phù hợp: một phần (VPS VN, cô lập, mã hoá; chưa có chính sách ATTT chính thức). (e) Hồ sơ đánh giá tác động xử lý đạt yêu cầu: **CHƯA** (§6) | 1/5 đạt, 1/5 một phần | C · B · D |
| 4.4 | Có cần Giấy chứng nhận không | Nếu 4.1 = CÓ ⇒ **bắt buộc**, do Bộ Công an cấp (Điều 24, Mẫu 05), thẩm định 30 ngày (Điều 25) | Phụ thuộc 4.1 | D |
| 4.5 | Hồ sơ Điều 25 | Đơn đề nghị · Giấy ĐKDN · văn bản chỉ định bộ phận bảo vệ DLCN · đề án hoạt động · bằng cấp, lý lịch nhân sự | Chưa có bản nào | C |
| 4.6 | Ai là nhân sự / bộ phận bảo vệ DLCN | NĐ 356 Điều 13–16: người có trình độ cao đẳng trở lên, 2 năm kinh nghiệm, đã đào tạo. Hôm nay: `COMPANY.email = support@vnxcommerce.com` làm đầu mối (`privacy-policy.md` §8 để trống «Họ tên / bộ phận») | **Chưa chỉ định** | F · C |
| 4.7 | Mức nhân sự tối thiểu theo luật | Tổ chức kinh doanh dịch vụ xử lý DLCN: ≥ 3 nhân sự đủ điều kiện (Điều 22, 16) | Chỉ khi 4.1 = CÓ | G |
| 4.8 | Hạn chót · chuyển tiếp · chế tài | Luật 91 + NĐ 356 hiệu lực 01/01/2026, không thấy lộ trình riêng cho dịch vụ xử lý DLCN. Hoãn 5 năm cho DN nhỏ / khởi nghiệp **không áp dụng** cho bên kinh doanh dịch vụ xử lý DLCN, xử lý DLCN nhạy cảm hoặc số lượng lớn. Phạt tới 3 tỷ; thu hồi / đình chỉ | Nếu 4.1 = CÓ thì đang vi phạm từ ngày có khách trả tiền | G |

**Kết luận phần 4:** không tự giả định. Câu hỏi gửi luật sư (§16.G-1) phải nhận văn bản trả lời có viện dẫn, và cổng
`COMMERCIAL READY` bị khoá cho tới khi có.

## 5. Ma trận vai trò dữ liệu — tóm tắt

Bảng đầy đủ 15 cột cho 17 tập dữ liệu ở `DATA_PROCESSING_REGISTER.md`. Tóm tắt vai trò:

| Nhóm | Chủ thể | Bên Kiểm soát | Bên Xử lý | Bên xử lý phụ | Căn cứ pháp lý (đề xuất, luật sư chốt) |
|---|---|---|---|---|---|
| A. Tài khoản SaaS, nhân viên khách thuê, thanh toán, IP / đăng nhập | Người đăng ký, nhân viên | **VNXcommerce** | — | VNPT, Google Drive, SePay, Zalo (OTP), Google / Facebook (OAuth) | Thực hiện hợp đồng + đồng ý khi đăng ký (`/start`) |
| B. Khách hàng Facebook của khách thuê: PSID, tên, hội thoại, SĐT, địa chỉ, đơn, bộ nhớ khách, kết quả AI | Người tiêu dùng | **Khách thuê** | **VNXcommerce** | Google Gemini, VNPT, Google Drive, Telegram / Lark (tin đơn), Meta (kênh), Pancake, Viettel Post, Zalo OA | Khách thuê chịu trách nhiệm có căn cứ (đồng ý / hợp đồng mua bán); VNX xử lý theo DPA — **chưa có DPA** |
| C. AI prompt / output | Cả A và B | theo nhóm nguồn | VNX | Google Gemini (hoặc BYOK của shop) | Theo nhóm nguồn + NĐ 356 Điều 10 (thông báo xử lý tự động) |
| D. Nhật ký kiểm toán, sao lưu, hỗ trợ, phân tích | A + B | VNX (A) / khách thuê (B) | VNX | VNPT, Google Drive | Nghĩa vụ pháp lý (ANM) + lợi ích hợp pháp — **luật 91 có cho «lợi ích hợp pháp» không: luật sư** |
| E. Khách tiềm năng sỉ (Google Places → liên hệ) | Chủ cửa hàng khác | VNX / khách thuê dùng tính năng | VNX | Google Places | Thu thập từ nguồn công khai để tiếp thị: cần đồng ý trước khi nhắn (NĐ 91) — **rủi ro** |

## 6. DPIA — Hồ sơ đánh giá tác động xử lý DLCN (Luật 91 + NĐ 356 Điều 19)

| Thành phần hồ sơ | Bằng chứng kỹ thuật đã có | Thiếu | Loại |
|---|---|---|---|
| Sơ đồ luồng dữ liệu | `DATA_FLOW_MAP.md` (bản này) | Xác nhận vùng xử lý của 4 bên ngoài | B |
| Mục đích xử lý | `privacy-policy.md` §2; Chính sách 1.1 công bố | Tách mục đích theo tính năng (bot, follow-up, phân tích, đào tạo bot «tự học» PR #496) | B |
| Loại dữ liệu | `DATA_PROCESSING_REGISTER.md` | Phân loại nhạy cảm: `customers.date_of_birth`, `gender`; ghi âm khách (`chatbot/`, PR #480) — ghi âm giọng nói là DLCN nhạy cảm? **luật sư** | B · G |
| Căn cứ / đồng ý | Dòng đồng ý ở `/start` (`components/onboarding/quick-start.tsx:203`, `start-wizard.tsx:343`), phiên bản ghi `ORG_ONBOARDED` (`lib/onboarding/service.ts:439`) | Đồng ý của **khách hàng cuối**: không có cơ chế nào — phụ thuộc khách thuê; chưa có sổ đồng ý (§11) | A · B |
| Lưu / xoá | 90 ngày sau hết hạn + báo trước 15 ngày (`SERVICE_COMMITMENTS`), xoá workspace (`lib/platform/offboard.ts`), xoá 30 ngày sau xác minh (Chính sách §9) | Chưa có job xoá tự động theo lịch; chưa có retention theo từng loại dữ liệu; chưa xoá được MỘT khách hàng cuối theo SĐT / PSID xuyên bảng | A |
| Kiến trúc | `docs/saas/SECURITY.md`, `docs/platform/target-architecture.md` | Bản vẽ cho cơ quan | B |
| Biện pháp bảo mật | Cô lập silo + bài kiểm; AES-256-GCM token (`lib/connectors/secrets.ts`); băm mật khẩu / liên kết; throttle đăng nhập (`lib/auth/login-throttle.ts`); audit | MFA không có; nhật ký đăng nhập không lưu IP (`audit_logs` không có cột IP — `db/schema.ts:916`); chính sách ATTT chính thức | A · B |
| Sổ rủi ro | `docs/platform/risk-register.md` (kỹ thuật) | Sổ rủi ro DLCN riêng | B |
| Quy trình sự cố | Không có runbook chính thức | Runbook 72 giờ (§12) | B |
| Nộp Bộ Công an | — | Mẫu 10, trong 60 ngày kể từ khi xử lý (số ngày cần đối chiếu bản ký NĐ 356); nếu VNX là DN nhỏ / khởi nghiệp VÀ không phải dịch vụ xử lý DLCN VÀ < 100.000 chủ thể ⇒ được hoãn 5 năm (**luật sư xác nhận** cả ba vế) | D · G |

**Không tự tuyên bố hồ sơ đã được tiếp nhận.** Trạng thái: **CHƯA LẬP, CHƯA NỘP.**

## 7. Chuyển dữ liệu xuyên biên giới

| # | Đường chuyển | Dữ liệu | Pháp nhân nhận | Vùng xử lý | Mã hoá | Trạng thái |
|---|---|---|---|---|---|---|
| X1 | Google Gemini API (`chatbot/src/gemini.js:5`, `lib/sales-chatbot/*` qua `ai-model-control`) | Nội dung hội thoại (tin khách + bot), tên hiển thị, SĐT / địa chỉ nếu khách gõ trong tin, mô tả ảnh (`vision.ts`), ghi âm khách (`chatbot/`, PR #480) | Google LLC / Google Asia Pacific (theo điều khoản API) | **UNKNOWN — BLOCKER** (API `generativelanguage` không cam kết vùng; Vertex AI có vùng nhưng chưa dùng) | TLS; Google giữ bản rõ khi xử lý | Đang chuyển (bot HSLC chạy thật) — **chưa có hồ sơ** |
| X2 | Google Drive sao lưu (`scripts/erp-backup.sh`, rclone `gcrypt:`) | Toàn bộ CSDL nhà + mọi `erp_org_*` | Google LLC | **UNKNOWN** | rclone crypt (Drive chỉ thấy byte mã hoá, khoá ở VPS) | Đang chuyển hằng ngày — dữ liệu mã hoá vẫn là DLCN? **luật sư**; Drive đang lỗi 403 từ 08/10 (`LAUNCH_GATE.md` §8) |
| X3 | Telegram Bot API (`lib/alerts/telegram.ts`; tin đơn mới `lib/sales-chatbot/new-order-alert.ts:52`) | **Tên, SĐT, địa chỉ, món hàng** của khách hàng cuối; cảnh báo vận hành | Telegram FZ-LLC / Telegram Messenger Inc. | **UNKNOWN** | TLS; Telegram giữ bản rõ | Đang chuyển (HSLC bật 04/10) — **chưa có hồ sơ** |
| X4 | Lark Custom Bot (`lib/alerts/lark.ts`, 11 nơi gọi) | Cảnh báo, bản tin, leo thang care: mã đơn, tên khách, SĐT ở một số mẫu tin | Lark Technologies Pte. Ltd. (Singapore) / ByteDance | **UNKNOWN** | TLS | Đang chuyển (ERP nhà VNX) |
| X5 | Meta Graph / Messenger (`lib/sales-chatbot/messenger.ts`, `lib/integrations/messenger/graph.ts`) | Tin nhắn hai chiều, PSID, tên; câu trả lời của bot (chứa dữ liệu khách suy ra) | Meta Platforms, Inc. / Meta Platforms Ireland Ltd. | **UNKNOWN** (không đoán) | TLS | Bản chất kênh: dữ liệu sinh ra ở Meta, VNX nhận về và gửi lại |
| X6 | Anthropic / OpenAI (`lib/ai/provider.ts`, `lib/cs/chat-detect.ts`, `lib/creative/*`) | Hội thoại CSKH của shop VNX (phân loại), ảnh sản phẩm, prompt copilot | Anthropic PBC / OpenAI, L.L.C. (Hoa Kỳ) | **UNKNOWN** | TLS | ERP nhà VNX (không phải sản phẩm Chốt Đơn) — vẫn phải vào hồ sơ của VNX |
| X7 | GitHub (`.github/workflows/*`, ops `db-query` kết quả mã hoá) | Mã nguồn; kết quả truy vấn production **đã mã hoá** bằng mật khẩu chủ shop (bộ nhớ dự án `do-production-qua-kenh-tom-tat`) | GitHub, Inc. (Microsoft) | **UNKNOWN** | Mã hoá ở tầng ứng dụng | Thấp — vẫn liệt kê |
| X8 | Google Places (`lib/integrations/google-places/client.ts`, relay Cloud Run `asia-southeast1` `deploy/places-relay/*`) | Tên, SĐT, địa chỉ cơ sở kinh doanh (có thể là cá nhân) — chiều VÀO từ Google; từ khoá tìm kiếm đi RA | Google LLC | Singapore (relay) / UNKNOWN (API) | TLS | Thu thập từ nguồn công khai để tiếp thị — rủi ro NĐ 91 |
| X9 | Cloudflare Worker relay Telegram (`deploy/telegram-relay-worker.js:1-23`, `lib/connectors/telegram-api.ts:1-20`) | **Toàn bộ nội dung tin Telegram** (gồm tin đơn mới: tên, SĐT, địa chỉ) + bot token trong đường dẫn | Cloudflare, Inc. | «ngoài Việt Nam», cụ thể **UNKNOWN**; có đang bật trên production (`TELEGRAM_API_BASE`) hay không: **UNKNOWN** | TLS | Bên xử lý phụ **chưa được công bố** ở Chính sách 1.1 |
| X10 | Zalo Bot API (`bot-api.zaloplatforms.com`, `lib/connectors/registry.ts:751-770`) | Tin báo nhóm (có thể chứa đơn) | VNG Corporation (Việt Nam) | VN (cần xác nhận) | TLS | Trong nước — vẫn phải vào danh sách bên xử lý phụ |
| X11 | GHN · GHTK (`lib/constants/carrier-ghn.ts`, `carrier-ghtk.ts`) | Tên, SĐT, địa chỉ người nhận, COD | Giao Hàng Nhanh · Giao Hàng Tiết Kiệm (Việt Nam) | VN | TLS | Trong nước; khách thuê tự kết nối — thiếu trong Chính sách §4 |

**Hồ sơ hỗ trợ đánh giá tác động chuyển xuyên biên giới (NĐ 356 Điều 18, Mẫu 09):** phải lập cho X1–X5 tối thiểu.
Hành động chặn trước khi nộp: (i) hỏi Google có cam kết vùng xử lý cho Gemini API hay phải chuyển sang Vertex AI khu
vực `asia-southeast1`; (ii) quyết định có tiếp tục gửi SĐT / địa chỉ khách qua Telegram / Lark không (thay bằng link mở
ERP — tiền lệ đã có: `lark-custom-bot-khong-nhan-nut-bam`); (iii) luật sư xác định bên nào nộp hồ sơ khi VNX là Bên Xử lý
(khách thuê là Bên Kiểm soát) — nghĩa vụ có thể thuộc **cả hai**.

## 8. Nơi lưu dữ liệu tại Việt Nam (Luật ANM 116/2025 Điều 25.3 + NĐ 333/2026)

| Thành phần | Ở đâu | Tại VN? | Ghi chú |
|---|---|---|---|
| CSDL chính (`erp` + `erp_org_*`) | Postgres trong Docker trên VPS VNPT (`docker-compose.prod.yml:6-34`) | **CÓ** | Chính sách 1.1 công bố «trung tâm dữ liệu VNPT tại Việt Nam» |
| Replica | Không có | n/a | |
| Object storage | Không có; tệp đính kèm là `bytea` trong CSDL (`custom_files.data`); ảnh khách giữ URL trên CDN Facebook / Pancake | CÓ (phần lưu) | Ảnh gốc ở Meta — ngoài VN |
| Sao lưu | VPS (`/root/backups`, 7 ngày / 4 tuần / 3 tay) + PITR + Google Drive mã hoá | VN **và** ngoài VN | Bản VN đủ để đáp ứng «lưu tại VN»; bản ngoài là chuyển xuyên biên giới (§7 X2) |
| Nhật ký | Docker logs trên VPS; `audit_logs` trong CSDL | CÓ | **Thiếu IP + cổng nguồn + đăng xuất** theo NĐ 333 (12 tháng) |
| Analytics | `platform_saas_daily`, `platform_tenant_usage_daily` trong CSDL nhà | CÓ | Không có GA / Pixel trên trang (grep sạch) |
| Cache | Bộ nhớ tiến trình (`lib/cache.ts::memo`) | CÓ | |
| Search index / vector DB | Không có (kiểm kê agent: xem `SUBPROCESSOR_REGISTER.md` §4) | n/a | |
| AI context store | `sales_chat_messages`, `sales_chat_conversations.state` trong CSDL tổ chức | CÓ | Bản tạm thời ở Google khi gọi API |
| Thông báo vận hành | Lark / Telegram | **KHÔNG** | §7 X3–X4 |

**Kế hoạch DATA RESIDENCY (không di chuyển dữ liệu production khi chưa có Tech Lead duyệt):**
1. Giữ nguyên CSDL + sao lưu chính tại VN (đã đúng).
2. Thêm nhật ký đăng nhập bền vững ≥ 12 tháng: tài khoản · thời điểm vào / ra · IP · cổng nguồn (NĐ 333) — mission
   trong handoff.
3. Xác thực tài khoản số bằng SĐT di động VN hoặc định danh điện tử (NĐ 333) cho tài khoản khách thuê: cơ chế OTP Zalo
   ZNS đã có nhưng **mặc định tắt** — **luật sư xác định SaaS B2B có thuộc đối tượng không**, rồi chủ sở hữu bật.
4. Quyết định về bản sao Google Drive: (a) giữ + lập hồ sơ xuyên biên giới, hoặc (b) chuyển sang lưu trữ đối tượng trong
   nước (VNPT / Viettel / FPT Cloud) — OWNER DECISION, chi phí phải đo.
5. Thời hạn lưu 24 tháng (NĐ 333) đối chiếu với «xoá 90 ngày sau hết hạn» của Điều khoản: hai mốc này **mâu thuẫn** nếu
   NĐ 333 áp cho VNX ⇒ LEGAL HOLD / RETENTION RULE phải phân biệt «dữ liệu dịch vụ của khách thuê» (xoá theo hợp đồng)
   với «dữ liệu ANM phải giữ» (tài khoản, nhật ký) — luật sư chốt.

## 9. Quyền chủ thể dữ liệu (DSR)

| Quyền | Nhóm A (tài khoản) | Nhóm B (khách hàng cuối) — qua khách thuê | Hôm nay |
|---|---|---|---|
| Truy cập / biết | Trang hồ sơ, Chính sách §6 | Khách thuê tìm theo SĐT / PSID trong hộp thư | Hộp thư có tìm theo hội thoại; **không có màn «tra cứu một chủ thể xuyên bảng»** |
| Sửa | Tự sửa hồ sơ | Nhân viên sửa khách / đơn | Có |
| Xuất | `/settings/data-export` CSV (`lib/exports/tenant-data.ts`, ghi `DATA_EXPORT`) | Xuất toàn tổ chức, không xuất **một** chủ thể | Thiếu xuất theo chủ thể |
| Rút đồng ý / hạn chế / phản đối | Email support (Chính sách §9) | Không có cơ chế; bot không có lệnh «tôi không muốn nói chuyện với máy» | **Thiếu** (NĐ 356 Điều 10: quyền không tham gia xử lý tự động) |
| Xoá | Email, xác minh, 30 ngày; xoá workspace `lib/platform/offboard.ts` (chạy thử trước, không đụng tiền) | Không có «xoá một khách hàng cuối» | Thiếu; **phải có LEGAL HOLD**: không xoá chứng từ thanh toán (kế toán), dữ liệu ANM 24 tháng |
| Nhật ký yêu cầu | `platform_audit_log` cho thao tác người vận hành | — | Thiếu sổ DSR riêng (ai yêu cầu, khi nào, kết quả, hạn 2 / 10 / 15 / 20 ngày) |

Thiết kế đề xuất ở `TECH_HANDOFF_LEGAL.md` M-DSR. Tenant-safe: mọi tra cứu đi qua `getDb()` của tổ chức, người vận hành
nền tảng chỉ xử lý nhóm A.

## 10. Sổ đồng ý (consent ledger) — đặc tả

Trường bắt buộc: `subject_kind` (ACCOUNT · END_CUSTOMER) · `subject_ref` (users.id / SĐT băm / PSID) · `org_code` ·
`purpose` (SERVICE · MARKETING · AI_PROCESSING · ANALYTICS · THIRD_PARTY) · `scope` · `source` (SIGNUP_FORM · CHAT ·
IMPORT · API · STAFF_RECORDED) · `policy_version` · `evidence` (tin nhắn gốc / ảnh chụp màn hình / tên form) ·
`granted_at` · `withdrawn_at` · `status` · `recorded_by`. Luật: không pre-checked; không gộp đồng ý tiếp thị với vận
hành; im lặng ≠ đồng ý; khách thuê ghi nhận đồng ý của khách hàng cuối nếu họ có. Hôm nay: không có bảng nào; dòng
đồng ý ở `/start` là chấp thuận hợp đồng, không phải sổ đồng ý theo mục đích.

## 11. Luật AI (134/2025/QH15)

| Mục | Phân tích | Trạng thái |
|---|---|---|
| Vai trò | VNXcommerce **đưa hệ thống AI vào sử dụng dưới thương hiệu «Chốt Đơn Tự Động»** ⇒ **nhà cung cấp** (Điều 3.4). Khách thuê dùng dưới quyền kiểm soát của mình ⇒ **bên triển khai** (Điều 3.5). VNX dùng cho shop của chính mình ⇒ cũng là bên triển khai. Google = nhà phát triển mô hình | Cả hai vai trò |
| Phân loại rủi ro | Điều 9: trung bình = «có khả năng gây nhầm lẫn, tác động hoặc thao túng người dùng». Bot bán hàng nói chuyện với người tiêu dùng, không xưng là máy, tự tạo đơn ⇒ **ít nhất TRUNG BÌNH**. Danh mục rủi ro cao do Thủ tướng ban hành — **chưa thấy** trong lượt tra cứu | TRUNG BÌNH (tạm), G xác nhận |
| Minh bạch (Điều 11.1) | **Vi phạm theo thiết kế**: `lib/sales-chatbot/followup.ts:58`; quyết định HSLC 05/10 bỏ câu báo máy. Không thấy ngoại lệ «pháp luật quy định khác» cho bán hàng | **KHÔNG ĐẠT** — F + A |
| Gắn nhãn nội dung (Điều 11.3) | Câu trả lời văn bản của bot gửi cho khách — có «gây nhầm lẫn» không khi bot xưng «em» như nhân viên? | G |
| Nghĩa vụ rủi ro trung bình (Điều 15) | Minh bạch + giải thích khi cơ quan yêu cầu | Cần sổ hệ thống AI |
| Nghĩa vụ chung (Điều 12) | An toàn, phát hiện / khắc phục sự cố: có `sales-health`, `ai-incident-watch`, `platform_ai_usage.status` | Một phần |
| Giám sát con người | `handoff_to_human`, tiếp quản, nút Xác nhận / Huỷ (#675) | Có — nhưng khách hàng cuối không tự gọi được người |
| Nhật ký / truy vết | `sales_conversation_events`, `prompt-stamp.ts`, `platform_ai_usage` (model, token); **không lưu prompt** | Một phần — không tái dựng được «bot đã thấy gì» |
| Sự cố AI | Chưa có quy trình báo cáo | Thiếu |
| Chuyển tiếp (Điều 35) | 12 tháng từ 01/03/2026 cho hệ thống **đang vận hành trước đó**; bot Chốt Đơn ra sau ⇒ có thể không được hưởng | G |
| Thông báo cơ quan | Luật giao Chính phủ quy định; chưa thấy nghị định hướng dẫn trong lượt này | UNKNOWN |

**AI SYSTEM REGISTER (khởi tạo):** `AI-01 Sales Agent Messenger / Zalo / web chat` — nhà cung cấp mô hình Google
(`gemini-2.5-flash-lite` mặc định, `gemini-omni-1.1-flash` ở một số đường — `lib/sales-chatbot/config.ts`,
`docs/platform/ai-model-control.md`), hoặc BYOK · mục đích: tư vấn, gom thông tin đơn, tạo nháp · giám sát: tiếp quản,
xác nhận tay · lịch sử thay đổi: PR #552 → #688 · `AI-02 Bot ghi âm / đọc ảnh` (`chatbot/`, `vision.ts`) ·
`AI-03 Follow-up tự động` (`followup.ts`) · `AI-04 Bot tự học từ hội thoại` (PR #496, `playbook.ts`) · `AI-05 Copilot /
agent nội bộ` (Anthropic — ERP nhà). Mỗi hệ thống cần: mức rủi ro, bằng chứng phân loại, phiên bản, người chịu trách
nhiệm, quy trình sự cố — mẫu ở `TECH_HANDOFF_LEGAL.md` M-AI-REG.

**Thiết kế công bố cho khách hàng cuối — bản sau OWNER OVERRIDE 08/10 (`CONVERSION_FIRST_REAUDIT.md` §3), mức TỐI
THIỂU HỢP PHÁP:** (1) nhận diện ở lớp giao diện, ngoài nội dung tin — tên hiển thị bot «Trợ lý AI», greeting / ice breakers
của Page, tiêu đề chat web — ma sát 0; (2) **một** dòng tự nhiên theo giọng shop, **một lần**, mở đầu câu trả lời đầu tiên
của hội thoại mới («Trợ lý AI của {shop} hỗ trợ anh/chị ngay đây ạ 😊»), không tin riêng, không lặp; (3) hỏi thẳng là máy
hay người thì trả lời thật một câu rồi tiếp tục bán; lệnh «gặp nhân viên» gọi `handoff_to_human` không qua AI quyết nhưng
**không** in hướng dẫn trong tin. Không dùng «tôi không phải con người» / «bạn đang nói chuyện với máy». Luật sư xác nhận
(1) một mình có đủ không (G-4). Mọi câu chữ phải đo A/B giữa các biến thể đều hợp pháp.

## 12. An toàn đơn hàng (ORDER SAFETY)

| Yêu cầu | Hôm nay | Khoảng trống |
|---|---|---|
| AI không âm thầm đổi SKU · SL · giá · giảm giá · SĐT · địa chỉ · trạng thái thanh toán | Giá luôn tính ở máy chủ, cấm giảm giá (`lib/commerce/pricing.ts:19-70`); nháp ghi `orders` NEW | Công tắc «đủ thông tin = đã xác nhận» nâng nháp bot lên CONFIRMED trước khi khách đồng ý (`order-create.ts:452-473`); «nguyên văn» chỉ là phép chuỗi con (`sc/text.ts:7-16`) |
| Bằng chứng từng trường: nguồn · giá trị trích · độ tin · khách sửa · người sửa · phiên bản · mốc | `customer_confirmation` chỉ nằm trong payload công cụ; `summary` bị bỏ khi tạo đơn | Thiết kế `ORDER_CANDIDATE.md` §2–§5 chưa triển khai |
| Mơ hồ ⇒ NEEDS VERIFICATION | #675 «cần người kiểm» + nút nhanh | Địa chỉ mơ hồ không làm bot hỏi lại (`vn-address.ts` không được bot gọi) |
| Không bịa xác nhận của khách | Luật HSLC: khách tự gửi SĐT + địa chỉ = chốt không cần xác nhận (`order-sync.ts:204-245`) | Chấp nhận được về giao dịch (khách chủ động) nhưng **phải lưu tin gốc làm bằng chứng** |

## 13. An ninh mạng

| Mục | Hôm nay | Khoảng trống |
|---|---|---|
| Cô lập tổ chức | SILO, `getDb()` theo claim `org` trong JWT; bài kiểm `tenant-attack`, `ai-sales-isolation`, `platform-isolation*` | Kiểm production chưa (🟡 CODE) |
| RBAC | `lib/auth/access.ts` ba chiều; chức danh không sinh quyền | — |
| MFA cho quản trị / người vận hành nền tảng | **Không có** (grep `totp`/`mfa` trong lib/auth: 0) | P1 |
| Quản lý bí mật | `.env` trên VPS + GitHub Secrets; token kết nối AES-256-GCM (`lib/connectors/secrets.ts`); job cấp phát không lưu mật khẩu | Luân chuyển khoá chưa có quy trình |
| Mã hoá | TLS (Caddy), sao lưu rclone crypt, mật khẩu băm | Mã hoá tại chỗ CSDL (at-rest) chỉ ở mức ổ đĩa VPS — xác nhận với VNPT |
| Lưu token | `org_channel_pages` (mã hoá), `integration_tokens` | — |
| Sao lưu / khôi phục | Hằng ngày + giờ cho org + PITR + drill Chủ nhật (`backup-recovery.md`) | Drive 403 từ 08/10 (`LAUNCH_GATE.md` §8) |
| Audit log | `audit_logs` (tổ chức), `platform_audit_log` (nền tảng), `DATA_EXPORT`, `ORG_OFFBOARD` | Không IP / user-agent; nhật ký đăng nhập chỉ bộ nhớ (`login-throttle.ts`) |
| Quản lý lỗ hổng | `npm audit`? CI gates; kho public | Chưa có lịch quét / chính sách vá |
| Rate limit | Throttle đăng nhập theo cặp (email, IP); trần OTP theo SĐT / IP băm / ngày; webhook ký HMAC (SePay), chữ ký Meta | Rate limit API chung chưa thấy |
| Phiên | JWT ký `AUTH_SECRET`, `loginAt` để thu hồi | — |
| Truy cập production | SSH VPS (ai?), ops GitHub Actions có dấu vết, `db-query` chỉ đọc + mã hoá kết quả | Danh sách người có SSH + quy trình rời đi |
| Ứng cứu sự cố | Không có runbook DLCN. **Đã có một sự cố thật**: `docs/security-2026-09-24-ops-log-leak.md` — log GitHub Actions của kho PUBLIC trước ngày sửa **có thể** đã chứa dữ liệu khách và secret (log giữ 90 ngày) | **Runbook 72 giờ** (dưới); **luật sư đánh giá sự cố 24/09 có thuộc diện phải thông báo theo Luật 91 / NĐ 356 không** (G) |

**Runbook sự cố lộ DLCN (khung, để luật sư điền thời hạn theo NĐ 356 Điều 28–29):** T+0 phát hiện → ghi `platform_audit_log`
`INCIDENT_OPEN` (không ghi dữ liệu người) · T+1h phân loại (loại dữ liệu, số chủ thể, tổ chức bị ảnh hưởng, có dữ liệu
nhạy cảm / vị trí / sinh trắc không) · T+4h cô lập (thu hồi token, xoay secret, chặn IP) · T+24h thông báo khách thuê bị
ảnh hưởng (Chính sách §10) · **≤ 72h** thông báo Bộ Công an theo mẫu NĐ 356 nếu thuộc diện (luật sư xác định ngưỡng) ·
T+7d báo cáo sau sự cố · bằng chứng lưu ≥ 24 tháng.

## 14. Phân loại thương mại điện tử

| Câu hỏi | Phân tích | Kết luận |
|---|---|---|
| chotdontudong.com / vnxcommerce.com có là «nền tảng TMĐT kinh doanh trực tiếp có chức năng đặt hàng trực tuyến»? | Trang `/pricing` → `/start` → chọn gói → mã chuyển khoản + VietQR → tiền về → kích hoạt (`docs/platform/billing.md`). Người mua là tổ chức (B2B) nhưng cũng có hộ kinh doanh / cá nhân. Giao dịch hoàn tất trên nền tảng của VNX | **Khả năng cao phải THÔNG BÁO** với Bộ Công Thương qua Cổng DVC quốc gia — **G xác nhận** |
| Thương mại của khách thuê diễn ra ở đâu | Trên Facebook / Zalo (kênh ngoài) **và** trên chat web `<tên>.erp.vnxcommerce.com/chat` do VNX host, nơi khách hàng cuối đặt hàng qua bot | Phần chat web có thể khiến VNX bị coi là nền tảng **trung gian** (phải ĐĂNG KÝ, nghĩa vụ nặng hơn: NĐ 248 Điều 18, 26). **Không tự phân loại** — G |
| Nghĩa vụ công bố | Chủ sở hữu, giá, điều kiện giao dịch, chính sách bảo vệ thông tin cá nhân | Đã có: `COMPANY`, `/pricing`, `/dieu-khoan-su-dung`, `/chinh-sach-bao-mat`. Thiếu: chính sách khiếu nại, quy trình giải quyết tranh chấp riêng, thông tin trên host chotdontudong.com (kiểm `lib/platform/site-host.ts::SITE_LEGAL_PATHS`) |
| Checklist nộp (nếu áp dụng) | Tài khoản DVC quốc gia của doanh nghiệp · GĐKDN · tên miền + chủ thể tên miền · mẫu thông báo · chính sách đã công bố · nhân sự TMĐT chuyên trách (NĐ 248 Điều 26) | D |

## 15. Thanh toán, thuế, hoá đơn, chống spam

**Số dư AI (`docs/saas/AI_BALANCE_V1.md`)**: nạp qua chuyển khoản vào **tài khoản ngân hàng của công ty** (SePay chỉ đối
soát sao kê, không giữ tiền — xác nhận hợp đồng SePay); trừ theo khách AI vượt gói; dòng `REFUND` chỉ hoàn tiền thật khi
ngừng dịch vụ; **không rút tiền, không chuyển giữa khách, không mua hàng bên thứ ba, không gọi là ví**. ⇒ Khớp kiến trúc
«SERVICE CREDIT ONLY». NĐ 52/2024: ví điện tử = nạp + rút + thanh toán cho bên thứ ba; thu hộ chi hộ = xử lý thanh toán
cho khách có tài khoản. Số dư AI không có hai đặc tính đó ⇒ **có cơ sở để không coi là trung gian thanh toán — G xác
nhận bằng văn bản**. Điều phải giữ bất biến (bài kiểm): không có đường `WITHDRAW`, `TRANSFER`, `PAY_THIRD_PARTY` trong
`platform_ai_ledger_entries` (`db/schema.ts:5342`, ràng buộc dấu `platform_ai_ledger_entries_sign_check`).

**Thuế / hoá đơn:** `tax_mode = 'UNDECLARED'` trên phiên bản giá (`platform_price_versions`); thông tin xuất hoá đơn khách
khai và chụp vào hoá đơn (`billing.md` §8); ERP **không** phát hành hoá đơn điện tử. Khoảng trống: (a) danh mục thuế có
cấu hình (không chịu thuế GTGT theo khoản 21 Điều 5 Luật 48/2024 **nếu** là dịch vụ phần mềm — kế toán quyết; phần AI theo
lượt có là «dịch vụ phần mềm» không — **E + G**); (b) thời điểm lập hoá đơn cho tiền nạp trước (NĐ 70/2025) — E; (c) bằng
chứng sẵn-sàng-hoá-đơn cho: thuê bao, phần vượt, nạp, chiết khấu, hoàn, dùng thử, nâng / hạ gói — có sổ
`platform_invoices`, `platform_billing_payments`, `platform_ai_ledger_entries`, `platform_price_pins` (truy vết giá);
thiếu: mã danh mục thuế trên từng dòng, liên kết dòng sổ ↔ số hoá đơn điện tử; (d) tích hợp nhà cung cấp hoá đơn điện tử
khi chủ sở hữu chọn (AGENTS §7: dịch vụ ngoài mới phải hỏi).

**Chống spam / tiếp thị:** follow-up Messenger của bot (`followup.ts`, theo cửa sổ 24 giờ của Meta?) · gửi hàng loạt
`/outreach/broadcast` (ERP nhà, qua Pancake Pages) · săn khách sỉ từ Google Places rồi nhắn Zalo / gọi (`lib/wholesale/*`)
· OTP ZNS (giao dịch). Phải tách **giao dịch / dịch vụ** (OTP, xác nhận đơn, trạng thái giao) khỏi **quảng cáo** (gợi mua
lại, broadcast, sỉ). NĐ 91/2020: quảng cáo qua SMS / email / gọi cần đồng ý trước + DoNotCall + từ chối; Messenger / Zalo
theo chính sách nền tảng + Luật 91. Hôm nay: không có sổ đồng ý tiếp thị, không có opt-out ghi nhận, broadcast không có
trần theo đồng ý ⇒ P1, và **không được xây thêm tự động hoá gửi hàng loạt không giới hạn**.

## 16. Bộ văn bản pháp lý — trạng thái

| # | Văn bản | Hôm nay | Việc |
|---|---|---|---|
| 1 | Điều khoản dịch vụ SaaS | **1.1 công bố** `/dieu-khoan-su-dung`; nháp gốc `terms-of-service.md`; chưa luật sư | G rà; thêm AI, DPA tham chiếu, khiếu nại |
| 2 | Chính sách quyền riêng tư | **1.1 công bố** `/chinh-sach-bao-mat`; chưa luật sư; chưa nêu Telegram / Lark / Zalo / Google Places; thời hạn «theo pháp luật» chưa điền số | G rà + cập nhật §4 bên thứ ba |
| 3 | DPA (Bên Kiểm soát – Bên Xử lý) | **Không có** | Soạn NHÁP: vai trò · chỉ dẫn · mục đích · loại dữ liệu · bảo mật · bên xử lý phụ · xuyên biên giới · lưu / xoá · sự cố · DSR · kiểm tra / hợp tác · chấm dứt (khung ở `DATA_PROCESSING_REGISTER.md` §6). Không tự ký |
| 4 | Danh sách bên xử lý phụ | Một phần trong Chính sách §4 | `SUBPROCESSOR_REGISTER.md` → trang công khai |
| 5 | Chính sách lưu & xoá | Rải ở Điều khoản 7, Chính sách 7–9 | Văn bản riêng + bảng retention theo loại |
| 6 | Chính sách ATTT | `docs/saas/SECURITY.md` (kỹ thuật) | Bản chính thức có chủ sở hữu ký |
| 7 | Thông báo minh bạch AI | **Không có** | Soạn sau OWNER DECISION §11 |
| 8 | Chính sách sử dụng chấp nhận được | Điều 6 Điều khoản | Tách riêng, thêm chống spam, cấm dùng bot lừa dối |
| 9 | Thanh toán / gia hạn / huỷ / hoàn | Điều 4 Điều khoản + `SERVICE_COMMITMENTS` | Thêm Số dư AI (không rút, hoàn khi chấm dứt), thuế |
| 10 | Khiếu nại / hỗ trợ | Điều 12 Điều khoản (liên hệ) | Văn bản riêng: kênh, thời hạn, leo thang |
| 11 | Ứng cứu sự cố | Không có | §13 khung |
| 12 | Quy trình yêu cầu chủ thể dữ liệu | Chính sách §9 (email) | Văn bản riêng + sổ DSR + mẫu NĐ 356 |

Tiếng Việt là bản chính thức hướng tới khách hàng (`docs/legal/README.md` đã theo nguyên tắc này).

## 17. Chấp thuận điện tử

Hôm nay: dòng «Bằng việc tạo cửa hàng, bạn đồng ý…» + phiên bản ghi `ORG_ONBOARDED.after.acceptedTerms`
(`lib/onboarding/service.ts:439`), chỉ cho đăng ký công khai. Thiếu: hash nội dung văn bản, IP / thiết bị, tài khoản
người bấm (đăng ký tạo tổ chức thì có), thời điểm riêng, đồng ý lại khi đổi phiên bản (README mục 4 đã dự kiến), tải bản
đã chấp thuận. Đặc tả bảng `platform_legal_acceptances` ở `TECH_HANDOFF_LEGAL.md` M-ACCEPT.

## 18. `/platform/compliance` — đặc tả màn hình

Mười lăm ô, mỗi ô một trong năm trạng thái: COMPLIANT · ACTION REQUIRED · PENDING AUTHORITY · COUNSEL REVIEW · UNKNOWN.
Nguồn mỗi ô là **bảng** (không phải hằng số): `platform_compliance_items` (khoá, trạng thái, bằng chứng, người đặt, lý
do, hạn, phiên bản luật). Mặc định của mọi ô khi chưa có dòng: **UNKNOWN**. Không ô nào tự chuyển COMPLIANT bằng mã; chỉ
người vận hành đặt kèm bằng chứng. Danh sách ô: Dữ liệu cá nhân · DPIA · Xuyên biên giới · Bên xử lý phụ · Sổ AI · Rủi ro
AI · Nơi lưu dữ liệu · Bảo mật · TMĐT · Hoá đơn · Văn bản pháp lý · Sự cố · Đồng ý · DSR · Giấy phép / hồ sơ đã nộp.
Mô tả kỹ thuật ở `TECH_HANDOFF_LEGAL.md` M-COMPLIANCE-ADMIN.

## 19. Việc phải làm theo người đóng

### F — OWNER DECISION (chủ sở hữu)
1. Bot có xưng là AI với khách không (Điều 11.1 Luật AI)? Phương án đề xuất §11. Quyết định này đảo quyết định HSLC 05/10.
2. Có tiếp tục gửi tên / SĐT / địa chỉ khách qua Telegram / Lark không, hay thay bằng link mở ERP?
3. Sao lưu ngoài máy: giữ Google Drive (+ hồ sơ xuyên biên giới) hay chuyển về lưu trữ trong nước?
4. Chỉ định bộ phận / nhân sự bảo vệ DLCN (tên, bằng cấp, đào tạo). Nếu theo đuổi Giấy chứng nhận: ≥ 3 nhân sự.
5. Bật OTP SĐT khi đăng ký (NĐ 333) sau khi luật sư xác nhận phạm vi.
6. Chọn luật sư / hãng luật; ngân sách cho 7 câu hỏi §19.G.
7. Chọn nhà cung cấp hoá đơn điện tử; chốt cách xử lý thuế với kế toán.
8. `PLATFORM_SIGNUP_MODE`: đang `open` trong khi quyết định 08/10 là «đăng ký lại khi sẵn sàng» — đóng hay giữ?
9. Xác nhận bên ký hợp đồng VPS (Vietnix hay VNPT) — Chính sách 1.1 đang công bố VNPT.
10. Số ngày dùng thử: mã `TRIAL_DAYS = 7` (`lib/billing/rules.ts:166`) nhưng `docs/legal/README.md:23` và quyết định
    04/10 ghi 14 ngày — cái nào đúng? Điều khoản công bố phải khớp mã.
11. Cam kết «báo trước 15 ngày qua email» (`SERVICE_COMMITMENTS.deletionNoticeDays`) trong khi **hệ thống không có kênh
    email nào** — chọn kênh (Zalo / trong app) hoặc thêm email (dịch vụ ngoài mới, AGENTS §7).

### G — LEGAL COUNSEL REQUIRED (gửi luật sư, nhận văn bản có viện dẫn)
1. Chốt Đơn Tự Động có thuộc «kinh doanh dịch vụ xử lý DLCN» (NĐ 356 Điều 21) không? Nếu có: lộ trình xin Giấy chứng nhận
   và việc được / không được cung cấp dịch vụ trong lúc chờ.
2. VNX có được hưởng hoãn 5 năm (DPIA, bộ phận BVDLCN) không — xác định quy mô doanh nghiệp theo luật hỗ trợ DNNVV và
   ngưỡng «số lượng lớn».
3. Nghĩa vụ hồ sơ chuyển xuyên biên giới thuộc Bên Kiểm soát (khách thuê), Bên Xử lý (VNX) hay cả hai; dữ liệu mã hoá
   (Drive) có là chuyển DLCN không.
4. Luật AI: ngoại lệ của Điều 11.1; mức rủi ro; Điều 35 có áp cho bot ra mắt sau 01/03/2026 không; nghĩa vụ thông báo cơ
   quan ở mức trung bình.
5. NĐ 333: SaaS B2B có thuộc đối tượng xác thực tài khoản bằng SĐT và lưu 24 tháng không; mốc tính.
6. TMĐT: thông báo hay đăng ký; chat web do VNX host có làm VNX thành nền tảng trung gian không.
7. Số dư AI không phải trung gian thanh toán / ví điện tử (NĐ 52/2024) — xác nhận; điều kiện hoàn tiền.
8. Căn cứ xử lý không cần đồng ý cho nhóm A (thực hiện hợp đồng) và nhóm D (nhật ký, bảo mật) theo Luật 91.
9. Rà 12 văn bản §16.

### D — GOVERNMENT FILING (chỉ làm sau khi G trả lời)
1. Hồ sơ đánh giá tác động xử lý DLCN — Bộ Công an, Mẫu 10 (trừ khi được hoãn).
2. Hồ sơ đánh giá tác động chuyển xuyên biên giới — Bộ Công an, Mẫu 09 (X1–X5).
3. Giấy chứng nhận đủ điều kiện kinh doanh dịch vụ xử lý DLCN — Bộ Công an, Mẫu 05 (nếu áp dụng).
4. Thông báo / đăng ký nền tảng TMĐT — Bộ Công Thương qua Cổng DVC quốc gia (nếu áp dụng).
5. Thông báo hệ thống AI (nếu nghị định hướng dẫn Luật AI đòi).
**Chưa hồ sơ nào được nộp. Không được ghi khác đi.**

### E — ACCOUNTING / TAX
1. Phân loại thuế GTGT cho thuê bao và phần AI theo lượt; mã danh mục thuế cấu hình vào `platform_price_versions`.
2. Thời điểm lập hoá đơn cho tiền nạp Số dư AI; hạch toán doanh thu chưa thực hiện.
3. Chọn nhà cung cấp hoá đơn điện tử; quy trình xuất khi khách tích «Xuất hoá đơn VAT».

### U — BLOCKED / UNKNOWN
| Mục | Vì sao chưa biết | Cách gỡ |
|---|---|---|
| Vùng xử lý Gemini API | Google không công bố vùng cho `generativelanguage` | Hỏi Google Cloud; cân nhắc Vertex AI `asia-southeast1` |
| Vùng Meta / Telegram / Lark / Drive | Không đoán | Đọc DPA / điều khoản từng bên, ghi vào `SUBPROCESSOR_REGISTER.md` |
| Phạm vi NĐ 333 | Bản tóm tắt mâu thuẫn | G-5 |
| Danh mục AI rủi ro cao | Chưa tìm thấy quyết định Thủ tướng | Theo dõi; G-4 |
| SaaS + AI có là «dịch vụ phần mềm» | Định nghĩa mới từ 01/01/2026 (NĐ 353/2025) | E-1 + G |
| Số nhân sự đủ điều kiện | Chưa khai | F-4 |
| Ghi âm khách có là DLCN nhạy cảm | NĐ 356 mở rộng nhạy cảm (dữ liệu theo dõi hành vi, sử dụng mạng xã hội) | G |

## 20. Nguyên tắc làm việc (giữ nguyên từ brief)

Không chạm mã production ở Phase 1. Phase 2: handoff (`TECH_HANDOFF_LEGAL.md`). Phase 3: Tech Lead cắt mission nhỏ, không
mega PR. Không kết luận pháp lý thiếu nguồn. Không bịa yêu cầu. Không ghi «đã nộp» khi chưa nộp.
