/**
 * ═══ ops `shipment-state-probe` — CỬA NỘI BỘ BOT → ERP MẤT BAO LÂU, NGUỘI VÀ ẤM (CHỈ ĐỌC, 24/10/2026) ═══
 *
 * Vì sao: sau đợt pos-reship-link, lượt `bot-order-describe` ĐẦU TIÊN sau khoảng lặng ra «ERP trả 0 lần gửi chính» (run 40051679905) — bot
 * rơi về câu cũ vì lượt gọi nguội vượt timeout 1,5 s; ba lượt ngay sau đều đủ. Trước khi nới timeout phải biết chậm Ở ĐÂU: lần mở kết nối,
 * route Next, hay câu `PRIMARY_ATTEMPT` (con-truy-vấn tương quan) bị JIT biên dịch — cùng lớp lỗi `chayKhongJit` (db/index.ts) đã chữa.
 *
 * Đo ba thứ, mỗi thứ «lượt 1 của tiến trình» rồi 5 lượt ấm:
 *  1. Hàm truy vấn thật (`primaryShipmentsByOrders`, `shipmentStatesByCodes`) với 20 đơn / 20 mã vận đơn tạo lại thật.
 *  2. Chính route HTTP trong container (localhost:3000) với khoá `CHATBOT_ADMIN_TOKEN` của máy — khoá KHÔNG bao giờ in.
 *  3. EXPLAIN (ANALYZE, BUFFERS) câu lần gửi chính — ĐÚNG câu hàm phát ra (bắt lại từ `Pool.query`, không viết bản thứ hai), JIT mặc định vs
 *     JIT tắt, xen kẽ 3 lượt mỗi bên, kèm khối `JIT:` nếu có.
 * Chỉ đọc (ERP_READ_ONLY + select trong giao dịch rollback). Tóm tắt chỉ in SỐ; mã đơn / mã vận đơn / kế hoạch đầy đủ chỉ ở phần MÃ HOÁ.
 */
// Module (không phải script toàn cục): tránh trùng tên `main` với script khác khi tsc kiểm cả thư mục.
export {};

process.env.ERP_READ_ONLY = "1";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const LUOT_AM = 5;
const LUOT_EXPLAIN = 3;

type Cap = { text: string; values: unknown[] };

