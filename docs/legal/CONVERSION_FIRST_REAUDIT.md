# RÀ LẠI THEO NGUYÊN TẮC «TUÂN THỦ ĐÚNG LUẬT, MA SÁT THẤP NHẤT» — OWNER OVERRIDE 08/10/2026

> Chủ sở hữu ghi đè Phase 1 / 2: tuân thủ đúng yêu cầu pháp luật với ma sát thương mại thấp nhất; không biến
> RECOMMENDED / OPTIONAL thành chốt chặn; không thêm popup · checkbox · cảnh báo lặp · bước xác nhận vào hội thoại bán hàng
> hay luồng đơn nếu luật không bắt buộc đúng chỗ đó. Tệp này rà lại **từng mục** của `LEGAL_LAUNCH_GATE.md` và
> `TECH_HANDOFF_LEGAL.md`; hai tệp đó đã được sửa theo kết luận ở đây. `VIETNAM_LEGAL_COMPLIANCE.md` giữ nguyên phần
> phân tích luật (nó không đề xuất ma sát), chỉ sửa §11 (thiết kế công bố AI).
>
> Thang: **MANDATORY** (có điều luật cụ thể, đã đọc) · **COUNSEL** (chưa đủ chắc) · **RECOMMENDED** (thực hành tốt) ·
> **OPTIONAL**. Tác động chuyển đổi: **NONE / LOW / MEDIUM / HIGH** đo trên reply rate · lead→đơn · hoàn tất đơn · AOV ·
> tốc độ chốt · niềm tin. Luật ghi đè: RECOMMENDED / OPTIONAL + MEDIUM / HIGH ⇒ **DEFER**; MANDATORY + MEDIUM / HIGH ⇒
> **thiết kế lại** cho ma sát thấp trước khi giao Tech Lead.

## 1. Bảng rà lại — LEGAL-P0 cũ

