/**
 * ═══════════ TRỪ SỐ DƯ AI CHO KHÁCH AI VƯỢT PHẦN GÓI GỒM (docs/saas/AI_BALANCE_V1.md · quyết định chủ shop 08/10/2026) ═══════════
 *
 *  · KHI NÀO TRỪ: ĐÚNG lúc đồng hồ khách AI ghi một khách MỚI của kỳ (`lib/pricing/ai-customer.ts::noteAiCustomerReply` — sau
 *    khi câu trả lời AI đã tới khách) mà số khách của kỳ đã VƯỢT phần gói gồm. Khách đã tính trong kỳ nhắn tiếp ⇒ không trừ thêm.
 *  · TRỪ BAO NHIÊU: đơn giá vượt của CHÍNH phiên bản giá tổ chức đang ghim (`aiCustomerBlockVnd / aiCustomerBlockSize` — V1:
 *    590đ · 490đ · 390đ). Dòng sổ ghi phiên bản + đơn giá + số đơn vị ⇒ đổi bảng giá về sau không đổi dòng cũ.
 *  · CHỈ khi tổ chức đã bật Số dư AI (cờ `ai_balance.enabled`), gói trả phí có phần vượt tính tiền (`overage.mode = BILLED`).
 *    Dùng thử: luật L5 (hết lượt ⇒ phải chọn gói), không trừ số dư. Gói hợp đồng / không giới hạn: không trừ.
 *  · CHỐNG TRÙNG: khoá `aic-charge:<tổ chức>:<khoá khách AI của kỳ>` — một khách một kỳ trừ đúng một lần dù lượt ghi lặp lại.
 *  · LỚP TIỀN: trừ tiền TẶNG trước nếu đủ một đơn giá, không thì tiền THẬT (đề xuất chờ kế toán duyệt — AI_BALANCE_V1 §4.6).
 *  · Phí khách ≠ chi phí nhà cung cấp: dòng này là DOANH THU dùng AI; chi phí thật vẫn ở `platform_ai_usage`, không gộp.
 *
 * Cổng «hết số dư ⇒ chặn khách AI MỚI» nằm ở `lib/pricing/ai-gate.ts::aiBalanceGate` (cùng một cổng gói, không cổng thứ hai);
 * tệp này chỉ cấp hai hàm thuần-ít-đọc cho nó: `balanceOverageTerms` (đơn giá + phần gồm) và `runAiBalanceAlerts` (báo chủ shop).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { aiBalanceEnabled, postAiLedgerEntry, readAiBalance } from "@/lib/billing/ai-balance";
import { balanceForecast, LOW_BALANCE_DEFAULT_VND } from "@/lib/billing/ai-balance-rules";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { resolveOrgPricing } from "@/lib/pricing/entitlements";

/** Đơn giá vượt + phần gồm của gói đang áp — `null` = tổ chức này KHÔNG trừ số dư (dùng thử · hợp đồng · không giới hạn · chưa khai). */
export type BalanceOverageTerms = { included: number; unitPriceVnd: number; priceVersionKey: string };

export async function balanceOverageTerms(orgCode: string): Promise<BalanceOverageTerms | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  const price = (await resolveOrgPricing(org)).plan?.planPrice ?? null;
  if (!price || price.trialDays !== null) return null;
  const included = price.included.aiCustomers;
  const { mode, aiCustomerBlockSize: size, aiCustomerBlockVnd: block } = price.overage;
  if (typeof included !== "number" || mode !== "BILLED" || !size || !block || size <= 0 || block <= 0) return null;
  return { included, unitPriceVnd: Math.ceil(block / size), priceVersionKey: price.versionKey };
}

export type AiUsageChargeResult =
  | { charged: true; unitPriceVnd: number; fundsClass: "CASH" | "PROMO"; entryId: string }
  | { charged: false; reason: "DISABLED" | "NO_TERMS" | "WITHIN_INCLUDED" | "ALREADY_CHARGED" };

