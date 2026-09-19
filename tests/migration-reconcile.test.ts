/**
 * HOÀ GIẢI VA CHẠM MIGRATION — HAI ĐƯỜNG NÂNG CẤP PHẢI VỀ CÙNG MỘT LƯỢC ĐỒ.
 *
 * ═══ VA CHẠM LÀ GÌ ═══
 *
 * Nhánh này và `main` cùng dùng số hiệu 0084–0099 cho những migration HOÀN TOÀN KHÁC NHAU: nhánh
 * đi về nhân sự AI bán hàng, `main` đi về lương · hoàn hàng · landing · vtp · tech. Không trùng
 * một tên tệp nào, nhưng trùng 15 số hiệu.
 *
 * ═══ VÌ SAO GỘP THẲNG LÀ HỎNG CẢ HAI PHÍA ═══
 *
 * Drizzle KHÔNG so tên tệp và KHÔNG so hash. Nó đọc MỐC LỚN NHẤT đã áp dụng (`created_at`) MỘT
 * LẦN, rồi bỏ qua mọi migration có mốc thấp hơn con số ấy. Nên:
 *
 *   · trên production (trần = mốc lớn nhất của `main`): CẢ 16 migration của nhánh đều có mốc thấp
 *     hơn ⇒ BỊ BỎ QUA HẾT. Production không bao giờ có lược đồ nhân sự AI.
 *   · trên bản chạy thử (trần = 1789381643786, đo được 19/09/2026): `main` 0084–0087 có mốc thấp
 *     hơn ⇒ bị bỏ qua. Và `main` 0090 chạy `ALTER TABLE "fanpages"` trong khi bảng ấy do chính
 *     0086 tạo ⇒ lượt migration CHẾT GIỮA CHỪNG. `IF NOT EXISTS` trên tên cột không cứu được một
 *     bảng không tồn tại.
 *
 * ═══ HOÀ GIẢI ═══
 *
 * Hai tệp, sinh ra từ CHÍNH SQL đã chạy thật (`scripts/migration-reconcile/generate.mjs`), mỗi
 * câu lệnh biến thành dạng chạy-lại-được, và GIỮ NGUYÊN thứ tự — chuỗi gốc có cả `create table`
 * lẫn `drop table` cùng một bảng.
 *
 *   R1  mốc nằm GIỮA trần của bản chạy thử và mốc của `main` 0088.
 *       ⇒ chạy trên bản chạy thử (tạo đủ bốn thứ `main` 0084–0087 tạo, TRƯỚC khi 0090 cần tới),
 *         bị bỏ qua trên production (đã có sẵn).
 *   R2  mốc LỚN HƠN mọi mốc của `main`.
 *       ⇒ chạy trên production (dựng lược đồ nhân sự AI), không làm gì trên bản chạy thử.
 *
 * ═══ BÀI KIỂM NÀY CHỨNG MINH GÌ ═══
 *
 * Hai đường đi khác hẳn nhau về cùng MỘT lược đồ cuối:
 *   A. CSDL mang lịch sử `main`      + hoà giải  → lược đồ hợp nhất
 *   B. CSDL mang lịch sử nhánh/staging + hoà giải → lược đồ hợp nhất
 * So từng bảng, từng cột, từng kiểu, từng chỉ mục. Khác một cột là đỏ.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version?: string; dialect?: string; entries: Entry[] };

/** Trần mốc ĐO ĐƯỢC trên bản chạy thử 19/09/2026 (97 migration đã áp, tag cuối `0097_review_expected_behavior`). */
const TRAN_STAGING = 1789381643786;

const show = (ref: string, p: string) => execFileSync("git", ["show", `${ref}:${p}`], { encoding: "utf-8" });
const journalOf = (ref: string): Journal => JSON.parse(show(ref, "drizzle/meta/_journal.json")) as Journal;

/** Dựng một thư mục drizzle tạm từ một danh sách mục sổ + các tệp .sql tương ứng. */
function dungThuMuc(entries: Entry[], sqlOf: (tag: string) => string): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "reconcile-"));
  const thuMuc = path.join(tmp, "drizzle");
  mkdirSync(path.join(thuMuc, "meta"), { recursive: true });
  for (const e of entries) writeFileSync(path.join(thuMuc, `${e.tag}.sql`), sqlOf(e.tag));
  writeFileSync(path.join(thuMuc, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2) + "\n");
  return tmp;
}

/** Ảnh chụp lược đồ: bảng · cột · kiểu · cho phép null · chỉ mục. Đủ mịn để bắt lệch một cột. */
async function anhChupLuocDo(client: { query: <T>(q: string) => Promise<{ rows: T[] }> }): Promise<string> {
  const cols = await client.query<{ s: string }>(`
    select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable as s
    from information_schema.columns where table_schema = 'public' order by 1`);
  const idx = await client.query<{ s: string }>(`
    select tablename || '/' || indexname as s from pg_indexes where schemaname = 'public' order by 1`);
  return [...cols.rows.map((r) => r.s), "── chỉ mục ──", ...idx.rows.map((r) => r.s)].join("\n");
}

