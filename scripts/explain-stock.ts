/**
 * ĐO TRUY VẤN KẾ HOẠCH ĐẶT HÀNG — câu chậm nhất còn lại của ERP.
 *
 * Bốn vòng chẩn đoán trước đều dừng ở "câu này 40 giây" rồi đoán tiếp. Kế hoạch thực thi là thứ duy
 * nhất trả lời được VÌ SAO: quét tuần tự hay dùng chỉ mục, chạy một lần hay chạy lại cho từng dòng.
 *
 * Dựng câu lệnh bằng CHÍNH mã của ứng dụng (`buildPlanRowsQuery`), không chép tay lại SQL — chép
 * tay thì đo một câu khác với câu đang chạy thật.
 *
 * ─── ĐO CÓ VÀ KHÔNG CÓ JIT ───
 *
 * `explain-stock` lần trước cho thấy chi phí kế hoạch 2,2 triệu và dòng `JIT:` trong bản kế hoạch.
 * PostgreSQL bật JIT khi chi phí ước lượng vượt `jit_above_cost` (mặc định 100.000). Với truy vấn
 * nhiều truy vấn con tương quan trên máy 2 nhân, thời gian BIÊN DỊCH JIT có thể lớn hơn thời gian
 * chạy — nên phải đo cả hai, cùng dữ liệu, cùng bộ lọc, rồi mới kết luận.
 *
 * `set local jit = off` chỉ có hiệu lực TRONG giao dịch của phép đo này. Không đụng tới cấu hình
 * máy chủ, không ảnh hưởng phiên nào khác.
 *
 * CHỈ ĐỌC: `EXPLAIN ANALYZE` có chạy thật câu lệnh, nhưng đây là `select` nên không ghi gì.
 */