| # | Mục | Phân loại | Căn cứ | Tác động chuyển đổi | Kết luận | Thiết kế ma sát thấp nhất |
|---|---|---|---|---|---|---|
| P0-1 | Phân loại dịch vụ xử lý DLCN + Giấy chứng nhận | **COUNSEL** (nếu áp dụng ⇒ MANDATORY, là giấy phép) | NĐ 356 Điều 21–25 | NONE (pháp nhân, không chạm khách) | **GIỮ P0** — đúng luật của brief: giấy phép bắt buộc chưa rõ thì không READY | Không có việc kỹ thuật; chỉ câu hỏi luật sư G-1 |
| P0-2 | DPIA lập + nộp | **MANDATORY** trừ khi được hoãn (COUNSEL về hoãn 5 năm) | Luật 91; NĐ 356 Điều 19 | NONE (hồ sơ nội bộ) | **GIỮ P0** | Bằng chứng kỹ thuật đã có; không bước nào hướng tới khách |
| P0-3 | Hồ sơ chuyển xuyên biên giới + vùng xử lý | **MANDATORY** | NĐ 356 Điều 18; Luật 91 Điều 8 | NONE với khách hàng cuối; vận hành kho MEDIUM nếu che SĐT trong tin Telegram | **GIỮ P0**, nhưng tách: hồ sơ là bắt buộc; **che SĐT trong tin đơn KHÔNG bắt buộc** — có thể giữ nguyên tin đầy đủ và đưa Telegram / Lark vào hồ sơ chuyển xuyên biên giới, hoặc chuyển tin đơn sang Zalo Bot (trong nước) | Phương án A (ít đổi nhất): giữ tin đầy đủ, liệt kê Telegram + Cloudflare + Lark trong hồ sơ Điều 18. Phương án B: tin đơn đi Zalo Bot, Telegram chỉ cảnh báo kỹ thuật. Chủ sở hữu chọn; M-ALERT-MINIMIZE hạ xuống OPTIONAL |
| P0-4 | Minh bạch AI | **MANDATORY** | Luật AI 134/2025 Điều 11.1 (đọc toàn văn); Điều 7 cấm che giấu thông tin bắt buộc | **MEDIUM nếu làm sai** (disclaimer dài, lặp, giọng máy) · **LOW** nếu một dòng tự nhiên | **GIỮ P0 — THIẾT KẾ LẠI** (§3) | Một dòng ngắn, giọng shop, một lần đầu hội thoại; tên hiển thị bot; không lặp; không «tôi không phải con người» |
| P0-5 | DPA với khách thuê | **MANDATORY** (hợp đồng Bên Kiểm soát – Bên Xử lý) | Luật 91 (bên xử lý); NĐ 356 | LOW nếu là phụ lục của Điều khoản, chấp thuận cùng một lần; HIGH nếu thêm bước ký riêng | **GIỮ P0 — thiết kế lại**: DPA = Phụ lục Điều khoản, dẫn chiếu, không thêm cú bấm | Không thêm màn hình; một dòng đồng ý hiện có bao trùm cả Điều khoản + Phụ lục DPA + Chính sách |
| P0-6 | Chấp thuận điện tử có bằng chứng (hash · IP · checkbox · đồng ý lại) | Bằng chứng backend: **RECOMMENDED** (gánh nặng chứng minh); checkbox tường minh: **OPTIONAL**; đồng ý lại khi đổi phiên bản: **RECOMMENDED** (Điều khoản §10 tự cam kết) | Luật GDĐT 20/2023 (giá trị pháp lý); Luật BVQLNTD (hợp đồng theo mẫu) — không điều nào đòi checkbox | Checkbox / màn chặn đồng ý lại: **MEDIUM** · ghi sổ backend: NONE | **HẠ XUỐNG P1**; bỏ checkbox và màn chặn; chỉ ghi sổ backend (phiên bản · hash · mốc · IP) | Giữ dòng «Bằng việc tạo cửa hàng…» hiện có; đổi phiên bản ⇒ thông báo trong app, không chặn |
| P0-7 | Nơi lưu dữ liệu tại VN | **MANDATORY** | Luật ANM Điều 25.3 (toàn văn) | NONE | **GIỮ P0** — đã đạt phần chính; chỉ còn câu hỏi bản sao Drive (COUNSEL) + tên nhà cung cấp VPS | Không việc hướng khách |
| P0-8 | Thông báo / đăng ký nền tảng TMĐT | **COUNSEL** | Luật TMĐT 122/2025; NĐ 248 | NONE (hồ sơ) | **GIỮ P0 dạng COUNSEL** (nếu áp dụng là thủ tục bắt buộc trước khi hoạt động) | Chân trang có thông tin chủ sở hữu — đã có `COMPANY` |
| P0-9 | Quy trình sự cố 72 giờ | Nghĩa vụ thông báo: **MANDATORY**; runbook: **RECOMMENDED** (để đáp hạn) | Luật 91; NĐ 356 Điều 28–29 | NONE | **GIỮ P0 ở mức tối thiểu**: một trang runbook + người trực; bảng `platform_incidents` hạ P1 | Tài liệu, không mã |
| P0-10 | Quyền chủ thể dữ liệu (khách hàng cuối) | Đáp ứng yêu cầu trong hạn: **MANDATORY**; công cụ tự phục vụ: **RECOMMENDED** | Luật 91; NĐ 356 (2 / 10 / 15 / 20 ngày) | NONE (không chạm hội thoại) | **GIỮ P0 ở mức quy trình tay** (ops chỉ đọc + script xoá có chạy thử); M-DSR tooling hạ P1 | Không thông báo / popup nào tới khách hàng cuối; yêu cầu đi qua khách thuê |
| P0-11 | Số dư AI ≠ trung gian thanh toán | **COUNSEL** (nếu là ví điện tử ⇒ giấy phép NHNN) | NĐ 52/2024 | NONE | **GIỮ P0 dạng COUNSEL** (thuộc lớp giấy phép) | Bài kiểm bất biến: RECOMMENDED, rẻ, giữ |
| P0-12 | Thuế / hoá đơn | Xuất hoá đơn đúng khi thu tiền: **MANDATORY** (kế toán); bảng danh mục thuế cấu hình: **RECOMMENDED** | NĐ 123/2020 + 70/2025; Luật GTGT 48/2024 | NONE | **GIỮ P0 ở mức kế toán chốt cách xuất** (tay qua nhà cung cấp HĐĐT được); M-TAX-CATEGORY hạ P1 | Không thêm bước ở `/settings/plan` |

