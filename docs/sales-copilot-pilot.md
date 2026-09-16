# Nấc TRỢ LÝ bán hàng — sổ tay thí điểm

**Máy soạn → nhân viên đọc, sửa nếu cần → nhân viên bấm gửi.** Không có đường nào cho máy tự gửi.

## 1. Bốn công tắc, và ai mở được cái nào

| Công tắc | Nghĩa | Ở đâu | Ai mở được |
|---|---|---|---|
| `AI_ALLOW_AUTO_SEND` | MÁY tự nhắn khách | ghim `"false"` trong `docker-compose.staging.yml` | **không ai** — phải sửa tệp, commit, qua cổng kiểm thử, dựng lại |
| `AI_ALLOW_HUMAN_APPROVED_SEND` | NHÂN VIÊN bấm gửi | `.env.staging` | thao tác ops `ai-staging-copilot` |
| `AI_ALLOW_ORDER_CREATE` | tạo / chốt đơn trên POS | ghim `"false"` | **không ai** (giai đoạn này) |
| `AI_LIVE_INGEST_ENABLED` | ĐỌC tin khách về, liên tục | `.env.staging` | thao tác ops `ai-staging-live-ingest` |

Tên cũ `AI_ALLOW_CUSTOMER_SEND` sau bản tách **chỉ còn nghĩa "nhân viên bấm gửi"**. Nó không bao giờ
mở được đường máy tự gửi, kể cả khi ai đó bật nó lên vì quen tay.

## 2. Sáu cửa cho một lần gửi

Một câu do AI soạn chỉ tới được khách khi **cả sáu** cùng đúng:

1. có phiên đăng nhập (`requireUser`) — job nền không có phiên nên không đi qua được cửa này;
2. có quyền `ai:send` (quyền RIÊNG, tách khỏi `ai:view` và khỏi `ai:manage`);
3. nấc quyền hạn thật trong `ai_agents` ≥ `COPILOT` — đọc lại từ CSDL, không nhận từ nơi gọi;
4. `page_id` có tên trong `settings["ai.copilotPages"]`;
5. câu gợi ý còn hiệu lực: chưa quá 30 phút **và** chưa có tin khách nào mới hơn;
6. chưa ai kết thúc câu ấy — ràng buộc duy nhất ở CSDL, nên hai tab cùng bấm chỉ ra một tin.

Cửa 6 nằm ở CSDL chứ không ở tầng ứng dụng vì hai lượt bấm song song đều đọc thấy "chưa gửi" trước
khi lượt nào kịp ghi. Và dòng sổ được ghi **trước** khi gọi Pancake: ghi sau thì tiến trình chết
đúng khe giữa hai bước là tin đã đi mà sổ không có dòng nào.

## 3. Bật thí điểm cho MỘT page

Chạy workflow **Vận hành ERP trên VPS** trên nhánh `claude/ai-workforce-sales-v1`:

```
action = ai-staging-copilot
arg    = --page=1117899664739453 --on
```

Thao tác này đặt ba thứ rồi **đọc lại từ bản đang chạy** để in ra: nấc `COPILOT` cho nhân sự
`sales`, danh sách page `["1117899664739453"]`, và `AI_ALLOW_HUMAN_APPROVED_SEND=true`. Nó cũng ghi
đè `AI_ALLOW_AUTO_SEND=false` một lần nữa — thừa, và cố ý thừa.

Tắt: `arg = --off` (danh sách page về rỗng, nấc về `SHADOW`, công tắc người-bấm về false).

Mở hàng đợi: `http://127.0.0.1:3100/ai/copilot` qua tunnel SSH.

## 4. Nạp tin sống — khách nhắn là thẻ hiện ra

**ĐỌC tự động được. GỬI thì không.** Bốn việc, bốn mức rủi ro, và chỉ hai việc đầu chạy nền:

| Việc | Ai thấy | Chạy nền? |
|---|---|---|
| ĐỌC tin khách về | không ai ngoài shop | ✔ |
| SOẠN câu gợi ý | không ai ngoài shop | ✔ (nấc `COPILOT`) |
| GỬI cho khách | **người ngoài** | ✘ — chỉ khi có người bấm |
| TẠO ĐƠN | tiền và hàng đi theo | ✘ — `AI_ALLOW_ORDER_CREATE` vẫn CẤM |

Gộp bốn việc vào một công tắc thì để xem được tin khách phải mở luôn đường gửi. Tách ra thì bộ nạp
chạy suốt ngày mà **không có đường nào tới khách**: tệp nó chạy không import cổng gửi (có bài kiểm
quét mã nguồn khoá lại điều đó), còn cổng gửi thì đòi một khoá tài khoản mà tiến trình nền không có.

