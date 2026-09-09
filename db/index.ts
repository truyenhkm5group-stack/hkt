import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { pgliteDirectory } from "@/lib/local-mode";
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
  // Cách tách đường dẫn nằm ở `lib/local-mode.ts` để lệnh dựng bản test và lớp CSDL hiểu giống nhau.
  return pgliteDirectory(databaseUrl()) ?? undefined;
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
  const pool = new Pool({ connectionString: databaseUrl(), max: 10 });
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
