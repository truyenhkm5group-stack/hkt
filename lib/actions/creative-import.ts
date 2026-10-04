"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { OWN_AD_IMPORT } from "@/lib/constants/creative-loop";
import { decideOwnAdMode, type OwnAdMode } from "@/lib/constants/own-ad-ranking";
import { importOwnAds, importPancakeProductPhotos, type OwnAdGraph, type OwnAdImportSummary, type PancakeImportSummary } from "@/lib/creative/import";
import { getFacebookAdsClient } from "@/lib/integrations/facebook/client";
import { openOrgMetaAdsClient } from "@/lib/marketing/meta-ads-org";
import { currentOrganization } from "@/lib/platform/context";
import { readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import { hasErpAdAttribution, listOwnAdCandidates, type OwnAdCandidateList } from "@/lib/queries/creative-own-ads";

/**
 * ═══════════ VÒNG MẪU — NHẬP NGUỒN ẢNH CÓ SẴN ═══════════
 *
 * Ba nút ở tab Nguồn ảnh. Mọi luật ở `lib/creative/import.ts` (đường ghi) và
 * `lib/queries/creative-own-ads.ts` (xem trước, chỉ đọc). Tệp này chỉ: kiểm quyền → lược đồ → đọc tên
 * người thao tác từ MÁY CHỦ (AGENTS.md mục 34) → gọi đường ghi → nhật ký.
 *
 * Quyền `ideas:write` — cùng quyền tải ảnh nguồn bằng tay. Nhập nguồn KHÔNG tiêu đồng nào: nguồn chỉ
 * là đầu vào của lượt lập lô, và lô vẫn phải qua lượt duyệt (quyền `expenses:write`).
 */

type Result<T = object> = ({ ok: true } & T) | { error: string };

const DUONG = "/marketing/creatives";

async function nguoiThaoTac(userId: string, fallback: string): Promise<{ id: string; name: string }> {
  const db = await getDb();
  const row = await db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { name: true, email: true } });
  return { id: userId, name: row?.name?.trim() || row?.email || fallback };
}

/** Nhập ảnh chính của mọi mã đang bán từ Pancake thành nguồn "Ảnh sản phẩm thật". */
export async function importPancakeProductPhotosAction(): Promise<Result<{ summary: PancakeImportSummary }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền thêm ảnh nguồn cho vòng mẫu" };
  const db = await getDb();
  const actor = await nguoiThaoTac(user.id, user.email);
  const summary = await importPancakeProductPhotos(db, actor);
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_SOURCE_IMPORT_PANCAKE",
    entity: "CREATIVE_SOURCE",
    entityId: "pancake",
    after: { imported: summary.imported.map((x) => x.productId), existing: summary.existing, failed: summary.failed, remaining: summary.remaining },
  });
  if (summary.imported.length) revalidatePath(DUONG);
  return { ok: true, summary };
}

/**
 * Nhánh chọn mẫu của tổ chức đang chạy — xem trước và lượt nhập gọi CÙNG hàm, để máy chủ kiểm lại bằng đúng luật người
 * xem vừa thấy (`decideOwnAdMode`).
 */
async function ownAdMode(db: Awaited<ReturnType<typeof getDb>>, now: Date): Promise<OwnAdMode> {
  return decideOwnAdMode(await hasErpAdAttribution(db, now));
}

/** XEM TRƯỚC mẫu thắng / mẫu tốt của shop trên Facebook — CHỈ ĐỌC CSDL, không gọi Facebook. */
export async function previewOwnAdCandidatesAction(): Promise<Result<{ list: OwnAdCandidateList; winOrdersAbove: number }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền thêm ảnh nguồn cho vòng mẫu" };
  const db = await getDb();
  const { config } = await readCurrentCreativeConfig(db);
  const now = new Date();
  const list = await listOwnAdCandidates(db, { now, winOrdersAbove: config.winOrdersAbove, mode: await ownAdMode(db, now) });
  return { ok: true, list, winOrdersAbove: config.winOrdersAbove };
}

