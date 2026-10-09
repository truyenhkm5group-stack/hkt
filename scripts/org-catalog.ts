/*
  ops `org-catalog` — DANH MỤC · BẢNG GIÁ SỈ · CÂU MẪU · CÔNG TẮC BOT CỦA MỘT TỔ CHỨC KHÁCH (CHỈ ĐỌC).

  Vì sao có (08/10/2026): chủ shop Hải Sản Làng Chài báo qua chủ nền tảng ba việc — khách mua 0,5kg chả cá / chả mực mà bot
  không tính tiền được (danh mục chỉ có quy cách 1kg), bot phải chốt không đối chiếu tồn, và khách hỏi giá sỉ thì phải trả lời
  bằng BẢNG GIÁ SỈ chứ không phải giá lẻ. Cả ba đều là DỮ LIỆU trong CSDL CỦA TỔ CHỨC (mẫu mã, bảng giá, `settings`), mà
  `db-query` chỉ mở CSDL nhà và `org-summary` chỉ in số đếm — không trả lời được «HSLC đang có quy cách nào, bảng giá sỉ nào,
  công tắc nào đang bật». Không đo được thì mọi hướng dẫn cho chủ shop là đoán.

  Script này CHỈ ĐỌC (`ERP_READ_ONLY=1` trước khi nạp @/db; CSDL tổ chức mở bằng `getDbForInspection` — máy chủ ép chỉ đọc,
  không migrate, không tạo; `main` hỏi lại Postgres rồi dừng nếu không phải). Việc SỬA (thêm quy cách, bật công tắc, lập bảng
  giá sỉ) là của chủ shop trên giao diện ERP của họ: Sản phẩm → sửa sản phẩm → thêm mẫu mã; AI bán hàng → cấu hình → hai công
  tắc; Sản phẩm → Bảng giá sỉ.

  In ra (phần MÃ HOÁ, vì giá và chữ câu mẫu là nội dung của shop): công tắc bot (bật · giá sỉ · chốt không kiểm tồn · field
  bot đọc), hồ sơ shop + hướng dẫn thêm, TỪNG sản phẩm / mẫu mã (id · SKU · quy cách · giá lẻ · gram · ẩn), bảng giá sỉ + từng
  bậc, câu mẫu đang bật. Dòng mang tiền tố "[ops:tom-tat] " (log công khai) chỉ mang số đếm + trạng thái công tắc — không tên, không giá.
  KHÔNG đọc cột nào mang dữ liệu của NGƯỜI (khách, SĐT, địa chỉ, tin nhắn).

  arg: `<mã tổ chức>`; rỗng ⇒ in danh sách tổ chức (mã · tên · trạng thái) để chọn.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-catalog.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { asc, eq, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { AI_PROFILE_SETTING_KEY } from "@/lib/blueprints/types";
import { isManualRecordId } from "@/lib/constants/manual-products";
import { orgHasSyncedSource } from "@/lib/platform/capabilities";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { parseSalesChatbotConfig, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { parseQuickReplySettings, QUICK_REPLY_SETTING_KEY } from "@/lib/sales-chatbot/quick-replies-shared";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
/** Trần của kênh tóm tắt (cùng số với các script tóm tắt khác). */
export const SUMMARY_MAX_CHARS = 300;

export type CatalogVariant = { id: string; sku: string; label: string; price: number | null; weightGrams: number | null; hidden: boolean; manual: boolean };
export type CatalogProduct = { id: string; name: string; code: string | null; manual: boolean; removed: boolean; variants: CatalogVariant[] };
export type CatalogReport = {
  org: { code: string; name: string };
  /** Tổ chức đồng bộ sản phẩm từ nguồn ngoài (Pancake) — quy cách mới phải thêm ở nguồn. `null` = không đọc được. */
  syncedProducts: boolean | null;
  /** `null` = chưa có cấu hình `ai.salesChatbot` (hoặc hỏng) — khác hẳn «mọi công tắc TẮT». */
  bot: { enabled: boolean; wholesalePricing: boolean; sellWithoutStockCheck: boolean; productFields: string[]; extraInstructions: string } | null;
  profile: string;
  products: CatalogProduct[];
  priceLists: { id: string; name: string; isDefault: boolean; active: boolean; tiers: { variantId: string; variantLabel: string; minQuantity: number; unitPrice: number }[] }[];
  quickReplies: { title: string; triggers: string[]; answer: string; upsell: boolean; images: number }[];
  /** Cài đặt câu mẫu: bật / tắt; `upsellSet` = đã chọn câu upsell (kèm ảnh menu) cho bước mời thêm món. `null` = không đọc được. */
  quickReplySettings: { enabled: boolean; upsellSet: boolean } | null;
};

