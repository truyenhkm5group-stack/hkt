# Vòng mẫu quảng cáo — đặc tả và trạng thái

> **File trạng thái DUY NHẤT của vòng mẫu.** Đây là Nấc 4 (NỘI DUNG) của
> `docs/marketing-ai-department.md`. Cập nhật: **24/09/2026** · **ĐÃ DỰNG ĐỦ vòng** (sinh · đăng · đo ·
> chấm · học · màn hình) — **CHƯA CHẠY THẬT**: chờ các việc của chủ shop ở §7.
>
> Hợp đồng mã nguồn: `lib/constants/creative-loop.ts` (mọi con số, mọi trần, từ vựng gen).
> Hàm thuần: `lib/creative/{plan,judge,learn,schedule}.ts`. Kiểm thử: `tests/creative-loop.test.ts`.

---

## 0. Chủ shop yêu cầu gì, và đã chốt gì

Yêu cầu (24/09/2026): *tự động hoá từ ảnh đầu vào (tay · spy · R&D) → viết câu lệnh → AI sinh mẫu →
đăng fanpage → chạy quảng cáo → đọc chỉ số, nối về đúng mẫu → mẫu tốt vào thư viện, mẫu kém bị loại
→ tự rút kinh nghiệm, tự chỉnh ảnh đầu vào và câu lệnh → lặp lại mỗi ngày.*

Chủ shop chốt cùng ngày (bốn câu hỏi, AGENTS.md mục 7):

| Câu hỏi | Chốt |
|---|---|
| Máy tự ghi Facebook tới đâu | **Duyệt MỘT lần cho cả lô** — vẫn là nấc `COPILOT` của ngày 22/09, không mở `AUTO` |
| Ngân sách test | **10 mẫu × 200.000đ × 1 ngày, chạy 6:00 sáng.** Tắt sớm nếu đắt / chỉ số xấu; mẫu tốt mới được tiêu thêm. Luật cụ thể chủ shop tự điền |
| Máy sinh ảnh | **Chỉ ChatGPT (gpt-image)** |
| Thế nào là THẮNG | **Mẫu có > 100 đơn** |

Ba điều tôi (người dựng) suy ra từ các câu chốt, cần chủ shop biết:

1. **Tắt sớm chạy KHÔNG cần bấm; tiêu thêm thì PHẢI bấm.** Lượt duyệt lô khoá luôn bộ luật tắt của
   lô ấy, nên tắt theo luật là việc người đã cho phép trước. Tắt chỉ làm GIẢM tiền. Tiêu thêm làm tăng
   tiền nên vẫn là một lần bấm riêng (nấc `COPILOT`).
2. **Chưa khai luật thì máy không tự tắt và không tự kết luận.** Luật rỗng ⇒ mẫu chạy hết 200.000đ
   rồi tự dừng; phán quyết là `UNJUDGED` (chưa kết luận được), không phải `LOSE`.
3. **"Mẫu kém thì loại, không lưu" — loại khỏi THƯ VIỆN và xoá ẢNH, nhưng GIỮ gen + số đo.** Xoá hẳn
   dòng thì máy quên mình đã thua ở đâu và ngày mai sinh lại đúng ý tưởng ấy. Mẫu thua là thứ máy HỌC
   nhiều nhất.

## 1. Vòng một ngày (giờ Việt Nam)

```
14:00 hôm trước  LẬP LÔ   planBatch()  — 10 + 3 ô dự phòng, hạt giống = ngày chạy (chạy lại ra đúng lô cũ)
                 VIẾT     LLM viết câu lệnh ảnh (EN) + câu chữ + tiêu đề (VI) cho từng ô
                 SINH     gpt-image SỬA ảnh sản phẩm THẬT theo câu lệnh — không vẽ sản phẩm từ con số 0
                          (mặc định gửi cả lô qua Batch API, rẻ 50% — §5e)
02:00            VẼ NỐT   Batch còn chưa xong ⇒ huỷ, ô thiếu ảnh vẽ bằng gọi ngay ở chất lượng vừa (§5e)
                 ⇒ lô "Chờ duyệt", báo Lark/Telegram
tối / sáng sớm   NGƯỜI    xem 13 ảnh, gạt ảnh không ưng, bấm DUYỆT CẢ LÔ (thấy rõ tổng tiền, khung giờ, luật tắt)
05:30            HẠN      chưa duyệt ⇒ lô "Quá hạn", KHÔNG một đồng nào được chi
trước 06:00      ĐĂNG     mỗi mẫu: tải ảnh → bài ẩn trên fanpage → nhóm QC (trọn đời 200.000đ, 06:00→06:00) → mẩu QC
06:00 → 06:00    CHẠY     Facebook tự dừng ở end_time — ERP chết giữa chừng cũng không tiêu quá ngân sách đã duyệt
mỗi lượt tick    ĐO+TẮT   chi cấp mẩu (ad_spends hạt AD) + đơn theo ad_id → judgeVariant() → luật tắt ⇒ tắt nhóm
hết khung + 24h  CHẤM     WIN (> 100 đơn) ⇒ thư viện · PROMISING ⇒ đề nghị tiêu thêm · LOSE ⇒ loại, ảnh xoá sau 7 ngày
mỗi ngày         HỌC      geneStats() ⇒ sổ học ⇒ đầu vào của planBatch() ngày mai
```