import { getDb } from "@/db";
import { buildPlanRowsQuery, loadPlanningAssumptions } from "@/lib/queries/planning";
import { variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { sql } from "drizzle-orm";

function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

type PlanNode = {
  "Node Type"?: string;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Relation Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};

type PlanRoot = {
  Plan: PlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  JIT?: { Timing?: Record<string, number>; Functions?: number };
};

/** Cộng dồn khối đệm của cả cây kế hoạch — `BUFFERS` chỉ có ở từng nút. */
function demBuffers(node: PlanNode): { hit: number; read: number } {
  let hit = Number(node["Shared Hit Blocks"] ?? 0);
  let read = Number(node["Shared Read Blocks"] ?? 0);
  for (const con of node.Plans ?? []) {
    const c = demBuffers(con);
    hit += c.hit;
    read += c.read;
  }
  return { hit, read };
}

/** Các nút tốn thời gian nhất, kèm SỐ LẦN CHẠY — nút chạy lại 2.500 lần là truy vấn con tương quan. */
function nutNang(node: PlanNode, ket: { ten: string; ms: number; loops: number; rows: number }[] = []) {
  const loops = Number(node["Actual Loops"] ?? 1);
  const ms = Number(node["Actual Total Time"] ?? 0) * loops;
  ket.push({
    ten: `${node["Node Type"] ?? "?"}${node["Relation Name"] ? ` on ${node["Relation Name"]}` : ""}`,
    ms,
    loops,
    rows: Number(node["Actual Rows"] ?? 0),
  });
  for (const con of node.Plans ?? []) nutNang(con, ket);
  return ket;
}

async function doMot(ten: string, text: string, tatJit: boolean) {
  const db = await getDb();
  const t0 = Date.now();
  let root: PlanRoot | null = null;
  await db.transaction(async (tx) => {
    if (tatJit) await tx.execute(sql.raw("set local jit = off"));
    const r = await tx.execute(sql.raw(`explain (analyze, buffers, timing, format json) ${text}`));
    const dong = rowsOf<Record<string, unknown>>(r)[0];
    const giaTri = Object.values(dong ?? {})[0];
    const parsed = typeof giaTri === "string" ? JSON.parse(giaTri) : giaTri;
    root = (Array.isArray(parsed) ? parsed[0] : parsed) as PlanRoot;
  });
  const total = Date.now() - t0;
  if (!root) {
    console.log(`\n══════ ${ten} · JIT ${tatJit ? "OFF" : "ON"} — không đọc được kế hoạch ══════`);
    return;
  }
  const r: PlanRoot = root;
  const buf = demBuffers(r.Plan);
  const jitTiming = r.JIT?.Timing ?? {};
  const jitMs = Object.values(jitTiming).reduce((t, v) => t + Number(v ?? 0), 0);

  console.log(`\n══════ ${ten} · JIT ${tatJit ? "OFF" : "ON"} ══════`);
  console.log(`TOTAL_TIME      ${total} ms (kể cả vòng đi về)`);
  console.log(`PLANNING_TIME   ${Number(r["Planning Time"] ?? 0).toFixed(2)} ms`);
  console.log(`EXECUTION_TIME  ${Number(r["Execution Time"] ?? 0).toFixed(2)} ms`);
  console.log(`ROWS            ${r.Plan["Actual Rows"] ?? 0}`);
  console.log(`BUFFERS         hit ${buf.hit} · read ${buf.read}`);
  console.log(`JIT_TIME        ${jitMs ? `${jitMs.toFixed(2)} ms · ${r.JIT?.Functions ?? 0} hàm` : "không bật"}`);
  console.log("QUERY_PLAN (10 nút tốn nhiều thời gian nhất, ms đã nhân số vòng lặp):");
  for (const n of nutNang(r.Plan).sort((a, b) => b.ms - a.ms).slice(0, 10)) {
    console.log(`  ${n.ms.toFixed(1).padStart(9)} ms  ×${String(n.loops).padStart(6)} vòng  ${String(n.rows).padStart(7)} dòng  ${n.ten}`);
  }
}

async function main() {
  const db = await getDb();
  const a = await loadPlanningAssumptions();

  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);

  /*
    CÂU TOÀN BỘ CÓ THỂ CHƯA TỒN TẠI TRONG IMAGE ĐANG CHẠY.

    Ops nạp SCRIPT mới nhất từ GitHub nhưng `lib/` thì lấy từ image đã dựng — nên ngay sau khi tách
    `buildPlanRowsQuery`, script mới gặp image cũ và hàm chưa có. Bắt lỗi ở đây để các phép đo còn
    lại VẪN CHẠY: nửa số liệu vẫn hơn không có gì, và thông báo nói rõ vì sao thiếu.
  */
  const muc: [string, { toSQL(): { sql: string; params: unknown[] } }][] = [];
  try {
    muc.push(["TOÀN BỘ dòng kế hoạch (đúng câu /inventory/planning chạy)", buildPlanRowsQuery(db, a)]);
  } catch (e) {
    console.log(`⚠ Chưa đo được câu toàn bộ: ${e instanceof Error ? e.message : String(e)}`);
    console.log("  (image đang chạy chưa có buildPlanRowsQuery — deploy rồi chạy lại để có số này)");
  }
  muc.push(["vsales (đơn hàng → mẫu mã)", db.select().from(sales)]);
  muc.push(["vreceipts (phiếu kho → mẫu mã)", db.select().from(receipts)]);

  for (const [ten, truyVan] of muc) {
    const { sql: text, params } = truyVan.toSQL();
    const cauLenh = bind(text, params);
    for (const tatJit of [false, true]) {
      try {
        await doMot(ten, cauLenh, tatJit);
      } catch (e) {
        console.log(`\n══════ ${ten} · JIT ${tatJit ? "OFF" : "ON"} — LỖI ══════\n${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  process.exit(0);
}

/**
 * Nhúng tham số vào câu lệnh để `explain` chạy được.
 *
 * `EXPLAIN` không nhận tham số rời, mà mục đích ở đây là ĐỌC KẾ HOẠCH chứ không phải chạy an toàn —
 * script này chỉ chạy tay trên ops, không nằm trên đường của người dùng.
 */
function bind(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return String(v);
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

main().catch((error) => {
  console.error("explain-stock lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
