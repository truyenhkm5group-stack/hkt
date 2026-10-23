/**
 * ═══ TIN CHO NGƯỜI VẬN HÀNH NỀN TẢNG: CHUỖI LÙI KÊNH + VẾT GỬI (P0 cạn credit AI, 24/10/2026) — CHỈ MÁY CHỦ ═══
 *
 * Đo 23/10/2026: `sales-health` phát hiện hslc AI = CRITICAL · CREDIT lúc 19:52Z, hai phút sau lỗi đầu — phát hiện KHÔNG chậm. Chỗ
 * hụt là đường gửi: `notifyPlatformOperator` là if / else (có Lark thì CHỈ Lark; Lark hỏng ⇒ «FAILED», không lùi sang Telegram) và
 * kết quả gửi bị bỏ, nên không ai trả lời được «tin có tới nhóm VNX không».
 *
 *  · `deliverThroughChain` — thử LẦN LƯỢT từng kênh đã cấu hình, DỪNG ở kênh đầu tiên nhận (không gửi trùng). Hàm thuần theo các
 *    hàm gửi nó nhận vào, để bài kiểm chạy bằng kênh giả.
 *  · Vết ở CSDL nhà (`platform_operator_alerts`) theo (tổ chức, khoá chống trùng của tin) — khoá chống trùng của một quyết định
 *    sức khoẻ giống nhau giữa các tổ chức, nên khoá vết luôn kèm mã tổ chức. Chỉ mã tổ chức + tiêu đề, không dữ liệu khách.
 *  · Bảng chưa có (CSDL nhà chưa áp 0259) ⇒ đọc «chưa có vết», ghi bỏ qua; tin vẫn gửi qua chuỗi (MIGRATION_SERVE_COMPAT).
 */
import { and, eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";

export const OPERATOR_CHANNELS = ["LARK_MANAGER", "LARK", "TELEGRAM"] as const;
export type OperatorChannel = (typeof OPERATOR_CHANNELS)[number];
export type OperatorNotifyResult = "SENT" | "NO_CHANNEL" | "FAILED";

export type ChannelAttempt = { channel: OperatorChannel; send: () => Promise<{ ok: boolean; error?: string }> };
export type ChainOutcome = { result: OperatorNotifyResult; channel: OperatorChannel | null; errors: { channel: OperatorChannel; error: string }[] };

/** Che chuỗi lỗi trước khi lưu: bỏ URL (webhook mang khoá trong đường dẫn) và chuỗi dài giống khoá / token. */
export function redactChannelError(e: string): string {
  return e
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<token>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<khoá>")
    .slice(0, 300);
}

/** Thử lần lượt; kênh đầu tiên nhận ⇒ SENT và DỪNG. Không kênh nào ⇒ NO_CHANNEL. Mọi kênh hỏng ⇒ FAILED kèm lỗi từng kênh. */
export async function deliverThroughChain(attempts: readonly ChannelAttempt[]): Promise<ChainOutcome> {
  if (!attempts.length) return { result: "NO_CHANNEL", channel: null, errors: [] };
  const errors: ChainOutcome["errors"] = [];
  for (const a of attempts) {
    try {
      const r = await a.send();
      if (r.ok) return { result: "SENT", channel: a.channel, errors };
      errors.push({ channel: a.channel, error: redactChannelError(r.error ?? "kênh từ chối") });
    } catch (e) {
      errors.push({ channel: a.channel, error: redactChannelError(e instanceof Error ? e.message : "lỗi lạ") });
    }
  }
  return { result: "FAILED", channel: null, errors };
}

function isMissingTable(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return (x?.code ?? x?.cause?.code) === "42P01";
}

const t = schema.platformOperatorAlerts;
/** Khoá vết — cùng một phép cắt ở đọc và ghi, để khoá dài không bao giờ lệch nhau. */
const keyOf = (k: string) => k.slice(0, 300);

/** Kết quả đã ghi của MỘT tin; `null` = chưa có vết (chưa gửi lần nào, hoặc CSDL nhà chưa áp 0259). */
export async function readOperatorAlertResult(orgCode: string, dedupeKey: string): Promise<OperatorNotifyResult | null> {
  try {
    const pdb = await getPlatformDb();
    const [row] = await pdb.select({ result: t.result }).from(t).where(and(eq(t.orgCode, orgCode), eq(t.dedupeKey, keyOf(dedupeKey)))).limit(1);
    return (row?.result as OperatorNotifyResult | undefined) ?? null;
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/** Ghi / cộng dồn vết một lượt gửi. Lượt sau SENT ghi đè FAILED trước đó; số lần thử cộng dồn. Không ném vì bảng chưa có. */
export async function recordOperatorAlert(input: { orgCode: string; dedupeKey: string; title: string; outcome: ChainOutcome; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const lastError = input.outcome.errors.length ? input.outcome.errors.map((x) => `${x.channel}: ${x.error}`).join(" · ").slice(0, 600) : null;
  try {
    const pdb = await getPlatformDb();
    await pdb
      .insert(t)
      .values({ orgCode: input.orgCode, dedupeKey: keyOf(input.dedupeKey), title: input.title.slice(0, 300), result: input.outcome.result, channel: input.outcome.channel, attempts: 1, lastError, firstAt: now, lastAt: now })
      .onConflictDoUpdate({
        target: [t.orgCode, t.dedupeKey],
        set: { result: input.outcome.result, channel: input.outcome.channel, attempts: sql`${t.attempts} + 1`, lastError, lastAt: now },
      });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
}
