# Nhân viên bán hàng AI — ĐỐI CHIẾU DỮ LIỆU SỐNG (19/09/2026)

Phiên này KHÔNG mở nhánh tính năng mới. Vòng chạy là: **đo trạng thái thật → kiểm đường nối
Pancake → soi 979 lượt đã có → tìm lỗi → vá → khoá bằng bài kiểm → triển khai bản chạy thử →
dò lại trên chính bản chạy thử**.

Mọi con số dưới đây đều kèm **mã lượt chạy** để tra lại. Chỗ nào chưa đo được thì ghi là
**CHƯA ĐO ĐƯỢC** — không thay bằng một con số gần đúng.

---

## 1. Trạng thái chạy THẬT — đo lúc 11:06, không đọc tài liệu cũ

Lượt chạy **35439186664** (`ai-staging-runtime`, CHỈ ĐỌC).

**Nấc quyền hạn có hiệu lực: `COPILOT`** — dựng từ `ai_agents.mode = COPILOT`, không có ghi đè ở
`settings.modes`, mặc định môi trường là `SHADOW`, trần `MAX_ALLOWED_MODE = COPILOT`.

| công tắc | giá trị thật trong container |
|---|---|
| MÁY tự gửi | **CẤM** (`false`) |
| NGƯỜI bấm gửi | được phép (`true`) |
| Tạo đơn | **CẤM** (`false`) |
| Bộ nạp sống | bật (`true`) — container `vnx-ai-staging-ingest` chạy 29 giờ |
| Gọi mô hình | bật · nhà cung cấp `erp` (dùng lại tầng AI sẵn có, KHÔNG dựng tích hợp thứ hai) |

**AUTO KHÔNG kích hoạt được, và điều đó đã được thử mà không ghi gì:** đặt
`ai_agents.mode = AUTO` cho ra nấc có hiệu lực `COPILOT`; `clampMode("AUTO")` trả `COPILOT`.
Trần là một hằng số môi trường, không hợp nhất được từ CSDL.

**COPILOT đang bật nhưng CHƯA AI DÙNG.** Sổ thao tác nấc trợ lý — nơi DUY NHẤT ghi "ai đã gửi gì
cho khách" — có **0** thao tác `SEND` / `EDIT_SEND`. Phiên này không bật, không hạ, không chạm
`settings.modes`; page thí điểm vẫn đúng một mã: `["1117899664739453"]`.

### Bằng chứng an toàn (bốn dòng đầu phải bằng 0 — đều bằng 0)

| phép đo | số đo |
|---|---|
| tin gợi ý đã gửi cho khách | **0** |
| tin do nhân sự AI soạn nằm trong bảng tin | **0** |
| hội thoại đã gắn đơn POS | **0** |
| thao tác KẾT THÚC ở nấc trợ lý | **0** |
| lời gọi công cụ GHI bị cổng từ chối | 0 — xem chú thích ngay dưới |

Dòng thứ năm CỐ Ý đảo chiều: càng nhiều càng tốt, vì nó là bằng chứng cổng đang chặn. Nó đang
bằng **0**, và điều đó KHÔNG có nghĩa là cổng hỏng — nó có nghĩa là **trên bản chạy thử chưa
lượt nào đi xa tới mức thử tạo đơn**. Cổng vẫn được chứng minh ở mức mã nguồn: bài kiểm dây
chuyền chạy hết một cuộc bán tới bước chốt và khẳng định lời gọi `order.create_draft` bị từ chối
với `outcome = DENIED`. Nhưng trên dữ liệu sống thì chốt chặn ấy CHƯA TỪNG BỊ CHẠM, và đó là một
sự thật phải nói ra chứ không phải một ô xanh.

Ngoài ra: `tests/sales-regression.test.ts` quét mã nguồn ĐÃ VÀO KHO của các tệp bề mặt mới và
khẳng định không tệp nào có đường gửi tin hay tạo đơn. Phép quét bỏ chú thích trước khi tìm, và
có bài tự kiểm chứng minh nó vẫn cắn trên bốn đoạn mã bẩn. Production trả `ok:true` sau lượt đo.

### Khối lượng đang có

| | |
|---|---|
| hội thoại đã nạp | 593 |
| tin nhắn đã nạp | 7.057 — **1.373 của khách** · 5.684 của shop |
| lượt chạy AI | **979** |
| gợi ý có chữ | 653 / 979 |
| **đã chấm tay** | **0** |

