# Phiên 20/09/2026 — vận hành việc chuyển người, khoảng trống bảng số đo, và một cổng kiểm thủng

**Khuyến nghị cuối: `KEEP CURRENT ROUTER`.** Lý do ở mục cuối. Không đổi định tuyến, không bật
AUTO, không chạm production, không kích hoạt nhánh chỉ-luật, không kích hoạt Gemini/Anthropic.

Mọi con số dưới đây đo trên **bản chạy thử** ngày 20/09/2026 bằng truy vấn CHỈ ĐỌC. Chỗ nào chưa
đo được thì ghi CHƯA BIẾT — không có ô nào thay bằng 0.

---

## 0. AN TOÀN — không có hồi quy, nên không sửa hạ tầng

| câu hỏi | số đo | kết luận |
|---|---|---|
| tin gửi cho khách | 0 | ĐẠT |
| đơn do máy tạo | 0 | ĐẠT |
| cầu dao bật | `true` | ĐẠT |
| cầu dao cắt nhầm | 0 lượt | ĐẠT |
| production còn sống | có | ĐẠT |
| CSDL production | chỉ đọc | ĐẠT |

Không có hồi quy ⇒ **không sửa hạ tầng**, đúng như đặc tả yêu cầu.

---

## 1. VIỆC CHUYỂN NGƯỜI — 202/0 KHÔNG phải cái ta tưởng

Con số cũ: 202 việc máy xin người vào, 0 việc có chủ. Có đúng hai cách giải thích, đòi hai việc
khác hẳn nhau, nên phải đo trước khi kết luận:

- **A — không ai bấm.** Vấn đề quy trình / khả năng nhìn thấy.
- **B — có bấm mà không ăn.** Lỗi mã.

**Câu trả lời là A.** `sales_copilot_actions` có **đúng 0 dòng `TAKEOVER`**, 0 người, 0 hội thoại.
Chưa ai bấm nút ấy lần nào.

### Nhưng lỗi mã CŨNG có thật — nó chỉ chưa ai giẫm phải

Nút "tự nhận việc" gác nhánh ghi bằng `humanTakeoverAt`. Cột ấy có **hai nơi ghi**: nhân viên tự
nhận việc, **và chính máy** khi nó gọi `conversation.handoff`. Với mọi việc máy chuyển sang, cột
đã có giá trị trước khi ai bấm ⇒ nhánh ghi bị bỏ qua ⇒ `takeover_by_user_id` không bao giờ được
ghi. Không báo lỗi, mà lượt bấm vẫn để lại một dòng nhật ký nói `after: { takeoverByUserId }`.

Nó sẽ nổ ở **lần bấm đầu tiên**, trên đúng 100% việc do máy chuyển sang. Đã sửa (`e49a686`):

- gác bằng **khoá người**, không gác bằng mốc thời gian;
- quyết định tách thành hàm thuần `planTakeover`, sáu ca kiểm, ca đầu là đúng ca vỡ;
- cột mới `takeover_claimed_at` (migration 0100, chỉ THÊM, không backfill) — `human_takeover_at`
  trả lời *khách bắt đầu chờ lúc nào*, cột mới trả lời *một con người cầm việc lúc nào*;
- nhận việc GIỮ mốc chờ cũ và GIỮ lý do máy đã khai;
- trả việc xoá cả `takeover_claimed_at`.

### Vòng đời

`UNCLAIMED` → `CLAIMED` → `RESOLVED`. Hai mức đầu đọc từ bảng hội thoại. **`RESOLVED` không đọc
được ở đó**: trả việc về máy xoá sạch cả ba cột, nên nó đếm từ nhật ký thao tác (`RELEASE`), theo
**dòng** chứ không theo hội thoại — một hội thoại có thể xin người nhiều lần, mỗi lần một vòng đời.

Hạn xử lý **chỉ áp cho việc chưa ai nhận**. Một việc đã có người cầm mà chưa xong là vấn đề khác
hẳn; trộn hai thứ thì con số "quá hạn" nói về hai chuyện cùng lúc.

### Còn lại cho chủ shop

1. `work.machineHandoffSlaMinutes` **chưa khai** ⇒ mọi dòng mang trạng thái `UNKNOWN`. Không có
   mặc định và sẽ không thêm: "bao nhiêu phút thì muộn" là quyết định vận hành.
2. Chưa ai bấm nhận việc lần nào. Mã đã thông; phần còn lại là người.

