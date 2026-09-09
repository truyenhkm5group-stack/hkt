# Độ phủ quy kết quảng cáo — đo, sửa, và trần thật

Kèm `docs/ads-attribution-audit.md` (kiến trúc quy kết) và
`docs/business-rules/ORDER_OUTCOME.md` (kết quả đơn).

## Đo được gì trên production (30 ngày, đơn đã chốt, n = 1.676)

| Tín hiệu | Số đơn | Tỷ lệ |
|---|---|---|
| Có `ad_id` | 770 | **45,9%** |
| Có `post_id` | 1.375 | **82,0%** |
| Thiếu `ad_id` nhưng **có** `post_id` | 605 | 36,1% |
| Có `ad_id` trong dữ liệu thô mà thiếu ở cột | **0** | 0% |
| Có `page_id` | 1.581 | 94,3% |
| Có `conversation_id` | 1.418 | 84,6% |

## Kết luận quan trọng nhất: mapper KHÔNG làm rơi gì

`raw->>'ad_id'` khớp cột ở **100%** trường hợp. Nghĩa là ERP không đánh mất dữ liệu — **Pancake
thật sự không gửi** mã quảng cáo cho phần lớn đơn đến từ bình luận / nhắn tin dưới bài viết.

Hệ quả: **chờ Pancake gửi thêm là chờ mãi.** Muốn tăng độ phủ thì phải nối bằng tín hiệu khác.

## Đường nối xác định: bài viết → chiến dịch

Facebook cho biết mỗi mẩu quảng cáo quảng bá **bài viết** nào
(`creative{effective_object_story_id}`, dạng `<page_id>_<post_id>`). Pancake ghi `orders.post_id`.
Nối hai đầu đó lại là dùng **dữ kiện của Facebook**, không phải suy đoán.

```
đơn.post_id  →  các mẩu QC quảng bá bài đó  →  chiến dịch
```

### Ba ràng buộc, và chúng quyết định toàn bộ thiết kế

**1. Nhiều mẩu quảng cáo có thể cùng quảng bá một bài.**
Ở cấp *mẩu* là nhập nhằng — chọn bừa một mẩu là bịa. Nhưng nếu tất cả các mẩu đó thuộc **cùng một
chiến dịch** thì cấp chiến dịch vẫn xác định. Và chiến dịch mới là nơi **có số chi tiêu**, tức là
nơi ROAS thật sự được tính.

**2. Bài do NHIỀU chiến dịch cùng chạy thì KHÔNG nối.** Đếm riêng thành "nhập nhằng" để nhìn thấy.
Thà thiếu còn hơn gán doanh thu sai chỗ — vì con số gán sai vẫn trông hoàn toàn hợp lý.

**3. KHÔNG ghi ngược `ad_id` suy ra vào bảng đơn.** Đơn giữ nguyên sự thật thô Pancake gửi; phần
nối tính lúc truy vấn. Ghi ngược là bịa quy kết, và sau đó không ai phân biệt được đâu là dữ liệu
thật, đâu là ERP tự đoán.

## KẾT QUẢ ĐO THẬT SAU KHI CHẠY (09/09/2026)

Sau khi đồng bộ điền `post_id` cho 94/99 mẩu quảng cáo và quy hai bên về cùng một khoá:

| | Số đơn | Tỷ lệ |
|---|---|---|
| Nối bằng `ad_id` | 770 | 45,9% |
| **Nối thêm được nhờ bài viết** | **5** | **+0,3%** |
| **Bài do NHIỀU chiến dịch cùng chạy ⇒ giữ nhập nhằng** | **539** | **32,2%** |
| Còn lại (không có bài, hoặc bài chưa chạy quảng cáo) | 362 | 21,6% |

**Độ phủ cuối: 46,2%.** Đường nối hoạt động đúng, nhưng chỉ thêm được 5 đơn.

### Vì sao chỉ +0,3% — và đây mới là phát hiện quan trọng

**539 đơn có bài viết được chạy bởi nhiều chiến dịch cùng lúc.** Với cách shop đang tổ chức quảng
cáo, một bài viết thường xuất hiện trong nhiều chiến dịch, nên từ bài KHÔNG suy ra được chiến dịch
nào mang lại đơn.

ERP giữ chúng ở trạng thái **nhập nhằng** thay vì chọn bừa — đúng nguyên tắc, và đó là lý do con số
không đẹp lên.

### Phân nhóm chính thức (đo lại 09/09/2026, n = 1.676)

| Nhóm | Nghĩa | Số đơn |
|---|---|---|
| — | Có `ad_id` tra được chiến dịch | **770** |
| **A · UNIQUE_DETERMINISTIC** | Bài chỉ thuộc **một** chiến dịch | **5** |
| **B · AMBIGUOUS** | Bài thuộc **nhiều** chiến dịch | **539** |
| **C · UNMAPPED** | Không có bằng chứng nguồn nào | **362** |

**Chỉ nhóm A được nối tự động, và nó đã được nối.** Độ phủ cuối: **46,2%**.

### Giả thuyết "tách theo kỳ" — ĐÃ KIỂM VÀ BÁC BỎ

