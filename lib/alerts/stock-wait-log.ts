import { and, isNull, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { StockShortageSnapshot } from "@/lib/constants/stock-shortage";
import { getStockShortage } from "@/lib/queries/stock-shortage";

/**
 * ═══════════ GHI SỔ ĐƠN CHỜ HÀNG ═══════════
 *
 * Chạy trong job `alerts` (10 phút/lần), ĐỘC LẬP với việc có gửi tin Lark hay không: tắt tin nhắn
 * không được làm mất phép đo. Mỗi lượt:
 *
 *   · đơn ERP kết luận `WAITING_STOCK` → mở dòng (hoặc mở lại nếu đã đóng), cập nhật `last_seen_at`;
 *   · dòng đang mở mà đơn KHÔNG còn chờ → đóng bằng `cleared_at` = lúc ghi.
 *
 * Độ phân giải là một lượt job: mốc đóng muộn nhất ~10 phút so với lúc đơn thật sự hết chờ. Job
 * ngừng chạy thì dòng mở vẫn mở và các ngày ngừng chạy được tính là còn chờ — lượt chạy lại sẽ đóng.
 *
 * Chỉ ghi `stock_wait_log`. Không đổi đơn, không đổi tồn, không tạo việc.
 */

const MIN_INTERVAL_MS = 5 * 60_000;
const CHUNK = 500;
const holder = globalThis as unknown as { __erpStockWaitLogAt?: number };

export type StockWaitLogResult = { waiting: number; opened: number; closed: number; skipped?: string; error?: string };

/** Nhãn mẫu thiếu của một đơn — ảnh chụp để người đọc. */
function labelsOf(lines: { label: string; short: number }[]): string {
  return lines.map((l) => `${l.label} ×${l.short}`).join(", ").slice(0, 500);
}

/** Ghi sổ từ một ảnh chụp thiếu hàng. Tách riêng để kiểm thử dùng đúng đường ghi này. */
export async function writeStockWaitLog(snapshot: StockShortageSnapshot, now: Date): Promise<StockWaitLogResult> {
  const db = await getDb();
  const w = schema.stockWaitLog;
  const waiting = [...snapshot.orders.values()].filter((o) => o.state === "WAITING_STOCK");
  const ids = waiting.map((o) => o.orderId);
  const before = await db.select({ orderId: w.orderId }).from(w).where(isNull(w.clearedAt));
  const openBefore = new Set(before.map((r) => r.orderId));

  for (let i = 0; i < waiting.length; i += CHUNK) {
    const rows = waiting.slice(i, i + CHUNK).map((o) => ({
      orderId: o.orderId,
      firstSeenAt: now,
      lastSeenAt: now,
      clearedAt: null,
      maxShortUnits: o.shortLines.reduce((t, l) => t + l.short, 0),
      shortLabels: labelsOf(o.shortLines),
      episodes: 1,
    }));
    await db
      .insert(w)
      .values(rows)
      .onConflictDoUpdate({
        target: w.orderId,
        set: {
          lastSeenAt: now,
          clearedAt: null,
          // Đơn đã đóng mà chờ lại ⇒ một đợt mới; mốc đầu GIỮ NGUYÊN.
          episodes: sql`${w.episodes} + case when ${w.clearedAt} is null then 0 else 1 end`,
          maxShortUnits: sql`greatest(${w.maxShortUnits}, excluded.max_short_units)`,
          shortLabels: sql`excluded.short_labels`,
        },
      });
  }

  const closeWhere = ids.length ? and(isNull(w.clearedAt), notInArray(w.orderId, ids)) : isNull(w.clearedAt);
  const closed = await db.update(w).set({ clearedAt: now }).where(closeWhere).returning({ orderId: w.orderId });
  return { waiting: waiting.length, opened: ids.filter((id) => !openBefore.has(id)).length, closed: closed.length };
}

/** Lượt tự động của job `alerts`. Trần nhịp 5 phút: job còn chạy sau mỗi đợt webhook. */
export async function runStockWaitLog(opts: { now?: Date } = {}): Promise<StockWaitLogResult> {
  const now = opts.now ?? new Date();
  if (holder.__erpStockWaitLogAt && now.getTime() - holder.__erpStockWaitLogAt < MIN_INTERVAL_MS) {
    return { waiting: 0, opened: 0, closed: 0, skipped: "vừa ghi trong 5 phút qua" };
  }
  holder.__erpStockWaitLogAt = now.getTime();
  // Dùng đệm 60 giây của bảng thiếu hàng (chung với trang và hàng đợi fulfillment) — độ phân giải
  // của sổ là một lượt job, lệch thêm tối đa một phút không đổi được con số theo ngày.
  const snapshot = await getStockShortage();
  return writeStockWaitLog(snapshot, now);
}
