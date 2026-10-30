# Săn khách sỉ (HSLC Wholesale Lead Hunter)

> Module `wholesale_leads` (migration `0197`). Tìm nhà hàng, quán, khách sạn, cửa hàng thực phẩm làm khách sỉ mới từ dữ
> liệu doanh nghiệp công khai trên Google Places. Hệ thống chuẩn hoá, khử trùng và chấm điểm lead, rồi đưa lead vào quy
> trình bán sỉ tới lúc lead thành khách hàng ERP.
> Module TẮT ở tổ chức nhà. Mẫu ngành `seafood-commerce` 1.1.0 có sẵn module này.

## 1. Luồng

```
Chiến dịch → kế hoạch ô (từ khoá × tỉnh × khu vực) → Text Search (trường gọn) → khử trùng Place ID
→ lọc sơ bộ (đóng cửa · sai nhóm khách · từ khoá loại trừ · trùng tên + địa chỉ)
→ Place Details CHỈ cho địa điểm qua lọc (SĐT · website · sao · số đánh giá)
→ chuẩn hoá SĐT → lọc theo chiến dịch (bắt buộc SĐT / website, sao / đánh giá tối thiểu)
→ khử trùng SĐT → tên miền → chấm điểm → tự lên «Đủ điều kiện» (≥ ngưỡng, có SĐT)
→ (tuỳ chọn) đọc trang liên hệ công khai của website + thu thập email B2B có bằng chứng (mục 4c)
→ Hàng đợi liên hệ (người duyệt, người gửi) → pipeline → «Chốt được» → chuyển thành khách hàng ERP → doanh thu
```

Từ 27/10/2026 cùng luồng này quét cả **khách sỉ nước ngoài**: «tỉnh» là nước, «khu vực» là thành phố (mục 4d).

Hệ thống không bao giờ tự gửi tin. Lead chỉ vào hàng đợi khi người bấm «Xếp hàng liên hệ» hoặc khi cấu hình đặt
`AUTO_PREPARE`. Ở mức `AUTO_PREPARE`, hệ thống chỉ soạn sẵn lời chào theo mẫu, và người vẫn phải duyệt rồi gửi.

## 2. Kiến trúc trong ERP

| Phần | Ở đâu |
|---|---|
| Sổ module, quyền, menu, phạm vi dữ liệu | `lib/constants/platform-modules.ts` · `lib/auth/permissions.ts` · `lib/constants/department-modules.ts` · `lib/constants/data-scope-policy.ts` (`WHOLESALE_LEADS`) |
| Kết nối Google (khoá theo tổ chức) | `lib/connectors/registry.ts` (`google-places`), kiểm tra `lib/connectors/testers.ts::testGooglePlaces` |
| Client Places API (New) | `lib/integrations/google-places/client.ts` |
| Nguồn lead (abstraction) | `lib/wholesale/providers.ts`: `DiscoveryProvider` (Google Places) · `EnrichmentProvider` (website) · `ImportProvider` (CSV) |
| Lõi quét nền | `lib/wholesale/engine.ts` (`runLeadHunterTick`) · job `wholesale-leads` (`lib/wholesale/job.ts`, `lib/sync/jobs.ts`) |
| Hàm thuần | `phone.ts` · `segments.ts` · `scoring.ts` · `query-plan.ts` · `areas.ts` · `dedupe.ts` · `website-parse.ts` · `email-discovery.ts` · `opener.ts` · `config.ts` · `contactability.ts` · `temperature.ts` |
| Lõi ghi (quyền → zod → ghi → audit) | `campaigns.ts` · `leads.ts` · `outreach.ts` · `consents.ts` · `config-core.ts` · `email-store.ts`; vỏ server action `lib/actions/wholesale.ts` |
| Truy vấn | `lib/queries/wholesale.ts` · `lib/queries/wholesale-export.ts` |
| Trang | `/wholesale/leads` · `/wholesale/leads/[id]` · `/wholesale/outreach` · `/wholesale/lead-hunter` · `/wholesale/dashboard` · `/wholesale/settings` · `GET /api/wholesale/export` |

Khi thêm một nguồn mới (Facebook, TikTok, danh bạ, Yellow Pages), viết một provider đúng vai (`DISCOVERY` /
`ENRICHMENT` / `IMPORT`) và khai `googleSourced`. Lõi không phải sửa.

Module không dựng CRM thứ hai. Lead chỉ thành dòng `customers` khi đã chốt, và đi qua đúng lõi tạo khách có sẵn
(`createCustomerAsAgent`). Nếu đã có khách cùng SĐT (so 9 số cuối), lead được nối vào khách đó: không tạo bản thứ hai,
không ghi đè hồ sơ. Doanh thu đọc theo `customer_id` bằng cùng công thức với trang Khách hàng (`ORDER_OUTCOME_FAST`
cộng `REVENUE_RECOGNIZED_ON_DELIVERY`).

## 3. Dữ liệu: nguồn Google tách khỏi dữ liệu của HSLC

| Bảng | Chủ | Ghi chú |
|---|---|---|
| `wholesale_place_snapshots` | **Google** | Tên, địa chỉ, SĐT, website, sao, loại hình, toạ độ, và khoá khử trùng dẫn xuất từ chúng. Có `expires_at` (mặc định 30 ngày). Hết hạn mà không được làm mới thì job xoá trắng các trường này và chỉ giữ Place ID. |
| `wholesale_leads` | **HSLC** | Trạng thái, người phụ trách, mốc liên hệ, điểm và lý do, cơ hội, `customer_id`. Trường liên hệ chỉ được ghi khi đến từ nguồn không phải Google: nhân viên nhập hoặc xác minh, tệp nhập, website của doanh nghiệp. Ô nhân viên đã sửa (`staff_edited_fields`) thì máy không ghi đè. |
| `wholesale_campaigns` · `wholesale_search_cells` · `wholesale_campaign_cells` | HSLC | Chiến dịch, ô phủ toàn cục, hàng đợi ô của từng chiến dịch (khoá thuê `locked_until`, `page_token`). |
| `wholesale_place_hits` | HSLC | Mỗi (chiến dịch, Place ID) một dòng, kèm kết cục (`NEW_LEAD` · `EXISTING_LEAD` · `FILTERED` · `SUPPRESSED` · `DUPLICATE`). |
| `wholesale_lead_activities` | HSLC | Lịch sử: tìm thấy, gọi, ghi chú, trạng thái, giao việc, liên hệ, chuyển đổi. Người làm lưu bằng khoá tài khoản (luật 34). |
| `wholesale_lead_enrichments` | HSLC | Phát hiện từ website, mỗi dòng kèm `source_url`. Email = kind `EMAIL` (một dòng mỗi email). Vai trò, trạng thái MX và ngày xác minh của email nằm ở `meta.emailChecks` của dòng nhật ký `ENRICHED` (mục 4c). |
| `wholesale_outreach_items` | HSLC | Hàng đợi liên hệ. Chỉ mục duy nhất bảo đảm mỗi lead chỉ có một lời chào đang mở trên mỗi kênh. |
| `wholesale_suppressions` | HSLC | Danh sách KHÔNG LIÊN HỆ, khoá theo SĐT, tên miền, Place ID và email (email từ 0261, lưu dạng chuẩn hoá). |
| `wholesale_contact_consents` | HSLC | Nhật ký ĐỒNG Ý LIÊN HỆ (0261): bằng chứng khách cho phép liên hệ một kênh, chỉ thêm. Mục 4b. |
| `wholesale_api_usage` | HSLC | Mỗi lượt gọi API một dòng: phương thức, SKU, mã HTTP, số kết quả, số lead mới, số trùng, thời gian, chi phí ước tính (micro-USD). |

Màn hình hiển thị theo thứ tự: dữ liệu của tổ chức trước, sau đó tới snapshot Google còn hạn. Snapshot đã xoá thì ô
hiện «—» và có nút «Làm mới dữ liệu Google».

## 4. Tuân thủ Google Maps Platform

Phần này là cách kỹ thuật đã làm. Nó không phải ý kiến pháp lý. Chủ shop hoặc luật sư nên tự đọc điều khoản hiện hành.

- **Place ID** là định danh ngoài, được lưu lâu dài (Google cho phép).
- **Nội dung Google** chỉ được giữ tạm, tối đa `googleRetentionDays` ngày (mặc định 30, trần 30). Hết hạn thì nội dung
  bị xoá. Lead đang chăm (từ «Đủ điều kiện» tới «Đang thương lượng») được làm mới bằng Place Details trước khi hết hạn,
  và lượt làm mới này tính tiền và chịu trần ngân sách.
- **Ghi công nguồn:** mọi màn hình hiện dữ liệu Places đều có dòng «Dữ liệu địa điểm: Google Maps».
- **Xuất CSV** chỉ gồm dữ liệu của tổ chức, Place ID và link Google Maps. Tệp không chứa tên, địa chỉ, SĐT hay sao lấy
  từ Google.
- Khi khách xác nhận SĐT hoặc chuyển thành khách hàng, SĐT trở thành dữ liệu của HSLC (`phone_source = VERIFIED_CALL`).
- **Đọc website** đi qua rào SSRF dùng chung của kho (`lib/net/public-url.ts::fetchPublicUrl`), chỉ chạm trang công khai và tôn trọng `robots.txt`. Hệ thống không đăng nhập, không vượt captcha hay
  tường phí, và chỉ trích kênh liên hệ doanh nghiệp tự công bố.

## 4b. Tuân thủ liên hệ: danh sách chặn email và nhật ký đồng ý (0261, 27/10/2026)

Phần này là cách kỹ thuật đã làm, không phải ý kiến pháp lý. Kết luận pháp lý vẫn ở `docs/legal/DATA_PROCESSING_REGISTER.md`
D17: tiếp thị tới người chưa đồng ý là rủi ro, và luật sư chưa thẩm định.

**Danh sách chặn có thêm EMAIL.** Email được chuẩn hoá trước khi lưu và so (`normalizeEmail`):

- bỏ khoảng trắng hai đầu và tiền tố `mailto:`, rồi đổi sang chữ thường;
- KHÔNG bỏ dấu chấm của Gmail, KHÔNG bỏ phần `+nhãn`. Đó là luật riêng của từng nhà cung cấp; đoán sai thì hai người bị gộp
  làm một.