Mốc đọc gần nhất 19/09 11:06:13 · 6.868 tin đã nạp · **0 vòng hỏng liên tiếp**.

---

## 2. Đường nối Pancake — đo từ VPS, không đọc tài liệu

Lượt chạy: **35438053292** (lần đầu) · **35438213314** (sau khi sửa dụng cụ đo).

**ĐỌC ĐƯỢC.** Token người dùng (479 ký tự) thấy 13 page; page `1117899664739453` có tên
**"Hải An Fashion"**, nền tảng facebook. Đọc được 60 hội thoại trong 24 giờ và 15 tin của hội
thoại đầu.

**Chất lượng tin nhắn (15 tin đo được):** 0 tin thiếu mã · 0 mã trùng · 0 tin thiếu mốc thời
gian · API trả theo thứ tự cũ→mới · 4 tin có đính kèm (`photo`, `ad_click`) · 1 tin mang mã
quảng cáo · 2 danh tính người gửi tách bạch (shop 13 tin, khách 2 tin).

**BẢN ĐỒ MÃ PAGE: CHƯA XÁC NHẬN ĐƯỢC.** Đối tượng page Pancake trả về đúng ba khoá định danh —
`id = 1117899664739453`, `role_in_page`, `shop_id = 408063069`. Mã Facebook `61589434244037`
**không khớp khoá nào**. Quyền đọc vẫn đạt; thứ chưa xác nhận được là bản đồ giữa hai mã, và
Pages API không trả mã Facebook ở đâu trong đối tượng page. Đây là một câu hỏi còn mở, không
phải một sự cố.

**PHÂN TRANG KHÔNG CHẠY.** Xin `page_size=20` nhận về 60; trang 1 và trang 2 trùng **đủ 60/60**
mã hội thoại. Pancake bỏ qua cả `page_size` lẫn `page_number`. Cả hai lời gọi này đều thành
công (không 429), nên kết luận đứng vững.

**60 LÀ TRẦN CỨNG HAY LÀ TOÀN BỘ: CHƯA ĐO ĐƯỢC.** Cửa sổ 1 giờ → 60, 24 giờ → 60, 720 giờ →
HTTP 429. Cửa sổ rộng nhất là cửa sổ DUY NHẤT bác bỏ được giả thuyết trần, nên mất nó là mất cả
phép đo. Hai cửa sổ hẹp cùng ra 60 không chứng minh gì — 60 hội thoại có tin mới trong một giờ
là chuyện bình thường với một page đang chạy quảng cáo.

**TÊN THAM SỐ PHÂN TRANG ĐÚNG: CHƯA ĐO ĐƯỢC.** Sáu tên đã dò (`page` · `offset` · `skip` ·
`current_count` · `last_conversation_id` · `after`) đều trả 429 vì chính bài kiểm đã bắn mười
lời gọi liền nhau. Phải chạy lại khi hết giới hạn, hoặc hỏi tài liệu Pancake.

---

## 3. Bảy lỗi tìm được và đã vá

Xếp theo mức thiệt hại nếu để nguyên.

### 3.1 · "Khách chọn MÀU VÀNG" bị đọc thành "khách ĐỒNG Ý CHỐT ĐƠN" — NẶNG NHẤT

`isAffirmativeText` so trên chuỗi đã bỏ dấu và danh sách của nó có `"vang"`;
`normalize("vàng")` cũng ra `"vang"`. Đây là điều kiện thứ năm trong sáu điều kiện tạo đơn.
Cùng va chạm ấy còn ba chỗ: `vẫn`→`van`, `đã`→`da`, `ư`→`u`.

Vá: hai danh sách. Từ không dấu so như cũ; từ mà cái dấu phân biệt nó với một từ khác
(`vâng` · `dạ` · `ừ` · `ừa` · `ừm` · `ờ`) đòi đúng chính tả có dấu. Hệ quả có chủ ý: khách gõ
`vang` không dấu KHÔNG được tính là đồng ý — máy không phân biệt được, và nói rằng mình phân
biệt được là nói dối. Giá của chiều này là một câu hỏi lại; giá của chiều kia là một kiện hàng
thật gửi cho người không đặt.

