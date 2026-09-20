# Bằng chứng lượt chạy runner đầu tiên của Phòng Tech AI

## Vì sao có trang này

Trước khi tin một agent được phép đụng vào kho mã, phải chứng minh được ba điều: nó chạy trên
đúng nhánh của nó, nó chỉ chạm vào đúng phạm vi được giao, và nó không tự ý đưa thay đổi ra
ngoài. Trang này là bản ghi của lượt chạy đầu tiên dùng để kiểm chứng cả ba điều đó.

Đây là tài liệu bằng chứng cho một lượt chạy cụ thể, không phải đặc tả hệ thống runner.

## Thông tin lượt chạy

| Mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 |
| Vai agent đã chạy | DOCUMENTATION |
| Nhánh làm việc | `ai/documentation/TECH-1-mu9svtcd` |
| Base SHA | `54f47dc969bd0b1e89a2a0dab3393577e15513d1` |

## Phạm vi duy nhất

Lượt chạy này được phép tạo hoặc sửa **đúng một tệp**:

```
docs/ai-tech-agent-runner-proof.md
```

Không tệp nào khác được tạo, sửa hay xoá. Quyền ghi của vai DOCUMENTATION giới hạn trong thư
mục `docs/`, và việc TECH-1 còn thu hẹp thêm xuống đúng tệp trên.

## Kết quả bốn cổng

Bốn lệnh dưới đây được chạy trực tiếp trong cây làm việc của nhánh, toàn bộ trả về mã thoát 0.

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | ĐẠT — exit 0 |
| Lint | `npm run lint` (`eslint`) | ĐẠT — exit 0 |
| Test | `npm run test` | ĐẠT — exit 0, bộ kiểm thử báo "TẤT CẢ KIỂM THỬ ĐẠT" |
| Build | `npm run build` | ĐẠT — exit 0 |

Hai ghi chú để người đọc sau không hiểu nhầm là cổng đã hỏng:

- Cổng test in ra một số dòng cảnh báo `⚠` (thứ tự số hiệu migration, các dòng kết hợp
  logistics + tiền cần xem xét) và log của `vtp-registry` về trạng thái Viettel Post chưa dịch
  được. Đây là cảnh báo, không làm lệnh thất bại.
- Cổng build kết thúc với "Compiled with warnings": thư viện `jose` dùng `CompressionStream` /
  `DecompressionStream` vốn không được Edge Runtime hỗ trợ. Cũng là cảnh báo, không phải lỗi.

Các cảnh báo này có sẵn ở base SHA và không liên quan tới thay đổi của lượt chạy này — lượt chạy
chỉ thêm một tệp Markdown trong `docs/`.

## Những việc vai DOCUMENTATION KHÔNG được làm

- Không sửa mã nguồn. Phạm vi ghi chỉ là `docs/`.
- Không sửa tệp nào ngoài đúng một tệp đã nêu ở phần Phạm vi.
- Không tạo commit. Việc commit do runner thực hiện sau khi agent kết thúc.
- Không merge nhánh, không mở hay đóng PR thay người.
- Không deploy, không chạm vào môi trường chạy thật.
- Không chạy lệnh ngoài danh sách cho phép, và không tìm cách lách khi một lệnh bị chặn — gặp
  lệnh bị chặn thì báo lại, không thử đường vòng.
- Không viết ra điều không đọc được từ mã nguồn hoặc từ kết quả lệnh thật. Chưa biết thì ghi là
  chưa biết.

## Ranh giới quyền

Agent không merge, không deploy
