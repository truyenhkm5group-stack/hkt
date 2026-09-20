# Bằng chứng lượt chạy runner đầu tiên của Phòng Tech AI

## Vì sao có trang này

Trước khi cho agent đụng vào mã nguồn thật, cần chứng minh được một điều đơn giản: runner có thật
sự dựng được cây làm việc trên một nhánh riêng, chạy đúng một vai agent, giới hạn đúng phạm vi ghi
đã khai báo, và bốn cổng chất lượng của repo vẫn chạy được từ trong cây đó. Lượt chạy này là lượt
kiểm chứng (proof) cho vai DOCUMENTATION — vai có rủi ro thấp nhất vì không được chạm vào mã.

Trang này ghi lại những gì đã thực sự xảy ra trong lượt chạy, để lượt sau có mốc so sánh.

## Thông số lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 |
| Base SHA | `54f47dc969bd0b1e89a2a0dab3393577e15513d1` |
| Nhánh làm việc | `ai/documentation/TECH-1-mu9tlxq7` |
| Vai agent đã chạy | DOCUMENTATION |
| Phạm vi ghi được cấp | `docs/` |
| Phạm vi thực tế của lượt chạy | đúng một tệp: `docs/ai-tech-agent-runner-proof.md` |

Phạm vi của lượt chạy này hẹp hơn quyền ghi được cấp: agent được ghi trong cả `docs/`, nhưng việc
TECH-1 chỉ cho phép tạo hoặc sửa duy nhất tệp `docs/ai-tech-agent-runner-proof.md`. Không có tệp
nào khác bị tạo, sửa hay xoá.

## Kết quả bốn cổng

Các lệnh được chạy từ cây làm việc của nhánh trên, qua script trong `package.json`.

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | ĐẠT — exit code 0 |
| lint | `npm run lint` (`eslint`) | ĐẠT — exit code 0, không có cảnh báo in ra |
| test | `npm run test` (`tsx tests/sync-fixtures.test.ts`) | ĐẠT — exit code 0, bộ kiểm thử in "TẤT CẢ KIỂM THỬ ĐẠT" |
| build | `npm run build` (`next build`) | ĐẠT — exit code 0 |

Hai ghi chú để người đọc sau không hiểu nhầm "sạch tuyệt đối":

- `npm run test` đạt nhưng vẫn in một số cảnh báo đã biết của repo: trạng thái Viettel Post chưa
  dịch được, hai cảnh báo `migration-number-decreasing` (`0042_bank_ledger`,
  `0041_shipment_return_leg_index`), và 18 dòng "kết hợp logistics + tiền cần xem xét". Đây là
  cảnh báo có sẵn từ base SHA, không phải do lượt chạy này sinh ra.
- `npm run build` đạt nhưng kết thúc bằng "Compiled with warnings": thư viện `jose` dùng
  `CompressionStream` / `DecompressionStream` không được Edge Runtime hỗ trợ. Cũng là cảnh báo có
  sẵn từ base SHA.

Vì lượt chạy này chỉ thêm một tệp Markdown, bốn kết quả trên phản ánh trạng thái của base SHA chứ
không phản ánh tác động của agent.

## Những việc vai DOCUMENTATION KHÔNG được làm

- Không sửa mã nguồn. Quyền ghi chỉ có trong `docs/`; mọi thay đổi ngoài thư mục đó nằm ngoài vai.
- Không commit. Việc commit do runner thực hiện sau khi agent gọi `finish`.
- Không merge.
- Không deploy.
- Không chạy lệnh ngoài danh sách cho phép, và khi một lệnh bị chặn thì không tìm đường lách — phải
  báo lại trong phần kết luận.
- Không viết những điều không đọc được từ mã nguồn: không bịa số liệu, không bịa tên hàm; chỗ nào
  chưa biết thì ghi rõ là chưa biết.

Agent không merge, không deploy

## Điều trang này chưa khẳng định

Lượt chạy chỉ chứng minh đường đi của vai DOCUMENTATION. Nó chưa nói gì về các vai có quyền ghi mã
nguồn, chưa kiểm chứng hành vi của runner khi agent vi phạm phạm vi ghi, và chưa kiểm chứng luồng
commit/PR phía sau `finish` — những phần đó cần lượt chạy riêng.
