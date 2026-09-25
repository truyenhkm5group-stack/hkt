# Vòng mẫu quảng cáo — đặc tả và trạng thái

> **File trạng thái DUY NHẤT của vòng mẫu.** Đây là Nấc 4 (NỘI DUNG) của
> `docs/marketing-ai-department.md`. Cập nhật: **24/09/2026** · **ĐÃ DỰNG ĐỦ vòng** (sinh · đăng · đo ·
> chấm · học · màn hình) — **CHƯA CHẠY THẬT**: chờ các việc của chủ shop ở §7.
>
> Hợp đồng mã nguồn: `lib/constants/creative-loop.ts` (mọi con số, mọi trần, từ vựng gen, từ vựng DNA).
> Hàm thuần: `lib/creative/{plan,design,judge,learn,schedule}.ts`. Kiểm thử: `tests/creative-loop.test.ts`,
> `tests/creative-design.test.ts`.
>
> **24/09/2026 (lần hai): lô = 10 THIẾT KẾ SẢN PHẨM MỚI + 1 mockup cho mỗi mẫu thắng chủ shop chọn; trần 20
> mẫu / 4.000.000đ mỗi ngày chạy — §5f.**
>
> **25/09/2026: gen ảnh bằng tay (10 ảnh / lần) · tích chọn bài · tên chiến dịch / nhóm / quảng cáo sửa được · MỖI BÀI MỘT
> CHIẾN DỊCH — §5i.**

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
14:00 hôm trước  ĐỌC DNA  vài mã còn thiếu DNA (mô hình đọc ảnh, §5f)
                 LẬP LÔ   composeDailyBatch() — 10 ô THIẾT KẾ MỚI + 1 mockup / mẫu thắng được chọn, hạt giống = ngày chạy
                 VIẾT     LLM viết câu lệnh ảnh (EN) + câu chữ + tiêu đề (VI) cho từng ô
                 SINH     gpt-image SỬA ảnh sản phẩm THẬT theo câu lệnh — không vẽ sản phẩm từ con số 0
                          (mặc định gửi cả lô qua Batch API, rẻ 50% — §5e)
02:00            VẼ NỐT   Batch còn chưa xong ⇒ huỷ, ô thiếu ảnh vẽ bằng gọi ngay ở chất lượng vừa (§5e)
                 ⇒ lô "Chờ duyệt", báo Lark/Telegram
tối / sáng sớm   NGƯỜI    xem ảnh, gạt ảnh không ưng, bấm DUYỆT CẢ LÔ (thấy rõ tổng tiền, khung giờ, luật tắt + luật riêng từng ô)
05:30            HẠN      chưa duyệt ⇒ lô "Quá hạn", KHÔNG một đồng nào được chi
trước 06:00      ĐĂNG     mỗi mẫu: tải ảnh → bài ẩn trên fanpage → CHIẾN DỊCH riêng (TẮT) → nhóm QC (trọn đời 200.000đ,
                          06:00→06:00) → mẩu QC → bật chiến dịch (§5i)
06:00 → 06:00    CHẠY     Facebook tự dừng ở end_time — ERP chết giữa chừng cũng không tiêu quá ngân sách đã duyệt
mỗi lượt tick    ĐO+TẮT   chi cấp mẩu (ad_spends hạt AD) + đơn theo ORDER_AD_ID → judgeVariant() → luật tắt ⇒ tắt nhóm
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
   **Ngoại lệ có chủ đích — ô `DESIGN` (chủ shop 24/09/2026):** ô THIẾT KẾ MỚI quảng cáo một mẫu CHƯA SẢN
   XUẤT; chủ shop tạo sản phẩm trên Pancake đúng mã `TK-…`, nhận đơn như hàng thường rồi mới sản xuất (shop
   bán trước). Ranh giới 2 KHÔNG nới: ảnh tham chiếu vẫn chỉ là ảnh sản phẩm THẬT của mã cha (chất ảnh,
   thương hiệu), `assertPixelSafe` vẫn đòi `PRODUCT_PHOTO`, câu lệnh dặn "thiết kế mới, KHÔNG sao chép mẫu
   tham chiếu". Ô khai thác / thăm dò / tự làm giữ nguyên ranh giới 3.
4. **Một cửa ghi Facebook.** Mọi lời gọi ghi nằm trong `lib/integrations/facebook/ads-write.ts`, qua
   cùng chốt cứng `ADS_WRITE_ENABLED` và nấc `COPILOT`. `tests/ads-write.test.ts` quét toàn kho.
5. **Máy chỉ làm việc trong chỗ NGƯỜI cho phép**, và chỉ đụng chiến dịch / nhóm / mẩu do chính nó tạo.
   Máy không sửa đối tượng, không đụng quảng cáo của marketer. **Hai ngoại lệ có chủ đích về tạo chiến
   dịch:** (a) MỖI BÀI MỘT CHIẾN DỊCH (§5i, chủ shop 25/09/2026) — chiến dịch riêng của từng bài tạo từ các
   trường của chiến dịch test (người dựng), luôn TẮT tới bước cuối, tiền vẫn ở NHÓM trọn đời 200.000đ;
   (b) scale mẫu thắng (§5g) — máy SAO CHÉP một trong hai chiến dịch MẪU người dựng, bản sao luôn TẮT,
   chỉ bật khi người duyệt.
6. **Không nguồn tiền mới.** Chi đọc từ `ad_spends` hạt `AD` (đã đo khớp 0 đồng với hạt chiến dịch,
   `docs/ads-measurement-audit-2026-09-22.md` §4). Kết quả đơn đọc qua `ORDER_OUTCOME_FAST`. Không bảng
   nào của vòng mẫu được báo cáo lợi nhuận/lương đọc.

## 3. Hàng rào tiền — trần cứng của mã nguồn (`CREATIVE_HARD_LIMITS`)