Mọi chỗ kiểm danh sách chặn đều kiểm cả email khi lead có email: lọc ở `finalizeLead`, soạn / duyệt / gửi lời chào, nhập
tệp. Nút «Không liên hệ» trên lead đưa cả email vào danh sách. Ở `/wholesale/settings` có ô thêm email tay, dùng cho thư
«xin ngừng gửi» chưa gắn được với lead nào. Khi thêm, lời chào đang chờ của các lead mang email đó bị huỷ. Gỡ vẫn cần
`wholesale:config` và lý do.

**Nhật ký đồng ý** (`wholesale_contact_consents`) là bằng chứng khách cho phép liên hệ. Mỗi dòng ghi:

- lead, kênh (`EMAIL` · `PHONE` · `ZALO`) và địa chỉ đã chuẩn hoá;
- căn cứ và mô tả bằng chứng (bắt buộc), kèm link nếu có;
- người ghi, lưu bằng khoá tài khoản (luật 34), và mốc ghi.

Bảng chỉ thêm. Thu hồi là điền một lần `revoked_at` cùng lý do và người thu hồi, không xoá dòng. Lead còn bằng chứng thì
không xoá được.

Căn cứ là danh sách đóng (`CONSENT_BASES`, chú thích từng giá trị trong `lib/wholesale/contactability.ts`):

| Căn cứ | Khi nào dùng |
|---|---|
| Tự đăng ký qua form | Khách tự điền form hoặc đăng ký nhận báo giá |
| Khách chủ động liên hệ / trả lời | Khách nhắn / gọi / gửi mail tới trước trên đúng kênh đó |
| Đồng ý bằng lời khi gọi | Ghi ngày gọi, người nghe máy, câu khách nói |
| Đã là khách hàng | Chỉ nhận khi lead đã chuyển thành khách hàng ERP |
| Lời mời chào hàng công khai | Doanh nghiệp công bố mời báo giá cho đúng nhóm hàng; bắt buộc link tới chính lời mời |
| Chủ shop xác nhận căn cứ khác | Hợp đồng giấy, thoả thuận đối tác; bắt buộc mô tả |

Không có giá trị «không có căn cứ»: không có căn cứ thì không có dòng nào. Cũng không có căn cứ «email công khai trên
website». Bộ đọc website không bao giờ ghi một dòng đồng ý.

**Ai được tự liên hệ** — hàm thuần `contactability(lead, consents, suppressions, channel, mode)` quyết định:

1. Lead ở trạng thái KHÔNG LIÊN HỆ ⇒ không.
2. Thiếu địa chỉ cho kênh đó ⇒ không.
3. Khớp danh sách chặn ở BẤT KỲ khoá nào ⇒ không, trên mọi kênh. Danh sách chặn thắng mọi đồng ý.
4. Chế độ `AUTOMATED` (máy tự gửi) cần một đồng ý còn hiệu lực, đúng kênh, đúng địa chỉ. Đồng ý ghi cho địa chỉ khác không
   tính. Đồng ý đã thu hồi cho kết quả `CONSENT_REVOKED`, không có đồng ý cho `NO_CONSENT`.
5. Chế độ `MANUAL` (nhân viên tự gọi, tự bấm gửi từng tin) giữ quy trình cũ: chỉ bước 1–3 chặn.

Hôm nay chưa có kênh tự gửi nào (mức `AUTO_SEND` vẫn khoá). Kênh tự gửi viết sau PHẢI gọi `leadContactability(…,
"AUTOMATED")` trước mỗi lượt gửi. Trang lead có khối «Đồng ý liên hệ»: kết luận của từng kênh, nhật ký (kể cả dòng đã thu
hồi), form ghi và nút thu hồi. Quyền ghi / thu hồi là `wholesale:work` cộng phạm vi dữ liệu của lead; không có khoá quyền mới.

## 4c. Làm giàu website & thu thập email B2B (chủ shop chốt 27/10/2026)

> **Email thu thập công khai ≠ đồng ý nhận tiếp thị — chưa được gửi tự động.** ERP chỉ THU THẬP và KIỂM KỸ THUẬT. Không
> có đường nào gửi email tới các địa chỉ này; kênh Email trong hàng đợi liên hệ vẫn do người duyệt và người tự gửi. Bộ
> thu thập KHÔNG ghi dòng đồng ý nào (mục 4b); email máy điền vẫn qua danh sách chặn và khử trùng email như mọi email.

**Đọc gì.** Trang chủ + tối đa `maxPages − 1` trang CÙNG website (Cấu hình › Đọc website, 1–5 trang). Trang kế tiếp chọn
theo đường dẫn và chữ trên liên kết (`rankContactPages`): liên hệ (`contact`, `lien-he`…) › đại lý / bán sỉ / mua hàng
(`wholesale`, `distributor`, `b2b`, `purchasing`, `procurement`, `dai-ly`, `ban-si`…) › giới thiệu (`about`,
`gioi-thieu`, `ve-chung-toi`) › `impressum`. Liên kết ở `<footer>` được cộng điểm. Trang không khớp mẫu nào thì không
đọc — bộ đọc không bò khắp website. Bỏ trang đăng nhập / giỏ hàng / tệp.

**Không theo sang tên miền khác.** Mọi request (kể cả bước chuyển hướng mà rào SSRF tự đi) qua một bộ gác chỉ cho phép
CÙNG website (khác `www.` vẫn là cùng). Rào SSRF vẫn là MỘT bản — `fetchPublicUrl`; bộ gác chỉ thay hàm `fetch` nó gọi,
nên request tới website khác không bao giờ rời máy. Trang chủ chuyển hẳn sang tên miền khác ⇒ `FAILED`, ghi rõ tên miền.
`robots.txt` (nhóm `*`, hoặc nhóm mang tên bot) cấm đường nào thì không tải đường đó.

**Trích email** (`extractEmailCandidates`): `mailto:` (nhiều địa chỉ, bỏ `?subject`), chữ trên trang, dạng che
(`name [at] domain [dot] com`, `name(at)domain.com`, `name at domain dot com` — chữ «at» trần không kèm «dot» thì KHÔNG
dịch), thực thể HTML (`&#64;`, `&#x40;`, `&commat;`), email Cloudflare che (`data-cfemail`), JSON-LD (`email` ở
Organization / contactPoint). Loại: email trong `<script>` thường / chú thích HTML, tên tệp ảnh (`logo@2x.png`), tên
miền mẫu (example.*, domain.com…), dịch vụ ghi lỗi (sentry, wixpress), hộp thư hệ thống (`noreply`…), mã băm, hộp thư
dùng một lần (mailinator, yopmail…). Trần 20 email / trang, 20 / website.

**Vai trò** (`classifyEmailRole`, theo phần trước @): `PURCHASING` (purchasing · procurement · buyer · thumua ·
mua-hang · nhap-hang) › `SALES` (sales · kinhdoanh · b2b · wholesale · export · dai-ly · ban-si…) › `GENERAL` (info ·
contact · hello · lienhe · admin · hotro · datban…; hộp thư mang tên thương hiệu như `haisanxanh@gmail.com` của
haisanxanh.vn cũng là liên hệ chung) › `PERSONAL` (dạng họ tên: `lan.nguyen`, `nguyenvana` — «có thể», là phỏng đoán) ›
`OTHER` (kế toán, tuyển dụng, marketing, chuỗi không đọc được).

**Kiểm kỹ thuật — KHÔNG gửi thư** (`checkEmailDomain`): chỉ hỏi DNS. Có MX ⇒ `VALID_MX`; không MX nhưng có A/AAAA ⇒
`VALID_MX` (MX ngầm định, RFC 5321 §5.1); tên miền không tồn tại, không MX lẫn A, hoặc «null MX» (RFC 7505) ⇒ `NO_MX`;
DNS lỗi / quá giờ ⇒ `UNKNOWN` (CHƯA BIẾT, không phải hỏng). Tối đa 5 tên miền / website (tên miền website trước), mỗi
tên miền hỏi một lần, trần 2,5 giây. **Tuyệt đối không mở kết nối SMTP, không dò RCPT / VRFY** — đó là hành vi của kẻ
gửi thư rác và làm IP máy chủ vào danh sách đen.

**Email tốt nhất** (`pickBestEmail`): vai trò (mua hàng › kinh doanh › liên hệ chung › cá nhân) › cùng tên miền website ›
`VALID_MX` › nguồn chắc hơn (mailto / JSON-LD / Cloudflare › chữ › dạng che). `OTHER` và `NO_MX` không bao giờ được chọn.
Ghi vào `wholesale_leads.email` CHỈ khi ô trống, hoặc giá trị đang có do CHÍNH MÁY điền ở lượt trước
(`meta.emailFilled`; lead nguồn Google thì giá trị trùng một phát hiện cũ cũng là của máy). Ô nhân viên đã sửa
(`staff_edited_fields`) không bao giờ bị đè; email từ tệp nhập không bị thay.

**Chỗ lưu (không migration).** Mỗi email một dòng `wholesale_lead_enrichments` (kind `EMAIL`, `source_url`). Bảng này
không có cột jsonb nên vai trò + MX + nguồn + `emailVerifiedAt` của MỖI LƯỢT QUÉT nằm ở `meta` dòng nhật ký `ENRICHED`
(`emailChecks`, `emailBest`, `emailFilled`, `emailDiscoveryVersion`). Màn hình đọc lượt MỚI NHẤT; email nhân viên tự gõ
chưa qua lượt quét nào thì trạng thái là CHƯA BIẾT, không được đếm là hợp lệ.

**Chạy hàng loạt.** Nút «✉ Thu thập email» ở `/wholesale/leads` (quyền `wholesale:scan`) xếp tối đa 200 lead / lần
(trần 500) có website, chưa có email, chưa quét trong `EMAIL_RESCAN_DAYS` = 30 ngày, không phải «Không liên hệ» / «Đã
chốt», website không phải Facebook / Zalo / host dùng chung. Xếp hàng = `website_status = 'PENDING'`; job
`wholesale-leads` đọc dần vài lead mỗi lượt và chỉ chạy khi cờ «Đọc website» đang bật. Lead đang chờ không bị xếp lại;
«quét lại sau» = `website_checked_at + 30 ngày` (không có cột riêng). Thuần quy tắc — không tốn token AI, không tốn
tiền API. Lead mới có website vẫn tự vào hàng như trước (`finalizeLead`).

**Màn hình.** `/wholesale/leads`: email + vai trò + trạng thái tên miền dưới cột Liên hệ; bộ lọc «Email» (có / chưa /
tên miền nhận thư / không nhận thư / theo vai trò). `/wholesale/leads/[id]`: bảng «Email tìm được trên website» (vai trò ·
tên miền · trang nguồn · cách lấy · ngày xác minh; email không còn ở lượt mới nhất vẫn hiện, MX = chưa biết).
`/wholesale/dashboard`: «Lead có email hợp lệ / có website / tổng lead sẵn sàng» (ảnh chụp hiện tại, không theo kỳ).

