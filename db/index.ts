import { sql as sqlRaw } from "drizzle-orm";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { probeActive, recordQuery } from "@/lib/perf/probe";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

type Holder = { db?: Db; kind?: "pg" | "pglite"; pool?: Pool; pglite?: unknown };
const holder = globalThis as unknown as { __erpDb?: Holder };
if (!holder.__erpDb) holder.__erpDb = {};

export function databaseUrl() {
  return (process.env.DATABASE_URL || "").trim();
}

export function isPglite() {
  return databaseUrl().startsWith("pglite:");
}

/** Đường dẫn thư mục dữ liệu khi dùng PGlite (pglite://./data/pglite hoặc pglite:memory) */
export function pgliteDataDir() {
  const url = databaseUrl();
  const path = url.replace(/^pglite:\/\//, "").replace(/^pglite:/, "");
  return path === "memory" || path === "" ? undefined : path;
}

async function createPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dir = pgliteDataDir();
  if (dir) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(dir, { recursive: true });
    // PGlite chỉ cho phép MỘT tiến trình mở thư mục dữ liệu; mở đồng thời sẽ làm hỏng dữ liệu.
    const lockFile = path.join(dir, ".erp-lock");
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number; startedAt: string };
      if (existing.pid && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        throw new Error(
          `Thư mục dữ liệu PGlite "${dir}" đang được tiến trình khác (PID ${existing.pid}) sử dụng. ` +
            "Chế độ PGlite chỉ cho phép một tiến trình: hãy dừng server (Ctrl+C) trước khi chạy lệnh này, hoặc dùng các nút đồng bộ trên giao diện. " +
            "Để dùng đồng thời nhiều tiến trình, hãy chuyển sang PostgreSQL (docker compose up -d).",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Thư mục dữ liệu PGlite")) throw error;
      // không có lock hoặc lock hỏng → tiếp tục
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const release = () => {
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
        if (current.pid === process.pid) fs.unlinkSync(lockFile);
      } catch {
        // bỏ qua
      }
    };
    process.once("exit", release);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        release();
        process.exit(0);
      });
    }
  }
  const client = new PGlite(dir);
  instrumentQueries(client as unknown as QueryClient);
  holder.__erpDb!.pglite = client;
  return drizzle(client, { schema }) as unknown as Db;
}

function createPg(): Db {
  /**
   * BỂ KẾT NỐI PHẢI VỪA VỚI SỐ NHÂN CPU, KHÔNG PHẢI VỪA VỚI SỐ TRUY VẤN.
   *
   * Đo trên production 10/09/2026: VPS có **2 nhân**, `erp-db` ghim 105% CPU, load 15 phút 5,47.
   * Trang chủ bắn 181 lượt truy vấn cùng lúc (76 của bảng điều khiển + 105 của bản tóm tắt). Với
   * `max: 10`, mười tiến trình Postgres cùng tranh 2 nhân — mỗi câu 300ms thành 9 giây, và tổng
   * thời gian TĂNG so với chạy ít luồng hơn.
   *
   * Đây là chỗ trực giác đánh lừa: thêm luồng KHÔNG làm nhanh hơn khi CPU đã bão hoà, nó chỉ chia
   * nhỏ cùng một lượng CPU thành nhiều phần và cộng thêm chi phí chuyển ngữ cảnh.
   *
   * Cho phép chỉnh bằng `PGPOOL_MAX` để không phải deploy lại khi đổi cấu hình máy.
   */
  const max = Math.max(2, Number(process.env.PGPOOL_MAX) || 5);
  const pool = new Pool({ connectionString: databaseUrl(), max });
  instrumentQueries(pool as unknown as QueryClient);
  holder.__erpDb!.pool = pool;
  return drizzlePg(pool, { schema });
}

type QueryClient = { query: (...args: unknown[]) => Promise<unknown> };