---

## 2. BẢNG SỐ ĐO — 47,3% việc treo là chuyện này, và nó dồn vào MỘT mẫu

| | |
|---|---|
| tổng việc treo | **203** |
| do thiếu bảng số đo | **96** (47,3%) |
| liên quan size vì lý do khác | 7 |
| số mẫu hàng liên quan | **1** |
| bảng số đo đã khai | **0** |

Toàn bộ 96 việc treo ấy thuộc **một mẫu duy nhất**: `Đầm Q004`
(`f0c0269c-df99-4c6a-b3be-8088b15eda42`). Tuổi trung bình 26 giờ, cũ nhất **108 giờ**.

**Máy từ chối đoán size khi không có căn cứ — đúng luật 47, và không được sửa.** Câu hỏi không
phải "làm sao để máy đoán giỏi hơn" mà là "bổ sung cho mẫu nào trước".

### Danh mục có 6 mẫu khai được bảng số đo

Cả sáu đều có đúng 4 size `M · L · XL · 2XL`:

| mã shop | tên |
|---|---|
| **Q004** | **Đầm Q004** ← 96/96 việc treo |
| Q001 | Q001 |
| Q002 | Đầm Q002 |
| Q003 | Đầm Q003 |
| Q005 | ĐẦM Q005 |
| X001 | Quần định hình |

**Khai Q004 trước xoá được 96/96 việc treo vì size.** Bốn mẫu còn lại chưa gây ra việc treo nào.

**Cùng nhãn size KHÔNG có nghĩa cùng số đo.** Một bảng `GLOBAL` cho cả sáu mẫu là đường tắt sai:
vải co giãn và vải cứng cùng ghi "L" mà số đo khác nhau, và `size-engine.ts` có trường
`fabricStretch` đúng vì lý do ấy. Mỗi mẫu cần đo thật một lần.

### Bốn nhóm mà đặc tả đòi

Đặc tả đòi phân **có · thiếu · không đầy đủ · cũ · mâu thuẫn**. Vì **chưa khai bảng nào**, ba
nhóm sau **chưa thể tồn tại**. Truy vấn in thẳng phán xét ấy thay vì dựng bốn ô rỗng: một bảng in
bốn nhóm với ba ô bằng 0 đọc như thể đã soi rồi mà không thấy vấn đề.

---

## 3. SỔ NGUỒN Ô ĐƠN HÀNG V1 — ĐÓNG

Sáu ca A–F chạy qua **đường ghi thật** (`recordProvenance()` + `snapshotOf()`) và **đọc lại từ
CSDL** bằng truy vấn drizzle, kèm bất biến toàn bảng (đúng một dòng hiệu lực cho mỗi cặp hội
thoại × ô) và dọn sạch sau khi chạy, có kiểm luôn cả FK cascade.

Bảng rỗng **không được đọc là ĐẠT** — sáu phép kiểm ca đều "rỗng = đạt", nên trên một bảng rỗng
chúng đạt một cách vô nghĩa. Đó là lý do phải có bài kiểm ghi thật. **V1 đóng. Không dựng hệ
thống trạng thái đơn hàng thứ hai.**

---

## 4. GIÁ VÀ CHI PHÍ — `PRICING_UNKNOWN`, và đó là câu trả lời đúng

696 lượt gọi mô hình trong 30 ngày, **0 lượt tính được thành tiền**, 0 lượt có ảnh chụp giá.

| nhà / mẫu | lượt | tính được tiền | token vào | token ra |
|---|---|---|---|---|
| `erp / gpt-5.6-luna` | 470 | 0 | 0 | 0 |
| `erp:openai / gpt-5.6-luna` | 204 | 0 | 52.381 | 23.187 |
| `erp:openai / gpt-5.6-terra` | 22 | 0 | 6.301 | 2.510 |

Sổ giá: **0 dòng**, nhãn phiên bản "(chưa khai)".

**Hạ tầng giá đã có và là nguồn chính thức** (`lib/constants/ai-model-pricing.ts` +
`settings['ai.config'].pricing`). Không dựng bảng giá thứ hai. Thiếu đúng hai thứ, và cả hai đều
là **con số chủ shop phải cung cấp** — đoán là bịa hoá đơn:

1. **tỷ giá USD→VND**. `FACEBOOK_USD_VND` có sẵn nhưng nó là **giá trị mặc định trong mã**
   (25.500), không phải một con số chủ shop khai. Mượn nó rồi gọi là số của chủ shop là dựng một
   nguồn giả.