## 2. Ranh giới không được xoá

1. **Mô hình không quyết định.** Chọn gen, chấm mẫu, tắt mẫu đều là hàm thuần có kiểm thử. LLM chỉ
   VIẾT câu chữ cho một bản giao việc đã được chọn, và viết bản tin học từ một bảng đã được đếm.
2. **Điểm ảnh gửi sang máy SINH ảnh chỉ là ảnh của shop:** ảnh sản phẩm thật (`PRODUCT_PHOTO`), ảnh
   mẫu thắng/hứa hẹn của vòng, và ảnh **quảng cáo cũ của shop** (`OWN_AD`, §5c) — cùng một lý do: đó là
   quảng cáo CỦA SHOP đã chạy trên tài khoản của shop. `OWN_AD` chỉ vào được bằng nút nhập theo `ad_id`
   (form tải tay không nhận loại này, CSDL bắt buộc `fb_ad_id`), đi sang máy sinh ảnh dưới nhãn
   `OWN_VARIANT`, và chỉ khi nó gắn ĐÚNG mã hàng của ảnh sản phẩm trong ô. Ảnh SPY / tay / R&D chỉ được
   một mô hình ĐỌC ảnh xem và rút ra gen + mô tả chữ — kể cả khi chúng gắn đúng mã. Chép ảnh người khác
   là rủi ro bản quyền và là lý do Facebook khoá tài khoản.
3. **Mọi ô có ảnh sản phẩm thật làm gốc.** Quảng cáo ra một chiếc váy không có trong kho thì đơn nào
   cũng thành đơn hoàn — tiền quảng cáo mua về tỷ lệ hoàn.
4. **Một cửa ghi Facebook.** Mọi lời gọi ghi nằm trong `lib/integrations/facebook/ads-write.ts`, qua
   cùng chốt cứng `ADS_WRITE_ENABLED` và nấc `COPILOT`. `tests/ads-write.test.ts` quét toàn kho.
5. **Máy chỉ làm việc BÊN TRONG chiến dịch test do NGƯỜI dựng**, và chỉ đụng nhóm/mẩu do chính nó tạo.
   Máy không tạo chiến dịch, không sửa đối tượng, không đụng quảng cáo của marketer.
6. **Không nguồn tiền mới.** Chi đọc từ `ad_spends` hạt `AD` (đã đo khớp 0 đồng với hạt chiến dịch,
   `docs/ads-measurement-audit-2026-09-22.md` §4). Kết quả đơn đọc qua `ORDER_OUTCOME_FAST`. Không bảng
   nào của vòng mẫu được báo cáo lợi nhuận/lương đọc.

## 3. Hàng rào tiền — trần cứng của mã nguồn (`CREATIVE_HARD_LIMITS`)

| Trần | Giá trị | Nguồn |
|---|---|---|
| Mẫu đăng mỗi lô | 10 | chủ shop 24/09 |
| Ngân sách trọn đời một mẫu (khung test) | 200.000đ | chủ shop 24/09 |
| Khung test | 1 ngày | chủ shop 24/09 |
| Tổng cam kết test / ngày chạy | 2.000.000đ | = 10 × 200.000đ |
| "Tiêu thêm" một lần bấm | 200.000đ | chủ shop 24/09 |
| "Tiêu thêm" toàn shop / ngày | 1.000.000đ | chủ shop 24/09 |
| Ảnh sinh / ngày | 30 | chặn vòng lặp hỏng |
| Chi sinh ảnh / ngày | 2 USD | chủ shop 24/09 |

Cấu hình (`settings` khoá `creative.config`) chỉ LÀM HẸP được, không nới. Trần tiền theo ngày đếm
trên SỔ `creative_fb_actions` (lượt đã áp), không đếm trên cấu hình.

Bốn lớp chặn tiêu quá, độc lập nhau: **(a)** cổng thuần từ chối trước khi gọi · **(b)** ngân sách TRỌN
ĐỜI + `end_time` trên chính Facebook — ERP có chết cũng không tiêu quá · **(c)** chốt cứng env đọc lại
ngay trước lời gọi mạng · **(d)** công tắc tắt khẩn cấp `ads.write.kill` đọc lại ngay trước MỖI lời gọi
ghi, không cần deploy (§9).

## 4. Chấm mẫu (`judgeVariant`, hàm thuần)

