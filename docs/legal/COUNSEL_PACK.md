# GÓI CÂU HỎI GỬI LUẬT SƯ — CHỐT ĐƠN TỰ ĐỘNG

**Bên yêu cầu:** Công ty cổ phần VNXcommerce · MST 0109872760 · Tầng 3, Tòa nhà Gold Season, 47 Nguyễn Tuân, Thanh Xuân, Hà Nội
**Ngày:** 09/10/2026 · **Trạng thái:** WAITING_FOR_LEGAL_COUNSEL
**Cần từ luật sư:** văn bản trả lời có viện dẫn điều khoản, theo mẫu YES / NO / CONDITIONS ở cuối mỗi câu hỏi.

> Tài liệu này mô tả sự thật kỹ thuật và kinh doanh, không phải ý kiến pháp lý. Số điều của Nghị định 356/2025/NĐ-CP
> được đọc qua bản tóm tắt của trang pháp luật, chưa đối chiếu bản ký. Xin luật sư đối chiếu bản gốc.

## 0. Sản phẩm trong một trang

**Mô hình kinh doanh.** VNXcommerce bán phần mềm thuê bao «Chốt Đơn Tự Động» cho cửa hàng bán lẻ (thường là hộ kinh
doanh hoặc doanh nghiệp nhỏ bán qua Facebook). Cửa hàng trả phí tháng hoặc năm.

| Gói | Giá tháng |
|---|---|
| INBOX (không có AI) | 299.000 ₫ |
| STARTER | 790.000 ₫ |
| GROWTH | 1.490.000 ₫ |
| SCALE | 2.990.000 ₫ |
| ENTERPRISE | từ 5.990.000 ₫ |

Phí tính theo số «khách được AI trả lời» trong kỳ. Phần vượt gói trừ vào «Số dư AI» cửa hàng nạp trước bằng chuyển
khoản. Số dư AI không rút được và không chuyển được sang cửa hàng khác. Thanh toán chỉ bằng chuyển khoản theo mã QR
vào tài khoản ngân hàng của công ty. Không nhận thẻ, không dùng cổng thanh toán.

**Chức năng.** Cửa hàng nối Fanpage Facebook (hoặc Zalo OA, hoặc ô chat trên trang web do VNX cung cấp). Khi người mua
nhắn tin, phần mềm:
1. nhận tin qua webhook của Meta;
2. gửi nội dung hội thoại, tên Facebook, ảnh người mua gửi, và nếu là khách cũ thì cả tên, SĐT, địa chỉ, đơn cũ, tới
   mô hình AI của Google (Gemini) để soạn câu trả lời;
3. gửi câu trả lời lại cho người mua qua Messenger, dưới danh nghĩa Fanpage của cửa hàng;
4. khi người mua đưa SĐT và địa chỉ, tạo đơn hàng trong phần mềm của cửa hàng;
5. báo đơn mới (tên, SĐT, địa chỉ, món) vào nhóm Telegram, Lark hoặc Zalo của cửa hàng.

Nhân viên cửa hàng có thể tiếp quản bất kỳ hội thoại nào, và khi đó bot im lặng.

**Dữ liệu được lưu ở đâu.**
- Mỗi cửa hàng có một cơ sở dữ liệu riêng, trên một máy chủ ảo đặt tại Việt Nam. Tài liệu nội bộ ghi nhà cung cấp là
  Vietnix, còn chính sách công bố ghi VNPT. Công ty đang xác nhận bên ký hợp đồng.
- Bản sao lưu được mã hoá trên máy chủ rồi mới tải lên Google Drive. Google chỉ thấy dữ liệu đã mã hoá.
- Hội thoại, hồ sơ người mua và đơn hàng được giữ trong suốt thời gian thuê. Chưa có lịch xoá tự động.

