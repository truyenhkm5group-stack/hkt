# Sales AI · phiên 19/09/2026 (đêm) — hoà giải migration, triển khai staging, bật cầu dao

**Khuyến nghị: `READY FOR SHADOW MULTI-PROVIDER`** — xem mục 10.

Production KHÔNG bị đụng. AUTO không bật. 0 tin gửi khách. 0 đơn máy tạo.

---

## 1. MIGRATION — VA CHẠM, VÀ ĐƯỜNG HOÀ GIẢI ĐÃ KIỂM

### Va chạm tìm được

Nhánh và `main` cùng dùng số hiệu **0084–0099** cho những migration **hoàn toàn khác nhau**:
15 số hiệu trùng, **không một tên tệp nào trùng**.

| | nhánh | `main` |
|---|---|---|
| miền | nhân sự AI bán hàng | lương · hoàn hàng · landing · vtp · tech · phiên |
| migration từ 0084 | 16 (0084–0099) | 23 (0084–0106) |
| mốc lớn nhất | 1789835704721 | **1789976427245** |

Thêm một khuyết tật có sẵn: **sổ của nhánh có HAI mục cùng `idx` 85** (`0085_sales_shadow_validation`
và `0086_product_resolver_v2`). `main` không có mục trùng nào.

### Lịch sử đã áp dụng thật

| | bản chạy thử (đo trực tiếp) |
|---|---|
| số migration đã áp | **97** |
| mốc trần | **1789381643786** (14/09/2026 10:27) |
| hash mục cuối | `b3daebe6ae82` — **khớp đúng** `0097_review_expected_behavior` của nhánh |
| bảng của `main` | `payroll_periods` · `fb_adsets` · `return_reason_observations` · `care_decisions` · `cto_proposals` = **0 / 0 / 0 / 0 / 0** |

⇒ Bản chạy thử mang **lịch sử của nhánh**, và **không có một mảnh lược đồ nào của `main`**.

Production: **không đọc journal trực tiếp** trong phiên này — thao tác `db-query` chạy vào
container production, và tôi chọn không chạm tới nó khi chưa cần. Trạng thái của nó suy ra từ
`main` (mốc trần = mốc lớn nhất của `main`), và mọi thiết kế dưới đây **không phụ thuộc** vào con
số ấy ngoài bất đẳng thức "lớn hơn mọi mốc của nhánh" — điều đã kiểm được từ chính hai cuốn sổ.

### Vì sao gộp thẳng hỏng CẢ HAI phía

Drizzle **không so tên tệp** và **không so hash**. Nó đọc mốc lớn nhất đã áp **một lần**, rồi bỏ
qua mọi migration có mốc thấp hơn.

- **production**: cả **16** migration của nhánh đều dưới trần ⇒ **bỏ qua hết**, im lặng.
- **bản chạy thử**: `main` 0084–0087 dưới trần ⇒ bỏ qua. Và `main` 0090 chạy
  `ALTER TABLE "fanpages"` trong khi bảng ấy do chính 0086 tạo ⇒ **lượt migration chết giữa
  chừng**. `IF NOT EXISTS` trên tên cột không cứu được một bảng không tồn tại.

### Hoà giải: hai tệp, sinh từ chính SQL đã chạy

| | nội dung | mốc | chạy ở đâu |
|---|---|---|---|
| **R1** | hiệu ứng `main` 0084–0087 | **giữa** trần bản chạy thử và mốc `main` 0088 | chạy ở bản chạy thử; bỏ qua ở production |
| **R2** | **trạng thái cuối** lược đồ nhánh | **lớn hơn mọi mốc `main`** | chạy ở production; không-làm-gì ở bản chạy thử |

**Bài học đắt nhất của phiên: idempotent TỪNG CÂU không phải idempotent CẢ CHUỖI khi trong chuỗi
có lệnh xoá.** Bản R2 đầu ghép 16 migration rồi thêm `IF NOT EXISTS` vào từng câu — bài kiểm bác
bỏ ngay: 0088 tạo `sales_size_profiles` cùng khoá ngoại trỏ tới nó, 0091 xoá **cả cột lẫn bảng**;
phát lại trên một CSDL đã ở trạng thái cuối thì câu "thêm khoá ngoại" chạy vào một cột **không
còn tồn tại**. R2 vì vậy mô tả **trạng thái cuối**, không phát lại lịch sử.

### Kiểm hai đường nâng cấp — ĐẠT

`tests/migration-reconcile.test.ts`, hai CSDL PGlite thật:

- **đường A** (lịch sử `main` → hợp nhất): **124 migration**
- **đường B** (lịch sử nhánh, đúng bản chạy thử hôm nay → hợp nhất): **120 migration**
- **lược đồ cuối TRÙNG KHỚP trên 2 676 dòng** ảnh chụp bảng · cột · kiểu · chỉ mục.