### 3.2 · Bộ dò câu hỏi coi MỌI câu kết thúc bằng "h" là câu hỏi

Lớp ký tự `[àảáừửhả]` chứa `h` trơ trọi ("ok em chốt cho anh" ⇒ câu hỏi) và chứa `ừ`, tức chính
một lời đồng ý. Mệnh đề đi kèm `\b(hả|hử|à)$` thì **không bao giờ khớp**: trong JS không cờ `u`,
`\b` tính theo bảng ASCII nên giữa khoảng trắng và chữ "à" không có ranh giới nào — và chính vì
nó câm lặng nên lớp ký tự sai kia mới trông như đang làm việc.

### 3.3 · "chị chọn màu, vâng ạ" bị đọc thành khách chọn màu Vàng

Chiều còn lại của cùng va chạm, ở đường nhận màu. Vá bằng cách loại tiếng đồng ý theo chính tả
CÓ DẤU — giữ nguyên `mau vang` không dấu, vì đó đúng là lý do đường có chỉ dấu tồn tại.

### 3.4 · 28/258 lần chuyển người không quy được về lý do nào (11%)

Không phải thiếu lý do mà là **lưu nhầm bản quyết định**. Mỗi lượt sinh hai quyết định:
bản ĐƯỢC PHÉP (người đã vào cầm việc ⇒ `NO_ACTION`) và bản ĐỂ CHẤM. `sales_suggestions.action`
ghi từ bản thứ hai, `ai_runs.decision` chỉ ghi bản thứ nhất — nên đúng những lượt đáng so sánh
nhất là những lượt mất mã lý do. Vá: lưu bản để chấm dưới khoá riêng `decision.evaluation`.
Luật 13 nay được khoá ở mức DỮ LIỆU, và bản vá đã được dựng lại lỗi cũ để chứng minh bài kiểm cắn.

### 3.5 · Lượt nạp gọi Pancake 20 lần cho MỘT trang dữ liệu

Điều kiện dừng `list.length < 50` không bao giờ đúng khi máy chủ luôn trả 60. Vá: thôi gọi lại
khi trang mới không mang mã nào chưa từng thấy (20 → 2 lời gọi), không đếm một hội thoại hai
lần, và **nói ra** rằng mẻ này chưa lấy hết cửa sổ (`paginationStalled`). Đây KHÔNG phải bản vá
phân trang — tên tham số đúng vẫn chưa biết (xem §2).

### 3.6 · "cho chị 1 cái" không mang ý muốn mua · "giao chậm quá" không vào nhóm sau bán

Khách vẫn được chuyển người nhờ ngưỡng tin cậy, nhưng LÝ DO sai ⇒ chạy nhầm phòng và nằm nhầm ô
báo cáo.

### 3.7 · Bài kiểm đọc 429 thành "tham số không được chấp nhận"

Sáu dòng kết luận về THAM SỐ rút ra từ một phản hồi về TẦN SUẤT, trông y hệt sáu phép đo thật.
Vá dụng cụ đo trước khi kết luận: giãn nhịp, lùi dần, và trả về đúng chữ CHƯA ĐO ĐƯỢC.

---

## 4. Ma trận tiếng Việt (§8)

Năm nhóm — xác nhận · màu · size · ý muốn mua · khiếu nại. Bài kiểm khoá **cả hai chiều**, và
danh sách CẤM dài hơn danh sách PHẢI NHẬN, đúng theo mức độ thiệt hại của hai chiều.

`vâng ≠ vàng` nay được khoá ở **cả ba chỗ** nó từng va nhau: đường xác nhận (3.1), đường nhận
màu không chỉ dấu (đã vá phiên trước), đường nhận màu có chỉ dấu (3.3).

Kèm BẪY chiều ngược: "cho mình 1 cái màu đỏ" · "đổi sang màu xanh nhé" · "lấy size L" phải
KHÔNG rơi vào hàng đợi chăm sóc. Mọi lần nới danh sách sau bán đều có nguy cơ đổi một đơn sắp
chốt lấy một việc không có thật.

---

## 5. Dò bề mặt TRÊN CHÍNH BẢN CHẠY THỬ (§14)

Lượt chạy **35439059386**, chạy TỪ TRONG container của bản chạy thử, có đăng nhập thật.

