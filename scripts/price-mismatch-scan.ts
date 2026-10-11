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

  arg: `<mã tổ chức> [--days=1..60] [--since=<ISO>] [--flag [--apply]]` (mặc định 14 ngày).
   · `--since=<ISO>` — CHỈ đơn tạo từ mốc đó (vd mốc deploy bản sửa giá) ⇒ «PRICE_MISMATCH MỚI = 0» là điều kiện DONE của chủ shop.
     Thay cho cửa sổ `--days`; mốc không được ở tương lai và không cũ hơn 60 ngày.
   · `--flag` — đưa đơn lệch CÒN SỐNG vào hàng «Cần người kiểm» của trang Đơn: cờ `PRICE_MISMATCH` + ghi chú số tiền ĐÚNG theo báo
     giá máy chủ (cùng cơ chế cờ của lõi đơn — `flagOrderForReviewAsAgent`, nhật ký ORDER_REVIEW). KHÔNG đổi giá đơn, KHÔNG gửi tin.
     Mặc định CHẠY THỬ (in danh sách sẽ gắn); `--flag --apply` mới ghi. Idempotent: đơn đang có cờ này, hoặc người ĐÃ kiểm cờ này
     (vết trong `reviewLog`), thì bỏ qua — chạy lại không gắn lại. Đơn đã qua giai đoạn gắn cờ (đóng gói trở đi) được liệt kê riêng.
     Chủ shop chỉ thị 11/10/2026 «đưa vào hàng sửa / kiểm tra» — gắn cờ được phép, sửa giá thì không.
  Kênh [ops:tom-tat] chỉ số đếm / tiền tổng + mã ngắn #XXXXXXXX ở chế độ --flag (mã đơn không phải dữ liệu cá nhân) — KHÔNG tên, SĐT,
  địa chỉ. Chi tiết từng đơn ở phần MÃ HOÁ. Không `--flag --apply` ⇒ CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại
  `default_transaction_read_only`); `--flag --apply` ⇒ ghi qua lõi đơn trong ngữ cảnh tổ chức (`withOrganization`).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("price-mismatch-scan.ts"));
const SE_GHI = process.argv.includes("--flag") && process.argv.includes("--apply");
if (CHAY_THANG && !SE_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, getDbForInspection, schema, type Db } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { canFlagOrderForReview, orderReviewLogOf, orderReviewOf } from "@/lib/constants/order-review";
import { withOrganization } from "@/lib/platform/context";
import { flagOrderForReviewAsAgent } from "@/lib/records/order-create";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { findOrganization } from "@/lib/platform/organizations";
import { classifyOrderPrice, type MismatchOrderLine, type MismatchVerdict } from "@/lib/sales-chatbot/price-mismatch";
import { loadPricingContext, orgPricingConfig, pricingContextOf, type PricingContext } from "@/lib/sales-chatbot/quote";
import { rowsOf } from "@/lib/sql-rows";

export const PRICE_SCAN_DEFAULT_DAYS = 14;
export const PRICE_SCAN_MAX_DAYS = 60;
const USAGE = `<mã tổ chức> [--days=1..${PRICE_SCAN_MAX_DAYS}] [--since=<ISO>] [--flag [--apply]]`;
/** Người gắn cờ — người vận hành nền tảng chạy ops (ghi vào `by` của cờ + nhật ký, không phải tài khoản người dùng). */
export const PRICE_SCAN_AGENT = { name: "Người vận hành (ops price-mismatch-scan)", source: "scripts/price-mismatch-scan.ts" } as const;
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

export type PriceScanArgs = { code: string; days: number; since: Date | null; flag: boolean; apply: boolean };

export function parsePriceScanArgs(argv: readonly string[], now: Date = new Date()): PriceScanArgs | { error: string } {
  const known = /^--(days|since)=|^--(flag|apply)$/;
  const bad = argv.find((a) => a.startsWith("--") && !known.test(a));
  if (bad) return { error: `cờ lạ ${bad.slice(0, 20)}` };
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? PRICE_SCAN_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > PRICE_SCAN_MAX_DAYS) return { error: `--days phải là số nguyên 1..${PRICE_SCAN_MAX_DAYS}` };
  const rawSince = argv.find((a) => a.startsWith("--since="))?.slice(8);
  let since: Date | null = null;
  if (rawSince !== undefined) {
    const t = /^\d{4}-\d{2}-\d{2}/.test(rawSince) ? Date.parse(rawSince) : NaN;
    if (!Number.isFinite(t)) return { error: "--since phải là mốc ISO (vd 2026-10-11T14:30:00+07:00)" };
    if (t > now.getTime()) return { error: "--since ở tương lai" };
    if (t < now.getTime() - PRICE_SCAN_MAX_DAYS * 86_400_000) return { error: `--since cũ hơn ${PRICE_SCAN_MAX_DAYS} ngày` };
    since = new Date(t);
  }
  const flag = argv.includes("--flag");
  const apply = argv.includes("--apply");
  if (apply && !flag) return { error: "--apply chỉ đi cùng --flag" };
  return { code, days, since, flag, apply };
}

