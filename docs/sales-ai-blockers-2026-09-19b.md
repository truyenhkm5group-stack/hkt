# Nhân viên bán hàng AI — ĐÓNG BỐN NÚT THẮT (19/09/2026, phiên chiều)

Nhánh `claude/fervent-albattani-46yg73`. Mọi con số kèm **mã lượt chạy** để tra lại. Chỗ nào chưa
đo được thì ghi **CHƯA ĐO ĐƯỢC** — không thay bằng một con số gần đúng.

---

## P0 · An toàn — đọc từ runtime, không đọc tài liệu

Lượt chạy **35441721162** (`ai-staging-runtime`, CHỈ ĐỌC) và log bộ nạp lúc 12:02.

| | |
|---|---|
| Nấc có hiệu lực | **`COPILOT`** (cột CSDL `COPILOT` · không ghi đè ở `settings.modes` · mặc định môi trường `SHADOW` · trần `MAX_ALLOWED_MODE = COPILOT`) |
| `AI_ALLOW_AUTO_SEND` | **`false`** |
| `AI_ALLOW_ORDER_CREATE` | **`false`** |
| AUTO có bật được không | **KHÔNG** — đặt thử `ai_agents.mode = AUTO` cho ra nấc có hiệu lực `COPILOT`; `clampMode("AUTO")` trả `COPILOT`. Phép thử này KHÔNG ghi gì. |
| Tin đã gửi cho khách | **0** (gợi ý đã gửi 0 · tin do AI soạn nằm trong bảng tin 0 · thao tác gửi ở nấc trợ lý 0) |
| Đơn đã tạo | **0** (hội thoại gắn đơn POS 0) |

Không đổi một dòng authority nào trong phiên này.

---

## P3 · Phân trang Pancake — TÌM RA, VÀ NẶNG HƠN TƯỞNG

Lượt chạy **35444310784**, cửa sổ 24 giờ, page `1117899664739453`. Sáu ứng viên, so bằng **giao
của hai tập mã** chứ không bằng số đếm — hai trang cùng trả 60 dòng có thể là 60 hội thoại khác
nhau hoặc đúng 60 hội thoại cũ, và số đếm không phân biệt được hai chuyện ấy.

| tham số | trang 1 | trang 2 | TRÙNG | duy nhất |
|---|---|---|---|---|
| `page_number=2` | 60 | 60 | 60 | 60 |
| `page=2` | 60 | 60 | 60 | 60 |
| `offset=60` | 60 | 60 | 60 | 60 |
| `skip=60` | 60 | 60 | 60 | 60 |
| **`current_count=60`** | 60 | **40** | **0** | **100** |
| `last_conversation_id` | 60 | 60 | 60 | 60 |

**Đạt tiêu chí nghiệm thu**: trang 2 chứa mã hội thoại KHÁC HẲN trang 1 — trùng 0.

Và nó lộ ra một điều nặng hơn phiên trước tưởng. Cửa sổ 24 giờ có **ít nhất 100** hội thoại trong
khi một lời gọi trả **tối đa 60** ⇒ 60 là **trần cứng mỗi lượt**, và bản cũ **để rơi 40 hội thoại
mỗi mẻ** — không phải "gọi thừa mười chín lần" như đã ghi ở phiên trước, mà là **mất dữ liệu**.

Khuôn này **vốn đã có trong chính tệp ấy**: `listMessages` dùng `current_count` từ đầu. Hai điểm
cuối của cùng một API dùng cùng một quy ước, còn `listConversations` dùng `page_number` — thứ
Pancake không hiểu và **cũng không báo lỗi**. Một tham số bị bỏ qua im lặng là dạng hỏng đắt nhất.

**Đã vá** (`lib/integrations/pancake/pages.ts`):
- `current_count = số mã ĐÃ THẤY` (không phải `out.length`: `out` bị `limit` cắt còn con trỏ máy
  chủ thì không — buộc hai thứ vào nhau là hẹn một lỗi lệch trang vào ngày ai đó đổi `limit`);
- **bỏ** điều kiện dừng `list.length < 50`. Nó ĐOÁN kích thước trang và đoán sai; sửa 50 thành 60
  chỉ là đoán lại. Hai điều kiện còn lại không đoán gì: trang rỗng, và trang không mang mã nào mới;