## 2. Bảng rà lại — LEGAL-P1 cũ và mission

| # | Mục / mission | Phân loại | Tác động CĐ | Kết luận |
|---|---|---|---|---|
| P1-1 / M-CONSENT | Sổ đồng ý theo mục đích | Đồng ý phải chứng minh được **khi đồng ý là căn cứ** (NĐ 356: đồng ý có ghi nhận) — MANDATORY cho nhóm A nơi dùng đồng ý; với khách hàng cuối, căn cứ chính là hợp đồng mua bán + đồng ý với Page (khách thuê chịu) | Popup đồng ý trong Messenger: **HIGH** · ghi sổ backend: NONE | **GIỮ P1 chỉ phần backend**; **CẤM** popup / câu hỏi đồng ý trong hội thoại; ghi đồng ý tiếp thị khi khách thuê bật follow-up / broadcast (họ là Bên Kiểm soát) |
| P1-2 / M-OPTOUT | Từ chối nhận tin | SMS / email / gọi: **MANDATORY** (NĐ 91) — hệ thống **không có** ba kênh này; Messenger / Zalo: quyền phản đối (Luật 91) + chính sách Meta | Xử lý từ khoá «dừng» ở backend: NONE; bot không gửi câu «nhắn STOP để huỷ»: tránh | **GIỮ P1, backend-only**: nhận ra từ khoá dừng ⇒ tắt follow-up / broadcast cho người đó; không thêm chữ vào tin bán hàng |
| P1-3 / M-AI-REG | Sổ hệ thống AI | RECOMMENDED (Điều 15: giải thích khi cơ quan hỏi) | NONE | GIỮ P1, một tệp hằng số, không UI |
| P1-4 / M-COMPLIANCE-ADMIN | `/platform/compliance` | OPTIONAL | NONE | **HẠ P2** (POST-LAUNCH); tạm dùng chính `LEGAL_LAUNCH_GATE.md` |
| P1-5 / M-LOGIN-LOG | Nhật ký đăng nhập 12 tháng có IP | MANDATORY **nếu** NĐ 333 áp (COUNSEL) | NONE | GIỮ P1; rẻ, làm ngay |
| P1-6 / M-PHONE-AUTH | Xác thực tài khoản bằng SĐT | COUNSEL | **HIGH** nếu OTP trước khi tạo workspace | **DEFER** tới khi luật sư nói bắt buộc; nếu bắt buộc: xác minh SĐT **sau** khi vào workspace (trong 7 ngày dùng thử) hoặc lúc thanh toán đầu — không chặn `/start` |
| P1-7 | Bộ phận bảo vệ DLCN | MANDATORY trừ khi hoãn (COUNSEL) | NONE | GIỮ P1 (C) |
| P1-8 | Chính sách ATTT, MFA người vận hành | RECOMMENDED | NONE | GIỮ P1 (nội bộ) |
| P1-9 | Chính sách khiếu nại | MANDATORY nếu là nền tảng TMĐT (COUNSEL); Luật BVQLNTD đòi tiếp nhận khiếu nại | NONE (một trang) | GIỮ P1 |
| P1-10 / M-RETENTION | Lưu / xoá tự động | Xoá khi hết mục đích: nguyên tắc MANDATORY; tự động hoá: RECOMMENDED | NONE | GIỮ P1 |
| P1-11 | Bằng chứng từng trường của đơn | RECOMMENDED | NONE (backend) — **CẤM** thêm bước xác nhận pháp lý trong luồng đơn | GIỮ P1 theo roadmap sản phẩm; luồng «khách đưa thông tin → máy kiểm → AI xác nhận dữ kiện thương mại → tạo đơn» giữ nguyên |
| P1-12 / M-SUBPROC | Công bố bên thứ ba | Cập nhật Chính sách §4 cho đủ tên: **MANDATORY** (nghĩa vụ thông báo của Luật 91); trang động + bài kiểm hostname: OPTIONAL | NONE | **Tách**: cập nhật Chính sách = P1 làm ngay; trang động = P2 |
| P1-13 / M-TRIAL-CONSISTENCY | Số công bố khớp mã | MANDATORY (thông tin đúng, Luật BVQLNTD) | NONE | GIỮ P1, làm ngay |
| P1-14 / M-PROMPT-MIN | Tối thiểu hoá khối «khách cũ» trong prompt | RECOMMENDED (nguyên tắc tối thiểu hoá) | **MEDIUM** (bot mất ngữ cảnh địa chỉ cũ ⇒ hỏi lại ⇒ chậm chốt) | **DEFER** |
| M-ACCEPT | Bảng chấp thuận | Backend: RECOMMENDED; checkbox + màn chặn: OPTIONAL | Checkbox / chặn: MEDIUM | **Giữ backend, bỏ checkbox và màn chặn** |
| M-ALERT-MINIMIZE | Che SĐT trong tin đơn | OPTIONAL (hồ sơ xuyên biên giới mới là bắt buộc) | Vận hành kho MEDIUM | **DEFER**; chủ sở hữu chọn phương án A / B ở P0-3 |
| M-INVARIANT-CREDIT | Bài kiểm bất biến tín dụng dịch vụ | RECOMMENDED | NONE | GIỮ (rẻ) |
| M-OBSERVE | Đo production chỉ đọc | RECOMMENDED (đầu vào cho hồ sơ) | NONE | GIỮ, làm đầu tiên |
| M-INCIDENT | Bảng sự cố | RECOMMENDED | NONE | Runbook (tài liệu) P0 tối thiểu; bảng P1 |
| M-TAX-CATEGORY | Danh mục thuế cấu hình | RECOMMENDED | NONE | P1 |
| M-OFFSITE-VN | Sao lưu trong nước | COUNSEL / F | NONE | P2 |
| M-ECOM-DISCLOSURE | Chân trang TMĐT | COUNSEL | NONE | P1 sau G |
| M-DSR | Công cụ DSR | RECOMMENDED (đáp ứng trong hạn mới là bắt buộc) | NONE | P1; P0 chỉ cần quy trình tay |

