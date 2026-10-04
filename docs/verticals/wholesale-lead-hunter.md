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
→ (tuỳ chọn) đọc trang liên hệ công khai của website
→ Hàng đợi liên hệ (người duyệt, người gửi) → pipeline → «Chốt được» → chuyển thành khách hàng ERP → doanh thu
```

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
| Hàm thuần | `phone.ts` · `segments.ts` · `scoring.ts` · `query-plan.ts` · `areas.ts` · `dedupe.ts` · `website-parse.ts` · `opener.ts` · `config.ts` |
| Lõi ghi (quyền → zod → ghi → audit) | `campaigns.ts` · `leads.ts` · `outreach.ts` · `config-core.ts`; vỏ server action `lib/actions/wholesale.ts` |
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
| `wholesale_lead_enrichments` | HSLC | Phát hiện từ website, mỗi dòng kèm `source_url`. |
| `wholesale_outreach_items` | HSLC | Hàng đợi liên hệ. Chỉ mục duy nhất bảo đảm mỗi lead chỉ có một lời chào đang mở trên mỗi kênh. |
| `wholesale_suppressions` | HSLC | Danh sách KHÔNG LIÊN HỆ, khoá theo SĐT, tên miền và Place ID. |
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

## 5. Tiết kiệm chi phí API

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
- **Ưu tiên ô:** từ khoá từng ra nhiều lead mới trên mỗi lượt quét thì được quét trước.

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
| Ý định mua | 15 | Nhóm ưu tiên của HSLC: hải sản, buffet, lẩu, tiệc, nướng |
| Quy mô | 20 | Số đánh giá; nhiều chi nhánh (trùng SĐT / website, chữ «chi nhánh»); loại hình phục vụ số lượng lớn |
| Liên hệ được | 15 | SĐT di động > cố định > tổng đài; website; email / Facebook / Zalo công khai |
| Vị trí | 10 | Tỉnh trong vùng phục vụ (ưu tiên / giao được) |
| Chất lượng | 10 | Đang hoạt động; sao (tối đa 2 điểm, nên sao không bao giờ quyết điểm); dữ liệu đủ |
| Học từ kết quả | ±5 | Tỷ lệ chốt của nhóm so với tỷ lệ chung, làm trơn Bayes. Chỉ áp khi nhóm có ≥ 20 lead đã đi tới kết cục |

Hạng: A ≥ 80 · B ≥ 65 · C ≥ 45 · D < 45 (sửa được). Quán đã đóng cửa vĩnh viễn bị chặn ở tối đa 20 điểm.

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
4. **Tên + số nhà / đường.** Tên đã bỏ từ chung; thiếu số nhà thì không gộp.

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

**Lời chào AI** chỉ diễn đạt lại từ dữ kiện có thật: tên, loại hình và khu vực của lead, cùng tên shop, sản phẩm, MOQ,
giao hàng và khuyến mãi khai ở cấu hình. Câu AI chứa số, link hoặc email không có trong dữ kiện bị loại, và hệ thống dùng
mẫu thay thế. Chi phí AI ghi vào sổ AI của nền tảng (`lead_hunter`), chịu hạn mức của gói.

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
`WHOLESALE_LEAD_IMPORT`, `WHOLESALE_LEAD_STATUS/EDIT/ASSIGN/CONTACT/DNC/OPPORTUNITY/CONVERT/EXPORT/CAMPAIGN`,
`WHOLESALE_OUTREACH_QUEUE`, `WHOLESALE_CONFIG_UPDATE`, `WHOLESALE_SUPPRESSION_REMOVE`.

## 13. Cách lấy khoá Google Places API

1. Vào https://console.cloud.google.com, tạo hoặc chọn một dự án, rồi **bật thanh toán** (Billing) cho dự án.
2. Mở APIs & Services → Library, tìm **Places API (New)** và bấm Enable.
3. Mở APIs & Services → Credentials → Create credentials → **API key**.
4. Giới hạn khoá:
   - API restrictions: chỉ **Places API (New)**;
   - Application restrictions: **IP addresses**, điền IP máy chủ ERP.
5. (Nên làm) Mở APIs & Services → Places API (New) → Quotas, đặt trần số lượt mỗi ngày.
6. Trong ERP, mở Cài đặt → Kết nối → «Google Places (tìm doanh nghiệp)», dán khoá, bấm **Kiểm tra** rồi **Bật**. Lượt
   kiểm tra là một Text Search chỉ xin Place ID, nên Google không tính phí.

Khoá được mã hoá AES-256-GCM trong CSDL của tổ chức (biến `PLATFORM_SECRETS_KEY` của máy chủ đã có). Khoá không bao giờ
xuống trình duyệt và luôn đi trong tiêu đề `X-Goog-Api-Key`, không bao giờ nằm trong URL.

## 14. Chạy chiến dịch đầu tiên

1. Bật module «Săn khách sỉ» ở Cài đặt → Module (tổ chức đã cài mẫu hải sản 1.1.0 thì module đã bật sẵn).
2. Khai khoá Google (mục 13). Ở `/wholesale/settings`, đặt trần ngày / tháng theo ngân sách, kiểm vùng phục vụ và
   thông tin lời chào (MOQ, giao hàng, khuyến mãi).
3. Ở `/wholesale/lead-hunter`, bấm «Dùng mẫu» trên mẫu **HSLC – Wholesale F&B Prospects** (6 tỉnh, 20 từ khoá, 9 nhóm
   khách, bắt buộc có SĐT).
4. Lần đầu nên thu nhỏ chiến dịch: một tỉnh, vài khu vực, một hai nhóm từ khoá. Bấm «Xem trước truy vấn» để xem số truy
   vấn và chi phí, rồi bấm «Lưu & bắt đầu quét».
5. Theo dõi tiến độ trực tiếp trên thẻ chiến dịch. Xong thì mở «Khách sỉ tiềm năng», lọc hạng A/B, giao cho nhân viên,
   rồi bấm «Xếp hàng liên hệ».

## 15. Kiểm thử

`tests/wholesale-lead-hunter.test.ts`, đăng ký trong `tests/sync-fixtures.test.ts`. Bài kiểm dùng Google giả (thay
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

## 16. Giới hạn đã biết / Phase 2

- **Kênh tự gửi** (Zalo OA, SMS brandname, email) chưa có. Mức `AUTO_SEND` đã khai nhưng đang khoá.
- **DNS rebinding** khi đọc website: hệ thống kiểm DNS rồi mới tải, nên còn một khe nhỏ giữa hai bước. Rủi ro thấp vì
  phản hồi chỉ được trích chữ.
- **Khu vực là tên quận / huyện cũ dùng để tìm.** Cấp huyện không còn từ 07/2025 nhưng Google và người dùng vẫn gọi tên
  cũ. Địa chỉ của lead không bị suy ra từ tên khu vực.
- **«Học từ kết quả»** chỉ có tác dụng sau khi có đủ lead đi tới kết cục (≥ 20 mỗi nhóm).
- **Phase 2 đề xuất:**
  - bộ chuyển kênh Zalo OA / SMS có dedupe và danh sách không liên hệ;
  - Nearby Search theo lưới toạ độ cho thành phố lớn;
  - nguồn Facebook Pages / danh bạ ngành;
  - gợi ý tự động chiến dịch kế tiếp từ bảng «DT / 100 lead»;
  - gắn bảng giá sỉ mặc định khi chuyển khách;
  - nhắc gọi lại vào hàng đợi `/work`.
