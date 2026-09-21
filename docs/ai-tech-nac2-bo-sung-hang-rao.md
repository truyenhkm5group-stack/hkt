# Nấc 2 · bổ sung: ba chỗ hở còn lại của hàng rào tuyệt đối

Ngày 20/09/2026 · Nhánh `claude/charming-turing-kao6lw` · **Không migration**

---

## 0. Nói trước: phần lớn Nấc 2 đã có người làm, và tôi làm trùng

Phiên này và một phiên khác **cùng làm Nấc 2 song song**. PR #52 vào `main` trước, và nó đã có
đúng những thứ tôi cũng dựng: sổ phạm vi theo vai, `NEVER_WRITE` kiểm **trước** sổ vai bên trong
`checkWritePath()`, vai lạ rơi về `docs/`.

Đó là chính xác cái giá mà AGENTS.md mục 9 cảnh báo, và lần này nó không làm `main` đỏ — nó chỉ
đốt công. PR của tôi vì thế **bị dựng lại từ `main`**: bỏ toàn bộ phần trùng, giữ đúng phần `main`
chưa có. Ép bản của tôi đè lên bản đã vào kho sẽ làm mất `agent-test-guard.ts` của họ — thứ tôi
không có và là thứ tốt hơn cách tiếp cận tĩnh của tôi.

---

## 1. Ba chỗ hở còn lại

### 1.1 `db/schema.ts` khoá một tệp, để ngỏ hai tệp bên cạnh

Cạnh lược đồ còn:

- `db/migrate.ts` — bộ áp migration **chạy tự động lúc app khởi động**, trên dữ liệu thật, không
  ai bấm gì;
- `db/index.ts` — nơi mở kết nối và ép cờ chỉ-đọc.

Nay hàng rào là `db/`.

### 1.2 Hàng rào khoá nơi KHAI, để ngỏ nơi THI HÀNH

`lib/constants/agent-{sandbox,scopes,test-guard}.ts` là nơi hàng rào được **khai**.
`lib/agents/runner.ts` là nơi nó được **đọc và truyền xuống** `AgentWorkspace`.

Lý lẽ của chính PR #52 — *"một agent sửa được hàng rào của mình thì hàng rào chỉ còn là một lời đề
nghị"* — áp cho **cả hai nửa**. Khoá bản khai mà để ngỏ nơi thi hành thì vẫn còn nguyên một đường:
sửa một dòng ở runner để nó thôi đọc bản khai.

