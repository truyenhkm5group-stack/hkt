# Bộ định tuyến nhiều nhà cung cấp + đối chiếu chi phí — đo ngày 19/09/2026

**Khuyến nghị: `KEEP CURRENT ROUTER`.** Lý do không phải "bộ định tuyến mới chưa tốt" — mà là ba
điều kiện để *so sánh* còn chưa tồn tại, và một trong ba là chuyện đang cháy. Chi tiết ở mục 6.

Mọi con số dưới đây đo trên bản chạy thử, cửa sổ 30 ngày tới 19/09/2026, **1006 lượt chạy**. Không
lượt nào bị sửa, không mô hình nào bị gọi, nấc quyền hạn không bị đụng tới.

---

## 1. AUDIT TRƯỚC — cái gì đã có rồi

Đặc tả đòi "xây hợp đồng trung lập nhà cung cấp". Phần lớn nó **đã có**, nên phiên này dùng lại
thay vì dựng bản thứ hai:

| Đặc tả đòi | Đã có ở đâu | Việc phải làm |
|---|---|---|
| §2 hợp đồng chung (kết quả · token · độ trễ · chi phí) | `lib/ai-workforce/providers/types.ts` — `CompletionRequest` / `CompletionResult` / `ModelProvider`, có đủ **bốn rổ token** | không sửa gì |
| §4 định tuyến theo tầng | `lib/ai-workforce/model-router.ts` — leo nấc `RULE → ECONOMY → STRONG → HUMAN`, không một nhánh nào rẽ theo tên nhà cung cấp | không sửa gì |
| chi phí ước tính | `estimateCostVnd()` — bốn rổ, ba mức giá, `null` khi chưa khai | không sửa gì |
| ghi từng lượt gọi | bảng `ai_model_calls` — nhà cung cấp · mẫu · nấc · bước · 3 rổ token · tiền · phiên bản bảng giá · độ trễ · hỏng/không · lời lỗi | không sửa gì |
| §10 kiểm tra trước khi lên đơn | `missingOrderRequirements()` (`confirm.ts:106`) | không sửa gì — xem mục 5 |
| §3 sổ mẫu mô hình | **chưa có** | đã thêm |
| Gemini | **chưa có** | đã thêm |
| §6 mô phỏng định tuyến ngầm | **chưa có** | đã thêm |

Nói thẳng: **hợp đồng trung lập không phải thứ phải xây, nó đã trung lập sẵn.** Phần thiếu là một
nhà cung cấp thứ ba, một bản khai mẫu mô hình, và một phép đo.

---

## 2. GEMINI — có mặt để ĐO, bị khoá khỏi đường ra tới khách

`lib/ai-workforce/providers/google.ts` viết theo đúng `ModelProvider` đang có. Khoá bằng danh sách
`SHADOW_ONLY_PROVIDERS` (`lib/ai-workforce/config.ts`), **bốn cánh cửa**, cửa nào cũng có bài kiểm:

1. **biến môi trường** — `AI_WORKFORCE_PROVIDER=google` không khai được.
2. **bộ chọn mặc định** — `defaultProviderName()` về `stub` ngay cả khi Gemini là nhà cung cấp
   **duy nhất** có khoá.
3. **cấu hình trong CSDL** — `ai_agent_versions.routing` sửa được từ màn hình, nên nó không phải
   thẩm quyền đủ; `runModelStep()` đi qua `getLiveProvider()` và từ chối **trước khi gọi mạng**.
4. **sổ đăng ký** — `getProvider()` vẫn trả về nó, vì phép đo phải gọi được. Đó là ranh giới cần
   giữ, không phải ranh giới cần xoá.

Ba chỗ Gemini đếm token khác, chép thẳng là báo sai hoá đơn theo cả hai chiều:
`promptTokenCount` **đã gồm** phần đệm (phải trừ ra, không thì báo đắt); `thoughtsTokenCount` tính
theo giá **đầu ra** nhưng không nằm trong `candidatesTokenCount` (phải cộng, không thì báo rẻ); bộ
đệm ngầm không tính tiền lượt ghi (rổ ghi-đệm là **0 thật**, khác "chưa biết").