**Quy mô.** Đang có một số cửa hàng chạy thật, trong đó một cửa hàng hải sản dùng bot hằng ngày từ đầu tháng
10/2026. Số người mua (chủ thể dữ liệu) chưa đo. Kỹ thuật đo được trong một ngày khi luật sư cần.

**Văn bản đã công bố.** Chính sách quyền riêng tư 1.1 và Điều khoản sử dụng 1.1, hiệu lực 04/10/2026. Cả hai chưa qua
luật sư. Người đăng ký đồng ý bằng một dòng chữ trên nút «Tạo cửa hàng», và phiên bản văn bản được ghi vào nhật ký.

---

## Câu hỏi 1 — VNXcommerce có đang «kinh doanh dịch vụ xử lý dữ liệu cá nhân» không?

**Văn bản liên quan**
- Nghị định 356/2025/NĐ-CP:
  - Điều 21: chín loại hình dịch vụ, trong đó có «cung cấp hệ thống tự động», «xử lý bằng trí tuệ nhân tạo», «thu thập
    từ trang web, mạng xã hội».
  - Điều 22: điều kiện (pháp nhân Việt Nam; người đứng đầu là công dân Việt Nam thường trú; ít nhất 3 nhân sự đủ điều
    kiện; hạ tầng phù hợp; hồ sơ đánh giá tác động đạt).
  - Điều 24–25: Bộ Công an cấp Giấy chứng nhận, thẩm định 30 ngày.
- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15, quy định chuyển tiếp: doanh nghiệp nhỏ và khởi nghiệp được hoãn 5 năm
  nghĩa vụ đánh giá tác động và bộ phận bảo vệ dữ liệu, **trừ** bên kinh doanh dịch vụ xử lý dữ liệu cá nhân, bên xử lý
  dữ liệu nhạy cảm, hoặc bên xử lý số lượng lớn.

**Sự thật liên quan**
- Hai lập luận ngược nhau:
  - Có thể là dịch vụ xử lý: VNX thu tiền để tự động nhận, phân tích bằng AI và trích xuất dữ liệu người mua trên mạng
    xã hội.
  - Có thể chỉ là phần mềm: VNX bán phần mềm, còn cửa hàng quyết định thu gì và dùng làm gì. VNX là Bên Xử lý theo chỉ
    dẫn của cửa hàng (Chính sách 1.1, mục 1).
- VNX đáp ứng điều kiện pháp nhân Việt Nam. Ba điều kiện còn lại chưa có hồ sơ: người đứng đầu, ba nhân sự, hồ sơ đánh
  giá tác động.

**Lựa chọn và tác động tới bán hàng**

| | Lựa chọn | Tác động |
|---|---|---|
| A | Không phải dịch vụ xử lý | Bán ngay khi xong các hồ sơ khác |
| B | Là dịch vụ xử lý | Phải có Giấy chứng nhận trước khi thu tiền; mất ít nhất 30 ngày thẩm định cộng thời gian tuyển nhân sự. Khách hàng cuối không thấy gì khác |

**Cần luật sư xác nhận**

| # | Câu hỏi | YES / NO / CONDITIONS |
|---|---|---|
| 1a | Mô hình trên có thuộc Điều 21 không? Nếu có, mục nào? | |
| 1b | Nếu có: VNX có được tiếp tục phục vụ cửa hàng hiện có trong lúc chờ Giấy chứng nhận không? | |
| 1c | VNX có được hoãn 5 năm (đánh giá tác động, bộ phận bảo vệ dữ liệu) không? Xin xác định quy mô doanh nghiệp và ngưỡng «số lượng lớn» | |
| 1d | Ghi âm giọng nói người mua (chỉ ở bot nội bộ của VNX, không ở sản phẩm bán ra) có phải dữ liệu nhạy cảm không? | |

---

## Câu hỏi 2 — Bot phải cho người mua biết mình là AI đến mức nào?

