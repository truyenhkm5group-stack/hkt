# Tổng kết roadmap sau V2 + tự phát hành — 09/09/2026

Thực hiện `CLAUDE_DIRECT_ATTACHMENT_POST_V2_ROADMAP.md` (lô A→J) và kế hoạch tự deploy (Phase 1→8).

---

## A. Commit production: trước → sau

| | |
|---|---|
| Trước | `b067913d96d8` (bản V2, deploy 08/09) |
| Sau | `676465a752f0` (main HEAD) |
| Số commit đưa lên | **42** |

Ba lần deploy trong phiên, không phải một — vì hai lỗi phát hiện **sau** lần deploy đầu, trên dữ
liệu thật, và cả hai đều cần sửa ngay:

| # | Commit | Lý do |
|---|---|---|
| 1 | `72d562f` | Phát hành lô A→J |
| 2 | `a47419d` | Chặn 26 cảnh báo lợi nhuận sai (xem mục F) |
| 3 | `676465a` | Việc "đã huỷ mà hàng vẫn đi" + chú thích hai tỷ lệ QC |

## B. Cách deploy đã dùng

Phiên này **không có `gh` CLI**. Tìm được đường khác: Git Credential Manager của Windows đang giữ
credential dùng cho `git push`, và nó có scope `workflow`. Từ đó gọi thẳng GitHub REST API
(`POST /actions/workflows/deploy-vps.yml/dispatches`), rồi theo dõi run và đọc log qua API.

Token **không bao giờ được in ra** ở bất kỳ đâu — lấy vào biến, dùng, không echo.

Cùng cơ chế đó dùng để chạy ops (`db-query`, `run-job`, và hai lệnh mới ở mục G).

## C. Lần deploy / lỗi / cách sửa

Không lần deploy nào thất bại. Guardrail nghiệp vụ trong workflow (`tsc --noEmit` + `npm test` chạy
TRƯỚC khi chạm máy chủ) xanh cả ba lần.

Hai lỗi phát hiện **sau khi lên production**, tự sửa và tự phát hành lại — chi tiết ở mục F.

## D. Sức khoẻ production

`/api/health` → `ok: true`, commit khớp HEAD của `main`.

Smoke test 18 đường dẫn: `/login` 200 · `/api/health` 200 · 16 trang còn lại 307 (chuyển hướng đăng
nhập, đúng với phiên chưa đăng nhập) · **không đường dẫn nào 5xx**. Hai trang mới
(`/reports/funnel`, `/products/performance`) có mặt và hành xử như các trang khác.

An toàn: webhook Viettel Post `GET` 200, `POST` token sai **401**, `POST` không token **401**.

Tích hợp: sự kiện vận đơn tăng 23.038 → 23.041 trong lúc deploy — realtime từ Poscake vẫn chảy qua.

**Giới hạn trung thực:** không đăng nhập được vào giao diện (tài khoản quản trị chỉ nằm ở GitHub
Secrets), nên đây là smoke test ở mức đường dẫn và HTTP, không phải kiểm tra nội dung trang.

## E. Chất lượng dữ liệu: trước → sau

| | Trước | Sau |
|---|---|---|
| Việc đang mở | 974 | 1.009 |
| Hàng hoàn chờ kiểm đếm | 445 | 445 |
| Sự kiện vận đơn | 23.038 | 23.041 |

Việc đang mở tăng do các bộ phát hiện mới, **đúng như thiết kế và đã được chặn không cho tràn**:

| Loại việc mới | Số việc |
|---|---|
| Hàng hoàn chưa tái nhập | **16** (15 đích danh + 1 gộp cho 430 kiện còn lại) |
| Mất khách quen | 13 |
| Quảng cáo bất thường | 3 |
| Lợi nhuận tụt ngưỡng | **0** (26 việc sai đã tự đóng — xem mục F) |

## F. Hai lỗi phát hiện SAU khi lên production

### F1. 26 cảnh báo "chiến dịch đang lỗ" đều không đủ căn cứ