/** Quy cách của một mẫu mã như bot đọc (`variantText` trong lib/sales-chatbot/catalog.ts). HÀM THUẦN. */
export function variantLabel(v: { detail: string; color: string; size: string }): string {
  return v.detail.trim() || [v.color, v.size].filter((x) => x.trim()).join(" · ") || "(không quy cách)";
}

async function readJson(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

export async function collectOrgCatalog(org: { code: string; name: string; isHome: boolean }, db: Db): Promise<CatalogReport> {
  const syncedProducts = await orgHasSyncedSource("products", org.code).catch(() => null);
  const rawBot = await readJson(db, SALES_CHATBOT_SETTING_KEY);
  const cfg = rawBot && typeof rawBot === "object" ? parseSalesChatbotConfig(rawBot) : null;
  const prof = (await readJson(db, AI_PROFILE_SETTING_KEY)) as { businessProfile?: unknown } | null;
  const profile = typeof prof?.businessProfile === "string" ? prof.businessProfile : "";

  const p = schema.products;
  const pv = schema.productVariants;
  const prows = await db.select({ id: p.id, name: p.name, code: p.customId, removed: p.isRemoved }).from(p).orderBy(asc(p.name), asc(p.id));
  const vrows = await db
    .select({ id: pv.id, productId: pv.productId, sku: pv.sku, detail: pv.detail, color: pv.color, size: pv.size, price: pv.retailPrice, weight: pv.weight, hidden: pv.isHidden, removed: pv.isRemoved })
    .from(pv)
    .orderBy(asc(pv.sku), asc(pv.id));
  const products: CatalogProduct[] = prows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code ?? null,
    manual: isManualRecordId(r.id),
    removed: r.removed,
    variants: vrows
      .filter((v) => v.productId === r.id && !v.removed)
      .map((v) => ({ id: v.id, sku: v.sku, label: variantLabel(v), price: v.price > 0 ? v.price : null, weightGrams: v.weight > 0 ? v.weight : null, hidden: v.hidden, manual: isManualRecordId(v.id) })),
  }));
  const nameOf = new Map(prows.map((r) => [r.id, r.name]));
  const labelOf = new Map(vrows.map((v) => [v.id, `${nameOf.get(v.productId) ?? v.productId} · ${variantLabel(v)}`]));

  const pl = schema.priceLists;
  const lists = await db.select({ id: pl.id, name: pl.name, isDefault: pl.isDefault, active: pl.active }).from(pl).orderBy(sql`${pl.active} desc`, asc(pl.name));
  const pli = schema.priceListItems;
  const items = await db.select({ priceListId: pli.priceListId, variantId: pli.variantId, minQuantity: pli.minQuantity, unitPrice: pli.unitPrice }).from(pli).orderBy(asc(pli.variantId), asc(pli.minQuantity));
  const priceLists = lists.map((l) => ({
    id: l.id,
    name: l.name,
    isDefault: l.isDefault,
    active: l.active,
    tiers: items.filter((i) => i.priceListId === l.id).map((i) => ({ variantId: i.variantId, variantLabel: labelOf.get(i.variantId) ?? `(mẫu mã ${i.variantId} không còn)`, minQuantity: i.minQuantity, unitPrice: i.unitPrice })),
  }));

  const qr = schema.salesChatQuickReplies;
  const qs = parseQuickReplySettings(await readJson(db, QUICK_REPLY_SETTING_KEY));
  const qi = schema.salesChatQuickReplyImages;
  const imageCounts = new Map((await db.select({ id: qi.quickReplyId, n: sql<number>`count(*)::int` }).from(qi).groupBy(qi.quickReplyId)).map((r) => [r.id, Number(r.n)]));
  const quickReplies = (await db.select({ id: qr.id, title: qr.title, triggers: qr.triggers, answer: qr.answer }).from(qr).where(eq(qr.active, true)).orderBy(asc(qr.title))).map((q) => ({ title: q.title, triggers: q.triggers ?? [], answer: q.answer, upsell: q.id === qs.upsellReplyId, images: imageCounts.get(q.id) ?? 0 }));

  return {
    org: { code: org.code, name: org.name },
    syncedProducts,
    bot: cfg ? { enabled: cfg.enabled, wholesalePricing: cfg.wholesalePricing, sellWithoutStockCheck: cfg.sellWithoutStockCheck, productFields: [...cfg.productFields], extraInstructions: cfg.extraInstructions } : null,
    profile,
    products,
    priceLists,
    quickReplies,
    quickReplySettings: { enabled: qs.enabled, upsellSet: quickReplies.some((q) => q.upsell) },
  };
}

