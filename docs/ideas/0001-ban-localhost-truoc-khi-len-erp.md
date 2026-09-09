# 0001. Bản test trên máy (localhost) trước, đưa lên ERP sau

- **Người đề xuất / ngày:** Chủ shop · 09/09/2026
- **Trạng thái:** Đã làm — `npm run local` (mã: `scripts/local-test.ts`, `lib/local-mode.ts`,
  `components/local-test-banner.tsx`, kiểm thử: `tests/local-mode.test.ts`)

## Vấn đề đang gặp

Mọi thay đổi hiện đi thẳng lên ERP thật ở https://erp.vnxcommerce.com. Chỗ đó là nơi nhân viên
đang chốt đơn, kế toán đang đối soát COD và chủ shop đang đọc số để quyết định. Ba hệ quả:

1. **Sai một lần là sai trên dữ liệu thật.** Một báo cáo tính nhầm không chỉ hiện sai — nó hiện sai
   cho người đang dùng nó để quyết định, và không ai biết nó sai cho tới khi đối chiếu.
2. **Không xem trước được.** Chủ shop chỉ nhìn thấy tính năng mới sau khi nó đã lên máy chủ thật;
   muốn sửa một chi tiết nhỏ thì phải chạy lại cả vòng đẩy mã và triển khai.
3. **Thử nghiệm nào cũng có giá.** Muốn thử nhập một bảng kê, một sao kê, một đợt đồng bộ — dữ liệu
   thử nằm lẫn trong dữ liệu thật, dọn ra rất mất công.

## Ý tưởng

Mỗi thay đổi được dựng và xem tận mắt trên **một bản ERP riêng chạy ở máy cá nhân** với dữ liệu
giả, tích hợp tắt hẳn. Ưng rồi mới qua cổng kiểm tra và đưa lên ERP thật.

Bản test phải thoả ba điều, nếu không thì nó còn nguy hiểm hơn là không có:

- **Không chạm vào dữ liệu thật.** Không nối tới CSDL của máy chủ, không nối tới CSDL nào ngoài máy
  mình. Lệnh dựng bản test có xoá và gieo lại dữ liệu.
- **Không gọi ra ngoài.** Không kéo đơn Pancake thật, không gọi Viettel Post, không đẩy webhook,
  không nhắn Lark/Telegram. Bản test chạy sai thì cũng chỉ sai trong máy.
- **Nhìn là biết đây là bản test.** Giao diện giống hệt ERP thật, nên nếu không có nhãn thì sớm muộn
  cũng có người đọc số của bản test rồi tưởng là số thật.

## Cách làm

```bash
npm install
npm run local          # chuẩn bị + mở http://localhost:3000
npm run local:setup    # chỉ chuẩn bị (không mở giao diện)
npm run local:reset    # xoá sạch dữ liệu thử, gieo lại từ đầu
```

`npm run local:setup` (`scripts/local-test.ts`) làm bốn việc:

1. Tạo/bổ sung `.env.local` — chỉ thêm khoá còn thiếu, **không đè** giá trị đã có (ai đó điền token
   thật để thử một tích hợp thì lần chạy sau không mất công đó). Khoá phiên sinh ngẫu nhiên.
2. Kiểm tra cổng chặn CSDL: chỉ đi tiếp khi `DATABASE_URL` nằm trên máy mình
   (`lib/local-mode.ts::guardLocalDatabase`).
3. Chạy migration + tạo tài khoản quản trị (`scripts/seed-admin.ts`).
4. Gieo dữ liệu mẫu (`scripts/seed-demo.ts`): ~1.100 đơn, 71 mẫu mã, vận đơn, chi phí, quảng cáo.

Đăng nhập mặc định: `admin@shop.local` / `Admin@12345`.

## Ranh giới an toàn

| Ranh giới | Được giữ bằng |
|---|---|
| CSDL riêng, tách khỏi cả `data/pglite` của lần chạy thử thông thường | `DATABASE_URL="pglite://./data/pglite-local"` do chính lệnh đặt |
| Không xoá/gieo nhầm lên CSDL thật | `guardLocalDatabase` — địa chỉ ngoài máy mình thì dừng; đọc không ra địa chỉ cũng dừng. Tên dịch vụ Docker của máy chủ thật (`db`) **không** được coi là máy mình |
| Không gọi API ngoài | Khoá Pancake / Viettel Post / Facebook để trống trong `.env.local`; `lib/env.ts` coi chuỗi rỗng là chưa cấu hình |
| Không đọc nhầm số của bản test | Cờ `ERP_LOCAL_TEST=1` bật dải cảnh báo trên mọi trang và ở màn đăng nhập. Cờ chỉ do lệnh này ghi ra, **không** suy từ địa chỉ CSDL — máy chủ thật cũng nối CSDL nội bộ, suy kiểu đó thì ERP thật sẽ đeo nhãn "bản test" |
| Cấu hình bản test không lọt vào kho mã | `.env.local` nằm trong `.gitignore`; `tests/local-mode.test.ts` kiểm lại điều đó |

## Quy trình sau khi có bản test

1. Sửa mã trong cây làm việc riêng của phiên (`AGENTS.md` §9).
2. `npm run local` → xem tận mắt trên http://localhost:3000, thử đúng thao tác mà người dùng sẽ làm.
3. Cổng kiểm tra: `npm run typecheck && npm run lint && npm test && npm run build`.
4. Đẩy lên nhánh phát triển và `main`.
5. Triển khai bằng workflow **Deploy ERP to VPS**, rồi xác nhận run thành công.

Bước 2 là bước mới; nó không thay thế bước 3 — bản test trả lời câu "thứ này có đúng ý không",
cổng kiểm tra trả lời câu "thứ này có làm hỏng cái khác không".

## Việc còn lại

- Dữ liệu mẫu chưa phủ vài kịch bản nhập liệu: bảng kê Viettel Post, sao kê ngân hàng, đơn landing.
  Muốn thử các luồng đó trên bản test thì phải tự nhập tệp mẫu — có thể gieo sẵn sau này.
- PGlite chỉ cho **một** tiến trình mở thư mục dữ liệu: dừng giao diện (Ctrl+C) trước khi chạy lệnh
  CLI trên cùng CSDL, hoặc chuyển bản test sang PostgreSQL cục bộ (`docker compose up -d db`).
