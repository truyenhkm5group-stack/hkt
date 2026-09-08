# Tổng kết roadmap sau V2 — 09/09/2026

Thực hiện `CLAUDE_DIRECT_ATTACHMENT_POST_V2_ROADMAP.md`, lô A → J.

**34 commit · 82 khối kiểm thử · 17/17 bất biến nghiệp vụ · cổng ra 15/17 đạt tại chỗ.**
**Chưa deploy** — phiên này không có `gh` CLI. Chi tiết và cách chạy: `docs/erp-post-v2-release-report.md`.

---

## Task hoàn thành

| Lô | Nội dung | Commit |
|---|---|---|
| **A** | Hàng đợi việc hợp nhất · ưu tiên · hạn xử lý · quyền sở hữu · giao diện | `f039539` `a1b5b12` `d21bcf9` `0805463` `5c0e57f` |
| **B** | Hợp đồng phễu · hiệu suất nhân sự · chăm sóc khách · báo cáo chuyển đổi | `4e0a622` `bcddd0c` `ed48e25` `92260ec` |
| **C** | Độ phủ quy kết QC · CAC · drill-down · phát hiện bất thường | `875e0eb` `4a8c3f9` `5bc354d` `e14f61f` |
| **D** | Mô hình mẫu mã · bảng màu × size · luật phân loại | `30fea62` `83211e7` `1cd925f` |
| **E** | Tốc độ bán · ngày còn hàng · dự báo cháy · đề xuất SX · vốn nằm chết | `845bbf0` `2c157c2` `32183ec` `973f043` `c93b560` |
| **F** | Bảng điều khiển quản trị · việc cần làm · hợp đồng drill-down | `804e29e` |
| **G** | Nền tảng trợ lý chỉ-đọc · tóm tắt deterministic · an toàn khuyến nghị | `20da309` |
| **H** | Tìm kiếm toàn hệ thống · dòng thời gian truy vết | `2b08892` `89a2573` |
| **I** | Đo & tối ưu hiệu năng vòng 2 · độ tin cậy job nền | `7529f72` `7342b17` |
| **J** | Nhất quán giao diện | `912dfeb` |

## Kiểm thử

`npm test` → **TẤT CẢ KIỂM THỬ ĐẠT** · **82 khối** · **17/17 bất biến** · typecheck sạch ·
lint **0 lỗi** (3 cảnh báo có từ trước) · production build thành công.

**11 bộ kiểm thử mới**: phễu bán hàng · hiệu suất nhân sự · độ phủ quy kết QC · bất thường QC ·
phân loại mẫu mã · dự báo tồn kho · hàng bán chậm · hợp đồng drill-down · tóm tắt kinh doanh ·
tìm kiếm · dòng thời gian.

## Deploy

**Không thực hiện được.** `gh` CLI không có trong phiên này nên không dispatch được workflow.
Toàn bộ mã đã trên `main`, đã qua cổng ra. Chạy: **Actions → Deploy ERP to VPS → main**.

Rollback: deploy lại `b067913`. Migration `0037` chỉ cộng thêm cột nên bản cũ chạy nguyên vẹn.

## Sức khoẻ production

Chưa đo được ở phiên này (cùng lý do). Lần đo gần nhất, sau bản V2: `/api/health` `ok`,
0 nghiêm trọng ở Chất lượng dữ liệu, 50 cảnh báo đều có lý do, RAM 556/1.963 MB, load 0,20.

## Chất lượng dữ liệu

Trên dữ liệu kiểm thử: **22 luật chạy đủ**, số trên thẻ khớp danh sách mở ra.
Sau khi deploy cần quét lại trên production — kỳ vọng **0 nghiêm trọng**, không đổi so với trước.

## KPI: dự kiến KHÔNG đổi

Không thay đổi nào chạm `ORDER_OUTCOME` hay bất kỳ công thức tiền nào. Kiểm thử nhất quán chỉ số
xác nhận giao thành công 18 khớp ở cả 5 nơi (Đơn hàng · Vận đơn · GTC · Marketing · Chất lượng dữ
liệu).

Hai tỷ lệ quảng cáo nay hiện ở **cả** bảng điều khiển lẫn Báo cáo lợi nhuận, dùng **chung một hàm**;
kiểm thử so trực tiếp hai nơi và bắt lỗi nếu lệch quá 0,05 điểm phần trăm.

## Chân lý lợi nhuận

Không đổi. Cơ chế phân bổ chi phí theo kỳ của bản V2 giữ nguyên, hồi quy vẫn xanh. Bổ sung **CAC hai
mức** cho quảng cáo và **giá trị vốn nằm chết** cho tồn kho — cả hai đều là chỉ số mới, không viết
lại chỉ số cũ.

## Hàng đợi việc

Từ 13 lên **19 loại việc**, từ 3 lên **5 trạng thái**, công thức ưu tiên từ 4 lên **6 yếu tố** và
nay **giải thích được từng phần điểm**. Thêm hạn xử lý theo loại việc, giao việc cho người khác,
"bắt đầu làm", và "bỏ qua có lý do" (bắt buộc lý do, khoá bằng ràng buộc CHECK ở CSDL).

## CS / bán hàng

Phễu **năm bước đo được** (không phải bảy — hai bước còn lại không có nguồn dữ liệu). Hiệu suất theo
**năm vai**, xếp theo doanh thu giao thành công chứ không theo số đơn. Trang **Phễu bán hàng** mới.