---

## 3. RULE-FIRST — con số đáng giá nhất của cả phiên

| | số lượt | tỷ lệ |
|---|---:|---:|
| `RULE_ONLY_ELIGIBLE` (luật đủ tự tin, không rủi ro, không ảnh) | 751 / 1006 | **74.7%** |
| thật sự rơi vào làn `RULE_ONLY` | 644 / 1006 | **64.0%** |

Ba con số khớp nhau và chênh lệch giữa chúng có nghĩa: **771** lượt có độ tin ≥ 0.75 → **751** sau
khi loại ảnh / người đã cầm / ý định rủi ro → **644** sau khi nhánh CHUYỂN NGƯỜI (chạy trước) lấy
đi 107 lượt.

Đây **không phải** phép tiết kiệm chi phí, nó là phép giảm rủi ro mà tiện thể rẻ hơn: mỗi lượt luật
xử được là một lượt không tốn token **và không có cơ hội bịa**.

Và nó cũng là lý do mạnh nhất để chưa vội thêm nhà cung cấp: **thêm mô hình thứ ba không làm gì cho
644 lượt ấy cả.**

### Một chỗ phải nói ra, không được giấu

`complexityOf()` có bốn yếu tố, nhưng yếu tố nặng nhất — "luật không kết luận được độ tin"
(+0.40) — **chưa bao giờ chạy trên dữ liệu thật: 0/1006 lượt có độ tin `null`** (dải thật:
0.200 – 0.990). Lược đồ `UNDERSTANDING_SCHEMA` bắt buộc `confidence` là số, nên bậc luật luôn trả
về một con số.

Hệ quả: điểm độ khó hiện đang do **ba** yếu tố quyết (độ tin thấp · chưa nối được mã hàng · hội
thoại dài), không phải bốn. Nhánh kia không sai, nó chỉ chưa có dịp chạy — và một bảng phân bổ
trông như đã cân nhắc đủ bốn yếu tố thì dễ bị tin hơn mức nó đáng được tin.

---

## 4. PHÂN BỔ LÀN, VÀ ĐỐI CHIẾU CHI PHÍ

Mô phỏng chạy hai kịch bản trên **cùng** 1006 lượt. Cờ đối chứng chỉ đổi **nhà cung cấp trong cùng
một nấc**, không bao giờ đổi nấc — so hai nhà cung cấp ở hai nấc khác nhau là phép so vô nghĩa.

| Làn | đang chạy | đối chứng Gemini |
|---|---:|---:|
| `RULE_ONLY` | 644 (64.0%) | 644 (64.0%) |
| `OPENAI_ROUTINE` | 143 (14.2%) | 0 |
| `GEMINI_ROUTINE` | 0 | 143 (14.2%) |
| `ANTHROPIC_COMPLEX` | 2 (0.2%) | 0 |
| `GEMINI_COMPLEX` | 0 | 2 (0.2%) |
| `HUMAN` | 217 (21.6%) | 217 (21.6%) |

### Bảng tiền: HIỆN TẠI — · ROUTER V1 —

**Cả hai ô đều là CHƯA BIẾT, và không được in thành 0.** Nguyên nhân đã truy tới tận gốc, không
phải suy đoán:

- **660** lượt gọi mô hình trong cửa sổ, **660/660 chưa khai đơn giá**.
- Bảng `settings` **không có dòng `ai.config` nào** (0 rows). Chưa ai từng khai bảng giá.

Đây là chỗ đặc tả và luật 42 của kho mã nói cùng một điều, nên phép đo dừng ở đây thay vì đoán:
giá phải do **chủ shop khai** (`settings`, mục `pricing`), **không tra trên Internet**. Khai xong,
chạy lại `ai-staging-router-sim` là có ngay cả hai cột.

---

## 5. §9 SỔ SỰ THẬT ĐƠN HÀNG và §10 KIỂM TRA TRƯỚC KHI LÊN ĐƠN

### §10 — ĐÃ CÓ ĐỦ, không dựng lại