- giữ `paginationStalled` làm **lưới an toàn** — Pancake đổi ý thì vòng lặp dừng sau hai lượt và
  **nói ra**, thay vì lại im lặng chạy đủ hai mươi vòng.

Bài kiểm khoá **hành vi**, không khoá tên tham số: máy chủ giả đọc `current_count` và cắt trần 60
như thật, bài kiểm đòi client lấy đủ **100 mã khác nhau trong 3 lượt**. Ai đổi sang tên khác mà
vẫn lấy đủ thì vẫn xanh — thứ đáng bảo vệ là "không mất hội thoại nào", không phải một chuỗi ký tự.

**Đường lùi theo cửa sổ thời gian KHÔNG dùng được**, và may là đã đo: cắt đôi cửa sổ cho ra hai
lát **trùng nhau 60/60**. `since`/`until` không phân hoạch theo cách một đường lùi cần. Nếu đã
đoán thay vì đo, bản vá sẽ là cắt nhỏ cửa sổ — và nó sẽ không lấy thêm được một hội thoại nào.

---

## P4 · Mã Facebook ↔ mã Pancake — KHÔNG CÓ CHỨNG CỨ NÀO

Cùng lượt chạy **35444310784**, phần 2. Hỏi bảy nguồn; mỗi nguồn tự khai nó thuộc hạng nào.

| nguồn | hạng | kết quả |
|---|---|---|
| Ô `fanpage_sales_profiles.facebook_page_id` | KHAI BÁO | **ĐỂ TRỐNG** — ERP chưa từng lưu mã nào |
| Đường dẫn bài viết trong tin nhắn (`post_url`) | CHỨNG CỨ | 725/7.063 tin có đường dẫn, **0** đường dẫn mang dãy số sau `facebook.com/` |
| Mã quảng cáo khách bấm (`ad_id`) | CHỨNG CỨ | **627 tin · 44 mã khác nhau** (vd `120246034943260238`) — đây là chiếc cầu DUY NHẤT còn lại |
| Payload thô của tin nhắn | CHỨNG CỨ | **0** dãy ≥ 12 chữ số nào khác mã Pancake |
| Gói tin webhook | CHỨNG CỨ | **bảng RỖNG** — page này chạy hoàn toàn bằng đọc bù, không có webhook nào |
| `fb_ads.story_id` (`"<mã page>_<mã bài>"`) | CHỨNG CỨ | **0 dòng** trên bản chạy thử |
| Tiền tố mã hội thoại | CHỨNG CỨ | 588 hội thoại mang tiền tố `1117899664739453` (mã **Pancake**) |

**Câu hỏi dứt khoát:** mã `61589434244037` xuất hiện **0 lần** trong toàn bộ dữ liệu sống —
0 trong `sales_messages.raw`, 0 trong `state`, 0 trong `offer_snapshot`, 0 trong `webhook_events`.

### Kết luận P4

**BẢN ĐỒ NÀY CHƯA ĐƯỢC XÁC MINH, và không có nguồn nào trong ERP xác minh được nó.** Con số
`61589434244037` tới từ bản mô tả công việc, không từ dữ liệu. Ô cấu hình đáng lẽ giữ nó thì đang
**để trống**, nên hiện KHÔNG có gì trong hệ thống khẳng định hai mã này thuộc về nhau — cũng
không có gì phủ nhận.

**Nguồn CÓ THẨM QUYỀN, theo thứ tự nên hỏi:**
1. **Chính trang Facebook** (phần "Giới thiệu" → ID trang) — lời khai của bên sở hữu mã.
2. **Facebook Ads API qua 44 mã quảng cáo đã có** — mỗi mã tra ra page đã chạy nó. Đây là đường
   duy nhất ERP tự đi được, nhưng nó cần quyền Ads, không phải quyền Pages.
3. **Màn hình cấu hình của Pancake** — nơi người vận hành nối page Facebook vào Pancake.

**Pages API của Pancake KHÔNG phải nguồn có thẩm quyền** cho câu hỏi này: nó trả đúng ba khoá
định danh (`id`, `role_in_page`, `shop_id`) và không khoá nào là mã Facebook.

Có một quan sát nhỏ đáng ghi cho lần sau: **5 hội thoại** mang tiền tố KHÁC (`122108644592357630`,
`122111474942357630`, `122108752004357630`, `122111474246357630`). Chúng không phải
`61589434244037`, nhưng chúng chứng minh tiền tố mã hội thoại KHÔNG phải lúc nào cũng là mã page
— nên đừng ai dùng nó làm đường suy ra mã page.

