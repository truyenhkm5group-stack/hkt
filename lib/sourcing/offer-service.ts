/**
 * Kho mẫu nguồn nhập tay (SRC-3) — LÕI GHI (chỉ máy chủ). Server action (`lib/actions/sourcing-offers.ts`) kiểm phiên + quyền
 * `sourcing:write` rồi gọi vào đây với người thao tác; lõi làm zod → CSDL tổ chức → audit. Bài kiểm gọi thẳng lõi.
 *  · Chống trùng HAI khoá: (nền tảng, mã) và link chuẩn hoá — trùng thì KHÔNG tạo, trả về mẫu đã có (kể cả mẫu đang lưu trữ).
 *  · Ảnh chụp giá CHỈ THÊM: không có đường sửa / xoá một lần chụp.
 *  · Không xoá cứng: lưu trữ (`archived_at`) / khôi phục, có lý do.
 *  · Bảng chưa có (CSDL chưa áp 0256) ⇒ trả câu lỗi, không ghi gì.
 */
import { and, eq, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { SOURCING_PRICE_TIERS_MAX } from "@/lib/constants/sourcing";
import { isMissingSourcingTable } from "@/lib/queries/sourcing";
import { canonicalShopUrl, imageKey, parseOfferUrl, safeHttpUrl } from "@/lib/sourcing/offer-url";
import { parseCnyInput, parseHundredthsInput, serializePriceTiers, validatePriceTiers, type PriceTier } from "@/lib/sourcing/price";
import { serializeSkus } from "@/lib/sourcing/skus";

export type SourcingOfferResult = { ok: true; id: string; message: string } | { ok: false; errors: { message: string }[]; duplicateOfId?: string };

const fail = (message: string, duplicateOfId?: string): SourcingOfferResult => ({ ok: false, errors: [{ message }], ...(duplicateOfId ? { duplicateOfId } : {}) });
const NOT_MIGRATED = "CSDL của tổ chức chưa áp migration 0256 (kho mẫu nguồn) — báo người vận hành, chưa ghi được.";

/** Người thao tác — khoá tài khoản BẮT BUỘC (AGENTS 34): mọi dòng ghi mang `users.id`. */
export type SourcingActor = { id: string; email: string };

function isUniqueViolation(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return (x?.code ?? x?.cause?.code) === "23505";
}

async function run(fn: () => Promise<SourcingOfferResult>): Promise<SourcingOfferResult> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingSourcingTable(e)) return fail(NOT_MIGRATED);
    throw e;
  }
}

const tierInput = z.object({ fromQty: z.number().int(), price: z.string().max(20) });
const snapshotInput = {
  tiers: z.array(tierInput).min(1, "Cần ít nhất một bậc giá").max(SOURCING_PRICE_TIERS_MAX),
  moq: z.number().int().min(1, "MOQ phải ≥ 1").max(10_000_000).nullable(),
  colors: z.string().max(2000).default(""),
  sizes: z.string().max(2000).default(""),
};

/** Chữ giá ⇒ bậc fen. Lỗi ⇒ câu chỉ đúng bậc nào sai. */
function readTiers(raw: z.infer<typeof tierInput>[]): { tiers: PriceTier[] } | { error: string } {
  const tiers: PriceTier[] = [];
  for (let i = 0; i < raw.length; i++) {
    const fen = parseCnyInput(raw[i].price);
    if (fen === null) return { error: `Bậc ${i + 1}: giá «${raw[i].price}» không đọc được — gõ số tệ, tối đa 2 số lẻ (ví dụ 12.30).` };
    tiers.push({ fromQty: raw[i].fromQty, priceFen: fen });
  }
  const err = validatePriceTiers(tiers);
  return err ? { error: err } : { tiers };
}

const imageInput = z.string().trim().max(2000).default("");

function readImage(raw: string): { url: string | null; key: string | null } | { error: string } {
  if (!raw) return { url: null, key: null };
  const url = safeHttpUrl(raw);
  return url ? { url, key: imageKey(url) } : { error: "Link ảnh phải là http(s)." };
}

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Nhà cung cấp theo link shop chuẩn hoá: có thì dùng lại (điền tên nếu đang trống), chưa có thì tạo. Link trống ⇒ `null`. */
async function upsertSupplier(db: Db | Tx, platform: string, shopRaw: string, name: string, userId: string): Promise<{ id: string | null } | { error: string }> {
  if (!shopRaw) return { id: null };
  const shopUrl = canonicalShopUrl(shopRaw);
  if (!shopUrl) return { error: "Link shop nhà cung cấp không đọc được (cần http/https)." };
  const [existing] = await db.select().from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.shopUrl, shopUrl)).limit(1);
  if (existing) {
    if (name && !existing.name.trim()) await db.update(schema.sourcingSuppliers).set({ name }).where(eq(schema.sourcingSuppliers.id, existing.id));
    return { id: existing.id };
  }
  const [row] = await db
    .insert(schema.sourcingSuppliers)
    .values({ platform, shopUrl, name, createdBy: userId })
    .onConflictDoNothing({ target: schema.sourcingSuppliers.shopUrl })
    .returning({ id: schema.sourcingSuppliers.id });
  if (row) return { id: row.id };
  const [again] = await db.select({ id: schema.sourcingSuppliers.id }).from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.shopUrl, shopUrl)).limit(1);
  return { id: again?.id ?? null };
}