`missingOrderRequirements(state)` (`lib/ai-workforce/agents/sales/confirm.ts:106`) là hàm **thuần**
(không CSDL, không mạng, không đồng hồ) và phát đúng năm mã: `VARIANT` · `QUANTITY` · `PHONE` ·
`ADDRESS` · `PRICE`.

**Mô hình không đè được nó**, bốn lớp độc lập:
`decide()` tự gọi lại nó và hạ `CREATE_DRAFT_ORDER` xuống `SEND_ORDER_REVIEW` khi còn thiếu
(`decide.ts:122-129`) → dây chuyền chặn lần nữa trước khi gọi công cụ → cổng công cụ đọc lại nấc
quyền hạn **từ CSDL** chứ không tin lời gọi → và **giá lên đơn là giá máy chủ tính**, lược đồ đầu
vào của công cụ **không có ô giá** (`erp.ts:567-568`).

Kết luận: đặc tả §10 đã được thoả. Dựng một "preflight" thứ hai là dựng nguồn sự thật thứ hai cho
đúng câu hỏi ấy.

### §9 — CÓ MỘT NỬA, và nửa thiếu là nửa quan trọng

Trạng thái đơn nằm ở **một ô jsonb duy nhất**: `sales_conversations.state`. Nó là một túi phẳng các
giá trị trần — `size`, `phone`, `address`, `quotedTotal`… **không ô nào mang nguồn, thời điểm hay
độ tin.**

- **Có lịch sử theo LƯỢT**: `ai_runs.state_before` / `state_after` chụp trọn túi ấy trước và sau
  mỗi lượt, nên **biết được một ô đã ĐỔI ở lượt nào**.
- **Không biết được AI ĐÃ ĐỔI NÓ**: ví dụ `state.size` có ba chỗ ghi khác nhau (khách nói · bảng
  số đo ERP · dòng mẫu mã khớp được), cả ba ghi cùng một chuỗi trần. Đọc xong không phân biệt được.
- **Ngoại lệ duy nhất, và nó đã làm đúng**: mã hàng / mẫu mã có sổ riêng
  `sales_product_resolutions` — mỗi lượt một dòng, có `source` (11 giá trị khai sẵn), `confidence`,
  `evidence`, `candidate_count`, trỏ về `run_id` và `message_id`.

Nên việc phải làm cho §9 **không phải** dựng bảng mới: nó là mở rộng đúng khuôn mẫu
`sales_product_resolutions` đã chứng minh được, sang các ô còn lại. Phiên này **không làm** —
xem mục 7.

---

## 6. VÌ SAO `KEEP CURRENT ROUTER`

Bốn điều kiện để câu "bộ định tuyến mới tốt hơn" có nghĩa. **Không điều nào đang đúng:**

1. **Không có giá ⇒ không có phép so chi phí.** 660/660 lượt gọi chưa khai đơn giá; bảng `settings`
   chưa có dòng cấu hình AI nào. Cả cột HIỆN TẠI lẫn cột ROUTER V1 đều là CHƯA BIẾT. Một bộ định
   tuyến tối ưu chi phí mà chưa đo được chi phí thì chưa có gì để tối ưu.

2. **0/1006 lượt có người chấm ⇒ cấm nói về chất lượng.** Đặc tả §8 ghi thẳng điều này, và phiên
   này giữ: không một con số nào trong báo cáo gọi một mô hình là tốt hơn mô hình khác.

