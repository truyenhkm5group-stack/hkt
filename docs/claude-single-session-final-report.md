# Báo cáo phiên tiếp quản một phiên duy nhất — 09/09/2026

Thực hiện `CLAUDE_ERP_SINGLE_SESSION_TAKEOVER_AND_RELEASE.md`. Từ đầu phiên này chỉ một phiên làm
ERP; bốn phiên trước coi là CLOSED/HANDOFF.

---

## A. Kiểm kê tiếp quản

Chi tiết đầy đủ: `docs/single-session-takeover-inventory.md`.

Điều quan trọng nhất, và nó đổi hẳn cách gộp: **bốn phiên trước không làm trên bốn nhánh riêng** mà
cùng commit thẳng vào `main`. Nên không có gì để "fetch rồi cherry-pick theo phiên" — việc của họ đã
nằm xen kẽ trong lịch sử tuyến tính. Rủi ro thật của mô hình đó không phải xung đột nội dung mà là
commit dở dang và thao tác git trên cây dùng chung.

Quét 11 nhánh remote: **9 nhánh đã gộp hết hoặc bị `main` phủ**, 1 nhánh là sản phẩm độc lập không
thuộc ERP, và **đúng 1 commit còn giá trị đã được thu hồi**.

## B. Production trước khi phát hành

| | |
| --- | --- |
| Commit đang chạy | `2d09a6094df3` — **điểm quay lui** |
| `/api/health` | `ok: true` |
| Migration đã áp | 44/44, băm khớp hết |

## C. Bản ứng cử

**`d8b290d3c0083d3646b61543d11054c3c5da9a5c`**

## D. Việc đã tích hợp trong phiên này

| SHA | Nội dung |
| --- | --- |
| `c0085bc` | **Thu hồi** từ nhánh cũ: báo đơn Pancake chưa chuẩn hoá địa chỉ |
| `f69572b` | **Sửa lỗ hổng**: 3 trang đã làm xong nhưng không có lối vào từ menu |
| `02368eb` | **Sửa sự thật**: "đã đóng" thôi trộn ba chuyện khác nhau + khôi phục bộ lọc theo bộ phận |
| `d8b290d` | Kiểm kê tiếp quản |

### D.1 Đơn kẹt vì địa chỉ chưa chuẩn hoá — 231 đơn

Pancake chỉ giao được khi ghép được địa chỉ khách vào đơn vị hành chính (3 cấp cũ, hoặc 2 cấp mới từ
01/07/2025). Ghép không được thì `ship_province` rỗng, POS hiện *"Vui lòng cung cấp địa chỉ cần chuẩn
hoá"*, đơn nằm im vì không đẩy sang ĐVVC được — và **ERP không hề báo**, nên không ai biết để hỏi lại
khách.

Đo trên production hôm nay: **386/2.423 đơn trong 60 ngày**, trong đó **231 đơn còn sống**.

Bộ lọc căn theo **tỉnh** rỗng chứ không theo quận/huyện rỗng: đơn chỉ có tỉnh + xã là **đúng** chuẩn
hai cấp mới, không phải lỗi. Số trên nhãn bộ lọc cố ý bỏ qua chính bộ lọc địa chỉ — nếu không, bấm
vào "Chưa chuẩn hoá" là nhãn đếm lại chính tập vừa lọc ra và thôi nói lên tổng.

### D.2 Ba trang không có lối vào

Mua hàng & xưởng, Giữ chân khách, Mô phỏng kịch bản đều đã hoàn chỉnh và nằm trong kho, nhưng **không
có dòng nào trong menu**. Một tính năng không có lối vào thì với người dùng nó không tồn tại.

Khoá lại bằng `testNavigationCoverage`: so route thật với `href` trong menu, **hai chiều**. Trang cố
ý không vào menu phải khai kèm lý do. Đo được: 43 trang, 33 mục menu, 0 trang bị bỏ quên.

### D.3 "Đã đóng" không phải "đã làm"

Production có **3.896 việc đã đóng** và không ai trả lời được bao nhiêu là công của đội. Cột
`resolved_at` gộp ba đường hoàn toàn khác nhau: người bấm đóng · điều kiện tự hết · loại cảnh báo bị
tắt. Lấy con số đó báo cáo năng suất là báo nhầm.

Đã tách bằng `resolution` (MANUAL · AUTO · STALE · UNKNOWN) + `resolved_by`, ràng buộc CHECK ở mức
CSDL. **3.896 dòng lịch sử ghi `UNKNOWN`** — không gán bừa cho hệ thống cũng không gán cho người, và
không tính vào tỷ lệ nào.