Thứ tự: `WIN` (vượt `winOrdersAbove` đơn chốt, đã vào thư viện thì không tự rơi ra) → chưa đăng
`PENDING` → không có số chi `RUNNING`/`UNJUDGED` (CHƯA BIẾT ≠ 0) → luật tắt `KILL` (chạy ngay trong
khung) → đang chạy `RUNNING` → hết khung, đợi đơn về `AWAITING_ORDERS` → không có luật giữ `UNJUDGED`
→ qua mọi luật giữ `PROMISING` → hụt một luật `LOSE`.

**Luật trên tỷ số có mẫu số 0 không kích hoạt** (mục 42). Muốn tắt mẫu "tiêu 100K mà không có tin
nhắn nào" thì viết luật trên SỐ ĐẾM: `{ metric: "messages", op: "lt", value: 1, minSpendVnd: 100000 }`.

**"0 tin nhắn" là số ĐO ĐƯỢC, không phải CHƯA BIẾT** (điều tra 24/09/2026, không đổi mã). Câu hỏi:
`variantMetrics` cộng `coalesce(sum(ad_spends.messages), 0)` và cột ấy `NOT NULL DEFAULT 0` — liệu
có dòng chi tiêu nào mà số tin nhắn thật ra là *không biết* nhưng bị ghi 0, để luật "tiêu 150K mà
0 tin nhắn" tắt nhầm mẫu? Kết luận: với tập dòng mà vòng mẫu đọc, **không có trạng thái chưa biết
thật**. Căn cứ:

- Vòng mẫu chỉ đọc dòng `grain = 'AD'` khớp `ad_id` của chính mẩu nó đăng. Dòng hạt `AD` chỉ sinh ra
  từ `lib/integrations/facebook/sync.ts::dungDong` — dòng gõ tay (`createAdSpend`) và dòng hạt
  chiến dịch không có `ad_id`, nên không bao giờ vào phép cộng này.
- Mỗi dòng hạt `AD` dựng từ MỘT dòng insights mà lời gọi LUÔN xin trường `actions`
  (`client.ts::insightItems`). Insights API của Facebook chỉ trả các `action_type` có giá trị khác 0
  và bỏ hẳn mảng `actions` khi không có hành động nào — nên "vắng" trong một dòng đã trả về có nghĩa
  là 0, không phải "không lấy được". Không có nhánh nào ghi `spend` mà bỏ `actions` của cùng dòng.
- Lượt đồng bộ lỗi (hoặc cấp mẩu lỗi và lùi về hạt chiến dịch) thì KHÔNG ghi dòng hạt `AD` nào cho
  ngày ấy ⇒ `spendVnd = null` ⇒ phán quyết đã là CHƯA BIẾT sẵn (`judge.ts`, bước 2), không có "tiền
  có, tin nhắn 0" giả.
- Chiến dịch không phải mục tiêu Tin nhắn: 0 vẫn là số đếm đúng (không có hội thoại nào bắt đầu);
  vòng mẫu sao chép cài đặt nhóm từ mẩu mẫu trong chiến dịch TEST mục tiêu Tin nhắn (§7), nên luật
  trên `messages` áp đúng loại quảng cáo. Đặt luật ấy cho một mẩu mẫu không nhắn tin là lỗi CẤU HÌNH,
  và bằng `null` thì cũng không sửa được.

Rủi ro còn lại là ĐỘ TƯƠI, không phải chỗ trống: Facebook có thể điều chỉnh số hành động vài ngày sau;
đồng bộ ghi đè 3 ngày gần nhất mỗi lượt. Luật tắt nên kèm `minSpendVnd` đủ lớn để không kết luận trên
vài giờ dữ liệu đầu tiên. Nếu sau này có một nguồn chi tiêu hạt `AD` KHÔNG xin `actions`, lúc ấy mới
cần cột `messages` nhận `NULL` — và phải kèm luật chấm coi `null` là "chưa đủ căn cứ".

**Đơn chốt** = đơn Pancake mang `ad_id` của mẩu, `ORDER_OUTCOME <> 'CANCELLED'`. Màn hình in cạnh nó
số đơn giao thành công và hoàn (theo `ORDER_OUTCOME`), vì mẫu nhiều đơn mà hoàn cao vẫn là mẫu lỗ.

> **Giới hạn đã biết:** quy kết đơn → quảng cáo đi bằng `ad_id` Pancake gửi, phủ **72,6%** đơn có
> nguồn Facebook (đo 22/09). ~1/4 đơn thật của một mẫu có thể không được đếm ⇒ ngưỡng "> 100 đơn"
> đang đếm THIẾU, không đếm thừa. Không lấp bằng suy đoán.

## 5. Học (`geneStats` + Thompson, hàm thuần)

Mỗi mẫu mang sáu **gen** trong một từ vựng ĐÓNG (góc bán · bối cảnh · người mẫu · bố cục · chữ trên
ảnh · tông màu). Với mỗi giá trị gen: số mẫu đã thử, số thành công, số thắng. Thành công theo LUẬT
(`WIN`/`PROMISING` vs `KILL`/`LOSE`) — hoặc, khi chưa có luật giữ, theo nền TƯƠNG ĐỐI (chi/đơn không
tệ hơn trung vị) và màn hình phải in bao nhiêu quan sát đứng trên nền ấy.

