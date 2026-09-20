# Bằng chứng lượt chạy runner đầu tiên của Phòng Tech AI (TECH-1)

## Vì sao có trang này

Trước khi giao cho agent bất kỳ quyền đụng vào kho mã, cần một lượt chạy thật để chứng minh
đường ống hoạt động đúng như thiết kế: agent nhận việc, làm trên nhánh riêng, bị giới hạn phạm vi
ghi, và bốn cổng kiểm tra vẫn chạy được trên cây làm việc của agent. Trang này ghi lại lượt chạy
đó để người sau không phải tin lời kể — mọi con số dưới đây đều lấy từ output lệnh đã chạy.

## Danh tính lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 |
| Base SHA | `dedab483ffd4b0069d4400614e0a5de39d09a7e1` |
| Nhánh agent làm việc | `ai/documentation/TECH-1-mua4mnwe` |
| Vai agent đã chạy | DOCUMENTATION |

## Phạm vi duy nhất của lượt chạy

Lượt chạy này được phép tạo hoặc sửa **đúng một tệp**:

```
docs/ai-tech-agent-runner-proof.md
```

Không có tệp nào khác được tạo, sửa hay xoá. Quyền ghi của vai tài liệu bị giới hạn trong thư mục
`docs/`, và task này còn thu hẹp thêm xuống một tệp duy nhất.

## Kết quả bốn cổng

Cả bốn lệnh đều được chạy trên chính cây làm việc của nhánh agent, qua danh sách lệnh cho phép.

| Cổng | Lệnh | Exit code | Kết quả |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 | ĐẠT |
| Lint | `npm run lint` (`eslint`) | 0 | ĐẠT, không có phát hiện nào được in ra |
| Test | `npm run test` | 0 | ĐẠT — output kết thúc bằng "TẤT CẢ KIỂM THỬ ĐẠT" |
| Build | `npm run build` | 0 | ĐẠT, có cảnh báo (warning), không có lỗi |

Ghi chú để không hiểu nhầm hai cổng cuối:

- **Test**: ngoài dòng tổng kết "TẤT CẢ KIỂM THỬ ĐẠT", bộ kiểm thử còn in một số cảnh báo dạng `⚠`
  (ví dụ `migration-number-decreasing` ở `0042_bank_ledger` và `0041_shipment_return_leg_index`, và
  một danh sách 18 dòng kết hợp logistics + tiền cần xem xét). Đây là cảnh báo tư vấn, không làm
  cổng trượt — exit code vẫn là 0.
- **Build**: Next.js báo "Compiled with warnings", nguồn cảnh báo là `node_modules/jose`
  (`CompressionStream` / `DecompressionStream` không được Edge Runtime hỗ trợ). Cảnh báo đến từ
  thư viện bên thứ ba, không đến từ thay đổi của lượt chạy này — và lượt chạy này không hề đụng
  vào mã nguồn.

## Những việc vai tài liệu KHÔNG được làm

- Không sửa mã nguồn: chỉ ghi được trong `docs/`.
- Không tạo commit — việc commit do runner thực hiện sau khi agent kết thúc.
- Không merge nhánh vào nhánh chính.
- Không deploy, không đụng vào hạ tầng hay biến môi trường máy chủ.
- Không chạy lệnh ngoài danh sách cho phép; nếu một lệnh bị chặn thì báo lại, không tìm cách lách.
- Không viết điều không đọc được từ mã nguồn hoặc từ output lệnh. Chưa biết thì ghi là chưa biết.

## Câu khẳng định ranh giới

Agent không merge, không deploy