| trang | HTTP | dấu hiệu | tệp JS | RSC |
|---|---|---|---|---|
| `/ai/review` | 200 · 350.010 ký tự · 415 nút | 5/5 ✓ | 30/30 · 200 | ✓ |
| `/ai/fanpage` | 200 · 343.882 ký tự · 64 nút | 4/4 ✓ | 30/30 · 200 | ✓ |
| `/ai` | 200 · 1.064.193 ký tự · 29 nút | 1/1 ✓ | 29/29 · 200 | ✓ |
| `/ai/copilot` | 200 · 180.890 ký tự · 13 nút | — | 30/30 · 200 | ✓ |

**Ô tìm thật sự thu hẹp:** 100 nút chấm khi không lọc → **0** với một từ khoá không tồn tại.

**ĐÂY LÀ PHÉP ĐO HTTP, KHÔNG PHẢI TRÌNH DUYỆT THẬT.** Nó chứng minh máy chủ giao đủ HTML và
giao đủ 30/30 tệp JS với mã 200 — tức chỗ đứt không nằm ở phía máy chủ. Nó KHÔNG chứng minh
React đã gắn được vào cây, không chứng minh một cú bấm chạy tới nơi. Container của phiên làm
việc này bị chính sách mạng chặn ra `ai-staging.vnxcommerce.com` (403 ở lớp CONNECT), nên không
mở được trình duyệt thật vào đó từ đây.

---

## 6. Chấm tay — CHƯA CÓ DỮ LIỆU, không phải 0% LỖI (§12)

**0 / 979 lượt đã được người chấm.**

Màn hình nói đúng điều ấy: độ chính xác in `chưa chấm` chứ không in `0%`, độ phủ in `—` khi mẫu
số bằng 0. Câu lệnh SQL của `ai-staging-runtime` cũng trả `NULL` và nhãn `CHƯA CÓ DỮ LIỆU CHẤM`.

Phiên này đã dựng sẵn **phép lấy mẫu phân tầng** trên `/ai/review`: mỗi ý định một ô, kèm số
lượt và số ĐÃ CHẤM của chính ý định đó; viền hổ phách = ý định chưa ai chấm lượt nào. Bảo một
người "chấm 30 lượt" mà không nói 30 lượt NÀO thì họ chấm 30 lượt đầu danh sách, và 30 lượt gần
nhau gần như chắc chắn cùng một loại câu hỏi.

**Đây là việc của người, và tôi không được tự chấm thay.** Một bài kiểm kỹ thuật xanh không
phải một lượt chấm.

---

## 7. Điều KHÔNG được kết luận từ phiên này

- **Không** kết luận máy trả lời đúng hay sai: chưa lượt nào được người chấm.
- **Không** kết luận 60 hội thoại là toàn bộ dữ liệu trong cửa sổ (§2).
- **Không** kết luận Pages API không phân trang được — mới chỉ kết luận `page_number` và
  `page_size` bị bỏ qua.
- **Không** kết luận bản đồ mã Pancake ↔ Facebook (§2).
- **Không** kết luận giao diện bấm được: phép đo là HTTP, không phải trình duyệt (§5).
- **Không** kết luận cổng chặn tạo đơn đã được thử trên dữ liệu sống: nó chưa từng bị chạm (§1).

---

## 7b. TRIỂN KHAI VÀ XÁC NHẬN TRÊN DỮ LIỆU SỐNG

Ảnh `sha256:6e3bd710…` (dựng từ `832aa24`, mang đủ bảy bản vá) · triển khai run **35439906471** ·
dựng lại bộ nạp run **35440400008**.

**BẰNG CHỨNG MÃ MỚI ĐANG CHẠY, không phải lời khai của lượt triển khai.** Sau khi dựng lại, ô
`last_error` của bộ nạp mang đúng câu chữ **chỉ tồn tại trong bản vá hôm nay**:

> Page 1117899664739453: Pancake lặp lại trang một — mẻ này chỉ lấy được 60 hội thoại, CHƯA phải
> toàn bộ cửa sổ.

Hai điều cùng lúc: bộ nạp thật sự chạy mã mới, VÀ lỗi phân trang có thật ngoài bài kiểm — nó vừa
xảy ra trên lưu lượng thật. Đây là loại bằng chứng đáng tin hơn hẳn một dòng "deploy thành công".