Lập lô: 60% ô **khai thác** (biến thể của mẫu thắng/hứa hẹn, đổi ĐÚNG MỘT gen — để biết gen nào làm
nên chiến thắng), 40% ô **thăm dò** (nguồn cảm hứng ít dùng nhất, gen thiếu chọn bằng lấy mẫu Thompson
— giá trị chưa thử tự được thử, giá trị đã thua nhiều lần tự bị bỏ, không cần xoá dữ liệu).

## 5b. Mẫu tự làm (chủ shop yêu cầu 24/09/2026)

Chủ shop vẽ mẫu trên web ChatGPT / Grok (gói tháng, không có API cho máy) và tải vào lô:

- Vào **lô gần nhất còn hạn duyệt** (`manualTargetDay`): trước 5:30 là lô hôm nay, sau đó là lô ngày mai.
- Lô chưa có ⇒ dựng sẵn "Chờ duyệt" (`plan.manualSeed`). Tới 14:00 máy chỉ lập **phần còn thiếu**:
  `batchSize + extraCandidates − số mẫu tự làm`; ô máy đánh số 1…n, ô tự làm 1001+.
- **Đăng trước** ô máy lập (`publishOrder`); trần 10 mẫu/lô không đổi — mẫu tự làm chiếm chỗ ô máy.
- Không qua máy viết / máy vẽ. Bắt buộc mã hàng + sáu gen (không có gen thì máy không học được gì từ mẫu).
- Câu chữ ghi giá khác giá ERP ⇒ cảnh báo, không chặn. Người tải được quy kết bằng khoá tài khoản (mục 34).
- Vẫn qua MỘT lượt duyệt lô; thêm mẫu sau khi mở hộp duyệt làm phiếu cũ mất hiệu lực (digest đổi).

Tệp: `lib/creative/manual.ts` (đường ghi duy nhất) · `lib/actions/creative-manual.ts` · form ở tab Duyệt lô ·
`drizzle/0118_creative_manual_variants.sql` · `tests/creative-manual.test.ts`.

## 5c. Nhập nguồn ảnh có sẵn (chủ shop yêu cầu 24/09/2026)

*"Lấy luôn những ảnh mẫu win và những ảnh mẫu có chỉ số tốt (giá tin nhắn < 4.000đ) để làm nguồn ảnh
ban đầu, từ đó sinh thêm ảnh biến thể mẫu test mới."* Và tab Nguồn ảnh không bắt tải tay ảnh sản phẩm
mà Pancake đã có.

- **Nhập ảnh sản phẩm từ Pancake** — mỗi mã `not is_removed` có `products.image` ⇒ một nguồn
  `PRODUCT_PHOTO` (`title` = tên mã, `source_url` = URL ảnh). Lũy đẳng theo (mã, URL); ảnh lỗi mang lý
  do, không làm hỏng cả lượt; tối đa `PANCAKE_PHOTO_IMPORT_MAX` ảnh một lượt bấm.
- **Nhập mẫu thắng / mẫu tốt từ Facebook** — HAI bước. Xem trước (chỉ đọc CSDL): mẩu có chi hạt `AD`
  trong 60 ngày, tin nhắn cả đời ≥ 5, và THẮNG (đơn chốt vượt `winOrdersAbove`) hoặc TỐT (chi / tin nhắn
  cả đời < 4.000đ, đã chi ≥ 50.000đ) — số đo qua ĐÚNG `variantMetrics()` của vòng, không điều kiện kết
  quả đơn thứ hai. Nhập (tối đa 30 / lượt): máy chủ KIỂM LẠI ngưỡng, đọc ảnh + câu chữ qua Graph CHỈ-GET
  (`image_url` → `link_data.picture` / `photo_data.url` → `image_hash` tra `adimages`), video / băng
  chuyền / quảng cáo động bị bỏ kèm lý do; lũy đẳng theo `fb_ad_id`. Mã hàng = mã chiếm nhiều dòng đơn
  nhất trong các đơn mang `ad_id` (bỏ quà tặng) → không có thì `ad_spends.product_id` → không có nữa thì
  để trống và NÓI RA (nguồn ấy chưa làm mẫu cha được).
- **Dùng vào đâu.** `OWN_AD` đủ sáu gen + có mã có ảnh thật ⇒ MẪU CHA của ô khai thác (THẮNG nếu lúc nhập
  là mẫu thắng, không thì HỨA HẸN; xếp theo đơn / chi như mẫu của vòng), ô con ghi nguồn vào
  `inspiration_source_id`. Gen chưa đủ ⇒ nguồn cảm hứng đứng TRƯỚC spy / tay / R&D. Câu chữ của nó đi vào
  `loadWinningExamples` (xen kẽ với mẫu thắng của vòng) để máy viết học giọng văn đã bán được. Gen của
  nguồn mới được đọc ở lượt chạy sau như mọi nguồn (`describePending`).