/**
 * Trừ số dư cho MỘT khách AI mới của kỳ. `periodCount` = số khách AI của kỳ SAU lượt ghi này (người gọi đọc từ chính sổ đồng
 * hồ — tệp này không import đồng hồ để không vòng import). Ném khi sổ hỏng; người gọi ở runtime nuốt lỗi và đếm.
 */
export async function chargeAiCustomerUsage(input: { orgCode: string; eventKey: string; at: Date; periodCount: number }): Promise<AiUsageChargeResult> {
  if (!(await aiBalanceEnabled(input.orgCode))) return { charged: false, reason: "DISABLED" };
  const terms = await balanceOverageTerms(input.orgCode);
  if (!terms) return { charged: false, reason: "NO_TERMS" };
  if (input.periodCount <= terms.included) return { charged: false, reason: "WITHIN_INCLUDED" };
  const pdb = await getPlatformDb();
  return pdb.transaction(async (tx) => {
    const bal = await readAiBalance(input.orgCode, tx);
    const fundsClass = bal.promoVnd >= terms.unitPriceVnd ? "PROMO" : "CASH";
    const posted = await postAiLedgerEntry(tx, {
      orgCode: input.orgCode,
      entryType: "AI_USAGE",
      fundsClass,
      amountVnd: -terms.unitPriceVnd,
      idempotencyKey: `aic-charge:${input.orgCode}:${input.eventKey}`,
      sourceType: "AI_CUSTOMER",
      sourceRef: input.eventKey,
      priceVersionKey: terms.priceVersionKey,
      unitPriceVnd: terms.unitPriceVnd,
      units: 1,
      note: `Khách AI thứ ${input.periodCount.toLocaleString("vi-VN")} của kỳ (gói gồm ${terms.included.toLocaleString("vi-VN")})`,
      occurredAt: input.at,
    });
    return posted.created ? { charged: true as const, unitPriceVnd: terms.unitPriceVnd, fundsClass, entryId: posted.id } : { charged: false as const, reason: "ALREADY_CHARGED" as const };
  });
}

// ─────────────────────────── Báo số dư thấp / hết số dư ───────────────────────────

export type AiBalanceAlertRun = { sent: "LOW" | "EXHAUSTED" | null; balanceVnd: number | null; skipped: string | null };

const VN_OFFSET_MS = 7 * 3_600_000;
const vnDayKey = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);

/**
 * MỘT lượt kiểm cho tổ chức NGỮ CẢNH (chạy trong job `sales-health` sẵn có — không lịch mới). Hết số dư ⇒ báo «hết» (AI đã
 * ngừng nhận khách mới); dưới ngưỡng khách khai ⇒ báo «sắp hết» kèm dự kiến số ngày. MỘT dòng chuông mỗi mức mỗi NGÀY (khoá
 * chống trùng theo ngày giờ VN). Chỉ tổ chức đã bật Số dư AI và có gói trừ số dư. Không ném.
 */