## 3. Công bố AI — thiết kế lại ở mức TỐI THIỂU HỢP PHÁP

**Căn cứ bắt buộc** (đọc toàn văn bản dịch Luật 134/2025): Điều 11 khoản 1 — hệ thống AI tương tác trực tiếp với con người
phải được *thiết kế và vận hành* sao cho người dùng *nhận biết được* mình đang tương tác với AI, «trừ khi pháp luật quy
định khác». Điều 7 cấm «che giấu thông tin bắt buộc». Luật **không** quy định câu chữ, **không** đòi lặp lại, **không**
đòi câu phủ định kiểu «tôi không phải con người». Luật chỉ đòi *khả năng nhận biết*.

**Cái gì phải bỏ** (vì nó là che giấu chủ động, không phải «ít ma sát»): lời nhắc «không nhắc rằng mình là AI hay tin tự
động» (`followup.ts:58`); vai «nhân viên bán hàng» (`engine.ts:156`) khi khách hỏi thẳng «em là máy hay người?». Bot
trả lời thật, một câu, rồi tiếp tục bán — đây là ranh giới MANDATORY, không thương lượng.

**Ba cơ chế xếp theo ma sát tăng dần — chọn tổ hợp (1) + (2), đưa (1)-đơn-lẻ cho luật sư đánh giá:**

