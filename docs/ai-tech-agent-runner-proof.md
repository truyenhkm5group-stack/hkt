# Kiểm chứng runner Phòng Tech AI — lượt chạy đầu tiên (Phase 2A)

## Vì sao có trang này

Trước khi cho agent chạy trên việc thật, cần một lượt chạy có thể kiểm chứng lại được:
ai chạy, chạy trên nhánh nào, được phép sửa gì, và bốn cổng chất lượng ra kết quả gì.
Trang này là bản ghi của lượt chạy đó. Mục đích duy nhất là làm bằng chứng vận hành,
không phải hướng dẫn sử dụng.

## Thông tin lượt chạy

| Hạng mục | Giá trị |
| --- | --- |
| Mã việc | TECH-1 — Kiểm chứng DOCUMENTATION agent Phase 2A |
| Vai agent đã chạy | DOCUMENTATION |
| Base SHA | **Chưa xác minh được từ trong phiên chạy** — xem mục "Những chỗ chưa biết" |
| Nhánh agent làm việc | **Chưa xác minh được từ trong phiên chạy** — cây làm việc được runner dựng sẵn trên một nhánh riêng, tách khỏi nhánh chính |
| Phạm vi ghi được | thư mục `docs/` |
| Phạm vi thực tế của lượt chạy | đúng một tệp: `docs/ai-tech-agent-runner-proof.md` |

Phạm vi một tệp là điều kiện của lượt chạy này, không phải tình cờ: nếu agent sửa
đúng một tệp mà bốn cổng vẫn xanh, thì phần diff do agent tạo ra dễ soát bằng mắt
và dễ hoàn tác.

## Kết quả bốn cổng

Chạy trong chính phiên làm việc này, ghi lại nguyên trạng:

| Cổng | Lệnh | Kết quả |
| --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit`) | đạt, exit code 0 |
| lint | `npm run lint` (`eslint`) | đạt, exit code 0, không có cảnh báo |
| test | `npm run test` | **không chạy được** — lệnh bị danh sách cho phép của agent chặn |
| build | `npm run build` (Next.js) | đạt, exit code 0, biên dịch có cảnh báo |

Ghi chú về hai cổng không hoàn toàn sạch:

- **test**: runner chặn `npm run test` đối với vai tài liệu. Theo luật, agent không tìm
  đường lách; cổng này phải do runner hoặc CI chạy, không có kết quả từ phía agent.
- **build**: build thành công nhưng in cảnh báo từ `node_modules/jose`
  (`CompressionStream`, `DecompressionStream` — API Node.js không được Edge Runtime hỗ trợ),
  đi theo đường import `jose/webapi` → `jwt/encrypt` → `jwe_encrypt` → `deflate.js`.
  Cảnh báo đến từ thư viện phụ thuộc, không phải từ thay đổi của lượt chạy này —
  lượt chạy này không chạm vào mã nguồn nào.

## Những việc vai tài liệu KHÔNG được làm

- Không sửa mã nguồn; chỉ ghi trong `docs/`.
- Không sửa tệp nào ngoài tệp duy nhất thuộc phạm vi việc.
- Không commit — việc commit do runner làm sau khi agent xong.
- Không merge.
- Không deploy.
- Không đọc vùng bí mật, dữ liệu kho git hay thư viện (các lối đọc này bị chặn cứng).
- Không chạy lệnh ngoài danh sách cho phép, và không tìm cách khác để lách khi bị chặn.
- Không bịa số liệu, tên hàm, SHA hay tên nhánh. Chưa biết thì ghi là chưa biết.

Agent không merge, không deploy

## Những chỗ chưa biết

Base SHA và tên nhánh **không** được ghi vào trang này vì trong phiên chạy agent không
có cách hợp lệ để đọc chúng:

- các lệnh `git rev-parse HEAD` và `git rev-parse --abbrev-ref HEAD` đều bị danh sách
  cho phép chặn;
- đọc trực tiếp `.git/HEAD` bị chặn vì thuộc vùng dữ liệu kho git không bao giờ đọc.

Hai giá trị này runner có sẵn khi tạo cây làm việc và khi commit. Cách đúng để hoàn thiện
bản ghi là runner điền vào bảng trên lúc commit, hoặc mở cho vai tài liệu một lệnh đọc
SHA/nhánh ở chế độ chỉ đọc. Để trống có chủ đích vẫn tốt hơn là điền một giá trị đoán.
