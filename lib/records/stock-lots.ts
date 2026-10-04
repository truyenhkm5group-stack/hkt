import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { isLotDay, LOT_LIMITS, normalizeLotCode } from "@/lib/constants/lots";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import type { FieldError } from "@/lib/metadata/types";

/**
 * ═══════════ LÔ & HẠN DÙNG — ĐƯỜNG GHI (docs/verticals/food-lots.md) ═══════════
 *
 *  · Mọi lượt ghi cần `lots:write` (khoá của module `lots` — tắt module ⇒ `can()` từ chối).
 *  · Lô chỉ gắn lên dòng phiếu kho DƯƠNG (nhập mới / tái nhập / điều chỉnh tăng). Tổng các lô của một dòng KHÔNG vượt số của
 *    dòng — kiểm trong giao dịch sau khoá tư vấn theo dòng, hai người gắn cùng lúc không vượt được.
 *  · KHÔNG đường nào ở đây ghi `stock_receipts` / `stock_receipt_items`: lô không đổi một cái tồn nào (luật 10). Hàng hết hạn
 *    phải huỷ thì lập phiếu XUẤT KHO như mọi lần xuất tay.
 *  · Người thao tác đi bằng khoá tài khoản; tên là ảnh chụp do máy chủ đọc (luật 34). Gỡ lô cần lý do.
 */

export type LotResult = { ok: true; id: string; message: string } | MetaFailure;

function zodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}

function gate(user: SessionUser): MetaFailure | null {
  return can(user, "lots:write") ? null : fail("FORBIDDEN", "Bạn không có quyền gắn / gỡ lô (lots:write).");
}

const showDay = (d: string) => d.split("-").reverse().join("/");

/** Loại phiếu mang hàng VÀO kho — chỉ dòng dương của chúng mới gắn lô được. */
const INBOUND_KINDS = ["RECEIPT", "RETURN", "ADJUSTMENT"] as const;

const lotZ = z
  .object({
    receiptItemId: z.string({ error: "Chọn dòng phiếu nhập" }).trim().min(1, "Chọn dòng phiếu nhập").max(200),
    lotCode: z.string({ error: "Nhập mã lô" }).max(200),
    expiresOn: z.string({ error: "Nhập hạn dùng" }).refine(isLotDay, "Hạn dùng dạng YYYY-MM-DD"),
    producedOn: z.string().refine(isLotDay, "Ngày sản xuất dạng YYYY-MM-DD").nullable().default(null),
    quantity: z.number({ error: "Nhập số lượng" }).int("Số lượng là số nguyên").min(1, "Ít nhất 1").max(LOT_LIMITS.maxQty),
    note: z.string().trim().max(LOT_LIMITS.noteMax).default(""),
  })
  .strict();

export type StockLotInput = z.input<typeof lotZ>;

export async function createStockLotCore(user: SessionUser, raw: unknown): Promise<LotResult> {
  const denied = gate(user);
  if (denied) return denied;
  const parsed = lotZ.safeParse(raw);
  if (!parsed.success) return fail("INVALID", zodErrors(parsed.error));
  const v = parsed.data;
  const code = normalizeLotCode(v.lotCode);
  if (!code) return fail("INVALID", [{ field: "lotCode", message: "Nhập mã lô." }]);
  if (v.producedOn && v.producedOn > v.expiresOn) return fail("INVALID", [{ field: "producedOn", message: "Ngày sản xuất phải trước hạn dùng." }]);
  const db = await getDb();
  const ri = schema.stockReceiptItems;
  const r = schema.stockReceipts;
  const [item] = await db.select({ id: ri.id, variantId: ri.variantId, quantity: ri.quantity, kind: r.kind, receivedAt: r.receivedAt }).from(ri).innerJoin(r, eq(r.id, ri.receiptId)).where(eq(ri.id, v.receiptItemId)).limit(1);
  if (!item) return fail("INVALID", [{ field: "receiptItemId", message: "Dòng phiếu không tồn tại." }]);
  if (!(INBOUND_KINDS as readonly string[]).includes(item.kind) || item.quantity <= 0) return fail("INVALID", [{ field: "receiptItemId", message: "Chỉ gắn lô lên dòng phiếu đưa hàng VÀO kho." }]);
  const id = crypto.randomUUID();
  const l = schema.stockLots;
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stock-lot-item:${item.id}`}))`);
    const [agg] = await tx.select({ used: sql<number>`coalesce(sum(${l.quantity}), 0)::int` }).from(l).where(eq(l.receiptItemId, item.id));
    const used = Number(agg?.used ?? 0);
    if (used + v.quantity > item.quantity) return { over: item.quantity - used };
    const [dup] = await tx.select({ id: l.id }).from(l).where(and(eq(l.receiptItemId, item.id), sql`lower(${l.lotCode}) = ${code.toLowerCase()}`)).limit(1);
    if (dup) return { dup: true };
    await tx.insert(l).values({ id, receiptItemId: item.id, variantId: item.variantId, lotCode: code, expiresOn: v.expiresOn, producedOn: v.producedOn, quantity: v.quantity, note: v.note, createdByUserId: user.id, createdByName: user.name });
    return { ok: true };
  });
  if ("over" in outcome) return fail("CONFLICT", [{ field: "quantity", message: `Dòng phiếu chỉ còn ${Math.max(0, outcome.over ?? 0)} cái chưa gắn lô.` }]);
  if ("dup" in outcome) return fail("CONFLICT", [{ field: "lotCode", message: `Mã lô «${code}» đã gắn trên dòng phiếu này.` }]);
  await audit({ userId: user.id, userEmail: user.email, action: "STOCK_LOT_CREATE", entity: "STOCK_LOT", entityId: id, before: null, after: { receiptItemId: item.id, variantId: item.variantId, lotCode: code, expiresOn: v.expiresOn, quantity: v.quantity }, reason: "Gắn lô lên phiếu nhập" });
  return { ok: true, id, message: `Đã gắn lô «${code}» · ${v.quantity} cái · hạn ${showDay(v.expiresOn)}.` };
}

/** Gỡ lô gắn nhầm — bắt buộc lý do. Không đụng phiếu kho, không đổi tồn. */
export async function deleteStockLotCore(user: SessionUser, id: string, reason: string): Promise<LotResult> {
  const denied = gate(user);
  if (denied) return denied;
  const why = (reason ?? "").trim();
  if (why.length < LOT_LIMITS.reasonMin) return fail("INVALID", [{ field: "reason", message: "Ghi lý do gỡ lô (ít nhất 3 ký tự)." }]);
  const db = await getDb();
  const l = schema.stockLots;
  const [row] = await db.delete(l).where(eq(l.id, id)).returning({ id: l.id, lotCode: l.lotCode, expiresOn: l.expiresOn, quantity: l.quantity, receiptItemId: l.receiptItemId });
  if (!row) return fail("NOT_FOUND", "Không có lô này.");
  await audit({ userId: user.id, userEmail: user.email, action: "STOCK_LOT_DELETE", entity: "STOCK_LOT", entityId: id, before: row, after: null, reason: why });
  return { ok: true, id, message: `Đã gỡ lô «${row.lotCode}».` };
}
