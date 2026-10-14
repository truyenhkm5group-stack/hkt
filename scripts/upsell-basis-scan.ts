/*
  ops `upsell-basis-scan` — ĐƠN CỦA BOT CÓ DÒNG HÀNG KHÔNG CÓ CĂN CỨ TỪ KHÁCH (món upsell khách chưa đồng ý · số lượng bot tự tăng).

  Vì sao có (P0 HSLC 14/10/2026, ca «Châu Dương» #91F3641C): khách chọn 1kg chả cá thu 280.000 ₫; bot gửi câu mời thêm món rồi tự đưa
  «Nem hải sản tôm bề bề · Hộp 10 cái × 3» vào đơn nháp — đơn tự chốt 640.000 ₫. Bản sửa của máy chủ (`lineBasisViolation`,
  lib/sales-chatbot/cart-commitment.ts) chặn từ nay; đơn ĐÃ tạo trước đó vẫn nằm đó. Script này dựng lại GIỎ CÓ THẨM QUYỀN của hội thoại
  bằng CHÍNH luật của máy chủ (`applyCustomerCartMessage` trên từng tin khách tới lúc đơn được ghi lần cuối) rồi hỏi `lineBasisViolation`
  với dòng hàng THẬT của đơn (quy gói bằng `computePriced` — cùng phép tính của lõi đơn).

  Kết quả là ƯỚC TÍNH (ESTIMATED): giỏ dựng lại từ chữ khách hôm nay; hội thoại không có món khách nói tường minh ⇒ KHÔNG kết luận (đếm
  riêng «không đủ căn cứ»), đúng luật an toàn của bản sửa (không chắc thì không chặn).

  `--flag` = kế hoạch gắn cờ UPSELL_UNCONSENTED cho đơn còn sống (CHẠY THỬ, chỉ in); `--flag --apply` = gắn qua lõi đơn
  (`flagOrderForReviewAsAgent` — khoá dòng, nhật ký ORDER_REVIEW). KHÔNG đổi dòng / tiền đơn, KHÔNG gửi tin: người kiểm gọi khách rồi
  sửa đơn. Idempotent: đơn đang có cờ, hoặc người ĐÃ kiểm cờ này ⇒ bỏ qua.

  Tóm tắt [ops:tom-tat] chỉ số đếm / tiền; mã đơn chỉ ở phần MÃ HOÁ (trừ mã ngắn #XXXXXXXX ở dòng kế hoạch --flag, như price-mismatch-scan).
  Không `--apply` ⇒ CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại `default_transaction_read_only`).

  arg: `<mã tổ chức> [--days=1..30] [--flag [--apply]]` (mặc định 7 ngày).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("upsell-basis-scan.ts"));
const SE_GHI = process.argv.includes("--flag") && process.argv.includes("--apply");
if (CHAY_THANG && !SE_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, getDbForInspection, schema, type Db } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { canFlagOrderForReview, orderReviewLogOf, orderReviewOf } from "@/lib/constants/order-review";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { flagOrderForReviewAsAgent } from "@/lib/records/order-create";
import { applyCustomerCartMessage, lineBasisViolation, type AskedLine, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { computePriced, loadPricingContext, orgPricingConfig } from "@/lib/sales-chatbot/quote";
import { rowsOf } from "@/lib/sql-rows";

export const UPSELL_SCAN_DEFAULT_DAYS = 7;
export const UPSELL_SCAN_MAX_DAYS = 30;
const USAGE = `<mã tổ chức> [--days=1..${UPSELL_SCAN_MAX_DAYS}] [--flag [--apply]]`;
export const UPSELL_SCAN_AGENT = { name: "Người vận hành (ops upsell-basis-scan)", source: "scripts/upsell-basis-scan.ts" } as const;
const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const vnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")} ₫`;

export type UpsellScanArgs = { code: string; days: number; flag: boolean; apply: boolean };

export function parseUpsellScanArgs(argv: readonly string[]): UpsellScanArgs | { error: string } {
  const bad = argv.find((a) => a.startsWith("--") && !/^--days=|^--(flag|apply)$/.test(a));
  if (bad) return { error: `cờ lạ ${bad.slice(0, 20)}` };
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? UPSELL_SCAN_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > UPSELL_SCAN_MAX_DAYS) return { error: `--days phải là số nguyên 1..${UPSELL_SCAN_MAX_DAYS}` };
  const flag = argv.includes("--flag");
  const apply = argv.includes("--apply");
  if (apply && !flag) return { error: "--apply chỉ đi cùng --flag" };
  return { code, days, flag, apply };
}

export type BasisVerdict = { kind: "OK" | "NO_BASIS" | "UNKNOWN"; reason: string | null };

/**
 * Giỏ có thẩm quyền dựng lại từ tin khách (theo thứ tự) ⇒ phán quyết căn cứ cho dòng hàng của đơn. Giỏ không có món khách nói tường minh
 * ⇒ UNKNOWN (không kết luận). HÀM THUẦN.
 */