**Văn bản liên quan**
- Luật Trí tuệ nhân tạo 134/2025/QH15, hiệu lực 01/03/2026:
  - Điều 3: định nghĩa nhà cung cấp (khoản 4) và bên triển khai (khoản 5). VNX là nhà cung cấp; cửa hàng là bên triển
    khai.
  - Điều 11 khoản 1: hệ thống AI tương tác trực tiếp với con người phải được thiết kế để người dùng **nhận biết được**
    mình đang tương tác với AI, trừ khi pháp luật quy định khác.
  - Điều 7: cấm che giấu thông tin bắt buộc.
  - Điều 9: hệ thống «có khả năng gây nhầm lẫn» là rủi ro trung bình.
  - Điều 35: hệ thống vận hành trước 01/03/2026 có 12 tháng chuyển tiếp.
- Nghị định 356/2025/NĐ-CP Điều 10 (theo bản tóm tắt): xử lý tự động phải thông báo, giải thích nguyên tắc, và cho chủ
  thể quyền không tham gia.

**Sự thật liên quan**
- Hôm nay bot **không** cho người mua biết mình là AI:
  - lời nhắc hệ thống bảo bot đóng vai «nhân viên bán hàng»;
  - tin nhắc lại tự động được dặn «không nhắc rằng mình là AI»;
  - trang chat web chỉ ghi «Chat với {tên bot}».
- Đây là quyết định kinh doanh cũ, nhằm giữ cảm giác mua hàng tự nhiên.
- Bot ra mắt sau 01/03/2026, nên có thể không được hưởng thời gian chuyển tiếp 12 tháng.
- Người mua có thể nhắn để gặp nhân viên. Bot có công cụ chuyển sang người.

**Lựa chọn và tác động tới bán hàng**

| | Cách công bố | Tác động |
|---|---|---|
| A | **Chỉ ở giao diện.** Tên hiển thị «Trợ lý AI», lời chào của Fanpage và tiêu đề ô chat ghi «Trợ lý AI của {shop}». Không thêm chữ vào hội thoại. Lời chào Messenger không hiện với người tới từ quảng cáo hoặc bình luận | Không có |
| B | **A, cộng một dòng.** Câu trả lời đầu tiên của hội thoại mới mở bằng «Trợ lý AI của {shop} hỗ trợ anh/chị ngay đây ạ 😊». Một lần, không tách tin riêng, không lặp lại. Khi bị hỏi thẳng «máy hay người», bot trả lời thật. **Đây là phương án chủ sở hữu chọn** | Thấp, chưa đo |
| C | Câu dài, lặp lại, hoặc kiểu «tôi không phải con người» | Trung bình đến cao. Không đề xuất |

**Cần luật sư xác nhận**

| # | Câu hỏi | YES / NO / CONDITIONS |
|---|---|---|
| 2a | Phương án A một mình có đủ «nhận biết được» theo Điều 11 khoản 1 không? | |
| 2b | Phương án B có đủ không? Câu chữ có phải theo mẫu nào không? | |
| 2c | Bot ra mắt sau 01/03/2026 có được hưởng Điều 35 không? | |
| 2d | Bot bán hàng có thuộc rủi ro trung bình không? Có phải thông báo cơ quan nào không? | |
| 2e | Điều 10 Nghị định 356 có áp cho bot bán hàng không? Nếu có, quyền «gặp nhân viên» có đủ là quyền không tham gia không? | |
| 2f | Trách nhiệm công bố thuộc VNX (nhà cung cấp), cửa hàng (bên triển khai), hay cả hai? | |

---

## Câu hỏi 3 — Chuyển dữ liệu cá nhân ra nước ngoài: ai phải nộp hồ sơ, cho những đường nào?

**Văn bản liên quan**
- Nghị định 356/2025/NĐ-CP Điều 18: hồ sơ đánh giá tác động chuyển dữ liệu ra nước ngoài, Mẫu 09, nộp Bộ Công an trong
  60 ngày kể từ khi bắt đầu chuyển.