Tệp: `lib/creative/import.ts` (đường ghi) · `lib/queries/creative-own-ads.ts` (xem trước, chỉ đọc) ·
`lib/actions/creative-import.ts` · `app/(dashboard)/marketing/creatives/import-buttons.tsx` ·
`drizzle/0119_creative_own_ads.sql` · `tests/creative-import.test.ts`.

## 5d. Câu chữ theo ảnh + soạn trước khi duyệt (chủ shop yêu cầu 24/09/2026)

*"Duyệt ảnh xong cần có phần soạn các thông tin sẵn để sẵn sàng đăng bài, đăng camp ads như tiêu đề,
content (AI suggest luôn sao cho phù hợp với ảnh đã sinh ra và được duyệt)."*

- `writer.ts` viết câu chữ TRƯỚC khi có ảnh ⇒ chỉ là NHÁP. Ngay sau khi ảnh được lưu, `captionFromImage()`
  (`lib/creative/caption.ts`, OpenAI Responses + `input_image`, route `creative.caption`) NHÌN ảnh và viết
  lại tiêu đề + nội dung chính. Luật giá y như `writer.ts`: sai ⇒ viết lại một lần ⇒ vẫn sai thì bỏ con số giá.
- Viết theo ảnh hỏng ⇒ GIỮ câu nháp, mẫu vẫn `GENERATED`; lý do ở `gen_error` (tiền tố `CAPTION_FALLBACK_PREFIX`)
  và thẻ mẫu nói ra. Không có cột mới.
- Tab Duyệt lô: mỗi mẫu `GENERATED` hiện khối **Sẵn sàng đăng** (xem trước bài như trên Facebook — tên fanpage
  theo cấu hình chụp của lô, đọc từ sổ `fanpages`) và nút **Soạn câu chữ**: sửa tay (đếm ký tự 40/500), hoặc
  **AI gợi ý theo ảnh** (2–3 phương án, không tự lưu). Mẫu tự làm dùng được như mẫu máy.
- Sửa được khi lô chưa duyệt (`PLANNED`/`PENDING_APPROVAL`) và còn hạn — điều kiện nằm TRONG câu `UPDATE`.
  Câu chữ nằm trong digest ⇒ **sửa câu chữ ⇒ cần bấm duyệt lại** (phiếu đã phát tự vô hiệu). Giá khác ERP
  chỉ cảnh báo. Quyền `ideas:write`; nhật ký ghi trước/sau.

Tệp: `lib/creative/{caption,copy-edit}.ts` · `lib/actions/creative-copy.ts` · `copy-editor.tsx` ·
`AdPreview` trong `variant-bits.tsx` · `tests/creative-copy.test.ts`.

## 5e. Mô hình ảnh và đường Batch

> **Đang chạy (chủ shop chốt lần hai 24/09/2026): `gpt-image-2.5-sunburst`, chất lượng VỪA, khổ 4:5, GỌI
> NGAY (`imageMode = SYNC`), trần 2 USD/ngày** — ước ~1,1 USD / lô 13 ảnh. Lần chốt đầu là "Cao + Batch"
> nhưng tài liệu mô hình của OpenAI ghi sunburst **không nhận Batch**. Đường Batch dưới đây vẫn nằm trong
> mã và bật được ở tab Cấu hình cho mô hình nhận nó (vd `gpt-image-2`, ~1,4 USD / lô ở mức cao).


- **Khi bật Batch** (`imageMode = BATCH`, mô hình nhận Batch): chất lượng do cấu hình · khổ dọc 4:5 `1088x1360` (bảng tin Facebook; hai
  cạnh bội số 16) · vẽ nốt lúc `batchFallbackHourVn = 2` ở `fallbackImageQuality = medium`.
  Trần `maxImageUsdPerDay = 2` KHÔNG đổi. `SYNC` giữ nguyên hành vi cũ (gọi ngay từng ảnh).
- **Giá là ƯỚC TÍNH, một bảng:** `IMAGE_MODEL_TOKEN_PRICE_PER_MTOK` (USD / 1 triệu token, developers.openai.com
  pricing đọc 24/09/2026) × số token ước tính (bảng token đầu ra theo chất lượng của gpt-image-1, quy theo diện
  tích; 1.000 token chữ + 3 ảnh × 1.500 token đầu vào) × 0,5 khi đi Batch. Mô hình lạ ⇒ tính theo mô hình đắt
  nhất. Ghi chi phí sau khi gọi cũng đọc ĐÚNG bảng ấy (`imageEditCostUsd`, × 0,5 cho dòng Batch). Một lô 13 ảnh
  cao 4:5 qua Batch ≈ 1,4 USD; gọi ngay cả lô ở mức cao ≈ 2,8 USD (vượt trần — lý do vẽ nốt hạ về mức vừa ≈ 1,1 USD).