async function findDuplicate(db: Db, platform: string, offerId: string | null, canonicalUrl: string) {
  const o = schema.sourcingOffers;
  const cond = offerId ? or(eq(o.canonicalUrl, canonicalUrl), and(eq(o.platform, platform), isNotNull(o.offerId), eq(o.offerId, offerId))) : eq(o.canonicalUrl, canonicalUrl);
  const [hit] = await db.select({ id: o.id, archivedAt: o.archivedAt, titleVi: o.titleVi }).from(o).where(cond).limit(1);
  return hit ?? null;
}

const duplicateMessage = (hit: { archivedAt: Date | null; titleVi: string }) =>
  `Mẫu này đã có trong kho${hit.titleVi ? ` («${hit.titleVi}»)` : ""}${hit.archivedAt ? " — đang lưu trữ, khôi phục thay vì tạo mới" : ""}.`;

const createSchema = z.object({
  url: z.string().trim().min(1, "Dán link sản phẩm").max(2000),
  titleVi: z.string().trim().min(2, "Ghi tên tiếng Việt (ít nhất 2 ký tự)").max(200),
  titleZh: z.string().trim().max(300).default(""),
  imageUrl: imageInput,
  supplierShopUrl: z.string().trim().max(2000).default(""),
  supplierName: z.string().trim().max(200).default(""),
  ...snapshotInput,
});

export async function createSourcingOffer(user: SourcingActor, input: z.input<typeof createSchema>): Promise<SourcingOfferResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  const link = parseOfferUrl(d.url);
  if (!link) return fail("Link không đọc được — cần link http(s) của trang sản phẩm.");
  const tiers = readTiers(d.tiers);
  if ("error" in tiers) return fail(tiers.error);
  const image = readImage(d.imageUrl);
  if ("error" in image) return fail(image.error);
  return run(async () => {
    const db = await getDb();
    const dup = await findDuplicate(db, link.platform, link.offerId, link.canonicalUrl);
    if (dup) return fail(duplicateMessage(dup), dup.id);
    let created: { id: string };
    try {
      created = await db.transaction(async (tx) => {
        const supplier = await upsertSupplier(tx, link.platform, d.supplierShopUrl, d.supplierName, user.id);
        if ("error" in supplier) throw new SupplierError(supplier.error);
        const [row] = await tx
          .insert(schema.sourcingOffers)
          .values({ platform: link.platform, offerId: link.offerId, canonicalUrl: link.canonicalUrl, sourceUrl: d.url, titleZh: d.titleZh, titleVi: d.titleVi, imageUrl: image.url, imageKey: image.key, supplierId: supplier.id, dataStatus: "MANUAL", createdBy: user.id })
          .returning({ id: schema.sourcingOffers.id });
        await tx.insert(schema.sourcingOfferSnapshots).values({ offerId: row.id, tiers: serializePriceTiers(tiers.tiers), moq: d.moq, skus: serializeSkus(d.colors, d.sizes), source: "MANUAL", capturedBy: user.id });
        return row;
      });
    } catch (e) {
      if (e instanceof SupplierError) return fail(e.message);
      if (isUniqueViolation(e)) {
        const again = await findDuplicate(db, link.platform, link.offerId, link.canonicalUrl);
        if (again) return fail(duplicateMessage(again), again.id);
      }
      throw e;
    }
    await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_OFFER_CREATE", entity: "SOURCING_OFFER", entityId: created.id, after: { platform: link.platform, offerId: link.offerId, canonicalUrl: link.canonicalUrl, titleVi: d.titleVi, tiers: tiers.tiers, moq: d.moq } });
    return { ok: true, id: created.id, message: "Đã lưu mẫu vào kho." };
  });
}

class SupplierError extends Error {}

const snapshotSchema = z.object({ offerId: z.string().min(1).max(100), ...snapshotInput });