export function basisVerdictOf(customerTexts: readonly { text: string; seq: number; at: Date }[], asked: readonly AskedLine[], catalog: readonly string[]): BasisVerdict {
  let cart: CartCommitment | undefined;
  for (const m of customerTexts) {
    try {
      cart = applyCustomerCartMessage(cart, m.text, m.seq, m.at, { catalog });
    } catch {
      /* luật giỏ ném ⇒ giữ giỏ cũ, như engine */
    }
  }
  if (!cart?.selectedItems.some((x) => x.customerExplicit)) return { kind: "UNKNOWN", reason: "Hội thoại không có món khách nói tường minh — không đủ căn cứ để kết luận" };
  const v = lineBasisViolation(cart, asked, null);
  return v ? { kind: "NO_BASIS", reason: v } : { kind: "OK", reason: null };
}

export type ScannedUpsell = { id: string; stage: string; total: number; verdict: BasisVerdict; raw: unknown };

/** Đơn của bot (có hội thoại) trong N ngày ⇒ phán quyết căn cứ. Chỉ ĐỌC. */
export async function scanUpsellBasis(db: Db, days: number, now: Date = new Date()): Promise<ScannedUpsell[]> {
  const o = schema.orders;
  const since = new Date(now.getTime() - days * 86_400_000);
  const orders = await db
    .select({ id: o.id, stage: sql<string>`${o.stage}::text`, conv: o.salesConversationId, at: o.insertedAt, updatedAt: o.updatedAt, total: o.totalPriceAfterDiscount, fee: o.shippingFee, raw: o.raw })
    .from(o)
    .where(and(gte(o.insertedAt, since), isNotNull(o.salesConversationId), isNotNull(sql`${o.raw}->>'agent'`)));
  if (!orders.length) return [];
  const it = schema.orderItems;
  const items = await db.select({ orderId: it.orderId, variantId: it.variantId, quantity: it.quantity }).from(it).where(inArray(it.orderId, orders.map((x) => x.id)));
  const ctx = await loadPricingContext(await orgPricingConfig(db), null, db);
  const catalog = [...new Set([...ctx.byId.values()].map((c) => c.name))];
  const m = schema.salesChatMessages;
  const convIds = [...new Set(orders.map((x) => x.conv!))];
  const msgs = convIds.length ? await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(inArray(m.conversationId, convIds)).orderBy(asc(m.conversationId), asc(m.seq)) : [];
  const out: ScannedUpsell[] = [];
  for (const ord of orders) {
    const until = Math.max(ord.at?.getTime() ?? 0, ord.updatedAt?.getTime() ?? 0);
    const texts = msgs
      .filter((x) => x.conv === ord.conv && x.role === "user" && x.at.getTime() <= until)
      .map((x) => {
        const blocks = Array.isArray(x.content) ? (x.content as { type?: unknown; text?: unknown }[]) : [];
        if (blocks.some((b) => b.type === "tool_result")) return null;
        const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n").trim();
        return text ? { text, seq: x.seq, at: x.at } : null;
      })
      .filter((x): x is { text: string; seq: number; at: Date } => x !== null);
    const lines = items.filter((x) => x.orderId === ord.id && x.variantId).map((x) => ({ variantId: x.variantId!, quantity: x.quantity }));
    const asked = computePriced(lines, ctx).asked;
    out.push({ id: ord.id, stage: ord.stage, total: Number(ord.total ?? 0) + Number(ord.fee ?? 0), verdict: basisVerdictOf(texts, asked, catalog), raw: ord.raw });
  }
  return out;
}

export type UpsellFlagPlan = { id: string; action: "FLAG" | "ALREADY_FLAGGED" | "ALREADY_REVIEWED" | "STAGE_LOCKED"; stage: string; note: string };

/** Kế hoạch gắn cờ cho đơn NO_BASIS còn sống — HÀM THUẦN (cùng luật bỏ qua với price-mismatch-scan). */
export function planUpsellFlags(rows: readonly ScannedUpsell[]): UpsellFlagPlan[] {
  return rows
    .filter((r) => r.verdict.kind === "NO_BASIS" && r.stage !== "CANCELLED" && r.stage !== "DELETED")
    .map((r) => {
      const note = `Đơn có dòng hàng KHÔNG có căn cứ từ khách (ước tính từ hội thoại): ${(r.verdict.reason ?? "").split(":")[0].slice(0, 160)}. Tổng đơn ${vnd(r.total)}. Gọi khách xác nhận món + số lượng, sửa đơn rồi «Xác nhận đơn».`.slice(0, 300);
      const action: UpsellFlagPlan["action"] = orderReviewOf(r.raw)?.entries.some((e) => e.code === "UPSELL_UNCONSENTED")
        ? "ALREADY_FLAGGED"
        : orderReviewLogOf(r.raw).some((l) => l.entries.some((e) => e.code === "UPSELL_UNCONSENTED"))
          ? "ALREADY_REVIEWED"
          : canFlagOrderForReview(r.stage)
            ? "FLAG"
            : "STAGE_LOCKED";
      return { id: r.id, action, stage: r.stage, note };
    });
}

