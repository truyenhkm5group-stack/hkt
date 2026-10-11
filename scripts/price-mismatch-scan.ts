/*
  ops `price-mismatch-scan` — ĐƠN CỦA BOT CÓ TIỀN HÀNG KHÁC BÁO GIÁ MÁY CHỦ KHÔNG, TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (P0 11/10/2026, ca «Phạm Minh Ái»): tổ chức bật «báo giá sỉ» thì đường giá cũ bỏ qua giảm theo khối lượng cho MỌI khách
  (khối giảm nằm trong `if (!books)` — nay ở lib/sales-chatbot/quote.ts `computePriced`) ⇒ 2kg chả cá thu 560.000 thay vì 540.000,
  thêm 1kg chả mực 400.000 ⇒ 960.000 thay vì 940.000. Script đếm đơn đã ghi theo giá sai trong N ngày và in danh sách mã đơn để đưa
  vào hàng sửa (người sửa — script KHÔNG sửa gì).

  Cách tính: đơn của bot = `orders.raw.agent` có giá trị, `inserted_at` trong N ngày. Tiền hàng đơn (Σ đơn giá × SL − giảm dòng) so với
  `computePriced` của CHÍNH quote.ts trên danh mục + cấu hình HÔM NAY, ở hai ngữ cảnh: giá cho khách chưa xác minh (bảng mặc định khi
  bật sỉ, giá lẻ khi tắt) và bảng riêng của khách (nếu có) — khớp một trong hai là khớp. Phân loại thuần ở
  lib/sales-chatbot/price-mismatch.ts. Giá danh mục có thể đã đổi từ lúc lên đơn ⇒ ESTIMATED; «thiếu giảm khối lượng» chỉ khi đơn
  giá từng dòng khớp giá hôm nay mà tiền giảm thiếu — đúng dấu vết của lỗi trên.

  arg: `<mã tổ chức> [--days=1..60]` (mặc định 14). Kênh [ops:tom-tat] chỉ số đếm / tiền tổng — KHÔNG mã đơn, tên, SĐT. Danh sách
  mã đơn (mã ngắn #XXXXXXXX) chỉ ở phần MÃ HOÁ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại `default_transaction_read_only`).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("price-mismatch-scan.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { findOrganization } from "@/lib/platform/organizations";
import { classifyOrderPrice, type MismatchOrderLine, type MismatchVerdict } from "@/lib/sales-chatbot/price-mismatch";
import { loadPricingContext, orgPricingConfig, pricingContextOf, type PricingContext } from "@/lib/sales-chatbot/quote";
import { rowsOf } from "@/lib/sql-rows";

export const PRICE_SCAN_DEFAULT_DAYS = 14;
export const PRICE_SCAN_MAX_DAYS = 60;
const USAGE = `<mã tổ chức> [--days=1..${PRICE_SCAN_MAX_DAYS}]`;
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

export function parsePriceScanArgs(argv: readonly string[]): { code: string; days: number } | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? PRICE_SCAN_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > PRICE_SCAN_MAX_DAYS) return { error: `--days phải là số nguyên 1..${PRICE_SCAN_MAX_DAYS}` };
  return { code, days };
}

export type ScannedOrder = { id: string; stage: string; verdict: MismatchVerdict };

/** Quét đơn của bot trong N ngày — chỉ ĐỌC. Trả từng đơn kèm phán quyết (dùng chung cho bài kiểm). */
export async function scanBotOrders(db: Db, days: number, now: Date = new Date()): Promise<ScannedOrder[]> {
  const o = schema.orders;
  const since = new Date(now.getTime() - days * 86_400_000);
  const orders = await db
    .select({ id: o.id, stage: o.stage, customerId: o.customerId })
    .from(o)
    .where(and(gte(o.insertedAt, since), isNotNull(sql`${o.raw}->>'agent'`)));
  if (!orders.length) return [];
  const it = schema.orderItems;
  const items = await db.select({ orderId: it.orderId, variantId: it.variantId, quantity: it.quantity, unitPrice: it.unitPrice, discount: it.totalDiscount }).from(it).where(inArray(it.orderId, orders.map((x) => x.id)));
  const cfg = await orgPricingConfig(db);
  // Một lượt đọc danh mục; ngữ cảnh khác nhau chỉ ở bảng giá.
  const base = await loadPricingContext(cfg, cfg.wholesalePricing ? await priceBooksFor(null, db) : null, db);
  const catalog = [...base.byId.values()];
  const customerCtx = new Map<string, PricingContext | null>();
  const out: ScannedOrder[] = [];
  for (const ord of orders) {
    const lines: MismatchOrderLine[] = items.filter((x) => x.orderId === ord.id).map((x) => ({ variantId: x.variantId, quantity: x.quantity, unitPrice: x.unitPrice === null ? null : Number(x.unitPrice), discount: x.discount === null ? null : Number(x.discount) }));
    const contexts: PricingContext[] = [base];
    if (cfg.wholesalePricing && ord.customerId) {
      if (!customerCtx.has(ord.customerId)) {
        const books = await priceBooksFor(ord.customerId, db);
        customerCtx.set(ord.customerId, books.customerList ? pricingContextOf(catalog, cfg, books) : null);
      }
      const c = customerCtx.get(ord.customerId);
      if (c) contexts.push(c);
    }
    out.push({ id: ord.id, stage: String(ord.stage), verdict: classifyOrderPrice(lines, contexts) });
  }
  return out;
}

async function main() {
  const args = parsePriceScanArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`price-mismatch-scan: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`price-mismatch-scan: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("price-mismatch-scan: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const rows = await scanBotOrders(db, args.days);
  const live = (r: ScannedOrder) => r.stage !== "CANCELLED";
  const bad = rows.filter((r) => r.verdict.kind === "PRICE_MISMATCH");
  const gap = bad.reduce((s, r) => s + (r.verdict.actual - (r.verdict.expected ?? r.verdict.actual)), 0);
  const unpriceable = rows.filter((r) => r.verdict.kind === "UNPRICEABLE");
  console.log(`Đơn của bot ${args.days} ngày: ${rows.length} · tính lại được ${rows.length - unpriceable.length} · lệch ${bad.length} (ESTIMATED — giá danh mục hôm nay)`);
  for (const r of bad) {
    const v = r.verdict;
    console.log(`  PRICE_MISMATCH #${manualOrderShortCode(r.id)} · ${r.stage} · đơn ${vnd(v.actual)} · máy chủ ${vnd(v.expected ?? 0)} · chênh ${vnd(v.actual - (v.expected ?? 0))}${v.missingVolumeDiscount ? " · THIẾU GIẢM KHỐI LƯỢNG" : ""}${v.multiUnit ? " · dòng N × gói đơn vị" : ""}`);
  }
  for (const r of unpriceable) console.log(`  KHÔNG TÍNH LẠI ĐƯỢC #${manualOrderShortCode(r.id)} · ${r.stage} · ${r.verdict.reason}`);
  tomTat(`price-mismatch-scan ${args.days} ngày: đơn bot ${rows.length} · PRICE_MISMATCH ${bad.length} (còn sống ${bad.filter(live).length}) · Σ chênh ${vnd(gap)} · thiếu giảm khối lượng ${bad.filter((r) => r.verdict.missingVolumeDiscount).length} · có dòng N×gói đơn vị ${bad.filter((r) => r.verdict.multiUnit).length} · không tính lại được ${unpriceable.length} — ESTIMATED; mã đơn trong phần mã hoá`);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("price-mismatch-scan lỗi:", e instanceof Error ? e.message : e);
    tomTat("price-mismatch-scan: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