const importOwnAdsSchema = z
  .object({
    adIds: z
      .array(z.string().trim().regex(/^\d{5,}$/, "Mã quảng cáo không hợp lệ"))
      .min(1, "Chưa chọn mẩu quảng cáo nào")
      .max(OWN_AD_IMPORT.maxPerImport, `Tối đa ${OWN_AD_IMPORT.maxPerImport} mẩu mỗi lượt nhập`),
    /** Mã hàng người nhập chọn cho mẩu (mẩu → products.id). Máy chủ kiểm mã có trong sổ sản phẩm của tổ chức. */
    productIds: z.record(z.string().trim().regex(/^\d{5,}$/, "Mã quảng cáo không hợp lệ"), z.string().trim().min(1).max(64)).optional(),
  })
  .strict();

/**
 * Graph CHỈ ĐỌC cho lượt nhập: nhà ⇒ client biến môi trường như cũ; tổ chức khách ⇒ client của kết nối «meta-ads-org»
 * ĐANG BẬT của chính nó (chặn bằng chủ của khoá ở lối gọi mạng) kèm danh sách tài khoản được phép — «chỉ ảnh của shop».
 */
async function ownAdGraph(): Promise<{ graph: OwnAdGraph; allowedAccountIds?: string[] } | { error: string }> {
  const org = await currentOrganization();
  if (org.isHome) {
    try {
      const client = getFacebookAdsClient();
      return { graph: { getAdCreativeContent: (id) => client.getAdCreativeContent(id), getAdImageUrls: (acc, hashes) => client.getAdImageUrls(acc, hashes) } };
    } catch (e) {
      return { error: e instanceof Error && e.message ? e.message : "Chưa cấu hình kết nối Facebook" };
    }
  }
  const opened = await openOrgMetaAdsClient();
  if (!("ok" in opened)) return { error: `Chưa đọc được quảng cáo của tổ chức (${opened.detail.replace(/^Bỏ qua:\s*/, "")}). Bật kết nối «Quảng cáo Facebook (Meta) của tổ chức» ở Cài đặt → Kết nối.` };
  const { client, adAccountIds } = opened;
  return { graph: { getAdCreativeContent: (id) => client.getAdCreativeContent(id), getAdImageUrls: (acc, hashes) => client.getAdImageUrls(acc, hashes) }, allowedAccountIds: adAccountIds };
}

/** NHẬP các mẩu đã chọn thành nguồn "Quảng cáo cũ của shop" — đọc ảnh + câu chữ qua Graph (chỉ GET). */
export async function importOwnAdsAction(input: unknown): Promise<Result<{ summary: OwnAdImportSummary }>> {
  const user = await requireUser();
  if (!can(user, "ideas:write")) return { error: "Bạn không có quyền thêm ảnh nguồn cho vòng mẫu" };
  const parsed = importOwnAdsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };

  const g = await ownAdGraph();
  if ("error" in g) return { error: g.error };

  const db = await getDb();
  const { config } = await readCurrentCreativeConfig(db);
  const actor = await nguoiThaoTac(user.id, user.email);
  const now = new Date();
  const summary = await importOwnAds(db, parsed.data.adIds, actor, {
    graph: g.graph,
    now,
    winOrdersAbove: config.winOrdersAbove,
    mode: await ownAdMode(db, now),
    productOverrides: parsed.data.productIds,
    allowedAccountIds: g.allowedAccountIds,
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CREATIVE_SOURCE_IMPORT_OWN_AD",
    entity: "CREATIVE_SOURCE",
    entityId: "facebook",
    after: { requested: parsed.data.adIds, productIds: parsed.data.productIds ?? {}, imported: summary.imported, existing: summary.existing.map((x) => x.adId), skipped: summary.skipped, noProduct: summary.noProduct },
  });
  if (summary.imported.length) revalidatePath(DUONG);
  return { ok: true, summary };
}
