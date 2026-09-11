import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearMemo, memo, staleMemo } from "@/lib/cache";
import { subscribe } from "@/lib/realtime/bus";

/**
 * ═══════ JOB NỀN VÀ WEBHOOK KHÔNG ĐƯỢC XOÁ HẲN BỘ ĐỆM ═══════
 *
 * SỰ CỐ THẬT (10–11/09/2026). Bản vá "trả số cũ ngay, làm mới phía sau" (`staleMemo`) chỉ được nối
 * vào `audit()`. Ba đường khác vẫn gọi `clearMemo()` — xoá sạch — sau MỌI lượt chạy: bộ chạy job
 * (đơn 3 phút, vận đơn 10 phút, cảnh báo 10 phút), job landing chạy MỖI PHÚT kể cả khi 0 dòng mới,
 * và webhook Pancake sau mọi gói tin kể cả gói lặp. Job giữ ấm 4 phút một lần không bao giờ thắng,
 * và perf-probe production 11/09 vẫn đo lượt nguội: 3,3s bảng điều khiển + 3,8s tóm tắt + 3,0s sự
 * thật tài chính, ba lượt chen nhau trên 2 nhân.
 *
 * Bài kiểm này canh ở mức MÃ NGUỒN: đường nền chỉ được `staleMemo`, còn `clearMemo` dành cho thao
 * tác NGƯỜI bấm (server action) — người vừa chủ động đổi dữ liệu thì chấp nhận chờ số mới.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/cache-semantics.test.ts
 */
const DUONG_NEN = [
  "lib/sync/runner.ts",
  "lib/landing/sheet.ts",
  "lib/integrations/facebook/ads-index.ts",
  "app/api/webhooks/pancake/[secret]/[[...event]]/route.ts",
  "app/api/webhooks/viettelpost/route.ts",
  "app/api/webhooks/vtp-statement/route.ts",
];

export async function testCacheSemantics() {
  for (const f of DUONG_NEN) {
    const src = readFileSync(f, "utf8");
    assert.equal(/\bclearMemo\s*\(/.test(src), false, `${f}: đường nền gọi clearMemo() — xoá hẳn đệm khiến người mở trang trả giá lượt tính nguội. Dùng staleMemo().`);
  }

  // ───────── Đánh dấu cũ ⇒ người đọc nhận NGAY số cũ, lượt làm mới chạy phía sau ─────────
  clearMemo();
  let lan = 0;
  const tinh = async () => {
    lan += 1;
    return lan;
  };
  assert.equal(await memo("nen", 60_000, tinh), 1);
  staleMemo();
  const started = performance.now();
  const cu = await memo("nen", 60_000, async () => {
    await new Promise((r) => setTimeout(r, 40));
    return tinh();
  });
  assert.equal(cu, 1, "sau staleMemo, người đọc phải nhận số cũ ngay");
  assert.ok(performance.now() - started < 30, "không được bắt người đọc chờ lượt tính lại");

  // ───────── Lượt làm mới xong và giá trị ĐỔI ⇒ phát sự kiện để trang tự kéo số mới ─────────
  const nhan: string[] = [];
  const stop = subscribe((e) => {
    if (e.type === "sync" && e.source === "CACHE") nhan.push(e.job);
  });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(nhan.some((j) => j.startsWith("memo:")), "giá trị đổi (1 → 2) mà không phát sự kiện thì người xem giữ số cũ tới khi có chuyện khác xảy ra");
    assert.equal(await memo("nen", 60_000, tinh), 2, "lượt kế tiếp phải trúng số mới");

    // Giá trị KHÔNG đổi ⇒ không phát: tránh vòng làm mới vô ích.
    nhan.length = 0;
    staleMemo();
    await memo("nen", 60_000, async () => 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(nhan.length, 0, "giá trị y hệt mà vẫn phát sự kiện là bắt mọi trình duyệt dựng lại trang vô ích");
  } finally {
    stop();
    clearMemo();
  }

  console.log(`✓ Ngữ nghĩa đệm: ${DUONG_NEN.length} đường nền chỉ đánh dấu cũ · người đọc nhận số cũ ngay · giá trị đổi mới phát sự kiện, không đổi thì im`);
}

if (process.argv[1] && /cache-semantics\.test\.ts$/.test(process.argv[1])) {
  void testCacheSemantics();
}
