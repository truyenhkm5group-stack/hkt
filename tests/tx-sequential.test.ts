import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import type { Db } from "@/db";
import { getOperatingCostByDay } from "@/lib/queries/cost-engine";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ TRONG MỘT GIAO DỊCH, CÁC CÂU CHẠY NỐI TIẾP — KHÔNG `Promise.all` TRÊN CLIENT CỦA NÓ ═══════
 *
 * `chayKhongJit` (db/index.ts) mở MỘT giao dịch = MỘT client Postgres, và một client chỉ chạy một câu một
 * lúc. `Promise.all([tx.select…, tx.select…])` bên trong nó không song song gì cả: pg@8 tự xếp hàng các
 * câu trên client đó và in cảnh báo «Calling client.query() when the client is already executing a
 * query is deprecated and will be removed in pg@9.0». Tìm thấy 23/10/2026 qua log perf-probe:
 * reports.ts::orderFacts · payroll.ts::productEconomics · marketing-daily.ts::getMarketingDailyUncached,
 * và tầng hai — cost-engine.ts::getOperatingCostByDay chạy song song trên `db` mà orderFacts truyền `tx`.
 *
 * Hai cái giá: nâng pg@9 là ba báo cáo tiền gãy ngay; và phép đo tính cả thời gian ĐỨNG XẾP HÀNG vào
 * từng câu (câu tra khoá chính trông như mất vài giây).
 *
 * VÌ SAO QUÉT MÃ NGUỒN: trên PGlite `chayKhongJit` gọi thẳng `fn(db)` và KHÔNG mở giao dịch
 * (db/index.ts), nên bộ kiểm thử không bao giờ đi đúng đường này — một bài kiểm động sẽ xanh giả.
 * Bài quét đọc `git show HEAD:` (mã đã vào kho), bắt cả hai tầng:
 *   1. thân giao dịch có `Promise.all` / `allSettled` / `.map(async` dùng chính biến client của nó;
 *   2. hàm được gọi với client giao dịch (ở bất kỳ đối số nào) mà thân nó `Promise.all` trên tham số đó.
 * Miễn trừ phải khai kèm lý do; miễn trừ không còn khớp gì là đỏ.
 */

/** Miễn trừ: "tệp:tên" → lý do (≥ 20 ký tự). Hôm nay rỗng. */
const MIEN_TRU: Record<string, string> = {};