async function main() {
  // Bắt câu lệnh mà hàm phát ra — để EXPLAIN đúng câu ấy với đúng tham số.
  const pg = (await import("pg")).default as unknown as {
    Pool: { prototype: { query: (...a: unknown[]) => unknown } };
  };
  let capture: Cap[] | null = null;
  const goc = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function boc(...a: unknown[]) {
    if (capture) {
      const q = a[0] as string | { text?: string; values?: unknown[] };
      capture.push(typeof q === "string" ? { text: q, values: (a[1] as unknown[]) ?? [] } : { text: String(q?.text ?? ""), values: q?.values ?? [] });
    }
    return goc.apply(this, a as never);
  };

  const { getDb } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { rowsOf } = await import("@/lib/sql-rows");
  const { primaryShipmentsByOrders, shipmentStatesByCodes } = await import("@/lib/queries/shipment-state-internal");
  const { thoiGianThucThi, trungVi } = await import("@/lib/constants/perf-explain");
  const db = await getDb();

  const mau = rowsOf<{ order_id: string; code: string }>(
    await db.execute(sql`select s.order_id, upper(s.vtp_order_number) as code from shipments s
      where s.raw -> 'reship' ->> 'of' is not null and s.order_id is not null and s.vtp_order_number is not null and s.order_id ~ '^[0-9]+$'
      order by s.created_at desc limit 20`),
  );
  const ids = mau.map((r) => String(r.order_id));
  const codes = mau.map((r) => String(r.code));
  console.log(`mẫu: ${ids.length} đơn · ${codes.length} mã`);

  const bamGio = async (ten: string, fn: () => Promise<unknown>) => {
    const out: number[] = [];
    for (let i = 0; i <= LUOT_AM; i += 1) {
      const t0 = performance.now();
      await fn();
      out.push(performance.now() - t0);
    }
    const [dau, ...am] = out;
    const tv = trungVi(am);
    console.log(`${ten}: lượt 1 ${dau.toFixed(0)} ms · ấm ${am.map((x) => x.toFixed(0)).join(" / ")} ms`);
    tomTat(`${ten}: lượt 1 ${dau.toFixed(0)} ms · ấm trung vị ${tv === null ? "—" : tv.toFixed(0)} ms · max ${Math.max(...am).toFixed(0)} ms`);
  };

  // 1. Hàm truy vấn — lượt đầu cũng bắt câu lệnh cho phần EXPLAIN.
  capture = [];
  await bamGio("primaryShipmentsByOrders (20 đơn)", () => primaryShipmentsByOrders(ids));
  const cauChinh = capture.find((c) => /PRIMARY|"orders"\."id" in/i.test(c.text) || /from "orders"/.test(c.text)) ?? capture[0] ?? null;
  capture = null;
  await bamGio("shipmentStatesByCodes (20 mã)", () => shipmentStatesByCodes(codes));

  // 2. Route HTTP thật trong container.
  const token = process.env.CHATBOT_ADMIN_TOKEN || "";
  const port = process.env.PORT || "3000";
  if (!token) tomTat("route: KHÔNG đo — container không có CHATBOT_ADMIN_TOKEN");
  else {
    const url = `http://127.0.0.1:${port}/api/internal/shipment-state?codes=${encodeURIComponent(codes.join(","))}&orders=${encodeURIComponent(ids.join(","))}`;
    let lastStatus = 0;
    let lastOrders = 0;
    await bamGio("route /api/internal/shipment-state (20 + 20)", async () => {
      const r = await fetch(url, { headers: { "x-chatbot-token": token } });
      lastStatus = r.status;
      const b = (await r.json().catch(() => ({}))) as { orders?: unknown[] };
      lastOrders = Array.isArray(b.orders) ? b.orders.length : -1;
    });
    tomTat(`route: HTTP ${lastStatus} · trả ${lastOrders} lần gửi chính / ${ids.length} đơn hỏi`);
  }

  // 3. EXPLAIN câu lần gửi chính — JIT mặc định vs tắt, xen kẽ.
  if (!cauChinh) tomTat("EXPLAIN: CHƯA ĐO ĐƯỢC — không bắt được câu lệnh của primaryShipmentsByOrders");
  else {
    const PoolCtor = (pg as unknown as { Pool: new (o: { connectionString: string; max: number }) => { connect: () => Promise<{ query: (t: string, v?: unknown[]) => Promise<{ rows?: Record<string, string>[] }>; release: () => void }>; end: () => Promise<void> } }).Pool;
    const pool = new PoolCtor({ connectionString: process.env.DATABASE_URL ?? "", max: 1 });
    const mot = async (jitTat: boolean) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set transaction read only");
        if (jitTat) await c.query("set local jit = off");
        const r = await c.query(`explain (analyze, buffers, timing) ${cauChinh.text}`, cauChinh.values);
        return (r.rows ?? []).map((x) => String(Object.values(x)[0]));
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    const bat: number[] = [];
    const tat: number[] = [];
    let khoiJit: string[] = [];
    let keHoach: string[] = [];
    for (let k = 0; k < LUOT_EXPLAIN; k += 1) {
      const dB = await mot(false);
      const tb = thoiGianThucThi(dB);
      if (tb !== null) bat.push(tb);
      if (!khoiJit.length) {
        const j = dB.findIndex((l) => l.trim().startsWith("JIT:"));
        if (j >= 0) khoiJit = dB.slice(j, j + 6);
      }
      const dT = await mot(true);
      const tt = thoiGianThucThi(dT);
      if (tt !== null) tat.push(tt);
      keHoach = dT;
    }
    await pool.end().catch(() => undefined);
    const mB = trungVi(bat);
    const mT = trungVi(tat);
    console.log(`EXPLAIN JIT mặc định [${bat.map((x) => x.toFixed(1)).join(" · ")}] · JIT tắt [${tat.map((x) => x.toFixed(1)).join(" · ")}]`);
    console.log(khoiJit.length ? khoiJit.map((l) => `  ${l.slice(0, 200)}`).join("\n") : "  (không có khối JIT: — JIT không biên dịch câu này)");
    console.log("── kế hoạch lượt JIT tắt cuối ──");
    console.log(keHoach.map((l) => `  ${l}`).join("\n"));
    tomTat(`EXPLAIN lần gửi chính: JIT mặc định trung vị ${mB === null ? "—" : mB.toFixed(1)} ms · JIT tắt ${mT === null ? "—" : mT.toFixed(1)} ms · ${khoiJit.length ? "CÓ biên dịch JIT" : "KHÔNG biên dịch JIT"}`);
  }
}

main().then(
  () => process.stdout.write("", () => process.exit(0)),
  (e: unknown) => {
    console.error("shipment-state-probe lỗi:", e instanceof Error ? e.message : e);
    tomTat("shipment-state-probe: LỖI — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  },
);