Nếu các chiến dịch của cùng một bài chạy ở **những khoảng thời gian rời nhau**, thì ngày đặt đơn sẽ
phân giải được. Đã kiểm trên chính 4 bài chiếm toàn bộ 539 đơn:

| Bài | Các chiến dịch | Kết luận |
|---|---|---|
| …329169 | 27/07–30/08 · 06/08–07/08 · 06/08–28/08 | **chồng lấn** |
| …329169 | 28/07–24/08 · 06/08–07/08 | **chồng lấn** |
| …493325 | 29/08–05/09 · 02/09–03/09 · 03/09 · 05/09–08/09 | **chồng lấn** |
| …120117 | 5 chiến dịch, 23/08–08/09 | **chồng lấn** |

**Không bài nào tách được theo kỳ.** Ngày đặt đơn không phân giải được chiến dịch ⇒ **không auto-map**.

### Một quan sát KHÔNG dùng để tự động hoá

Ở 2 trong 4 bài, **một chiến dịch chiếm hơn 99,8% chi tiêu** (221,3 triệu so với 169 nghìn và 95
nghìn; 164,4 triệu so với 169 nghìn).

Gán hết cho chiến dịch lớn nhất sẽ đúng gần hết — nhưng đó là **suy đoán theo tỷ trọng**, không phải
bằng chứng. ERP **không làm**, và tài liệu ghi lại để chủ shop tự nhìn và tự quyết.

### Việc chủ shop làm được để độ phủ nhảy vọt

Toàn bộ 539 đơn nhập nhằng dồn vào **đúng 4 bài viết**. Nếu mỗi bài chỉ chạy trong **một** chiến
dịch, 539 đơn đó lập tức nối được:

> **46,2% → 78,4%**

Đây là thay đổi **cách đặt quảng cáo**, không phải thay đổi phần mềm. Con số 78,4% **không phải kết
quả ERP đạt được**, mà là kết quả *nếu* cách đặt quảng cáo đổi — ghi rõ để không ai đọc nhầm thành
cam kết.

## Trần thật, không hứa quá

| | Tỷ lệ |
|---|---|
| Độ phủ hiện tại (chỉ `ad_id`) | **45,9%** |
| **Trần lý thuyết** (có `ad_id` **hoặc** `post_id`) | **82,0%** |
| Phần không có tín hiệu nào | **18,0%** |

**Mục tiêu 80% của kế hoạch nằm ngay sát trần 82%** — đạt được hay không phụ thuộc hai điều không
nằm trong tay ERP:

1. bao nhiêu bài viết thật sự **được chạy quảng cáo** (bài đăng tự nhiên thì không có mẩu QC nào,
   và đơn từ đó **đúng là không thuộc chiến dịch nào**);
2. bao nhiêu bài chỉ thuộc **một** chiến dịch (bài nhiều chiến dịch giữ nguyên nhập nhằng).

**18% đơn không có cả `ad_id` lẫn `post_id` là trần cứng.** Không có cách nào nối chúng mà không
bịa. Đây là con số phải chấp nhận, không phải con số cần "xử lý".

## Cấm — đã cân nhắc và cố ý không làm

- **Không** dùng số điện thoại / khách hàng để đoán chiến dịch.
- **Không** dùng `page_id` để gán chiến dịch: một trang chạy nhiều chiến dịch cùng lúc.
- **Không** dùng thời điểm đặt đơn để gán chiến dịch đang chạy.
- **Không** suy rộng doanh thu theo tỷ lệ độ phủ để "bù" phần thiếu.

Cả bốn cách trên đều làm độ phủ đẹp lên ngay lập tức và đều là bịa.

## Ngưỡng bật lại cảnh báo lợi nhuận

Cảnh báo "chiến dịch đang lỗ" và "ROAS dưới ngưỡng" chỉ bật khi độ phủ **≥ 80%**
(`ADS_ANOMALY_RULES.minAttributionToJudgeProfit`).

Lý do đã đo được trên production: chi tiêu đếm **đủ 100%** còn doanh thu chỉ quy được cho phần đơn
có mã — lấy chi tiêu đủ trừ doanh thu thiếu rồi kết luận "đang lỗ" là **so hai vế không cùng gốc**,
và nó báo lỗ cho gần như mọi chiến dịch. Lần quét đầu sau deploy sinh **26 cảnh báo sai** đúng vì
điều này.

Cảnh báo **so kỳ với kỳ** (chi tăng vọt mà hàng không ra, tỷ lệ giao tụt, đồng bộ đứng im) **vẫn
chạy ở mọi mức độ phủ**: hai kỳ cùng thiếu như nhau nên so sánh vẫn có nghĩa.

## Đo lại sau khi đồng bộ

Cột `fb_ads.post_id` chỉ được điền khi job đồng bộ quảng cáo chạy lại. Trước đó phần "nối thêm nhờ
bài viết" sẽ bằng 0 — **đó là đúng, không phải lỗi**.

Xem số hiện tại: trang **Quảng cáo → Độ phủ quy kết**, hai dòng "Nối thêm được nhờ bài viết" và
"Có bài viết nhưng nhiều chiến dịch cùng chạy".
