# Sales AI · phiên 19/09/2026 (tối) — P0 hồi phục, cầu dao, sổ giá, sổ nguồn ô đơn

**P0: ĐẠT.** OpenAI đã hồi phục thật trên bản chạy thử. Không còn `429 no-credit`.
Production không bị đụng, AUTO không bật, không tin nào gửi khách, không đơn nào được tạo.

---

## 1. P0 — XÁC MINH HỒI PHỤC

Chạy bằng **chính credential và chính cấu hình** bản chạy thử đang dùng (script chạy trong
container, đọc cùng `.env.staging`, đi qua chính `runModelStep` và chính `UNDERSTANDING_SCHEMA`
mà mỗi tin nhắn khách đi qua). Không dùng khoá riêng: một phép dò cầm khoá riêng sẽ xanh trong
khi dây chuyền thật vẫn đỏ, và đó là kiểu báo cáo làm người ta ngừng tìm.

### Bước A — một lượt gọi (run `35454314375`)

| | |
|---|---|
| HTTP | thành công |
| hợp đồng có cấu trúc | **hợp lệ** (đúng `UNDERSTANDING_SCHEMA`) |
| token vào / đệm / ra | **143 / 0 / 85** |
| độ trễ | **3 454 ms** |
| nhà cung cấp / mẫu | `erp:openai` / `gpt-5.6-luna` |
| lời lỗi | **`null`** |
| ghi vào `ai_model_calls` | **1 dòng ✓** |
| `429 no-credit` | **0 ✓** |

### Bước B — mẻ ngầm 20 hội thoại (run `35454501320`, đếm ở `35454691172`)

| | |
|---|---|
| lượt gọi mô hình | **17** (8 `understand` + 7 `generate` + 2 `understand` nấc mạnh) |
| thành công | **17 / 17 = 100%** |
| hỏng · 429 · hết giờ | **0 · 0 · 0** |
| độ trễ TB | 2 162 ms · 2 663 ms · 2 130 ms |
| token vào / ra | 4 648 / 1 966 |
| **đường lui dùng tới** | **0 lần** — 21 lượt chạy đều `(không leo nấc)` |
| lượt chạy | 13 ECONOMY · 6 RULE · 2 STRONG · **0 chuyển người, 0 thất bại** |
| tin đã gửi khách | **0 ✓** |
| đơn máy tạo | **0 ✓** (công cụ đơn **không được gọi lần nào**) |

**Đạt toàn bộ điều kiện nghiệm thu của mục 1.** Chi phí vẫn là CHƯA BIẾT — lý do ở mục 3, và đó
là một lỗi đã tìm ra và sửa trong phiên này, không phải một ô trống.

---

## 2. CẦU DAO (§2, §3) — LÀM XONG, **TẮT MẶC ĐỊNH**

`runModelStep()` xử lý một lượt hỏng rất đúng — leo nấc rồi chuyển người — nhưng nó **không nhớ
gì giữa các lượt**, nên hôm 17–19/09 nó làm đúng như vậy 470 lần liên tiếp. Cái thiếu không phải
cách xử một lượt, mà là trí nhớ.

- **6 trạng thái** · **9 nhóm lỗi** · chính sách là một **BẢNG theo nhóm lỗi**, không một dòng
  `if provider === …` nào. Phép quét mã nguồn khoá điều đó.
- **429 hết tiền ≠ 429 chặn tốc độ.** Hết tiền → 0 lần thử lại, mở cầu dao, chờ 30 phút. Chặn tốc
  độ → thử lại có lùi dần, chờ 1 phút. Ngân sách tổ chức/dự án xếp vào **hết hạn mức** (người phải
  vào bảng điều khiển nới nó). Khoá sai → **không tự dò lại**.