## 4a. Khách hợp với HSLC lúc này (chủ shop chốt 05/10/2026)

**Hàng hoá.** Danh mục HSLC đọc ngày 05/10/2026 gồm: chả mực giã tay, chả cá thu, nem hải sản tôm bề bề, ruốc bông tôm,
ruốc bông cá thu, nước mắm cốt cá cơm. Đây là hàng đặc sản đóng gói, giá 120–350 nghìn.

**Ràng buộc.** HSLC chưa xuất được hoá đơn VAT. Vì vậy khách phù hợp là cửa hàng / quán **vừa và nhỏ**, nhập về để bán lại
hoặc để dùng.

**Nhóm khách mặc định** (`DEFAULT_TARGET_SEGMENTS`):

- cửa hàng đặc sản / đồ khô / quà biếu;
- cửa hàng thực phẩm sạch;
- cửa hàng mẹ & bé (ruốc cho bé);
- tạp hoá;
- quán hải sản;
- quán nhậu;
- quán ăn / bún chả cá;
- lẩu, nướng, nhà hàng chung.

Khách sạn, tiệc / catering, buffet và siêu thị thường đòi hoá đơn, nên xuống cuối bảng điểm và không nằm trong mục tiêu mặc
định.

**Bộ lọc** (`chainFilter`, `maxReviews`, `sizeProfile` trong cấu hình):

| Lọc | Cách nhận ra | Lý do lọc |
|---|---|---|
| Chuỗi theo danh sách | Tên khớp danh sách thương hiệu (Golden Gate, Redsun, đồ ăn nhanh, siêu thị và cửa hàng tiện lợi chuỗi…). Lọc ngay ở bước tìm, không tốn lượt chi tiết. | `CHAIN` |
| Chuỗi theo số điểm bán | Cùng một tên xuất hiện ở hơn `maxSameName` địa điểm. | `CHAIN` |
| Quá đông khách | Hơn `maxReviews` đánh giá Google (mặc định 5.000). | `TOO_LARGE` |
| Đối thủ | Tên có mặt hàng của shop (mặc định «chả mực») VÀ ở tỉnh gốc (mặc định Quảng Ninh) HOẶC có dấu hiệu sản xuất / bán buôn («giã tay», «giá sỉ», «đại lý», «xưởng»…). Tên là món ăn («bánh cuốn chả mực») thì giữ — quán dùng hàng là khách. Xem `lib/wholesale/competitor.ts`. | `COMPETITOR` |

Chỉ lead do máy tìm mới bị các bộ lọc này chặn. Lead do nhân viên nhập là quyết định của người.

**Đối thủ (05/10/2026).** Từ khoá «chả mực Hạ Long» kéo về 36 lead có chữ «chả mực», điểm 89–98, đứng đầu hàng đợi gọi —
phần lớn là cơ sở làm chả mực ở Quảng Ninh. Từ khoá ấy đã bỏ khỏi bộ mặc định (chiến dịch tạo trước đó vẫn giữ ô đã lên
lịch, nhưng kết quả của chúng qua lọc đối thủ). Luật áp lên lead ĐÃ CÓ một lần cho mỗi bản luật (`sweepCompetitors`, khoá
`settings` `wholesale.competitorSweep`): chỉ lead máy tìm, chưa ai liên hệ, chưa giao. Lead bị loại chỉ đổi sang «Đã
loại» với lý do `COMPETITOR`, không xoá. Chủ shop sửa mặt hàng / tỉnh gốc / dấu hiệu / tên món ở trang Cấu hình.

**Hồ sơ «vừa và nhỏ»** chấm điểm quy mô như sau:

- cao nhất cho nơi có 30–1.199 đánh giá;
- giảm dần với nơi đông hơn;
- gần 0 khi có từ 3 điểm bán cùng thương hiệu trở lên.

Hai điểm bán (một chi nhánh) vẫn được coi là cơ sở vừa.

## 4e. Email bán sỉ — hộp thư đi ở chế độ CHẠY THỬ (E1, 0264, 27/10/2026)

Phần này là cách kỹ thuật đã làm, không phải ý kiến pháp lý. Chủ shop CHƯA chọn nhà cung cấp email (SES / Resend / Gmail) và
CHƯA có tên miền gửi, nên bản này dựng đủ đường ống nhưng **không một thư nào rời ERP**: chế độ cao nhất chạy được là
`DRY_RUN`, chế độ `LIVE` bị từ chối cho tới khi có bộ chuyển (adapter) thật trong `LIVE_EMAIL_ADAPTERS`.

**Luồng.** Lời chào kênh «Email» ở Hàng đợi liên hệ (mẫu, hoặc AI đã qua bộ chặn câu bịa `openerLooksInvented`) → nút «Đưa
vào hộp thư đi» ⇒ thư `DRAFT` (lời chào gốc chuyển «Đã huỷ» — một lời chào không đi hai đường) → **người** duyệt từng thư ⇒
`APPROVED` / `QUEUED` → job `wholesale-leads` (mỗi 3 phút, không đổi lịch) chạy `runEmailOutboxTick` → cổng chính sách →
nhà cung cấp → `SENT` · `FAILED` · `BLOCKED`. Trang `/wholesale/outbox` (tab «Hộp thư đi»).

**Cổng chính sách** (`lib/wholesale/email-policy.ts::evaluateEmailSend`, hàm thuần, tất định, hỏi NGAY TRƯỚC khi gọi nhà cung
cấp). Thư chỉ đi khi ĐỦ: chế độ tổ chức không `OFF` (LIVE cần adapter + chủ shop bật) · không bị nút dừng (tổ chức · chiến dịch ·
tên miền nhận) · có danh tính người gửi để in chân thư · lead chưa trả lời / huỷ đăng ký / trả về vĩnh viễn / báo rác / KHÔNG
LIÊN HỆ · `contactability(lead, …, "EMAIL", "AUTOMATED").allowed` (P1a — **email công khai trên website không phải đồng ý**) ·
không khớp danh sách chặn · email của lead chưa đổi từ lúc soạn · đã duyệt, nội dung khớp băm lúc duyệt, lượt duyệt chưa dùng ·
chưa có thư thật cùng khoá · chưa chạm hạn mức giờ / ngày / tên miền nhận. Hàm gom HẾT lý do. Lý do TỰ HẾT (chế độ, nút dừng,
hạn mức, thiếu danh tính) giữ thư ở `QUEUED` và hẹn 15 phút sau; lý do khác ⇒ `BLOCKED` kèm câu lý do, mở lại = duyệt lại.

**Không gửi trùng.** Khoá `idempotency_key` = lead + mẫu + bước + email, UNIQUE trừ thư chạy thử đã gửi (chạy thử không ăn mất
lượt gửi thật). Job đổi `QUEUED → SENDING` bằng MỘT câu UPDATE có điều kiện trước khi gọi nhà cung cấp; tiến trình chết giữa
chừng ⇒ thư nằm lại `SENDING` chờ người kiểm, không bao giờ tự gửi lại. Lỗi tạm lùi dần 5′ · 10′ · 20′ … trần 6 giờ, tối đa 5 lần.

**Chạy thử ≠ liên hệ.** Thư `SENT` mode `DRY_RUN` mang mã `dryrun-…`, sự kiện SENT `meta.mode = DRY_RUN`, một dòng lịch sử lead
ghi rõ «CHẠY THỬ», và **không** đổi trạng thái liên hệ / lượt liên hệ của lead.