| # | Cơ chế | Ma sát | Đáp ứng Điều 11.1? | Ghi chú |
|---|---|---|---|---|
| 1 | **Nhận diện ở lớp giao diện, ngoài nội dung tin**: tên hiển thị bot mặc định «Trợ lý AI» thay «Trợ lý bán hàng» (`config.ts:208`); Messenger **greeting text** + **ice breakers** của Page (hiện trước khi khách gửi tin đầu) mang chữ «Trợ lý AI của {shop}»; chat web: tiêu đề «Trợ lý AI · {shop}» thay «Chat với {botName}» (`app/chat/page.tsx:29`); Zalo OA: mô tả OA | **NONE** — không một ký tự nào trong hội thoại | Khả năng cao với chat web (nhãn luôn hiện). Với Messenger, greeting chỉ hiện cho khách mới mở lần đầu, không hiện với khách tới từ quảng cáo click-to-Messenger hoặc bình luận ⇒ **một mình có thể chưa đủ** — **COUNSEL** | Đã có thể làm ngay, không đợi quyết định |
| 2 | **Một dòng tự nhiên, một lần, đầu hội thoại mới** (hoặc sau ≥ 30 ngày im lặng), đặt vào câu trả lời đầu tiên của bot theo giọng shop — mẫu mặc định: «Trợ lý AI của {shop} hỗ trợ anh/chị ngay đây ạ 😊» — rồi vào việc ngay trong cùng tin; không tin riêng, không lặp ở tin sau, không lặp ở follow-up | **LOW** (≤ 1 dòng, 1 lần) | Có — khách «nhận biết» ngay tại điểm tương tác | Khách thuê sửa được câu trong hàng rào: phải chứa «trợ lý AI» hoặc «AI», ≤ 60 ký tự, không chứa phủ định về con người. Khi nhân viên tiếp quản thì không cần gì thêm |
| 3 | Tin riêng / disclaimer dài / lặp mỗi tin / nút «gặp nhân viên» gắn mọi tin | MEDIUM–HIGH | Thừa so với luật | **KHÔNG LÀM** |

**Quy tắc hành vi (MANDATORY, chi phí 0 với chuyển đổi):**
- Hỏi thẳng «là máy / là bot / là AI / người thật không?» ⇒ trả lời thật, ngắn, giọng shop («Dạ em là trợ lý AI của shop,
  có gì cần nhân viên em chuyển ngay ạ») rồi tiếp tục. Không né, không nói dối. Bài kiểm golden thêm 3 câu hỏi loại này.
- Lệnh «gặp nhân viên» / «người thật» ⇒ `handoff_to_human` không qua AI quyết (đã có công cụ; chỉ thêm từ khoá). Không in
  hướng dẫn về lệnh này trong mọi tin — chỉ khi khách hỏi hoặc khi bot đã chuyển người.
- Ghi `sales_conversation_events` `ai.disclosed` (mốc, cơ chế 1 / 2, câu đã dùng) — bằng chứng backend, khách không thấy.

**Đo (bắt buộc trước khi mở rộng):** A/B câu chữ dòng (2) — tất cả biến thể đều chứa «trợ lý AI»; đo reply rate, lead→đơn,
hoàn tất đơn, rớt sau tin đầu, trên ≥ 2 tuần / ≥ 200 hội thoại mỗi nhánh. **Không bao giờ** A/B «có công bố» vs «không».

**Câu hỏi luật sư (bổ sung G-4):** (a) cơ chế (1) một mình có đủ «nhận biết được» không khi khách tới từ quảng cáo / bình
luận? (b) câu mẫu ở (2) có đáp ứng không, hay luật / nghị định hướng dẫn sẽ đòi cụm từ cụ thể? (c) NĐ 356 Điều 10 (xử lý
tự động) có áp cho bot tư vấn bán hàng không — nếu có, «quyền không tham gia» thực hiện bằng lệnh «gặp nhân viên» đã đủ chưa?

## 4. Báo cáo theo yêu cầu

### MANDATORY LEGAL CONTROLS (trước khách trả tiền)
1. Hồ sơ đánh giá tác động xử lý DLCN — hoặc văn bản luật sư xác nhận được hoãn.
2. Hồ sơ chuyển xuyên biên giới cho Gemini · Drive · Telegram (+ Cloudflare) · Lark · Meta; biết vùng xử lý.
3. Công bố AI mức tối thiểu (§3: cơ chế 1 + 2; bot không nói dối khi bị hỏi).
4. DPA — phụ lục Điều khoản, chấp thuận cùng một lần.
5. Lưu dữ liệu tại VN (đã đạt phần chính; làm rõ Drive).
6. Có khả năng thông báo sự cố trong 72 giờ (runbook + người trực).
7. Có khả năng đáp yêu cầu chủ thể trong hạn (quy trình tay + script xoá chạy thử).
8. Xuất hoá đơn đúng khi thu tiền (kế toán chốt; nhà cung cấp HĐĐT ngoài).
9. Chính sách quyền riêng tư nêu đủ bên thứ ba; số liệu công bố khớp mã (7 / 14 ngày, VNPT / Vietnix, kênh thông báo).
10. Ba câu hỏi giấy phép (dịch vụ xử lý DLCN · TMĐT · trung gian thanh toán) có văn bản luật sư — không phải việc kỹ thuật.