test("hoà giải migration: hai đường nâng cấp về cùng một lược đồ", { timeout: 600_000 }, async () => {
  const nhanh = journalOf("HEAD");
  const main = journalOf("origin/main");

  // ── ① VA CHẠM CÓ THẬT, và bài kiểm tự chứng minh tiền đề của mình ──
  const theoIdxNhanh = new Map(nhanh.entries.map((e) => [e.idx, e.tag]));
  const vaCham = main.entries.filter((e) => theoIdxNhanh.has(e.idx) && theoIdxNhanh.get(e.idx) !== e.tag);
  assert.ok(vaCham.length >= 15, `phải có ít nhất 15 số hiệu va chạm, đang thấy ${vaCham.length}`);

  const tranMain = Math.max(...main.entries.map((e) => e.when));
  const nhanhRieng = nhanh.entries.filter((e) => !main.entries.some((m) => m.tag === e.tag));
  // Đây là lý do R2 tồn tại: MỌI migration riêng của nhánh đều nằm dưới trần của production.
  assert.ok(
    nhanhRieng.every((e) => e.when < tranMain),
    "nếu có migration của nhánh mốc cao hơn trần của main thì lập luận của R2 phải viết lại",
  );

  // ── ② MỐC CỦA HAI TỆP HOÀ GIẢI PHẢI NẰM ĐÚNG CHỖ ──
  const main0088 = main.entries.find((e) => e.tag.startsWith("0088_"))!;
  const R1_WHEN = 1789390000000;
  const R2_WHEN = tranMain + 60_000;
  assert.ok(R1_WHEN > TRAN_STAGING, "R1 phải CAO HƠN trần bản chạy thử, nếu không nó bị bỏ qua ở đúng nơi cần nó");
  assert.ok(R1_WHEN < main0088.when, "R1 phải THẤP HƠN main 0088, nếu không main 0088–0106 bị bỏ qua trên bản chạy thử");
  assert.ok(R2_WHEN > tranMain, "R2 phải cao hơn mọi mốc của main, nếu không production bỏ qua nó");

  const R1 = readFileSync("scripts/migration-reconcile/out/R1.sql", "utf-8");
  const R2 = readFileSync("scripts/migration-reconcile/out/R2.sql", "utf-8");

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const chay = async (entries: Entry[], sqlOf: (tag: string) => string) => {
    const tmp = dungThuMuc(entries, sqlOf);
    const client = new PGlite(path.join(tmp, "db"));
    const db = drizzle(client) as never;
    try {
      await migrate(db, { migrationsFolder: path.join(tmp, "drizzle") });
      const anh = await anhChupLuocDo(client as never);
      const soApDung = Number((await client.query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n ?? 0);
      return { anh, soApDung };
    } finally {
      await client.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  // Sổ HỢP NHẤT: mục chung (0..83) + mục riêng của main + R1 đặt TRƯỚC main 0088 + mục riêng của
  // nhánh + R2 ở cuối. `idx` ở đây chỉ để đọc; thứ hạng thật do vị trí mảng và mốc quyết định.
  const chung = main.entries.filter((e) => nhanh.entries.some((b) => b.tag === e.tag));
  const mainRieng = main.entries.filter((e) => !nhanh.entries.some((b) => b.tag === e.tag));
  const r1: Entry = { idx: 900, version: "7", when: R1_WHEN, tag: "R1_main_catchup", breakpoints: true };
  const r2: Entry = { idx: 901, version: "7", when: R2_WHEN, tag: "R2_branch_ai_schema", breakpoints: true };

  const truoc0088 = mainRieng.filter((e) => e.when < main0088.when);
  const tu0088 = mainRieng.filter((e) => e.when >= main0088.when);
  const hopNhat: Entry[] = [...chung, ...truoc0088, r1, ...tu0088, ...nhanhRieng, r2];

  const sqlHopNhat = (tag: string): string => {
    if (tag === "R1_main_catchup") return R1;
    if (tag === "R2_branch_ai_schema") return R2;
    const ref = nhanh.entries.some((e) => e.tag === tag) ? "HEAD" : "origin/main";
    return show(ref, `drizzle/${tag}.sql`);
  };

  // ── ĐƯỜNG A: CSDL trắng đi theo sổ hợp nhất (tương đương production nâng cấp) ──
  const A = await chay(hopNhat, sqlHopNhat);

  // ── ĐƯỜNG B: CSDL ĐÃ MANG lịch sử nhánh (đúng bản chạy thử hôm nay), rồi nâng cấp ──
  //
  // Dựng bằng cách chạy sổ hợp nhất NHƯNG cắt bỏ mọi mục có mốc <= trần bản chạy thử — đúng thứ
  // drizzle sẽ làm khi gặp một CSDL có trần ấy. Nếu R1 thiếu, bước này CHẾT ở main 0090.
  const nhuStaging = hopNhat.filter((e) => e.when > TRAN_STAGING);
  const daCoSan = nhanh.entries.filter((e) => e.when <= TRAN_STAGING);
  const B = await chay([...daCoSan, ...nhuStaging], sqlHopNhat);

  // ── SO HAI LƯỢC ĐỒ ──
  if (A.anh !== B.anh) {
    const a = new Set(A.anh.split("\n"));
    const b = new Set(B.anh.split("\n"));
    const chiA = [...a].filter((x) => !b.has(x)).slice(0, 20);
    const chiB = [...b].filter((x) => !a.has(x)).slice(0, 20);
    assert.fail(`hai đường nâng cấp ra lược đồ KHÁC NHAU.\nchỉ đường A có:\n  ${chiA.join("\n  ")}\nchỉ đường B có:\n  ${chiB.join("\n  ")}`);
  }
  assert.equal(A.anh, B.anh);
  assert.ok(A.anh.includes("sales_conversations."), "lược đồ hợp nhất phải có bảng của nhánh");
  assert.ok(A.anh.includes("fanpages."), "lược đồ hợp nhất phải có bảng của main");
  assert.ok(A.anh.includes("order_field_provenance."), "phải có bảng mới nhất của nhánh");
  assert.ok(A.anh.includes("ai_model_calls.input_price_vnd_per_million"), "phải có cột ảnh chụp giá");
  console.log(`  ✓ đường A: ${A.soApDung} migration · đường B: ${B.soApDung} migration · lược đồ cuối TRÙNG KHỚP (${A.anh.split("\n").length} dòng ảnh chụp)`);
});