const MO_GIAO_DICH = /(chayKhongJit\(|\.transaction\(\s*async)/g;
const SONG_SONG = /Promise\.(all|allSettled)\(|\.map\(\s*async/g;

function canBang(src: string, i: number, mo = "(", dong = ")"): string {
  const bd = src.indexOf(mo, i);
  if (bd < 0) return "";
  let sau = 0;
  for (let j = bd; j < src.length; j++) {
    if (src[j] === mo) sau++;
    else if (src[j] === dong && --sau === 0) return src.slice(bd, j + 1);
  }
  return src.slice(bd);
}

const thoat = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tên biến client của callback giao dịch: `async (tx) =>`, `(tx) =>`, `async tx =>`. */
function bienClient(than: string): string | null {
  const m = /^\(\s*\w+\s*,\s*(?:async\s*)?\(?\s*(\w+)/.exec(than) ?? /^\(\s*async\s*\(?\s*(\w+)/.exec(than);
  return m?.[1] ?? null;
}

export type ViPham = { tep: string; dong: number; ten: string; vi: string };

/** HÀM THUẦN trên tập tệp `{ đường dẫn: mã nguồn }` — để chính bài kiểm thử được nó bằng mã giả. */
export function timSongSongTrenGiaoDich(tep: Record<string, string>): ViPham[] {
  const ra: ViPham[] = [];
  const goiVoiTx = new Map<string, { noi: string; viTri: number }[]>();
  for (const [f, src] of Object.entries(tep)) {
    for (const m of src.matchAll(MO_GIAO_DICH)) {
      const truoc = src.slice(Math.max(0, m.index - 30), m.index + 15);
      if (/function chayKhongJit/.test(truoc)) continue;
      const than = canBang(src, m.index);
      const tx = bienClient(than);
      if (!tx) continue;
      const dongMo = src.slice(0, m.index).split("\n").length;
      // Tầng 1: song song ngay trong thân, dùng chính client giao dịch.
      for (const p of than.matchAll(SONG_SONG)) {
        const doan = canBang(than, p.index + p[0].length - 1);
        if (new RegExp(`\\b${thoat(tx)}\\b`).test(doan)) {
          ra.push({ tep: f, dong: dongMo + than.slice(0, p.index).split("\n").length - 1, ten: "(thân giao dịch)", vi: `${p[0].replace("(", "")} trên «${tx}»` });
        }
      }
      // Ghi lại mọi lời gọi có client giao dịch ở một đối số — cho tầng 2.
      for (const c of than.matchAll(/\b([A-Za-z_]\w*)\(/g)) {
        const doiSo = canBang(than, c.index + c[0].length - 1).slice(1, -1);
        const cac = doiSo.split(/,(?![^()]*\))/).map((x) => x.trim());
        const vt = cac.indexOf(tx);
        if (vt >= 0) goiVoiTx.set(c[1], [...(goiVoiTx.get(c[1]) ?? []), { noi: `${f}:${dongMo}`, viTri: vt }]);
      }
    }
  }
  // Tầng 2: hàm nhận client giao dịch mà thân nó chạy song song trên tham số đó (hoặc biến gán từ nó).
  for (const [ten, noiGoi] of goiVoiTx) {
    for (const [f, src] of Object.entries(tep)) {
      for (const d of src.matchAll(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${thoat(ten)}\\s*(?:<[^>]*>)?\\(`, "g"))) {
        const thamSo = canBang(src, d.index + d[0].length - 1);
        const ten_ = thamSo.slice(1, -1).split(/,(?![^<>()]*[>)])/).map((p) => p.trim().split(/[:=?]/)[0].trim());
        const than = canBang(src, d.index + d[0].length - 1 + thamSo.length, "{", "}");
        for (const { noi, viTri } of noiGoi) {
          const pn = ten_[viTri];
          if (!pn) continue;
          const bi = new Set([pn, ...[...than.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*${thoat(pn)}\\b`, "g"))].map((a) => a[1])]);
          for (const p of than.matchAll(/Promise\.(all|allSettled)\(/g)) {
            const doan = canBang(than, p.index + p[0].length - 1);
            if ([...bi].some((x) => new RegExp(`\\b${thoat(x)}\\s*\\.(select|execute|insert|update|delete|query)\\b`).test(doan))) {
              ra.push({ tep: f, dong: src.slice(0, d.index).split("\n").length + than.slice(0, p.index).split("\n").length - 1, ten, vi: `Promise.all trên tham số «${pn}» — được gọi với client giao dịch tại ${noi}` });
              break;
            }
          }
        }
      }
    }
  }
  return ra;
}

/**
 * Mã ĐÃ VÀO KHO (HEAD), đọc bằng MỘT tiến trình `git cat-file --batch` — không phải một `git show` cho
 * mỗi tệp (2.4xx tệp × một tiến trình là gần hai phút mỗi lượt chạy). Tệp chưa vào kho trả `missing`
 * và bị bỏ qua: repo-integrity đã chặn việc commit mã import thứ chưa vào kho.
 */
function tepDaVaoKho(): Record<string, string> {
  const ds = execSync("git ls-files lib app scripts", { encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f));
  const buf = execSync("git cat-file --batch", { input: ds.map((f) => `HEAD:${f}`).join("\n") + "\n", maxBuffer: 512 * 1024 * 1024 });
  const ra: Record<string, string> = {};
  let i = 0;
  for (const f of ds) {
    const eol = buf.indexOf(0x0a, i);
    if (eol < 0) break;
    const dau = buf.subarray(i, eol).toString("utf8");
    i = eol + 1;
    const m = /^\S+ blob (\d+)$/.exec(dau);
    if (!m) continue; // "<tên> missing" — không có nội dung đi kèm
    const n = Number(m[1]);
    ra[f] = buf.subarray(i, i + n).toString("utf8");
    i += n + 1;
  }
  return ra;
}

export async function testTxSequential(db: Db) {
  // ───────── Đột biến DỰNG SẴN: máy quét phải bắt được cả hai tầng trên mã giả ─────────
  const gia = timSongSongTrenGiaoDich({
    "lib/a.ts": "export async function f(db) { return chayKhongJit(db, (tx) => Promise.all([tx.select().from(x), tx.select().from(y)])); }",
    "lib/b.ts": "export async function g(db) { return chayKhongJit(db, async (tx) => [await tx.select().from(x), await h(1, tx)]); }\nexport async function h(n, conn) { const c = conn ?? d; return Promise.all([c.select().from(a), c.select().from(b)]); }",
    "lib/c.ts": "export async function k(db) { return chayKhongJit(db, async (tx) => [await tx.select().from(x), await tx.select().from(y)]); }",
    "lib/d.ts": "export async function m(db) { return db.transaction(async (tx) => { await Promise.all(rows.map((r) => tx.insert(t).values(r))); }); }",
  });
  assert.ok(gia.some((v) => v.tep === "lib/a.ts" && v.ten === "(thân giao dịch)"), "tầng 1: Promise.all trên tx ngay trong thân phải bị bắt");
  assert.ok(gia.some((v) => v.tep === "lib/b.ts" && v.ten === "h"), "tầng 2: hàm nhận tx rồi Promise.all trên nó phải bị bắt");
  assert.ok(!gia.some((v) => v.tep === "lib/c.ts"), "await nối tiếp trong thân giao dịch là ĐÚNG — không bắt");
  assert.ok(gia.some((v) => v.tep === "lib/d.ts"), ".transaction + Promise.all(rows.map(… tx.insert …)) phải bị bắt");

  // ───────── Mã đã vào kho: không chỗ nào ngoài miễn trừ ─────────
  const viPham = timSongSongTrenGiaoDich(tepDaVaoKho());
  const khoa = (v: ViPham) => `${v.tep}:${v.ten}`;
  const conLai = viPham.filter((v) => !MIEN_TRU[khoa(v)]);
  assert.deepEqual(conLai.map((v) => `${v.tep}:${v.dong} ${v.ten} — ${v.vi}`), [], "song song trên CÙNG client của một giao dịch — đổi sang await nối tiếp (một client chỉ chạy một câu một lúc)");
  const moCoi = Object.keys(MIEN_TRU).filter((k) => !viPham.some((v) => khoa(v) === k));
  assert.deepEqual(moCoi, [], "miễn trừ không còn khớp chỗ nào — xoá khỏi danh sách");
  for (const [k, lyDo] of Object.entries(MIEN_TRU)) assert.ok(lyDo.trim().length >= 20, `miễn trừ ${k} phải kèm lý do đọc được`);

  // ───────── TRƯỚC = SAU: getOperatingCostByDay — đường song song (tự mở bể) ↔ đường nối tiếp (nhận db) ─────────
  const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
  const chuan = (x: unknown): unknown => (x instanceof Map ? [...x.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, chuan(v)]) : Array.isArray(x) ? x.map(chuan) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, chuan(v)])) : x);
  const songSong = await getOperatingCostByDay(ALL);
  const noiTiep = await getOperatingCostByDay(ALL, db);
  assert.deepEqual(chuan(noiTiep), chuan(songSong), "cùng SQL, cùng thứ tự kết quả: nhận client từ ngoài (nối tiếp) phải ra ĐÚNG như tự mở bể (song song)");

  console.log(`✓ Giao dịch chạy câu nối tiếp: máy quét bắt cả hai tầng trên mã giả · mã đã vào kho 0 chỗ song song trên client giao dịch · getOperatingCostByDay nối tiếp = song song`);
}
