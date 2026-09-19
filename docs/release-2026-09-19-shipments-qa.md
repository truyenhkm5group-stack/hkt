# Vận đơn & care — vòng sửa theo QA thật trên Chrome production (19/09/2026)

Bản này KHÔNG đổi kiến trúc. Phần tách **kết quả care** khỏi **lệnh Viettel Post** (bản
18–19/09, `docs/release-2026-09-19-care-decision.md`) giữ nguyên, và có bài kiểm khoá lại điều đó.

## Nguyên nhân gốc chung của hai lỗi P0

`buildQueue` (`lib/queries/care-workbench.ts`) dựng dòng từ ba nguồn: tháp giao vận · case sai
thông tin · **kiện có đợt care đã đóng trong 7 ngày**. Nhánh thứ ba ghi thẳng `failedAttempts: 0`,
mượn khoá lý do `CARE_TODAY`, rồi để `careViewOf` xếp góc nhìn theo TRẠNG THÁI của đợt care.

Đo trên production bằng ops `db-query` ngày 19/09/2026: **11 vận đơn** có đồng thời một đợt đã đóng
trong 7 ngày và một đợt còn mở. Ba kiện thuộc rổ `DELIVERY_FAILED` đi đường tháp giao vận nên không
sao; **tám kiện còn lại** (`RETURNING` · `PENDING`) rơi vào nhánh thứ ba và mang cả hai lỗi:

| Vận đơn | Chặng | Lần hụt thật | Bảng in | Đợt care |
|---|---|---|---|---|
| `474b6367` | Đang chuyển hoàn | 4 | "Chưa hụt lần nào" | `RESOLVED/false` + `ASSIGNED/true` |
| `db48a154` | Chờ xử lý | 5 | "Chưa hụt lần nào" | `RESOLVED/false` + `WAITING_CARRIER/true` |
| `450c048f` | Chờ xử lý | 1 | "Chưa hụt lần nào" | `RESOLVED/false` + `ASSIGNED/true` |

Và cùng những dòng ấy in **"Đã rời điều kiện cần care · Nên: Không còn việc gì"** trong khi vẫn nằm
tab **Cần care**, vẫn cộng vào tổng kiện, COD treo và số vỡ SLA.

### Sửa

* **Số lần phát hụt về MỘT phép đếm** trong `loadQueueFacts` — cùng công thức panel chi tiết dùng
  (`count(*) where normalized_stage = 'DELIVERY_FAILED'`), áp trong `push()` cho **mọi** nguồn dòng.
  Nguồn dòng không còn được phép nói một con số riêng.
* **Tư cách hàng đợi đi theo ĐIỀU KIỆN CARE**, không theo cờ `active` của đợt: cờ mới
  `CareCase.inCareCondition`. Đúng lời hứa ở đầu tệp — *"kiện RỜI hàng đợi khi điều kiện hết, không
  phải khi đội bấm xong"*. Trình duyệt cũng đọc cờ này trong `patch()`, nếu không thì một lần đổi
  trạng thái sẽ kéo kiện đã hết việc quay lại tab Cần care.
* **Khoá lý do riêng `LEFT_CARE_CONDITION`** để một dòng thôi nói hai điều trái nhau.

Kiện vẫn **tra được** ở tab "Đã xử lý" và ở "Tất cả vận đơn" — không dòng lịch sử nào biến mất.

## Các lỗi còn lại

| # | Lỗi | Sửa |
|---|---|---|
| P0-1 | "Đã giao người" đọc ra thành *đã giao hàng cho người nhận* | Nhãn → **"Đã giao việc"**. Khoá `ASSIGNED` trong CSDL **giữ nguyên** |
| P0-3 | "VTP cần đối chiếu" cụt ở 300/354 — 54 kiện im lặng lâu nhất không có đường nào mở ra | 300 thành **cỡ trang**, nút "Xem thêm" (`?dc=`); bộ đếm theo lý do tính bằng **hàm cửa sổ trên toàn bộ tập** (trước đây đếm trên trang đã trả về nên mọi chip đều thiếu, và thiếu **không đều**); "Chép toàn bộ N mã" **hỏi lại CSDL** |
| P0-4 | Phím tắt 1/2/3 có thể bắn khi đang gõ | `lib/keyboard.ts`: `closest()` trên input/textarea/select/contenteditable/ô tìm/ô note + bộ gõ tiếng Việt (`isComposing`). Phím chỉ **CHỌN**, nút "Ghi nhận" mới ghi |
| P1-6 | Tab "Đã xử lý" in "COD treo 152,1 tr · 147 vỡ SLA" trên 272 ca đã đóng | Phép cộng đúng, **nhãn sai**: nhãn đi theo tab |
| P1-7 | Tooltip ⓘ dính, che hàng tab, nuốt cú bấm vào tab "Đã xử lý" | Mở **xuống**, đóng khi cuộn (nghe ở pha bắt), trễ 120 ms để đi từ nút xuống bảng |
| P1-8 | Khối "KẾT QUẢ CARE" `sticky` che 1–2 dòng hành trình | Ra **hẳn khỏi vùng cuộn** — vẫn luôn thấy, không phủ lên gì |
| P1-9 | "Chờ phát lại" xuất hiện ở ba chỗ với ba nghĩa | Cột CARE tách rõ **"Kết quả case"** / **"Trạng thái care"**; cột ĐVVC mang tiền tố **VTP** |
| P1-10 | Hẹn nhanh chỉ có ở dòng ngoài bảng | Ngăn kéo có +2 giờ / Sáng mai / +2 ngày, dùng chung `followUpPresetAt` |
| P1-11 | COD 749.000 cạnh "sản phẩm 998.000", dòng `1 × 0 ₫` không rõ là gì | In phép cộng: Tạm tính − Giảm giá + Phí ship = Tổng đơn, trừ đã trả trước rồi so với COD vận đơn; lệch thì **nói thẳng là lệch**. Cột Pancake không trả in `—`, không in `0`. Dòng 0 ₫ dán nhãn theo cờ `is_bonus`, **không suy từ "giá bằng 0"** |
| P1-12 | "Khách hàng 0984107775" trông như tên khách | `lib/constants/customer-name.ts` → in **"Chưa có tên"**, chuỗi gốc ở tooltip. Không đoán tên, không ghi đè dữ liệu |
| P2-14 | Đổi tab không có phản hồi | Chấm quay tại đúng tab vừa bấm + bảng cũ mờ đi (`StaleWhileRefreshing`), không xô lệch bố cục |

## Những gì bản này KHÔNG làm

* **P2-13 (một lần rớt về màn đăng nhập)**: chưa tái hiện được, và không có log đủ để kết luận.
  Đoán một nguyên nhân rồi vá là thêm một đường mã không ai chứng minh được. Xem phần dưới.
* **P0/P1-15 (webhook Pancake → Viettel Post)**: là việc của tầng tích hợp, không phải của màn hình
  này. Trộn nửa vời vào bản UI sẽ làm cả hai khó đọc lại. Đo riêng, báo cáo riêng.

## Bài kiểm

`tests/shipments-qa-fixes.test.ts` — 15 khối, chạy trong `npm test`. Không khối nào ghim một ngày
tuyệt đối (luật 50): mốc hoặc đi theo đồng hồ thật cùng nhịp với thứ nó đo, hoặc dựng từ chính dữ
liệu vừa gieo.

Hai khối khoá lại kiến trúc đã chốt: ghi kết quả care trên ca **đã hết điều kiện** vẫn phải được, và
gói tin ĐVVC **không xoá/sửa một dòng quyết định nào** (`care_decisions` là sổ chỉ thêm).
