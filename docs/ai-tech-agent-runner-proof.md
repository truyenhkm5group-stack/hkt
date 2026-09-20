# Bằng chứng lượt chạy runner đầu tiên — agent DOCUMENTATION (Phase 2A)

## Vì sao có trang này

Trước khi tin một agent được phép đụng vào kho mã thật, phải trả lời được ba câu:
nó chạy trên nền nào, nó được sửa cái gì, và ai kiểm tra kết quả của nó. Trang này
ghi lại lượt chạy runner đầu tiên của Phòng Tech AI để những lượt sau có mốc đối chiếu.
Đây là bản ghi một lượt chạy cụ thể, không phải đặc tả chung của hệ thống agent.

## Danh tính lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 |
| Base SHA | `0973e9ae55bdefd35e6f60b3de9e350e48c95c70` |
| Nhánh agent làm việc | `ai/documentation/TECH-1-mu9uou7q` |
| Vai agent đã chạy | DOCUMENTATION |
| Phạm vi ghi được | `docs/` |

Cây làm việc được runner dựng sẵn trên nhánh trên, tách khỏi nhánh chính. Agent không
tự tạo nhánh và không tự chọn base.

## Phạm vi duy nhất của lượt chạy này

Lượt chạy này được phép tạo hoặc sửa **đúng một tệp**:

```
docs/ai-tech-agent-runner-proof.md
```

Không tệp nào khác trong kho được đụng tới — kể cả tệp khác trong `docs/`. Phạm vi hẹp
là có chủ ý: lượt đầu tiên dùng để kiểm chứng đường ống runner, nên diff phải đủ nhỏ để
người review đọc hết trong một lần.

## Kết quả bốn cổng

Bốn lệnh dưới đây được chạy trong cây làm việc của lượt chạy này. Cả bốn đều trả về
mã thoát 0.

| Cổng | Lệnh | Mã thoát | Kết quả |
| --- | --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | 0 | ĐẠT |
| lint | `npm run lint` (`eslint`) | 0 | ĐẠT |
| test | `npm run test` | 0 | ĐẠT — bộ kiểm thử in "TẤT CẢ KIỂM THỬ ĐẠT" |
| build | `npm run build` | 0 | ĐẠT |

Ghi chú về những dòng cảnh báo, để lần sau không ai tưởng là lỗi mới:

- **test** in một số cảnh báo không làm hỏng cổng: trạng thái Viettel Post chưa dịch
  được, hai cảnh báo `migration-number-decreasing` (`0042_bank_ledger`,
  `0041_shipment_return_leg_index`), và 18 dòng bị đánh dấu "logistics + tiền cần xem xét".
  Đây là cảnh báo có sẵn của kho mã, không phải do lượt chạy này sinh ra.
- **build** kết thúc với "Compiled with warnings": thư viện `jose` dùng
  `CompressionStream` / `DecompressionStream`, vốn không được Edge Runtime hỗ trợ.
  Cũng là cảnh báo có sẵn, không đến từ thay đổi trong lượt chạy này.

Vì lượt chạy này chỉ thêm một tệp Markdown, không cảnh báo nào ở trên có thể do nó gây ra.
Giá trị của bốn cổng ở đây là mốc nền: các lượt sau chạm vào mã nguồn sẽ so với mốc này.

## Những việc vai tài liệu KHÔNG được làm

Vai DOCUMENTATION bị giới hạn cố ý. Nó **không**:

- sửa mã nguồn — chỉ ghi được trong `docs/`;
- sửa tệp nào khác ngoài tệp duy nhất trong phạm vi lượt chạy;
- commit thay đổi — việc commit do runner làm sau khi agent kết thúc;
- merge nhánh làm việc vào nhánh chính;
- deploy, hay tác động tới môi trường chạy thật;
- chạy lệnh ngoài danh sách cho phép, và không tìm cách lách khi một lệnh bị chặn;
- bịa số liệu, tên hàm hay hành vi không đọc được từ mã nguồn. Chỗ nào chưa biết thì
  ghi rõ là chưa biết.

Agent không merge, không deploy

## Ranh giới của bản ghi này

Trang này chỉ khẳng định những gì quan sát được trong lượt chạy TECH-1: base SHA, tên
nhánh, phạm vi một tệp, và mã thoát của bốn lệnh ở trên. Nó không mô tả cách runner
được cấu hình, cách chọn agent, hay chính sách review PR — những phần đó chưa được đọc
trong lượt chạy này nên không ghi ở đây.