**Tiêu đề và chân thư** (`lib/email-provider/message.ts`). `Message-ID` tất định `<wsm-<id thư>@<tên miền gửi>>`; thư nhắc
mang `In-Reply-To` + `References`; `List-Unsubscribe: <https://…/api/wholesale/unsubscribe/<token>>` + `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058 — DKIM phủ hai tiêu đề này là việc của nhà cung cấp thật). Chân thư: tên doanh nghiệp + địa
chỉ + lý do nhận + link huỷ; tiêu đề gắn nhãn `[QC]` (cách hiểu NĐ 91/2020 — **luật sư chưa thẩm định**).

**Huỷ đăng ký.** Token `vnxu1.<mã tổ chức>.<bí mật 32 byte>`, một token một thư, chỉ lưu băm trong CSDL tổ chức của tiền tố.
GET = trang xác nhận (email đã che, không ghi gì — máy quét link không huỷ hộ ai); POST = huỷ một chạm ⇒ dòng chặn `EMAIL` +
sự kiện `UNSUBSCRIBE` + dừng mọi thư chưa gửi của lead + lịch sử lead. Bấm lại không ghi thêm. Mọi token sai ⇒ cùng một 404.
Link vẫn chạy khi shop tắt module (người nhận không mất quyền huỷ). Lưu ý: theo luật P1a, dòng chặn khớp BẤT KỲ khoá nào của lead
chặn MỌI kênh tự động — huỷ email cũng chặn Zalo / SMS tự động tới lead đó.

**Nhận phản hồi** (`lib/wholesale/email-inbound.ts::ingestInboundEmail`, chưa có hộp thư thật — bộ đọc hộp thư / webhook về sau
gọi hàm này). Idempotent theo Message-ID; nối luồng bằng `In-Reply-To` rồi `References`; không khớp luồng thì chỉ nhận khi địa
chỉ gửi khớp ĐÚNG MỘT lead. Thư tự động (`Auto-Submitted` ≠ `no`) bỏ qua. Khớp ⇒ sự kiện `REPLY` · dừng thư chưa gửi · mốc phản
hồi đầu · MỘT việc tay phòng Kinh doanh giao cho người phụ trách lead (`/work`).

**Quyền.** `wholesale:work` soạn · duyệt từng thư · huỷ · bấm DỪNG · «Chạy thử gửi». `wholesale:config` đổi chế độ / hạn mức /
danh tính, MỞ lại nút dừng, duyệt hàng loạt. `LIVE` chỉ chủ shop (vai trò quản trị). Không thêm khoá quyền mới.

**Cấu hình** ở `settings` khoá `wholesale.email` (object; đọc thô rồi trộn từng trường, chế độ lạ ⇒ `OFF`). Hạn mức mặc định 20 thư
/ giờ · 100 / ngày · 5 / tên miền nhận / ngày, trần cứng 200 · 1.000 · 50.

**Gửi thật — Google Workspace SMTP (E2, chủ shop chốt 30/10/2026).** Adapter thật đầu tiên là connector `gws-smtp`
(`lib/integrations/gws-smtp/client.ts`, thư viện `nodemailer`): `smtp.gmail.com:587`, STARTTLS bắt buộc, đăng nhập bằng App
Password của hộp thư (vd `truyenhk@vnxcommerce.com`). Chủ shop nhập hộp thư + App Password ở Cài đặt → Kết nối dữ liệu; App
Password mã hoá AES-256-GCM trong `org_connections`, màn hình chỉ hiện dạng che, câu lỗi không bao giờ chứa nó. «Kiểm tra» chỉ
đăng nhập SMTP (EHLO → STARTTLS → AUTH), không gửi thư. Bật kết nối KHÔNG đổi chế độ: email vẫn TẮT / CHẠY THỬ cho tới khi quản trị
chọn «Gửi thật» — và lựa chọn đó bị từ chối khi kết nối chưa kiểm tra đạt + bật. Lúc chạy, kết nối tắt ⇒ thư nằm chờ kèm lý do
(không rơi về chạy thử). From luôn là hộp thư đã đăng nhập; Message-ID ổn định, List-Unsubscribe + One-Click từ `buildOutgoingEmail`.
Lỗi đăng nhập SMTP dừng cả lượt (không đốt hết lô); 4xx thử lại có lùi dần; 5xx ⇒ FAILED. Trước khi bật gửi thật, chủ shop thêm
DKIM (`google._domainkey`) + DMARC cho tên miền — đo 30/10: SPF có, DKIM / DMARC chưa. Đọc thư trả lời qua IMAP / Gmail API: CHƯA
làm (sổ việc E3).

## 4f. Kế hoạch kênh: nước ngoài — Email · trong nước — Zalo (chủ shop chốt 30/10/2026)

> «Tách phần tìm khách nước ngoài để gửi email với luồng khách trong nước để nhắn Zalo. Bổ sung gửi email cho cả khách trong
> nước (trong trường hợp không gửi được tin nhắn Zalo cho khách đó).»

**Một hàm thuần quyết làn** — `contactPlanOf` (`lib/wholesale/contact-plan.ts`), nạp dữ kiện theo lô ở
`lib/wholesale/contact-plan-store.ts`:

| Làn | Khi nào |
|---|---|
| Nước ngoài — Email | Nước của lead (thang bên dưới) khác VN, và lead có email |
| Trong nước — Zalo | Lead trong nước nhắn Zalo được — kể cả khi có email |
| Trong nước — chuyển sang email | Zalo KHÔNG GỬI ĐƯỢC **và** lead có email |
| Thiếu căn cứ nước — người xác nhận | Thang nước ra CHƯA BIẾT — nhân viên chọn nước («Xác nhận nước») rồi lead mới vào làn Zalo / Email |
| Thiếu kênh | Không có kênh dùng được — kế hoạch in «Chưa có email — chạy Thu thập email», không đoán địa chỉ |
| Dừng liên hệ | KHÔNG LIÊN HỆ hoặc khớp danh sách chặn (cùng luật P1a: chặn thắng mọi đồng ý) |

«Zalo không gửi được» chỉ có ba đường: không có SĐT di động (Zalo đi theo số di động); `zalo_status = NOT_FOUND` (không có
tài khoản — một sự thật duy nhất, nút «Không có Zalo» sẵn có và lý do `NO_ACCOUNT` cùng ghi vào đây); hoặc nhân viên bấm
«Zalo không gửi được» với lý do trong danh sách đóng (không có tài khoản · chặn tin người lạ · số sai). **Khách chưa trả
lời KHÔNG phải «không gửi được»**: hàm không nhận đầu vào nào về phản hồi hay hẹn gọi lại, nên im lặng không đổi được kênh.

Dấu «Zalo không gửi được» là dòng `wholesale_lead_activities` kind `ZALO`, `outcome = UNDELIVERABLE` (`meta.reason`), người
làm lưu bằng `users.id`, có audit. Hoàn tác THÊM một dòng `UNDELIVERABLE_UNDONE` — không dòng nào bị xoá; dòng mới nhất giữa
hai loại quyết định. Hai loại dòng này không được đếm là «tin Zalo đã nhắn» (màn điện thoại), và lead đã đánh dấu rời hàng
«Zalo trước» sang hàng gọi.

**Hàng đợi liên hệ** chia đúng các làn trên. Nút «Đưa vào hộp thư đi» (E1) chỉ hiện ở hai làn email; làn chuyển sang email có
thêm «Soạn email dự phòng» cho lời chào kênh Zalo. Lõi soạn email (`emailDraftFromOutreachCore`) cũng TỪ CHỐI lead trong
nước còn nhắn Zalo được — luật nằm ở máy chủ, không chỉ ở nút. Mọi thư vẫn qua cổng chính sách E1 (đồng ý · danh sách chặn
· hạn mức) và vẫn CHẠY THỬ.

**Cổng pháp lý theo nước** (issue #1085): `wholesale.email.allowedCountries` — mã ISO2 của nước ĐÃ RÀ LUẬT thư chào hàng,
`VN` cho khách trong nước. Mặc định RỖNG, không có nước mặc định. Nước người nhận đọc từ thang nước dưới đây; CHƯA BIẾT ⇒
coi như chưa rà. Ở chế độ GỬI THẬT, nước chưa rà ⇒ thư nằm chờ
với lý do `COUNTRY_NOT_REVIEWED`; ở CHẠY THỬ thư vẫn đi hết đường ống, cảnh báo in ở Hộp thư đi và ghi vào sự kiện `SENT`.
Chỉ QUẢN TRỊ (vai trò ADMIN, có `wholesale:config`) sửa danh sách ở trang Hộp thư đi, bắt buộc lý do, có audit
(`WHOLESALE_EMAIL_COUNTRIES`). Đây là ghi nhận kỹ thuật, không phải ý kiến pháp lý.

**Nước của lead — MỘT thang chứng cứ** (`leadCountryOf`, `lib/wholesale/lead-country.ts`; dữ kiện gom DUY NHẤT ở
`countryInputOf` trong `contact-plan-store.ts`). Cổng nước của hộp thư đi, làn kênh và ngôn ngữ AI soạn email cùng đọc hàm
này — trước đây có hai luật (khoá tỉnh ở cổng / làn, SĐT + tên miền ở AI) và lead `+1 · .com` bị một bên xếp Việt Nam, bên kia
viết tiếng Anh. Thứ tự:

1. **Người xác nhận** — dòng `wholesale_lead_activities` kind `EDIT`, `outcome = COUNTRY_CONFIRMED`, `meta.country`; chỉ
   thêm, dòng mới nhất thắng; `wholesale:work` + phạm vi dữ liệu + audit `WHOLESALE_LEAD_COUNTRY`.
2. **Khoá tỉnh** — `intl …` ⇒ nước của ô quét; tỉnh Việt Nam có trong danh sách chuẩn ⇒ VN. Khoá không nhận ra ⇒ bỏ qua.
3. **Mã nước SĐT** — `phone_country_code = 84` / `+84…` ⇒ VN; `+<mã>` / `00<mã>` ⇒ nước của mã. Mã dùng chung nhiều nước
   (+1 Mỹ · Canada · Caribe, +7 Nga · Kazakhstan) KHÔNG kết luận — luật thư chào hàng của Mỹ (CAN-SPAM) và Canada (CASL) khác nhau.
4. **Đuôi tên miền quốc gia** của website rồi email (.de, .fr, .com.vn, .co.uk ⇒ GB). Đuôi chung (.com, .net…) và đuôi quốc
   gia hay bị dùng như đuôi chung (.io, .co, .ai, .me, .tv…; .eu không phải một nước) KHÔNG kết luận.
5. Còn lại ⇒ **CHƯA BIẾT** (`null`). Không có mặc định «trong nước».

CHƯA BIẾT ⇒ cổng nước coi như chưa rà (gửi thật nằm chờ), làn «Thiếu căn cứ nước — người xác nhận», và AI soạn email TỪ CHỐI
(trước khi tốn lượt AI) thay vì đoán ngôn ngữ. Nước đã biết: VN / Việt Kiều ⇒ tiếng Việt, nước khác ⇒ tiếng Anh
(`draftLanguageForCountry` — chỉ ánh xạ, không suy nước).

## 4d. Khách sỉ nước ngoài và phân khúc B2B (chủ shop chốt 27/10/2026)

Chủ shop ưu tiên **tìm khách tiềm năng** — cả trong nước lẫn nước ngoài — bằng đúng bộ quét Google Places đang chạy.
Phần này **chưa gửi gì**: lead quốc tế đi Tìm thấy → Đủ điều kiện (người duyệt) như lead trong nước.

**Vùng quét quốc tế** (`lib/wholesale/areas-intl.ts`). Cùng cấu trúc `SearchProvince` với `areas.ts`, nên kế hoạch ô,
hàng đợi, trần chi tiêu, khử trùng và chấm điểm đi nguyên một đường, không có lõi thứ hai.

| Nước | Khoá | Thành phố | Từ khoá áp được |
|---|---|---|---|
| Singapore | `intl sg` | Singapore | `en` |
| Malaysia | `intl my` | Kuala Lumpur · Klang · George Town Penang · Johor Bahru | `en` |
| Thái Lan | `intl th` | Bangkok · Samut Sakhon · Chiang Mai · Pattaya | `en` |
| Nhật Bản | `intl jp` | Tokyo · Osaka · Yokohama · Nagoya · Fukuoka | `en` · `ja` |
| Hàn Quốc | `intl kr` | Seoul · Busan · Incheon · Daegu | `en` · `ko` |
| Đài Loan | `intl tw` | Taipei · New Taipei · Taichung · Kaohsiung · Tainan | `en` · `zh-Hant` |
| Hồng Kông | `intl hk` | Hong Kong Island · Kowloon · New Territories | `en` · `zh-Hant` |
| Úc | `intl au` | Sydney · Melbourne · Brisbane · Perth · Adelaide | `en` |
| Mỹ | `intl us` | Los Angeles · Westminster California · San Jose California · Houston · Dallas · Seattle · New York · Chicago · Atlanta | `en` |
| Canada | `intl ca` | Toronto · Vancouver · Montreal · Calgary | `en` |
| Anh | `intl gb` | London · Birmingham · Manchester · Leeds | `en` |
| Đức | `intl de` | Berlin · Hamburg · Frankfurt · Munich · Leipzig | `en` · `de` |
| Pháp | `intl fr` | Paris · Rungis · Marseille · Lyon | `en` · `fr` |
| Hà Lan | `intl nl` | Amsterdam · Rotterdam · The Hague | `en` |
| UAE | `intl ae` | Dubai · Abu Dhabi · Sharjah | `en` |

- **Ô quốc tế không đụng ô trong nước.** Khoá ô là `TEXT|<từ khoá>|<khoá tỉnh>|<mã khu vực>`. Khoá nước là `intl <mã
  ISO>`, không tỉnh VN nào bắt đầu bằng `intl `, nên «seafood importer × Tokyo» không bao giờ trùng một ô trong nước,
  kể cả khi trùng từ khoá. Khoá ô trong nước không đổi một ký tự (có bài kiểm cho mọi từ khoá mặc định).
- **Chữ CJK.** Khoá từ khoá cũ bỏ mọi ký tự ngoài a–z, nên «水産卸» và «食品卸» đều thành chuỗi rỗng — chung một ô.
  `keywordFold` giữ chữ ngoài Latin; với chữ Việt / Latin nó cho ra đúng chuỗi cũ.
- **Ngôn ngữ / vùng gửi tới Google.** Ô quốc tế gửi `regionCode` = mã nước, `languageCode = en` (ngôn ngữ của KẾT QUẢ —
  nhân viên đọc được tiếng Anh, không đọc được tiếng Nhật / Thái), và `locationBias` hình tròn quanh tâm thành phố (chỉ
  thiên vị, không giới hạn cứng). Ô trong nước gửi đúng như trước: `vi` / `VN`, không thiên vị toạ độ.
- **Từ khoá theo ngôn ngữ.** Nhóm từ khoá mang `lang`: nhóm `vi` chỉ sinh ô trong nước, `en` mọi nước ngoài, bản địa chỉ
  nước dùng tiếng ấy. Từ khoá tự khai (không có `lang`) áp mọi nơi như trước.
- **Khu vực tự khai** nhận tên nước: «Nhật Bản: Kobe» ⇒ ô `intl jp` mang ngôn ngữ / vùng Nhật (Kobe không có tâm thiên vị).
- **Địa chỉ lead quốc tế** không được đọc thành tỉnh VN: lead nhận nước của ô.

**Phân khúc B2B mới** (`LEAD_SEGMENTS`, thêm vào cuối — 17 khoá cũ giữ nguyên tên vì `wholesale_leads.segment` đã lưu):

| Khoá | Nhận ra từ | Phù hợp / ý định |
|---|---|---|
| `SEAFOOD_IMPORTER` | «seafood importer / wholesaler / trading / distributor», «frozen seafood», «水産卸», «수산물 도매», «海鮮批發», «Fischgroßhandel», «grossiste produits de la mer»… | 28 / 11 |
| `ASIAN_FOOD_WHOLESALE` | «Asian food importer», «Asian grocery wholesale», «Asia Großhandel», «grossiste asiatique»… | 27 / 11 |
| `FOODSERVICE_DISTRIBUTOR` | «foodservice», «HORECA», «restaurant supply», «food wholesaler», «食品卸», «식자재», «grossiste alimentaire»…; loại hình Google `wholesaler` (chỉ ô quốc tế) | 20 / 8 |
| `PRIVATE_LABEL_OEM` | «private label», «OEM», «co-packer»… | 18 / 7 |

- Luật B2B **chỉ áp cho ô / lead quốc tế** (`classifySegment(…, { b2b: true })`), và ở đó đứng trước mọi luật khác. Chỉ cụm
  chữ nói rõ việc buôn mới khớp — «Ocean Seafood Restaurant» vẫn là nhà hàng hải sản; «磯丸水産» (chuỗi quán nhậu) không phải
  nhà buôn.
- Ô trong nước và nhập tệp phân nhóm đúng như trước: bốn khoá B2B không nằm trong mục tiêu mặc định trong nước, nên nếu áp
  luật B2B ở đây thì một nhà phân phối VN tên «… Food Distributor» (khách HSLC muốn) bị lọc `SEGMENT` — trước đây nó
  `UNCLASSIFIED` và đi qua. Có bài kiểm khoá điều này.
- Chữ CJK / từ ghép tiếng Đức khớp CHUỖI CON (không có khoảng trắng để khớp ranh giới từ). Loại hình Google `wholesaler`
  ⇒ `FOODSERVICE_DISTRIBUTOR` cũng chỉ ở ô quốc tế.
- «Chuỗi nhà hàng Việt / châu Á» và «chuỗi siêu thị» không có khoá riêng: chúng vào `RESTAURANT` / `SUPERMARKET` sẵn có;
  chuỗi nhận ra bằng số điểm cùng thương hiệu như trong nước.
- `DEFAULT_TARGET_SEGMENTS` trong nước không đổi.

**Nhóm từ khoá quốc tế** (`lib/wholesale/keywords-intl.ts`, mọi nhóm TẮT sẵn): nhập khẩu / bán sỉ hải sản · bán sỉ /
nhập khẩu thực phẩm châu Á · HORECA / phân phối thực phẩm · chuỗi nhà hàng Việt / châu Á · chuỗi siêu thị châu Á · nhãn
riêng / OEM (tiếng Anh); và năm nhóm bản địa chỉ khai khi chắc nghĩa: Nhật, Hàn, Trung phồn thể (Đài Loan + Hồng Kông),
Đức, Pháp. Không có tiếng Thái / Hà Lan / Mã Lai — tiếng Anh vẫn quét được các nước ấy.

**Mẫu «HSLC – International Seafood Importers (pilot)»** (`hslc-intl-seafood-importers-pilot`):

- 3 nước, 4 thành phố: Singapore · Kuala Lumpur · Sydney · Melbourne;
- chỉ nhóm «nhập khẩu / bán sỉ hải sản» (3 từ: seafood importer · seafood wholesaler · frozen seafood distributor);
- mức `ENTERPRISE` (website có ngay trong lượt tìm), tối đa 50 lead;
- **bắt buộc website** (email của nhà nhập khẩu nằm trên website của họ), **không bắt buộc SĐT** (xem giới hạn dưới);
- trạng thái `DRAFT`, là mẫu — không tự chạy; «Dùng mẫu» ra một nháp, chủ shop tự bấm «Bắt đầu quét».

**Ước tính chi phí** — thẻ mẫu và thẻ nháp in ngay số truy vấn × đơn giá SKU (`campaignCostEstimate`, cùng phép tính với
«Xem trước truy vấn»). Với đơn giá mặc định Text Search Enterprise 35 US$ / 1.000 lượt, tỷ giá 26.000:

| | Lượt | US$ | ≈ VND |
|---|---|---|---|
| Ít nhất (12 ô × 1 trang) | 12 | 0,42 | 10.920 |
| Điển hình (1,5 trang / ô) | 18 | 0,63 | 16.380 |
| Nhiều nhất (12 ô × 3 trang) | 36 | 1,26 | 32.760 |

Đây là giá niêm yết, chưa trừ ô vừa quét và chưa trừ 1.000 lượt Enterprise miễn phí mỗi tháng — còn lượt miễn phí thì số
tiền thật là 0. Trần ngày / tháng vẫn chặn bất kể ước tính.

**Trạm chuyển tiếp** (`deploy/places-relay`) chuyển nguyên thân yêu cầu POST và nguyên chuỗi truy vấn GET, nên
`languageCode` / `regionCode` / `locationBias` của ô quốc tế tới Google mà không cần sửa trạm (có bài kiểm).

## 5. Tiết kiệm chi phí API

**Chế độ chỉ dùng miễn phí** (`freeTier`, bật sẵn). Google miễn phí mỗi tháng, tính theo từng SKU trên mỗi tài khoản thanh
toán, theo bảng giá từ 03/2025:

| Nhóm SKU | Lượt miễn phí / tháng |
|---|---|
| Essentials | 10.000 |
| Pro | 5.000 |
| Enterprise | 1.000 |
| Text Search chỉ-ID | không giới hạn |

Cách chặn:

- Trước mỗi lượt gọi, engine đếm lượt đã bị tính trong tháng của đúng SKU sắp gọi.
- Còn dưới 95% hạn mức thì tự dừng với lý do `FREE_TIER`; ngày 1 tháng sau tự chạy lại.
- «Xem trước truy vấn» in số lượt miễn phí còn lại so với số lượt chiến dịch cần.

Mặc định dùng mức `ENTERPRISE` vì đây là lựa chọn rẻ nhất trên mỗi lead:

- một lượt trả tới 20 địa điểm, có sẵn SĐT và số đánh giá, không cần bước chi tiết;
- 1.000 lượt miễn phí mỗi tháng.

Bộ từ khoá lõi có 7 từ. Nhân với 57 khu vực của đợt ① là 399 lượt, nằm trong phần miễn phí.


- **Stage A (tìm):** dùng field mask theo mức `discoveryTier`.
  - `PRO` là mặc định theo đặc tả. Bước tìm lấy tên, địa chỉ, loại hình, trạng thái và toạ độ (SKU Text Search Pro),
    đủ để lọc trước.
  - `IDS_ONLY` chỉ lấy Place ID (miễn phí), nhưng mọi địa điểm mới đều tốn một lượt chi tiết.
  - `ENTERPRISE` lấy luôn SĐT, website và sao trong lượt tìm, không cần bước chi tiết.
- **Stage B (chi tiết):** chỉ chạy cho địa điểm đã qua lọc, với field mask liên hệ (SKU Place Details Enterprise).
- **Phân trang thích ứng:** chỉ xin trang 2 hoặc 3 khi trang trước đủ 20 kết quả và tỉ lệ địa điểm mới ≥
  `minNewRatioForNextPage`.
- **Ô còn mới không quét lại:** ô đã quét trong vòng `cellFreshDays` ngày (mặc định 30) được đánh dấu `SKIPPED_FRESH`
  khi chiến dịch bắt đầu.
- **Ưu tiên ô:** hạng quét đi trước (① tỉnh quét trước → ② không có biển → ③ ven biển, mục 14). TRONG cùng hạng, từ khoá
  từng ra nhiều lead mới trên mỗi lượt quét thì được quét trước.

Lưu ý khi so sánh chi phí: Text Search tính tiền theo **lượt tìm** (tới 20 địa điểm mỗi lượt), còn Place Details tính
theo **địa điểm**. Vì vậy mức `ENTERPRISE` thường rẻ hơn tính trên mỗi lead khi tỉ lệ địa điểm qua lọc cao. Trang
«Xem trước truy vấn» in chi phí ước tính cho từng mức; chủ shop chọn mức ở cấu hình.

**Đơn giá mặc định** (US$ / 1.000 lượt, bảng công khai từ 03/2025): Text Search Pro 32 · Text Search Enterprise 35 ·
Place Details Enterprise 20 · Text Search chỉ-ID 0. Chủ shop sửa ở `/wholesale/settings` khi Google đổi giá. Đây là
**ước tính**: chưa trừ hạn mức miễn phí hằng tháng. Hoá đơn Google Cloud mới là số thật.

## 6. Trần chi tiêu (chặn cứng)

Trước **mỗi** lượt gọi tính tiền, hệ thống kiểm ba điều:

- chi hôm nay + đơn giá ≤ trần ngày;
- chi tháng này + đơn giá ≤ trần tháng;
- số lượt hôm nay < trần lượt.

Nếu chạm một trong ba trần, hệ thống làm các việc sau:

- Mọi chiến dịch đang chạy chuyển sang `PAUSED` với lý do (`BUDGET_DAILY` / `BUDGET_MONTHLY` / `REQUEST_LIMIT`).
- Người có `wholesale:config` nhận một thông báo mỗi ngày (chuông và hàng đợi chung).
- Lượt quét dừng ngay, không gọi thêm lượt nào.

Trần ngày và trần lượt tự mở lại từ 0 giờ hôm sau; trần tháng tự mở lại từ ngày 1 tháng sau (giờ Việt Nam). Mặc định là
**5 US$/ngày, 50 US$/tháng, 1.000 lượt/ngày**. Đây là giá trị an toàn để module không bao giờ chạy mà không có trần;
chủ shop đặt lại theo ngân sách thật.

Ngoài ra còn các lớp bảo vệ khác:

- Google trả **403** (khoá sai hoặc API chưa bật): mọi chiến dịch tạm dừng với `API_AUTH` và chủ shop nhận thông báo.
- Google trả **429**: ô đó hẹn thử lại sau 10 phút và lượt quét dừng.
- **5xx / lỗi mạng / hết giờ:** thử lại có lùi dần lũy thừa 2 kèm nhiễu, tối đa `maxRetries` lần. Ô lỗi 3 lần chuyển
  sang `FAILED`, chiến dịch vẫn chạy tiếp.
- Mỗi lượt gọi có `timeoutMs`. Các lượt gọi cách nhau ít nhất `requestIntervalMs`.

Nên đặt thêm hạn mức (Quotas) theo ngày ngay trong Google Cloud Console, làm lớp chặn thứ hai.

## 7. Chạy nền

Job `wholesale-leads` chạy mỗi 3 phút. Nó chỉ chạy qua fan-out tầng tự động hoá, cho tổ chức khách. Mỗi lượt kéo dài
tối đa 50 giây, theo thứ tự:

1. mở lại các chiến dịch tạm dừng vì trần, nếu đã sang kỳ mới;
2. lấy chi tiết cho lead đang chờ;
3. quét mỗi chiến dịch một trang (xoay vòng giữa các chiến dịch);
4. làm mới lead đang chăm sắp hết hạn lưu;
5. đọc website (tối đa 5 lead);
6. xoá dữ liệu Google đã hết hạn;
7. đánh dấu chiến dịch nào đã xong.

Nếu không có việc, job chỉ chạy một câu đọc và không ghi `sync_runs`. Các nút «Bắt đầu quét», «Tiếp tục» và «Chạy ngay
một lượt» chạy thêm một lượt nền ngay (`after`), qua cùng khoá theo tổ chức nên không chồng với lượt của lịch.

Lượt quét an toàn khi chạy lại, tạm dừng hay chết giữa chừng, vì:

- Lead upsert theo `place_id` (UNIQUE); lượt thấy upsert theo (chiến dịch, Place ID).
- Ô đang xử lý được giữ bằng khoá thuê: lượt chết thì hết hạn thuê và lượt sau lấy lại ô đó.
- Tạm dừng / tiếp tục chỉ đổi trạng thái chiến dịch. Tiến độ (ô `DONE`, `page_token`, lead chờ chi tiết) nằm ở từng dòng.

## 8. Chấm điểm (0–100, xác định)

| Thành phần | Tối đa | Đọc từ |
|---|---|---|
| Phù hợp ngành | 30 | Nhóm khách (từ khoá trong tên, rồi `primaryType`, rồi `types`) |
| Ý định mua | 15 | Nhóm ưu tiên của HSLC: hải sản, buffet, lẩu, tiệc, nướng. Lead QUỐC TẾ tự nhận là nhà buôn (tên có «importer», «distributor», «wholesale», «卸», «도매», «批發», «Großhandel», «grossiste»…, hoặc loại hình `wholesaler`) được cộng `B2B_INTENT_BONUS` = 3, vẫn trần 15 |
| Quy mô | 20 | Số đánh giá; nhiều chi nhánh (trùng SĐT / website, chữ «chi nhánh»); loại hình phục vụ số lượng lớn |
| Liên hệ được | 15 | SĐT di động > cố định > tổng đài; website; email / Facebook / Zalo công khai |
| Vị trí | 10 | Tỉnh trong vùng phục vụ (ưu tiên / giao được). Nước ngoài: 0 điểm với lý do «thị trường nước ngoài, chưa khai vùng xuất khẩu» |
| Chất lượng | 10 | Đang hoạt động; sao (tối đa 2 điểm, nên sao không bao giờ quyết điểm); dữ liệu đủ |
| Học từ kết quả | ±5 | Tỷ lệ chốt của nhóm so với tỷ lệ chung, làm trơn Bayes. Chỉ áp khi nhóm có ≥ 20 lead đã đi tới kết cục |

Hạng: A ≥ 80 · B ≥ 65 · C ≥ 45 · D < 45 (sửa được). Quán đã đóng cửa vĩnh viễn bị chặn ở tối đa 20 điểm.

**Nhiệt độ Nóng / Ấm / Nguội** (`lib/wholesale/temperature.ts`, 0261) trả lời một câu khác hạng: có nên ưu tiên lead này
ngay bây giờ không. Nó không đổi điểm A–D. Nhiệt độ được tính lúc xem từ hạng, trạng thái và mốc tương tác gần nhất (liên
hệ, phản hồi, ghi chú); không lưu cột nào, vì nó đổi theo thời gian.

| Lead | Nhiệt độ |
|---|---|
| Đã thành khách | không áp dụng |
| Không liên hệ / Mất | Nguội |
| Đã phản hồi, tương tác ≤ `TEMPERATURE_HOT_DAYS` (7) ngày | Nóng |
| Đã phản hồi, tương tác ≤ `TEMPERATURE_WARM_DAYS` (30) ngày, hoặc lâu hơn nhưng đã hẹn gọi lại | Ấm |
| Đã phản hồi, im quá 30 ngày | Nguội |
| Đã phản hồi nhưng chưa có mốc nào | Ấm, kèm câu «chưa có mốc» |
| Chưa phản hồi, hạng A/B | Ấm (không bao giờ Nóng) |
| Chưa phản hồi, hạng khác hoặc chưa chấm; «Không nghe máy» từ 3 lần | Nguội |

Nhãn hiện ở cột Điểm của danh sách (di chuột để đọc lý do) và ở khối «Điểm & lý do» của trang lead, kèm từng lý do.

AI không tham gia chấm điểm. Mỗi thành phần có một câu lý do ghép từ dữ liệu có thật; dữ liệu nào chưa có thì câu lý do
ghi «chưa có …», không in 0.

## 9. Chuẩn hoá SĐT

`lib/wholesale/phone.ts`:

- `+84912345678`, `84912345678`, `0912 345 678` và `+84 (0) 912-345-678` cho cùng khoá `+84912345678`.
- Phân loại `MOBILE` / `LANDLINE` / `SPECIAL` (1800/1900) / `UNKNOWN`.
- Hàm không bịa số. Thiếu số 0 đầu, đầu số cũ 11 số hoặc số nước ngoài đều cho `normalized = null`.

Lead lưu `phone_raw`, `normalized_phone`, `phone_kind`, `phone_country_code` và `phone_source`.

## 10. Khử trùng

Theo thứ tự:

1. **Place ID** (UNIQUE).
2. **SĐT chuẩn hoá**.
3. **Tên miền website.** Các host dùng chung (Facebook, Linktree, business.site…) bị bỏ qua.
4. **Email chuẩn hoá** (0261). Đứng sau tên miền: hai cơ sở cùng website là chứng cứ mạnh hơn cùng hộp thư, vì chuỗi hay
   dùng chung mail kế toán. Đứng trước khoá tên vì email là định danh chính xác. Chỉ so với email của tổ chức (snapshot
   Google không có email), trên dạng `lower(btrim(email))` nên dòng cũ còn chữ hoa vẫn khớp.
5. **Tên + số nhà / đường.** Tên đã bỏ từ chung; thiếu số nhà thì không gộp.

Khi bộ đọc website điền một email đã thuộc lead khác, lead MỚI HƠN được đánh dấu `DUPLICATE_EMAIL` và trỏ về lead lâu đời
hơn. Máy không tự gộp trong hai trường hợp, chỉ ghi một dòng lịch sử để người xem:

- lead đã có người chăm;
- lead kia mới hơn.

Lead trùng được đánh dấu `DUPLICATE` và trỏ về lead gốc (`duplicate_of_lead_id`). Lead gốc được cộng điểm quy mô
(nhiều chi nhánh). Lead do nhân viên đã chăm không bao giờ bị máy ghi đè.

## 11. Pipeline & liên hệ

Các trạng thái: `NEW → QUALIFIED → READY_TO_CONTACT → CONTACTED / NO_ANSWER → INTERESTED → CATALOG_SENT → PRICE_SENT →
SAMPLE_REQUESTED → NEGOTIATING → WON / LOST`, và `DO_NOT_CONTACT`.

- Hệ thống tự ghi mốc `first_contact_at`, `first_response_at`, `last_contact_at`, `qualified_at`, `won_at` và
  `contact_attempt_count`.
- `LOST` bắt buộc có lý do.
- `DO_NOT_CONTACT` là trạng thái một chiều:
  - SĐT, tên miền và Place ID vào danh sách không liên hệ;
  - mọi lời chào đang chờ bị huỷ;
  - lead không bao giờ được thêm vào chiến dịch khác;
  - địa điểm mới mang cùng SĐT bị lọc `SUPPRESSED`.
- Gỡ khỏi danh sách cần `wholesale:config` và lý do, và được ghi nhật ký.

Kênh liên hệ (bộ chuyển kênh `channelAction`) gồm Gọi điện · Zalo · SMS · Email · Facebook · WhatsApp. Ở bản này mọi
kênh là **thủ công**: ERP dựng link mở app và cho chép nội dung, người bấm gửi rồi ghi kết quả. Muốn thêm kênh tự gửi,
viết bộ chuyển kênh mới và mở mức `AUTO_SEND`; hàng đợi không phải viết lại.

**Gửi nhân viên thị trường** (`lib/wholesale/field-handoff.ts`, chủ shop yêu cầu 04/10/2026). Chủ shop gọi điện chào
hàng trước, rồi chuyển khách cho nhân viên thị trường tới tận nơi. Có hai cách bấm:

- nút «Gửi NV thị trường» ở trang lead;
- thao tác hàng loạt ở danh sách lead (tối đa 50 khách mỗi lượt).

Tin đi qua `deliverMessage`, dùng kết nối nhắn tin của tổ chức mà cấu hình chọn: Telegram mặc định, Zalo hoặc Lark cũng
được. Nơi nhận là một danh sách «tên → Chat ID» khai ở `/wholesale/settings`. Mỗi lead đi thành một tin riêng, để nhân viên
chuyển tiếp hay ghim được từng khách. Bấm lại trong cùng phút không gửi lần hai. Lead KHÔNG LIÊN HỆ và lead ngoài phạm vi
dữ liệu của người bấm bị bỏ qua, có ghi lý do.

Tin chỉ mang **dữ liệu của shop**, kèm link Google Maps:

- Cuộc gọi «Nghe máy» hoặc «Hẹn gọi lại» chép tên và SĐT vừa gọi được thành dữ liệu của shop (`phone_source =
  VERIFIED_CALL`).
- Địa chỉ chỉ được chép khi người gọi tích «khách xác nhận đúng địa chỉ».
- Lead chưa gọi thì tin ghi «chưa gọi xác nhận», và nhân viên mở bản đồ để xem tên, vị trí.

Làm vậy vì nội dung Google không được mang ra ngoài ứng dụng (mục 4).

**Gọi khách bằng điện thoại** (`/wholesale/mobile`, chủ shop 05/10/2026). Đây là màn riêng cho nhân viên sale sỉ cầm
điện thoại, không phải bản thu nhỏ của màn máy tính. Mục menu tên là «Gọi khách sỉ (điện thoại)»; danh sách lead hiện thêm một
nút lớn khi xem trên màn nhỏ.

Các màn:

1. **Hôm nay:** sáu con số và bốn nút lớn.
2. **Danh sách gọi:** chip lọc một chạm, ô tìm theo tên / SĐT / khu vực.
3. **Màn khách:** nút GỌI NGAY (`tel:`), chép SĐT, bản đồ, Zalo, website.
4. **Lịch sử gọi.**

Thứ tự gọi (`lib/queries/wholesale-mobile.ts`), khách đứng trên được gọi trước:

1. hẹn gọi lại đã quá hạn;
2. hẹn trong hôm nay;
3. khách đang quan tâm;
4. còn lại, xếp theo điểm cao rồi theo lượt tìm thấy mới nhất.

«Khách tiếp theo» bỏ qua khách vừa liên hệ trong 2 giờ.

**Bấm gọi khác với đã gọi.** Nút GỌI NGAY chỉ mở ứng dụng gọi và ghi `CALL_INITIATED` (migration 0210), gồm lead, người bấm, số và
mốc. Nó không đổi trạng thái và không tăng số lần liên hệ. Khi quay lại ERP, bảng «Kết quả cuộc gọi?» tự bật lên, nhờ lượt bấm còn
chờ được lưu trong trình duyệt.

**Kết quả cuộc gọi tách khỏi trạng thái lead.** Người bán chọn một trong chín kết quả; trạng thái do `callOutcomeEffect` suy ra:

| Kết quả | Trạng thái lead | Kèm theo |
|---|---|---|
| Có nhu cầu | INTERESTED | |
| Gửi bảng giá | INTERESTED | việc tiếp theo «Gửi bảng giá», hiện ở chip «Chờ báo giá» |
| Đang cân nhắc | INTERESTED | bắt buộc hẹn gọi lại 3 ngày |
| Hẹn gọi lại | CONTACTED | bắt buộc hẹn, mặc định 9 giờ sáng mai |
| Không nghe máy | NO_ANSWER | |
| Sai người phụ trách | CONTACTED | việc tiếp theo «Xin SĐT người phụ trách nhập hàng» |
| Không có nhu cầu | LOST | lý do + ghi chú |
| Sai số | LOST | lý do + ghi chú |
| Không liên hệ lại | danh sách chặn | |

Hai luật giữ an toàn:

- Không bao giờ lùi một lead đã đi xa.
- Lead đã thành khách (WON) không đổi trạng thái.

Ghi chú nhanh có chip một chạm. Micro của bàn phím điện thoại vẫn đọc giọng nói vào ô ghi chú như thường. Mọi cuộc gọi đi qua
`logCallCore`, nên báo cáo «Hiệu quả» và màn máy tính thấy ngay.

**Lời chào AI** chỉ diễn đạt lại từ dữ kiện có thật: tên, loại hình và khu vực của lead, cùng tên shop, sản phẩm, MOQ,
giao hàng và khuyến mãi khai ở cấu hình. Câu AI chứa số, link hoặc email không có trong dữ kiện bị loại, và hệ thống dùng
mẫu thay thế. Chi phí AI ghi vào sổ AI của nền tảng (`lead_hunter`), chịu hạn mức của gói.

### 11a. Nhắn Zalo trước, gọi sau (chủ shop 06/10/2026)

Khách mới có SĐT **di động** chưa ai thử Zalo nằm ở chip **«Cần nhắn Zalo»** (màn điện thoại) chứ không ở «Cần gọi».
Nút «💬 Chép tin & mở Zalo» (hộp «Zalo · Gọi» trên danh sách, và màn một khách trên điện thoại) làm hai việc trong một cú
bấm:

1. chép tin chào sỉ đã cá nhân hoá vào bộ nhớ tạm;
2. mở `https://zalo.me/0xxxxxxxxx` — app Zalo trên điện thoại hoặc Zalo PC.