/** `null` ⇒ `—` (CHƯA BIẾT), không bao giờ `0 ₫` (luật 42). */
export const vnd = (n: number | null): string => (n === null ? "—" : `${n.toLocaleString("vi-VN")} ₫`);
const onOff = (b: boolean): string => (b ? "BẬT" : "TẮT");

/** Phần MÃ HOÁ: đủ chi tiết để chủ shop / người vận hành thấy đúng thứ bot thấy — id sản phẩm, quy cách, giá, bậc sỉ, câu mẫu. */
export function catalogLines(r: CatalogReport): string[] {
  const out: string[] = [];
  out.push(`Tổ chức ${r.org.code}: ${r.org.name}`);
  out.push(`Nguồn sản phẩm: ${r.syncedProducts === null ? "— (không đọc được)" : r.syncedProducts ? "ĐỒNG BỘ từ nguồn ngoài (Pancake) — quy cách mới thêm ở nguồn rồi đồng bộ" : "tạo tay trên ERP — quy cách mới thêm ở Sản phẩm → sửa sản phẩm"}`);
  out.push(r.bot ? `Bot: ${onOff(r.bot.enabled)} · báo giá theo bảng giá sỉ ${onOff(r.bot.wholesalePricing)} · chốt không kiểm tồn ${onOff(r.bot.sellWithoutStockCheck)} · field bot đọc: ${r.bot.productFields.join(", ") || "(không)"}` : "Bot: — (chưa có cấu hình ai.salesChatbot)");
  out.push(`Về shop (${r.profile.length} ký tự): ${r.profile || "(trống)"}`);
  out.push(`Hướng dẫn thêm (${r.bot?.extraInstructions.length ?? 0} ký tự): ${r.bot?.extraInstructions || "(trống)"}`);
  out.push("");
  out.push(`SẢN PHẨM (${r.products.length}):`);
  for (const p of r.products) {
    out.push(`· ${p.id} · ${p.name}${p.code ? ` · mã ${p.code}` : ""} · ${p.manual ? "tạo tay" : "đồng bộ"}${p.removed ? " · ĐÃ GỠ" : ""}`);
    if (!p.variants.length) out.push("    (không có mẫu mã)");
    for (const v of p.variants) out.push(`    - ${v.id} · SKU ${v.sku || "(trống)"} · ${v.label} · giá lẻ ${vnd(v.price)} · ${v.weightGrams === null ? "chưa khai gram" : `${v.weightGrams} g`}${v.hidden ? " · ẨN (thôi bán)" : ""}`);
  }
  out.push("");
  out.push(`BẢNG GIÁ SỈ (${r.priceLists.length}):`);
  if (!r.priceLists.length) out.push("    (chưa có bảng giá nào — bot bật giá sỉ cũng không có bậc để báo, mọi câu hỏi sỉ sẽ chuyển nhân viên)");
  for (const l of r.priceLists) {
    out.push(`· ${l.name}${l.isDefault ? " · MẶC ĐỊNH" : ""}${l.active ? "" : " · NGỪNG DÙNG"} · ${l.tiers.length} bậc`);
    for (const t of l.tiers) out.push(`    - ${t.variantLabel} · từ ${t.minQuantity}: ${vnd(t.unitPrice)}`);
  }
  out.push("");
  out.push(`CÂU MẪU ĐANG BẬT (${r.quickReplies.length}):`);
  out.push(r.quickReplySettings ? `Câu mẫu: ${onOff(r.quickReplySettings.enabled)} · câu upsell (mời thêm món kèm ảnh menu): ${r.quickReplySettings.upsellSet ? "ĐÃ CHỌN" : "CHƯA CHỌN — bot sẽ tự gợi ý từng món"}` : "Câu mẫu: — (không đọc được cài đặt)");
  for (const q of r.quickReplies) out.push(`· ${q.upsell ? "[UPSELL] " : ""}${q.title} (${q.images} ảnh) [${q.triggers.join(" / ")}]: ${q.answer.replace(/\s+/g, " ").trim()}`);
  return out;
}