export async function addSourcingSnapshot(user: SourcingActor, input: z.input<typeof snapshotSchema>): Promise<SourcingOfferResult> {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  const tiers = readTiers(d.tiers);
  if ("error" in tiers) return fail(tiers.error);
  return run(async () => {
    const db = await getDb();
    const [offer] = await db.select({ id: schema.sourcingOffers.id }).from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, d.offerId)).limit(1);
    if (!offer) return fail("Không thấy mẫu.");
    const [row] = await db
      .insert(schema.sourcingOfferSnapshots)
      .values({ offerId: d.offerId, tiers: serializePriceTiers(tiers.tiers), moq: d.moq, skus: serializeSkus(d.colors, d.sizes), source: "MANUAL", capturedBy: user.id })
      .returning({ id: schema.sourcingOfferSnapshots.id });
    await db.update(schema.sourcingOffers).set({ updatedAt: new Date() }).where(eq(schema.sourcingOffers.id, d.offerId));
    await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_SNAPSHOT_ADD", entity: "SOURCING_OFFER", entityId: d.offerId, after: { snapshotId: row.id, tiers: tiers.tiers, moq: d.moq } });
    return { ok: true, id: d.offerId, message: "Đã chụp giá mới — lần chụp cũ vẫn giữ trong lịch sử." };
  });
}

const updateSchema = z.object({
  offerId: z.string().min(1).max(100),
  titleVi: z.string().trim().min(2, "Ghi tên tiếng Việt (ít nhất 2 ký tự)").max(200),
  titleZh: z.string().trim().max(300).default(""),
  imageUrl: imageInput,
  supplierShopUrl: z.string().trim().max(2000).default(""),
  supplierName: z.string().trim().max(200).default(""),
});

export async function updateSourcingOffer(user: SourcingActor, input: z.input<typeof updateSchema>): Promise<SourcingOfferResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  const image = readImage(d.imageUrl);
  if ("error" in image) return fail(image.error);
  return run(async () => {
    const db = await getDb();
    const [before] = await db.select().from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, d.offerId)).limit(1);
    if (!before) return fail("Không thấy mẫu.");
    const supplier = await upsertSupplier(db, before.platform, d.supplierShopUrl, d.supplierName, user.id);
    if ("error" in supplier) return fail(supplier.error);
    const after = { titleVi: d.titleVi, titleZh: d.titleZh, imageUrl: image.url, imageKey: image.key, supplierId: supplier.id };
    await db.update(schema.sourcingOffers).set(after).where(eq(schema.sourcingOffers.id, d.offerId));
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SOURCING_OFFER_UPDATE",
      entity: "SOURCING_OFFER",
      entityId: d.offerId,
      before: { titleVi: before.titleVi, titleZh: before.titleZh, imageUrl: before.imageUrl, supplierId: before.supplierId },
      after: { titleVi: after.titleVi, titleZh: after.titleZh, imageUrl: after.imageUrl, supplierId: after.supplierId },
    });
    return { ok: true, id: d.offerId, message: "Đã lưu thay đổi." };
  });
}

const supplierSchema = z.object({
  supplierId: z.string().min(1).max(100),
  offerId: z.string().min(1).max(100),
  name: z.string().trim().max(200).default(""),
  yearsOnPlatform: z.number().int().min(0).max(100).nullable(),
  rating: z.string().max(10).default(""),
  responseRate: z.string().max(10).default(""),
  verified: z.boolean().nullable(),
  shipFrom: z.string().trim().max(200).default(""),
  /** Ngày người xem số trên trang nguồn (YYYY-MM-DD); trống ⇒ hôm nay — mốc để tính «cũ». */
  factsAsOf: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Ngày dạng YYYY-MM-DD").default(""),
});