**Giới hạn của Zalo, nói thẳng:**

- Link Zalo không điền sẵn được chữ, nên nhân viên giữ ngón tay ở ô chat → Dán.
- ERP **không** biết trước số có Zalo hay không (Zalo không mở API tra số). App Zalo tự hiện hồ sơ hoặc báo «không tìm
  thấy»; nhân viên quay lại bấm một trong ba kết quả `ZALO_RESULTS`.
- Ảnh gửi bằng nút chia sẻ của điện thoại (`navigator.share` với tệp) → Zalo → chọn cuộc trò chuyện vừa mở. Ảnh phục vụ qua
  `/api/wholesale/zalo-image/<số thứ tự>`: chỉ ảnh ĐÃ KHAI trong cấu hình, tải qua `fetchPublicUrl`, không phải proxy mở.

| Kết quả | Trạng thái | Hẹn | `zalo_status` | Tính là liên hệ |
|---|---|---|---|---|
| Đã gửi tin Zalo | lead giai đoạn đầu ⇒ «Đã liên hệ» | GỌI 9 giờ sáng hôm sau nếu khách im | `FOUND` | có |
| Đã gửi kết bạn | như trên | như trên | `FOUND` | có |
| Không có Zalo | giữ nguyên | gọi NGAY (lên hàng «Cần gọi») | `NOT_FOUND` | không |