2. **đơn giá công bố của `gpt-5.6-luna` và `gpt-5.6-terra`**. `usdPriceFor()` trả `null` cho cả
   hai, và bài kiểm khoá điều đó lại để không ai chép đại một con số vào.

### Phép kiểm chi phí — phần làm được ĐÃ làm

Đặc tả đòi: gọi thật 10–20 lượt rồi khẳng định *tính ra ≈ lưu lại trong một sai số làm tròn*.
Phần "gọi thật" **còn bị chặn**. Nhưng câu hỏi trả lời được **mạnh hơn** một phép so xấp xỉ:

**Sai số bằng ĐÚNG 0, do cấu trúc.** `runModelStep` lấy thẳng giá trị `estimateCostVnd()` trả về
rồi lưu; không có phép nhân thứ hai ở giữa để lệch. Một ngưỡng sai số ở đây sẽ là ngưỡng cho một
phép tính **không tồn tại** — và tệ hơn, nó sẽ nuốt mất đúng cái lỗi mà nó tưởng đang canh. Bài
kiểm khoá tính chất ấy ở mức mã nguồn, cộng một phép **dựng lại từ ba cột ảnh chụp** (kể cả rổ
đệm) ra đúng con số đã lưu.

**Bất biến ảnh chụp** cũng đã có kiểm: đổi tỷ giá tháng sau ra con số khác cho cùng một lượt, và
từ ảnh chụp vẫn dựng lại được con số lịch sử mà không cần bảng giá cũ.

---

## 5. NHÃN NGƯỜI CHẤM — 0 dòng, và đó là nút thắt của BA hạng mục

`sales_review_labels`: **0 dòng**. Mức cỡ mẫu: **`INSUFFICIENT`**. Còn thiếu **38** dòng có căn
cứ để tới mức dùng được.

Đường ống đã dựng (`lib/constants/review-benchmark.ts`), và luật đầu tiên của nó không phải một
con số: **máy không tự chấm máy**. Một điểm số do mô hình sinh ra trông y hệt một điểm số có căn
cứ, nên nó sẽ lặng lẽ thay chỗ cho phần việc đắt nhất mà cũng là phần duy nhất đáng tin. Bài kiểm
quét mã đã vào kho: tệp nào chạm bảng nhãn thì không được gọi mô hình.

**Hai con số tách rời, in cạnh nhau:**

- **có kết luận** — đủ để đo tỷ lệ;
- **có căn cứ** — có kết luận **và** nói được lỗi ở đâu (lý do đóng hoặc câu *đáng lẽ phải làm gì*).

Chỉ loại thứ hai mới so được hai mô hình trên cùng một lượt. Gộp lại thì một bộ 40 dòng có căn cứ
và một bộ 40 dòng chỉ có tích đọc ra giống hệt nhau.

| mức | từ | nghĩa |
|---|---|---|
| `INSUFFICIENT` | < 20 | mọi tỷ lệ đều là tiếng ồn |
| `PRELIMINARY` | 20 | đọc được xu hướng, **chưa** kết luận |
| `MEANINGFUL` | 38 | con số đầu tiên dùng để quyết định được |
| `STRONGER` | 100 | chênh lệch nhỏ vẫn có nghĩa |

Hai mốc dưới **lấy lại** từ `PILOT_REVIEWED_TURNS_TARGET`, không gõ lại.

---

## 6. NHÁNH CHỈ-LUẬT — chưa tính được, và đó KHÔNG phải "chỉ-luật kém"

1.045 lượt chạy trong 30 ngày, **0 lượt có sự thật để so**.

Nhánh chỉ-luật là phép tính tất định — chạy lại lúc nào cũng ra cùng kết quả. Nhưng "đúng bao
nhiêu phần" cần **một thước đo**, và thước đo ấy chỉ đến từ người chấm. Không có nhãn thì con số
độ chính xác không tồn tại; nó **không** bằng 0, và **không** có nghĩa hai bên ngang nhau.

**Vẫn ở chế độ bóng. Không đổi định tuyến.**

---

## 7. ANTHROPIC / GEMINI — một bên thiếu khoá, một bên thiếu cả đường dẫn khoá