export type ScannedOrder = { id: string; stage: string; verdict: MismatchVerdict; raw: unknown };

/** Quét đơn của bot trong N ngày (hoặc từ mốc `from`) — chỉ ĐỌC. Trả từng đơn kèm phán quyết (dùng chung cho bài kiểm). */
export async function scanBotOrders(db: Db, days: number, now: Date = new Date(), from: Date | null = null): Promise<ScannedOrder[]> {
  const o = schema.orders;
  const since = from ?? new Date(now.getTime() - days * 86_400_000);
  const orders = await db
    .select({ id: o.id, stage: o.stage, customerId: o.customerId, raw: o.raw })
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
    out.push({ id: ord.id, stage: String(ord.stage), verdict: classifyOrderPrice(lines, contexts), raw: ord.raw });
  }
  return out;
}

export type FlagPlan = { id: string; action: "FLAG" | "ALREADY_FLAGGED" | "ALREADY_REVIEWED" | "STAGE_LOCKED"; stage: string; note: string };

/** Ghi chú của cờ — số tiền ĐÚNG theo báo giá máy chủ. HÀM THUẦN. */
export function mismatchNote(v: MismatchVerdict): string {
  const exp = v.expected ?? 0;
  return `Tiền hàng đơn ${vnd(v.actual)} ≠ báo giá máy chủ ${vnd(exp)} (chênh ${vnd(v.actual - exp)})${v.missingVolumeDiscount ? " — thiếu giảm theo khối lượng" : ""}. Giá đơn CHƯA sửa: người kiểm sửa dòng đơn theo số đúng.`;
}

/**
 * Kế hoạch gắn cờ cho đơn lệch CÒN SỐNG — HÀM THUẦN. Đang có cờ PRICE_MISMATCH ⇒ bỏ qua; người đã kiểm cờ này (vết reviewLog) ⇒ bỏ
 * qua (không gắn lại thứ người đã quyết); giai đoạn ngoài NEW / WAITING / CONFIRMED ⇒ không gắn được (lõi từ chối), liệt kê riêng.
 */
export function planMismatchFlags(rows: readonly ScannedOrder[]): FlagPlan[] {
  return rows
    .filter((r) => r.verdict.kind === "PRICE_MISMATCH" && r.stage !== "CANCELLED")
    .map((r) => {
      const note = mismatchNote(r.verdict);
      const action: FlagPlan["action"] = orderReviewOf(r.raw)?.entries.some((e) => e.code === "PRICE_MISMATCH")
        ? "ALREADY_FLAGGED"
        : orderReviewLogOf(r.raw).some((l) => l.entries.some((e) => e.code === "PRICE_MISMATCH"))
          ? "ALREADY_REVIEWED"
          : canFlagOrderForReview(r.stage)
            ? "FLAG"
            : "STAGE_LOCKED";
      return { id: r.id, action, stage: r.stage, note };
    });
}