- **Lượt dựng lô:** viết câu chữ cho MỌI ô `PLANNED`, kiểm trần NGÀY theo giá Batch (ô vượt trần ⇒ `GEN_FAILED`
  có lý do), gom điểm ảnh qua `gatherPixels` (đường duy nhất), tải ảnh tham chiếu lên Files API (`purpose:
  "vision"`) — `assertPixelSafe` chạy lại trước byte đầu tiên VÀ khi dựng từng dòng JSONL — rồi tạo MỘT lô
  (`/v1/batches`, `endpoint: "/v1/images/edits"`, `completion_window: "24h"`), mỗi dòng `custom_id` = id mẫu,
  thân JSON `images: [{ file_id }]`. Trạng thái nằm ở `creative_batches.plan.imageBatch` (không migration).
- **Lũy đẳng:** pha `SUBMITTING` được ghi TRƯỚC lời gọi, có điều kiện "chưa có `imageBatch`". Lượt gửi đứt giữa
  chừng KHÔNG gửi lại (có thể trả tiền hai lần) — tới mốc vẽ nốt thì bỏ và vẽ bằng gọi ngay.
- **Giữ chỗ trong trần:** lô đã gửi mà chưa về ảnh giữ chỗ (`reservedImageSpend`) cho tới khi dừng.
- **Kết quả:** `completed` ⇒ ảnh lưu + câu chữ theo ảnh (y đường gọi ngay) + `GENERATED`; dòng lỗi ⇒ `GEN_FAILED`
  CHỈ khi lô có ít nhất một dòng ra ảnh. Lô huỷ / hết hạn / hỏng, hoặc không dòng nào ra ảnh ⇒ ô ở lại để vẽ nốt.
- **Vẽ nốt:** tới `imageBatchFallbackAt()` (2:00 ngày chạy) mà lô còn chạy ⇒ huỷ; đợi OpenAI báo đã huỷ (nhận
  cả dòng đã xong) tối đa 30 phút, rồi vẽ ô còn thiếu bằng gọi ngay ở `medium`, dùng lại câu lệnh đã viết.
  OpenAI từ chối lô ngay lúc gửi ⇒ vẽ nốt NGAY (đợi tới 2:00 không đổi được kết quả).
- **Báo:** tóm tắt `buildBatch().imageBatch` đi vào `sync_runs.detail` của job `creative-loop`. Tin "chờ duyệt"
  vẫn chỉ bắn khi lô sang `PENDING_APPROVAL`.

> **Mâu thuẫn tài liệu cần chủ shop biết:** trang mô hình `gpt-image-2.5-sunburst` (và `-flare`) trên
> developers.openai.com ghi **"Batch · v1/batch · Not supported"** (đọc 24/09/2026), và trang giá chưa niêm yết giá
> Batch cho hai mô hình này; `gpt-image-2` và `gpt-image-1` ghi "Supported". Máy vẫn gửi thử (tài liệu của mô
> hình mới có thể đi sau API) — bị từ chối thì vẽ ngay bằng gọi ngay ở `medium` và tab Cấu hình cảnh báo. Muốn
> đúng "Cao + Batch" thì đổi mô hình sang `gpt-image-2` (cùng giá token, Batch được hỗ trợ).

Tệp: `lib/integrations/openai/batch.ts` · `lib/creative/image-batch.ts` · `lib/creative/generate.ts` ·
`lib/constants/creative-loop.ts` (giá) · `tests/creative-image-batch.test.ts`.

## 6. Đã dựng gì, ở đâu

| Phần | Tệp | Việc |
|---|---|---|
| Nền | `lib/constants/creative-loop.ts` · `lib/creative/{plan,judge,learn,schedule,images}.ts` · 7 bảng (`drizzle/0117_creative_loop.sql`) | hợp đồng, hàm thuần, lược đồ |
| Sinh | `lib/creative/{vision,writer,generate}.ts` · `lib/integrations/openai/images.ts` · `lib/queries/creative-plan.ts` | đọc ảnh nguồn → gen; lập lô; LLM viết (giá đúng ERP); gpt-image sửa ảnh sản phẩm thật; trần ảnh/ngày |
| Đo / chấm / học | `lib/queries/creative-loop.ts` · `lib/creative/evaluate.ts` | chi hạt AD + đơn theo `ad_id`; chấm; chốt thư viện; sổ phán quyết + sổ học; xoá ảnh mẫu thua sau hạn |
| Bàn tay | `lib/integrations/facebook/ads-write.ts` (thêm hàm) · `lib/marketing/creative-write-gate.ts` · `lib/creative/{approval,story-spec,publish,extend}.ts` · `lib/actions/{creative,creative-extend}.ts` | cổng thuần có thứ tự; phiếu duyệt lô; đăng; tắt theo luật; tắt tay; tiêu thêm (hai bước) |
| Màn hình | `/marketing/creatives` — tab Duyệt lô · Đang chạy · Thư viện · Máy đã học gì · Nguồn ảnh · Cấu hình | mọi việc của người nằm ở đây |
| Vòng | `lib/creative/{loop,notify}.ts` · job `creative-loop` · `scripts/scheduler.mjs` | một lượt tất định; tin báo Lark/Telegram |