**An toàn sau khi triển khai (đọc từ log bộ nạp, 11:33:05):** nấc `COPILOT` · MÁY tự gửi ✓ CẤM ·
tạo đơn ✓ CẤM · NGƯỜI bấm gửi được phép · `clampMode("AUTO")` vẫn ra `COPILOT`. Đếm thẳng trong
CSDL: gợi ý đã gửi **0** · tin do AI gửi **0**.

**MỘT SỐ ĐO MỚI CHO CÂU HỎI CÒN MỞ Ở §2.** Vòng 11:33:12 đọc cửa sổ 1 giờ và nhận **30** hội
thoại — không phải 60. Vậy máy chủ KHÔNG trả 60 một cách vô điều kiện, và bộ lọc thời gian có
tác dụng. Điều này LÀM YẾU giả thuyết trần cứng nhưng **chưa bác bỏ nó**: câu hỏi thật vẫn là
"một cửa sổ có NHIỀU HƠN 60 hội thoại thì có bị cắt ở 60 không", và cửa sổ 720 giờ — phép đo duy
nhất trả lời được — vẫn chưa chạy được vì 429. Ghi lại ở đây để lần đo sau không phải bắt đầu từ
con số 0.

**Chưa có lượt chạy AI mới nào sau khi triển khai** (vòng 11:33 đọc 0 tin mới ⇒ 0 lượt soạn), nên
bản vá lưu lý do chuyển người (§3.4) mới chỉ được chứng minh bằng bài kiểm, CHƯA được xác nhận
trên dữ liệu sống. Lần soi tiếp theo phải đo lại đúng con số 28/258 ấy.

---

## 8. KHUYẾN NGHỊ

# KEEP SHADOW

Ba lý do, xếp theo sức nặng:

1. **0/979 lượt được người chấm.** Không có một phép đo nào về việc máy trả lời ĐÚNG hay SAI.
   Mọi thứ đo được trong phiên này là về CƠ CHẾ (an toàn, đường nối, tính toàn vẹn dữ liệu), và
   cơ chế đúng không nói gì về nội dung. Đây là điều kiện chặn, một mình nó đã đủ.

2. **Phiên hôm nay tìm ra một lỗi có thể chốt đơn từ chữ "vàng".** Lỗi ấy sống trong mã đã chạy
   979 lượt, và nó lộ ra không phải nhờ một bài kiểm có sẵn mà nhờ một ma trận từ mới viết. Khi
   một vòng đo tìm ra lỗi hạng ấy, điều nó nói không phải "đã sạch" mà là "chưa đo đủ".

3. **Một chỗ hụt dữ liệu chưa định lượng được.** Chưa biết 60 hội thoại là trần hay là toàn bộ.
   Nếu là trần thì mọi con số dựng trên mẻ nạp đều đứng trên một mẫu bị cắt.

**Về nấc `COPILOT` đang bật trên bản chạy thử:** phiên này KHÔNG chạm vào nó. Nó cho phép NGƯỜI
bấm gửi, và sổ thao tác cho thấy **chưa ai bấm lần nào** (0 `SEND` / 0 `EDIT_SEND`). Máy tự gửi
vẫn CẤM và AUTO vẫn không kích hoạt được. Nói cách khác: bản chạy thử đang ở `COPILOT` trên giấy
tờ nhưng ở `SHADOW` trên thực tế. Khuyến nghị KEEP SHADOW ở trên là về **hành vi**, và hành vi
hiện tại đã đúng — việc phải giữ là ĐỪNG để ai bấm gửi trước khi có 30–50 lượt đã chấm.

**Ba việc phải xong trước khi bàn tới nấc trợ lý (ASSIST):**

1. Người chấm 30–50 lượt, **rải theo ý định** bằng các ô phân tầng trên `/ai/review` — không
   chấm 30 lượt gần nhau nhất.
2. Chạy lại `ai-staging-read-test` khi hết giới hạn tần suất để trả lời dứt điểm hai câu còn mở
   ở §2 (trần dữ liệu · tên tham số phân trang).
3. Giải chỗ hổng lớn nhất của nghiệp vụ: **bảng số đo size**. Nó là lý do chuyển người chiếm áp
   đảo, và nó là dữ liệu chứ không phải mã — không bản vá nào làm nó biến mất.

**TUYỆT ĐỐI KHÔNG bật AUTO.** Không việc nào ở trên dẫn tới nấc ấy.