Khách trả lời qua Zalo ⇒ ghi bằng chính chín kết quả của cuộc gọi, chọn kênh «Khách trả lời qua Zalo» (`channel = 'ZALO'`
trên dòng `CALL`) — một luật trạng thái cho cả hai kênh. Số cố định / tổng đài không bao giờ có Zalo ⇒ đi thẳng hàng gọi.

**Kịch bản** ở Cấu hình → «Kịch bản nhắn Zalo chào sỉ» (`outreach.zaloTemplate`), mỗi dòng một đoạn, dòng rỗng sau khi điền
biến bị bỏ. Biến thêm so với lời chào: `{{ten_nv}}` (tên gọi của nhân viên đang nhắn), `{{gui_anh}}` (câu «em gửi vài hình…» CHỈ khi đã chọn ảnh) và `{{loi_ich}}` (một câu theo nhóm
khách — cách diễn đạt, không phải dữ kiện về doanh nghiệp). Kịch bản mặc định không ghi giá. **Ảnh kèm** (`zaloImages`, tối
đa 10, https) chọn từ ảnh sản phẩm hoặc dán link.

## 12. Quyền & phạm vi

| Quyền | Dùng cho | Vai trò mặc định |
|---|---|---|
| `wholesale:view` | Xem lead, bảng hiệu quả | CS · MARKETING · LEADER · MANAGER · ADMIN |
| `wholesale:work` | Gọi, ghi chú, trạng thái, liên hệ, chuyển khách | CS · MARKETING · LEADER · MANAGER · ADMIN |
| `wholesale:assign` | Giao lead, thêm vào chiến dịch, xuất CSV | LEADER · MANAGER · ADMIN |
| `wholesale:scan` | Chạy chiến dịch (tốn tiền), nhập tệp | ADMIN (MANAGER bị loại tường minh) |
| `wholesale:config` | Trần ngân sách, đơn giá, lời chào, gỡ danh sách không liên hệ | ADMIN |

