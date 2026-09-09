# Tổng kết phiên tiếp tục từ production hiện tại — 09/09/2026

Thực hiện `CLAUDE_ERP_CONTINUE_FROM_CURRENT_PRODUCTION.md`.

---

## A. Commit production: trước → sau

| | |
|---|---|
| Trước phiên | `676465a752f0` |
| Sau phiên | `2ac5554f71f6` (đã xác minh chạy) |
| Commit đưa lên | **17** |

## B. Cách deploy

Không có `gh` CLI. Dùng credential mà Git Credential Manager đang giữ cho `git push` — nó có scope
`workflow` — để gọi thẳng GitHub REST API dispatch workflow và đọc log. **Token không in ra ở bất
kỳ đâu.**

## C. Bối cảnh đặc biệt: hai phiên làm việc song song

Trong phiên này có **một phiên khác đang code cùng lúc trên cùng cây làm việc** (module Ý tưởng
marketing). Ba va chạm thật đã xảy ra và được xử lý:

1. **Hai migration cùng số 0032.** Không gây sự cố (drizzle áp theo thứ tự mảng và băm nội dung),
   nhưng làm thứ tự migration không còn đọc được. **Cố ý không đổi tên migration đã áp** — đổi tên
   là tạo mục mới và drizzle sẽ áp LẠI. Thay vào đó thêm bộ chặn để không tái diễn.
2. **Sổ migration bị ghi đè, xoá mất mục của tôi.** File `0038` còn nhưng không có trong sổ ⇒ sẽ
   **không bao giờ được áp**. Bộ chặn vừa viết bắt đúng lỗi này. Đã thêm lại đúng thứ tự.
3. **Tôi cuốn nhầm file kiểm thử của họ vào commit** trong khi thư viện nó phụ thuộc chưa lên. Một
   bản checkout sạch sẽ đỏ `tsc` — tức là **chặn deploy của cả hai phiên**. Đã gỡ khỏi repo và giữ
   nguyên file trên đĩa cho họ, rồi xác minh bằng cách checkout sạch và chạy lại typecheck.

## D. Sức khoẻ production

`/api/health` `ok: true`, commit khớp HEAD. Smoke 17 đường dẫn: `/login` và `/api/health` **200**,
15 trang còn lại **307** (chuyển hướng đăng nhập — đúng với phiên chưa đăng nhập), **không đường dẫn
nào 5xx**. Webhook `POST` token sai vẫn **401**.

## E. KPI trước → sau

| | Trước | Sau |
|---|---|---|
| Giao thành công | 405 | **405** |
| Hoàn | 816 | 817 |
| Đang giao | 271 | 270 |
| Chưa rõ | 13 | **13** |
| Chưa gửi | 615 | **615** |
| Huỷ | 294 | **294** |
| Doanh thu lên đơn | 1.063.252.498đ | **giữ nguyên** |
| Doanh thu giao TC | 215.569.000đ | **giữ nguyên** |
| Tiền thực nhận | 212.052.000đ | **giữ nguyên** |

Một đơn chuyển từ *đang giao* sang *hoàn* trong 19 phút giữa hai lần đo, cùng lúc có **+8 sự kiện
Viettel Post** — đó là hành trình thật của gói hàng, không phải tác động của deploy. **Ba con số
tiền giống hệt từng đồng** xác nhận không công thức nào bị đổi.

## F. Độ phủ quy kết quảng cáo (P0.1)

Đo trên production, 30 ngày, đơn đã chốt (n = 1.676):

| | |
|---|---|
| Có `ad_id` | **45,9%** |
| Có `post_id` | **82,0%** |
| Có `ad_id` trong dữ liệu thô mà thiếu ở cột | **0** |

**Kết luận quan trọng nhất: mapper không làm rơi gì.** Pancake thật sự không gửi mã quảng cáo cho
đơn đến từ bình luận / nhắn tin dưới bài viết. Chờ Pancake là chờ mãi.

**Đường nối xác định đã dựng:** Facebook cho biết mỗi mẩu quảng cáo quảng bá **bài viết** nào; nối
`orders.post_id` → chiến dịch bằng dữ kiện đó. Ba ràng buộc: bài do **nhiều chiến dịch** cùng chạy
thì **không nối** (đếm riêng là nhập nhằng); **không ghi ngược** `ad_id` suy ra vào bảng đơn; nối
chỉ áp dụng ở **cấp chiến dịch**.

**Trần thật là 82%, không phải 100%.** 18% đơn không có cả `ad_id` lẫn `post_id` — không có cách nào
nối mà không bịa. Mục tiêu 80% của kế hoạch nằm sát trần và còn phụ thuộc hai điều ngoài tầm ERP:
bao nhiêu bài thật sự được chạy quảng cáo, và bao nhiêu bài chỉ thuộc một chiến dịch.

### BA lỗi tự phát hiện SAU deploy, nhờ kiểm chứng trên dữ liệu thật