---

## P5 · Lý do chuyển người trên lượt chạy MỚI — ĐẠT MỘT NỬA, VÀ NỬA KIA PHẢI NÓI RÕ

Lượt chạy **35441808708** (mẻ chạy ngầm sinh 27 lượt mới) rồi **35442410249** (đọc lại từ CSDL).

Phép đo **đọc lại `ai_runs.decision` đã nằm trong CSDL**, không đọc lại biến mà mẻ chạy vừa in ra
— một phép đo đọc lại chính biến nó vừa in thì luôn xanh, kể cả khi đường ghi hỏng hoàn toàn.

| | chuyển người | có mã lý do | THIẾU mã lý do | tỷ lệ thiếu |
|---|---|---|---|---|
| TRƯỚC bản vá | 258 | 230 | **28** | **10,9 %** |
| SAU bản vá | 8 | 8 | **0** | **0,0 %** |

**Nhưng 0 % ấy CHƯA chứng minh bản vá chạy đúng**, và đây là chỗ dễ tự lừa mình nhất:

Bản vá chỉ có tác dụng ở lượt **CHỈ ĐỂ CHẤM** (`evaluation_only = true`) — tức khi người đã vào
cầm hội thoại VÀ nhân sự ở nấc `SHADOW`. Điều kiện trong mã là `nguoiDaVao && agent.mode === "SHADOW"`.
Bản chạy thử hiện ở nấc **`COPILOT`**, nên `evaluation_only` **không còn được bật cho lượt nào**:
số lượt chỉ-để-chấm ở phía SAU là **0/27**, và cột `decision.evaluation` trống ở cả hai phía.

Nghĩa là 8 lần chuyển người mới **đi qua đường bình thường** — đường vốn chưa bao giờ hỏng. Chúng
xác nhận đường ấy vẫn tốt; chúng **không chạm vào đường đã hỏng**.

**Trạng thái đúng của P5:**
- Bản vá được chứng minh bằng **bài kiểm ở mức DỮ LIỆU** — quét toàn bộ gợi ý trong CSDL thử và
  đòi mọi lượt `HANDOFF_HUMAN` đọc được mã lý do. Đã dựng lại lỗi cũ để chứng minh bài kiểm **cắn**:
  bỏ dòng vá ra thì nó đỏ đúng câu ấy.
- Chưa chứng minh **trên dữ liệu sống**, vì ở nấc `COPILOT` đường hỏng không thể xảy ra.
- 28 lượt thiếu mã lý do đều là **di sản của thời nấc `SHADOW`**; chúng không tăng thêm và cũng
  không tự lành.
- Muốn xác minh sống thì phải có một lượt `evaluation_only` — tức hạ nấc về `SHADOW` trên một page
  có người đang cầm việc. **Phiên này KHÔNG làm điều đó**: đổi nấc quyền hạn là việc của chủ shop,
  và đổi nó chỉ để làm xanh một ô báo cáo là đúng thứ bộ luật này sinh ra để chặn.

---

## P1 · Mẻ chấm — DỰNG XONG CÔNG CỤ, CHƯA AI CHẤM

**0 / 979 lượt được người chấm.** Con số này KHÔNG đổi trong phiên, và nó không được phép đổi
bằng code.

Đã dựng **mẻ chấm phân tầng 14 nhóm** (`lib/constants/sales-eval-buckets.ts`), sàn **38 ca** —
nằm trong khoảng 30–50 chủ shop yêu cầu, và sàn được **cộng ra từ chính sổ nhóm**, không gõ lại.

Mười bốn nhóm: hỏi giá · hỏi màu · hỏi size · chọn mẫu mã · ý muốn mua · xác nhận `vâng` ·
va chạm màu `vàng` · đổi màu/size · SĐT-địa chỉ · khiếu nại · hỏi giao hàng · đổi-trả ·
chưa rõ mẫu · máy chuyển người.

**Rổ chia theo CHỮ KHÁCH GÕ, không theo nhãn của máy.** Khối chip cũ chia theo nhãn ý định của
chính máy, và đó là một vòng tròn: lượt nào máy đọc nhầm ý định sẽ rơi vào rổ sai, còn rổ ĐÚNG
trông như không có ca nào — đúng cái lỗi phép chấm sinh ra để bắt. Ngoại lệ duy nhất là nhóm
"máy chuyển người", nơi câu hỏi chính là "quyết định ấy có đúng không".

