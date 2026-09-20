# Bằng chứng lượt chạy runner đầu tiên của Phòng Tech AI

## Vì sao có trang này

Trước khi tin một agent được phép đụng vào kho mã, phải chứng minh được ba thứ: nó chạy trên
nhánh riêng (không phải nhánh chính), nó chỉ sửa đúng phạm vi được giao, và kết quả của nó đi
qua đủ các cổng kiểm tra tự động. Lượt chạy TECH-1 tồn tại chỉ để chứng minh ba điều đó — nó
không sửa một dòng nghiệp vụ nào.

## Thông tin lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 |
| Base SHA | `dedab483ffd4b0069d4400614e0a5de39d09a7e1` |
| Nhánh agent làm việc | `ai/documentation/TECH-1-mua4wtjk` |
| Vai agent đã chạy | DOCUMENTATION |
| Phạm vi ghi được | `docs/` |
| Tệp được phép thay đổi | đúng một tệp: `docs/ai-tech-agent-runner-proof.md` |

Phạm vi của lượt chạy này là **duy nhất một tệp**: `docs/ai-tech-agent-runner-proof.md`.
Không có tệp nào khác được tạo, sửa hay xoá.

## Kết quả bốn cổng

Cả bốn lệnh đều chạy trên cây làm việc của nhánh `ai/documentation/TECH-1-mua4wtjk`.

| Cổng | Lệnh | Mã thoát | Kết quả |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 | ĐẠT |
| lint | `npm run lint` (`eslint`) | 0 | ĐẠT |
| test | `npm run test` (`tsx tests/sync-fixtures.test.ts`) | 0 | ĐẠT — log in "TẤT CẢ KIỂM THỬ ĐẠT" |
| build | `npm run build` (`next build`) | 0 | ĐẠT |

Ghi chú về cảnh báo, để lần sau không ai tưởng là hồi quy:

- `npm run test` in một số dòng `⚠` mang tính rà soát (thứ tự số hiệu migration ở
  `0042_bank_ledger` và `0041_shipment_return_leg_index`, 18 dòng "logistics + tiền" cần xem xét,
  vài mã trạng thái Viettel Post chưa dịch được). Đây là cảnh báo, không làm lệnh thất bại.
- `npm run build` báo "Compiled with warnings": thư viện `jose` dùng `CompressionStream` /
  `DecompressionStream` vốn không được Edge Runtime hỗ trợ. Cảnh báo đến từ phụ thuộc, không
  đến từ thay đổi của lượt chạy này.

Các tên lệnh ở trên được đọc trực tiếp từ mục `scripts` trong `package.json`.

## Những việc vai DOCUMENTATION KHÔNG được làm

- Không sửa mã nguồn: chỉ được ghi trong `docs/`.
- Không tạo/sửa migration, schema hay cấu hình hạ tầng.
- Không commit — việc commit do runner thực hiện sau khi agent kết thúc.
- Không mở, không duyệt và không gộp pull request.
- Không đưa lên môi trường chạy thật.
- Không chạy lệnh ngoài danh sách cho phép; nếu lệnh bị chặn thì báo lại, không tìm đường lách.
- Không viết những gì không đọc được từ mã nguồn; phần nào chưa biết thì ghi rõ là chưa biết.

## Ranh giới quyền hạn

Agent không merge, không deploy