- **Bài kiểm bắt một lỗ thật trước khi nó ra tới bản chạy thử:** bản đầu đặt phép thử "hết tiền"
  *bên trong* nhánh 429 sau một cổng chữ. Lời lỗi hết tiền thật của một nhà cung cấp khác là
  *"Your credit balance is too low"* — không khớp cổng ấy, rơi vào `UNKNOWN`, **không mở cầu dao**,
  tức là đúng lại kịch bản thử-lại-suốt-hai-ngày. Đã sửa: phép thử đứng ngoài nhánh 429.
- **§3 được khoá bằng phép quét mã nguồn**: hai tệp cầu dao không được nhắc tới điều kiện lên đơn,
  máy trạng thái, chính sách rủi ro hay luật chuyển người. Đổi nhà cung cấp mà đổi luôn mức kiểm
  tra là biến một sự cố hạ tầng thành một lỗ hổng nghiệp vụ.
- **TẮT mặc định** (`AI_CIRCUIT_BREAKER_ENABLED`) — nhưng **vẫn đếm**, nên đọc được "nếu bật thì
  đã bỏ qua bao nhiêu lượt" *trước* khi bật.

---

## 3. SỔ GIÁ (§4–§6) — TÌM RA VÌ SAO CHƯA BAO GIỜ TÍNH ĐƯỢC TIỀN

### Lỗi gốc: ghi một đằng, đọc một nẻo

`scripts/ai-set-pricing.ts` ghi vào `settings["ai"]`. `getAiSettings()` đọc `settings["ai.config"]`.
**Hai khoá khác nhau** — script chạy xong, in "đã ghi", và không một lượt gọi nào tính được tiền.
Không lỗi, không cảnh báo. Đó là lý do 660/660 lượt trong 30 ngày đều `cost_vnd IS NULL` dù kho mã
đã có sẵn cả bộ công cụ khai giá.

Đã sửa: lấy khoá từ hằng số `AI_CONFIG_KEY`, và **đọc lại sau khi ghi** rồi thoát mã lỗi nếu đọc
lại không thấy gì.

### Hai lỗi còn lại

- **Hai bảng giá cho cùng một mô hình** — `lib/ai/provider.ts::PRICE_PER_MTOK` song song với
  `lib/constants/ai-model-pricing.ts`. Đã gỡ bảng thứ hai; cả hai tầng AI nay đọc chung một sổ.
- **Thiếu ô giá đệm** — `estimateCostVnd()` trả CHƯA BIẾT khi lượt gọi có token đệm mà bảng giá
  chưa khai giá đệm. Khai thiếu một ô thì công sức khai giá thành vô ích. Sổ nay có đủ, và
  `--model=` nhận `<vào>/<ra>/<đệm>/<ghi đệm>`.

### §5 — ảnh chụp giá theo từng lượt gọi

`pricing_version` chỉ nói ta dùng **bảng giá nào**, mà bảng giá nằm trong `settings` và **bị ghi
đè**. Nên ba cột mới giữ **chính đơn giá đã dùng**. Bài kiểm chứng minh: dựng lại đúng con số chi
phí của tháng trước từ ảnh chụp, *sau khi* bảng giá đã đổi tỷ giá.

**Không backfill.** 660 lượt cũ giữ nguyên `NULL`; phép tính lại trên chúng phải mang nhãn
`ESTIMATED_WITH_CURRENT_PRICE`, không được gọi là chi phí thật.

### §6 còn chặn ở đúng HAI con số của chủ shop

1. **Tỷ giá USD→VND.** 2. **Đơn giá công bố của `gpt-5.6-luna` và `gpt-5.6-terra`.**

Hai mô hình ấy **cố ý không có** trong sổ: tôi không biết đơn giá công bố của chúng, và chép một
con số nhớ mang máng sẽ tạo ra bảng chi phí trông rất thuyết phục mà sai. Khai xong:

```
npx tsx scripts/ai-set-pricing.ts --usd-vnd=<tỷ giá> \
  --model="gpt-5.6-luna:<usd vào>/<usd ra>/<usd đệm>" \
  --model="gpt-5.6-terra:<usd vào>/<usd ra>/<usd đệm>"
```

---