| Trần | Giá trị | Nguồn |
|---|---|---|
| Mẫu đăng mỗi lô | 20 | chủ shop 24/09 (lần hai; trước đó 10) |
| Ngân sách trọn đời một mẫu (khung test) | 200.000đ | chủ shop 24/09 |
| Khung test | 1 ngày | chủ shop 24/09 |
| Tổng cam kết test / ngày chạy | 4.000.000đ | = 20 × 200.000đ, chủ shop 24/09 (lần hai) |
| "Tiêu thêm" một lần bấm | 200.000đ | chủ shop 24/09 |
| "Tiêu thêm" toàn shop / ngày | 1.000.000đ | chủ shop 24/09 |
| Ảnh sinh / ngày | 30 | chặn vòng lặp hỏng |
| Chi sinh ảnh / ngày | 2 USD | chủ shop 24/09 — lô đầy 20 ảnh ở cấu hình đang chạy (gọi ngay · vừa · 4:5) ≈ 1,7 USD; ở "Cao + Batch" ≈ 2,2 USD thì ô vượt thành "Sinh ảnh lỗi" có lý do |

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

**Đơn chốt** = đơn quy về mẩu bằng `ORDER_AD_ID` (`lib/queries/ads-attribution-link.ts` — CÙNG biểu
thức với cấp mẩu của `/ads`), `ORDER_OUTCOME <> 'CANCELLED'`. Hai đường, theo thứ tự thẩm quyền:
`ad_id` Pancake gửi; không có thì bài viết của đơn, CHỈ khi bài ấy thuộc ĐÚNG MỘT mẩu (bài nhiều mẩu cùng
chạy ⇒ nhập nhằng ⇒ không nối). Mỗi đơn đi một đường, số đo mang cả hai con số (`attribution.direct` /
`attribution.viaPost`) và sổ phán quyết chụp lại (`ordersDirect` / `ordersViaPost`). Màn hình in cạnh nó
số đơn giao thành công và hoàn (theo `ORDER_OUTCOME`), vì mẫu nhiều đơn mà hoàn cao vẫn là mẫu lỗ, và
**chi / đơn + doanh thu lên đơn** làm BẰNG CHỨNG (không đổi ngưỡng, không tô màu).

**Luật TẮT vẫn đếm đơn mang `ad_id`** (`KILL_RULE_ORDER_BASIS = "DIRECT_AD_ID"`, 25/09/2026): luật tắt là
đường duy nhất số đơn tự dẫn tới một lượt GHI Facebook, và người duyệt lô đã cho phép nó theo định nghĩa
cũ. Chuyển luật tắt sang `ORDER_AD_ID` là quyết định của chủ shop (HUMAN GATE).

> **Giới hạn đã biết:** Pancake gửi `ad_id` cho **72,6%** đơn có nguồn Facebook (đo 22/09); đường bài
> viết lấp thêm phần đơn của bài chỉ thuộc một mẩu (mẫu tự đăng của vòng là đúng loại ấy). Đơn không có
> dấu vết nào, hoặc đến từ bài nhiều mẩu cùng chạy, vẫn không được đếm ⇒ ngưỡng "> 100 đơn" có thể đếm
> THIẾU, không đếm thừa. Không lấp bằng suy đoán.
>
> **Chưa đổi theo:** đếm MOQ thiết kế (`lib/queries/creative-moq.ts`, đường `viaAd`) vẫn đi bằng
> `orders.ad_id` — nó tự dựng nháp lệnh sản xuất nên đổi định nghĩa là việc riêng, có người quyết.

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
- **Đăng trước** ô máy lập (`publishOrder`: tự làm → thiết kế mới → mockup → thăm dò); trần số mẫu/lô không đổi — mẫu tự làm chiếm chỗ ô máy lập.
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

## 5f. Thiết kế sản phẩm mới + mockup có luật riêng (chủ shop 24/09/2026, lần hai)

*"Ngoài ảnh biến thể của mẫu cũ, thiết kế SẢN PHẨM MỚI (áo/váy chưa từng có) lấy DNA từ các mã đã bán tốt và
các mẩu quảng cáo lịch sử có chỉ số tốt — mẫu mới PHẢI KHÁC các mẫu cũ. Thiết kế mới được quảng cáo và nhận đơn
như hàng thường (sản xuất sau)."*

**Lô mỗi ngày** (`composeDailyBatch`, hàm thuần, tất định theo ngày lô) = `designSlots` (10) ô **THIẾT KẾ MỚI**
+ 1 ô **MOCKUP** cho MỖI mẫu thắng chủ shop bật "Chạy mockup hằng ngày" (công tắc trên thẻ nguồn `OWN_AD` /
thẻ ảnh sản phẩm thật ở tab Nguồn ảnh — `mockupSourceIds` / `mockupProductIds`, action `setDailyMockup`, quyền
`ideas:write`, lưu qua đúng đường cấu hình) + `exploreSlots` (mặc định 0) ô thăm dò. Mỗi mẫu 200.000đ, mục
tiêu tin nhắn — đường đăng qua mẩu mẫu / chiến dịch test không đổi. Thứ tự đăng **tự làm → thiết kế →
mockup → thăm dò**; trần cắt ở cuối. `extraCandidates` = số ô THIẾT KẾ sinh dư (mặc định 0).

**DNA** — từ vựng ĐÓNG `DESIGN_DNA_VOCAB` (nhóm hàng · dáng · độ dài · cổ · tay · chất liệu · hoạ tiết · họ màu ·
chi tiết · phong cách), phiên bản riêng `DESIGN_DNA_VERSION`. DNA của mã đang có (kể cả mã đã gỡ có ảnh) đọc
bằng mô hình đọc ảnh (`lib/creative/dna.ts`, route `creative.dna`, phanh tiền AI ngày, sổ `ai_interactions`),
tối đa `PRODUCT_DNA_PER_BUILD` mã mỗi lượt dựng lô, ảnh: nguồn `PRODUCT_PHOTO` → `OWN_AD` gắn mã →
`products.image`. Lũy đẳng (`product_dna`, một dòng mỗi mã); đọc hỏng thử lại sau 24 giờ; không có khoá API ⇒
bỏ qua, không ghi gì.