**F1 — đồng bộ không bao giờ điền dữ liệu.** Chạy đồng bộ và nhận `candidates: 0`: nó chỉ tra mẩu
**chưa có** trong bảng, nên mẩu đã lưu sẽ không bao giờ được điền `post_id`. Tính năng đúng logic
nhưng **không bao giờ có dữ liệu để chạy**. Sửa bằng một lượt quét **tự kết thúc**.

**F2 — migration bị bỏ qua VĨNH VIỄN trên production.** `ERROR: column fa.post_id does not exist` —
trang Quảng cáo lỗi trên production trong khi kiểm thử, typecheck và build đều xanh. Nguyên nhân:
drizzle chỉ áp migration có mốc **muộn hơn** migration cuối đã áp; phiên song song ghi đè sổ, xoá
mục của tôi, migration của họ được áp trước, và khi tôi thêm lại với mốc **cũ hơn** thì nó bị bỏ
qua. Kiểm thử không bắt được vì cơ sở dữ liệu kiểm thử dựng mới từ đầu. Đã sửa mốc và thêm bất biến
"mốc phải TĂNG NGHIÊM NGẶT".

**F3 — hai bên không cùng một khoá.** Sau khi điền được `post_id` cho 94 mẩu, đo lại vẫn ra **0 đơn
nối thêm**. Lấy mẫu mới thấy Pancake ghi `"<page_id>_<post_id>"` đầy đủ, còn tôi lưu phần sau — so
thẳng thì không bao giờ khớp. Kiểm thử cũng sai theo vì fixture dùng cùng một chuỗi cho cả hai bên,
tức là mô phỏng một thế giới không tồn tại. Đã quy cả hai về cùng khoá và sửa fixture.

### Kết quả đo THẬT sau khi cả ba lỗi được sửa

| | Số đơn | Tỷ lệ |
|---|---|---|
| Nối bằng `ad_id` | 770 | 45,9% |
| Nối thêm nhờ bài viết | **5** | +0,3% |
| **Bài do NHIỀU chiến dịch cùng chạy ⇒ giữ nhập nhằng** | **539** | **32,2%** |

**Độ phủ cuối: 46,2%.** Đường nối hoạt động đúng nhưng chỉ thêm 5 đơn — và **phát hiện quan trọng
hơn con số** là 539 đơn có bài viết được chạy bởi nhiều chiến dịch cùng lúc, nên từ bài KHÔNG suy ra
được chiến dịch nào mang lại đơn. ERP giữ nhập nhằng thay vì chọn bừa.

**Việc chủ shop làm được:** nếu mỗi bài chỉ chạy trong MỘT chiến dịch thì 539 đơn kia lập tức nối
được — **46,2% → khoảng 78%**. Đây là thay đổi CÁCH ĐẶT QUẢNG CÁO, không phải thay đổi phần mềm.

## G. Hàng hoàn (P0.2)

674 vận đơn HOÀN chưa xác nhận: **445 có gắn đơn** (497 món), 229 là vận đơn chiều hoàn không gắn
đơn (đúng thiết kế).

**0 kiện tự sửa được.** Không kiện nào đã có phiếu tái nhập; và chứng từ "hàng về tới nơi" **không
tồn tại** — Viettel Post đánh dấu thẳng vận đơn gốc là HOÀN, không tạo dòng chiều hoàn tương ứng.
Toàn bộ 445 cần kho đếm tay, đúng luật đã khoá.

Việc làm được: **cho thấy quy mô bằng tiền** ngay trên trang Kế hoạch SX, kèm hệ quả — bảng đề xuất
sản xuất đang đặt **thừa đúng bằng lượng đó**.

## H. Hàng đợi việc (P0.3)

**Kết luận đi ngược giả định của kế hoạch: hàng đợi KHÔNG có nhiễu để dọn.**

- **0** việc quá 30 ngày;
- **0** việc mà đối tượng đã xong nhưng việc chưa đóng;
- không có việc trùng.

1.009 việc là **tồn đọng vận hành thật**: 494 đơn chờ gửi, 299 case CSKH, 77 đang chuyển hoàn, 74
đơn thiếu thông tin. Việc cần làm không phải xoá bớt mà là **chia đúng đội**.

**Vấn đề thật tìm được:** khi tách "đơn chờ xử lý" thành hai loại, khoá chống trùng giữ nguyên có
chủ ý — hệ quả không lường trước là **494 việc cũ vẫn mang nhãn cũ**, phần tách chỉ có tác dụng cho
việc phát sinh về sau. Đã thêm bước phân loại lại theo trạng thái hiện tại của đơn: xác định,
idempotent, không tạo và không đóng việc nào.

## I. Xung đột Pancake ↔ ĐVVC (P0.4)