Mỗi nhóm khai **câu hỏi nó trả lời** và **hậu quả nếu máy hỏng ở đó**, hiện ra khi di chuột.

Bổ sung **7 lý do chấm còn thiếu**: `WRONG_INTENT` · `WRONG_VARIANT` · `WRONG_STATE` ·
`MISSING_ENTITY` · `BAD_REPLY` · `WRONG_ORDER_DRAFT` · `OTHER`. **Thêm** chứ không đổi tên nhãn
cũ — `reason_tags` đã lưu chuỗi, đổi tên là làm mồ côi những lượt đã chấm.

---

## P6 · Số đo sau chấm

| | |
|---|---|
| Đã chấm | **0** |
| ĐẠT / KHÔNG ĐẠT | **CHƯA CÓ DỮ LIỆU CHẤM** — không phải 0 % lỗi |
| Tỷ lệ chuyển người | 266/1.006 lượt (**26,4 %**) · trong đó `LOW_CONFIDENCE` 115 · `SIZE_DATA_MISSING` 110 |
| Bịa đặt / phá luật | **CHƯA ĐO ĐƯỢC ở mức người chấm.** Phép soi máy trên 523 câu soi được cho 0 cờ; 130 câu KHÔNG soi được (thiếu ảnh chụp dữ kiện) và được đếm riêng, không gộp vào nhóm "sạch" |
| Đọc sai ý định / sai mẫu mã / sai trạng thái | **CHƯA CÓ DỮ LIỆU CHẤM** |
| Hồi quy | **9/9 ca dựng sẵn ĐẠT** · `npm test` in TẤT CẢ KIỂM THỬ ĐẠT |

---

## Triển khai bản vá phân trang

Ảnh dựng từ `0601c4b` (run **35444897935**) · ứng dụng run **35445476826** · dựng lại bộ nạp
run **35445790333**.

**Bằng chứng bộ nạp đang chạy mã mới:** ô `last_error` của bộ nạp nay là `—`. Trước lượt triển
khai nó mang câu "Pancake lặp lại trang một — mẻ này chỉ lấy được 60 hội thoại, CHƯA phải toàn bộ
cửa sổ", tức lưới an toàn đang bật. Vòng 13:27:18 chạy sạch, và `tin_da_nap` nhích 6.868 → 6.874.

**An toàn sau triển khai** (log bộ nạp 13:27:11): nấc `COPILOT` · MÁY tự gửi ✓ CẤM · tạo đơn ✓
CẤM · `clampMode("AUTO")` vẫn ra `COPILOT` · đếm thẳng CSDL: 0 gợi ý đã gửi, 0 tin do AI gửi.

**ĐIỀU CHƯA CHỨNG MINH ĐƯỢC, và không được làm tròn thành đã chứng minh:** các vòng chạy sau khi
triển khai đều dùng cửa sổ 1 giờ và cửa sổ ấy hiện chỉ có 30 hội thoại — DƯỚI trần 60, nên một
lời gọi là đủ và phép phân trang KHÔNG bị chạm tới. Việc `last_error` sạch vì thế là tin tốt
nhưng CHƯA phải bằng chứng: một cửa sổ 30 hội thoại thì bản CŨ cũng không báo lặp.

Phép đo dứt khoát còn thiếu là **một mẻ nạp thật trên cửa sổ có hơn 60 hội thoại, lấy về hơn 60**.
Bản thân tham số đã được chứng minh bằng đo trực tiếp (bảng ở §P3: trùng 0, duy nhất 100) và bằng
bài kiểm hành vi; thứ còn thiếu là nhìn thấy nó xảy ra trong chính đường nạp. Đó là việc đầu tiên
của lần sau, và nó rẻ: chạy `ai-staging-ingest --hours=24` vào giờ có nhiều hội thoại rồi đọc số
hội thoại lấy được.

---

## P3 · BẰNG CHỨNG SỐNG — ĐÓNG HOÀN TOÀN

Lượt chạy **35447295117** · cửa sổ **72 giờ** · chạy `PancakePagesClient.listConversations` —
ĐÚNG hàm mà `ingest.ts` gọi — trong container đang chạy, đo từ ngoài bằng lớp bọc `fetch` chỉ đếm
và ghi lại, không đổi tham số cũng không sửa dữ liệu.