Thêm `lib/agents/`, `app/api/` (tuyến HTTP hướng ra Internet, trong đó có cửa chép sổ), và
`lib/tech/` — dịch vụ giữ sổ của chính phòng Tech: `service.ts` mở/đóng lượt chạy và đổi trạng
thái việc, `dispatch-service.ts` (PR #53, Nấc 3) là nơi ERP giao việc cho agent. Đó là đường GHI
vào chính cuốn sổ ghi lại agent đã làm gì; sửa được nó là sửa được lời khai về chính mình.

### 1.3 Bộ đếm khẳng định có đúng hai đường lách

`agent-test-guard.ts` chặn lối tắt *"xoá khẳng định cho cổng xanh"*, và nó làm việc đó tốt. Nhưng
nó đếm **số** khẳng định. Bài kiểm mới dựng cả hai đường lách **trên chính hàm ấy** và cho thấy nó
trả `ok: true`:

| Đường lách | Bộ đếm thấy gì | Hậu quả |
|---|---|---|
| `assert.equal(x, 'RETURNED')` → `assert.equal(x, 'DELIVERED')` | số khẳng định **không đổi** | Luật nghiệp vụ vừa bị viết lại, cổng xanh |
| Xoá một dòng `await testX()` trong bộ chạy | `testX()` **không phải** khẳng định | Cả một khối kiểm thử biến mất, diff **một dòng** |

Đường thứ nhất là thứ AGENTS.md mục 0 gọi thẳng tên: *"Không được sửa giá trị kỳ vọng của chúng để
CI xanh — nếu chúng đỏ thì code sai, không phải test sai."*

Vai `QA` ghi được `tests/`, nên tới hôm nay cả hai đường ấy đều mở. Nay **11 bài kiểm khoá luật**
nằm ngoài tầm với — nhưng `tests/<bài mới>.test.ts` vẫn ghi được, vì một hàng rào chặn tất cả là
một hàng rào vô dụng.

---

## 2. Chống trôi: sổ đi theo AGENTS.md, không đi theo trí nhớ

Danh sách "bài kiểm khoá luật" sẽ cũ đi ngay khi có luật thứ 66. Nên bài kiểm **quét AGENTS.md**
và đòi mọi tệp `tests/*.test.ts` được nhắc tên phải nằm ở một trong hai chỗ:

- hàng rào tuyệt đối `NEVER_WRITE`, hoặc
- `TEST_NEU_LAM_VI_DU` — **kèm lý do**.

Ba tệp ở danh sách thứ hai (`order-duplicate`, `care-os`, `cs-workqueue`) được mục 50 và 65 nêu
như **ví dụ về một lỗi đã xảy ra**, không phải nơi một luật được ghim.

Thêm một luật mới có nhắc tên một bài kiểm mà quên xếp ⇒ **đỏ ngay**, thay vì bài ấy lặng lẽ nằm
trong tầm với. Và mọi mục ở cả hai danh sách phải trỏ vào **tệp có thật**: đổi tên mà quên sửa sổ
thì mục cũ khớp với đúng 0 đường dẫn, không ai đỏ.

---

## 3. Thử phá

| Phá cái gì | Bài kiểm | Kết quả |
|---|---|---|
| Gỡ `tests/contract-order-outcome.test.ts` khỏi hàng rào | ca kiểm phải nằm trong `NEVER_WRITE` | ✅ **ĐỎ** |
| Gỡ `lib/agents/` khỏi hàng rào | ca kiểm `lib/agents/runner.ts` | ✅ **ĐỎ** |

Phép kiểm sẵn có của PR #52 (*"mọi vùng cấm trong sổ đều phải có ít nhất một ca kiểm"*) làm việc
này tự động — thêm một vùng cấm mà quên ca kiểm thì đỏ, và gỡ một vùng cấm mà quên ca kiểm cũng
đỏ. Đó là một thiết kế tốt và bản này dùng lại nguyên vẹn.

---

## 4. Cổng

`npm run typecheck` · `npm run lint` · `npm test` (ẩn danh và có `GITHUB_TOKEN` giả) · `npm run build` — sạch.

`✓ Nấc 2 (phạm vi theo vai): … 28 vùng cấm, gồm CHÍNH hàng rào và nơi thi hành nó … bài kiểm khoá
luật ngoài tầm với (đổi giá trị kỳ vọng và xoá dòng đăng ký đều lọt bộ đếm)`

---

## 5. Bài học vận hành, không phải bài học kỹ thuật

Hai phiên làm trùng một nấc trong cùng một buổi chiều. AGENTS.md mục 9 đã bắt mỗi phiên một nhánh
và một cây làm việc riêng — và điều đó đã giữ cho `main` không đỏ. Nhưng nó **không** ngăn được
hai phiên nhận cùng một việc.

Thứ còn thiếu là một chỗ **công bố việc đang làm** trước khi bắt đầu, không phải sau khi xong.
`docs/tech-ai-room-status.md` đã là "file trạng thái DUY NHẤT" cho việc ĐÃ XONG; nó chưa có mục
cho việc ĐANG LÀM. Đó là đề xuất, không phải thay đổi trong PR này — thêm một quy ước vào AGENTS.md
là việc của chủ shop.

---

## 6. Bài kiểm này KHÔNG chạm bộ chạy, và đó là chủ ý

Khối `testBaiKiemKhoaLuatNgoaiTamVoi()` được gọi **ngay trong** `testHangRaoTuyetDoi()`, không đăng
ký riêng ở `tests/sync-fixtures.test.ts`.

Lý do là **vận hành**, không phải kiểu dáng: mọi phiên thêm một bài kiểm đều sửa đúng một dòng
`import` trong bộ chạy. Nhánh này đã xung đột ở đúng dòng ấy **bốn lần trong một buổi chiều** —
mỗi lần phải gộp tay, và mỗi lần gộp đều làm **huỷ lượt duyệt** đang có, nên PR quay lại vạch xuất
phát dù nội dung không đổi một chữ.

Khối ấy vốn thuộc về hàng rào tuyệt đối, nên gọi nó ngay tại đó vừa đúng chỗ về nội dung, vừa làm
nhánh **không chạm bộ chạy một dòng nào**. Không mất gì: cùng một tiến trình, cùng một lượt chạy,
mọi khẳng định vẫn chạy — đã xác nhận bằng một lượt thử phá (gỡ `tests/sync-fixtures.test.ts` khỏi
hàng rào ⇒ **ĐỎ**), chứ không tin rằng nó vẫn chạy.

PR nay còn **3 tệp**, và không tệp nào là tệp mà phiên khác đang sửa.