Phạm vi dữ liệu `WHOLESALE_LEADS` lọc theo `assigned_to_user_id`. Nhân viên có phạm vi «Chỉ của mình» hoặc «Được giao»
chỉ thấy và chỉ chạm được lead giao cho mình. Phạm vi được kiểm cả ở danh sách lẫn ở từng thao tác ghi (`rowInScope`).

Nhật ký ghi các hành động: `WHOLESALE_CAMPAIGN_CREATE`, `WHOLESALE_SCAN_START/PAUSE/RESUME/STOP`,
`WHOLESALE_LEAD_IMPORT`, `WHOLESALE_LEAD_STATUS/EDIT/ASSIGN/CONTACT/DNC/OPPORTUNITY/CONVERT/EXPORT/CAMPAIGN/HANDOFF`,
`WHOLESALE_OUTREACH_QUEUE`, `WHOLESALE_CONFIG_UPDATE`, `WHOLESALE_SUPPRESSION_ADD/REMOVE`, `WHOLESALE_CONSENT_RECORD/REVOKE`.

## 13. Cách lấy khoá Google Places API

1. Vào https://console.cloud.google.com, tạo hoặc chọn một dự án, rồi **bật thanh toán** (Billing) cho dự án.
2. Mở APIs & Services → Library, tìm **Places API (New)** và bấm Enable.
3. Mở APIs & Services → Credentials → Create credentials → **API key**.
4. Giới hạn khoá:
   - API restrictions: chỉ **Places API (New)**;
   - Application restrictions: **None**. Máy chủ ERP gọi qua trạm Cloud Run (mục 13a), nên IP gửi đi không cố định.