**Mã cha** (`loadDesignInputs`, chỉ đọc): đơn giao thành công / hoàn 90 ngày qua `ORDER_OUTCOME_FAST` (không
viết điều kiện kết quả đơn thứ hai), nối đơn → mã qua `order_items.product_id` (bỏ quà tặng); chi / tin nhắn
hạt `AD`. Đủ điều kiện khi ≥ 3 đơn giao HOẶC chi/tin < 4.000đ trên ≥ 5 tin — và có DNA. Điểm = giao × tỷ lệ
giao (`designParentScore`). Các con số này là **đề xuất của người dựng** (`DESIGN_PARENT_RULES`).

**Lập thiết kế** (`planDesigns`): cha trội (A, bắt buộc có ảnh sản phẩm thật) × mẹ (B), chọn có trọng số theo
điểm; lai từng thuộc tính bằng lấy mẫu Thompson trên thống kê DNA của các thiết kế đã test (`dnaStats`, học
như `learn.ts`); đột biến 25% mỗi thuộc tính (trừ nhóm hàng). **MỚI LẠ:** DNA phải khác MỌI mã đang có và MỌI
thiết kế 30 ngày gần nhất ở ≥ 2 thuộc tính — thuộc tính CHƯA BIẾT không tính là khác. Không đủ ⇒ `shortfall`,
không nhồi. Giá đề nghị = giá của A (một giá duy nhất), không suy được ⇒ `NULL` và câu chữ không ghi giá.

**Bảng `design_concepts`** (migration `0120`): mã `TK-YYMMDD-NN` (duy nhất; chủ shop tạo sản phẩm Pancake
đúng mã này), DNA, mã cha, lý do, ảnh đại diện, trạng thái `DRAFT · TESTING · WIN · LOSE · PRODUCTION`, giá đề
nghị. Ô nối bằng `creative_variants.design_concept_id` (chế độ ô `DESIGN`). Trạng thái do lượt chấm đẩy tới
(chỉ tiến); `PRODUCTION` chỉ NGƯỜI bấm (`setDesignProduction`). Số đơn của thiết kế = đơn mang `ad_id` của các
mẩu mang nó (`variantMetrics`, chỉ đọc) — tab **Thiết kế mới**.

