# Phase 3 — Quản trị hiệu suất theo KẾT QUẢ: điểm xuất phát

Tài liệu này KHÔNG đề xuất tính năng mới cho tới khi đã nói rõ **cái gì đã có**. Lý do: phần lớn
hạ tầng đo lường của Phase 3 đã được dựng ở Phase 2 và V2, và một bản "Phase 3" viết lại từ đầu
sẽ tạo ra bộ số thứ hai cho cùng một câu hỏi — đúng cái sai mà AGENTS.md mục 8 cấm.

---

## 1 · Đã có gì (đang chạy trên production)

### Thẻ điểm cá nhân — `lib/queries/work-performance.ts::getPerformance`

Sáu trục, mỗi trục có **mẫu số** đứng cạnh và `null` khi chưa đo được (không bao giờ thay bằng 0):

| trục | nói gì | nguồn |
|---|---|---|
| `outcome` | việc đóng trong kỳ mà kết quả **thuộc trách nhiệm** người này | `work_item_events` |
| `quality` | việc đóng rồi phải mở lại / bị chặn nhiều lần | `work_item_events` |
| `sla` | tỷ lệ việc **có hạn** đóng đúng hạn | hạn của chính miền nguồn |
| `productivity` | số việc đóng — **luôn** đọc cùng độ khó và tiền trung bình | phép chiếu |
| `resolutionHours` | **trung vị** giờ xử lý (không phải trung bình) | mốc xuất hiện → đóng |
| `okr` | tiến độ KR cá nhân | `okr_key_results` |

Cộng thêm `recovered` (tiền lấy lại được) — **cố ý không gộp vào điểm nào**, vì tiền của một ca
phụ thuộc giá trị đơn chứ không phụ thuộc người xử lý.

`combineScore` chỉ trả về điểm khi chủ shop **tự khai trọng số**; không có bộ mặc định và không
được thêm. Độ phủ luôn đứng cạnh điểm.

### Hiệu suất theo phòng — `lib/queries/dept-performance.ts`

Mỗi chỉ số mang `basis` (nguồn số liệu, để kiểm chứng được) và cờ `shared` cho kết quả mà bên
ngoài đồng quyết định. Phòng nào ERP chưa đọc được ở độ mịn NGƯỜI thì nằm ở danh sách `missing` —
**nói thẳng là chưa đo được**, không bịa một con số.

### Kỳ review — `review_cycles`

Chốt kỳ đóng băng số liệu của kỳ đó (`status = 'FINAL'`, bất biến).

---

## 2 · Thiếu gì để gọi là "quản trị theo kết quả"

Bốn khoảng trống, xếp theo thứ tự phải làm:

### 2.1 · Chưa có ĐÍCH ở mức người, nên số đo không nói được "đạt hay chưa"

`outcome = 72` là một con số, không phải một kết luận. Thiếu vế "kỳ vọng của vai trò này là bao
nhiêu". OKR cá nhân có đích nhưng chỉ phủ những người đã được đặt KR — mà đặt KR là việc nặng,
không hợp với nhân viên vận hành.

**Việc cần làm**: sổ **KỲ VỌNG THEO VAI TRÒ / CHỨC DANH** — mỗi chức danh khai ngưỡng cho vài trục
(ví dụ: nhân viên vận đơn, `sla ≥ 85%`, `resolutionHours ≤ 8`). Chủ shop khai; **không có bộ mặc
định**, vì một ngưỡng máy đoán sẽ được đọc như một cam kết của shop.

Đây là chỗ **chức danh** (`positions`, vừa dựng ở P0.2) lần đầu có việc thật để làm — và nó vẫn
không sinh quyền: kỳ vọng là thứ để ĐỐI CHIẾU, không phải thứ để MỞ CỬA.

### 2.2 · Chưa có xu hướng

Thẻ điểm là ảnh chụp một kỳ. Quản trị theo kết quả cần **kỳ này so với kỳ trước**: một người ở 68
và đang lên khác hẳn một người ở 68 và đang xuống, dù con số bằng nhau.

**Việc cần làm**: `getPerformance` nhận thêm kỳ đối chiếu và trả `delta` theo **đơn vị của chính
trục đó**, dấu đã tính theo chiều (giống `scoreboard` của họp tuần). Không tạo bảng mới: tính lại
từ cùng dữ liệu, vì hai kỳ đọc từ hai nguồn là hai cách để chúng lệch nhau.

### 2.3 · Chưa có vòng phản hồi khép kín

Hiện tại số liệu chảy một chiều: chứng từ → thẻ điểm → màn hình. Không có chỗ ghi **trao đổi giữa
quản lý và nhân viên**, **cam kết cho kỳ sau**, và **kiểm lại cam kết đó ở kỳ kế tiếp**.

**Việc cần làm**: bản ghi đánh giá cá nhân gắn vào `review_cycles` — đích → thực tế → chênh →
nhận xét của quản lý → **một** cam kết cho kỳ sau → kỳ sau tự đối chiếu cam kết ấy. Chốt kỳ thì
bất biến như mọi kỳ review khác.

Ràng buộc: bản ghi này **phải có người ký**. Một bản đánh giá do máy sinh ra rồi tự lưu là thứ
không ai đứng sau, và nhân viên sẽ đúng khi không tin nó.

### 2.4 · Chưa nói được phần nào KHÔNG thuộc kiểm soát của người đó

`shared` đã đánh dấu chỉ số do bên ngoài đồng quyết định, nhưng mới ở mức NHÃN. Chưa có chỗ nói
"kỳ này người này tụt vì ĐVVC đình công 4 ngày" — mà đó chính là thông tin quyết định một kỳ đánh
giá công bằng.

**Việc cần làm**: cho phép gắn **yếu tố ngoài tầm kiểm soát** vào một kỳ của một phòng (khoảng
thời gian + mô tả + chỉ số bị ảnh hưởng), và mọi thẻ điểm chồng lấn khoảng đó hiện nhãn cảnh báo.
Không tự điều chỉnh số — điều chỉnh số là bịa; nêu bối cảnh là trung thực.

---

## 3 · Ranh giới của Phase 3

**Không** đụng vào:

- `ORDER_OUTCOME` và mọi luật nghiệp vụ ở `docs/business-rules/ORDER_OUTCOME.md`;
- cách tính tiền, kho, chi phí, lương đã chốt kỳ;
- mô hình quyền vừa dựng ở P0.2 (kỳ vọng theo chức danh là ĐỐI CHIẾU, không phải phân quyền).

**Không** làm, dù nghe hợp lý:

- xếp hạng nhân viên theo số việc đã đóng (AGENTS.md 24, 27);
- một điểm tổng khi chủ shop chưa khai trọng số;
- tự điều chỉnh số của một kỳ vì lý do khách quan.

---

## 4 · Tăng trưởng đề xuất cho phiên sau

Làm **2.1 trước**, một mình, rồi dừng lại đo. Lý do: nó là vế còn thiếu khiến mọi con số hiện có
chưa kết luận được, và nó nhỏ (một sổ khai báo + một cột "so với kỳ vọng" trên thẻ điểm đã có).
2.2 và 2.4 chỉ có nghĩa khi đã có đích để so. 2.3 là phần nặng nhất và phải làm sau cùng, vì nó
đóng băng dữ liệu — sai ở đó thì sửa được nhưng không xoá được.