- Luật Bảo vệ dữ liệu cá nhân Điều 8: phạt tới 5 % doanh thu năm trước nếu vi phạm quy định chuyển xuyên biên giới.
- Luật An ninh mạng 116/2025/QH15 Điều 25 khoản 3 và Nghị định 333/2026/NĐ-CP: lưu dữ liệu người dùng tại Việt Nam.

**Các đường đang chuyển ra nước ngoài.** Vùng xử lý của tất cả các bên dưới đây công ty chưa xác định.

| # | Bên nhận | Dữ liệu | Ghi chú |
|---|---|---|---|
| 1 | Google (Gemini API) | Nội dung hội thoại, tên Facebook, ảnh người mua; với khách cũ: tên, SĐT, địa chỉ, đơn cũ | Đang chạy hằng ngày. Có thể đổi sang Google Vertex AI đặt tại Singapore |
| 2 | Google Drive | Toàn bộ cơ sở dữ liệu, đã mã hoá trước khi tải lên | Google không có khoá giải mã |
| 3 | Telegram (có thể qua Cloudflare) | Tên, SĐT, địa chỉ, món của đơn mới | Gửi vào nhóm của cửa hàng |
| 4 | Lark | Cảnh báo; một số mẫu tin có tên và SĐT | |
| 5 | Meta (Messenger) | Tin nhắn hai chiều | Bản chất của kênh: dữ liệu sinh ra tại Meta |

**Lựa chọn và tác động tới bán hàng**

| | Lựa chọn | Tác động |
|---|---|---|
| A | Giữ nguyên cả năm đường, lập hồ sơ Mẫu 09 cho từng đường | Không có |
| B | Thu hẹp: báo đơn chuyển sang Zalo Bot (trong nước); AI chuyển sang vùng xác định; sao lưu ngoài máy chuyển về kho trong nước | Người mua không thấy gì. Vận hành kho có ảnh hưởng nhẹ khi đổi kênh báo đơn. Tốn chi phí kỹ thuật |

**Cần luật sư xác nhận**

| # | Câu hỏi | YES / NO / CONDITIONS |
|---|---|---|
| 3a | Hồ sơ Mẫu 09 do ai nộp: cửa hàng (Bên Kiểm soát), VNX (Bên Xử lý), hay cả hai? | |
| 3b | Gọi API AI (dữ liệu chỉ đi qua để xử lý) có tính là chuyển xuyên biên giới không? | |
| 3c | Sao lưu đã mã hoá, bên nhận không có khoá, có tính không? | |
| 3d | Meta (kênh do người mua tự chọn) có tính không? | |
| 3e | Hạn 60 ngày tính từ ngày nào, khi bot đã chạy từ đầu tháng 10/2026? | |
| 3f | Nghị định 333 có buộc VNX lưu dữ liệu tối thiểu 24 tháng, lưu nhật ký 12 tháng, và xác thực tài khoản bằng SĐT không? | |

---

## Sự cố 24/09/2026 — có phải thông báo cơ quan không?

Câu này đứng riêng vì nếu có nghĩa vụ thông báo thì hạn có thể đã qua. Hồ sơ nội bộ:
`docs/security-2026-09-24-ops-log-leak.md`.

**Chuyện gì đã xảy ra**
- Kho mã nguồn của công ty trên GitHub để **công khai**. Nhật ký các lượt chạy công cụ vận hành cũng công khai, ai cũng
  đọc được không cần đăng nhập, và GitHub giữ 90 ngày.
- Từ 04/09/2026 tới ngày sửa 24/09/2026, công cụ tra cứu cơ sở dữ liệu in thẳng kết quả ra nhật ký đó.
- Theo đọc mã nguồn (công ty **chưa** tải lại nhật ký cũ để xác nhận), nhật ký **có thể** đã chứa:
  - tên, SĐT, địa chỉ người mua;
  - email nhân viên; lương, hoa hồng kèm tên nhân viên;
  - nội dung sao kê ngân hàng của công ty;
  - một số khoá bí mật (webhook Lark, token bot Telegram).