### Quyết định dựng đáng ghi lại

- **Hạn hiệu lực của một mẫu đọc từ SỔ tiêu thêm** (`extendedEndAtOf`), không từ khung gốc của lô.
  Bắt được khi ghép gói: lượt chấm từng chuyển mẫu đã tiêu thêm sang ENDED và thôi xét luật tắt
  trong khi Facebook vẫn đang tiêu tiền. Có bài kiểm hồi quy.
- **Luật TẮT lấy từ ảnh chụp của lô; luật GIỮ và ngưỡng THẮNG lấy từ cấu hình hiện tại.** Tắt là hành
  động người duyệt đã cho phép trên đúng bộ luật đã thấy; chấm tốt/kém không chạm tiền nên luật điền
  sau vẫn chấm được mẫu cũ.
- **"Đơn chốt" = đơn đã xác nhận** (`CONFIRMED_ORDER`), cùng định nghĩa với bảng quyết định `/ads`.
- **Phiếu tiêu thêm hết hạn sau 15 phút**; bấm lần hai sau khi đã áp thì phiếu cũ vô hiệu.
- **Mẩu mẫu gửi tin nhắn về fanpage khác fanpage đã khai ⇒ không đăng.**
- **Tắt vòng (`enabled = false`) vẫn CHẤM và vẫn TẮT theo luật** — chỉ không đăng / không dựng mới.
- `focusProductIds` = CHỈ test các mã này (cả ô khai thác lẫn thăm dò).

### Rủi ro còn lại (đã biết, chưa chặn được bằng mã)

- Phản hồi "tạo nhóm" rơi mất sau khi Facebook đã tạo ⇒ một nhóm mồ côi ACTIVE không có mẩu (không
  tiêu tiền, nhưng ERP không biết nó). Tên nhóm mang ngày lô + số ô để tra tay.
- Các hàm ghi mới chưa từng chạy trên Facebook thật — lượt đầu nên là MỘT lô nhỏ (`batchSize` 2–3).
- Chi phí đọc ảnh / viết chữ bằng model OpenAI in "CHƯA BIẾT" vì bảng giá AI của kho chỉ có Claude.
- Đường Batch ảnh (§5e) chưa từng gọi OpenAI thật: tên trường lấy từ tài liệu, kiểm thử chạy trên OpenAI giả.
  Số token mỗi ảnh của gpt-image-2.x là ước tính (OpenAI chưa công bố bảng) — đối chiếu `gen_cost_usd` thật
  sau lô đầu.

## 7. Chủ shop còn phải làm gì để vòng CHẠY THẬT

| Việc | Vì sao máy không tự làm được |
|---|---|
| Cấp lại System User token có **`ads_management`** + quyền **tạo quảng cáo cho fanpage** test | token hiện chỉ `ads_read` |
| Dựng **một chiến dịch TEST** (mục tiêu Tin nhắn, ngân sách ở cấp nhóm — ABO) và **một mẩu QC mẫu** trong đó | máy không tạo chiến dịch và không tự đoán đối tượng |
| Điền `creative.config`: fanpage · tài khoản · chiến dịch test · mẩu mẫu · **luật tắt · luật giữ** | ngưỡng là quyết định kinh doanh (mục 38) |
| Đặt `ADS_WRITE_ENABLED=true`, `ADS_WRITE_MODE=COPILOT`, `CREATIVE_LOOP_EVERY_MINUTES=10` ở **GitHub Variables** rồi deploy (xoá Variable = TẮT ở lần deploy sau; gõ tay vào `.env` trên VPS sẽ bị đè); `OPENAI_API_KEY` phải có | đổi lịch và mở đường ghi là việc của chủ shop (mục 7) |
| Bật `enabled` ở tab Cấu hình | công tắc mềm của vòng |
| Bấm **Nhập ảnh sản phẩm từ Pancake** (hoặc tải tay ảnh sản phẩm thật) cho các mã muốn test | máy không sinh mẫu cho sản phẩm nó không nhìn thấy |
| Bấm **Nhập mẫu thắng / mẫu tốt từ Facebook** (token hiện có `ads_read` là đủ — chỉ GET) | chọn mẩu nào làm mẫu cha là việc của người |
| ~~Chốt ba con số "đề xuất" ở §3~~ — **ĐÃ CHỐT 24/09/2026** (`b32a1fac`: 200.000đ/lượt · 1.000.000đ/ngày · 2 USD/ngày) | ngưỡng tiền |

## 8. BLOCKED / HUMAN GATE

