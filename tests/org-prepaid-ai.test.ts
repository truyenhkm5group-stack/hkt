/**
 * CHẾ ĐỘ «AI DÙNG CHUNG TRẢ TRƯỚC THEO KHÁCH AI» (docs/saas/AI_BALANCE_V1.md §7 · quyết định chủ shop 08/10/2026).
 *
 *  1. THUẦN — dòng giá trả trước (khách AI gồm 0 + khối khách AI) không trùng dòng nào của bảng giá V1 / legacy · đơn giá dẫn
 *     xuất = giá vượt của gói AI tự mua rẻ nhất (V1 Starter ⇒ 590đ) · phần vượt của dòng trả trước KHÔNG có dòng khách AI / ghế ·
 *     trần AI: cờ bật ⇒ softOnly (credit không chặn), cờ tắt ⇒ trần cũ (credit là trần CỨNG) · bước kế tiếp (bảng chân lý) · mức
 *     dùng quy ra tiền (chưa đo được ⇒ `null`, không 0) · cách dùng ops.
 *  2. MÃ NGUỒN — script mặc định CHỈ ĐỌC + hỏi lại Postgres · không ghi thẳng bảng nào · không đổi động cơ / credit · log công
 *     khai không mang số tiền · không nhánh theo mã tổ chức · ops-vps đăng ký thao tác (mã hoá kết quả).
 *  3. VÒNG THẬT (PGlite, hai tổ chức ở giá cũ `standard`): chưa khai tài khoản nhận ⇒ CHẶN, không ghi · MỞ NẠP (cờ, nhật ký
 *     SCRIPT) mà chưa trừ / chặn gì · số dư 0 ⇒ KHÔNG ghim · nạp QR (SePay xác nhận) cộng ĐÚNG một lần dù đối chiếu chạy nhiều lần
 *     · KÍCH HOẠT: phát hành phiên bản (chỉ tới bằng ghim) + ghim, giá thuê bao không đổi · mỗi khách AI MỚI trừ đúng 590đ, một lần
 *     · hết số dư ⇒ khách mới không nhận AI, khách đã tính vẫn được trả lời · AI dùng chung mở được (nguồn PLATFORM) và credit
 *     KHÔNG phải cổng · tắt cờ ⇒ credit thành trần cứng lại · tổ chức khác giữ nguyên hành vi · chạy thử không ghi một dòng nào.
 *  4. REVIEW #674: hoá đơn gia hạn đang mở theo giá cũ CHẶN kích hoạt; hoá đơn giá cũ cùng gói trả SAU kích hoạt KHÔNG ghim lùi (đổi
 *     sang gói V1 thì ghim theo hoá đơn) · credit = ngưỡng cảnh báo, trần cứng chống lạm dụng = credit × 3, chưa credit ⇒ trần của
 *     gói · `--unit` phải khớp đơn giá · số dư ≥ max(100.000đ, 1 ngày) hoặc `--force-low-balance` · cảnh báo «đang thu 590đ mà bot
 *     còn khoá riêng» và «AI dùng chung chạy mà không ở trả trước» · `isPrepaidAiPrice` chỉ nhận kind chỉ-ghim.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { platformChatAi } from "@/lib/ai-builder/provider";
import { invalidateAiControl, setOrgAiLimitAsOperator, SCRIPT_AI_LIMIT_KEY } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { checkAiQuota, resolveAiLimits } from "@/lib/ai-usage/quota";
import { applyAiOverride, EMPTY_SOURCE_USAGE, evaluateAiQuota, parseAiLimits } from "@/lib/ai-usage/types";
import { createAiTopupIntent, postAiLedgerEntry, readAiBalance } from "@/lib/billing/ai-balance";
import { balanceOverageTerms, chargeAiCustomerUsage } from "@/lib/billing/ai-usage-charge";
import { applyPrepaidAiStep, planPrepaidAi, prepaidHoursCovered, prepaidMinActivateVnd, prepaidStep, prepaidUsageEstimate } from "@/lib/billing/prepaid-ai";
import { BILLING_RECEIVER_KEY, markInvoicePaidManually, reconcileBillingPayments, setBillingReceiver, voidInvoice } from "@/lib/billing/service";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { listPlans } from "@/lib/entitlements/check";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setAiBalanceEnabled } from "@/lib/platform/kill-switches";
import { AI_BALANCE_FLAG, invalidateOrgFlags } from "@/lib/platform/org-flags";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { noteAiCustomerReply, resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { invalidateAiEntitlement, salesAiPlanGate } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { AI_CUSTOMER_METER_LIVE_KEY, invalidatePriceBook, loadPriceBook, pinOrgPriceVersion, plansForOrg } from "@/lib/pricing/price-book";
import { usagePeriodOf } from "@/lib/pricing/meter";
import {
  catalogAiLimits,
  computeOverage,
  currentCatalogVersion,
  isPrepaidAiPrice,
  LEGACY_VERSION_KEY,
  prepaidAiLimits,
  prepaidAiPriceRows,
  prepaidAiTerms,
  PREPAID_AI_VERSION_KEY,
} from "@/lib/pricing/versions";
import { SALES_CHATBOT_SETTING_KEY, salesBotBillingSource } from "@/lib/sales-chatbot/config";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { rowsOf } from "@/lib/sql-rows";
import { parsePrepaidArgs, planLines } from "../scripts/org-prepaid-ai";

const P = "pai-pre";
const O = "pai-oth";
const ORGS = [P, O] as const;
const PAGE = "778899001122";
const REF = "pai-test-";
const OP_EMAIL = "op@pai.local";
const goc = process.cwd();
const read = (f: string) => readFileSync(path.join(goc, f), "utf8");
const boChuThich = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pai-user", email: "pai@local", name: "PAI", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

// ─────────────────────────── 1 · THUẦN ───────────────────────────

async function testPure() {
  const now = new Date();
  const book = await loadPriceBook({ fresh: true });
  const catalog = currentCatalogVersion(book, now);
  assert.ok(catalog, "sổ giá có bảng giá niêm yết");
  const catRows = book.prices.filter((p) => p.versionKey === catalog.key);
  const legacyRows = book.prices.filter((p) => p.versionKey === LEGACY_VERSION_KEY);
  assert.ok(legacyRows.length > 0, "có phiên bản giá cũ");
  const kindOf = (key: string) => book.versions.find((v) => v.key === key)?.kind ?? null;
  assert.deepEqual([...catRows, ...legacyRows].filter((p) => isPrepaidAiPrice(p, kindOf(p.versionKey))).map((p) => `${p.versionKey}:${p.planKey}`), [], "không dòng giá V1 / legacy nào bị coi là trả trước (Inbox gồm 0 nhưng không có khối khách AI)");

  const terms = prepaidAiTerms(catRows);
  assert.deepEqual(terms && [terms.blockSize, terms.blockVnd, terms.unitPriceVnd, terms.fromPlanKey], [100, 59_000, 590, "starter"], "đơn giá = giá vượt của gói AI tự mua rẻ nhất (Starter V1)");
  assert.equal(prepaidAiTerms(catRows.filter((p) => p.planKey === "inbox" || p.planKey === "trial" || p.planKey === "enterprise")), null, "không gói AI tự mua nào khai giá vượt ⇒ không đoán đơn giá");

  const rows = prepaidAiPriceRows(legacyRows, terms!, PREPAID_AI_VERSION_KEY);
  assert.ok(rows.every((r) => isPrepaidAiPrice(r, "LEGACY_SNAPSHOT")) && rows.every((r) => r.versionKey === PREPAID_AI_VERSION_KEY && !r.listed && r.trialDays === null), "mọi dòng chép là trả trước, không niêm yết, không dùng thử");
  const std = legacyRows.find((p) => p.planKey === "standard")!;
  const stdPre = rows.find((p) => p.planKey === "standard")!;
  assert.deepEqual([stdPre.monthlyVnd, stdPre.yearlyFreeMonths, stdPre.features, stdPre.addonPrices], [std.monthlyVnd, std.yearlyFreeMonths, std.features, std.addonPrices], "giá thuê bao / tính năng / mua thêm giữ như giá cũ");
  assert.equal(std.included.aiCustomers, undefined, "nguồn chép không bị sửa");
  const over = computeOverage(stdPre, { aiCustomers: 2_000, aiCustomersCoverage: "MEASURED", fanpages: 99, users: 99, aiConversations: null, aiReplies: null });
  assert.deepEqual([over.lines.map((l) => l.key), over.totalVnd], [["fanpages", "users"], 0], "không dòng khách AI (đã trừ Số dư) · không phần vượt ghế (như giá cũ)");

  // Trần AI (review #674 M2 · L6 · L7): cờ bật + CHƯA credit ⇒ y như gói cũ; có credit ⇒ softOnly, credit = ngưỡng cảnh báo, trần
  // cứng chống lạm dụng = credit × 3; cờ tắt ⇒ trần cũ (credit trần CỨNG); gói CATALOG «gồm 0 + khối» KHÔNG phải trả trước.
  const stdLimits = parseAiLimits((await listPlans()).find((p) => p.key === "standard")?.limits).limits;
  const hit = { price: stdPre, source: "VERSION" as const };
  const live = catalogAiLimits({ hit, versionKind: "LEGACY_SNAPSHOT", versionPrices: rows, criticalBelowPct: 60, usdToVnd: 25_000, prepaid: { live: true, planLimits: stdLimits } });
  assert.deepEqual(live, prepaidAiLimits(stdLimits));
  const noCredit = applyAiOverride(live!, {});
  assert.deepEqual({ ...noCredit, prepaid: undefined }, { ...stdLimits, prepaid: undefined }, "chưa có credit (bot còn khoá riêng) ⇒ trần y như gói cũ, không softOnly");
  const withCredit = applyAiOverride(live!, { platformCreditUsdPerMonth: 5 });
  assert.deepEqual([withCredit.softOnly, withCredit.costUsdPerMonth.soft, withCredit.costUsdPerMonth.hard, withCredit.requestsPerDay], [true, 5, 15, stdLimits.requestsPerDay], "credit 5 ⇒ cảnh báo 5 · trần chống lạm dụng 15 · trần lượt của gói");
  assert.deepEqual(applyAiOverride(live!, { platformCreditUsdPerMonth: 5, costUsdHard: 40, costUsdSoft: null }).costUsdPerMonth, { soft: null, hard: 40 }, "ghi đè tường minh của người vận hành thắng");
  assert.equal(catalogAiLimits({ hit, versionKind: "LEGACY_SNAPSHOT", versionPrices: rows, criticalBelowPct: 60, usdToVnd: 25_000, prepaid: { live: false, planLimits: stdLimits } }), null, "cờ tắt ⇒ trần cũ của gói");
  assert.equal(catalogAiLimits({ hit, versionKind: "CATALOG", versionPrices: rows, criticalBelowPct: 60, usdToVnd: 25_000 }), null, "không khai cờ ⇒ phía hẹp");
  assert.equal(isPrepaidAiPrice(stdPre, "CATALOG"), false, "gói CATALOG «gồm 0 + khối khách AI» không bị coi là trả trước");
  assert.equal(isPrepaidAiPrice(stdPre, null), false);
  const growth = catRows.find((p) => p.planKey === "growth")!;
  const gIn = { hit: { price: growth, source: "VERSION" as const }, versionKind: "CATALOG" as const, versionPrices: catRows, criticalBelowPct: 60, usdToVnd: 25_000 };
  assert.deepEqual(catalogAiLimits({ ...gIn, prepaid: { live: true, planLimits: stdLimits } }), catalogAiLimits(gIn), "gói V1 không trả trước ⇒ trần y như cũ");
  const spent = (usd: number) => ({ ...EMPTY_SOURCE_USAGE, costUsdMonth: usd });
  const v10 = evaluateAiQuota("PLATFORM", withCredit, spent(10));
  assert.ok(v10.ok && v10.softExceeded, "trả trước: 10 USD > credit 5 vẫn cho, kèm CẢNH BÁO — cổng khách mới là Số dư");
  const v15 = evaluateAiQuota("PLATFORM", withCredit, spent(15));
  assert.ok(!v15.ok && v15.reason === "COST_HARD", "chạm trần chống lạm dụng (credit × 3) ⇒ chặn");
  assert.equal(evaluateAiQuota("PLATFORM", noCredit, spent(0)).ok, false, "chưa credit ⇒ AI dùng chung đóng như gói cũ");
  assert.equal(evaluateAiQuota("PLATFORM", applyAiOverride(stdLimits, { platformCreditUsdPerMonth: 5 }), spent(10)).ok, false, "giá cũ: credit là trần cứng");

  // Bước kế tiếp.
  const s = (blockers: string[], onPrepaid: boolean, flagOn: boolean, balanceVnd: number | null, more: { minBalanceVnd?: number; forceLowBalance?: boolean; activationBlockers?: string[] } = {}) => prepaidStep({ blockers, onPrepaid, flagOn, balanceVnd, ...more });
  assert.deepEqual(
    [
      s(["x"], false, false, 9),
      s([], false, false, null),
      s([], false, true, 0),
      s([], false, true, null),
      s([], false, true, -5),
      s([], false, true, 1),
      s([], false, true, 99_999),
      s([], false, true, 100_000),
      s([], false, true, 300_000, { minBalanceVnd: 400_000 }),
      s([], false, true, 1, { forceLowBalance: true }),
      s([], false, true, 0, { forceLowBalance: true }),
      s([], false, true, 500_000, { activationBlockers: ["hoá đơn mở"] }),
      s([], true, true, 0),
      s([], true, false, 9),
    ],
    ["BLOCKED", "OPEN_TOPUP", "WAIT_TOPUP", "WAIT_TOPUP", "WAIT_TOPUP", "WAIT_TOPUP", "WAIT_TOPUP", "ACTIVATE", "WAIT_TOPUP", "ACTIVATE", "WAIT_TOPUP", "BLOCKED", "ACTIVE", "BLOCKED"],
    "mức kích hoạt = max(100.000đ, 1 ngày); --force-low-balance hạ xuống > 0 nhưng số dư ≤ 0 KHÔNG BAO GIỜ ghim; hoá đơn mở chặn kích hoạt",
  );
  assert.deepEqual([prepaidMinActivateVnd(null), prepaidMinActivateVnd(50_000), prepaidMinActivateVnd(708_000)], [100_000, 100_000, 708_000]);
  assert.deepEqual([prepaidHoursCovered(354_000, 708_000), prepaidHoursCovered(100_000, null), prepaidHoursCovered(-5, 708_000)], [12, null, 0], "đủ ≈ giờ; chưa ước được nhịp ⇒ null, không 0");

  // Mức dùng quy ra tiền.
  const t = new Date("2026-10-08T05:00:00Z");
  const day = (d: string, n: number) => ({ day: d, n });
  const conv = [day("2026-10-01", 2), day("2026-10-04", 300), day("2026-10-06", 900), day("2026-10-07", 1_200)];
  const a = prepaidUsageEstimate({ now: t, meterFirstAt: new Date("2026-10-07T02:00:00Z"), meterByDay: [day("2026-10-07", 700)], convByDay: conv, costByDay: [{ day: "2026-10-07", usd: 3.12 }], unitPriceVnd: 590 });
  assert.deepEqual([a.days7[0], a.days7[6], a.meterFullDays, a.basis, a.customersPerDay, a.vndPerDay, a.topup7dVnd, a.topup30dVnd], ["2026-10-01", "2026-10-07", 0, "CONVERSATIONS", 1_200, 708_000, 5_000_000, 21_300_000], "đồng hồ mới bật (0 ngày trọn) ⇒ hội thoại AI, nhịp = max(trung bình, ngày gần nhất)");
  assert.deepEqual([a.cost7dUsd, a.creditSuggestUsd], [3.12, 117], "ngân sách theo dõi = max(7 ngày × 30/7, ngày gần nhất × 30) × 1,25");
  const b = prepaidUsageEstimate({ now: t, meterFirstAt: new Date("2026-09-30T02:00:00Z"), meterByDay: [day("2026-10-05", 100), day("2026-10-06", 100), day("2026-10-07", 40)], convByDay: conv, costByDay: [], unitPriceVnd: 590 });
  assert.deepEqual([b.meterFullDays, b.basis, b.meterPerDay, b.vndPerDay, b.cost7dUsd, b.creditSuggestUsd], [7, "METER", 40, 23_600, null, null], "đủ ngày trọn ⇒ đồng hồ khách AI; không có chi phí ⇒ chưa biết, không 0");
  const c = prepaidUsageEstimate({ now: t, meterFirstAt: null, meterByDay: [], convByDay: [], costByDay: [], unitPriceVnd: 590 });
  assert.deepEqual([c.basis, c.customersPerDay, c.vndPerDay, c.topup7dVnd, c.topup30dVnd], [null, null, null, null, null], "chưa đo được ⇒ null, không phải 0đ");

  assert.deepEqual(parsePrepaidArgs(["hslc-hmt-shop"]), { ok: true, code: "hslc-hmt-shop", apply: false, unitVnd: null, forceLowBalance: false });
  assert.deepEqual(parsePrepaidArgs(["hslc-hmt-shop", "--apply"]), { ok: true, code: "hslc-hmt-shop", apply: true, unitVnd: null, forceLowBalance: false });
  assert.deepEqual(parsePrepaidArgs(["hslc-hmt-shop", "--apply", "--unit=590", "--force-low-balance"]), { ok: true, code: "hslc-hmt-shop", apply: true, unitVnd: 590, forceLowBalance: true });
  for (const bad of [[], ["a", "b"], ["a", "--aply"], ["a", "--apply", "--apply"], ["a", "--credit=5"], ["a", "--unit=590"], ["a", "--force-low-balance"], ["a", "--apply", "--unit=5.9"], ["a", "--apply", "--unit=0"], ["a", "--apply", "--unit=590", "--unit=591"]])
    assert.equal(parsePrepaidArgs(bad).ok, false, `cách dùng sai: ${bad.join(" ")}`);
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

function testSource() {
  const src = read("scripts/org-prepaid-ai.ts");
  const code = boChuThich(src);
  assert.match(src, /if \(CHAY_THANG && !CO_GHI\) process\.env\.ERP_READ_ONLY = "1";/, "mặc định CHỈ ĐỌC");
  const iRo = code.indexOf("platformDbReadOnly()");
  const iPlan = code.indexOf("planPrepaidAi(");
  assert.ok(iRo > 0 && iRo < code.indexOf("findOrganization(a.code)") && iRo < iPlan, "hỏi lại Postgres TRƯỚC khi đọc");
  assert.ok(!/\bgetPlatformDb\b|\bgetDb\b|getDbFor|\.(?:insert|update|delete)\(|jsonb_set/.test(code), "script không tự mở CSDL / ghi bảng nào — chỉ gọi lõi");
  const lib = boChuThich(read("lib/billing/prepaid-ai.ts"));
  for (const [ten, s] of [["script", code], ["lõi", lib]] as const) {
    assert.ok(!/setOrgAiLimitAsOperator|saveChatbotEngineAsOperator|setBillingReceiver|withOrganization|\bgetDb\(/.test(s), `${ten}: không đặt credit, không đổi động cơ AI, không khai tài khoản nhận tiền, không mở CSDL tổ chức bằng kết nối ghi`);
  }
  assert.match(lib, /getDbForInspection\(org\)/, "động cơ AI đọc bằng kết nối KIỂM TRA (máy chủ ép chỉ đọc)");
  assert.match(boChuThich(read("lib/billing/service.ts")), /const keepPrepaid = isPrepaidVersionKey\(curPin\?\.key\) && invoice\.priceVersionKey === LEGACY_VERSION_KEY && invoice\.planKey === beforeOrg\?\.plan;/, "đường trả hoá đơn không ghim lùi tổ chức trả trước về giá cũ (hẹp: cùng gói)");
  for (const f of ["lib/billing/prepaid-ai.ts", "lib/pricing/versions.ts", "lib/pricing/price-book.ts", "lib/billing/ai-usage-charge.ts", "lib/pricing/ai-gate.ts"]) {
    assert.ok(!/hslc/i.test(boChuThich(read(f))), `${f}: không nhánh theo mã tổ chức`);
  }
  // Log công khai (kho PUBLIC): dòng tomTat không mang số tiền / số dư / mức dùng.
  for (const dong of code.split("\n").filter((d) => d.includes("tomTat(") && !d.includes("const tomTat"))) {
    assert.ok(!/\b(?:vnd|usd|so)\(|toLocaleString|creditSuggest|topup\w*Vnd|vndPerDay|unitPriceVnd|cashVnd|promoVnd/.test(dong), `log công khai không mang số tiền: ${dong.trim().slice(0, 120)}`);
  }
  // Lõi trả trước đọc sổ Số dư AI của MỘT tổ chức theo mã do người vận hành gõ ⇒ chỉ script ops được gọi (miễn trừ S21 khai ở
  // tests/platform-isolation-static.test.ts dựa vào điều này).
  const goiLoi: string[] = [];
  const quet = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const f = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules") quet(f);
      } else if (/\.(?:ts|tsx)$/.test(ent.name) && /\b(?:planPrepaidAi|applyPrepaidAiStep)\(/.test(boChuThich(readFileSync(f, "utf8")))) goiLoi.push(f);
    }
  };
  for (const d of ["lib", "app", "components", "scripts", "chatbot"]) quet(d);
  assert.deepEqual(goiLoi.sort(), ["lib/billing/prepaid-ai.ts", "scripts/org-prepaid-ai.ts"], "lõi trả trước chỉ có định nghĩa + script ops gọi — không server action / trang nào");
  const ops = read(".github/workflows/ops-vps.yml");
  assert.match(ops, /^\s+- org-prepaid-ai\s+#/m, "ops-vps: thao tác có trong danh sách chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\borg-prepaid-ai\b/, "ops-vps: kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\borg-prepaid-ai\b/, "ops-vps: chạy thử là lượt ĐỌC");
  assert.match(ops, /org-prepaid-ai\)\n[\s\S]{0,1500}?fetch_script org-prepaid-ai\.ts[\s\S]{0,300}?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-prepaid-ai\.ts ;;/, "ops-vps: nhánh chạy script qua ma_hoa_ket_qua + chay_voi_arg");
}

// ─────────────────────────── 3 · VÒNG THẬT ───────────────────────────

let txnSeq = 0;
const RECEIVER_ACCOUNT = "0123456789";
async function bankIn(amount: number, description: string): Promise<string> {
  const pdb = await getPlatformDb();
  const bankRef = `${REF}${++txnSeq}`;
  await pdb.insert(schema.bankTransactions).values({ txnAt: new Date(), amount, description, bankRef, source: "WEBHOOK", provider: "SEPAY", providerTxnId: `pai-sepay-${txnSeq}`, account: RECEIVER_ACCOUNT, lastSeenSource: "WEBHOOK" });
  return bankRef;
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformBillingPayments).where(like(schema.platformBillingPayments.bankRef, `${REF}%`));
  await pdb.delete(schema.bankTransactions).where(like(schema.bankTransactions.bankRef, `${REF}%`));
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiLedgerEntries).where(inArray(schema.platformAiLedgerEntries.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPaymentIntents).where(inArray(schema.platformPaymentIntents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiAccounts).where(inArray(schema.platformAiAccounts.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(or(inArray(schema.platformPricePins.orgCode, [...ORGS]), eq(schema.platformPricePins.versionKey, PREPAID_AI_VERSION_KEY)));
  await pdb.delete(schema.platformPlanPrices).where(eq(schema.platformPlanPrices.versionKey, PREPAID_AI_VERSION_KEY));
  await pdb.delete(schema.platformPriceVersions).where(eq(schema.platformPriceVersions.key, PREPAID_AI_VERSION_KEY));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformInvoices).where(inArray(schema.platformInvoices.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.actorEmail, OP_EMAIL));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.subject, `price-version:${PREPAID_AI_VERSION_KEY}`));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
  invalidateOrgFlags();
  invalidateAiControl();
  resetAiCustomerSeenForTests();
}

/** Ảnh chụp mọi bảng mà chế độ trả trước có thể ghi — chạy thử phải để nó NGUYÊN. */
async function writeSnapshot(): Promise<string> {
  const pdb = await getPlatformDb();
  const n = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await pdb.execute(q))[0]?.n ?? 0);
  return JSON.stringify([
    await n(sql`select count(*)::int n from platform_price_versions`),
    await n(sql`select count(*)::int n from platform_plan_prices`),
    await n(sql`select count(*)::int n from platform_price_pins where version_key <> 'legacy' or org_code in (${P}, ${O})`),
    await n(sql`select count(*)::int n from platform_flag_overrides`),
    await n(sql`select count(*)::int n from platform_audit_log`),
    await n(sql`select count(*)::int n from platform_ai_ledger_entries`),
    (await pdb.select({ key: schema.platformPricePins.versionKey }).from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, P)))[0]?.key ?? null,
  ]);
}

