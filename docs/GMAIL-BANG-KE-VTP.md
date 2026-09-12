# Tự động lấy bảng kê COD Viettel Post từ Gmail

Viettel Post tự gửi thư **"BẢNG KÊ ĐỐI SOÁT THANH TOÁN"** kèm tệp `BangKeChiCOD….xlsx` về hộp thư của shop. Trước đây phải tải tay rồi tải lên ERP nên bảng kê hay bị nhập trễ hoặc bỏ sót — mà thiếu bảng kê thì không biết tiền COD nào đã thực về tài khoản.

Đoạn script dưới đây chạy **trong chính Gmail của shop**, mỗi 15 phút tìm thư mới của Viettel Post, lấy tệp đính kèm và gửi sang ERP. ERP xử lý y hệt như khi bạn tải tay lên trang **Nhập dữ liệu Viettel Post**.

**ERP không giữ mật khẩu hộp thư.** Script chạy dưới tài khoản Google của bạn, xoá hoặc tắt lúc nào cũng được. Không cần Google Cloud project, không cần API key.

## Cài đặt (làm một lần, khoảng 5 phút)

1. Vào <https://script.google.com> → **Dự án mới**.
2. Xoá hết code mẫu, dán toàn bộ đoạn dưới đây.
3. Sửa hai dòng đầu: `ERP_URL` là địa chỉ ERP của shop, `SECRET` là **tham số bí mật webhook Viettel Post** (xem tại ERP → **Kết nối dữ liệu**; đổi được bằng ops `rotate-webhook-secrets`).
4. Bấm **Lưu**, chọn hàm `chayThuMotLan` rồi bấm **Chạy** → Google hỏi quyền, chọn tài khoản, **Nâng cao → Chuyển tới…(không an toàn)** → **Cho phép**. (Cảnh báo này là vì script do bạn tự viết, chưa được Google xét duyệt — bình thường.)
5. Xem kết quả ở **Nhật ký thực thi**. Vào ERP → **Kết nối dữ liệu** phải thấy lần chạy `vtp-statement-mail`.
6. Bấm biểu tượng **đồng hồ (Trình kích hoạt)** → **Thêm trình kích hoạt** → hàm `dongBoBangKeVTP`, nguồn **Theo thời gian**, **Hẹn giờ theo phút**, **15 phút một lần** → Lưu.

Lần chạy đầu quét **toàn bộ** thư Viettel Post trong hộp (kể cả thư cũ) nên lấp luôn phần bảng kê lịch sử còn thiếu. Những lần sau chỉ lấy thư chưa có nhãn `ERP-da-nhap`.

**Nếu thư đã bị gắn nhãn `ERP-da-nhap` mà ERP chưa nhập được** (xảy ra khi bộ đọc chưa hỗ trợ bố cục tệp): vào Gmail, tìm `label:ERP-da-nhap`, chọn tất cả rồi **gỡ nhãn** — chu kỳ kế tiếp sẽ gửi lại toàn bộ. Từ nay ERP trả HTTP 422 khi không nhập được tệp nào nên script sẽ tự giữ lại thư để thử lần sau.

Gửi lại cùng một tệp **không** làm số liệu nhân đôi, và gửi lại theo thứ tự nào cũng ra đúng một kết quả: mỗi dòng của mỗi tệp được ghi vào **sổ chứng từ** `cod_statement_lines` (một dòng cho mỗi cặp *tệp × mã vận đơn*), còn số tiền trên vận đơn chỉ là kết quả dựng lại từ sổ.

> **Vì sao có sổ này.** Trước đây mỗi tệp ghi thẳng lên vận đơn nên tệp nhập sau đè mất tệp nhập trước. Một vận đơn có mặt ở nhiều bảng kê (chiều đi có tiền, chiều hoàn chỉ có cước) mà script lại xử lý từ thư mới về thư cũ, nên bảng kê cũ xoá mất tiền của bảng kê mới: 334 vận đơn giao thành công bị đưa tiền về 0 và 79.774.116đ biến mất khỏi đối soát. Quy tắc dựng lại: ưu tiên dòng **có tiền**, trong đó lấy dòng có mốc chứng từ **muộn nhất**; dòng chỉ có cước không được hạ số đã có về 0.

Cần chạy lại toàn bộ (ví dụ sau khi nâng cấp cách đọc tệp): Gmail → tìm `label:ERP-da-nhap` → chọn tất cả → **gỡ nhãn**. Chu kỳ 15 phút kế tiếp sẽ gửi lại mọi bảng kê và ERP dựng lại tiền từ đầu.

## Đoạn script

