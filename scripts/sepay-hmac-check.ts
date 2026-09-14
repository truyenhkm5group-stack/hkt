/**
 * Kiểm chứng xác thực HMAC của webhook SePay trên máy chủ THẬT — mà KHÔNG ghi một đồng tiền giả nào.
 *
 * ─── VÌ SAO GÓI TIN THỬ CỐ Ý SAI ĐỊNH DẠNG ───
 *
 * Gói tin thiếu `transferType`. Route xác thực chữ ký TRƯỚC rồi mới đọc nội dung, nên:
 *   · chữ ký ĐÚNG → qua được cửa, rồi bị từ chối vì sai định dạng  ⇒ HTTP 400
 *   · chữ ký SAI  → bị chặn ngay ở cửa                              ⇒ HTTP 401
 *
 * Hai mã khác nhau chứng minh HMAC chạy đúng, mà `bank_transactions` không có thêm dòng nào.
 * Dùng một gói tin HỢP LỆ để "thử cho giống thật" sẽ tạo một giao dịch ma chảy thẳng vào báo cáo
 * dòng tiền — đừng sửa lại thành thế.
 *
 * ─── VÌ SAO CHẠY TRONG CONTAINER ───
 *
 * Cổng 3000 KHÔNG mở ra host trên production (Caddy đi qua mạng docker), nên gọi từ máy chủ vào
 * `127.0.0.1:3000` luôn "Connection refused". Chạy trong container cũng là cách secret không bao
 * giờ phải đi qua dòng lệnh: nó đã nằm sẵn trong môi trường của tiến trình.
 *
 * Dùng: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/sepay-hmac-check.ts
 */
import { createHmac } from "node:crypto";

const BASE = process.env.ERP_INTERNAL_URL || "http://127.0.0.1:3000";
const URL_WEBHOOK = `${BASE}/api/webhooks/sepay`;
const secret = process.env.SEPAY_WEBHOOK_SECRET ?? "";

/** Gói tin CỐ Ý thiếu `transferType` — xem đầu tệp. */
const BODY = JSON.stringify({
  id: "ops-hmac-check",
  gateway: "OPSCHECK",
  transactionDate: "2026-01-01 00:00:00",
  accountNumber: "0",
  transferAmount: 1,
});

async function post(signature: string, timestamp: string) {
  const res = await fetch(URL_WEBHOOK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sepay-signature": signature,
      "x-sepay-timestamp": timestamp,
    },
    body: BODY,
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

async function main() {
  if (!secret) {
    console.error("SEPAY_WEBHOOK_SECRET chưa có trong môi trường container — .env chưa nhận secret, hoặc app chưa khởi động lại.");
    process.exit(1);
  }
  // In ĐỘ DÀI, không bao giờ in giá trị.
  console.log(`SEPAY_WEBHOOK_SECRET trong container: có (${secret.length} ký tự)`);

  const ts = String(Math.floor(Date.now() / 1000));
  const good = `sha256=${createHmac("sha256", secret).update(`${ts}.${BODY}`).digest("hex")}`;
  const bad = `sha256=${"0".repeat(64)}`;

  const ok = await post(good, ts);
  const wrong = await post(bad, ts);
  console.log(`chữ ký ĐÚNG → HTTP ${ok.status} · ${ok.body}`);
  console.log(`chữ ký SAI  → HTTP ${wrong.status} · ${wrong.body}`);

  if (ok.status === 400 && wrong.status === 401) {
    console.log("✓ HMAC hoạt động đúng: chữ ký hợp lệ qua được xác thực (400 = sai định dạng có chủ đích), chữ ký sai bị chặn (401).");
    console.log("  Sổ ngân hàng KHÔNG có thêm dòng nào — gói tin thử bị từ chối trước khi tới bước ghi.");
    process.exit(0);
  }

  console.error(`✗ Không như kỳ vọng — chữ ký đúng=${ok.status} (mong 400), chữ ký sai=${wrong.status} (mong 401).`);
  if (ok.status === 401 && wrong.status === 401) {
    console.error("  401 ở cả hai: secret trong container KHÁC secret dùng để ký. Kiểm tra Secret trên GitHub và chạy lại apply-sepay-env.");
  }
  if (wrong.status === 200) {
    console.error("  200 ở chữ ký SAI: xác thực KHÔNG chạy. Gỡ webhook khỏi SePay ngay cho tới khi sửa xong — endpoint đang nhận của bất kỳ ai.");
  }
  process.exit(1);
}

void main();