Bật:

```
action = ai-staging-live-ingest
arg    = --on            (hoặc: --on --seconds=45)
```

Tắt: `arg = --off`. Kiểm một vòng mà **không bật gì**: `arg = --once`.

Thao tác này từ chối bật khi `settings["ai.copilotPages"]` còn rỗng — một bộ nạp không có page nào
để đọc chỉ sinh ra log "không đọc gì" và làm người vận hành tưởng hệ thống hỏng.

**Vì sao hỏi liên tục chứ không đợi webhook.** Webhook chat của Pancake chưa được kiểm chứng trên
bản chạy thử: 27 giờ không một tin nào về trong khi page vẫn chạy quảng cáo. Một đường vào chưa
chứng minh được thì không dựng cả đợt thí điểm lên nó. Hỏi mỗi 45 giây chậm hơn vài chục giây nhưng
**đo được**: mỗi vòng để lại một mốc trong `sales_ingest_cursors`.

**Chồng lấn 10 phút, và nó không sinh ra bản sao.** Pancake lọc hội thoại theo lần cập nhật, đồng hồ
hai bên không bao giờ khớp tuyệt đối, nên hỏi đúng từ mốc cũ thì một tin rơi vào khe giữa hai vòng
sẽ mất luôn và không ai biết. Đường nạp chống trùng bằng mã tin ngoài và bằng vân tay nội dung, nên
đọc lại một tin cũ là một phép không-thao-tác. Lần chạy đầu (chưa có mốc) đọc **2 giờ**, không đọc
cả lịch sử: một lượt nạp toàn bộ sẽ nuốt hạn mức Pancake và đổ hàng nghìn dòng vào hàng đợi cùng lúc.

**Dựng lại container không mất chỗ đang đọc**: mốc nằm ở CSDL, không trong bộ nhớ tiến trình.

**Đọc tình trạng không cần log.** Đầu trang `/ai/copilot` có một dải: `ĐANG CHẠY` / `CHẬM` / `LỖI` /
`TẮT`, vòng chạy được gần nhất, tin khách mới nhất, số tin đã nạp, số việc đang chờ. Con số quyết
định là **vòng CHẠY ĐƯỢC** gần nhất chứ không phải vòng gần nhất — một bộ nạp hỏng liên tục vẫn chạy
đều đặn. Quá 5 phút không có vòng nào chạy được là **ĐỨT**, không phải "đang chậm một chút".

Trang tự làm mới mỗi 20 giây bằng `router.refresh()` (không tải lại trang, nên chữ đang gõ dở trong
ô soạn không mất), và dừng khi tab bị ẩn.

**Hỏng thì nghỉ dài dần** 1× · 2× · 4× · 8×, có trần. Một hội thoại lẻ hỏng trong khi 29 hội thoại
kia nạp bình thường **không** bị tính là vòng hỏng — nó hiện ra màn hình dưới màu hổ phách "lỗi lẻ",
tách khỏi màu đỏ "hỏng N vòng liền".

> **Không dùng hội thoại cũ để lấp quota.** Hàng đợi loại lượt quá 24 giờ, lượt đã có người trả lời,
> lượt người khác đang cầm. Ngưỡng ấy **không** được hạ xuống chỉ để hàng đợi có dữ liệu — một thẻ
> gợi ý cho câu khách hỏi ba ngày trước là một tin trả lời muộn ba ngày.

## 5. Nhân viên làm gì trên hàng đợi

| Nút | Ghi lại gì |
|---|---|
| **Gửi nguyên văn** | `SEND` · câu máy soạn = câu gửi · khoảng cách sửa 0 |
| **Sửa & gửi** | `EDIT_SEND` · lưu **cả hai** câu + khoảng cách sửa |
| **Từ chối** | `REJECT` + một trong 11 lý do (một cú bấm) · **không gửi gì** |
| **Soạn lại** | `REGENERATE` · xếp việc cho dây chuyền đọc lại · **không gửi gì** |
| **Tự nhận việc** | `TAKEOVER` · máy im lặng tới khi chính người ấy trả lại |

Mọi dòng mang `users.id` của người bấm. Tên hiển thị do **máy chủ** đọc từ phiên, không nhận từ
client — client gửi tên khác với khoá thì dòng dữ liệu nói một đằng còn quy kết một nẻo.

## 6. Đọc số

`/ai/copilot` in ở đầu trang: gợi ý đã soạn · gửi nguyên văn · sửa rồi gửi · từ chối · **tỷ lệ dùng
được** · thời gian soát trung vị · số tin **thật sự** đã rời khỏi ERP (đọc từ sổ thao tác, không suy
từ cờ nào).