## 4. SỔ NGUỒN Ô ĐƠN HÀNG (§16, §17) — LÀM XONG, ĐÃ NỐI VÀO DÂY CHUYỀN

Sáu ô: `product_id` · `variant_id` · `color` · `size` · `quantity` · `phone`.

**Hai cột cho hai câu hỏi khác nhau, không gộp:** `source_type` (tới từ đâu) và `claim`
(`STATED`/`DERIVED`/`INFERRED` — có phải lời khách nói không). Gộp lại thì *"size do bảng số đo
gợi ý"* và *"size khách tự chọn"* trông y hệt nhau, và khi kiện hàng không vừa thì hồ sơ nói khách
tự chọn. `claim` **lấy từ bảng**, nơi gọi không điền được.

Sáu ca của §17 đều có bài kiểm, viết theo hội thoại thật. Ca E kiểm **cả hai chiều**: máy suy ra
size thì là `DERIVED`, và khách tự nói size thì là `STATED` *kể cả khi* bảng số đo cùng lúc ra
đúng giá trị ấy.

**Không phải máy trạng thái thứ hai:** `sales_conversations.state` vẫn là nguồn sự thật; phép quét
mã nguồn cấm sổ này chạm vào lưới quyết định. Lỗi khi ghi sổ **bị nuốt có chủ ý** — nó không được
phép làm hỏng một lượt phục vụ khách — và lý do ghi ngay tại chỗ, kèm điều kiện phải gỡ nhánh ấy
nếu có ngày bảng này tham gia một quyết định.

---

## 5. §14 MỨC NGHIÊM TRỌNG và §15 ĐỘ TIN HỆ THỐNG — LÀM XONG (hằng số thuần)

- **Một tỷ lệ đúng/sai chung là một con số nói dối.** Hai mô hình cùng sai 10%: một sai ở "câu hơi
  dài", một sai ở "chốt đơn khi khách chưa đồng ý". Bài kiểm dựng đúng hai mẻ ấy rồi đòi kỳ vọng
  thiệt hại cách nhau **hơn 50 lần**. Trọng số 1 · 4 · 20 · 100, **cố ý không đều**.
- **Trọng số không phải tiền và không giả vờ là tiền.** ERP không đo được "một lần chốt nhầm đơn
  tốn bao nhiêu đồng".
- **`system_confidence` giữ riêng khỏi `model_confidence`**, vì chỗ chúng lệch nhau (mô hình rất
  tự tin, hệ thống không có bằng chứng) là dấu hiệu kinh điển của một câu bịa trôi chảy. Trộn
  thành một trung bình là xoá đúng tín hiệu ấy. `preferSystem()` trả kèm **nguồn**.
- 14 nhóm câu của §13 **đã có sẵn** (`EVAL_BUCKETS`) — dùng lại, và bài kiểm khoá việc dùng lại.

---

## 6. §19 MISS-CASE — **KHUYẾN NGHỊ: KHÔNG XÂY MỚI**

Khảo sát kho mã: **5/7 phép dò đã tồn tại**, ở hai bộ máy khác nhau.

| Đặc tả đòi | Đã có chưa | Ở đâu |
|---|---|---|
| khách đang chờ | **có, hai nơi** | `sales-copilot.ts::copilotQueue` (đúng bảng của nhân sự AI) · `sales-leakage.ts` nhóm `NO_REPLY` |
| ý muốn mua mà chưa có đơn | **có, dạng QUAN SÁT** | `INFO_NO_ORDER` · `ORDER_NOT_CREATED` |
| có SĐT mà đứng im | **có** | `sales-leakage.ts` nhóm `PHONE_NO_ORDER` |
| đủ điều kiện mà chưa xử lý | **có** | `INFO_NO_ORDER` · `ORDER_CREATION_BLOCKED` |
| chuyển người không ai nhận | **có, dạng CỜ** | `sales-copilot.ts::machineHandoff` |
| khiếu nại chưa xử | **có, ở mức `cs_cases`** | `cs-next-action.ts::COMPLAINT_CRITICAL` |
| hội thoại rủi ro cao chưa xử | **KHÔNG CÓ** | — |