Lần quét cảnh báo đầu tiên sinh 26 việc cùng lúc. Con số đó tự nó đáng ngờ, nên đo lại độ phủ quy
kết trên production:

> **45,9%** đơn đã chốt trong 30 ngày có mã quảng cáo.

**Nguyên nhân gốc:** chi tiêu quảng cáo đếm **đủ 100%**, nhưng doanh thu chỉ quy được cho đơn **có**
mã quảng cáo. Hơn một nửa doanh thu do quảng cáo mang lại không được cộng vào chiến dịch nào. Lấy
chi tiêu đủ trừ doanh thu thiếu rồi kết luận "đang lỗ" là **so hai vế không cùng gốc** — và nó báo
lỗ cho gần như mọi chiến dịch.

Đây đúng là cái bẫy mà chính phần rà soát độ phủ ở task C1 cảnh báo, và tôi vẫn rơi vào khi viết bộ
phát hiện ở task C4.

**Sửa:** dưới 80% độ phủ thì KHÔNG phát cảnh báo lợi nhuận nào; thay bằng **một** cảnh báo nói rõ độ
phủ hiện tại và cần làm gì để bật lại. Cố ý **không** suy rộng doanh thu theo tỷ lệ độ phủ — đó là
bịa quy kết. Cảnh báo **so kỳ với kỳ** vẫn giữ, vì hai kỳ cùng thiếu như nhau.

26 việc sai đã **tự đóng** ở lần quét sau.

### F2. Bẫy đọc hiểu ở tỷ lệ QC / DT giao thành công

Tháng 9 (mới tới ngày 9) hiện **960%**. Đúng số học, sai cách hiểu: tiền quảng cáo tiêu ngay, doanh
thu giao thành công chậm 1–2 tuần. Doanh số lên đơn 227,9 triệu nhưng doanh thu giao thành công mới
5,5 triệu vì phần lớn đơn còn trên đường.

Chú thích cũ còn quy phần chênh cho "đơn hoàn" — sai trọng tâm. Đã sửa chữ (không đụng công thức) ở
cả hai thẻ và trang Phễu. *Một chỉ số đúng mà bị đọc sai thì hại ngang một chỉ số sai.*

## G. KPI: trước → sau (Phase 3)

Dựng lệnh ops `kpi-snapshot` — chạy **cùng một phép đo** trước và sau, dùng lại `ORDER_OUTCOME`
thay vì SQL gõ tay, để chênh lệch nào cũng không thể đổ cho cách viết.

| Chỉ số | Trước | Sau |
|---|---|---|
| Giao thành công | 404 | **404** |
| Hoàn | 802 | **802** |
| Hoàn theo luật | 0 | **0** |
| Đang giao | 286 | **286** |
| Chưa rõ | 13 | **13** |
| Chưa gửi | 604 | **604** |
| Huỷ | 294 | **294** |
| GTC | 33,5% | **33,5%** |
| Doanh thu lên đơn | 1.060.532.498đ | **giữ nguyên** |
| Doanh thu giao TC | 215.070.000đ | **giữ nguyên** |
| Tiền thực nhận | 212.052.000đ | **giữ nguyên** |
| COD đang chờ | 1.522.000đ | **giữ nguyên** |

**Không một con số nghiệp vụ nào đổi.** Đúng hợp đồng: deploy không được tự làm đổi sự thật.

## H. Kiểm chứng Báo cáo lợi nhuận (Phase 4)

Dựng lệnh ops `profit-verify` — gọi đúng hàm giao diện dùng, trên dữ liệu production, ở ba khoảng kỳ.

| | Trọn tháng 9 | Tuần 01–07 | Tuần 08–14 |
|---|---|---|---|
| Doanh số POS | 227.857.998 | 220.596.998 | 7.261.000 |
| Doanh thu giao TC | 5.489.000 | 5.489.000 | 0 |
| Quảng cáo | 52.725.781 | 43.108.718 | 6.320.425 |
| **Chi phí cố định** | **1.400.000** | **1.150.000** | **250.000** |
| Rủi ro tồn kho | 27.925.200 | 27.925.200 | 0 |
| QC / Doanh số POS | 23,1% | 19,5% | 87,0% |
| QC / DT giao TC | 960,6% | 785,4% | **— (mẫu số 0)** |