export async function applyUpsellFlags(plan: readonly UpsellFlagPlan[], now: Date = new Date()): Promise<{ flagged: string[]; failed: string[] }> {
  const flagged: string[] = [];
  const failed: string[] = [];
  for (const p of plan.filter((x) => x.action === "FLAG")) {
    const r = await flagOrderForReviewAsAgent(UPSELL_SCAN_AGENT, p.id, { code: "UPSELL_UNCONSENTED", note: p.note, quote: null }, now);
    if (r.ok && r.flagged) flagged.push(p.id);
    else failed.push(p.id);
  }
  return { flagged, failed };
}

export function reportUpsellScan(rows: readonly ScannedUpsell[], days: number) {
  const bad = rows.filter((r) => r.verdict.kind === "NO_BASIS");
  const unknown = rows.filter((r) => r.verdict.kind === "UNKNOWN").length;
  console.log(`Đơn của bot ${days} ngày có hội thoại: ${rows.length} · KHÔNG căn cứ ${bad.length} · không đủ căn cứ để kết luận ${unknown} (ESTIMATED)`);
  for (const r of bad) console.log(`  NO_BASIS #${manualOrderShortCode(r.id)} · ${r.stage} · tổng ${vnd(r.total)} · ${(r.verdict.reason ?? "").slice(0, 200)}`);
  const live = bad.filter((r) => r.stage !== "CANCELLED" && r.stage !== "DELETED");
  tomTat(`upsell-basis-scan ${days} ngày: đơn bot có hội thoại ${rows.length} · dòng hàng KHÔNG căn cứ ${bad.length} (còn sống ${live.length} · Σ tổng ${vnd(live.reduce((s, r) => s + r.total, 0))}) · không đủ căn cứ để kết luận ${unknown} — ESTIMATED; mã đơn trong phần mã hoá`);
}

async function main() {
  const args = parseUpsellScanArgs(process.argv.slice(2));
  const done = (code: number) => process.stdout.write("", () => process.exit(code));
  if ("error" in args) {
    tomTat(`upsell-basis-scan: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return done(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`upsell-basis-scan: DỪNG · không có tổ chức «${args.code}»`);
    return done(1);
  }
  if (args.apply) {
    await withOrganization(org.code, async () => {
      const rows = await scanUpsellBasis(await getDb(), args.days);
      reportUpsellScan(rows, args.days);
      const plan = planUpsellFlags(rows);
      const r = await applyUpsellFlags(plan);
      tomTat(`upsell-basis-scan --flag: ĐÃ GẮN CỜ ${r.flagged.length}${r.flagged.length ? ` (${r.flagged.slice(0, 20).map((id) => `#${manualOrderShortCode(id)}`).join(" ")})` : ""} · lõi từ chối ${r.failed.length} · đã có cờ ${plan.filter((p) => p.action === "ALREADY_FLAGGED").length} · người đã kiểm ${plan.filter((p) => p.action === "ALREADY_REVIEWED").length} · qua giai đoạn gắn cờ ${plan.filter((p) => p.action === "STAGE_LOCKED").length}`);
    });
    return done(0);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("upsell-basis-scan: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return done(70);
  }
  const rows = await scanUpsellBasis(db, args.days);
  reportUpsellScan(rows, args.days);
  if (args.flag) {
    const plan = planUpsellFlags(rows);
    for (const p of plan) console.log(`  KẾ HOẠCH ${p.action} #${manualOrderShortCode(p.id)} · ${p.stage} · ${p.note}`);
    const will = plan.filter((p) => p.action === "FLAG");
    tomTat(`upsell-basis-scan --flag CHẠY THỬ: sẽ gắn cờ ${will.length}${will.length ? ` (${will.slice(0, 20).map((p) => `#${manualOrderShortCode(p.id)}`).join(" ")})` : ""} · đã có cờ ${plan.filter((p) => p.action === "ALREADY_FLAGGED").length} · người đã kiểm ${plan.filter((p) => p.action === "ALREADY_REVIEWED").length} · qua giai đoạn gắn cờ ${plan.filter((p) => p.action === "STAGE_LOCKED").length} — thêm --apply để ghi`);
  }
  return done(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("upsell-basis-scan lỗi:", e instanceof Error ? e.message : e);
    tomTat("upsell-basis-scan: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}