Phát hiện kèm theo, một lỗi im lặng: vòng tự đóng **chỉ chạm loại cảnh báo đang bật**, nên tắt một
loại đi là việc cũ của nó nằm lại hàng đợi vĩnh viễn — không ai sinh thêm, cũng không gì đóng chúng.

## E. Việc CỐ Ý không lấy

| Nguồn | Vì sao |
| --- | --- |
| `claude/mb-bank-transaction-app-3am23s` (8 commit) | Sản phẩm **độc lập** trong `hkt/`. Sổ ngân hàng của ERP đã có riêng. Gộp vào là kéo một ứng dụng thứ hai vào kho. |
| `hotfix/vtp-import-recovery` (3 commit) | Nội dung đã có trong `main` dưới SHA khác; `main` còn nhiều hơn nhánh. |
| `4cc3622` (rà lại lý do vướng đơn landing) | `main` đã ghi `push_block` ngay lúc nhập sheet và có đường tính dự phòng lúc đọc. Phần còn lại là quét thêm, giá trị nhỏ, rủi ro gộp mã 2 ngày tuổi lớn hơn. |

## F. Việc bị nhiễm bẩn / bị mất — đã khôi phục

| Việc | Chuyện gì | Xử lý |
| --- | --- | --- |
| Biên bản Session 3 + đóng băng Session 1 | `reset` về `origin/main` làm văng 2 commit vừa tạo | commit lại nguyên nội dung (`f91cb50`, `586205e`) |
| Bộ lọc + chip theo **bộ phận** | `d8d6593` ghi đè `alerts/page.tsx` từ bản nền cũ; lõi còn trong `lib`, giao diện biến mất | khôi phục ở `02368eb` |

Loại hỏng thứ hai đáng sợ hơn: **không đỏ typecheck, không đỏ kiểm thử**, chỉ lặng lẽ mất khỏi màn
hình. Đã chụp toàn bộ cây bẩn vào `wip/takeover-snapshot-20260909` trước khi dọn.

## G. Migration

Chi tiết: `docs/migration-inventory-final.md`.

- **44/44 bản cũ đã áp trên production**, băm khớp hết, không thiếu không trùng.
- Bản mới `0045_case_resolution_source`, mốc `1788945579898`.
- Ràng buộc phải nhớ: **mọi migration mới phải có `when` > 1788945578898**. Nhỏ hơn ⇒ drizzle bỏ qua
  vĩnh viễn, không báo lỗi gì. Đã kiểm bằng chính mã nguồn drizzle, không đoán.

## H. Kiểm thử

Thêm mới trong phiên này:

- `testNavigationCoverage` — trang đã xong phải có lối vào, hai chiều;
- assertion địa chỉ chưa chuẩn hoá trong `tests/consistency.test.ts`;
- 9 assertion về nguồn gốc đóng việc trong `tests/action-queue.test.ts`, gồm cả *"thiếu nguồn gốc thì
  KHÔNG được mặc định là người làm"*.

## I–J. Cổng ra cuối

Chạy trên **worktree riêng dựng từ đúng SHA ứng cử**, không dùng cây làm việc chung:

| Bước | Kết quả |
| --- | --- |
| Cây làm việc sạch | ✓ |
| Sổ migration khớp file trên đĩa | ✓ |
| Không lộ bí mật trong kho mã | ✓ |
| `tsc --noEmit` | ✓ 11s |
| Lint | ✓ 7s |
| Toàn bộ kiểm thử nghiệp vụ | ✓ 10s |
| Dựng bản production | ✓ 47s |

**CỔNG RA CUỐI: ĐẠT — 7/7.**

## K. KPI trước phát hành

```
đơn 2.423 · giao thành công 407 · hoàn 846 · đang giao 290 · chưa rõ 13 · chưa gửi 553 · huỷ 314
GTC 32,5%
lên đơn 1.067.420.498đ · giao thành công 216.592.000đ · thực nhận có chứng từ 212.052.000đ
COD đang chờ 3.044.000đ
vận đơn 1.824 · sự kiện 24.126 · việc đang mở 965 · hoàn chờ kiểm đếm 453
```

## L–X. Trạng thái từng mảng