## Lợi nhuận quảng cáo

Độ phủ quy kết **9 mắt xích** đặt ngay cạnh bảng ROAS. **CAC lên đơn** và **CAC giao thành công** —
khoảng cách giữa hai con số là tiền trả cho đơn hoàn. **Sáu quy tắc** phát hiện bất thường, tách làm
hai loại việc vì hai người khác nhau xử lý.

## Hiểu biết sản phẩm

Trang **Hiệu quả mẫu mã** mới. Nhãn "đáng nhân bản" đòi **đủ cả sáu chiều**; thiếu chiều nào thì trả
"chưa đủ căn cứ" kèm tên chiều thiếu.

## Dự báo tồn kho

Tốc độ bán **chống nhiễu**, số ngày còn hàng, ngày dự kiến hết hàng, **hạn phải đặt**, **mức đặt tối
thiểu của xưởng**, và bảng **vốn nằm chết** làm đối trọng cho bảng đề xuất đặt.

## Bảng điều khiển quản trị

"Cần xử lý" từ **số đếm theo nhóm** thành **việc cụ thể**. Hai tỷ lệ quảng cáo. Hợp đồng drill-down
khoá bằng kiểm thử: **10/10** chỉ số bấm được, mang đúng kỳ, trỏ tới trang có thật.

## Nền tảng trợ lý

Bản tóm tắt **deterministic** — mọi con số tính bằng SQL, không bằng mô hình ngôn ngữ. Dự án chưa
nối nhà cung cấp AI nào và đó không phải lý do để bỏ trống: câu tóm tắt sinh theo quy tắc. Mỗi
khuyến nghị bắt buộc có **bốn thứ**: chỉ số · bằng chứng · khoảng thời gian · mức tin cậy.

## Hiệu năng

Sửa một truy vấn **chạy hai lần** mỗi lần tải bảng điều khiển (do chính đợt này gây ra). Ba rủi ro
lường trước kèm **ngưỡng xem lại** cụ thể, không sửa sớm.

---

## Ba lỗi THẬT phát hiện được — phần đáng đọc nhất

Cả ba đều im lặng, không báo gì cả.

1. **ROAS cấp mẩu quảng cáo tra chi tiêu sai không gian khoá.** Bật lên là mọi mẩu hiện chi 0đ và
   TOÀN BỘ tiền chiến dịch bị xếp vào "tiền tiêu mà không đơn nào" — kết luận sai hoàn toàn ở đúng
   chỗ dễ tin nhất. Nguyên nhân gốc là **dữ liệu không tồn tại**, nên sửa bằng cách nói CHƯA BIẾT.
2. **Ô tìm kiếm sập khi dán mã vận đơn** — tràn kiểu INTEGER 4 byte. Đúng ca dùng phổ biến nhất.
3. **Job treo tự chặn chính mình vĩnh viễn** — khoá trong bộ nhớ không bao giờ nhả, mà giao diện vẫn
   báo "đang chạy".

## Bốn thứ KHÔNG có nguồn dữ liệu — nêu tên thay vì im lặng

1. Phễu "Đã liên hệ" / "Đủ điều kiện" — ERP không đồng bộ hội thoại Pancake. **Không đo được tỷ lệ
   chốt từ khách nhắn tin.**
2. Nội dung quảng cáo (creative).
3. Chi tiêu cấp nhóm và cấp mẩu quảng cáo.
4. Luật "khách cũ đủ điều kiện mua lại" — cần chủ shop chốt trước.

## Blocker còn lại

**`gh` CLI không có trong phiên này.** Hệ quả: không deploy được, không quét Chất lượng dữ liệu và
không đo hiệu năng trên production. Mọi việc khác không phụ thuộc blocker đã làm xong.

## Backlog

- **`PENDING_DIRECT_VTP_FULFILLMENT`** — không làm trong phase này.
- **Đơn ↔ vận đơn vẫn 1:1** (`shipments.order_id` UNIQUE). Gỡ được, nhưng phải đổi grain lớp chỉ số
  **trước** — nếu không là nhân đôi doanh thu.
- **Khoá job ở mức tiến trình** — chạy hai bản ứng dụng thì phải đổi sang khoá cấp CSDL.
- **Tìm kiếm `LIKE '%…%'`** — ngưỡng xem lại: `orders` vượt ~50.000 dòng.
- **5 khoản `SOFTWARE`** chờ chủ shop khai kỳ hiệu lực (tồn từ bản V2).
- **13 xung đột Pancake ↔ ĐVVC** cần người xem (tồn từ bản V2).

## Phase kế tiếp đề xuất

1. **Deploy bản này**, quét lại Chất lượng dữ liệu và đối chiếu KPI trước/sau.
2. **Chủ shop khai ba thứ** để các chỉ số mới chạy đúng: mức đặt tối thiểu của xưởng, kỳ hiệu lực
   cho 5 khoản chi, và luật "khách cũ đủ điều kiện mua lại".
3. **Nâng độ phủ quy kết**: gán marketer cho chi tiêu quảng cáo và người bán cho đơn — trang Phễu
   bán hàng và Quảng cáo nay chỉ thẳng chỗ đang thiếu.
4. Chỉ khi ba việc trên xong mới nên mở **Direct VTP Fulfillment**.
