import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ═══════════ LỊCH THEO ĐỒNG HỒ — DEPLOY DÀY KHÔNG CÒN NUỐT JOB ═══════════
 *
 * Sự cố 28/09/2026: `care-return-check` (30 phút, offset 27) có lịch mà `sync_runs` rỗng sau 50 phút —
 * deploy xong lúc 09:23 · 09:43 · 10:09 UTC, mỗi lần khởi động lại bộ lập lịch trước phút 27. Bài này
 * mô phỏng đúng ngày ấy (deploy 20 phút/lần suốt 24 giờ) và đòi đủ 48 lượt, nơi cách cũ cho 0.
 *
 * Mốc thời gian trong bài là số mili-giây CỐ ĐỊNH truyền vào hàm thuần — không đọc đồng hồ (luật 50).
 */
type ClockModule = { nextRunAt: (nowMs: number, everyMin: number, offsetMin?: number) => number; delayUntilNext: (nowMs: number, everyMin: number, offsetMin?: number) => number };

const goc = path.resolve(__dirname, "..");
const PHUT = 60_000;
const NGAY_GOC = Date.UTC(2026, 8, 28, 0, 0, 0); // 28/09/2026 00:00 UTC — chỉ là một mốc chia hết cho 30 phút

export async function testSchedulerClock() {
  const { nextRunAt, delayUntilNext } = (await import(pathToFileURL(path.join(goc, "scripts/scheduler-clock.mjs")).href)) as ClockModule;

  // ───────── 1. Mốc cố định trên đồng hồ ─────────
  assert.equal(nextRunAt(NGAY_GOC, 30, 27), NGAY_GOC + 27 * PHUT, "30 phút offset 27 ⇒ phút :27");
  assert.equal(nextRunAt(NGAY_GOC + 27 * PHUT, 30, 27), NGAY_GOC + 57 * PHUT, "đúng TẠI một mốc ⇒ mốc SAU (không hẹn lại chính nó)");
  assert.equal(nextRunAt(NGAY_GOC + 27 * PHUT - 1, 30, 27), NGAY_GOC + 27 * PHUT, "trước mốc 1 ms ⇒ chính mốc ấy");
  assert.equal(nextRunAt(NGAY_GOC + 5 * PHUT, 15, 26), NGAY_GOC + 11 * PHUT, "offset lớn hơn chu kỳ được quy về [0, chu kỳ): 26 mod 15 = 11");
  assert.equal(nextRunAt(NGAY_GOC + 12_000, 3, 0.2), NGAY_GOC + 3 * PHUT + 12_000, "offset lẻ phút (0,2 = 12 giây) giữ nguyên");
  assert.equal(delayUntilNext(NGAY_GOC + 20 * PHUT, 30, 27), 7 * PHUT);
  assert.throws(() => nextRunAt(NGAY_GOC, 0, 1), /chu kỳ không hợp lệ/);

  // ───────── 2. Không phụ thuộc lúc khởi động ─────────
  const chuoi = (batDau: number, n: number, every: number, offset: number) => {
    const out: number[] = [];
    let t = nextRunAt(batDau, every, offset);
    for (let i = 0; i < n; i += 1) {
      out.push(t);
      t = nextRunAt(t, every, offset);
    }
    return out;
  };
  const a = chuoi(NGAY_GOC + 3 * PHUT, 6, 30, 27);
  const b = chuoi(NGAY_GOC + 19 * PHUT + 4321, 6, 30, 27);
  assert.deepEqual(a, b, "khởi động lúc nào cũng rơi vào CÙNG các mốc");
  assert.ok(a.every((t) => (t - NGAY_GOC) % (30 * PHUT) === 27 * PHUT));

  // ───────── 3. Ngày deploy dày: khởi động lại 20 phút/lần suốt 24 giờ ─────────
  const khoiDong = Array.from({ length: 72 }, (_, i) => NGAY_GOC + i * 20 * PHUT);
  const dem = (cachTinh: "cu" | "moi") => {
    let n = 0;
    khoiDong.forEach((r, i) => {
      const het = khoiDong[i + 1] ?? NGAY_GOC + 24 * 60 * PHUT;
      if (cachTinh === "cu") {
        // Cách cũ: lượt đầu ở r + offset, rồi mỗi 30 phút — nhưng bị cắt khi khởi động lại.
        for (let t = r + 27 * PHUT; t < het; t += 30 * PHUT) n += 1;
      } else {
        for (let t = nextRunAt(r, 30, 27); t < het; t = nextRunAt(t, 30, 27)) n += 1;
      }
    });
    return n;
  };
  assert.equal(dem("cu"), 0, "cách cũ: offset 27 > 20 phút giữa hai lần deploy ⇒ 0 lượt (đúng sự cố 28/09)");
  assert.equal(dem("moi"), 48, "theo đồng hồ: đủ 48 lượt / 24 giờ dù khởi động lại 72 lần");

  // ───────── 4. Bộ lập lịch thật sự dùng hàm này ─────────
  const src = readFileSync(path.join(goc, "scripts/scheduler.mjs"), "utf8");
  assert.match(src, /import \{ nextRunAt \} from "\.\/scheduler-clock\.mjs";/, "bộ lập lịch nhập hàm tính mốc");
  assert.match(src, /hen\(nextRunAt\(Date\.now\(\), item\.every, item\.offset\)\)/, "lượt đầu theo đồng hồ");
  assert.match(src, /hen\(nextRunAt\(Math\.max\(Date\.now\(\), moc\), item\.every, item\.offset\)\)/, "lượt kế tính từ MỐC vừa nhắm");
  assert.ok(!/setInterval\(\(\) => trigger\(item\.job/.test(src), "không còn setInterval tính từ lúc khởi động");

  console.log("✓ Lịch theo đồng hồ: mốc cố định (:27/:57), không phụ thuộc lúc khởi động · deploy 20 phút/lần suốt 24 giờ: cũ 0 lượt, mới 48");
}