3. **Champion đang chết, và chết từ hai ngày trước.** Đây là phát hiện quan trọng nhất của phiên:

   > `erp / gpt-5.6-luna / ECONOMY` — **470 lượt gọi, hỏng 470 (100%)**
   > `openai: 429 You have no credits remaining. Add credits to continue using the API`
   > từ **17/09 08:04** tới **19/09 12:05** (vài giờ trước lúc đo).

   Tài khoản OpenAI **hết hạn mức**. Nấc rẻ — nấc gánh phần lớn lượt gọi — đã không chạy được lần
   nào trong hai ngày. Không thể đối chứng một thách thức với một champion không chạy.

   *Tin tốt trong tin xấu:* đường lui hành xử đúng. Mô hình hỏng ⇒ `runModelStep` leo nấc rồi
   `HUMAN`, không rơi về một giá trị bịa. Không lượt nào lấy 429 làm câu trả lời cho khách.

   Số đo của lượt gọi **chạy được** (trước khi hết hạn mức), để đối chiếu về sau:

   | nhà cung cấp / mẫu | nấc | lượt | hỏng | p50 | p95 | gần nhất |
   |---|---|---:|---:|---:|---:|---|
   | `erp:openai` / `gpt-5.6-luna` | ECONOMY | 172 | 15 (8.7%) | 2 170 ms | 4 547 ms | 17/09 |
   | `erp:openai` / `gpt-5.6-terra` | STRONG | 18 | 14 (77.8%) | 1 885 ms | 4 644 ms | 16/09 |

   14/18 lượt nấc mạnh hỏng vì **sai lược đồ** (`entities.productCode`, `evidence`,
   `entities.quantity` trả sai kiểu) — đó là việc phải sửa riêng, không liên quan tới nhà cung cấp.

4. **Gemini chưa có khoá ⇒ chưa có đầu ra nào để so.** Adapter đã sẵn sàng; chưa lượt gọi nào xảy ra.

**Phần thưởng lớn nhất mà phép đo chỉ ra cũng không nằm ở nhiều nhà cung cấp:** 64% số lượt không
cần mô hình nào. Thêm nhà cung cấp thứ ba không động tới 644 lượt ấy.

### Trước lần quyết định sau, cần đúng bốn việc

1. Nạp lại hạn mức OpenAI (**đang cháy** — nấc rẻ chết hai ngày rồi).
2. Khai bảng giá vào `settings` mục `pricing` + một `pricingVersion`. Không tra giá trên Internet.
3. Chấm tay 30–100 ca ở `/ai/review` (mẻ phân tầng đã dựng sẵn).
4. Nếu muốn đối chứng Gemini: đặt `GOOGLE_AI_API_KEY` + `AI_MODEL_GOOGLE_*`. Đặt xong nó **vẫn**
   không ra tới khách — đó là chủ ý, bốn cánh cửa ở mục 2.

Xong bốn việc, chạy lại `ai-staging-router-sim` là có bảng chi phí thật.

---

## 7. PHIÊN NÀY KHÔNG LÀM GÌ — nói rõ để không ai tưởng đã có

- **§7 / §8 gọi thật champion–challenger.** Gọi được thì phải có khoá Gemini *và* một điểm chất
  lượng để so. Chưa có cái nào.
- **§11 máy chấm rủi ro** — mới có bản mô phỏng hai chiều, chưa có máy chấm nối vào dây chuyền.
- **§12 máy dò ca trượt · §13 tối ưu ngữ cảnh · §14 tra danh mục · §15 định tuyến ảnh.**
- **§17 màn hình chi phí** — không dựng màn hình cho một bảng số mà mọi ô đều là CHƯA BIẾT.
- **§19 nối ca đã chấm vào bộ đối chứng** — chưa có ca nào được chấm.
- **§9 sổ sự thật đơn hàng theo từng ô** — đã khảo sát (mục 5), chưa viết.
- **Không đổi một dòng nào của bộ định tuyến đang chạy**, ngoài việc bắt nó đi qua
  `getLiveProvider()` — thay đổi duy nhất, và nó chỉ **thu hẹp** chứ không mở rộng.

## 8. Một việc nhỏ nên sửa, và vì sao phiên này không tự sửa

Lượt gọi **hỏng** ghi tên nhà cung cấp **đã yêu cầu** (`erp`), lượt **thành công** ghi tên **đã
phân giải** (`erp:openai`). Nên cùng một mẫu hiện ra hai dòng trong mọi bảng gộp — đúng như bảng ở
mục 6.

Sửa thì dễ, nhưng nó đổi thứ production **ghi vào** `ai_model_calls`, mà phiên này khai là không
đụng hành vi đang chạy. Nêu ra để lần sau sửa có chủ đích, kèm một lượt dựng lại nhãn cũ.