**Thử ngược:** bỏ R1 ra khỏi sổ ⇒ đường B chết đúng ở `0090_fanpage_alias_access`.

### ⚠ Chỗ dễ hỏng nhất, phải nói trước

**R2 CHỈ được đưa vào sổ Ở LÚC GỘP NHÁNH.** Đưa nó vào sổ của nhánh lúc này là nâng trần bản chạy
thử lên **trên** mốc `main` 0088–0106, và **19 migration đó bị bỏ qua vĩnh viễn** — đúng cái bẫy
cả cuộc hoà giải sinh ra để tránh. Thứ tự sổ hợp nhất:

```
[chung 0000–0083] → [main 0084–0087] → R1 → [main 0088–0106] → [nhánh 0084–0099] → R2
```

**Chưa gộp nhánh.** Không đổi tên migration đã áp, không sửa SQL đã áp, không đặt lại sổ, không
xoá lược đồ, không ép bản chạy thử về lịch sử `main`, **không đụng CSDL production**.

---

## 2. TRIỂN KHAI STAGING — ĐẠT

Cổng chạy trên **bản checkout SẠCH** theo đúng SHA (`npm ci` · typecheck · lint · `npm test` ·
`npm run build`) — tất cả xanh, rồi mới dựng ảnh.

| | |
|---|---|
| ảnh | `sha256:1d79036b…` → container dựng lại |
| `/api/health` | **`{"ok":true}`** |
| bộ nạp | **KHÔNG bị dựng lại** (vẫn container cũ) ✓ |
| production | `ok:true` — **chỉ đọc**, không container nào bị đụng ✓ |
| migration mới áp | `order_field_provenance` ✓ · 4 cột ảnh chụp giá ✓ · 98 → **99 bảng** |

Phiên soát của người khác: dữ liệu nằm ở CSDL, **không bị đụng** — chỉ container ứng dụng được
dựng lại (~12 giây).

---

## 3. CẦU DAO — KIỂM LỖI ĐẠT, ĐÃ BẬT TRÊN STAGING

Năm tình huống chạy qua **chính `runModelStep()`**, và phép đo là **số lần nhà cung cấp bị gọi** —
vì sự cố 17–19/09 không phải "xử sai một lượt" mà là "xử đúng một lượt, lặp lại 470 lần".

| tình huống | tắt | bật | kết luận |
|---|---|---|---|
| **HẾT HẠN MỨC** | 10 lượt → **20 lần gọi** | **≤ 2 lần gọi**, 1 lần mở, ≥ 8 lượt bỏ qua | cắt được cơn mưa yêu cầu |
| **KHOÁ SAI** | — | cắt ngay, `probeAfter` = **null** | khoá sai không tự đúng ⇒ không tự dò lại |
| **CHẶN TỐC ĐỘ** | — | cắt, chờ **ngắn hơn** hết hạn mức | chờ là qua |
| **QUÁ THỜI GIAN** | — | **KHÔNG mở cầu dao**, mọi lượt vẫn thử | một lượt xui không phải bằng chứng nhà cung cấp chết |
| **KHOẺ** | — | **giống hệt tắt, tới từng ô** | điều kiện để dám bật |

**Lưới nghiệp vụ không bị đi vòng:** dựng đúng tình huống xấu (cầu dao đang mở, mô hình không chạy
được lượt nào, trạng thái đơn gần trắng) — điều kiện lên đơn **y hệt** lúc bình thường, so cả
danh sách chứ không từng mục.

**Đã bật trên staging** (`ai.config.circuitBreakerEnabled = true`), và **chỉ staging**. Quan sát
sau khi bật: **11 lượt gọi, 11 đạt, 0 lỗi, 0 lần cắt** — đúng như tình huống KHOẺ dự đoán.

> Một cửa phải mở mới: thao tác `set-setting` có sẵn chạy trong container **`erp-app`, tức là
> PRODUCTION**. Dùng nó để bật một thứ trên bản chạy thử là ghi nhầm vào chỗ đang phục vụ khách
> thật, và không có gì trong tên thao tác nói ra điều đó. Đã thêm `ai-staging-setting` chỉ mở vào
> `vnx-ai-staging-app`.

Cờ nay ở `settings` (đè biến môi trường), **không** ở `hardLimits`: chặn cứng phải env-only để
không ai nới được từ màn hình; còn cầu dao bật lên chỉ làm hệ thống **thôi** gọi một nhà cung cấp
vừa hỏng — hướng **hẹp hơn**, không mở thêm quyền nào.

---

## 4. SỔ GIÁ — CƠ CHẾ XONG, CÒN CHẶN Ở HAI CON SỐ CỦA CHỦ SHOP

Ba lỗi đã sửa ở phiên trước (ghi sai khoá `settings`, hai bảng giá song song, thiếu ô giá đệm).
Đo lại sau triển khai:

| | |
|---|---|
| `pricingVersion` | **(chưa khai)** |
| số mẫu đã khai giá | **0** |
| lượt gọi tính được tiền | **0 / 11** |
| lượt có **ảnh chụp giá** | **0 / 11** |

Ảnh chụp giá bằng 0 là **đúng và nhất quán**: chưa khai đơn giá thì `priceUsedFor()` trả `null`,
nên cả chi phí lẫn ảnh chụp đều `PRICING_UNKNOWN`. **Không lượt nào bị ghi cost = 0.**

**P5 (đối chiếu usage × giá × tỷ giá ≈ cost) CHƯA CHẠY ĐƯỢC** — nó cần đúng hai con số mà chỉ chủ
shop quyết:

1. **tỷ giá USD→VND**;
2. **đơn giá công bố của `gpt-5.6-luna` và `gpt-5.6-terra`**.

```
npx tsx scripts/ai-set-pricing.ts --usd-vnd=<tỷ giá> \
  --model="gpt-5.6-luna:<usd vào>/<usd ra>/<usd đệm>" \
  --model="gpt-5.6-terra:<usd vào>/<usd ra>/<usd đệm>"
```

Khai xong, mọi lượt gọi **mới** tự mang ảnh chụp giá; lượt cũ giữ `NULL` và mọi phép tính lại trên
chúng phải mang nhãn `ESTIMATED_WITH_CURRENT_PRICE`.

---

## 5. MÁY XIN NGƯỜI VÀO MÀ CHƯA AI NHẬN — CON SỐ LỚN HƠN NHIỀU SO VỚI DỰ ĐOÁN

Đo 19/09/2026 trên bản chạy thử:

| | |
|---|---|
| **chưa ai nhận** | **202** |
| đã có người nhận | **0** |
| cũ nhất | **6 047 phút ≈ 4,2 ngày** |
| tuổi trung bình | **1 086 phút ≈ 18 giờ** |
| ngưỡng hạn xử lý | **(CHƯA KHAI)** ⇒ mọi dòng là `UNKNOWN`, **không phải "trong hạn"** |

Con số 24 ở phiên trước là một lát cắt cũ; thực tế là **202**, và **chưa một lần nào có người nhận**.

**Lý do máy xin người vào — 202/202 đều có mã lý do** (luật 13 không bị vi phạm):

| lý do | số hội thoại |
|---|---:|
| `SIZE_DATA_MISSING` — ERP chưa có bảng số đo | **95** |
| `LOW_CONFIDENCE` — không hiểu khách muốn gì | 89 |
| `LOW_CONFIDENCE` — hỏi "size" 3 lần không có câu dùng được | 7 |
| `AFTER_SALES` | 4 |
| `PRICE_NEGOTIATION` | 3 |
| `COMPLAINT` | 3 |
| `LOW_CONFIDENCE` — hỏi "variant" 3 lần | 1 |

**Đọc số:** gần **một nửa** (95 + 7 = 102/202) là chuyện **bảng số đo**. Máy từ chối đoán size —
đúng luật — rồi xin người vào, và không ai vào. Khai bảng số đo cho các mẫu đang chạy sẽ xoá
khoảng một nửa hàng đợi này mà không cần đụng tới mô hình nào.

Đã dựng `UNCLAIMED_MACHINE_HANDOFF` ở mức **BÁO CÁO**, cố ý **không** thành nguồn việc: kho mã đã
có hai bộ máy dò việc sót ở **cùng độ mịn một hội thoại**, và thêm một nguồn nữa ở đúng độ mịn ấy
là cộng hai lần tiền ở mọi tổng hợp. Ngưỡng `work.machineHandoffSlaMinutes` **không có mặc định
nghiệp vụ**.

---

## 6. SỔ NGUỒN Ô ĐƠN HÀNG — CHƯA CHỨNG MINH ĐƯỢC TRÊN DỮ LIỆU SỐNG

Bảng đã có trên staging. Sau mẻ chạy ngầm 12 lượt: **0 dòng**.

Sáu phép kiểm ca đều "rỗng = đạt", nên **trên một bảng rỗng chúng đạt một cách vô nghĩa**. Tôi
**không** đọc chúng là PASS.

Đã hỏi thẳng CSDL để phân biệt hai khả năng, và câu trả lời là:

> **A — KHÔNG CÓ GÌ ĐỂ GHI: 12/12 lượt không đổi một trong sáu ô.** Sổ rỗng là **đúng** (ca C).

12 lượt ấy: 4 `ANSWER_QUESTION`, 8 `NO_ACTION` (người đã cầm hội thoại). Không lượt nào chạm tới
mã hàng · mẫu mã · màu · size · SĐT · số lượng.