export async function updateSourcingSupplier(user: SourcingActor, input: z.input<typeof supplierSchema>): Promise<SourcingOfferResult> {
  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  const rating = parseHundredthsInput(d.rating, 500);
  if (rating === "INVALID") return fail("Điểm đánh giá: số từ 0 tới 5, tối đa 2 số lẻ.");
  const response = parseHundredthsInput(d.responseRate, 10000);
  if (response === "INVALID") return fail("Tỷ lệ phản hồi: số % từ 0 tới 100, tối đa 2 số lẻ.");
  const anyFact = d.yearsOnPlatform !== null || rating !== null || response !== null || d.verified !== null || d.shipFrom !== "";
  const asOf = d.factsAsOf ? new Date(`${d.factsAsOf}T12:00:00+07:00`) : new Date();
  if (asOf.getTime() > Date.now() + 86_400_000) return fail("Ngày xem số liệu không được ở tương lai.");
  return run(async () => {
    const db = await getDb();
    const [before] = await db.select().from(schema.sourcingSuppliers).where(eq(schema.sourcingSuppliers.id, d.supplierId)).limit(1);
    if (!before) return fail("Không thấy nhà cung cấp.");
    const after = {
      name: d.name,
      yearsOnPlatform: d.yearsOnPlatform,
      ratingX100: rating,
      responseRateBp: response,
      verified: d.verified,
      shipFrom: d.shipFrom || null,
      factsSource: "MANUAL",
      // Không khai số nào ⇒ không có mốc: «chưa biết» không có tuổi.
      factsAsOf: anyFact ? asOf : null,
    };
    await db.update(schema.sourcingSuppliers).set(after).where(eq(schema.sourcingSuppliers.id, d.supplierId));
    await audit({
      userId: user.id,
      userEmail: user.email,
      action: "SOURCING_SUPPLIER_UPDATE",
      entity: "SOURCING_SUPPLIER",
      entityId: d.supplierId,
      before: { name: before.name, yearsOnPlatform: before.yearsOnPlatform, ratingX100: before.ratingX100, responseRateBp: before.responseRateBp, verified: before.verified, shipFrom: before.shipFrom, factsAsOf: before.factsAsOf },
      after,
    });
    return { ok: true, id: d.supplierId, message: "Đã lưu thông tin nhà cung cấp." };
  });
}

const archiveSchema = z.object({ offerId: z.string().min(1).max(100), archived: z.boolean(), reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự)").max(500) });

export async function setSourcingOfferArchived(user: SourcingActor, input: z.input<typeof archiveSchema>): Promise<SourcingOfferResult> {
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  return run(async () => {
    const db = await getDb();
    const [before] = await db.select({ archivedAt: schema.sourcingOffers.archivedAt }).from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, d.offerId)).limit(1);
    if (!before) return fail("Không thấy mẫu.");
    // Đã đúng trạng thái xin ⇒ không ghi gì (bấm hai lần không đẻ thêm dòng nhật ký — cùng luật với AGENTS 61).
    if ((before.archivedAt !== null) === d.archived) return { ok: true, id: d.offerId, message: d.archived ? "Mẫu đã ở trạng thái lưu trữ." : "Mẫu đang dùng." };
    const archivedAt = d.archived ? new Date() : null;
    await db.update(schema.sourcingOffers).set({ archivedAt }).where(eq(schema.sourcingOffers.id, d.offerId));
    await audit({ userId: user.id, userEmail: user.email, action: d.archived ? "SOURCING_OFFER_ARCHIVE" : "SOURCING_OFFER_RESTORE", entity: "SOURCING_OFFER", entityId: d.offerId, before: { archivedAt: before.archivedAt }, after: { archivedAt }, reason: d.reason });
    return { ok: true, id: d.offerId, message: d.archived ? "Đã lưu trữ mẫu." : "Đã khôi phục mẫu." };
  });
}

const weightSchema = z.object({ offerId: z.string().min(1).max(100), grams: z.number().int("Cân nặng là số gam nguyên").min(1, "Cân nặng ít nhất 1 g").max(100_000, "Tối đa 100.000 g") });

/** Khai cân nặng MỘT cái (0257) — chỉ thêm dòng, lần mới nhất dùng cho cước Trung Quốc → Việt Nam. */
export async function addSourcingWeight(user: SourcingActor, input: z.input<typeof weightSchema>): Promise<SourcingOfferResult> {
  const parsed = weightSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ message: i.message })) };
  const d = parsed.data;
  try {
    const db = await getDb();
    const [offer] = await db.select({ id: schema.sourcingOffers.id }).from(schema.sourcingOffers).where(eq(schema.sourcingOffers.id, d.offerId)).limit(1);
    if (!offer) return fail("Không thấy mẫu.");
    const [row] = await db.insert(schema.sourcingOfferWeights).values({ offerId: d.offerId, grams: d.grams, source: "MANUAL", capturedBy: user.id }).returning({ id: schema.sourcingOfferWeights.id });
    await audit({ userId: user.id, userEmail: user.email, action: "SOURCING_WEIGHT_ADD", entity: "SOURCING_OFFER", entityId: d.offerId, after: { weightId: row.id, grams: d.grams } });
    return { ok: true, id: d.offerId, message: "Đã lưu cân nặng — lần khai cũ vẫn giữ trong lịch sử." };
  } catch (e) {
    if (isMissingSourcingTable(e)) return fail("CSDL của tổ chức chưa áp migration 0257 (cân nặng mẫu nguồn) — báo người vận hành, chưa ghi được.");
    throw e;
  }
}