| | |
|---|---|
| Tổng lượt gọi API | **14** |
| Tổng dòng nhận về | 500 |
| **Mã duy nhất** | **500** |
| Chồng lấn trang 1 ↔ 2 | **0** |
| Hàm trả về | 500 hội thoại · 500 mã duy nhất |
| Mã TRÙNG trong kết quả | **0** |
| Cờ lặp trang một | **KHÔNG** |

Từng lượt: `current_count` tăng đều 0 → 40 → 80 → … → 460, mỗi lượt nhận 40 dòng mới và **trùng
với các lượt trước = 0** ở mọi lượt.

**Nghiệm thu: ĐẠT cả bốn điều** — quá 60 mã duy nhất (500) · trang 2 khác trang 1 · không lặp
trang một · không mã trùng.

Đặt cạnh bản cũ: cùng đường nạp ấy trước bản vá trả về **60** và gọi hai mươi lần. Nay **500**
trong mười bốn lượt.

Hai chi tiết phải ghi cho đúng, không làm tròn:
- **500 là TRẦN TÔI ĐẶT, không phải đáy cửa sổ.** Tham số `limit` của phép đo là 500 và kết quả
  chạm đúng 500, nên cửa sổ 72 giờ có **≥ 500** hội thoại chứ không phải đúng 500. Phép đo chứng
  minh "lấy được quá 60", không chứng minh "đã lấy hết".
- **Lượt 10 nhận 0 dòng rồi lượt 11 lặp lại `current_count=340` và nhận 40.** Đó là lớp HTTP
  (`fetchJson` với `retries: 2`) thử lại một phản hồi rỗng thoáng qua — vòng lặp phân trang không
  nhìn thấy lượt ấy. Không phải lỗi phân trang, nhưng đáng ghi: một phản hồi rỗng thoáng qua mà
  KHÔNG được thử lại sẽ làm vòng lặp dừng sớm và mất phần còn lại của cửa sổ trong im lặng.

---

## Cổng quyết định

# KEEP SHADOW

Cổng đòi bảy điều. Bốn đã đạt, ba chưa:

| điều kiện | trạng thái |
|---|---|
| ≥ 30 ca người chấm | ✗ **0** |
| Không còn lỗi an toàn nghiêm trọng chưa vá | ✓ bảy lỗi phiên sáng đã vá và khoá bằng bài kiểm |
| Hồi quy xanh | ✓ 9/9 · toàn bộ `npm test` đạt |
| Bịa đặt nghiêm trọng = 0 sau khi vá | ✗ **chưa đo được ở mức người chấm** — 0 cờ máy không phải 0 lỗi người |
| Nạp Pancake không bỏ sót vì phân trang | ✓ **ĐÓNG** — run 35447295117: đường nạp THẬT lấy 500 mã duy nhất trong 14 lượt gọi, chồng lấn 0, không lặp, không trùng |
| Lý do chuyển người lưu đúng | ◐ **một nửa** — bài kiểm chứng minh, dữ liệu sống chưa chạm được đường đã hỏng (xem P5) |
| Danh mục không bịa | ✗ chưa có người chấm để nói |

Điều kiện chặn vẫn là điều kiện cũ: **chưa một lượt nào được người chấm**. Mọi thứ đo được hôm nay
là về CƠ CHẾ — an toàn, đường nối, tính toàn vẹn dữ liệu — và cơ chế đúng không nói gì về việc máy
trả lời ĐÚNG hay SAI.

**KHÔNG bật AUTO.** Không việc nào ở trên dẫn tới nấc ấy.

### Ba việc, theo đúng thứ tự

1. **Người chấm 38 ca** theo các ô nhóm trên `/ai/review` — rải đều, không chấm 38 lượt gần nhau nhất.
2. **Triển khai bản vá phân trang rồi đo lại**: một mẻ nạp phải lấy được hơn 60 hội thoại trong
   cửa sổ 24 giờ. Đây là phép đo dứt khoát cho ô "không bỏ sót dữ liệu".
3. **Hỏi chủ shop mã Facebook thật** (hoặc tra qua 44 mã quảng cáo đã có) rồi khai vào ô đang để
   trống. Cho tới lúc ấy, đừng viết con số nào vào tài liệu như thể đã xác minh.
