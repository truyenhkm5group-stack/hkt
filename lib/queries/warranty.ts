import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { warrantyCardState, type WarrantyCardState, type WarrantyClaimStatus, type WarrantyResolution } from "@/lib/constants/warranty";

/**
 * ═══════════ BẢO HÀNH — ĐỌC (docs/verticals/household.md) ═══════════
 *
 * «Còn bảo hành» của phiếu và «trong bảo hành lúc mở ca» của ca đều TÍNH Ở ĐÂY lúc đọc (`warrantyCardState`, so ngày mở ca giờ
 * VN với hạn) — không cột nào lưu chúng.
 */

export type WarrantyClaimView = {
  id: string;
  cardId: string;
  openedAt: string;
  issue: string;
  status: WarrantyClaimStatus;
  resolution: WarrantyResolution | null;
  rejectReason: string | null;
  costVnd: number | null;
  chargedVnd: number | null;
  assigneeName: string | null;
  closedAt: string | null;
  note: string;
  /** Ngày mở ca (giờ VN) có nằm trong hạn của phiếu không. */
  inWarrantyWhenOpened: boolean;
};

export type WarrantyCardView = {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  productName: string;
  serial: string | null;
  orderId: string | null;
  purchasedOn: string;
  months: number;
  expiresOn: string;
  status: string;
  voidReason: string | null;
  note: string;
  state: WarrantyCardState;
  daysLeft: number;
  claims: WarrantyClaimView[];
};

const vnDayOf = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

async function claimsFor(cards: { id: string; expiresOn: string }[]): Promise<Map<string, WarrantyClaimView[]>> {
  const out = new Map<string, WarrantyClaimView[]>();
  if (!cards.length) return out;
  const expiry = new Map(cards.map((c) => [c.id, c.expiresOn]));
  const db = await getDb();
  const cl = schema.warrantyClaims;
  const rows = await db
    .select({ c: cl, assignee: schema.users.name })
    .from(cl)
    .leftJoin(schema.users, eq(schema.users.id, cl.assigneeUserId))
    .where(inArray(cl.cardId, cards.map((c) => c.id)))
    .orderBy(desc(cl.openedAt));
  for (const r of rows) {
    const list = out.get(r.c.cardId) ?? [];
    list.push({
      id: r.c.id,
      cardId: r.c.cardId,
      openedAt: r.c.openedAt.toISOString(),
      issue: r.c.issue,
      status: r.c.status as WarrantyClaimStatus,
      resolution: (r.c.resolution as WarrantyResolution | null) ?? null,
      rejectReason: r.c.rejectReason,
      costVnd: r.c.costVnd,
      chargedVnd: r.c.chargedVnd,
      assigneeName: r.assignee ?? null,
      closedAt: r.c.closedAt ? r.c.closedAt.toISOString() : null,
      note: r.c.note,
      inWarrantyWhenOpened: vnDayOf(r.c.openedAt) <= (expiry.get(r.c.cardId) ?? ""),
    });
    out.set(r.c.cardId, list);
  }
  return out;
}

const cardColumns = {
  card: schema.warrantyCards,
  customerName: schema.customers.name,
  customerPhone: schema.customers.phone,
};

async function viewsOf(rows: { card: typeof schema.warrantyCards.$inferSelect; customerName: string; customerPhone: string | null }[], today: string): Promise<WarrantyCardView[]> {
  const claims = await claimsFor(rows.map((r) => ({ id: r.card.id, expiresOn: r.card.expiresOn })));
  return rows.map((r) => {
    const s = warrantyCardState(r.card, today);
    return {
      id: r.card.id,
      customerId: r.card.customerId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      productName: r.card.productName,
      serial: r.card.serial,
      orderId: r.card.orderId,
      purchasedOn: r.card.purchasedOn,
      months: r.card.months,
      expiresOn: r.card.expiresOn,
      status: r.card.status,
      voidReason: r.card.voidReason,
      note: r.card.note,
      state: s.state,
      daysLeft: s.daysLeft,
      claims: claims.get(r.card.id) ?? [],
    };
  });
}