| nhà | khoá | trạng thái |
|---|---|---|
| OpenAI (qua cầu ERP) | có | đang chạy |
| Anthropic | `ANTHROPIC_API_KEY` đã nối trong workflow | chạy được **khi** Secret được đặt |
| **Gemini** | **không có biến nào trong workflow** | **chặn cứng** |

Gemini không chỉ thiếu khoá: `ops-vps.yml` **không truyền biến nào** tên `GEMINI_*` / `GOOGLE_*`
sang máy chủ. Thêm Secret thôi chưa đủ — phải nối cả đường dẫn biến. Không làm trong phiên này vì
đặc tả cấm kích hoạt Gemini.

Khi có khoá: 1 lượt khói + tối đa 10–20 lượt **ở bóng**. Không bao giờ gửi cho khách.

---

## 8. CẦU DAO — không đụng tới, đúng như đặc tả

| | 7 ngày |
|---|---|
| lượt tốt | 197 |
| lượt hỏng | 499 |
| **bị cầu dao cắt** | **0** |
| hỏng gần nhất | 2026-09-19 12:05 |
| tốt gần nhất | 2026-09-20 00:00 |

**Đừng đọc "499/696 hỏng" là tỷ lệ hỏng hôm nay.** Tách theo ngày:

| ngày | mẫu | lượt | hỏng |
|---|---|---|---|
| 2026-09-19 | `erp / gpt-5.6-luna` | 435 | 435 |
| 2026-09-18 | `erp / gpt-5.6-luna` | 27 | 27 |
| 2026-09-17 | `erp / gpt-5.6-luna` | 8 | 8 |
| 2026-09-15 | `erp:openai / gpt-5.6-luna` | 90 | 15 |
| **2026-09-20** | — | — | **0** |

Toàn bộ 435 lượt hỏng ngày 19/09 là **trước khi hồi phục** (lượt hỏng cuối 12:05), và cầu dao chỉ
được bật lúc ~18:21 cùng ngày. **0 lượt bị cắt là con số đúng**, không phải cầu dao đang ngủ: lúc
các lượt ấy hỏng thì nó chưa bật, và từ lúc bật tới giờ chưa có lượt hỏng nào để cắt.

**Không thiết kế lại cầu dao.** Không có bằng chứng hồi quy nào trên dữ liệu sống.

---

## 9. CỔNG KIỂM THỦNG — CHÍN TỆP KIỂM KHÔNG BAO GIỜ CHẠY

Phát hiện ngoài đặc tả, và là phát hiện đáng kể nhất của phiên này.

`npm test` chạy đúng **một** tệp: `tests/sync-fixtures.test.ts`, và tệp ấy gọi bài kiểm khác bằng
cách `import` một hàm đã xuất. Bài kiểm viết bằng `node:test` **không xuất hàm nào** — nó gọi
`test()` ở mức mô-đun. Không ai import nó, nên **nó không chạy**, ở cả máy người viết lẫn CI.

Chín tệp ở trạng thái ấy, và chúng không phải tệp phụ:

`ai-pricing-registry` · `circuit-fault` · `eval-severity-confidence` · `machine-handoff-sla` ·
`migration-reconcile` · `model-router-sim` · `order-provenance` · `provider-circuit` ·
`review-benchmark`

Tất cả đều **xanh** khi đem chạy — nên không có gì hỏng, và đó chính là điều làm nó khó thấy:
suốt thời gian ấy chúng không bảo vệ điều gì cả, mà vẫn trông y hệt như đang bảo vệ. Trong số đó
có cả bộ kiểm hoà giải migration mà mục 10 dưới đây dựa vào.

`scripts/run-unit-tests.mjs` **tự tìm** thay vì đọc một danh sách — một danh sách lại là một chỗ
phải nhớ cập nhật, và nó sẽ quên đúng như lần trước. Trình chạy đọc `git ls-files`, lọc tệp có
`from "node:test"`, bỏ tệp mà điểm vào đã import (chạy hai lần là đếm đôi), rồi giao cho
`tsx --test`. `npm test` giờ chạy cả hai vế và đỏ nếu một trong hai đỏ.

Đo lại: **45 phép khẳng định** giờ thật sự chạy trong cổng.

---

## 10. HOÀ GIẢI MIGRATION — sẵn sàng gộp, CHƯA gộp

Cách làm giữ nguyên, không đổi thiết kế. Không đổi tên migration đã áp, không sửa SQL đã áp,
không đặt lại sổ migration, không viết lại lược đồ theo kiểu phá huỷ.