Hai con số quan trọng nhất của đợt thí điểm:

- **Tỷ lệ dùng được** = (gửi nguyên văn + sửa rồi gửi) / (tổng số lượt đã quyết định).
- **Tỷ lệ phải sửa đáng kể** — ngưỡng 20% ký tự. Đổi một dấu chấm **không** tính; viết lại nửa câu
  thì tính. Đếm "có sửa hay không" sẽ nói sai về chất lượng theo hướng bi quan.

Mẫu số rỗng ⇒ in `—`, không in `0%`.

## 6b. Vì sao hàng đợi từ 0 lên 11 — và con số nào mới đúng

Ngày 16/09/2026 hàng đợi hiện **0 việc** trong khi page vẫn chạy quảng cáo. Không phải vì không có
khách chờ: 48/50 hội thoại bị tính là "shop đã đáp rồi" nên biến mất khỏi màn hình.

Ba dấu hiệu đo được trên 339 tin mang nhãn `PAGE_HUMAN` của page này:

| Dấu hiệu | Số đo | Nói lên điều gì |
|---|---|---|
| Số **tài khoản** gửi | **1** | không phân biệt người với máy bằng TÊN được |
| Tin gửi **trước** tin đầu của khách | **71** | nhân viên không chào trước khi khách nhắn |
| Tin là bản sao **y hệt** của tin khác | **97** | hai câu dài xuất hiện đúng một lần ở mỗi 35 hội thoại |

`classifySender` chạy lúc NẠP nên chỉ nhìn được MỘT tin — nó không có cách nào biết câu ấy còn nằm
ở 34 hội thoại khác. Vì thế phép nhận dạng câu mẫu nằm ở **lớp đọc**, nơi có cả tập dữ liệu để so:
cùng một chuỗi ký tự xuất hiện ở từ **3 hội thoại khác nhau** trở lên thì không tính là câu nhân
viên (`AUTOMATION_TEMPLATE_MIN_CONVERSATIONS`).

Sau khi sửa:

| | trước | sau |
|---|---|---|
| shop "đã đáp rồi" | 48 | **25** |
| khách vẫn đang chờ người | 0 | **23** |
| còn lại trong hàng đợi | 0 | **11** |

**23 khách đang bị giấu khỏi hàng đợi.** Ngưỡng 24 giờ KHÔNG bị hạ — 12 trong số 23 người ấy rơi ra
vì đã quá hạn hoặc đang có người cầm, và đó là câu trả lời đúng.

Nhánh sai rơi về phía **giữ việc lại**: nhận nhầm câu của một nhân viên thật thành câu mẫu thì một
người đọc thẻ rồi bỏ qua; nhận nhầm câu mẫu thành câu người thì một khách không bao giờ được trả
lời. Hai cái giá không cùng một hạng.

## 7. Ba điều đã biết trước, để không ai ngạc nhiên giữa đợt

1. **Chưa có bảng số đo cho Q004.** Khách hỏi "50kg mặc size gì" ⇒ máy **chuyển người**, không đoán.
   Trên mẻ đo gần nhất việc này chiếm 3/18 lượt. Khai `settings["ai.sizeRules"]` thì con số ấy về
   gần 0.
2. **Chưa khai đơn giá mô hình** ⇒ chi phí mỗi lượt là `CHƯA BIẾT`. Không ghi `0 ₫`.
3. **Bộ đếm "hỏi mãi một thứ" tăng khi máy SOẠN, không phải khi người GỬI.** Một câu bị từ chối vẫn
   được tính là đã hỏi, nên máy chuyển người sớm hơn thực tế một chút. Sai về phía an toàn, và ghi
   ra đây để không ai đọc nhầm con số.

## 8. Đợt thí điểm 20–50 lượt

Thứ tự đề nghị:

1. Bật cho đúng page WIN (mục 3) rồi bật bộ nạp tin sống (mục 4). Kiểm lại đầu trang `/ai/copilot`: nấc **Trợ lý** · MÁY tự gửi
   **CẤM** · NHÂN VIÊN bấm gửi **được phép** · page đúng một mã.
2. Một nhân viên trực, xử lý **20–50 lượt khách nhắn** bằng năm nút trên.
3. Không gửi hàng loạt. Mỗi tin là một cú bấm của một người đã đọc.
4. Cuối đợt đọc lại sáu con số ở mục 6, và mở `/ai/review` chấm tay ~30 lượt: chỉ ở đó mới có
   những chiều máy **không** tự chấm được (hiểu đúng ý, đúng sản phẩm, giọng có tự nhiên không).
