# Bằng chứng lượt chạy runner đầu tiên — Phòng Tech AI (TECH-1)

## Vì sao có trang này

Một lượt chạy agent chỉ đáng tin khi đọc ngược lại được: nó đứng trên nền commit nào, làm trên
nhánh nào, đụng vào đúng những tệp nào, và bốn cổng chất lượng nói gì. Thiếu một trong bốn thứ đó
thì "agent chạy thành công" chỉ là một câu khẳng định, không phải bằng chứng.

Trang này ghi lại lượt chạy đầu tiên của Phòng Tech AI để lần sau có cái mà đối chiếu.

## Nhận dạng lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | `TECH-1` |
| Base SHA | `a52a6927203208fab1abd9df718cbee586e78e3a` |
| Nhánh làm việc | `ai/documentation/TECH-1-mu9wg660` |
| Vai agent đã chạy | `DOCUMENTATION` |
| Phạm vi ghi | `docs/` |

Ba giá trị đầu lấy từ bản giao việc của runner. Tôi **không tự kiểm chứng lại được** chúng bằng
`git`: các lệnh `git rev-parse HEAD` và `git rev-parse --abbrev-ref HEAD` đều bị hàng rào của vai
tài liệu chặn, và tôi không đi đường vòng để lách. Dấu hiệu gián tiếp duy nhất đọc được là đường
dẫn cây làm việc hiện trong log `npm run test`:
`/tmp/erp-agent-XFmzLr/ai-documentation-TECH-1-mu9wg660` — khớp với tên nhánh nêu trên.

## Phạm vi duy nhất của lượt chạy này

Đúng **một** tệp, chính là tệp bạn đang đọc:

```
docs/ai-tech-agent-runner-proof.md
```

Không tệp nào khác được tạo, sửa hay xoá. Đây là một thay đổi thuần Markdown — không chạm vào mã
nguồn, schema, migration hay cấu hình.

## Kết quả bốn cổng

Tôi tự chạy cả bốn trong cây làm việc của lượt chạy này. Cột "mã thoát" là số thật mà runner trả về.

| Cổng | Lệnh | Mã thoát | Kết luận |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 | ĐẠT |
| lint | `npm run lint` (`eslint`) | 0 | ĐẠT, không phát sinh cảnh báo |
| test | `npm run test` (`tests/sync-fixtures.test.ts`) | 0 | ĐẠT — bản in kết thúc bằng `TẤT CẢ KIỂM THỬ ĐẠT` |
| build | `npm run build` (`next build`) | 0 | ĐẠT |

Hai ghi chú để người đọc sau không hiểu nhầm là có hồi quy:

- **test** in kèm vài cảnh báo có sẵn của bộ fixture: hai dòng `migration-number-decreasing`
  (`0042_bank_ledger`, `0041_shipment_return_leg_index`), các dòng `[vtp-registry]` báo trạng thái
  Viettel Post chưa dịch được, và 18 dòng "kết hợp logistics + tiền (cần xem xét)". Đây là cảnh
  báo, không phải lỗi; cổng vẫn thoát 0.
- **build** in `Compiled with warnings`: thư viện `jose` dùng `CompressionStream` /
  `DecompressionStream` vốn không được Edge Runtime hỗ trợ. Cảnh báo đến từ `node_modules`, không
  phải từ thay đổi của lượt chạy này.

Thứ tự thực tế: bốn cổng được chạy **trước** khi tệp tài liệu này được ghi. Vì thay đổi duy nhất
của lượt chạy là một tệp Markdown nằm trong `docs/`, nó không nằm trong đầu vào của `tsc`, `eslint`,
bộ test hay `next build`. Nói cho đủ: tôi **chưa** chạy lại bốn cổng sau khi ghi tệp.

## Những việc vai tài liệu KHÔNG được làm

Hàng rào này có thật chứ không phải quy ước xã giao — lệnh ngoài danh sách bị chặn ngay tại chỗ, như
trường hợp `git rev-parse` ở trên.

- Không sửa mã nguồn. Chỉ ghi được trong `docs/`.
- Không commit. Việc commit do runner làm sau khi agent xong.
- Không merge, không push.
- Không deploy.
- Không chạy lệnh ngoài danh sách cho phép, và không tìm đường lách khi một lệnh bị chặn.
- Không bịa: chỉ viết điều đọc được từ mã nguồn hoặc từ đầu ra lệnh đã chạy. Chưa biết thì ghi rõ
  là chưa biết.

Phạm vi đọc cũng bị giới hạn: trong lượt chạy này `src/lib/agents/runner.ts` và
`src/lib/constants/agent-sandbox.ts` đều nằm ngoài phạm vi đọc, nên trang này **không** mô tả chi
tiết cơ chế bên trong của runner hay sandbox. Phần mô tả runner ở dưới chỉ dựa trên
`scripts/agent-run.ts` và `scripts/agent-runner-check.ts` — hai tệp tôi đọc được thật.

## Runner đặt lượt chạy này ở đâu

Theo `scripts/agent-run.ts`:

- Lượt chạy khởi động bằng `npm run agent:run -- --task TECH-1 --agent documentation`, cổng mặc
  định là `typecheck,lint` và có thể mở rộng bằng `--gates`.
- Base SHA lấy từ `git rev-parse HEAD` của **kho gốc**, không phải của cây làm việc đang bẩn — để
  base ghi trong sổ mô tả đúng thứ agent nhìn thấy.
- Script tự nó cũng không merge/push/deploy; nó kết thúc bằng dòng
  `KHÔNG merge, KHÔNG push, KHÔNG deploy — người xem rồi quyết.`

`scripts/agent-runner-check.ts` (`npm run agent:check`) là bước kiểm trước: xác nhận có `git`, cây
làm việc sạch, hàng rào lệnh còn chặn đúng, và khoá AI của máy runner dùng được.

---

**Agent không merge, không deploy**