/** Tra phiếu theo SĐT (bỏ ký tự không phải số) / serial / tên khách / tên sản phẩm. Rỗng ⇒ 50 phiếu mới nhất. */
export async function searchWarrantyCards(q: string, today: string = vnDayOf(new Date())): Promise<WarrantyCardView[]> {
  const db = await getDb();
  const term = q.trim().slice(0, 80);
  const digits = term.replace(/\D/g, "");
  const c = schema.warrantyCards;
  const where = term
    ? or(
        ilike(c.serial, `%${term}%`),
        ilike(c.productName, `%${term}%`),
        ilike(schema.customers.name, `%${term}%`),
        digits.length >= 4 ? sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : undefined,
      )
    : undefined;
  const rows = await db.select(cardColumns).from(c).innerJoin(schema.customers, eq(schema.customers.id, c.customerId)).where(where).orderBy(desc(c.createdAt)).limit(50);
  return viewsOf(rows, today);
}

/** Phiếu của MỘT khách (trang khách). */
export async function customerWarrantyCards(customerId: string, today: string = vnDayOf(new Date())): Promise<WarrantyCardView[]> {
  const db = await getDb();
  const c = schema.warrantyCards;
  const rows = await db.select(cardColumns).from(c).innerJoin(schema.customers, eq(schema.customers.id, c.customerId)).where(eq(c.customerId, customerId)).orderBy(desc(c.purchasedOn)).limit(100);
  return viewsOf(rows, today);
}

/** Ca đang mở / đang xử lý — hàng đợi của người làm bảo hành, cũ nhất trước. */
export async function openWarrantyClaims(today: string = vnDayOf(new Date())): Promise<(WarrantyClaimView & { card: Pick<WarrantyCardView, "id" | "productName" | "serial" | "customerId" | "customerName" | "customerPhone" | "expiresOn"> })[]> {
  const db = await getDb();
  const cl = schema.warrantyClaims;
  const ids = await db.select({ cardId: cl.cardId }).from(cl).where(inArray(cl.status, ["OPEN", "IN_PROGRESS"])).orderBy(asc(cl.openedAt)).limit(200);
  if (!ids.length) return [];
  const c = schema.warrantyCards;
  const rows = await db.select(cardColumns).from(c).innerJoin(schema.customers, eq(schema.customers.id, c.customerId)).where(inArray(c.id, [...new Set(ids.map((i) => i.cardId))]));
  const views = await viewsOf(rows, today);
  return views
    .flatMap((v) => v.claims.filter((x) => x.status === "OPEN" || x.status === "IN_PROGRESS").map((x) => ({ ...x, card: { id: v.id, productName: v.productName, serial: v.serial, customerId: v.customerId, customerName: v.customerName, customerPhone: v.customerPhone, expiresOn: v.expiresOn } })))
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export type WarrantyFormOptions = {
  customers: { id: string; name: string; phone: string | null }[];
  products: { id: string; label: string }[];
  staff: { id: string; name: string }[];
};

/** Lựa chọn của form lập phiếu / mở ca: khách, sản phẩm (mẫu mã đang bán), người nhận ca (tài khoản đang hoạt động). */
export async function warrantyFormOptions(): Promise<WarrantyFormOptions> {
  const db = await getDb();
  const [customers, products, staff] = await Promise.all([
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone }).from(schema.customers).orderBy(asc(schema.customers.name)).limit(2000),
    db
      .select({ id: schema.productVariants.id, name: schema.products.name, detail: schema.productVariants.detail, size: schema.productVariants.size })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(and(eq(schema.productVariants.isRemoved, false), eq(schema.products.isRemoved, false)))
      .orderBy(asc(schema.products.name))
      .limit(2000),
    db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name)).limit(500),
  ]);
  return { customers, products: products.map((p) => ({ id: p.id, label: [p.name, p.detail.trim() || p.size.trim()].filter(Boolean).join(" · ") })), staff };
}