- ⏸ Token `ads_management` — chủ shop.
- ⏸ Luật tắt / luật giữ — chủ shop tự điền (đã nói 24/09).
- ⏸ Quyền: duyệt lô và tiêu thêm đang dùng lại `expenses:write` (giống bàn tay Nấc 3). Một quyền riêng
  hẹp hơn là đổi vai trò (mục 7) ⇒ chủ shop quyết.

## 9. Vận hành: công tắc tắt khẩn cấp đường ghi quảng cáo

`ADS_WRITE_ENABLED` tắt được mọi thứ nhưng là biến môi trường: đổi phải deploy lại, 15–20 phút. Công
tắc khẩn cấp đóng đường ghi trong vài giây. Luật: `lib/constants/ads-kill-switch.ts`; chốt đọc ở ĐÚNG
MỘT chỗ — `graphPost()` trong `lib/integrations/facebook/ads-write.ts`, ngay trước lời gọi mạng, không
đệm. Kiểm thử: `tests/ads-kill-switch.test.ts` (kéo ⇒ 0 lời gọi ghi ra mạng; lỗi đọc ⇒ chặn).

**Kéo công tắc** (một trong hai cách, có hiệu lực ở lời gọi Facebook KẾ TIẾP):

- Màn hình `/marketing/creatives` → tab **Đang chạy** hoặc **Cấu hình** → ô *Công tắc tắt khẩn cấp* →
  ghi lý do → bấm. Quyền: `expenses:write` (người duyệt lô) hoặc `settings:manage`.
- Ops, không cần giao diện: workflow **ops-vps** → `set-setting` với arg (GIỮ dấu nháy đơn — lệnh
  đi qua `sh -c`; lý do không được chứa dấu nháy đơn):
  `ads.write.kill '{"killed":true,"reason":"<vì sao>","by":"ops","at":"<giờ>"}'`.
  `set-setting` GỘP vào giá trị cũ, nên luôn ghi đủ `by`/`at` để không giữ lại tên người bấm trước.

**Nhả công tắc:** màn hình (chỉ `settings:manage` — nhả là cho máy tiêu tiền tiếp), hoặc ops
`set-setting` arg `ads.write.kill '{"killed":false,"reason":"<vì sao>","by":"ops","at":"<giờ>"}'`. Mọi lượt bấm trên màn hình ghi nhật
ký (`ADS_WRITE_KILL_ENGAGE` / `ADS_WRITE_KILL_RELEASE`) kèm người, lúc, lý do.

**Khi công tắc KÉO, cái gì bị chặn, cái gì vẫn đi:**

| Lời gọi | Kéo công tắc |
|---|---|
| Tải ảnh · tạo bài · tạo nhóm · tạo mẩu | CHẶN |
| Tiêu thêm (đặt lại ngân sách trọn đời) | CHẶN |
| Đổi ngân sách ngày chiến dịch — kể cả HẠ | CHẶN |
| Tạm dừng nhóm / chiến dịch (`status = PAUSED`, không kèm trường nào khác) | **VẪN ĐI** |

Vì sao tạm dừng vẫn đi: người kéo công tắc muốn TIỀN NGỪNG CHẢY. Nhóm test đã tạo vẫn tiêu tới
`end_time`, và luật tắt sớm là thứ duy nhất của ERP dừng được chúng — chặn nó là giữ tiền chảy đúng
lúc cần nó dừng. Tạm dừng đảo ngược được bằng một cú bấm trong Ads Manager; tiền đã tiêu thì không.
Phân loại đọc từ CHÍNH các trường sẽ gửi đi (đúng một trường `status` = `PAUSED`), không từ một cờ nơi
gọi khai. Hạ ngân sách ngày vẫn bị chặn vì cổng không tự kiểm được chiều mà không gọi Facebook, và một
lỗi đơn vị (đồng ↔ xu) trông y hệt một lượt hạ.

Muốn chặn cả tạm dừng (ví dụ nghi chính luật tắt đang tắt nhầm) ⇒ đóng `ADS_WRITE_ENABLED` (chậm hơn,
tuyệt đối).

**Mọi nhánh lỗi rơi về ĐÓNG:** không đọc được CSDL, JSON hỏng, `"killed"` không phải đúng `true`/`false`
(chuỗi `"false"`, `0`, thiếu trường) ⇒ coi như đang kéo. Không có dòng nào = chưa ai kéo = mở.

**Lô đang chờ đăng khi công tắc kéo:** lượt đăng ghi một dòng `DENIED · KILL_SWITCH` vào sổ và dừng
TRƯỚC mọi lời gọi Facebook — lô giữ nguyên ĐÃ DUYỆT, mẫu giữ nguyên, không thành `PUBLISH_FAILED`. Nhả
trước giờ chạy ⇒ lượt kế tiếp đăng tiếp; quá giờ ⇒ lô hết hạn, không đồng nào được chi.

Công tắc chỉ LÀM HẸP: `{"killed":false}` không mở được đường ghi khi `ADS_WRITE_ENABLED` đang tắt.
