import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * ═══════════ NHỊP TIM CỦA ĐƯỜNG "BẢNG KÊ VỀ QUA GMAIL" ═══════════
 *
 * Đoạn Apps Script trong Gmail (`docs/GMAIL-BANG-KE-VTP.md`) chỉ gọi sang ERP KHI CÓ THƯ MỚI.
 * Nên khi bảng kê im vài ngày, ERP không có cách nào phân biệt hai chuyện hoàn toàn khác nhau:
 *
 *   · Viettel Post chưa gửi bảng kê nào — đường dẫn vẫn tốt, không có gì phải làm;
 *   · script đã tắt / sai tham số bí mật / trình kích hoạt bị gỡ — tiền COD về mà ERP không biết.
 *
 * Đã xảy ra thật ngày 12/09/2026: trang Kết nối dữ liệu báo "67 giờ không nhận được gì" trong khi
 * trình kích hoạt bên Gmail vẫn chạy đủ mỗi 15 phút với tỷ lệ lỗi 0,22%. Không ai nói được bên nào
 * đúng, vì ERP chỉ thấy được những lượt CÓ tệp.
 *
 * Vì vậy MỌI lượt chạy của script đều báo sang, kể cả lượt không có thư. Nhịp tim ghi vào
 * `sync_state` chứ KHÔNG ghi `sync_runs`: 96 lượt "không làm gì" mỗi ngày sẽ chôn mất chính những
 * lần chạy thật mà bảng lịch sử đồng bộ sinh ra để cho thấy.
 */
export const STATEMENT_MAIL_HEARTBEAT_KEY = "viettelpost:statement-mail-heartbeat";

/**
 * Script chạy 15 phút một lần. Quá 2 giờ tức là đã lỡ 8 lượt liên tiếp — im lặng ở mức đó không
 * còn giải thích được bằng một lượt chạy trượt, nên mới hạ mức sức khoẻ.
 * (Chỉ là ngưỡng QUAN SÁT đường truyền, không phải ngưỡng nghiệp vụ.)
 */
export const STATEMENT_MAIL_SILENCE_HOURS = 2;

export type StatementMailHeartbeat = {
  /** ISO — lần cuối script liên lạc, dù có tệp hay không. */
  at: string;
  /** `GMAIL:…` — ai gọi sang. */
  actor: string;
  /** Số tệp của lượt đó (0 = lượt không có thư mới). */
  files: number;
  /** Số tệp ERP nhập được. */
  imported: number;
  /** PING | IMPORTED | FAILED — lượt đó kết thúc thế nào. */
  outcome: "PING" | "IMPORTED" | "FAILED";
};

/** Ghi lại rằng script vừa liên lạc. Không bao giờ làm hỏng lần nhập nếu ghi không được. */
export async function recordStatementMailContact(value: Omit<StatementMailHeartbeat, "at">) {
  try {
    const db = await getDb();
    const beat: StatementMailHeartbeat = { ...value, at: new Date().toISOString() };
    await db
      .insert(schema.syncState)
      .values({ key: STATEMENT_MAIL_HEARTBEAT_KEY, value: beat })
      .onConflictDoUpdate({ target: schema.syncState.key, set: { value: beat, updatedAt: new Date() } });
  } catch (e) {
    console.warn(`[vtp-statement] không ghi được nhịp tim: ${e instanceof Error ? e.message : e}`);
  }
}

/** Nhịp tim gần nhất. `null` = script chưa từng báo sống ⇒ CHƯA BIẾT, không phải "đã chết". */
export async function readStatementMailHeartbeat(): Promise<StatementMailHeartbeat | null> {
  try {
    const db = await getDb();
    const row = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, STATEMENT_MAIL_HEARTBEAT_KEY) });
    const value = row?.value as Partial<StatementMailHeartbeat> | undefined;
    if (!value?.at) return null;
    return {
      at: String(value.at),
      actor: String(value.actor ?? ""),
      files: Number(value.files ?? 0),
      imported: Number(value.imported ?? 0),
      outcome: value.outcome === "IMPORTED" || value.outcome === "FAILED" ? value.outcome : "PING",
    };
  } catch {
    return null;
  }
}