**Vì sao không xây mới:** ba nhóm `NO_REPLY` · `PHONE_NO_ORDER` · `INFO_NO_ORDER` đã được
`getSalesLeakageQueue` giữ **ở cùng độ mịn một hội thoại**. Một bộ máy thứ hai phát cùng ba nhóm
ấy sẽ **cộng hai lần ở mọi tổng hợp** — đúng thứ luật 19 của kho mã cấm, và ở đây
`ALERT_KINDS_OWNED_ELSEWHERE` **không đỡ được**, vì chúng không phải "alert kind".

**Và một nhóm phải KHÔNG được xây lại:** luật suy diễn "ý muốn mua" từ từ khoá đã từng tồn tại và
bị **xoá có chủ ý** sau khi sinh **181 ca sai**. `conversation-funnel.ts` ghi thẳng: *"KHÔNG CÓ
PHÉP SUY DIỄN Ý ĐỊNH MUA ở đây. ERP không có nguồn cho nó"*.

**Ba khoảng trống thật, hẹp hơn nhiều so với "xây một bộ máy":**

1. **`machineHandoff` không có hạn xử lý.** Nó là một cái cờ trên một màn hình — không SLA, không
   già đi, không chiếu vào hàng đợi việc. Đo 18/09: 24 lần máy xin người vào, **0 lần có người
   nhận**, và không ai thấy.
2. **Bảng `sales_followups` chỉ có đường GHI, không có đường ĐỌC** (đã tự kiểm chứng: chỉ
   `erp.ts::followup.schedule` ghi, không truy vấn nào đọc). Hạ tầng nằm không.
3. **Không có khái niệm rủi ro ở mức hội thoại** — mọi thứ tên "rủi ro" trong kho mã đều thuộc về
   đơn hàng hoặc mã hàng.

---

## 7. §20 CHI PHÍ NGỮ CẢNH — KẾT QUẢ NGƯỢC VỚI CÂU HỎI

Dây chuyền **không gửi lịch sử hội thoại lần nào**: `understand` gửi đúng tin hiện tại,
`generate` gửi câu nháp + tin hiện tại. Nó đã ở đầu **nén nhất** của thang.

Đo 7 ngày (run `35456678696`): `understand` **87 token vào/lượt** (277 lượt) · `generate` **74**
(400 lượt) · đệm **0** ở cả hai.

⇒ **Phần "nén ngữ cảnh để tiết kiệm" gần như không còn gì để nén.** Câu hỏi còn mở là chiều ngược
lại: ngữ cảnh mỏng thế có phải nguyên nhân của mất trạng thái giữa hai lượt không — và đó là câu
hỏi **chất lượng**, phải có người chấm.

> **Một phép đo trong phiên này đã tự bác bỏ chính nó, và đã được sửa.** Bản đầu ước token bằng
> `ký tự ÷ 4`: nó ước lời dặn hệ thống (815 ký tự) ra 204 token, trong khi **toàn bộ** đầu vào đo
> được của bước ấy chỉ 87 token — một ước tính lớn hơn cả con số thật mà nó đang ước. Con số "gấp
> 3,4×" dựng trên nó cũng sai. Nay tỷ lệ **đo từ chính lượt đã chạy** (ra ~9,7 ký tự/token), và
> khi tỷ lệ ra cao bất thường thì bản in **nói thẳng** hai cách giải thích còn lại rồi hạ mọi ô
> ước tính xuống mức *dấu hiệu*. Con số sau hiệu chuẩn: ~1,4×.

---

## 8. CÒN CHẶN — VÀ CHẶN BỞI CÁI GÌ