**Sinh ảnh:** cùng mô hình / khổ / chất lượng của cấu hình; ảnh tham chiếu DUY NHẤT là ảnh sản phẩm thật của A;
câu lệnh = mô tả thiết kế tất định theo DNA (`designPromptEn`) + chỉ thị gen + `NEW_DESIGN_CLAUSE` ("thiết kế
mới, KHÔNG sao chép"). Gen quảng cáo của ô thiết kế luôn có người mẫu mặc (không `NONE`, không trải phẳng).
Câu chữ qua `writer` + `caption` hiện có, được báo "mẫu mới", giá = giá đề nghị.

**Luật riêng theo mã cho ô mockup** (chủ shop 24/09; `MOCKUP_RULES`): lịch sử 60 ngày các mẩu QC hạt `AD` của
chính mã (mẩu có tin nhắn) ⇒ **TẮT** khi chi/tin nhắn > p75 (sàn chi 50.000đ), **GIỮ** khi ≤ trung vị; dưới 5
mẩu ⇒ luật chung của lô. Chụp vào `creative_variants.rules_snapshot` lúc lập lô; `judgeVariant` / lượt chấm
dùng luật của ô (`effectiveJudgeConfig`); **phiếu duyệt khoá cả luật riêng từng ô** (`approvalDigest` — ô
không có luật riêng thì digest y như cũ); đường tắt (`applyKills` → `pauseCreativeVariant`) chấp nhận luật
riêng của ô như luật thuộc lô.

Tệp: `lib/creative/{design,dna}.ts` · `composeDailyBatch` trong `lib/creative/plan.ts` ·
`lib/queries/creative-design.ts` · `lib/actions/creative-design.ts` · `design-tab.tsx` · `drizzle/0120_creative_design_concepts.sql` ·
`tests/creative-design.test.ts`.

## 5g. Scale mẫu thắng — chiến dịch NHÁP chờ duyệt (chủ shop quyết 24/09/2026)

*"Mẫu test thắng thì: scale ngân sách, scale camp, scale nhóm, chạy mục tiêu tối đa hoá lượt mua qua tin
nhắn và khách hàng tiềm năng (tạo bản nháp chờ duyệt)."* Ngân sách đề nghị ban đầu **500.000đ/ngày mỗi
chiến dịch nháp**. Vẫn nấc `COPILOT`: máy DỰNG nháp đang TẮT, NGƯỜI bấm duyệt thì mới BẬT.

**Đây là NGOẠI LỆ có chủ đích với ranh giới §2.5 ("máy không tạo chiến dịch").** Máy chỉ được có chiến
dịch mới bằng đúng MỘT cách: **sao chép một trong hai chiến dịch MẪU do NGƯỜI dựng** (id khai ở
`creative.config.scaleTemplates`). Máy không tạo chiến dịch từ số không, không đổi đối tượng / mục tiêu /
biểu mẫu — chép NGUYÊN; chỉ thay BÀI QUẢNG CÁO (ảnh + câu chữ của mẫu thắng) và NGÂN SÁCH NGÀY.

Luồng:

```
lượt chấm   mẫu THẮNG / HỨA HẸN ⇒ 2 dòng PROPOSED (mua qua tin nhắn · khách tiềm năng) — 0 lời gọi Facebook
            ⇒ MỘT tin Lark/Telegram cho các đề nghị chưa báo (đóng dấu notified_at khi gửi được)
người bấm   "Dựng nháp" ⇒ đọc chiến dịch mẫu (đúng 1 nhóm + 1 mẩu, đúng mục tiêu, ngân sách NGÀY)
            ⇒ POST /{mẫu}/copies  deep_copy=true · status_option=PAUSED · rename_options (tiền tố "[VM scale …]")
            ⇒ đọc bản sao (phải TẮT; lỡ đang bật ⇒ tắt ngay, dừng) ⇒ tạo bài từ ảnh + câu chữ mẫu thắng theo khuôn
              bài của bản sao ⇒ gắn vào mẩu (POST /{ad} creative) ⇒ đặt daily_budget ĐÚNG CẤP (CBO: chiến dịch,
              ABO: nhóm — đọc từ bản sao) ⇒ DRAFT, vẫn TẮT
người bấm   "Duyệt chạy" (hai bước: đề nghị → phiếu HMAC → áp) ⇒ tính lại, đọc LẠI bản sao trên Facebook
            (ai sửa bài/ngân sách trên Ads Manager sau khi phát phiếu ⇒ không bật) ⇒ bật mẩu → nhóm → CHIẾN DỊCH cuối
người bấm   "Tắt" (chỉ làm giảm tiền, công tắc khẩn cấp vẫn cho đi) · "Bỏ qua" đề nghị / nháp hỏng
```

| Trần / luật | Giá trị | Nguồn |
|---|---|---|
| Ngân sách ngày một chiến dịch scale | ≤ 500.000đ (cả CHECK ở CSDL) | chủ shop 24/09 |
| Tổng ngân sách ngày các chiến dịch scale ĐANG BẬT (`ACTIVE`) | ≤ 5.000.000đ | **ĐỀ XUẤT, CHỜ CHỦ SHOP CHỐT** |
| Nháp mỗi mẫu thắng | ≤ 2 (một mỗi loại); khoá duy nhất (mẫu, loại) | chủ shop 24/09 |
| Nguồn sao chép | CHỈ hai id mẫu đã khai (khác ⇒ `NOT_SCALE_TEMPLATE`) | ngoại lệ này |
| Căn cứ | phán quyết SỐNG `WIN` hoặc `PROMISING` (khác ⇒ `NOT_WINNER`) | §4 |

Cổng `gateScaleWrite` (hàm thuần, thứ tự khoá bằng bài kiểm): `HARD_DISABLED → MODE_OFF →
CONFIG_INCOMPLETE → NOT_APPROVED → APPROVAL_MISMATCH (bật) → NOT_SCALE_TEMPLATE (sao chép) → NOT_OUR_AD →
[tắt dừng ở đây] → NOT_WINNER → SCALE_DUPLICATE → OVER_SCALE_BUDGET → OVER_SCALE_DAILY_CAP (bật)`.

**Hỏng giữa chừng thì không có nửa nào đang chạy.** Bản sao sinh ra TẮT; mọi bước dựng nháp không bật gì;
bước bật đi mẩu → nhóm → chiến dịch nên chiến dịch (công tắc tổng) chỉ bật khi hai bước trước đã xong. Dựng
hỏng sau khi đã sao chép ⇒ `FAILED`, ô ghi id bản sao để người xoá tay, và KHÔNG dựng lại (mốc
`copy_attempted_at` ghi TRƯỚC lời gọi sao chép: phản hồi rơi mất vẫn biết là có thể đã có bản sao mồ côi).

Tham số Graph API (đọc 24/09/2026): `developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/`
(`deep_copy` — đồng bộ khi ≤ 3 mẩu con, nên mẫu phải có đúng 1 mẩu; `status_option` ACTIVE · PAUSED ·
INHERITED_FROM_SOURCE; `rename_options`; trả `copied_campaign_id` + `ad_object_ids`) và
`…/reference/adgroup/` (cập nhật `creative` của mẩu). Không có `copied_campaign_id` ⇒ không đoán, ghi FAILED.

Tệp: `lib/creative/scale.ts` (đường ghi) · `lib/integrations/facebook/ads-write.ts` (sáu hàm mới) ·
`gateScaleWrite` trong `lib/marketing/creative-write-gate.ts` · `lib/queries/creative-scale.ts` ·
`lib/actions/creative-scale.ts` · khối "Scale mẫu thắng" ở tab Đang chạy (`scale-panel.tsx`,
`scale-actions.tsx`) · ô cấu hình ở tab Cấu hình · `drizzle/0121_creative_scale_drafts.sql` ·
`tests/creative-scale.test.ts`.

**Chủ shop phải dựng trên Ads Manager (hai chiến dịch mẫu):** mỗi chiến dịch ĐÚNG một nhóm + một mẩu, để
TẮT; ngân sách NGÀY (CBO hoặc ABO đều được, không dùng trọn đời); fanpage của nhóm = fanpage đã khai.
(1) *Tối đa lượt mua qua tin nhắn*: mục tiêu **Doanh số** (`OUTCOME_SALES`), vị trí chuyển đổi **Ứng
dụng nhắn tin**, mục tiêu hiệu quả tối đa lượt mua qua tin nhắn, mẩu ảnh đơn nút "Gửi tin nhắn".
(2) *Khách hàng tiềm năng*: mục tiêu **Khách hàng tiềm năng** (`OUTCOME_LEADS`), biểu mẫu tức thì đã
tạo sẵn, mẩu ảnh đơn nút đăng ký. Rồi dán hai id chiến dịch vào tab Cấu hình → "Scale mẫu thắng".

## 5h. MOQ thiết kế mới — đủ 50 đơn thì máy dựng NHÁP lệnh sản xuất (chủ shop chốt 24/09/2026)

*"MOQ = 50 đơn."* Thiết kế mới bán như hàng thường (COD, sản xuất sau); khi một thiết kế gom đủ
**`DESIGN_MOQ.minOrders` = 50 ĐƠN** thì máy dựng MỘT nháp `production_orders` và gửi MỘT tin báo. Hằng số chỉ
nằm ở `lib/constants/creative-loop.ts` (`DESIGN_MOQ`, `designMoqReached` — ranh giới `>=`).

**Đếm gì.** Đếm ĐƠN, không đếm sản phẩm (khách mua 3 cái vẫn là một đơn). Đơn = population `CONFIRMED_ORDER`
và KHÔNG huỷ theo `ORDER_OUTCOME_FAST` — đúng "đơn chốt" (`bookedOrders`) của vòng mẫu. KHÔNG dùng "giao thành
công": thiết kế chưa sản xuất thì chưa có gì để giao. Đơn huỷ · xoá · Mới chưa chốt không tính.

| Đường | Nguồn | Ghi chú |
|---|---|---|
| (a) `viaAd` | `orders.ad_id` ∈ `fb_ad_id` của các mẩu thuộc biến thể có `design_concept_id` | cùng đường với cột "Đơn chốt"; Pancake gửi `ad_id` cho ~3/4 đơn Facebook ⇒ đếm THIẾU, không thừa |
| (b) `viaCode` | đơn có dòng KHÔNG PHẢI QUÀ là sản phẩm Pancake `custom_id` = mã TK (so khớp `upper(trim())`), nối qua `order_items.product_id` hoặc `variant_id → product_variants.product_id` | đường quan hệ của `lib/queries/product-code.ts`, không dò chuỗi SKU / tên |
| **MOQ** | HỢP (a) ∪ (b) theo id đơn | đơn thấy ở cả hai đường tính MỘT lần (`both`) |

**Số lượng** (`total_qty` của nháp) = tổng `quantity` các dòng mã TK, bỏ `is_bonus`. Màu / size đọc từ mẫu mã
(`product_variants.color/size`); thiếu một trong hai ⇒ vẫn cộng vào tổng nhưng KHÔNG chia vào ma trận, kể ra ở
`note`. Đơn chỉ thấy qua quảng cáo (`adOnly`, không có dòng mã TK — vd dòng gõ tay) ⇒ khách đặt bao nhiêu cái
của thiết kế là CHƯA BIẾT: không cộng, không đoán từ tên hàng, kể ra ở `note`.

**Nháp.** `status = 'DRAFT'` (trạng thái nháp sẵn có của trang Kế hoạch đặt hàng), mã `PO-<mã TK>`,
`product_id` = sản phẩm Pancake mang mã (không có ⇒ `NULL`, tên "Thiết kế TK-…"), `unit_cost = NULL` (không
căn cứ giá gia công — CHƯA BIẾT, không phải 0đ; migration bỏ NOT NULL của cột), xưởng trống, không hạn.
`created_by` = "Máy · vòng mẫu (MOQ)". **Máy KHÔNG gửi xưởng** (`DRAFT → SENT` chỉ qua `setProductionStatus`,
người bấm) và **KHÔNG đặt `design_concepts.status = 'PRODUCTION'`**.

**Lũy đẳng.** Khoá là `design_concepts.moq_reached_at`, ghi CÙNG giao dịch với nháp (cập nhật có điều kiện
`moq_reached_at IS NULL`). Chạy lại ⇒ không nháp thứ hai; người xoá nháp ⇒ `production_order_id` về `NULL` nhưng
mốc còn ⇒ máy KHÔNG dựng lại (xoá nháp là một quyết định). Mã `PO-<TK>` là khoá duy nhất thứ hai ở CSDL. Người
đã lập sẵn lệnh cho đúng mã (theo `product_code` hoặc sản phẩm Pancake mang mã, chưa huỷ) ⇒ máy NỐI vào lệnh
ấy, không dựng thêm. Căn cứ lúc dựng lưu ở `moq_snapshot`.

**Trong lượt vòng mẫu** (`runCreativeLoopTick`, bước 3c, qua `step(...)` — lỗi không chặn bước khác): chạy ở
MỌI lượt kể cả khi vòng TẮT (đơn vẫn về; nháp không tiêu tiền, không gửi xưởng). Tin báo `kind: "MOQ"`, một tin
MỖI thiết kế, khoá chống lặp `<ngày đủ MOQ>:<mã TK>`; gửi được (hoặc sổ nói đã gửi) thì đóng dấu
`moq_notified_at`, hỏng thì lượt sau gửi lại.

**Màn hình:** tab Thiết kế mới, cột "MOQ sản xuất": `x/50 đơn` đếm SỐNG, "mã TK a · chỉ QC b" (di chuột: số
trùng, số lượng), link tới nháp / lệnh đang nối, hoặc "nháp đã xoá".

Tệp: `lib/queries/creative-moq.ts` (đếm, chỉ đọc) · `lib/creative/moq.ts` (nháp thuần + đường ghi + tin báo) ·
bước 3c trong `lib/creative/loop.ts` · `design-tab.tsx` · `drizzle/0123_creative_design_moq.sql` ·
`tests/creative-moq.test.ts`.

**Chờ chủ shop quyết:** (1) đơn chỉ-qua-quảng-cáo có nên tính vào MOQ không — khách thấy quảng cáo thiết kế
nhưng có thể đã mua mã khác; hiện TÍNH (theo yêu cầu hai đường) và kể riêng. (2) nháp không có sản phẩm Pancake
mã TK thì trình sửa lệnh không lưu được (bắt buộc chọn sản phẩm) — tạo sản phẩm Pancake đúng mã trước khi test.
(3) gửi xưởng thẳng từ nháp (không bấm Lưu) không qua cổng duyệt người thứ hai `PURCHASING_LARGE` — cổng ấy
chỉ chạy ở `saveProductionOrder`, và giá NULL thì số tiền của cổng cũng là 0.

## 5i. Gen ảnh bằng tay · tích chọn bài · tên chiến dịch · MỖI BÀI MỘT CHIẾN DỊCH (chủ shop 25/09/2026)

*"Gen ảnh bằng tay (10 ảnh mỗi lần), duyệt từng ảnh, ảnh duyệt thì máy viết content + tiêu đề và gợi ý tên
chiến dịch / nhóm / quảng cáo; tích chọn bài để đăng hay loại; sửa được tên; MỖI BÀI MỘT CHIẾN DỊCH riêng."*

### Gen ảnh bằng tay (tab Duyệt lô → khối "Gen ảnh bằng tay")

```
người bấm "Gen 10 ảnh"   chọn ẢNH SẢN PHẨM THẬT (bắt buộc) + quảng cáo cũ của shop CÙNG mã (tuỳ chọn) + ý tưởng tự do
                         ⇒ startManualGen: kiểm nguồn, kiểm trần ảnh/ngày NGAY LÚC BẤM, ghi 1 lượt + 10 dòng ảnh PLANNED
                           (ảnh vượt trần ghi GEN_FAILED kèm lý do) — KHÔNG gọi OpenAI, trả lời ngay
sau phản hồi (after())   drawManualGen: từng ảnh kiểm lại trần → giữ chỗ DRAWING → gatherPixels → gpt-image → GENERATED
lượt vòng mẫu (bước 6)   vẽ nốt tối đa 4 ảnh / lượt nếu tiến trình after() chết; ảnh DRAWING quá 15 phút ⇒ GEN_FAILED, KHÔNG vẽ lại
người Duyệt / Loại       duyệt ⇒ captionFromImage viết tiêu đề + nội dung chính theo ẢNH (luật giá như §5d); loại ⇒ không vào lô
người "Đưa vào lô"       sửa câu chữ + ba tên ⇒ MỘT mẫu MANUAL trong lô gần nhất còn hạn duyệt (đúng đường mẫu tự làm, ô 1001+)
```

- **Mỗi lần bấm = 10 ảnh** (`MANUAL_GEN.imagesPerRun`). Mỗi ảnh một tổ hợp bối cảnh × bố cục khác nhau, đủ sáu gen trong
  từ vựng đóng (tất định theo id lượt — `manualGenGenes`), chữ trên ảnh luôn `NONE`. Câu lệnh = ý tưởng của người + sáu chỉ
  thị gen tất định (`geneDirectives`) + "giữ nguyên sản phẩm" (`PRESERVE_PRODUCT_CLAUSE`).
- **Ranh giới 2 + 3 giữ nguyên:** gốc PHẢI là `PRODUCT_PHOTO` đang bật có mã hàng; tham chiếu thêm CHỈ là `OWN_AD` cùng mã.
  Điểm ảnh đi qua ĐÚNG `gatherPixels` (nay xuất khẩu từ `generate.ts`) — spy / tay / R&D không bao giờ tới máy vẽ.
- **Trần chi ảnh CHUNG với lô:** `imageSpendToday` là sổ đếm duy nhất, nay cộng cả ảnh gen tay (và ảnh ĐANG VẼ theo giá
  ước tính), trừ ảnh gen tay đã vào lô để không đếm hai lần. Trần: `maxImagesPerDay` (30) và `imageDailyCapUsd` (2 USD).
  Vượt trần ⇒ bấm vẫn được nếu còn chỗ cho ít nhất một ảnh, máy **vẽ được bao nhiêu báo bấy nhiêu** (lý do ghi trên lượt và
  trên từng ảnh); hết hẳn ⇒ từ chối kèm lý do. Kiểm lại trước MỖI ảnh: giá thật đắt hơn ước tính thì ảnh sau bị chặn trước khi gọi.
- **Vì sao không vẽ trong server action:** 10 ảnh gọi ngay mất 1–10 phút. Action ghi lượt rồi trả lời ngay; việc vẽ chạy
  trong `after()` của Next (tiến trình Node trên VPS, không bị cắt như serverless), màn hình tự tải lại mỗi 8 giây khi còn ảnh
  chờ / đang vẽ, và lượt vòng mẫu vẽ nốt. Hai đường cùng giữ chỗ bằng `UPDATE … WHERE status = 'PLANNED'` ⇒ không ảnh nào vẽ hai lần.
- Mẫu vào lô mang `mode = 'MANUAL'` (không thêm chế độ mới): người đã CHỌN ảnh này như mẫu tự làm ⇒ đăng trước ô máy lập, cùng
  trần "mẫu tự làm ≤ số mẫu / lô", cùng học. Nguồn phân biệt được qua `gen_model` (mô hình vẽ, khác `MANUAL`), `why` ("Gen tay — …"),
  và `creative_manual_gen_images.variant_id`. Mẫu vào lô dùng ĐÚNG ảnh đã duyệt (không lưu bản thứ hai).

### Tích chọn bài trong lô chờ duyệt

Ô tích trên từng bài + thanh "Loại các bài đã chọn" / "Giữ các bài đã chọn" (`applyVariantSelection`, quyền `ideas:write`).
Giữ = bài chọn giữ lại (bài đã loại còn ảnh thì KHÔI PHỤC), mọi bài còn lại bị loại. Chỉ khi lô `PENDING_APPROVAL` còn hạn —
điều kiện nằm trong câu `UPDATE`. Phiếu duyệt chỉ khoá bài `GENERATED` ⇒ tập bài giữ lại CHÍNH LÀ tập bài trong digest: bài
bị loại không đăng, không tiêu tiền; chọn / loại ⇒ phiếu đã phát vô hiệu.

### Tên chiến dịch · nhóm · quảng cáo

| Tên | Khuôn mặc định | Nguồn |
|---|---|---|
| Chiến dịch | `<Tên TKQC>_<dd/MM ngày đăng>_TEST_<tên fanpage>_<số thứ tự>` | tên TKQC: dòng chi tiêu đã đồng bộ (`ad_spends.account_name`) của tài khoản đã khai; fanpage: sổ `fanpages` (alias → name) |
| Nhóm QC | `<Mục tiêu tối ưu>_<vị trí địa lý>_<độ tuổi>_<giới tính>_<autobid\|bidcap\|costcap>` | CÀI ĐẶT THẬT của nhóm QC mẫu, đọc qua `readTemplateAd` (chỉ GET), đệm ở `settings[creative.naming.template]` 12 giờ |
| Quảng cáo | `<tên fanpage>_<ảnh\|video>_<số thứ tự>_TXT` | hàm đặt tên nhận loại media; hiện vòng chỉ chạy ảnh |

- Bảng quy đổi mã Facebook → nhãn ngắn ở `lib/constants/creative-loop.ts` (`OPTIMIZATION_GOAL_LABEL`, `BID_STRATEGY_LABEL`,
  `GENDER_LABEL`). **Mã lạ in NGUYÊN mã**; thiếu hẳn một phần ⇒ `?` và nói ra. Thiếu tên TKQC / fanpage ⇒ BỎ phần ấy khỏi tên
  và cảnh báo. Chưa đọc được nhóm mẫu ⇒ tên nhóm trống ⇒ đăng với tên cũ `VM <ngày> #<ô>`.
- **Số thứ tự** = thứ tự bài trong NGÀY ĐĂNG (một lô mỗi ngày), cấp theo thứ tự đăng, duy nhất trong lô
  (`creative_variants.name_seq`, chỉ mục duy nhất). Không đánh lại khi một bài bị gạt — tên đã hiện cho người duyệt không tự đổi.
- Lượt vòng mẫu (bước 5) điền tên vào ô còn TRỐNG của bài `GENERATED` thuộc lô chưa duyệt; không đè tên người đã sửa. Để trống
  một tên = dùng lại tên mặc định. Sửa tên: nút "Sửa tên chiến dịch / nhóm / QC" trên từng bài (`saveVariantNames`, cùng điều
  kiện với sửa câu chữ). **Ba tên nằm trong digest** (vắng khỏi digest khi cả ba rỗng — phiếu của lô cũ tính lại vẫn khớp) ⇒
  sửa tên sau khi mở hộp duyệt ⇒ phiếu cũ vô hiệu. Hàm dựng tên là hàm THUẦN (`lib/creative/naming.ts::defaultNames`).

### MỖI BÀI MỘT CHIẾN DỊCH

**Chọn: TẠO chiến dịch từ các trường đọc được của chiến dịch chứa mẩu mẫu, KHÔNG sao chép bằng `/copies`.** Sao chép kéo theo nhóm
mẫu với LOẠI ngân sách của nó (Facebook không cho đổi ngày ↔ trọn đời trên nhóm đã có), mang cả start/end cũ của nhóm mẫu, và
cần thêm năm lời ghi mới (đổi tên chiến dịch · sửa nhóm: tên + ngân sách + khung giờ · sửa mẩu: tên + bài · bật ba cấp). Tạo mới
chỉ cần **HAI lời ghi mới**; nhóm và mẩu dùng lại đúng `createTestAdset` (ngân sách TRỌN ĐỜI + `end_time`, chép đối tượng / tối
ưu / giá thầu / đích tin nhắn từ nhóm mẫu) và `createAd`.

```
mỗi bài   tải ảnh → tạo bài → CREATE_CAMPAIGN  POST act_<id>/campaigns  name · objective · special_ad_categories · buying_type · status=PAUSED
                            → CREATE_ADSET     POST act_<id>/adsets     (như cũ) campaign_id = chiến dịch RIÊNG · lifetime_budget 200.000đ · start/end_time của lô
                            → CREATE_AD        POST act_<id>/ads        (như cũ) tên đã duyệt
                            → ACTIVATE_CAMPAIGN POST /<campaign_id>     status=ACTIVE — công tắc tổng, bước CUỐI; chỉ tới đây mẫu mới LIVE
```

- **Tiền không đổi:** 200.000đ trọn đời ở NHÓM + `end_time`; trần lô 20 bài / 4.000.000đ đếm trên sổ; COPILOT; phiếu HMAC;
  khung giờ lô; công tắc khẩn cấp chặn cả tạo lẫn bật chiến dịch (chỉ `status=PAUSED` còn đi). Chiến dịch mẫu để ngân sách ở
  cấp CHIẾN DỊCH (CBO) hoặc không đọc được mục tiêu / hạng mục đặc biệt ⇒ cả lô KHÔNG ghi gì (kiểm một lần trước lời gọi ghi đầu tiên).
- **Cổng:** `CREATE_CAMPAIGN` · `ACTIVATE_CAMPAIGN` là hành động TẠO (đòi lô đã duyệt + digest khớp + trước giờ chạy; tạo chiến
  dịch chịu cả ba trần tiền vì nó dẫn tới một nhóm). Tạo nhóm chỉ được vào chiến dịch test HOẶC chiến dịch riêng vòng đã tạo cho
  CHÍNH bài (`ownCampaignId`); bật chỉ được đúng chiến dịch riêng ấy (`NOT_OUR_AD` nếu khác). Mẩu mẫu vẫn phải nằm trong chiến dịch test.
- **Hỏng giữa chừng giữ id, không dựng lại, không mồ côi âm thầm:** mỗi bước tạo chiến dịch / nhóm / mẩu ghi `fb_pending_step`
  NGAY TRƯỚC lời gọi và xoá CÙNG giao dịch lưu id. Lượt sau thấy dấu còn ⇒ đánh `PUBLISH_FAILED` kèm TÊN để tìm tay, không gửi
  lại. Facebook trả lỗi ⇒ `PUBLISH_FAILED`, id đã tạo (chiến dịch riêng) nằm lại trên mẫu + trong sổ, chiến dịch vẫn TẮT. Tạo mẩu
  / bật hỏng ⇒ tắt nhóm (dọn dẹp) như cũ. Không tự thử lại.
- **Tắt theo luật / tiêu thêm / chấm** không đổi: đều đi theo NHÓM (`fb_adset_id`) và mẩu (`fb_ad_id`), đúng cho cả hai cấu trúc.
  Lô cũ: mẫu đã có nhóm mà không có chiến dịch riêng đi tiếp ĐƯỜNG CŨ (chỉ tạo mẩu trong chiến dịch test) — không phá dữ liệu đang chạy.

Tệp: `lib/creative/{manual-gen,naming,selection}.ts` · `lib/creative/{publish,manual,generate,loop,approval}.ts` (sửa) ·
`createTestCampaign` / `activateTestCampaign` / `testCampaignFields` trong `lib/integrations/facebook/ads-write.ts` ·
`lib/marketing/creative-write-gate.ts` · `lib/actions/creative-manual-gen.ts` · `applyVariantSelection` (`lib/actions/creative.ts`) ·
`saveVariantNames` (`lib/actions/creative-copy.ts`) · `lib/queries/creative-manual-gen.ts` · `manual-gen.tsx` · `manual-gen-panel.tsx` ·
`variant-select.tsx` · `names-editor.tsx` · `drizzle/0124_creative_manual_gen_campaign_per_post.sql` · `tests/creative-manual-gen.test.ts` ·
`tests/creative-write.test.ts` (ca 10–14).

**Chờ chủ shop quyết:** (1) trần **30 ảnh / ngày** (`maxImagesPerDay`) và **2 USD / ngày** là CHUNG: ngày có lô đầy 20 ảnh (~1,7 USD) thì
một lần bấm gen tay chỉ vẽ được ~3 ảnh — muốn đủ 10 ảnh / lần thì nâng trần (sửa mã, AGENTS.md mục 7). (2) Chiến dịch riêng
chép mục tiêu từ chiến dịch test (thường "Tương tác / Tin nhắn") — muốn mục tiêu khác cho bài test thì đổi ở chiến dịch test.
(3) Nếu tài khoản dùng Graph API ≥ v24 và Facebook đòi `is_adset_budget_sharing_enabled` khi tạo chiến dịch không ngân sách, lượt
tạo chiến dịch sẽ báo lỗi rõ ràng (không mồ côi gì) — kho đang gọi v21.0.

## 6. Đã dựng gì, ở đâu

| Phần | Tệp | Việc |
|---|---|---|
| Nền | `lib/constants/creative-loop.ts` · `lib/creative/{plan,judge,learn,schedule,images}.ts` · 7 bảng (`drizzle/0117_creative_loop.sql`) | hợp đồng, hàm thuần, lược đồ |
| Sinh | `lib/creative/{vision,writer,generate}.ts` · `lib/integrations/openai/images.ts` · `lib/queries/creative-plan.ts` | đọc ảnh nguồn → gen; lập lô; LLM viết (giá đúng ERP); gpt-image sửa ảnh sản phẩm thật; trần ảnh/ngày |
| Đo / chấm / học | `lib/queries/creative-loop.ts` · `lib/creative/evaluate.ts` | chi hạt AD + đơn theo `ORDER_AD_ID` (luật tắt: `ad_id`); chấm; chốt thư viện; sổ phán quyết + sổ học; xoá ảnh mẫu thua sau hạn |
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
- Scale (§5g): lời bật CHIẾN DỊCH mà phản hồi rơi mất sau khi Facebook đã bật ⇒ ERP ghi "nháp" trong khi
  chiến dịch đang chạy (đã được người duyệt, nhưng trần tổng đang bật đếm THIẾU nó). Người tắt / đổi
  ngân sách chiến dịch scale trực tiếp trên Ads Manager thì ERP không biết — trần tổng đếm theo bảng nháp.
  `/copies` chưa từng gọi Facebook thật: tham số lấy từ tài liệu, kiểm thử chạy trên cửa ghi giả.
- Đường Batch ảnh (§5e) chưa từng gọi OpenAI thật: tên trường lấy từ tài liệu, kiểm thử chạy trên OpenAI giả.
  Số token mỗi ảnh của gpt-image-2.x là ước tính (OpenAI chưa công bố bảng) — đối chiếu `gen_cost_usd` thật
  sau lô đầu.

## 7. Chủ shop còn phải làm gì để vòng CHẠY THẬT

| Việc | Vì sao máy không tự làm được |
|---|---|
| Cấp lại System User token có **`ads_management`** + quyền **tạo quảng cáo cho fanpage** test | token hiện chỉ `ads_read` |
| Dựng **một chiến dịch TEST** (mục tiêu Tin nhắn, ngân sách ở cấp nhóm — ABO, **KHÔNG CBO**) và **một mẩu QC mẫu** trong đó (khuyên đúng 1 nhóm + 1 mẩu, để TẮT). Từ §5i mỗi bài thành một chiến dịch riêng chép mục tiêu / hạng mục đặc biệt / kiểu mua của chiến dịch này và chép đối tượng / tối ưu / giá thầu / địa lý / tuổi / giới tính của nhóm mẫu — tên nhóm mặc định cũng đọc từ đó | máy không tự đoán đối tượng hay mục tiêu; chiến dịch mẫu CBO ⇒ máy không đăng |
| Điền `creative.config`: fanpage · tài khoản · chiến dịch test · mẩu mẫu · **luật tắt · luật giữ** | ngưỡng là quyết định kinh doanh (mục 38) |
| Đặt `ADS_WRITE_ENABLED=true`, `ADS_WRITE_MODE=COPILOT`, `CREATIVE_LOOP_EVERY_MINUTES=10` ở **GitHub Variables** rồi deploy (xoá Variable = TẮT ở lần deploy sau; gõ tay vào `.env` trên VPS sẽ bị đè); `OPENAI_API_KEY` phải có | đổi lịch và mở đường ghi là việc của chủ shop (mục 7) |
| Bật `enabled` ở tab Cấu hình | công tắc mềm của vòng |
| Bấm **Nhập ảnh sản phẩm từ Pancake** (hoặc tải tay ảnh sản phẩm thật) cho các mã muốn test | máy không sinh mẫu cho sản phẩm nó không nhìn thấy |
| Bấm **Nhập mẫu thắng / mẫu tốt từ Facebook** (token hiện có `ads_read` là đủ — chỉ GET) | chọn mẩu nào làm mẫu cha là việc của người |
| Bật **Chạy mockup hằng ngày** trên thẻ các mẫu thắng muốn chạy mockup (tab Nguồn ảnh) | chọn mẫu nào chạy mockup là quyết định của chủ shop (24/09) |
| Tạo sản phẩm trên Pancake đúng mã **TK-…** của thiết kế được duyệt (tab Thiết kế mới) | nhân viên chốt đơn thiết kế mới như hàng thường; máy không ghi vào Pancake |
| Dựng **hai chiến dịch MẪU scale** (§5g) và dán id vào tab Cấu hình; **chốt trần tổng 5.000.000đ/ngày** các chiến dịch scale đang bật (đang là ĐỀ XUẤT) | máy chỉ sao chép, không tự dựng mục tiêu / biểu mẫu; trần tiền là quyết định kinh doanh |
| Kiểm **tên fanpage** trong sổ fanpage (alias) và đồng bộ chi tiêu của **tài khoản QC** đã khai (để có tên TKQC trong tên chiến dịch) | tên lấy từ dữ liệu đã đồng bộ; thiếu thì phần ấy để trống và màn hình nói ra |
| Quyết **trần ảnh chung** 30 ảnh / 2 USD mỗi ngày có đủ cho lô + gen tay 10 ảnh / lần không (§5i) | trần tiền là quyết định kinh doanh |
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
