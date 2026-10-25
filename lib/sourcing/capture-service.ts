/**
 * ═══ LƯU MỘT LẦN CHỤP TRANG CHI TIẾT (SRC-6) — LÕI GHI, CHỈ MÁY CHỦ ═══
 *
 * Đường: (route đã qua `authenticateCaptureToken`) ⇒ bộ đọc nguồn ra `CaptureFacts` ⇒ ĐÂY: zod ⇒ upsert mẫu theo (1688, mã sản phẩm)
 * trong CSDL tổ chức ⇒ THÊM một ảnh chụp giá (chỉ khi có giá chi tiết) ⇒ THÊM một dòng lần chụp ⇒ audit. Gửi lại cùng mã sản phẩm là
 * một lần chụp MỚI — không đè dòng cũ (giá đổi theo thời gian).
 *  · Mẫu đã có (kể cả nhập tay / đang lưu trữ) ⇒ giữ nguyên tên tiếng Việt, nhãn nguồn của mẫu và trạng thái lưu trữ; chỉ điền ô
 *    đang trống (tên Trung, ảnh, nhà cung cấp).
 *  · Nhà cung cấp: số năm và nơi gửi hàng đọc được ⇒ cập nhật, mốc `facts_as_of` = lúc chụp, nguồn `EXTENSION`; số không đọc được giữ
 *    nguyên — không ghi `null` đè lên số người đã gõ.
 *  · KHÔNG đặt hàng, KHÔNG nhắn nhà cung cấp, KHÔNG gọi ra ngoài.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { SOURCING_CAPTURE_PARSER_VERSION, type SourcingCaptureFlag, type SourcingCaptureSource } from "@/lib/constants/sourcing";
import { isMissingSourcingTable } from "@/lib/queries/sourcing";
import { captureFactsSchema, deriveCapture, type CaptureFacts } from "@/lib/sourcing/capture";
import { upsertSupplier } from "@/lib/sourcing/offer-service";
import { imageKey, parseOfferUrl, safeHttpUrl } from "@/lib/sourcing/offer-url";
import { serializePriceTiers } from "@/lib/sourcing/price";

export type CaptureActor = { id: string; email: string };

export type CaptureResult =
  | { ok: true; offerId: string; created: boolean; captureId: string; snapshotId: string | null; flags: SourcingCaptureFlag[]; archived: boolean }
  | { ok: false; status: 400 | 503; error: string };

const NOT_MIGRATED = "CSDL của tổ chức chưa áp migration 0260 (lưu mẫu từ 1688) — báo người vận hành, chưa ghi được.";

export async function captureOffer(
  actor: CaptureActor,
  input: CaptureFacts,
  opts: { source: SourcingCaptureSource; tokenId: string | null; pageUrl: string; raw: unknown; sourceFlags?: readonly SourcingCaptureFlag[] },
): Promise<CaptureResult> {
  const parsed = captureFactsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: `Dữ liệu trang không hợp lệ: ${parsed.error.issues[0]?.message ?? "sai dạng"}` };
  const f = parsed.data;
  const link = parseOfferUrl(`https://detail.1688.com/offer/${f.offerId}.html`);
  if (!link || link.platform !== "1688" || link.offerId !== f.offerId) return { ok: false, status: 400, error: "Mã sản phẩm 1688 không đọc được." };
  const d = deriveCapture(f, opts.sourceFlags ?? []);
  const image = f.imageUrls.map((u) => safeHttpUrl(u)).find((u): u is string => !!u) ?? null;
  const pageUrl = safeHttpUrl(opts.pageUrl) ?? link.canonicalUrl;
  try {
    const db = await getDb();
    const out = await db.transaction(async (tx) => {
      const o = schema.sourcingOffers;
      const supplier = f.supplier.shopUrl ? await upsertSupplier(tx, "1688", f.supplier.shopUrl, f.supplier.name ?? "", actor.id) : { id: null };
      const supplierId = "error" in supplier ? null : supplier.id;
      const capturedAt = new Date();
      if (supplierId && (f.supplier.yearsOnPlatform !== null || f.supplier.shipFrom)) {
        await tx
          .update(schema.sourcingSuppliers)
          .set({
            ...(f.supplier.yearsOnPlatform !== null ? { yearsOnPlatform: f.supplier.yearsOnPlatform } : {}),
            ...(f.supplier.shipFrom ? { shipFrom: f.supplier.shipFrom } : {}),
            factsSource: "EXTENSION",
            factsAsOf: capturedAt,
          })
          .where(eq(schema.sourcingSuppliers.id, supplierId));
      }
      const find = () =>
        tx
          .select({ id: o.id, titleZh: o.titleZh, imageUrl: o.imageUrl, supplierId: o.supplierId, archivedAt: o.archivedAt })
          .from(o)
          .where(and(eq(o.platform, "1688"), isNotNull(o.offerId), eq(o.offerId, f.offerId)))
          .limit(1);
      let [offer] = await find();
      let created = false;
      if (!offer) {
        const [ins] = await tx
          .insert(o)
          .values({ platform: "1688", offerId: f.offerId, canonicalUrl: link.canonicalUrl, sourceUrl: pageUrl, titleZh: f.titleZh, titleVi: "", imageUrl: image, imageKey: image ? imageKey(image) : null, supplierId, dataStatus: opts.source, createdBy: actor.id })
          .onConflictDoNothing({ target: o.canonicalUrl })
          .returning({ id: o.id });
        created = !!ins;
        [offer] = await find();
        // Link chuẩn hoá đã thuộc một mẫu KHÔNG mang mã (nhập tay trước khi có cột mã) ⇒ mẫu đó chính là mẫu này.
        if (!offer) [offer] = await tx.select({ id: o.id, titleZh: o.titleZh, imageUrl: o.imageUrl, supplierId: o.supplierId, archivedAt: o.archivedAt }).from(o).where(eq(o.canonicalUrl, link.canonicalUrl)).limit(1);
      }
      if (!created) {
        const fill = {
          ...(!offer.titleZh && f.titleZh ? { titleZh: f.titleZh } : {}),
          ...(!offer.imageUrl && image ? { imageUrl: image, imageKey: imageKey(image) } : {}),
          ...(!offer.supplierId && supplierId ? { supplierId } : {}),
        };
        await tx.update(o).set({ ...fill, updatedAt: capturedAt }).where(eq(o.id, offer.id));
      }
      let snapshotId: string | null = null;
      if (d.tiers) {
        const [snap] = await tx
          .insert(schema.sourcingOfferSnapshots)
          .values({ offerId: offer.id, capturedAt, tiers: serializePriceTiers(d.tiers), moq: f.moq, skus: d.skuLabels, source: opts.source, capturedBy: actor.id })
          .returning({ id: schema.sourcingOfferSnapshots.id });
        snapshotId = snap.id;
      }
      if (f.weightGrams !== null) await tx.insert(schema.sourcingOfferWeights).values({ offerId: offer.id, grams: f.weightGrams, source: opts.source, capturedAt, capturedBy: actor.id });
      const [cap] = await tx
        .insert(schema.sourcingOfferCaptures)
        .values({ offerId: offer.id, snapshotId, source: opts.source, capturedAt, capturedBy: actor.id, tokenId: opts.tokenId, pageUrl, parserVersion: SOURCING_CAPTURE_PARSER_VERSION, facts: { ...f, derived: { tiers: d.tiers, sizeChart: d.sizeChart } }, raw: opts.raw ?? null, flags: d.flags })
        .returning({ id: schema.sourcingOfferCaptures.id });
      return { offerId: offer.id, created, captureId: cap.id, snapshotId, archived: offer.archivedAt !== null };
    });
    await audit({
      userId: actor.id,
      userEmail: actor.email,
      action: "SOURCING_OFFER_CAPTURE",
      entity: "SOURCING_OFFER",
      entityId: out.offerId,
      after: { source: opts.source, offerId1688: f.offerId, created: out.created, captureId: out.captureId, snapshotId: out.snapshotId, tiers: d.tiers, moq: f.moq, flags: d.flags },
    });
    return { ok: true, ...out, flags: d.flags };
  } catch (e) {
    if (isMissingSourcingTable(e)) return { ok: false, status: 503, error: NOT_MIGRATED };
    throw e;
  }
}