async function run() {
  const now = new Date();
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "pai-op", email: OP_EMAIL, organization: { code: home.code, name: home.name, isHome: true } });
  const operator = { orgCode: home.code, email: OP_EMAIL };
  const adminP = await withOrganization(P, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${P}.local`) }));
  assert.ok(adminP);
  const tenantP = sessionUser({ id: adminP.id, email: adminP.email, organization: { code: P, name: P, isHome: false } });
  for (const code of ORGS) await pinOrgPriceVersion(code, LEGACY_VERSION_KEY, { source: "TEST", reason: "Bài kiểm trả trước — giống HSLC (giá cũ)", email: null });
  invalidatePricing();

  // Hành vi CŨ của tổ chức khác — chụp trước, so sau.
  const oLimitsBefore = (await resolveAiLimits(O))?.limits;
  const oPriceBefore = (await plansForOrg(O)).find((p) => p.key === "standard")?.priceVnd;
  assert.equal(await balanceOverageTerms(P), null, "giá cũ: không khối khách AI ⇒ không trừ số dư");

  // ── Chưa khai tài khoản nhận tiền ⇒ CHẶN mọi bước, không ghi; câu nói chủ shop phải khai ở /platform.
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  const snap0 = await writeSnapshot();
  const p0 = await planPrepaidAi(P, now);
  assert.equal(p0.step, "BLOCKED");
  assert.ok(p0.blockers.some((b) => /tài khoản nhận tiền/.test(b) && /\/platform/.test(b)), JSON.stringify(p0.blockers));
  assert.ok(planLines(p0).some((l) => /CHƯA khai — chủ shop cần khai ở \/platform/.test(l)));
  const r0 = await applyPrepaidAiStep(P, operator, now);
  assert.ok("error" in r0 && r0.step === "BLOCKED", JSON.stringify(r0));
  assert.equal(await writeSnapshot(), snap0, "bị chặn ⇒ không ghi một dòng nào");
  assert.ok("ok" in (await setBillingReceiver(op, { bin: "970422", accountNumber: RECEIVER_ACCOUNT, accountName: "Công ty Nền Tảng", reason: "Tài khoản doanh thu nền tảng" })));

  // ── Chạy thử (kế hoạch) KHÔNG ghi; bước kế tiếp = MỞ NẠP.
  const snap1 = await writeSnapshot();
  const p1 = await planPrepaidAi(P, now);
  await planPrepaidAi(P, now);
  assert.equal(await writeSnapshot(), snap1, "chạy thử không ghi");
  assert.deepEqual([p1.step, p1.receiverReady, p1.flagOn, p1.onPrepaid, p1.versionKey, p1.prepaidVersionExists, p1.terms?.unitPriceVnd, p1.prepaidRow?.included.aiCustomers], ["OPEN_TOPUP", true, false, false, LEGACY_VERSION_KEY, false, 590, 0], JSON.stringify(p1.blockers));
  assert.ok(!p1.aiLimitsAfter?.softOnly && p1.warnings.some((w) => /Credit AI dùng chung đang 0/.test(w)), "kế hoạch nói rõ: chưa có credit ⇒ trần gói còn áp, credit đặt cùng lượt cutover");
  assert.deepEqual([p1.engine?.connectorKey, p1.openRenewals, p1.period], ["platform", [], { aiCustomers: 0, charged: 0 }], "chạy thử đọc được động cơ (mặc định của bot), hoá đơn mở, khách AI kỳ / dòng trừ");
  assert.ok(planLines(p1).some((l) => /CHƯA có dòng aic-charge: 0/.test(l)), "chạy thử in khách AI trong kỳ chưa có dòng aic-charge");

  // ── MỞ NẠP: bật cờ (nhật ký SCRIPT); giá cũ ⇒ vẫn chưa trừ, chưa chặn.
  const r1 = await applyPrepaidAiStep(P, operator, now);
  assert.ok("ok" in r1 && r1.step === "OPEN_TOPUP" && r1.changed, JSON.stringify(r1));
  const flagAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, P), eq(schema.platformAuditLog.subject, AI_BALANCE_FLAG)));
  assert.deepEqual(flagAudit.map((a) => [a.action, a.source, a.actorEmail]), [["FLAG_SET", "SCRIPT", null]], "cờ bật qua lõi, nhật ký nguồn SCRIPT, người làm = máy");
  assert.equal(await balanceOverageTerms(P), null, "cờ bật mà còn giá cũ ⇒ vẫn không trừ");

  const conv = async (psid: string) =>
    withOrganization(P, async () => {
      const [r] = await (await getDb()).insert(schema.salesChatConversations).values({ channel: "FANPAGE", pageId: PAGE, threadId: psid, visitorKey: fanpageVisitorKey(PAGE, psid) }).returning();
      return r;
    });
  const gateOf = (c: { channel: string; pageId: string | null; threadId: string | null; visitorKey: string | null }) =>
    withOrganization(P, () => salesAiPlanGate({ now, conversation: { channel: c.channel, pageId: c.pageId, threadId: c.threadId, visitorKey: c.visitorKey } }));
  const note = (id: string) => withOrganization(P, () => noteAiCustomerReply(id, now));
  const usage = async () => pdb.select().from(schema.platformAiLedgerEntries).where(and(eq(schema.platformAiLedgerEntries.orgCode, P), eq(schema.platformAiLedgerEntries.entryType, "AI_USAGE")));
  const c0 = await conv("5100000000400");
  assert.deepEqual(await gateOf(c0), { ok: true }, "MỞ NẠP không chặn khách nào (số dư 0)");
  await note(c0.id);
  assert.equal((await usage()).length, 0, "MỞ NẠP không trừ tiền");

  // ── Cờ BẬT + bot đang ở AI dùng chung (mặc định `platform`) mà CHƯA trả trước ⇒ chạy thử cảnh báo (review #674 M1).
  assert.ok((await planPrepaidAi(P, now)).warnings.some((w) => /bot đang chạy AI DÙNG CHUNG mà tổ chức KHÔNG ở/.test(w)), "cảnh báo AI nền tảng chạy mà không thu");

  // ── Số dư 0 ⇒ CHỜ NẠP, KHÔNG ghim.
  const r2 = await applyPrepaidAiStep(P, operator, now, { unitVnd: 590 });
  assert.ok("error" in r2 && r2.step === "WAIT_TOPUP" && /KHÔNG ghim/.test(r2.error), JSON.stringify(r2));
  assert.equal((await planPrepaidAi(P, now)).versionKey, LEGACY_VERSION_KEY, "số dư 0 ⇒ vẫn giá cũ");

  // ── Số dư dương nhưng dưới mức kích hoạt (100.000đ) ⇒ vẫn CHỜ NẠP; --force-low-balance mới cho (review #674 L2).
  await postAiLedgerEntry(pdb, { orgCode: P, entryType: "ADJUSTMENT", fundsClass: "CASH", amountVnd: 50_000, idempotencyKey: "pai-low-1", sourceType: "OPERATOR", note: "bài kiểm: số dư thấp" });
  const low = await planPrepaidAi(P, now);
  assert.deepEqual([low.step, low.minActivateVnd], ["WAIT_TOPUP", 100_000]);
  const rLow = await applyPrepaidAiStep(P, operator, now, { unitVnd: 590 });
  assert.ok("error" in rLow && /mức kích hoạt/.test(rLow.error) && /--force-low-balance/.test(rLow.error), JSON.stringify(rLow));
  assert.equal((await planPrepaidAi(P, now, { forceLowBalance: true })).step, "ACTIVATE", "--force-low-balance ⇒ số dư > 0 là đủ");
  await postAiLedgerEntry(pdb, { orgCode: P, entryType: "ADJUSTMENT", fundsClass: "CASH", amountVnd: -50_000, idempotencyKey: "pai-low-2", sourceType: "OPERATOR", note: "bài kiểm: hoàn số dư thấp" });

  // ── Nạp QR 100.000đ (SePay xác nhận) ⇒ số dư tăng ĐÚNG một lần dù đối chiếu chạy nhiều lần.
  const intent = await createAiTopupIntent(tenantP, { amountVnd: 100_000 }, now);
  assert.ok("ok" in intent, JSON.stringify(intent));
  await bankIn(100_000, `CK ${intent.intent.referenceCode} nap AI`);
  for (let k = 0; k < 4; k++) await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await readAiBalance(P)).totalVnd, 100_000, "cộng đúng một lần");

  // ── Hoá đơn gia hạn ĐANG MỞ theo giá cũ ⇒ CHẶN kích hoạt (review #674 M1); huỷ đi thì đi tiếp.
  const invoiceOf = async (code: string, planKey: string, versionKey: string, amountVnd: number) => {
    const [r] = await pdb.insert(schema.platformInvoices).values({ orgCode: code, planKey, months: 1, periodStart: "2026-11-01", periodEnd: "2026-11-30", listAmountVnd: amountVnd, amountVnd, transferCode: `ERPHDPA${String(++txnSeq).padStart(4, "2")}`, kind: "RENEWAL", priceVersionKey: versionKey }).returning();
    return r;
  };
  const inv0 = await invoiceOf(P, "standard", LEGACY_VERSION_KEY, 500_000);
  const pInv = await planPrepaidAi(P, now);
  assert.ok(pInv.step === "BLOCKED" && pInv.activationBlockers.some((b) => b.includes(inv0.transferCode) && /huỷ hoặc cho khách TRẢ/.test(b)), JSON.stringify(pInv.activationBlockers));
  assert.ok("error" in (await applyPrepaidAiStep(P, operator, now, { unitVnd: 590 })), "hoá đơn mở ⇒ không kích hoạt");
  assert.ok("ok" in (await voidInvoice(op, { invoiceId: inv0.id, reason: "Bài kiểm: huỷ hoá đơn giá cũ trước khi kích hoạt" })));

  // ── KÍCH HOẠT: đòi --unit khớp đơn giá (review #674 L5); phát hành phiên bản (chỉ tới bằng ghim) + ghim; giá thuê bao không đổi.
  const p3 = await planPrepaidAi(P, now);
  assert.equal(p3.step, "ACTIVATE", JSON.stringify([p3.blockers, p3.activationBlockers]));
  const noUnit = await applyPrepaidAiStep(P, operator, now);
  assert.ok("error" in noUnit && /--unit=<đ>/.test(noUnit.error), JSON.stringify(noUnit));
  const badUnit = await applyPrepaidAiStep(P, operator, now, { unitVnd: 591 });
  assert.ok("error" in badUnit && /khác đơn giá/.test(badUnit.error), JSON.stringify(badUnit));
  assert.equal((await pdb.select().from(schema.platformPriceVersions).where(eq(schema.platformPriceVersions.key, PREPAID_AI_VERSION_KEY))).length, 0, "thiếu / sai --unit ⇒ chưa phát hành, chưa ghim gì");
  const r3 = await applyPrepaidAiStep(P, operator, now, { unitVnd: 590 });
  assert.ok("ok" in r3 && r3.step === "ACTIVATE" && r3.changed, JSON.stringify(r3));
  const [ver] = await pdb.select().from(schema.platformPriceVersions).where(eq(schema.platformPriceVersions.key, PREPAID_AI_VERSION_KEY));
  assert.deepEqual([ver?.kind, ver?.effectiveFrom, ver?.label], ["LEGACY_SNAPSHOT", null, "Trả trước theo khách AI (V1)"], "phiên bản chỉ tới bằng ghim, không bao giờ thành bảng giá niêm yết");
  assert.equal(currentCatalogVersion(await loadPriceBook({ fresh: true }), now)?.key, currentCatalogVersion(await loadPriceBook(), now)?.key);
  const audits = await pdb.select().from(schema.platformAuditLog).where(or(eq(schema.platformAuditLog.subject, `price-version:${PREPAID_AI_VERSION_KEY}`), eq(schema.platformAuditLog.subject, `price-pin:${P}`)));
  assert.deepEqual(audits.map((a) => `${a.action}:${a.source}`).sort(), ["PRICE_VERSION_PIN:SCRIPT", "PRICE_VERSION_PUBLISH:SCRIPT"], "phát hành + ghim đều có nhật ký nguồn SCRIPT");
  const terms = await balanceOverageTerms(P);
  assert.deepEqual(terms, { included: 0, unitPriceVnd: 590, priceVersionKey: PREPAID_AI_VERSION_KEY }, "MỌI khách AI trừ số dư theo 590đ");
  assert.equal((await plansForOrg(P)).find((p) => p.key === "standard")?.priceVnd, oPriceBefore, "giá thuê bao giữ như giá cũ");
  const again = await applyPrepaidAiStep(P, operator, now, { unitVnd: 590 });
  assert.ok("ok" in again && again.step === "ACTIVE" && !again.changed, "chạy lại ⇒ không ghi gì thêm");
  // L1: bot chưa sang `platform` ⇒ ĐANG CHẠY nói rõ đang thu 590đ khi còn khoá riêng.
  await withOrganization(P, async () => (await getDb()).insert(schema.settings).values({ key: SALES_CHATBOT_SETTING_KEY, value: JSON.stringify({ connectorKey: "gemini-byok" }) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ connectorKey: "gemini-byok" }) } }));
  const pByok = await planPrepaidAi(P, now);
  assert.ok(pByok.step === "ACTIVE" && pByok.engine?.connectorKey === "gemini-byok" && pByok.warnings.some((w) => /CHƯA chuyển động cơ — đang thu 590đ/.test(w) && /org-ai-cutover pai-pre --apply --credit=/.test(w)), JSON.stringify(pByok.warnings));

  // ── Mỗi khách AI MỚI trừ đúng 590đ, một lần; khách đã tính nhắn tiếp không trừ thêm.
  const c1 = await conv("5100000000401");
  assert.deepEqual(await gateOf(c1), { ok: true });
  await note(c1.id);
  await note(c1.id);
  const c2 = await conv("5100000000402");
  await note(c2.id);
  const u2 = await usage();
  assert.equal(u2.length, 2, "hai khách mới ⇒ hai dòng trừ");
  assert.ok(u2.every((u) => u.amountVnd === -590 && u.unitPriceVnd === 590 && u.units === 1 && u.priceVersionKey === PREPAID_AI_VERSION_KEY && u.sourceType === "AI_CUSTOMER" && u.fundsClass === "CASH"), JSON.stringify(u2));
  assert.equal((await readAiBalance(P)).totalVnd, 100_000 - 2 * 590);
  // Khách c0 đã ghi ở bước MỞ NẠP (trước khi ghim) ⇒ là khách của kỳ, không bị trừ ngược.
  assert.deepEqual(await gateOf(c0), { ok: true });

  // ── Hết số dư ⇒ khách MỚI không nhận AI; khách đã tính vẫn được trả lời; âm tối đa một đơn giá.
  await postAiLedgerEntry(pdb, { orgCode: P, entryType: "ADJUSTMENT", fundsClass: "CASH", amountVnd: -(100_000 - 2 * 590 - 100), idempotencyKey: "pai-drain-1", sourceType: "OPERATOR", note: "bài kiểm: rút gần hết số dư" });
  const c3 = await conv("5100000000403");
  assert.deepEqual(await gateOf(c3), { ok: true }, "còn 100đ (> 0) ⇒ cho");
  await note(c3.id);
  assert.equal((await readAiBalance(P)).totalVnd, 100 - 590, "âm tối đa một đơn giá");
  const c4 = await conv("5100000000404");
  const blocked = await gateOf(c4);
  assert.ok(!blocked.ok && blocked.reason === "BALANCE_EXHAUSTED", JSON.stringify(blocked));
  assert.deepEqual(await gateOf(c1), { ok: true }, "khách đã tính trong kỳ vẫn được AI trả lời");
  assert.equal((await usage()).length, 3);

  // ── AI dùng chung (nguồn PLATFORM): credit = ngưỡng CẢNH BÁO (vượt vẫn chạy — cổng khách mới là số dư), trần cứng chống lạm
  //    dụng = credit × 3 (review #674 M2).
  const env = (o: Record<string, string>) => (name: string) => o[name];
  const ready = env({ PLATFORM_AI_ENABLED: "1", PLATFORM_AI_API_KEY: "plat-key-pai", PLATFORM_AI_PROVIDER: "gemini" });
  assert.ok(!(await platformChatAi(P, { env: ready, policy: null })).ok, "chưa đặt credit ⇒ AI dùng chung chưa mở (đúng như kế hoạch nói)");
  for (const code of ORGS) assert.ok("ok" in (await setOrgAiLimitAsOperator({ orgCode: code, key: SCRIPT_AI_LIMIT_KEY, value: 5, operator, reason: "Bài kiểm: ngân sách theo dõi AI dùng chung" })));
  const lim = (await resolveAiLimits(P))?.limits;
  assert.ok(lim?.softOnly === true && lim.platformCreditUsdPerMonth === 5 && lim.costUsdPerMonth.soft === 5 && lim.costUsdPerMonth.hard === 15, JSON.stringify(lim));
  const plat = await platformChatAi(P, { env: ready, policy: null });
  assert.ok(plat.ok && plat.provider.name === "gemini-platform", JSON.stringify(plat.ok ? plat.provider.name : plat.reason));
  assert.equal(salesBotBillingSource("platform", { home: false }), "PLATFORM", "bot chọn khoá `platform` ⇒ sổ AI ghi nguồn PLATFORM");
  const spend = (code: string, usd: number) => recordAiUsage({ orgCode: code, feature: "sales_chatbot", source: "PLATFORM", provider: "gemini-platform", model: "gemini-test", requests: 1, inputTokens: 1_000, outputTokens: 100, costUsd: usd, status: "OK", actorId: null });
  for (const code of ORGS) await spend(code, 10);
  const q10 = await withOrganization(P, () => checkAiQuota(P, "PLATFORM"));
  assert.ok(q10.ok && q10.softExceeded, "trả trước: đã tiêu 10 USD > credit 5 vẫn chạy, kèm cảnh báo");
  const soft = await withOrganization(P, async () => (await getDb()).select().from(schema.notifications).where(like(schema.notifications.dedupeKey, "ai-quota-soft:PLATFORM:%")));
  assert.ok(soft.length === 1 && !/USD/.test(`${soft[0].title} ${soft[0].body}`), "khách nhận MỘT câu cảnh báo, không số USD");
  await spend(P, 10);
  const q20 = await checkAiQuota(P, "PLATFORM", { notify: false });
  assert.ok(!q20.ok && q20.reason === "COST_HARD", "chạm trần chống lạm dụng 15 USD (credit × 3) ⇒ chặn");
  const oQuota = await checkAiQuota(O, "PLATFORM", { notify: false });
  assert.ok(!oQuota.ok && oQuota.reason === "PLATFORM_CREDIT_USED", "tổ chức khác (giá cũ): credit vẫn là trần cứng");

  // ── Tắt cờ (tắt khẩn) ⇒ không trừ, không chặn — VÀ credit thành trần cứng lại: không có AI nền tảng không giới hạn mà không thu.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: P, enabled: false, reason: "Bài kiểm tắt khẩn" })));
  invalidatePricing();
  const off = (await resolveAiLimits(P))?.limits;
  assert.ok(!off?.softOnly, JSON.stringify(off));
  assert.equal((await checkAiQuota(P, "PLATFORM", { notify: false })).ok, false, "cờ tắt ⇒ credit là trần cứng");
  assert.deepEqual(await chargeAiCustomerUsage({ orgCode: P, eventKey: "pai-x", at: now, periodCount: 9 }), { charged: false, reason: "DISABLED" });
  const pOff = await planPrepaidAi(P, now);
  assert.ok(pOff.step === "BLOCKED" && pOff.blockers.some((b) => /cờ Số dư AI đang TẮT/.test(b)), "trạng thái lệch ⇒ ops không tự bật lại");
  assert.ok("error" in (await applyPrepaidAiStep(P, operator, now)));

  // ── Tổ chức khác: giữ nguyên giá, trần AI, không trừ số dư.
  assert.equal(await balanceOverageTerms(O), null);
  assert.equal((await plansForOrg(O)).find((p) => p.key === "standard")?.priceVnd, oPriceBefore);
  const oAfter = (await resolveAiLimits(O))?.limits;
  assert.deepEqual({ ...oAfter, platformCreditUsdPerMonth: oLimitsBefore?.platformCreditUsdPerMonth }, oLimitsBefore, "trần AI của tổ chức khác không đổi (ngoài ô credit bài kiểm tự đặt)");
  assert.equal((await planPrepaidAi(O, now)).step, "OPEN_TOPUP", "tổ chức khác vẫn ở điểm xuất phát");

  // ── M1: hoá đơn gia hạn giá CŨ, CÙNG gói, được trả SAU khi kích hoạt ⇒ KHÔNG ghim lùi (nhật ký ghi rõ); đổi sang gói V1 thì ghim theo hoá đơn.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: P, enabled: true, reason: "Bài kiểm bật lại" })));
  const pinOf = async () => (await pdb.select({ key: schema.platformPricePins.versionKey }).from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, P)))[0]?.key;
  const late = await invoiceOf(P, "standard", LEGACY_VERSION_KEY, 500_000);
  assert.ok("ok" in (await markInvoicePaidManually(op, { invoiceId: late.id, amountVnd: 500_000, reason: "Bài kiểm: hoá đơn cũ trả sau kích hoạt" })));
  invalidatePricing();
  assert.equal(await pinOf(), PREPAID_AI_VERSION_KEY, "hoá đơn giá cũ trả muộn KHÔNG ghim lùi");
  assert.deepEqual(await balanceOverageTerms(P), { included: 0, unitPriceVnd: 590, priceVersionKey: PREPAID_AI_VERSION_KEY }, "vẫn trừ mọi khách AI");
  const [paidAudit] = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.subject, `invoice:${late.transferCode}`));
  assert.ok(paidAudit && (paidAudit.after as { keptPrepaidPin?: boolean }).keptPrepaidPin === true, JSON.stringify(paidAudit?.after));
  const book2 = await loadPriceBook({ fresh: true });
  const v1 = currentCatalogVersion(book2, now)!.key;
  const upgrade = await invoiceOf(P, "growth", v1, 1_490_000);
  assert.ok("ok" in (await markInvoicePaidManually(op, { invoiceId: upgrade.id, amountVnd: 1_490_000, reason: "Bài kiểm: khách mua gói V1" })));
  assert.equal(await pinOf(), v1, "đổi sang gói V1 ⇒ ghim theo hoá đơn như thường (luật hẹp)");
}

export async function testOrgPrepaidAi() {
  testSource();
  const pdb = await getPlatformDb();
  const savedReceiver = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) }))?.value;
  const savedLive = (await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY) }))?.value;
  await cleanup();
  await testPure();
  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "PrepaidAi@12345" }, source: "TEST", actor: null });
  // Đồng hồ khách AI ĐO TRỌN kỳ (bật từ trước đầu tháng) — như tests/ai-balance-usage.test.ts.
  const live = { at: new Date(usagePeriodOf(new Date()).from.getTime() - 86_400_000).toISOString() };
  await pdb.insert(schema.platformSettings).values({ key: AI_CUSTOMER_METER_LIVE_KEY, value: live }).onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: live } });
  try {
    await run();
  } finally {
    await cleanup();
    if (savedLive === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
    else await pdb.update(schema.platformSettings).set({ value: savedLive }).where(eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY));
    if (savedReceiver === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
    else await pdb.insert(schema.platformSettings).values({ key: BILLING_RECEIVER_KEY, value: savedReceiver }).onConflictDoUpdate({ target: schema.platformSettings.key, set: { value: savedReceiver } });
  }
  console.log(
    "✓ AI dùng chung trả trước theo khách AI: dòng giá trả trước không trùng V1 / legacy · đơn giá dẫn xuất 590đ (giá vượt Starter) · chưa khai tài khoản nhận ⇒ chặn, không ghi · MỞ NẠP không trừ / chặn · số dư 0 ⇒ không ghim · nạp QR cộng đúng một lần · KÍCH HOẠT: phiên bản chỉ-ghim + nhật ký SCRIPT, giá thuê bao giữ nguyên · mỗi khách AI mới trừ 590đ một lần · hết số dư ⇒ khách mới không nhận AI, khách đã tính vẫn được trả lời · AI dùng chung nguồn PLATFORM: credit = ngưỡng cảnh báo (khách nhận câu không USD), trần chống lạm dụng = credit × 3, chưa credit ⇒ trần gói · tắt cờ ⇒ credit trần cứng lại · hoá đơn mở chặn kích hoạt, hoá đơn giá cũ trả muộn không ghim lùi · --unit khớp đơn giá · mức kích hoạt max(100.000đ, 1 ngày) · cảnh báo bot còn khoá riêng / AI chung không thu · tổ chức khác giữ nguyên · chạy thử không ghi",
  );
}