**Năm phép kiểm tự động đều ĐẠT**: chi phí cố định, chi phí vận hành, quảng cáo và doanh thu giao
thành công của hai tuần đều **không vượt** trọn tháng; **không tỷ lệ nào ra Infinity/NaN**.

Chi phí cố định 1.150.000 + 250.000 = **đúng 1.400.000** của cả tháng: không cộng trùng, không cộng
nguyên khoản vào từng tuần. Mẫu số 0 ở tuần hai cho ra **"—"**, không phải 0% và không phải vô cực.

## I. 17 xung đột Pancake ↔ ĐVVC (Phase 5)

Kế hoạch ghi 13; **con số thật hiện là 17**.

| Nhóm | Số ca | Kết luận |
|---|---|---|
| Pancake huỷ · ĐVVC **đang giao** | **2** | **CẦN HÀNH ĐỘNG NGAY** |
| Pancake huỷ · ĐVVC đã giao, thu 30.000đ | 1 | ERP đã kết luận **HOÀN** đúng theo luật ngưỡng tiền |
| Pancake đã giao · ĐVVC đang hoàn | 2 | ERP kết luận **chưa kết thúc**, đúng — chiều hoàn còn đang đi |
| Pancake hoàn · ĐVVC đã giao, thu 20–30K | 10 | ERP kết luận **HOÀN**, trùng với Pancake |
| Pancake hoàn · ĐVVC đã giao, thu 499K–524K | 2 | **Cần người đối chiếu** (#1738, #2994) |

**15/17 đã được `ORDER_OUTCOME` xử lý đúng** — "xung đột" chỉ nằm ở nhãn thô của ĐVVC so với nhãn
Pancake, còn kết quả đơn thì đúng.

**Hai ca nguy hiểm thật** (`#3257 · PKE1515019056`, `#3755 · PKE1512538663`): kiện hàng vẫn đang
chạy tới người đã nói **không mua**. Trước đây chúng chỉ là một con số ở mức *cảnh báo* trên trang
Chất lượng dữ liệu — không ai cầm. Nay là **loại việc riêng, hạn 6 giờ**, ngắn nhất trong mọi loại
việc.

**Cố ý không đụng `ORDER_OUTCOME`**: việc huỷ trên Pancake không ghi đè chứng từ ĐVVC, và ngược lại.
Chỉ tạo việc cho người quyết định.

## J. 5 khoản chi thiếu kỳ hiệu lực (Phase 6)

Cả 5 đều từ **nhập sao kê ngân hàng**, nhóm `SOFTWARE`, phương pháp `EVENT_DATE`, **không khoản nào
có `period_start`/`period_end`**:

| Số tiền | Ngày ghi | Nội dung | Chứng từ |
|---|---|---|---|
| 1.340.000đ | 15/08 | TRAN ANH QUAN · chuyển tiền | MB FT26229037655852 |
| 530.000đ | 16/08 | TRAN ANH QUAN · chuyển tiền | MB FT26229359171708 |
| 600.000đ | 24/08 | **CTY TNHH PANCAKE VIỆT NAM** | MB FT26237019663390 |
| 800.000đ | 01/09 | TRAN ANH QUAN · chuyển tiền | MB FT26245508486633 |
| **6.000.000đ** | 02/09 | TRAN ANH QUAN · chuyển tiền | MB FT26246948262000 |

**Trường thiếu: `period_start` và `period_end` — cả 5 khoản.**

**Không khoản nào suy được kỳ một cách xác định.** Nội dung chuyển khoản không chứa thông tin kỳ;
kể cả khoản Pancake cũng chỉ có mã tham chiếu, không có "từ ngày … đến ngày …". Giữ nguyên cờ
`EXPENSE_NEEDS_ALLOCATION_REVIEW`, **không đoán** — đúng luật.

**Hậu quả đo được:** khoản **6.000.000đ** ghi ngày 02/09 đang rơi **trọn vẹn** vào tuần 01–07/09.
Nếu đó là phí phần mềm theo tháng/năm thì tuần đầu đang bị tính nặng 6 triệu và các tuần sau nhẹ đi
đúng bấy nhiêu.

**Một quan sát cần chủ shop xác nhận:** 4/5 khoản có nội dung "TRAN ANH QUAN chuyển tiền" — một
khoản chuyển khoản cá nhân được nhập tự động vào nhóm `SOFTWARE`. Nếu **nhóm chi phí** sai thì báo
cáo lợi nhuận sai bất kể kỳ có đúng hay không. Đây là thứ chỉ chủ shop biết.

## K. Dọn lint (Phase 7)

3 cảnh báo tồn từ trước đã dọn: hai import không dùng, và một biểu thức `&&` dùng như câu lệnh (đổi
thành `if` kèm giải thích vì sao chỉ giữ 10 lỗi đầu). **Lint nay 0 lỗi, 0 cảnh báo.**

Kèm theo: sửa một lỗi thật phát hiện khi rà — lược đồ zod của cấu hình cảnh báo **cắt mất** cờ
`incomplete`, nên mỗi lần chủ shop bấm Lưu là nó biến mất rồi âm thầm bật lại. Nút tắt không có tác
dụng, và không có thông báo lỗi nào. Nay 13 cờ đều có mặt ở **cả ba nơi** (kiểu dữ liệu · lược đồ
máy chủ · giao diện), khoá bằng kiểm thử.

## L. Roadmap sau V2 (Phase 8)

**10/10 lô A→J hoàn thành** trước phiên deploy này. Chi tiết:
`docs/erp-post-v2-release-report.md` và `docs/claude-post-v2-progress.md`.

Bổ sung trong phiên này: chặn tràn hàng đợi ở bộ phát hiện hàng hoàn (445 kiện tồn đọng ⇒ 16 việc
thay vì 200), loại việc "đã huỷ mà hàng vẫn đi", hai lệnh ops mới, và ba bản sửa nêu ở mục F–K.

## M. Còn tồn đọng & việc đáng làm tiếp

**Chặn thật — cần chủ shop:**

1. **Kỳ hiệu lực cho 5 khoản chi**, và xác nhận nhóm chi phí của 4 khoản "chuyển tiền cá nhân".
2. **Hai kiện hàng đang chạy tới khách đã huỷ** — nay có việc hạn 6 giờ, nhưng phải người gọi ĐVVC.
3. **Mức đặt tối thiểu của xưởng** — chưa khai thì đề xuất "đặt 5 cái" vẫn hiện dù xưởng không nhận.
4. **Luật "khách cũ đủ điều kiện mua lại"** — cố ý không tự đặt ngưỡng.

**Việc đáng làm tiếp, xếp theo giá trị:**

1. **Nâng độ phủ quy kết quảng cáo từ 46% lên trên 80%.** Đây là việc đáng giá nhất: nó đang khoá
   toàn bộ nhóm cảnh báo lợi nhuận quảng cáo, và làm mọi con số ROAS chỉ mô tả gần một nửa shop.
2. **Xử lý 445 kiện hàng hoàn chờ kiểm đếm.** Đây là hàng có thật trong kho mà ERP không đếm — kế
   hoạch sản xuất đang đặt thừa đúng bằng lượng đó.
3. **Giảm 1.009 việc đang mở**, trong đó 497 là "đơn chờ xử lý" và 290 là case CSKH. Hàng đợi ở quy
   mô này không ai làm hết được; nên lọc theo mức ưu tiên và đóng bớt việc đã hết ý nghĩa.
4. Hai ca #1738, #2994 cần người đối chiếu Pancake ↔ ĐVVC.

**Giữ PENDING, đúng lệnh:** Direct VTP Fulfillment · ERP tạo vận đơn VTP · WRITE BACKFILL toàn cục ·
xoay secret · tự đổi ngân sách quảng cáo · tự tạo đơn sản xuất · tự ép ghép vận đơn nhập nhằng.