/** Kênh tóm tắt công khai: CHỈ số đếm + trạng thái công tắc — không tên sản phẩm, không giá, không chữ của shop. */
export function catalogSummary(r: CatalogReport): string[] {
  const live = r.products.filter((p) => !p.removed);
  const variants = live.flatMap((p) => p.variants);
  const activeLists = r.priceLists.filter((l) => l.active);
  const tiers = activeLists.reduce((s, l) => s + l.tiers.length, 0);
  return [
    `Tổ chức ${r.org.code}: ${live.length} sản phẩm · ${variants.length} mẫu mã (${variants.filter((v) => v.price === null).length} chưa có giá · ${variants.filter((v) => v.hidden).length} ẩn) · nguồn ${r.syncedProducts === null ? "—" : r.syncedProducts ? "ĐỒNG BỘ" : "tạo tay"}`,
    `Bot: ${r.bot ? `${onOff(r.bot.enabled)} · giá sỉ ${onOff(r.bot.wholesalePricing)} · chốt không kiểm tồn ${onOff(r.bot.sellWithoutStockCheck)}` : "— (chưa có cấu hình)"} · bảng giá sỉ đang dùng ${activeLists.length} (${tiers} bậc) · câu mẫu đang bật ${r.quickReplies.length} · câu upsell ${r.quickReplySettings?.upsellSet ? `ĐÃ CHỌN (${r.quickReplies.find((q) => q.upsell)?.images ?? 0} ảnh)` : "CHƯA CHỌN"}`,
  ].map((l) => l.slice(0, SUMMARY_MAX_CHARS));
}

async function main() {
  const code = (process.argv[2] ?? "").trim();
  const list = await listOrganizations();
  if (!code) {
    tomTat(`Chưa chọn tổ chức — ${list.length} tổ chức: ${list.map((x) => `${x.code} ${x.status}${x.isHome ? " NHÀ" : ""}`).join(" | ")}`.slice(0, SUMMARY_MAX_CHARS * 3));
    for (const x of list) console.log(`${x.code}: ${x.name}`);
    process.exit(0);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) {
    console.error("org-catalog: mã tổ chức chỉ gồm chữ thường, số, - hoặc _.");
    process.exit(64);
  }
  const org = await findOrganization(code);
  if (!org) {
    tomTat(`Không có tổ chức «${code}». Có: ${list.map((x) => x.code).join(", ")}`);
    process.exit(1);
  }
  const db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    console.error("org-catalog: phiên CSDL không ở chế độ chỉ đọc — KHÔNG chạy.");
    process.exit(1);
  }
  const report = await collectOrgCatalog({ code: org.code, name: org.name, isHome: org.isHome }, db);
  for (const line of catalogLines(report)) console.log(line);
  for (const line of catalogSummary(report)) tomTat(line);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("org-catalog lỗi:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