**Bằng chứng giờ chạy trong cổng.** `tests/migration-reconcile.test.ts` là một trong chín tệp mồ
côi ở mục 9 — từ commit này nó chạy trong `npm test`, tức là chạy trong CI của cả
`deploy-vps.yml` lẫn `ops-vps.yml`. Nó dựng **hai CSDL PGlite thật** và so lược đồ:

| | |
|---|---|
| đường A (production → R2) | 124 migration |
| đường B (bản chạy thử → R1 → R2) | 120 migration |
| kết quả | **lược đồ giống hệt nhau**, 2.676 dòng ảnh chụp |

`tests/migration-upgrade-path.test.ts` (đã chạy sẵn từ trước) kiểm đường nâng cấp 83 → 100
migration: dữ liệu nghiệp vụ nguyên vẹn, không backfill người phụ trách, chạy lại không nhân đôi.
`tests/repo-integrity.test.ts` khoá **sổ chỉ nối vào cuối**: mục mới phải có mốc muộn hơn mọi mốc
đã có.

Trước khi gộp, ba điều kiện — và cả ba **đã tự động**, không còn là việc nhớ:

1. CI chạy **cả hai** đường nâng cấp ✔ (mục 10 ở trên)
2. không đặt lại sổ migration ✔ (`repo-integrity`)
3. không viết lại lược đồ theo kiểu phá huỷ ✔ (trình sinh chặn `DROP` không có `IF EXISTS`)

**Không tự gộp trong phiên này.** Đặc tả chỉ cho gộp khi quy trình của kho mã bắt buộc và mọi
phép kiểm xanh; ở đây không có ràng buộc nào bắt phải gộp ngay.

---

## 11–12. HAI VIỆC CỐ Ý KHÔNG LÀM

- **Nén bối cảnh** — chỉ đo, không dựng bộ tóm tắt / bộ nén. Đặc tả cấm đầu tư vào đây.
- **Gộp tin nhắn dồn** — chỉ mô phỏng ở bóng, không kích hoạt. Chưa tới lượt: nó nằm sau mọi
  hạng mục trên, và những hạng mục trên còn đang chờ dữ liệu.

---

## KHUYẾN NGHỊ: `KEEP CURRENT ROUTER`

Ba lựa chọn đặc tả cho phép, và hai lựa chọn kia đều bị chặn bởi **cùng một thứ**:

| lựa chọn | chặn ở đâu |
|---|---|
| `READY FOR LIMITED ROUTER PILOT` | không đo được. 0 nhãn người chấm ⇒ không có thước đo nào để nói bộ định tuyến mới tốt hơn. Thả một bộ định tuyến chưa đo được vào đường phục vụ khách là đổi một thứ đang chạy lấy một thứ không ai kiểm được. |
| `READY FOR SHADOW MULTI-PROVIDER` | **rút lại so với phiên trước.** Phiên 19/09 đề xuất mức này khi tin rằng bộ kiểm nhà cung cấp và sổ giá đang được canh. Mục 9 cho thấy chúng **chưa bao giờ chạy trong cổng**. Chạy nhiều nhà cung cấp ở bóng mà chi phí là `PRICING_UNKNOWN` thì đo được độ trễ và lỗi, **không** đo được tiền — mà tiền là nửa câu hỏi. |
| **`KEEP CURRENT ROUTER`** | ← |

Đây **không** phải kết luận rằng bộ định tuyến hiện tại tốt hơn. Nó là: chưa có gì để so, và ba
việc chặn đều **không sửa được bằng mã**.

### Ba việc chủ shop quyết, xếp theo thứ tự cởi nút

1. **Bảng số đo `Q004`** — xoá 96/203 việc treo, tức gần một nửa. Rẻ nhất, tác động lớn nhất.
2. **Tỷ giá USD→VND + đơn giá công bố hai mẫu `gpt-5.6-*`** — mở khoá toàn bộ phần tiền, và cùng
   với nó là phép kiểm chi phí trên lượt gọi thật.
3. **38 lượt chấm có căn cứ ở `/ai/review`** — mở khoá cùng lúc: độ chính xác nhánh chỉ-luật, đối
   chứng nhà cung cấp, và mọi câu hỏi "mô hình nào hơn".

Thêm: khai `work.machineHandoffSlaMinutes`, và bấm thử "nhận việc" một lần để xác nhận bản vá
mục 1 chạy trên máy chủ thật.
