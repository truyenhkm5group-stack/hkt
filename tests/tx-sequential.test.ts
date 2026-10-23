import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chayKhongJit, getDb, KetNoiThuHaiError, theoClient, type Db } from "@/db";
import { getOperatingCostByDay } from "@/lib/queries/cost-engine";
import { getRecognizedPayrollCost } from "@/lib/queries/payroll-cost";
import type { Period } from "@/lib/search-params";

/**
 * ═══════ MỘT GIAO DỊCH = MỘT CLIENT: CÂU CHẠY NỐI TIẾP, VÀ KHÔNG XIN KẾT NỐI THỨ HAI ═══════
 *
 * `chayKhongJit` (db/index.ts) mở MỘT giao dịch = MỘT client Postgres, giữ nó suốt thân `fn`. Hai lỗi cùng gốc:
 *
 *   A. SONG SONG TRÊN CLIENT GIAO DỊCH. `Promise.all([tx.select…, f(tx)…])` không song song gì: pg@8 xếp hàng và
 *      cảnh báo «client.query() when the client is already executing a query» (pg@9 bỏ hẳn), phép đo tính cả
 *      thời gian xếp hàng vào từng câu. Hàm nhận `db` từ ngoài thì chạy qua `theoClient` (song song trên bể,
 *      nối tiếp trên giao dịch).
 *   B. KẾT NỐI THỨ HAI. Trong thân giao dịch mà gọi `getDb()` (qua `getSettingJson`, `memo`…) là giữ một kết
 *      nối rồi xin cái khác ⇒ khoá chết bể khi 5 lượt cùng lúc (getOperatingCostByDay → getRecognizedPayrollCost).
 *
 * A KIỂM BẰNG QUÉT MÃ NGUỒN: trên PGlite `chayKhongJit` không mở giao dịch nên bài kiểm động xanh giả. Máy quét
 * LAN TRUYỀN — tập (hàm, tham số) nhận client giao dịch đi tới điểm cố định qua mọi lời gọi chuyển tiếp tham số
 * đó — và cờ mọi `Promise.all` / `allSettled` / `.map(async` nhắc tới tham số ấy ở BẤT KỲ vai trò nào (gọi trên
 * nó HOẶC truyền nó đi). Bản đầu (PR trước) chỉ tìm `db.select(…)` nên lọt `buildDays(tx)` — bản này thay nó.
 * `theoClient(…)` là cách chạy đúng nên không bị cờ.
 *
 * B KIỂM LÚC CHẠY: lá chắn trong db/index.ts (bật bởi ERP_TX_GUARD=1 của bộ chạy) ném `KetNoiThuHaiError` khi
 * `getDb()` bị gọi dưới dấu của `chayKhongJit` — bắt mọi tầng gọi mà quét mã nguồn không với tới.
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
/** Bỏ chú thích (giữ số dòng) — một tên hàm trong chú thích không phải một lời gọi. */
const boChuThich = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1)).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const doiSo = (s: string) => (s ? s.slice(1, -1).split(/,(?![^()[\]{}]*[)\]}])/).map((x) => x.trim()) : []);
const dongCua = (src: string, i: number) => src.slice(0, i).split("\n").length;
/** Gỡ mọi đoạn `theoClient(…)` (cân bằng ngoặc) — đó là cách chạy đúng trên client giao dịch. */
function boTheoClient(s: string): string {
  for (let i = s.indexOf("theoClient("); i >= 0; i = s.indexOf("theoClient(")) s = s.slice(0, i) + s.slice(i + "theoClient".length + canBang(s, i).length);
  return s;
}

type DinhNghia = { tep: string; thamSo: string[]; than: string; dong: number };

export type ViPham = { tep: string; dong: number; ten: string; vi: string };