/** Gắn cờ theo kế hoạch — chạy TRONG ngữ cảnh tổ chức (lõi đơn đọc `getDb()`). `apply = false` ⇒ không ghi. Trả số đơn đã gắn. */
export async function applyMismatchFlags(plan: readonly FlagPlan[], apply: boolean, now: Date = new Date()): Promise<{ flagged: string[]; failed: string[] }> {
  const flagged: string[] = [];
  const failed: string[] = [];
  if (!apply) return { flagged, failed };
  for (const p of plan.filter((x) => x.action === "FLAG")) {
    const r = await flagOrderForReviewAsAgent(PRICE_SCAN_AGENT, p.id, { code: "PRICE_MISMATCH", note: p.note, quote: null }, now);
    if (r.ok && r.flagged) flagged.push(p.id);
    else failed.push(p.id);
  }
  return { flagged, failed };
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
  if (args.apply) {
    // GHI: quét + gắn cờ trong ngữ cảnh tổ chức, qua lõi đơn (cổng module, khoá dòng, nhật ký ORDER_REVIEW).
    await withOrganization(org.code, async () => {
      const rows = await scanBotOrders(await getDb(), args.days, new Date(), args.since);
      await report(rows, args);
      const plan = planMismatchFlags(rows);
      const r = await applyMismatchFlags(plan, true);
      tomTat(`price-mismatch-scan --flag: ĐÃ GẮN CỜ ${r.flagged.length}${r.flagged.length ? ` (${r.flagged.slice(0, 20).map((id) => `#${manualOrderShortCode(id)}`).join(" ")})` : ""} · lõi từ chối ${r.failed.length} · đã có cờ ${plan.filter((p) => p.action === "ALREADY_FLAGGED").length} · người đã kiểm ${plan.filter((p) => p.action === "ALREADY_REVIEWED").length}`);
      tomTat(`đã qua giai đoạn gắn cờ (đóng gói trở đi) ${plan.filter((p) => p.action === "STAGE_LOCKED").length}: ${plan.filter((p) => p.action === "STAGE_LOCKED").slice(0, 20).map((p) => `#${manualOrderShortCode(p.id)}`).join(" ") || "—"} — sửa tay ở trang Đơn`);
    });
    process.exit(0);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("price-mismatch-scan: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const rows = await scanBotOrders(db, args.days, new Date(), args.since);
  await report(rows, args);
  if (args.flag) {
    const plan = planMismatchFlags(rows);
    for (const p of plan) console.log(`  KẾ HOẠCH ${p.action} #${manualOrderShortCode(p.id)} · ${p.stage} · ${p.note}`);
    const will = plan.filter((p) => p.action === "FLAG");
    tomTat(`price-mismatch-scan --flag CHẠY THỬ: sẽ gắn cờ ${will.length}${will.length ? ` (${will.slice(0, 20).map((p) => `#${manualOrderShortCode(p.id)}`).join(" ")})` : ""} · đã có cờ ${plan.filter((p) => p.action === "ALREADY_FLAGGED").length} · người đã kiểm ${plan.filter((p) => p.action === "ALREADY_REVIEWED").length} · qua giai đoạn gắn cờ ${plan.filter((p) => p.action === "STAGE_LOCKED").length} — thêm --apply để ghi`);
  }
  process.exit(0);
}

async function report(rows: readonly ScannedOrder[], args: PriceScanArgs) {
  const scope = args.since ? `từ ${args.since.toISOString()}` : `${args.days} ngày`;
  const live = (r: ScannedOrder) => r.stage !== "CANCELLED";
  const bad = rows.filter((r) => r.verdict.kind === "PRICE_MISMATCH");
  const gap = bad.reduce((s, r) => s + (r.verdict.actual - (r.verdict.expected ?? r.verdict.actual)), 0);
  const unpriceable = rows.filter((r) => r.verdict.kind === "UNPRICEABLE");
  console.log(`Đơn của bot ${scope}: ${rows.length} · tính lại được ${rows.length - unpriceable.length} · lệch ${bad.length} (ESTIMATED — giá danh mục hôm nay)`);
  for (const r of bad) {
    const v = r.verdict;
    console.log(`  PRICE_MISMATCH #${manualOrderShortCode(r.id)} · ${r.stage} · đơn ${vnd(v.actual)} · máy chủ ${vnd(v.expected ?? 0)} · chênh ${vnd(v.actual - (v.expected ?? 0))}${v.missingVolumeDiscount ? " · THIẾU GIẢM KHỐI LƯỢNG" : ""}${v.multiUnit ? " · dòng N × gói đơn vị" : ""}`);
  }
  for (const r of unpriceable) console.log(`  KHÔNG TÍNH LẠI ĐƯỢC #${manualOrderShortCode(r.id)} · ${r.stage} · ${r.verdict.reason}`);
  tomTat(`price-mismatch-scan ${scope}: đơn bot ${rows.length} · PRICE_MISMATCH ${bad.length} (còn sống ${bad.filter(live).length}) · Σ chênh ${vnd(gap)} · thiếu giảm khối lượng ${bad.filter((r) => r.verdict.missingVolumeDiscount).length} · có dòng N×gói đơn vị ${bad.filter((r) => r.verdict.multiUnit).length} · không tính lại được ${unpriceable.length} — ESTIMATED; mã đơn trong phần mã hoá`);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("price-mismatch-scan lỗi:", e instanceof Error ? e.message : e);
    tomTat("price-mismatch-scan: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
