import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════ MỌI TUYẾN TRÊN THANH ĐIỀU HƯỚNG PHẢI ĐƯỢC SMOKE PHỦ ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026, chủ shop báo hai lần trong một ngày). `/ideas` rồi `/bank` hỏng hẳn trên
 * production — trang chỉ hiện "Có lỗi khi tải trang". Cả hai lần lá chắn hiệu năng đều XANH, vì cả
 * hai tuyến đó **không có trong danh sách smoke**. Đo được lúc phát hiện: 11/34 tuyến của thanh
 * điều hướng đang nằm ngoài.
 *
 * Đây là lần thứ TÁM cùng một hình dạng lỗi trong kho mã này: một lá chắn canh whitelist gõ tay
 * thay vì canh cả bề mặt. Bảy lần trước: job không có lịch · phép nối không canh grain · lá chắn
 * chi phí canh sáu tệp · ranh giới ghi canh 15 tệp · khung xương canh 21 tuyến · lớp tăng tốc nối
 * 2/25 tệp · Server Action không nơi gọi.
 *
 * Cách chữa luôn giống nhau: đảo lá chắn lại. Đọc NGUỒN SỰ THẬT (ở đây là thanh điều hướng — thứ
 * quyết định người dùng bấm được vào đâu) rồi bắt buộc mọi mục phải được phủ, hoặc khai miễn trừ
 * KÈM LÝ DO.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/smoke-coverage.test.ts
 */

/**
 * Tuyến CỐ Ý không đưa vào smoke, và vì sao.
 *
 * "Chưa kịp thêm" KHÔNG phải lý do hợp lệ. Mỗi dòng ở đây phải nói được vì sao việc mở tuyến đó
 * trong một lượt kiểm tự động là sai chứ không phải là thiếu.
 */
const MIEN_TRU: Record<string, string> = {};

const goc = path.resolve(__dirname, "..");

export function testSmokeCoverage() {
  const sidebar = fs.readFileSync(path.join(goc, "components/app-sidebar.tsx"), "utf8");
  const smoke = fs.readFileSync(path.join(goc, "scripts/smoke.ts"), "utf8");

  const tuyen = [...new Set([...sidebar.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]))];
  assert.ok(tuyen.length > 25, `đọc hụt thanh điều hướng (chỉ thấy ${tuyen.length} tuyến) — biểu thức dò hỏng?`);

  // Chỉ lấy phần đường dẫn: smoke có thể phủ `/cod?recon=stale`, và như thế là đã phủ `/cod`.
  const daPhu = new Set([...smoke.matchAll(/^\s*"(\/[^"]*)",/gm)].map((m) => m[1].split("?")[0]));
  assert.ok(daPhu.size > 20, `đọc hụt danh sách smoke (chỉ thấy ${daPhu.size} tuyến)`);

  const thieu = tuyen.filter((r) => !daPhu.has(r.split("?")[0]) && !(r in MIEN_TRU));
  assert.deepEqual(
    thieu,
    [],
    `tuyến có trên thanh điều hướng nhưng KHÔNG được smoke mở thử: ${thieu.join(", ")}\n` +
      "Người dùng bấm vào được thì lá chắn phải mở được. Thêm vào ROUTES của scripts/smoke.ts, " +
      "hoặc khai vào MIEN_TRU kèm lý do vì sao KHÔNG nên kiểm tự động.",
  );

  const thuaKhai = Object.keys(MIEN_TRU).filter((r) => !tuyen.includes(r));
  assert.deepEqual(thuaKhai, [], `MIEN_TRU còn khai tuyến đã bị xoá khỏi thanh điều hướng: ${thuaKhai.join(", ")}`);
  for (const [r, ly] of Object.entries(MIEN_TRU)) assert.ok(ly.length > 25, `MIEN_TRU["${r}"] phải nói VÌ SAO, một dòng lý do thật`);

  /*
    TRANG LỖI CŨNG TRẢ HTTP 200.

    Ranh giới lỗi của Next dựng ra một trang hoàn chỉnh, có đủ khung ứng dụng, và trả 200 — nên
    `/operations` từng hỏng hẳn mà smoke vẫn báo "SUCCESS 121kB (102ms)" hai lần deploy liên tiếp.
    Đo mã HTTP và kích thước là chưa đủ.
  */
  assert.match(smoke, /ERROR_MARKER/, "smoke phải nhận ra TRANG LỖI — trang lỗi cũng trả HTTP 200 và có đủ khung ứng dụng");
  const errorTsx = fs.readFileSync(path.join(goc, "app/(dashboard)/error.tsx"), "utf8");
  const nhan = /const ERROR_MARKER = "([^"]+)"/.exec(smoke)?.[1] ?? "";
  assert.ok(nhan.length > 5, "ERROR_MARKER phải là một chuỗi thật");
  assert.ok(
    errorTsx.includes(nhan),
    `ERROR_MARKER ("${nhan}") không còn xuất hiện trong app/(dashboard)/error.tsx — đổi chữ ở trang lỗi mà quên đổi ở đây thì lá chắn im lặng mù trở lại`,
  );

  console.log(
    `✓ Lá chắn smoke phủ tuyến: ${tuyen.length} tuyến trên thanh điều hướng · ${daPhu.size} tuyến trong smoke · ${Object.keys(MIEN_TRU).length} miễn trừ có lý do · 0 tuyến bỏ sót · nhận ra được trang lỗi trả HTTP 200`,
  );
}

if (process.argv[1] && /smoke-coverage\.test\.ts$/.test(process.argv[1])) {
  testSmokeCoverage();
}