/** HÀM THUẦN trên tập tệp `{ đường dẫn: mã nguồn }` — để chính bài kiểm thử được nó bằng mã giả. */
export function timSongSongTrenGiaoDich(tepGoc: Record<string, string>): ViPham[] {
  const tep = Object.fromEntries(Object.entries(tepGoc).map(([f, s]) => [f, boChuThich(s)]));
  const dinhNghia = new Map<string, DinhNghia[]>();
  for (const [f, src] of Object.entries(tep)) {
    for (const d of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
      const ts = canBang(src, d.index + d[0].length - 1);
      // Thân bắt đầu ở `{` CUỐI DÒNG: kiểu trả về `Promise<{ … }>` cũng có `{`, lấy nhầm nó là lấy nhầm thân.
      const k = src.indexOf("{\n", d.index + d[0].length - 1 + ts.length);
      const than = k >= 0 ? canBang(src, k, "{", "}") : "";
      const ds = dinhNghia.get(d[1]) ?? [];
      ds.push({ tep: f, thamSo: doiSo(ts).map((p) => p.split(/[:=?]/)[0].trim()), than, dong: dongCua(src, d.index) });
      dinhNghia.set(d[1], ds);
    }
  }
  /** Định nghĩa của `ten` nhìn từ tệp `tu`: cùng tệp, hoặc tệp được import tường minh — không khớp bừa theo tên. */
  const timDinhNghia = (ten: string, tu: string): DinhNghia[] => {
    const ds = dinhNghia.get(ten) ?? [];
    const cungTep = ds.filter((d) => d.tep === tu);
    if (cungTep.length) return cungTep;
    const m = new RegExp(`import\\s*\\{[^}]*\\b${thoat(ten)}\\b[^}]*\\}\\s*from\\s*"@/([^"]+)"`).exec(tep[tu] ?? "");
    return m ? ds.filter((d) => d.tep === `${m[1]}.ts` || d.tep === `${m[1]}.tsx` || d.tep === `${m[1]}/index.ts`) : [];
  };

  const ra = new Map<string, ViPham>();
  const daXet = new Set<string>();
  const viec: { tep: string; bien: string; than: string; dong: number; nhan: string }[] = [];
  for (const [f, src] of Object.entries(tep)) {
    for (const m of src.matchAll(MO_GIAO_DICH)) {
      if (/function chayKhongJit/.test(src.slice(Math.max(0, m.index - 30), m.index + 15))) continue;
      const than = canBang(src, m.index);
      const bien = (/^\(\s*\w+\s*,\s*(?:async\s*)?\(?\s*(\w+)/.exec(than) ?? /^\(\s*async\s*\(?\s*(\w+)/.exec(than))?.[1];
      if (bien) viec.push({ tep: f, bien, than, dong: dongCua(src, m.index), nhan: "(thân giao dịch)" });
    }
  }
  while (viec.length) {
    const v = viec.pop()!;
    const khoa = `${v.tep}:${v.dong}:${v.bien}`;
    if (daXet.has(khoa)) continue;
    daXet.add(khoa);
    const biDanh = new Set([v.bien, ...[...v.than.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*[^;\\n]*\\b${thoat(v.bien)}\\b`, "g"))].map((a) => a[1])]);
    const nhacToi = (doan: string) => [...biDanh].some((x) => new RegExp(`\\b${thoat(x)}\\b`).test(doan));
    for (const p of v.than.matchAll(SONG_SONG)) {
      // `theoClient(…)` bên trong là đường ĐÚNG (nối tiếp trên giao dịch) — không tính là nhắc tới client.
      if (nhacToi(boTheoClient(canBang(v.than, p.index + p[0].length - 1)))) {
        const dong = v.dong + v.than.slice(0, p.index).split("\n").length - 1;
        ra.set(`${v.tep}:${dong}`, { tep: v.tep, dong, ten: v.nhan, vi: `${p[0].replace("(", "")} nhắc tới «${v.bien}» — client giao dịch` });
      }
    }
    for (const c of v.than.matchAll(/\b([A-Za-z_]\w*)\(/g)) {
      const cac = doiSo(canBang(v.than, c.index + c[0].length - 1));
      cac.forEach((x, vt) => {
        if (!biDanh.has(x) && !(/^\{/.test(x) && nhacToi(x))) return;
        for (const d of timDinhNghia(c[1], v.tep)) {
          const ten = d.thamSo[vt];
          if (ten && !ten.startsWith("{")) viec.push({ tep: d.tep, bien: ten, than: d.than, dong: d.dong, nhan: c[1] });
        }
      });
    }
  }
  return [...ra.values()];
}

/**
 * Mã ĐÃ VÀO KHO (HEAD), đọc bằng MỘT tiến trình `git cat-file --batch` — không phải một `git show` cho mỗi tệp.
 * Tệp chưa vào kho trả `missing` và bị bỏ qua: repo-integrity đã chặn việc commit mã import thứ chưa vào kho.
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
    if (!m) continue;
    const n = Number(m[1]);
    ra[f] = buf.subarray(i, i + n).toString("utf8");
    i += n + 1;
  }
  return ra;
}

export async function testTxSequential(db: Db) {
  // ───────── A · Đột biến DỰNG SẴN: máy quét phải bắt đúng trên mã giả ─────────
  const gia = timSongSongTrenGiaoDich({
    "lib/a.ts": "export async function f(db) { return chayKhongJit(db, (tx) => Promise.all([tx.select().from(x), tx.select().from(y)])); }",
    "lib/b.ts": "export async function g(db) { return chayKhongJit(db, async (tx) => [await tx.select().from(x), await h(1, tx)]); }\nexport async function h(n, conn) {\n  const c = conn ?? d;\n  return Promise.all([c.select().from(a), c.select().from(b)]);\n}",
    "lib/c.ts": "export async function k(db) { return chayKhongJit(db, async (tx) => [await tx.select().from(x), await tx.select().from(y)]); }",
    "lib/d.ts": "export async function m(db) { return db.transaction(async (tx) => { await Promise.all(rows.map((r) => tx.insert(t).values(r))); }); }",
    // Đúng ca đã lọt bản đầu: client giao dịch TRUYỀN TIẾP làm đối số, kiểu trả về có `{` trước thân.
    "lib/e.ts":
      "export async function p(db) { return chayKhongJit(db, async (tx) => [await build(tx, 1)]); }\nasync function build(db: Db, n: number): Promise<{ rows: X[] }> {\n  return Promise.all([rowsOf(db, n), spendOf(db)]);\n}",
    // theoClient là đường đúng — không cờ.
    "lib/f.ts": "export async function q(db) { return chayKhongJit(db, async (tx) => [await build2(tx)]); }\nasync function build2(db: Db) {\n  return theoClient(db, [() => rowsOf(db), () => spendOf(db)]);\n}",
  });
  const co = (tep: string) => gia.some((v) => v.tep === tep);
  assert.ok(co("lib/a.ts"), "tầng 1: Promise.all trên tx ngay trong thân phải bị bắt");
  assert.ok(co("lib/b.ts"), "lan truyền: hàm nhận tx (qua bí danh) rồi Promise.all trên nó phải bị bắt");
  assert.ok(!co("lib/c.ts"), "await nối tiếp trong thân giao dịch là ĐÚNG — không bắt");
  assert.ok(co("lib/d.ts"), ".transaction + Promise.all(rows.map(… tx.insert …)) phải bị bắt");
  assert.ok(co("lib/e.ts"), "client giao dịch TRUYỀN TIẾP làm đối số trong Promise.all phải bị bắt (ca buildDays lọt bản đầu)");
  assert.ok(!co("lib/f.ts"), "theoClient là đường đúng — không bắt");

  // ───────── A · Mã đã vào kho: không chỗ nào ngoài miễn trừ ─────────
  const viPham = timSongSongTrenGiaoDich(tepDaVaoKho());
  const khoa = (v: ViPham) => `${v.tep}:${v.ten}`;
  const conLai = viPham.filter((v) => !MIEN_TRU[khoa(v)]);
  assert.deepEqual(conLai.map((v) => `${v.tep}:${v.dong} [${v.ten}] ${v.vi}`), [], "song song trên client của một giao dịch — dùng theoClient (hàm nhận db) hoặc await nối tiếp (thân giao dịch)");
  const moCoi = Object.keys(MIEN_TRU).filter((k) => !viPham.some((v) => khoa(v) === k));
  assert.deepEqual(moCoi, [], "miễn trừ không còn khớp chỗ nào — xoá khỏi danh sách");
  for (const [k, lyDo] of Object.entries(MIEN_TRU)) assert.ok(lyDo.trim().length >= 20, `miễn trừ ${k} phải kèm lý do đọc được`);

  // ───────── B · Lá chắn lúc chạy: getDb() trong chayKhongJit NÉM; ngoài thì không ─────────
  assert.equal(process.env.ERP_TX_GUARD, "1", "bộ chạy phải bật lá chắn (tests/sync-fixtures.test.ts) — tắt thì cả lớp lỗi B không ai thấy");
  await assert.rejects(() => chayKhongJit(db, async () => getDb()), (e) => e instanceof KetNoiThuHaiError, "getDb() bên trong chayKhongJit phải bị chặn");
  assert.ok(await getDb(), "ngoài giao dịch thì getDb() chạy bình thường");
  assert.deepEqual(await chayKhongJit(db, (tx) => theoClient(tx, [() => Promise.resolve(1), Promise.resolve(2)])), [1, 2], "theoClient giữ đúng thứ tự");

  // ───────── TRƯỚC = SAU: getOperatingCostByDay — tự mở bể (song song) ↔ nhận client + payroll (nối tiếp) ─────────
  const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };
  const chuan = (x: unknown): unknown => (x instanceof Map ? [...x.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, chuan(v)]) : Array.isArray(x) ? x.map(chuan) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, chuan(v)])) : x);
  const songSong = await getOperatingCostByDay(ALL);
  const payroll = await getRecognizedPayrollCost(ALL);
  const noiTiep = await chayKhongJit(db, (tx) => getOperatingCostByDay(ALL, { db: tx, payroll }));
  assert.deepEqual(chuan(noiTiep), chuan(songSong), "cùng SQL, cùng thứ tự kết quả: trong giao dịch (payroll tính sẵn, nối tiếp) phải ra ĐÚNG như tự mở bể (song song)");

  console.log("✓ Một giao dịch = một client: máy quét LAN TRUYỀN bắt cả ca client truyền tiếp (buildDays) trên mã giả · mã đã vào kho 0 chỗ · lá chắn lúc chạy chặn getDb() trong chayKhongJit · getOperatingCostByDay trong giao dịch = ngoài giao dịch");
}