export async function runAiBalanceAlerts(now: Date = new Date()): Promise<AiBalanceAlertRun> {
  try {
    const org = await currentOrganization();
    if (!(await aiBalanceEnabled(org.code))) return { sent: null, balanceVnd: null, skipped: "chưa bật Số dư AI" };
    const terms = await balanceOverageTerms(org.code);
    if (!terms) return { sent: null, balanceVnd: null, skipped: "gói không trừ số dư" };
    const pdb = await getPlatformDb();
    const bal = await readAiBalance(org.code, pdb);
    const [acct] = await pdb.select({ low: schema.platformAiAccounts.lowBalanceVnd }).from(schema.platformAiAccounts).where(eq(schema.platformAiAccounts.orgCode, org.code)).limit(1);
    const threshold = acct?.low ?? LOW_BALANCE_DEFAULT_VND;
    const level = bal.totalVnd <= 0 ? "EXHAUSTED" : bal.totalVnd < threshold ? "LOW" : null;
    if (!level) return { sent: null, balanceVnd: bal.totalVnd, skipped: "số dư trên ngưỡng" };
    const spend7 = await readSpend7d(org.code, now);
    const f = balanceForecast({ balanceVnd: bal.totalVnd, spend7dVnd: spend7, daysToMonthEnd: vnDaysToMonthEnd(now) });
    const vnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`;
    // Cổng chỉ chặn khi khách AI của kỳ đã CHẠM phần gói gồm — trước đó nói «sẽ», không nói «đang» (review 08/10/2026, L3).
    const blocking = level === "EXHAUSTED" && (await aiCustomersThisPeriod(org.code, now)) >= terms.included;
    const title = level === "EXHAUSTED" ? (blocking ? "Số dư AI đã hết — AI tạm không nhận khách mới" : "Số dư AI đã hết — nạp trước khi vượt phần gói gồm") : `Số dư AI sắp hết: còn ${vnd(bal.totalVnd)}`;
    const body =
      level === "EXHAUSTED"
        ? blocking
          ? "Khách đã được AI chăm trong tháng vẫn được trả lời; khách mới chuyển cho nhân viên. Nạp tiền để AI nhận khách mới lại ngay."
          : "AI vẫn trả lời bình thường trong phần khách AI gói đã gồm. Khi vượt phần gồm mà số dư còn 0đ, khách MỚI sẽ chuyển cho nhân viên — nạp trước để không gián đoạn."
        : `Dưới ngưỡng cảnh báo ${vnd(threshold)}${f.daysRemaining !== null ? ` · dự kiến còn ${f.daysRemaining} ngày` : ""}${f.recommendTopupVnd ? ` · nên nạp thêm ${vnd(f.recommendTopupVnd)}` : ""}.`;
    // Khoá chống trùng theo NGÀY + MỨC, và «hết» tách theo đang chặn hay chưa: bản «chưa chặn» buổi sáng không được nuốt bản «AI
    // đã ngừng nhận khách mới» khi khách AI chạm phần gói gồm trong cùng ngày (review Số dư AI 08/10/2026, LOW).
    const db = await getDb();
    const inserted = await db
      .insert(schema.notifications)
      .values({ kind: "SYSTEM", severity: level === "EXHAUSTED" ? "critical" : "warning", title, body, href: "/settings/ai-balance", entityType: "AI_BALANCE", entityId: `ai-balance:${level}`, dedupeKey: `ai-balance:${org.code}:${vnDayKey(now)}:${level}${level === "EXHAUSTED" && blocking ? ":BLOCKING" : ""}`, occurredAt: now })
      .onConflictDoNothing({ target: schema.notifications.dedupeKey })
      .returning({ id: schema.notifications.id });
    return inserted.length ? { sent: level, balanceVnd: bal.totalVnd, skipped: null } : { sent: null, balanceVnd: bal.totalVnd, skipped: "mức này đã báo hôm nay" };
  } catch (e) {
    return { sent: null, balanceVnd: null, skipped: `lỗi: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}` };
  }
}

/** Số ngày còn lại của tháng (giờ VN), tính cả hôm nay. */
function vnDaysToMonthEnd(now: Date): number {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 0)).getUTCDate() - vn.getUTCDate() + 1;
}

/**
 * Khách AI ĐÃ GHI của tháng (giờ VN) — đọc thẳng sổ đồng hồ. Không import `lib/pricing/ai-customer.ts` (tệp ấy import tệp
 * này ⇒ vòng import); hai chuỗi sản phẩm / chỉ số khoá bằng bài kiểm mã nguồn.
 */
async function aiCustomersThisPeriod(orgCode: string, now: Date): Promise<number> {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  const from = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3_600_000);
  const e = schema.platformUsageEvents;
  const [row] = await (await getPlatformDb())
    .select({ n: sql<number>`coalesce(sum(${e.quantity}), 0)::int` })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.productKey, "chotdon"), eq(e.metric, "ai_customers"), gte(e.occurredAt, from)));
  return Number(row?.n ?? 0);
}

async function readSpend7d(orgCode: string, now: Date): Promise<number> {
  const pdb = await getPlatformDb();
  const e = schema.platformAiLedgerEntries;
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [row] = await pdb
    .select({ spent: sql<string>`coalesce(sum(-${e.amountVnd}), 0)::bigint` })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.entryType, "AI_USAGE"), gte(e.occurredAt, since)));
  return Number(row?.spent ?? 0);
}