5. (Nên làm) Mở APIs & Services → Places API (New) → Quotas, đặt trần số lượt mỗi ngày.
6. Trong ERP, mở Cài đặt → Kết nối → «Google Places (tìm doanh nghiệp)», dán khoá, bấm **Kiểm tra** rồi **Bật**. Lượt
   kiểm tra là một Text Search chỉ xin Place ID, nên Google không tính phí.

### 13a. Trạm chuyển tiếp — Google chặn Places khi gọi từ IP Việt Nam

Đo ngày 04/10/2026, cùng một khoá và cùng một yêu cầu:

| Nơi gọi | Kết quả |
|---|---|
| Cloud Shell | trả 20 Place ID |
| Máy chủ ERP (VNPT TP.HCM) | **403 «The caller does not have permission», không có `reason`** |
| Máy văn phòng (VNPT) | **403 «The caller does not have permission», không có `reason`** |
| Máy văn phòng, khoá sai cố ý | 400 `API_KEY_INVALID` |

Như vậy Google **nhận ra khoá rồi mới từ chối nơi gửi**. Không cấu hình nào của khoá sửa được lỗi này.

Cách xử lý: trạm `deploy/places-relay` (Node thuần, không phụ thuộc gói nào), chạy trên **Cloud Run vùng Singapore** trong
chính dự án Google Cloud của tổ chức.

- Trạm chỉ chuyển tiếp ba lời gọi: `searchText`, `searchNearby` và chi tiết một địa điểm.
- Trạm không giữ khoá Google: khoá vẫn đi theo từng yêu cầu trong tiêu đề `X-Goog-Api-Key`.
- Trạm đòi **mật khẩu trạm** (`X-Relay-Secret`), thiếu hoặc sai thì trả 401.
- ERP chỉ nhận địa chỉ trạm dạng `https://….run.app` (`PLACES_RELAY_URL_PATTERN`): người quản trị tổ chức gõ ô này, nên
  một URL tuỳ ý là cửa SSRF.

Dựng trạm trong Cloud Shell của dự án:

```
git clone --depth 1 https://github.com/truyenhkm5group-stack/hkt.git && cd hkt/deploy/places-relay
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
SECRET=$(openssl rand -hex 24)
gcloud run deploy places-relay --source . --region asia-southeast1 --allow-unauthenticated \
  --set-env-vars RELAY_SECRET=$SECRET --max-instances 2 --memory 256Mi
echo "MAT KHAU TRAM: $SECRET"
```

Rồi trong ERP, ở kết nối «Google Places»:

- «Địa chỉ trạm» = `Service URL` mà lệnh deploy in ra;
- «Mật khẩu trạm» = chuỗi `MAT KHAU TRAM`.

Bấm **Kiểm tra**. Câu báo đạt có chữ «qua trạm chuyển tiếp». Muốn gỡ trạm, để trống «Địa chỉ trạm»: ERP sẽ gọi thẳng
Google như cũ.

Khoá được mã hoá AES-256-GCM trong CSDL của tổ chức (biến `PLATFORM_SECRETS_KEY` của máy chủ đã có). Khoá không bao giờ
xuống trình duyệt và luôn đi trong tiêu đề `X-Goog-Api-Key`, không bao giờ nằm trong URL.

## 14. Chạy chiến dịch đầu tiên

1. Bật module «Săn khách sỉ» ở Cài đặt → Module (tổ chức đã cài mẫu hải sản 1.1.0 thì module đã bật sẵn).
2. Khai khoá Google (mục 13). Ở `/wholesale/settings`, đặt trần ngày / tháng theo ngân sách, kiểm vùng phục vụ và
   thông tin lời chào (MOQ, giao hàng, khuyến mãi).
3. Ở `/wholesale/lead-hunter`, bấm «Dùng mẫu» trên mẫu **HSLC – Wholesale F&B Prospects**. Mỗi mẫu có 20 từ khoá,
   9 nhóm khách và bắt buộc có SĐT. Danh sách quét có đủ 34 tỉnh/thành sau sáp nhập 2025, chia ba đợt theo thứ tự chủ shop
   chốt ngày 04/10/2026:
   - ① Hà Nội + TP.HCM;
   - ② vùng không có biển;
   - ③ ven biển.

   «Ven biển» xét theo **tỉnh cũ** của khu vực, tức danh sách 28 tỉnh giáp biển trước sáp nhập. Vì vậy Pleiku, Buôn Ma
   Thuột, Đà Lạt và Kon Tum ở đợt ②, dù tỉnh mới của chúng nay giáp biển.

   Chọn nhiều đợt trong một chiến dịch thì job vẫn quét theo thứ tự ① → ② → ③: độ ưu tiên ô = hạng quét × 100.000 +
   kinh nghiệm từ khoá (`cellScanPriority`). Tỉnh quét trước và luật biển sửa được ở `/wholesale/settings`, mục
   «Thứ tự quét».
4. Lần đầu nên thu nhỏ chiến dịch: một tỉnh, vài khu vực, một hai nhóm từ khoá. Bấm «Xem trước truy vấn» để xem số truy
   vấn và chi phí, rồi bấm «Lưu & bắt đầu quét».
5. Theo dõi tiến độ trực tiếp trên thẻ chiến dịch. Xong thì mở «Khách sỉ tiềm năng», lọc hạng A/B, giao cho nhân viên,
   rồi bấm «Xếp hàng liên hệ».

## 15. Kiểm thử

`tests/wholesale-lead-hunter.test.ts` và `tests/wholesale-consent.test.ts` (0261: chặn email, nhật ký đồng ý, khử trùng
email, nhiệt độ), cả hai đăng ký trong `tests/sync-fixtures.test.ts`. Bài kiểm dùng Google giả (thay
`fetch`) và không gọi mạng thật. Các phần được kiểm:

- chuẩn hoá SĐT, phân nhóm, chấm điểm xác định;
- kế hoạch ô quét và chi phí;
- khoá khử trùng, đọc trang liên hệ, rào SSRF / robots.txt;
- client Places: khoá trong tiêu đề, field mask, thử lại 5xx, không thử lại 403, câu lỗi đã che khoá;
- lời chào chặn bịa, gộp cấu hình.

Phần chạy trên tổ chức thật `wl-hslc` kiểm:

- kết nối và job thật, lọc trước chi tiết;
- khử trùng SĐT; quét cùng Place ID 10 lần (kể cả hai lượt song song) vẫn ra **một** lead;
- tạm dừng giữa chừng rồi tiếp tục đúng ô;
- lỗi API được thử lại mà không nhân đôi lead;
- trần ngân sách tự dừng, báo đúng một tin, tự mở lại ngày sau;
- không liên hệ chặn mọi đường;
- nhập tệp với `+84…` trùng `0…`;
- chuyển thành khách (không tạo bản thứ hai);
- hàng đợi liên hệ, phạm vi «Được giao»;
- xoá dữ liệu Google hết hạn;
- tổ chức nhà tắt module.

`tests/wholesale-email-discovery.test.ts` (thu thập email, mục 4c) kiểm: trích từng dạng che / thực thể / Cloudflare /
JSON-LD; loại email rác; vai trò; chọn trang cùng website theo ưu tiên; robots.txt cấm ⇒ không tải; chuyển hướng sang
tên miền khác ⇒ không một request nào tới đó; DNS GIẢ (không gọi mạng thật — AGENTS 65) cho MX / A / NXDOMAIN / null MX
/ lỗi / quá giờ; chọn email tốt nhất; không đè ô nhân viên sửa, không thay email từ tệp; bộ lọc danh sách + độ phủ; nút
«Thu thập email» xếp hàng không trùng và tôn trọng hạn quét lại.

## 16. Giới hạn đã biết / Phase 2

- **Kênh tự gửi** (Zalo OA, SMS brandname) chưa có. Mức `AUTO_SEND` đã khai nhưng đang khoá. Email có đường ống đầy đủ ở chế
  độ CHẠY THỬ (§4c); gửi thật chờ chủ shop chọn nhà cung cấp + tên miền.
- **DNS rebinding** khi đọc website: hệ thống kiểm DNS rồi mới tải, nên còn một khe nhỏ giữa hai bước. Rủi ro thấp vì
  phản hồi chỉ được trích chữ.
- **Khu vực là tên quận / huyện cũ dùng để tìm.** Cấp huyện không còn từ 07/2025 nhưng Google và người dùng vẫn gọi tên
  cũ. Địa chỉ của lead không bị suy ra từ tên khu vực.
- **«Học từ kết quả»** chỉ có tác dụng sau khi có đủ lead đi tới kết cục (≥ 20 mỗi nhóm).
- **SĐT nước ngoài chưa chuẩn hoá** (`phone.ts` chỉ hiểu số Việt Nam): lead quốc tế có «chưa có SĐT» ở điểm liên hệ,
  không khử trùng theo SĐT, và không tự lên «Đủ điều kiện» (luật đó đòi SĐT) — người duyệt tay. Vì thế mẫu quốc tế bắt
  buộc website thay vì SĐT. Chuẩn hoá E.164 nhiều nước là việc riêng.
- **Vùng xuất khẩu chưa khai**: cấu hình `serviceAreas` chỉ liệt kê 34 tỉnh, nên mọi nước ngoài 0 điểm vị trí. Khi HSLC
  có chứng từ xuất khẩu, cần thêm nước vào `serviceAreas` (khoá `intl xx`) — trang cấu hình hiện chưa liệt kê nước.
- **Bảng độ phủ** (`coverageByProvince`) và trang cấu hình vẫn chỉ hiện 34 tỉnh.
- **Phase 2 đề xuất:**
  - bộ chuyển kênh Zalo OA / SMS có dedupe và danh sách không liên hệ;
  - Nearby Search theo lưới toạ độ cho thành phố lớn;
  - nguồn Facebook Pages / danh bạ ngành;
  - gợi ý tự động chiến dịch kế tiếp từ bảng «DT / 100 lead»;
  - gắn bảng giá sỉ mặc định khi chuyển khách;
  - nhắc gọi lại vào hàng đợi `/work`.