- Riêng mã nguồn: 18 SĐT người mua từng được ghi cứng trong một tệp. Ngày 25/09 đã gỡ khỏi bản hiện hành, nhưng vẫn còn
  trong lịch sử công khai của kho (chủ sở hữu quyết không viết lại lịch sử).

**Đã làm:** từ 24/09 kết quả tra cứu được mã hoá trước khi ra nhật ký; nhật ký chỉ còn con số đếm; công cụ tra cứu chỉ
còn quyền đọc.

**Chưa xác nhận:** nhật ký cũ đã được xoá chưa; khoá bí mật đã được đổi chưa; có ai ngoài công ty đã đọc nhật ký không
(GitHub không cho biết).

| # | Câu hỏi | YES / NO / CONDITIONS |
|---|---|---|
| 4a | Đây có phải «vi phạm dữ liệu cá nhân» phải thông báo theo Luật 91/2025 và Nghị định 356/2025 (Điều 28–29) không, khi chưa xác nhận có người ngoài đã đọc? | |
| 4b | Nếu phải: thông báo cho ai (Bộ Công an, cửa hàng bị ảnh hưởng, người mua), và hạn tính từ 24/09 hay từ ngày xác nhận? | |
| 4c | 18 SĐT còn trong lịch sử kho công khai: có buộc phải viết lại lịch sử để gỡ không? | |
| 4d | Thông báo muộn bây giờ có lợi hơn hay hại hơn so với không thông báo? | |

---

## Câu hỏi phụ (cùng đợt nếu tiện; không phải ba câu chặn chính)

| # | Câu hỏi |
|---|---|
| P1 | Trang web bán gói phần mềm (đăng ký và chuyển khoản theo mã) có phải thông báo nền tảng thương mại điện tử với Bộ Công Thương không? Ô chat do VNX cung cấp cho người mua của cửa hàng có làm VNX thành nền tảng trung gian không? (Luật Thương mại điện tử 122/2025, Nghị định 248/2026) |
| P2 | Số dư AI (nạp trước, chỉ dùng cho dịch vụ AI, không rút, không chuyển, hoàn khi ngừng dịch vụ) có phải ví điện tử hay trung gian thanh toán theo Nghị định 52/2024 không? |
| P3 | Thoả thuận xử lý dữ liệu đặt làm phụ lục Điều khoản, đồng ý một lần khi đăng ký, có đủ giá trị không? |
| P4 | Rà Chính sách quyền riêng tư 1.1 và Điều khoản 1.1 đã công bố |

## Hồ sơ phải nộp nếu câu trả lời là YES

| Nếu | Hồ sơ | Nơi nộp | Hạn |
|---|---|---|---|
| 1a = YES | Đơn đề nghị Giấy chứng nhận (Mẫu 05), Giấy chứng nhận đăng ký doanh nghiệp, văn bản chỉ định bộ phận bảo vệ dữ liệu, đề án hoạt động, bằng cấp và lý lịch của ít nhất 3 nhân sự | Bộ Công an | Trước khi cung cấp dịch vụ; thẩm định 30 ngày |
| 1c = NO | Hồ sơ đánh giá tác động xử lý dữ liệu (Mẫu 10) và văn bản chỉ định bộ phận bảo vệ dữ liệu | Bộ Công an | 60 ngày kể từ khi xử lý |
| 3a có VNX | Hồ sơ đánh giá tác động chuyển dữ liệu ra nước ngoài (Mẫu 09), cho mỗi đường thuộc diện | Bộ Công an | 60 ngày kể từ khi chuyển |
| 4a = YES | Thông báo vi phạm dữ liệu cá nhân (mẫu theo Nghị định 356) | Bộ Công an; cửa hàng bị ảnh hưởng | Theo câu trả lời 4b |
| 2d = phải thông báo | Theo nghị định hướng dẫn Luật Trí tuệ nhân tạo (chưa thấy ban hành) | Chưa rõ | Chưa rõ |
| P1 = YES | Thông báo hoặc đăng ký nền tảng thương mại điện tử | Bộ Công Thương, qua Cổng Dịch vụ công quốc gia | Trước khi hoạt động |
| P2 = YES | Giấy phép trung gian thanh toán, hoặc thiết kế lại Số dư AI | Ngân hàng Nhà nước | Trước khi thu tiền nạp |