```javascript
const ERP_URL = 'https://erp.vnxcommerce.com';   // đổi nếu ERP chạy ở địa chỉ khác
const SECRET  = 'DAN_THAM_SO_BI_MAT_WEBHOOK_VTP'; // ERP → Kết nối dữ liệu

const NHAN = 'ERP-da-nhap';           // thư đã gửi sang ERP được gắn nhãn này
const TIM  = 'from:viettelpost has:attachment';

/** Chạy tay một lần để kiểm tra trước khi hẹn giờ. */
function chayThuMotLan() { dongBoBangKeVTP(); }

function dongBoBangKeVTP() {
  const nhan = GmailApp.getUserLabelByName(NHAN) || GmailApp.createLabel(NHAN);
  const threads = GmailApp.search(TIM + ' -label:' + NHAN, 0, 20);
  // NHỊP TIM: lượt không có thư mới vẫn báo sang ERP. Nếu không, những ngày Viettel Post không gửi
  // bảng kê nào thì ERP im re — và "script đã tắt" trông y hệt "chưa có bảng kê".
  if (!threads.length) { baoSong(); Logger.log('Không có thư mới.'); return; }

  for (const thread of threads) {
    const files = [];
    for (const msg of thread.getMessages()) {
      for (const att of msg.getAttachments()) {
        const ten = att.getName();
        if (!/\.(xlsx|xls|csv)$/i.test(ten)) continue;   // bỏ qua PDF hoá đơn, ảnh chữ ký…
        if (att.getSize() > 8 * 1024 * 1024) { Logger.log('Bỏ qua tệp quá lớn: ' + ten); continue; }
        files.push({ filename: ten, base64: Utilities.base64Encode(att.getBytes()) });
      }
    }
    if (!files.length) { thread.addLabel(nhan); continue; }

    const res = UrlFetchApp.fetch(ERP_URL + '/api/webhooks/vtp-statement', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ files: files, source: 'gmail', token: SECRET }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    Logger.log(thread.getFirstMessageSubject() + ' → HTTP ' + code + ' ' + res.getContentText().slice(0, 300));
    // Chỉ gắn nhãn khi ERP nhận thành công; lỗi thì để nguyên để lần chạy sau thử lại.
    if (code === 200) thread.addLabel(nhan);
  }
}

/** Báo cho ERP biết script còn sống dù không có gì để gửi. */
function baoSong() {
  UrlFetchApp.fetch(ERP_URL + '/api/webhooks/vtp-statement', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ files: [], ping: true, source: 'gmail', token: SECRET }),
    muteHttpExceptions: true,
  });
}
```

> **Vì sao có nhịp tim.** Ngày 12/09/2026 trang **Kết nối dữ liệu** báo *"67 giờ không nhận được gì"* trong khi trình kích hoạt bên Gmail vẫn chạy đủ mỗi 15 phút, tỷ lệ lỗi 0,22%. Không ai nói được bên nào đúng: ERP chỉ nhìn thấy những lượt CÓ tệp, nên một script đã chết và một hộp thư chưa có bảng kê mới trông giống hệt nhau. Từ nay mỗi lượt chạy đều báo sang, và trang Kết nối dữ liệu hiện riêng dòng **"Script Gmail lấy bảng kê"**.

Đang dùng script bản cũ (không có `baoSong`) thì mọi thứ vẫn chạy y như trước, chỉ là ERP không biết script còn sống hay không — dòng nhịp tim sẽ ghi *"chưa từng báo sống"*.

## Sự cố thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| `HTTP 401 Sai tham số bí mật` | `SECRET` không khớp; lấy lại ở ERP → Kết nối dữ liệu |
| `HTTP 503 Chưa cấu hình tham số bí mật` | `VIETTELPOST_WEBHOOK_SECRET` trống trong `.env` trên VPS |
| `HTTP 400 Không có tệp nào` | Thư chỉ có PDF hoá đơn, không có `.xlsx` — script tự gắn nhãn bỏ qua |
| Nhịp tim ghi *"chưa từng báo sống"* | Script còn ở bản cũ; dán lại đoạn trên (có hàm `baoSong`) |
| Nhịp tim quá 2 giờ | Trình kích hoạt bị gỡ, hoặc `SECRET` đã đổi nên mọi lượt gửi bị 401 |
| `HTTP 500` | ERP lỗi khi đọc tệp; xem chi tiết ở ERP → Kết nối dữ liệu. Thư **không** bị gắn nhãn nên lần sau tự thử lại |
| Nhập rồi mà đối soát COD chưa đổi | Báo cáo có bộ nhớ đệm 60–120 giây, chờ rồi tải lại trang |

Muốn dừng: xoá trình kích hoạt ở script, hoặc đổi tham số bí mật webhook bằng ops `rotate-webhook-secrets` (ERP sẽ từ chối mọi lần gửi cũ).