**Trạng thái thật: đường ghi KHÔNG bị bác bỏ, nhưng cũng CHƯA được chứng minh.** Sáu ca vẫn đứng
ở bài kiểm đơn vị (đã đạt). Để đóng V1 cần một lượt chạy **thật sự đổi một ô** — và tôi không tạo
ra nó, vì bịa một tin nhắn khách để làm bảng đẹp lên là bịa dữ liệu.

---

## 7. NHÀ CUNG CẤP

| | trạng thái |
|---|---|
| **OpenAI** | **KHOẺ.** Khói ngắn trước triển khai: 1 lượt ĐẠT, 143/0/85 token, **2 470 ms**, lỗi `null`, **429 = 0**. Sau triển khai: **11/11 lượt đạt, 0 lỗi**. |
| **Anthropic** | **CHẶN: chưa có credential trên bản chạy thử.** Phép dò báo "CHƯA CẤU HÌNH" — đó **không** phải một lỗi, và không bịa kết quả. |
| **Gemini** | **CHẶN: chưa có `GOOGLE_AI_API_KEY`.** Adapter + 4 lớp chặn đã xong và có bài kiểm; chưa lượt gọi nào xảy ra. |
| **cầu dao** | **BẬT** trên staging · trạng thái `HEALTHY` · 0 lần mở · 0 lượt bị cắt |

---

## 8. AN TOÀN — ĐỌC LẠI TỪ BẢNG, KHÔNG PHẢI LỜI HỨA

| | |
|---|---|
| tin đã gửi khách | **0** |
| đơn máy đã tạo | **0** (công cụ đơn **chưa được gọi lần nào**) |
| challenger gửi khách | **0** (chưa có challenger nào chạy) |
| ghi vào production | **0** |

---

## 9. HUMAN REVIEW

**Chưa có ca nào được chấm.** Không một con số chất lượng nào trong báo cáo này đến từ máy tự chấm
máy. Ngưỡng đã khai sẵn trong mã: **< 20** chẩn đoán · **20–37** sơ bộ · **38–50** so sánh có
nghĩa đầu tiên · **100+** bằng chứng mạnh.

**P11 (benchmark) và P12 (đo rule-only so với sự thật người chấm) vẫn CHẶN ở đây.**
`644/1006 · 74,7%` vẫn chỉ là **ELIGIBILITY**, chưa activate.

---

## 10. KHUYẾN NGHỊ: `READY FOR SHADOW MULTI-PROVIDER`

Không phải `READY FOR LIMITED ROUTER PILOT`: một pilot đòi bằng chứng chất lượng, và **0 ca được
chấm** nên chưa có gì để so.

Không còn là `KEEP CURRENT ROUTER` như phiên trước, vì bốn thứ chặn khi ấy nay đã khác:

- OpenAI khoẻ, đo lại hai lần trong phiên;
- đường hoà giải migration **đã có và đã kiểm hai chiều**;
- cầu dao **đã kiểm lỗi và đã bật** ở staging, chứng minh được rằng nó không đổi gì khi mọi thứ khoẻ;
- cơ chế chi phí đã thông từ đầu tới cuối, chỉ còn chờ hai con số của chủ shop.

**Router live KHÔNG đổi.** Không bật AUTO. Gemini vẫn không có đường ra tới khách.

### Việc tiếp theo, theo thứ tự đáng làm

1. **Khai bảng giá** (tỷ giá + đơn giá hai mẫu `gpt-5.6-*`) → mở khoá P5 và toàn bộ bảng chi phí.
2. **Khai bảng số đo** cho các mẫu đang chạy → xoá khoảng **một nửa** trong 202 việc đang treo.
3. **Đặt `work.machineHandoffSlaMinutes`** → 202 việc ấy có đồng hồ.
4. **Chấm 30–50 ca** ở `/ai/review` → mở khoá P11/P12.
5. Cấp credential Anthropic / Gemini khi muốn chạy đối chứng (mỗi nhà: 1 khói → tối đa 10–20 ngầm).
6. Khi gộp nhánh: theo đúng thứ tự sổ ở mục 1, và chạy lại `tests/migration-reconcile.test.ts`
   trên sổ đã gộp thật.

---

## 11. ĐÃ KHÔNG LÀM

- Không gộp nhánh vào `main` (đúng yêu cầu: chỉ gộp sau khi kiểm xanh — kiểm đã xanh, việc gộp
  là một quyết định riêng).
- Không đọc journal production (không cần, và mọi thiết kế không phụ thuộc vào nó).
- Không xây miss-case engine thứ hai.
- Không mở rộng sổ nguồn sang `address` / `name` / `price`.
- **P14 (gộp tin nhắn liên tiếp)** — chưa làm; thấp hơn migration/chi phí/review, và phiên này đã
  dùng hết chỗ cho bốn việc trên.