### MINIMUM-FRICTION IMPLEMENTATION
- Công bố AI: tên hiển thị + greeting / ice breakers + tiêu đề chat web (ma sát 0) và một dòng tự nhiên đầu hội thoại (≤ 1
  dòng, 1 lần). Bỏ lời nhắc che giấu. Không nút, không tin riêng, không lặp.
- DPA: phụ lục, dẫn chiếu trong dòng đồng ý hiện có. Không màn hình mới.
- Chấp thuận: ghi sổ backend (phiên bản · hash · mốc · IP). Không checkbox, không chặn đăng nhập khi đổi phiên bản — thông
  báo trong app.
- DSR / sự cố / sao lưu / nhật ký / hoá đơn: toàn bộ backend hoặc tài liệu; khách hàng cuối không thấy gì.
- Từ chối nhận tin: nhận từ khoá ở backend; không thêm chữ «nhắn STOP» vào tin bán hàng.
- Tin đơn ra Telegram / Lark: giữ nguyên nội dung; xử lý ở hồ sơ xuyên biên giới hoặc đổi sang Zalo Bot — chủ sở hữu chọn.

### NON-MANDATORY ITEMS TO REMOVE / DEFER
- Checkbox đồng ý tường minh ở `/start`; màn chặn «đồng ý lại» — bỏ.
- Che SĐT / địa chỉ trong tin đơn (M-ALERT-MINIMIZE) — defer.
- Tối thiểu hoá khối «khách cũ» trong prompt (M-PROMPT-MIN) — defer.
- OTP SĐT trước khi tạo workspace (M-PHONE-AUTH) — defer; nếu luật sư nói bắt buộc thì xác minh sau khi vào workspace.
- `/platform/compliance`, trang bên xử lý phụ động, bảng sự cố, danh mục thuế cấu hình, công cụ DSR tự phục vụ — P1 / P2,
  không chặn ra mắt.
- Mọi câu báo máy trong hội thoại ngoài dòng (2) — không thêm (giữ quyết định 05/10).

### CONVERSION RISKS còn lại
| Rủi ro | Mức | Giảm bằng |
|---|---|---|
| Dòng công bố AI đầu hội thoại làm khách rời | LOW (ước; chưa đo) | A/B câu chữ; đo 2 tuần; giữ ≤ 1 dòng, giọng shop |
| Bot trả lời thật «em là AI» khi bị hỏi làm mất niềm tin | LOW | Câu ngắn + mời chuyển nhân viên ngay trong câu |
| Nếu luật sư kết luận cơ chế (1) không đủ và (2) phải dài hơn | MEDIUM | Giữ hai phương án sẵn; chỉ đổi theo văn bản luật sư |
| Nếu NĐ 333 bắt buộc OTP SĐT | HIGH với đăng ký | Xác minh trễ (sau workspace / lúc thanh toán) |
| Nếu VNX bị coi là nền tảng TMĐT trung gian (chat web) | MEDIUM (nghĩa vụ người bán định danh từ 2027) | Hỏi luật sư trước; có thể chuyển chat web sang tên miền của khách thuê |

### COUNSEL QUESTIONS (gộp với §19.G tài liệu chính)
G-1 dịch vụ xử lý DLCN · G-2 hoãn 5 năm · G-3 bên nào nộp hồ sơ xuyên biên giới, dữ liệu mã hoá · **G-4 (mở rộng §3)**
cơ chế công bố AI tối thiểu nào đủ · G-5 NĐ 333 phạm vi (OTP, nhật ký) · G-6 TMĐT · G-7 Số dư AI · G-8 căn cứ không cần
đồng ý · G-9 rà 12 văn bản · **G-10 (mới)** DPA dưới dạng phụ lục Điều khoản chấp thuận một lần có đủ không · **G-11
(mới)** sự cố log 24/09 có phải thông báo không.