/**
 * Bọc `client.query` để đếm SỐ CÂU và thời gian của từng câu trong một lần dựng trang.
 * Cả hai driver (node-postgres và PGlite) đều đi qua đúng hàm này, nên chỉ cần bọc một chỗ.
 *
 * CHỈ bật khi ERP_PERF_PROBE=1 (script đo dùng). Production không bọc gì cả: lớp CSDL là chỗ
 * không được thêm rủi ro để đổi lấy một con số.
 */
function instrumentQueries(client: QueryClient) {
  if (process.env.ERP_PERF_PROBE !== "1") return;
  const original = client.query.bind(client) as QueryClient["query"];
  client.query = async (...args: unknown[]) => {
    if (!probeActive()) return original(...args);
    const started = performance.now();
    try {
      const result = (await original(...args)) as { rows?: unknown[] } | undefined;
      recordQuery(queryText(args[0]), performance.now() - started, result?.rows?.length ?? 0);
      return result;
    } catch (error) {
      recordQuery(queryText(args[0]), performance.now() - started, -1);
      throw error;
    }
  };
}

function queryText(first: unknown) {
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) return String((first as { text: unknown }).text);
  return "(không rõ)";
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let pending: Promise<Db> | null = null;

/** Lấy kết nối DB (lazy). Dùng `await getDb()` trong server code. */
export async function getDb(): Promise<Db> {
  if (holder.__erpDb!.db) return holder.__erpDb!.db;
  if (!pending) {
    pending = (async () => {
      if (!databaseUrl()) throw new Error("Chưa cấu hình DATABASE_URL");
      const db = isPglite() ? await createPglite() : createPg();
      holder.__erpDb!.db = db;
      holder.__erpDb!.kind = isPglite() ? "pglite" : "pg";
      return db;
    })();
  }
  return pending;
}

export { schema };

/**
 * ═══════ CHẠY MỘT BÁO CÁO NẶNG MÀ KHÔNG BẬT JIT ═══════
 *
 * ĐO ĐƯỢC trên production 10/09/2026, cùng câu, cùng dữ liệu, cùng kế hoạch:
 *
 *   vsales · JIT BẬT   thực thi 8.578,82 ms   biên dịch JIT 17.036,85 ms (465 hàm)
 *   vsales · JIT TẮT   thực thi     26,02 ms   không biên dịch
 *
 * Số khối đệm giống hệt nhau (47.802 và 47.796) — cùng một khối lượng công việc. Toàn bộ chênh
 * lệch là THỜI GIAN BIÊN DỊCH. PostgreSQL bật JIT khi chi phí ước lượng vượt `jit_above_cost`
 * (mặc định 100.000), mà các báo cáo tồn kho có chi phí ước lượng hàng triệu vì chúng nối nhiều
 * bảng dẫn xuất. Trên máy 2 nhân, biên dịch 465 hàm tốn nhiều hơn chính phép tính hàng trăm lần.
 *
 * ─── VÌ SAO KHÔNG TẮT JIT TOÀN MÁY CHỦ ───
 *
 * Tắt ở `postgresql.conf` sẽ đổi hành vi cho MỌI thứ chạm vào CSDL này, kể cả những truy vấn chưa
 * ai đo. Ở đây chỉ tắt trong ĐÚNG giao dịch của báo cáo đang chạy: `set local` hết hiệu lực khi
 * giao dịch kết thúc, không rò sang phiên khác, không đụng cấu hình.
 *
 * ─── VÌ SAO CÓ NHÁNH DỰ PHÒNG ───
 *
 * Bộ kiểm thử chạy trên PGlite (PostgreSQL biên dịch sang WASM) và không phải bản dựng nào cũng
 * nhận `set local jit`. Không đặt được thì vẫn chạy tiếp — chậm hơn thì chấp nhận, còn hơn để báo
 * cáo đổ vỡ vì một tinh chỉnh hiệu năng.
 */
export async function chayKhongJit<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sqlRaw.raw("set local jit = off"));
      return fn(tx as unknown as Db);
    });
  } catch (error) {
    // Chỉ rơi về đường thường khi chính việc TẮT JIT hỏng. Lỗi của báo cáo phải ném lên như cũ.
    if (!(error instanceof Error) || !/jit/i.test(error.message)) throw error;
    return fn(db);
  }
}