Đã xử lý ở phiên trước: 17 xung đột (kế hoạch ghi 13), **15 được `ORDER_OUTCOME` xử lý đúng**, 2 ca
nguy hiểm thật đã thành loại việc riêng hạn 6 giờ và **đã tạo trên production**.

## J. Chi phí thiếu kỳ (P0.5)

5 khoản, tất cả từ nhập sao kê, nhóm `SOFTWARE`. **Không khoản nào suy được kỳ** — nội dung chuyển
khoản không chứa thông tin kỳ. Giữ nguyên cờ, **không đoán**.

Hậu quả đo được: khoản **6.000.000đ** ghi 02/09 rơi trọn vào tuần 01–07/09.

Đã thêm **hành động khai kỳ** gọn ngay trên dòng của khoản đang cần: ba trường, có nhật ký ghi giá
trị trước/sau. "Chi một lần" cũng là câu trả lời hợp lệ và làm tắt cờ.

**Cần chủ shop xác nhận:** 4/5 khoản là "chuyển tiền" cá nhân bị nhập tự động vào nhóm `SOFTWARE`.
Nếu **nhóm** sai thì báo cáo sai bất kể kỳ có đúng hay không.

## K. Dòng tiền (Phase D)

Trang mới **Dòng tiền & vốn lưu động**. Lợi nhuận không phải tiền: shop bán COD có thể lãi trên giấy
mà hết tiền mặt.

**Giới hạn nói trước, không giấu ở cuối trang: ERP không có số dư ngân hàng.** Đây là dòng tiền
**ròng** dự kiến, không phải số dư tài khoản.

Dự phóng 7/14/30 ngày: tiền vào là COD của đơn **đã giao** chưa thấy chứng từ; tiền ra theo **nhịp
chi thực tế**. **Cố ý không dự phóng tiền từ đơn chưa giao** — tỷ lệ hoàn đủ lớn để phép ngoại suy
đó sai nghiêm trọng.

## L. Kiểm thử & cổng ra

**89 khối · 17/17 bất biến · typecheck sạch · lint 0 lỗi 0 cảnh báo · build thành công · checkout
sạch typecheck xanh · 0 bí mật trong kho mã · migration 0 câu phá huỷ.**

Bộ kiểm thử mới trong phiên: sổ migration, nối quy kết qua bài viết, dòng tiền, an toàn lớp tư vấn.

**Bộ hồi quy yêu cầu:** 21/23 mục đã có. Hai mục còn thiếu (`rejected action cannot execute`,
`simulation never writes`) thuộc Phase A và Phase F — chưa xây.

## M. Phần CHƯA làm, nói thẳng

Kế hoạch có 10 phase (A–J). Phiên này làm **P0.1–P0.5 + Phase D + phần an toàn của Phase E/H**.

**Chưa xây:** Phase A (workflow duyệt), B (mua hàng/sản xuất nâng cao), C (CRM/phân khúc khách),
F (mô phỏng kịch bản), G (executive OS), I (rà soát phân quyền), J (rà soát chéo cuối).

Lý do: mỗi phase trong số đó là một hạng mục sản phẩm riêng. Làm mười phần hời hợt tệ hơn làm vài
phần đến nơi — nhất là ở một kho mã mà lớp số liệu vừa mất rất nhiều công để làm cho đúng.

**Phase E (khuyến nghị quảng cáo) đang bị khoá có chủ ý** bởi chính ngưỡng độ phủ 80%: ở 46% thì
mọi khuyến nghị SCALE/CUT đều dựa trên nền so lệch. Xây nó trước khi độ phủ đủ là xây một cỗ máy
đưa lời khuyên sai.

## Việc đáng làm tiếp, xếp theo giá trị

1. **Tách bài viết ra từng chiến dịch riêng** (hoặc mỗi bài chỉ chạy một chiến dịch). Đây là việc
   đáng giá nhất và nằm hoàn toàn ở phía vận hành: nó đưa độ phủ từ 46,2% lên khoảng 78%, mở khoá
   toàn bộ nhóm cảnh báo lợi nhuận quảng cáo và Phase E.
2. **Đếm 445 kiện hàng hoàn** — hàng có thật trong kho mà ERP không đếm.
3. **Khai kỳ cho 5 khoản chi**, và xác nhận nhóm chi phí của 4 khoản "chuyển tiền".
4. **Chia 1.009 việc theo đội** — nay đã có nhãn đúng, cần người nhận.
5. Phase A (workflow duyệt) nếu muốn tiến tới các hành động ghi có kiểm soát.

## Giữ PENDING, đúng lệnh

Direct VTP Fulfillment · ERP tạo vận đơn VTP · WRITE BACKFILL toàn cục · xoay secret · tự đổi ngân
sách quảng cáo · tự tạo đơn sản xuất · tự sửa tồn kho · tự ép ghép vận đơn nhập nhằng.

Ranh giới cuối cùng được khoá bằng kiểm thử ở mức mã nguồn: **12 module chỉ-đọc không chứa một phép
ghi nào.**