## Bằng chứng kỹ thuật đã có

Tất cả nằm trong kho mã của công ty, thư mục `docs/legal/`, gửi kèm khi luật sư cần.

| Bằng chứng | Nội dung |
|---|---|
| Sổ xử lý dữ liệu | 17 loại dữ liệu: chủ thể, mục đích, vai trò, nơi lưu, chuyển ra nước ngoài, cách xoá |
| Sơ đồ luồng dữ liệu | Năm luồng, từng bước, chỉ tới vị trí trong mã nguồn |
| Sổ bên xử lý phụ | 30 bên ngoài mà phần mềm gửi hoặc nhận dữ liệu |
| Khung thoả thuận xử lý dữ liệu | 12 điều, để luật sư soạn bản chính |
| Bảng phân loại tuân thủ | Mỗi yêu cầu được phân loại bắt buộc hay khuyến nghị, kèm tác động tới bán hàng |
| Cô lập dữ liệu | Mỗi cửa hàng một cơ sở dữ liệu; có kiểm thử tự động chống truy cập chéo |
| Mã hoá | Token kết nối mã hoá AES-256-GCM; mật khẩu chỉ lưu dạng băm; sao lưu mã hoá trước khi rời máy chủ |
| Nhật ký thao tác | Thao tác quan trọng ghi kèm tài khoản; mỗi lần nhân viên VNX xem dữ liệu cửa hàng đều ghi lại |
| Quyền của cửa hàng với dữ liệu | Cửa hàng tự xuất dữ liệu ra CSV; xoá cả cửa hàng có chạy thử và từ chối nếu còn sổ tiền |
| Quy trình viết sẵn | Đáp yêu cầu của người có dữ liệu (tiếp nhận, xác minh, giữ chứng từ kế toán); xử lý sự cố dữ liệu (phân loại, khoanh vùng, quyết định thông báo) |
| Không theo dõi bên thứ ba | Trang web không có Google Analytics, Meta Pixel hay công cụ tương tự |
| Văn bản đã công bố | Chính sách quyền riêng tư 1.1 và Điều khoản 1.1, phiên bản người đăng ký đồng ý được ghi lại |

## Còn thiếu

| Việc | Ai làm |
|---|---|
| Vùng xử lý và điều khoản dữ liệu của Google (Gemini, Drive), Meta, Telegram, Lark, Cloudflare | Công ty hỏi từng bên; luật sư đọc |
| Số cửa hàng đang chạy và số người mua có dữ liệu | Kỹ thuật đo khi luật sư cần (1 ngày) |
| Bên ký hợp đồng máy chủ: Vietnix hay VNPT | Chủ sở hữu |
| Người đứng đầu và nhân sự bảo vệ dữ liệu | Chủ sở hữu |
| Bản chính thoả thuận xử lý dữ liệu | Luật sư |
| Con số thời hạn trong quy trình đáp yêu cầu của người có dữ liệu và quy trình sự cố (khung đã có, chỗ số đang để trống) | Luật sư chốt, kỹ thuật điền |
| Cách xuất hoá đơn và thuế suất cho thuê bao và phần AI | Kế toán |
| Chưa có hồ sơ nào được nộp cho cơ quan nhà nước | — |