| Mảng | Trạng thái |
| --- | --- |
| Thẩm quyền chi phí | ĐỦ — một đường qua Profit Engine; lương có dự phòng khi Payroll chưa phủ đủ, không double count, không lương = 0 |
| Sổ ngân hàng | ĐỦ — tiền tách khỏi lợi nhuận, nhóm kế toán quyết định vào báo cáo nào |
| Kiểm đếm hàng hoàn | ĐỦ — không auto restock; chỉ số đếm được mới vào tồn |
| Hàng đợi việc | ĐỦ + **đã sửa** nguồn gốc đóng việc và bộ lọc theo bộ phận |
| Máy duyệt / workflow | **BLOCKED_ON_OWNER_DECISION** — xem mục Y |
| Mua hàng & xưởng | ĐỦ mã, **số liệu chưa đối chiếu production** |
| CRM / Giữ chân khách | ĐỦ mã, **số liệu chưa đối chiếu production** |
| Dòng tiền | ĐỦ — không bịa số dư ngân hàng, không dự phóng tiền từ đơn chưa giao |
| Quy kết quảng cáo | **49,2%** — trần thật, xem mục Z |
| Máy khuyến nghị quảng cáo | **DATA_INSUFFICIENT** |
| Mô phỏng kịch bản | ĐỦ — chỉ đọc, có kiểm thử khoá không ghi |
| Tóm tắt quản trị | ĐỦ — deterministic, KHÔNG bằng mô hình ngôn ngữ |
| Lớp AI tư vấn | ĐỦ — 13 module chỉ-đọc khoá ở mức mã nguồn |
| Phân quyền | ĐỦ — 13 đường API nay hỏi đúng quyền module |
| Điều hướng | **đã sửa** — 0 trang bị bỏ quên |

## Y. Máy duyệt — vì sao chờ chủ shop

Phần **an toàn** của §10 ERP đã có đủ: lớp tư vấn không được ghi (khoá ở mức mã nguồn), không tự đổi
ngân sách quảng cáo, không tự tạo đơn mua, không tự sửa tồn; mọi thao tác ghi đều qua `requireUser` +
`can()` + `audit()`, và nhật ký ghi đủ **sáu câu**: ai · làm gì · trên cái gì · trước · sau · vì sao,
kèm `correlationId`.

Phần còn thiếu là **bắt buộc có người thứ hai duyệt**. Đó không phải thay đổi kỹ thuật mà là thay đổi
cách làm việc hằng ngày của kho và kế toán — thêm một bước chờ vào mỗi lần điều chỉnh tồn.
`AGENTS.md` §7 buộc hỏi chủ shop trước khi đổi quy trình.

**Câu cần trả lời: thao tác nào phải có người thứ hai duyệt, và ai duyệt?** Có câu trả lời là làm
được ngay.

## Z. Quy kết quảng cáo — đính chính

Khuyến nghị cũ *"tách mỗi bài về một chiến dịch để lên 78%"* **đã rút lại**. Chủ shop nêu rõ: nghiệp
vụ marketing scale một bài viết ra nhiều quảng cáo → nhóm → chiến dịch → tài khoản, và ngược lại một
tài khoản có nhiều chiến dịch, một chiến dịch nhiều nhóm, một nhóm nhiều quảng cáo. Quan hệ bài ↔
chiến dịch là **nhiều–nhiều theo thiết kế**, không phải cấu hình sai.

⇒ **~49% là trần thật** của quy kết theo bài viết ở cấp chiến dịch. 539 đơn nhập nhằng sẽ không tự
phân giải bằng dữ liệu hiện có.

Cách duy nhất tăng độ phủ mà không bịa số: **gắn mã theo dõi riêng cho từng mẩu quảng cáo**
(`ref`/`utm` trong liên kết hoặc kịch bản tin nhắn) để đơn mang được `ad_id` thật. Đó là quyết định
về cách chạy quảng cáo.

## Việc còn nợ

| # | Việc | Trạng thái |
| --- | --- | --- |
| 1 | Đối chiếu số Mua hàng & xưởng, Giữ chân khách trên production | cần làm sau deploy |
| 2 | Máy duyệt / workflow | `BLOCKED_ON_OWNER_DECISION` |
| 3 | Máy khuyến nghị quảng cáo | `DATA_INSUFFICIENT` |
| 4 | Direct VTP Fulfillment | **PENDING theo lệnh — không mở** |
| 5 | Vài vai trò mất quyền tải CSV | đúng chủ đích; mở lại thì cấp thêm khoá quyền, không bỏ kiểm tra |
