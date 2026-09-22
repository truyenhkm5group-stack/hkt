# TECH-3: Bài kiểm luật "nhánh agent về tới dòng việc" trên CSDL thật

## Mục đích
Viết bài kiểm cho ca hai lượt chạy nối tiếp trên cùng một việc: lượt sau đẩy nhánh khác thì dòng việc phải trỏ nhánh mới và chỉ có hai sự kiện BRANCH, không phải ba.

## Tệp được tạo
- `tests/agent-branch-claim-ingest.test.ts` — Bài kiểm chính, chạy `ingestAgentRun()` trên CSDL thật với:
  - Dựng một agent và một việc
  - Lượt chạy 1: ghi nhánh A vào dòng việc → tạo sự kiện BRANCH thứ 1
  - Lượt chạy 2: ghi nhánh B khác vào dòng việc → tạo sự kiện BRANCH thứ 2
  - Kiểm tra: dòng việc trỏ nhánh B (lượt sau thắng)
  - Kiểm tra: đúng 2 sự kiện BRANCH, không 3
  - Kiểm tra: mốc thời gian đi theo đồng hồ thật
  - Dọn dữ liệu tự động bằng tiền tố `tech-3-`

- `tests/agent-tu-dang-ky.test.ts` — Tệp đăng ký (sửa, không tạo)
  - Thêm `import { testNhanhAgentVeToiViec } from "./agent-branch-claim-ingest.test";`
  - Thêm lời gọi `await testNhanhAgentVeToiViec();` trong hàm `chayBaiKiemAgentTuDangKy()`

## Mô tả kỹ thuật

### Luật được kiểm tra
Hàm `xetGhiNhanhViec()` (đã tồn tại ở `lib/constants/agent-branch-claim.ts`) quyết định việc có nên ghi nhánh vào dòng việc hay không:
- Ô rỗng → ghi (lần đầu)
- Nhánh agent cũ + nhánh agent mới khác → ghi (lượt mới thắng)
- Nhánh của người (không có tiền tố `ai/`) → KHÔNG ghi (máy không cãi người)
- Lượt chạy không đẩy nhánh → KHÔNG xoá ô đang có

### Gọi hệ thống
Hàm `ingestAgentRun()` (nằm ở `lib/tech/agent-run-ingest.ts`) chịu trách nhiệm chép sổ lượt chạy từ máy ngoài về ERP:
- Nhận `branch` từ lượt chạy
- Gọi `setTechTaskBranch()` để cập nhật cột `tech_tasks.branch`
- Hàm này cũng trả về thông tin về việc có ghi được nhánh hay không (trường `nhanhViec`)

### Dữ liệu kiểm thử
- Agent: `tech-3-agent` (DOCUMENTATION, enabled=true)
- Việc: `tech-3-TASK` (status=TRIAGED)
- Lượt 1: external ref `tech-3-gh:900001:1`, nhánh `ai/documentation/tech-3-TASK-nhanh-A`
- Lượt 2: external ref `tech-3-gh:900002:1`, nhánh `ai/documentation/tech-3-TASK-nhanh-B`

### Sự kiện và mốc thời gian
Bài kiểm ghi lại hai sự kiện BRANCH:
- Sự kiện 1: `previousValue=""` → `nextValue=nhánh A`
- Sự kiện 2: `previousValue=nhánh A` → `nextValue=nhánh B`

Mốc thời gian được lấy từ đồng hồ thật (AGENTS.md mục 50, 65) — không ghim một ngày cụ thể. Bài kiểm chỉ kiểm tra mốc T2 ≥ T1.

## Chạy bài kiểm
```bash
npm test
```

Bài kiểm nằm trong khối cuối của `npm test`, chạy sau hầu hết các bài kiểm khác để không để dữ liệu của nó lọt vào tổng hợp của bài khác.

## Dọn dữ liệu
Bài kiểm tự dọn bằng hàm `cleanupBranchClaimFixtures()` ở cuối:
- Xoá sự kiện của việc
- Xoá lượt chạy của agent
- Xoá việc
- Xoá agent

Dữ liệu chỉ tồn tại trong quá trình chạy bài kiểm, không làm ảnh hưởng tới bài kiểm khác.

## Kết quả
- **Typecheck**: ✓ xanh
- **Lint**: ✓ xanh
- **Test**: ✓ TẤT CẢ KIỂM THỬ ĐẠT

Bài kiểm đã được đăng ký và chạy thành công trong bộ kiểm thử chính.
