import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { parseUnsubscribeToken, WHOLESALE_UNSUBSCRIBE_PREFIX } from "@/lib/constants/email-unsubscribe";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization, isOperationalOrganization } from "@/lib/platform/organizations";
import { isMissingEmailTable, recordEmailEvent, stopPendingEmails } from "@/lib/wholesale/email-outbox-store";

/**
 * ═══════════ HUỶ ĐĂNG KÝ EMAIL BÁN SỈ — LÕI (CHỈ MÁY CHỦ, E1) ═══════════
 *
 * Token `vnxu1.<mã tổ chức>.<bí mật>` (`lib/constants/email-unsubscribe.ts`): mã tổ chức chọn CSDL, bí mật chỉ lưu BĂM trong
 * CSDL của chính tổ chức đó. Mọi nhánh sai (dạng hỏng · tổ chức không có / không hoạt động · CSDL chưa áp 0264 · băm không khớp)
 * trả CÙNG một `NOT_FOUND` — route in cùng một trang 404, không nói tổ chức có tồn tại hay token từng đúng.
 *
 * Không hỏi module có bật không: người nhận có quyền huỷ đăng ký kể cả khi shop đã tắt module — tắt module không được làm link
 * huỷ trong những thư ĐÃ gửi thành link chết.
 *
 * Huỷ = (1) điền `used_at` MỘT lần (điều kiện `used_at IS NULL` trong câu UPDATE — hai cú bấm cùng lúc chỉ một lượt ghi);
 * (2) thêm dòng chặn EMAIL; (3) sự kiện UNSUBSCRIBE (khoá chống trùng theo token); (4) dừng mọi thư chưa gửi của lead;
 * (5) một dòng lịch sử lead. Bấm lại ⇒ trang «đã huỷ», không ghi thêm.
 */

export function hashUnsubscribeSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Phát token cho MỘT thư (gửi lại sau lỗi tạm ⇒ thay băm của chính dòng đó: link cũ chưa từng ra khỏi ERP). Trả token đầy đủ. */
export async function issueUnsubscribeToken(orgCode: string, input: { leadId: string; email: string; outboxId: string }, now: Date): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  const token = `vnxu1.${orgCode}.${secret}`;
  if (!parseUnsubscribeToken(token)) throw new Error("Mã tổ chức không dùng được trong token huỷ đăng ký.");
  const db = await getDb();
  const t = schema.wholesaleUnsubscribeTokens;
  await db
    .insert(t)
    .values({ tokenHash: hashUnsubscribeSecret(secret), leadId: input.leadId, email: input.email, outboxId: input.outboxId, createdAt: now })
    .onConflictDoUpdate({ target: t.outboxId, set: { tokenHash: hashUnsubscribeSecret(secret), email: input.email, createdAt: now } });
  return token;
}

export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${WHOLESALE_UNSUBSCRIBE_PREFIX}${token}`;
}

/** Che email để trang xác nhận không lộ địa chỉ đầy đủ cho người cầm link chuyển tiếp: `ch***@nhahang.vn`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`;
}

export type UnsubscribeOutcome = { status: "NOT_FOUND" } | { status: "OK"; maskedEmail: string; alreadyUsed: boolean; applied: boolean };

/**
 * `apply = false` (GET): chỉ ĐỌC — người / máy quét link trong hộp thư mở link không được huỷ hộ ai. `apply = true` (POST một
 * chạm hoặc nút trên trang): huỷ.
 */
export async function resolveUnsubscribe(rawToken: string, opts: { apply: boolean; via: "ONE_CLICK" | "PAGE"; now?: Date }): Promise<UnsubscribeOutcome> {
  const parsed = parseUnsubscribeToken(rawToken);
  if (!parsed) return { status: "NOT_FOUND" };
  const org = await findOrganization(parsed.orgCode);
  if (!org || !isOperationalOrganization(org)) return { status: "NOT_FOUND" };
  const now = opts.now ?? new Date();
  return withOrganization(org.code, async (): Promise<UnsubscribeOutcome> => {
    const db = await getDb();
    const t = schema.wholesaleUnsubscribeTokens;
    let row: typeof t.$inferSelect | undefined;
    try {
      [row] = await db.select().from(t).where(eq(t.tokenHash, hashUnsubscribeSecret(parsed.secret))).limit(1);
    } catch (e) {
      if (isMissingEmailTable(e)) return { status: "NOT_FOUND" };
      throw e;
    }
    if (!row) return { status: "NOT_FOUND" };
    const masked = maskEmail(row.email);
    if (!opts.apply || row.usedAt) return { status: "OK", maskedEmail: masked, alreadyUsed: !!row.usedAt, applied: false };
    const won = await db
      .update(t)
      .set({ usedAt: now, usedVia: opts.via })
      .where(and(eq(t.id, row.id), isNull(t.usedAt)))
      .returning({ id: t.id });
    if (!won.length) return { status: "OK", maskedEmail: masked, alreadyUsed: true, applied: false };
    await db
      .insert(schema.wholesaleSuppressions)
      .values({ kind: "EMAIL", value: row.email, reason: "Khách tự huỷ đăng ký email (link trong thư)", leadId: row.leadId, createdByUserId: null, createdByName: "Khách tự huỷ đăng ký", createdAt: now })
      .onConflictDoNothing();
    await recordEmailEvent({ leadId: row.leadId, outboxId: row.outboxId, kind: "UNSUBSCRIBE", providerEventId: `unsub:${row.id}`, meta: { via: opts.via }, at: now });
    const stopped = await stopPendingEmails(row.leadId, "Khách đã huỷ đăng ký email", now);
    await db.insert(schema.wholesaleLeadActivities).values({
      leadId: row.leadId,
      kind: "OUTREACH",
      channel: "EMAIL",
      outcome: "DO_NOT_CONTACT",
      note: `Khách tự huỷ đăng ký email (${opts.via === "ONE_CLICK" ? "nút một chạm của hộp thư" : "trang xác nhận"}) — đã chặn email ${row.email}${stopped ? `, dừng ${stopped} thư chưa gửi` : ""}.`,
      actorId: null,
      actorName: "Khách (link huỷ đăng ký)",
      createdAt: now,
    });
    return { status: "OK", maskedEmail: masked, alreadyUsed: false, applied: true };
  });
}
