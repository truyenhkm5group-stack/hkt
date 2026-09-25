"use server";

import { and, eq, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { marketerPriceCutoff } from "@/lib/constants/marketer-price";
import { normalizeProductCode } from "@/lib/constants/workshop-ledger";
import { vnStartOfDay } from "@/lib/format";
import { frozenPayrollOverlapping } from "@/lib/queries/marketer-price";
import { resolveProductByCode } from "@/lib/queries/product-code";

/**
 * ═══════════ GIÁ BÁO MKT — ĐƯỜNG GHI ═══════════
 *
 * Giá báo đổi LƯƠNG của marketer, nên đòi `payroll:manage` (cùng quyền với "Marketer phụ trách mã").
 * Mỗi lần đổi giá là MỘT DÒNG MỚI có ngày hiệu lực — không sửa đè dòng cũ, để lịch sử "Q002 báo
 * 150.000 từ đầu, hạ 120.000 từ 15/11 để xả tồn" còn nguyên và đọc lại được.
 *
 * KHÔNG SỬA LÙI VÀO KỲ LƯƠNG ĐÃ KHOÁ: một dòng giá áp từ ngày hiệu lực tới dòng kế tiếp, nên cả
 * khoảng đó không được chồng lên kỳ `LOCKED`/`PAID` (AGENTS.md mục 7, 21).
 */

type Result = { ok: true } | { error: string };

const priceInput = z.object({
  productCode: z.string().trim().min(1, "Nhập mã hàng").max(50),
  price: z.coerce.number().int().min(0, "Giá báo không âm").max(100_000_000),
  effectiveFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày hiệu lực không hợp lệ"),
  reason: z.string().trim().max(300).default(""),
});

/**
 * Kỳ lương đã khoá mà một dòng giá [from, next) CHẠM TỚI. Chỉ xét phần từ ngày bắt đầu áp dụng: dòng
 * khai "từ đầu vòng đời" (vd 01/07) không đổi được đơn tháng 7–8, nên không được chặn vì tháng 7–8.
 */
async function lockedPeriodTouched(productId: string, from: Date): Promise<string | null> {
  const next = await nextEntryAfter(productId, from);
  const cutoff = marketerPriceCutoff();
  if (next && next < cutoff) return null;
  return frozenPayrollOverlapping(from < cutoff ? cutoff : from, next);
}

async function nextEntryAfter(productId: string, from: Date): Promise<Date | null> {
  const db = await getDb();
  const [row] = await db
    .select({ at: schema.marketerPrices.effectiveFrom })
    .from(schema.marketerPrices)
    .where(and(eq(schema.marketerPrices.productId, productId), gt(schema.marketerPrices.effectiveFrom, from)))
    .orderBy(schema.marketerPrices.effectiveFrom)
    .limit(1);
  return row ? new Date(row.at.getTime() - 1) : null;
}

export async function setMarketerPrice(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Đặt giá báo MKT cần quyền Lương: khai báo nhân sự & chia mã" };
  const parsed = priceInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const code = normalizeProductCode(d.productCode);
  const product = await resolveProductByCode(code);
  if (!product) return { error: `Mã ${code} không khớp đúng một sản phẩm đang bán — giá báo phải gắn đúng một mã` };
  const from = vnStartOfDay(d.effectiveFrom);
  const khoa = await lockedPeriodTouched(product.id, from);
  if (khoa) return { error: `Giá này sẽ áp vào kỳ lương đã khoá (${khoa}) — chọn ngày hiệu lực sau kỳ đó` };
  const db = await getDb();
  const [row] = await db
    .insert(schema.marketerPrices)
    .values({ productId: product.id, productCode: code, price: d.price, effectiveFrom: from, reason: d.reason, setByUserId: user.id, setBy: user.name || user.email })
    .onConflictDoUpdate({
      target: [schema.marketerPrices.productId, schema.marketerPrices.effectiveFrom],
      set: { price: d.price, reason: d.reason, setByUserId: user.id, setBy: user.name || user.email, productCode: code },
    })
    .returning({ id: schema.marketerPrices.id });
  await audit({ userId: user.id, userEmail: user.email, action: "MARKETER_PRICE_SET", entity: "MARKETER_PRICE", entityId: row.id, detail: { code, price: d.price, effectiveFrom: d.effectiveFrom, reason: d.reason } });
  revalidatePath("/inventory/workshop");
  revalidatePath("/payroll");
  revalidatePath("/reports");
  return { ok: true };
}

export async function deleteMarketerPrice(id: string): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: "Xoá giá báo MKT cần quyền Lương: khai báo nhân sự & chia mã" };
  const db = await getDb();
  const row = await db.query.marketerPrices.findFirst({ where: eq(schema.marketerPrices.id, id) });
  if (!row) return { error: "Không tìm thấy dòng giá báo" };
  const khoa = await lockedPeriodTouched(row.productId, row.effectiveFrom);
  if (khoa) return { error: `Dòng giá này đã áp vào kỳ lương đã khoá (${khoa}) — không xoá được` };
  await db.delete(schema.marketerPrices).where(eq(schema.marketerPrices.id, id));
  await audit({ userId: user.id, userEmail: user.email, action: "MARKETER_PRICE_DELETE", entity: "MARKETER_PRICE", entityId: id, detail: { code: row.productCode, price: row.price, effectiveFrom: row.effectiveFrom, setBy: row.setBy } });
  revalidatePath("/inventory/workshop");
  revalidatePath("/payroll");
  revalidatePath("/reports");
  return { ok: true };
}