| Mục | Trạng thái | Chặn bởi |
|---|---|---|
| §6 đối chiếu chi phí đầu-cuối | cơ chế **đã sửa xong và có bài kiểm** | **tỷ giá + đơn giá `gpt-5.6-*`** — quyết định của chủ shop |
| §7 khói Gemini | adapter + 4 lớp chặn **xong, có bài kiểm** | **chưa có `GOOGLE_AI_API_KEY`** trên bản chạy thử. Không bịa kết quả. |
| §7 soát lớp chặn Gemini **trên bản chạy thử** | — | **ảnh đang chạy cũ hơn nhánh** (chưa có Gemini). Cần một lượt dựng lại ảnh. |
| §8 khói Anthropic | — | **chưa cấu hình khoá** trên bản chạy thử (phép dò báo "CHƯA CẤU HÌNH", không phải lỗi) |
| §10–§12 đối chứng champion/challenger | — | **0 ca có người chấm**. §8 của đặc tả cấm nói về chất lượng khi chưa có. |

### Một món nợ kỹ thuật phải nói ra

Nhánh này và `main` **dùng trùng số hiệu migration 0084–0097** với nội dung khác nhau (nhánh này
đi từ 0083 lên 0097; `main` độc lập đi lên 0106). Tôi **đã thử `git merge origin/main` và đã huỷ
lượt merge**: gỡ đúng cần đánh số lại 14 migration mà bản chạy thử **đã áp dụng rồi** dưới tên cũ,
và đó là một quyết định về dữ liệu, không phải một thao tác gộp mã. Món nợ này có TRƯỚC phiên này;
nó phải được xử lý khi gộp nhánh, không phải giữa một phiên làm việc. Hai migration mới của phiên
này (`0098`, `0099`) đánh số theo dãy của **nhánh này**.

`0098` **viết tay** chứ không dùng `npm run db:generate`: bản sinh tự động ra một tệp **dựng lại
toàn bộ lược đồ** (115 KB, `CREATE TABLE` cho mọi bảng) vì ảnh chụp meta của kho đã lệch từ lâu —
29 ảnh chụp cho 98 mục sổ. Áp bản ấy lên CSDL đang chạy là tai hoạ.

---

## 9. ĐÃ KHÔNG LÀM — nói rõ để không ai tưởng đã có

- **Không bật AUTO.** Không đổi live router. Không gửi tin cho khách. Không tạo đơn. Không đụng
  production. Không dựng lại ảnh bản chạy thử (phiên soát của người khác đang chạy trên đó).
- **Không xây miss-case engine mới** — xem mục 6; xây là cộng hai lần tiền.
- §9 lưu từng ca mô phỏng, §10 nối ca đã chấm vào bộ đối chứng, §11 ngưỡng 20/38–50/100,
  §12 cấu hình champion/challenger, §13 báo cáo theo từng nhóm — **chưa làm**, và phần lớn chặn ở
  cùng một chỗ: chưa có ca nào được người chấm.
- Tin nhắn của chủ shop **bị cắt ở mục 21** ("21. MESSAGE BUR…") nên mục ấy chưa được đọc.

---

## 10. VIỆC TIẾP THEO, THEO THỨ TỰ ĐÁNG LÀM

1. **Khai bảng giá** (tỷ giá + đơn giá hai mẫu `gpt-5.6-*`) → mở khoá toàn bộ §6 và bảng đối chiếu
   chi phí. Rẻ nhất, mở được nhiều nhất.
2. **Chấm 30–50 ca ở `/ai/review`** → mở khoá §10–§12. Không có nó thì mọi phép so mô hình đều
   không được phép kết luận.
3. **Dựng lại ảnh bản chạy thử** khi phiên soát nghỉ → soát được lớp chặn Gemini trên chính bản
   chạy thử, và nối được sổ nguồn ô đơn vào dữ liệu thật.
4. **Đặt hạn xử lý cho `machineHandoff`** — khoảng trống hẹp nhất và đắt nhất trong ba khoảng
   trống ở mục 6: 24 lần máy xin người vào, 0 lần có người nhận.
5. Cân nhắc **bật cầu dao** sau khi đọc số `skipped` mà nó đã đếm sẵn ở chế độ tắt.
