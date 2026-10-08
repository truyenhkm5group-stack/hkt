/**
 * ═══════════ SỬA BÙ THUÊ BAO CỦA CỬA HÀNG TỰ ĐĂNG KÝ (F-02) — CHỈ MÁY CHỦ ═══════════
 *
 * `scripts/saas-subscription-repair.ts` gọi tệp này. Đối tượng: workspace KHÔNG phải nhà, CÓ thương hiệu (`brand` khác NULL —
 * dấu của luồng tự đăng ký 0215), đang thiếu thuê bao: không có thuê bao sống nào, hoặc có sản phẩm đang dùng theo module mà
 * chưa có thuê bao. Đó đúng là các cửa hàng dựng qua `/start` trước bản vá F-02.
 *
 *  · MẶC ĐỊNH CHẠY THỬ — CHỈ ĐỌC: liệt kê từng workspace, sản phẩm sẽ mở (theo module, CÙNG luật với `/start` và với nút «Mở
 *    thuê bao còn thiếu»), tình trạng hiệu lực SẼ hiện (đọc từ thu phí đã có — `effectiveSubscriptionStatus`), mốc dùng thử đã
 *    chụp lúc đăng ký, và hệ quả. Không ghi một dòng nào.
 *  · `apply: true` (kèm lý do) — đi qua ĐÚNG hàm của `/start` (`openSignupSubscriptions`): chỉ thêm, idempotent, nhật ký
 *    `PRODUCT_SUBSCRIBE` mang lý do. KHÔNG khởi tạo / bật thu phí, KHÔNG đổi hay khởi động lại dùng thử, KHÔNG ghi lùi ngày bắt
 *    đầu thuê bao (mục 8.8 — không âm thầm dựng lại lịch sử): `started_at` = lúc chạy sửa bù, và báo cáo nói rõ điều đó.
 *  · Workspace không ACTIVE (dựng hỏng · đình chỉ · lưu trữ), chưa gắn tài khoản, hoặc không dùng sản phẩm nào theo module ⇒
 *    BỎ QUA kèm lý do — mỗi trường hợp có lối ra riêng của người vận hành, script không đoán thay.
 *
 * Chỉ in mã workspace / mã tài khoản / khoá sản phẩm / ngày — không tên khách, không email (log ops là công khai).
 */
import { inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { billingNotice, billingStanding, vnDate, type BillingStandingKind } from "@/lib/billing/rules";
import { readSubscriptionTerms, readTrialTerms } from "@/lib/billing/standing";
import { readEverPaidOrgs } from "@/lib/platform/saas-ledger";
import { productsInUse, readCommercialRegistry } from "@/lib/saas/accounts";
import { brandProductKey, openSignupSubscriptions, type SignupSubscriptionOutcome } from "@/lib/saas/signup-subscriptions";
import { effectiveSubscriptionStatus, SUBSCRIPTION_STATUS_LABEL, type BillingMode, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

/** Lý do sửa bù tối thiểu (cùng ngưỡng với lý do của thao tác người vận hành khác). */
export const REPAIR_REASON_MIN = 5;

/** Hệ quả của `--apply` — script in NGUYÊN VĂN, bài kiểm khoá các vế quan trọng. */
export const REPAIR_CONSEQUENCES: readonly string[] = [
  "Mỗi sản phẩm ở cột «mở» thành MỘT dòng thuê bao ACTIVE theo gói workspace (như luồng người vận hành), nhật ký PRODUCT_SUBSCRIBE mang lý do; started_at = lúc chạy sửa bù, KHÔNG ghi lùi về ngày đăng ký.",
  "Tình trạng hiệu lực ĐỌC từ thu phí đã có của workspace: script KHÔNG khởi tạo / bật thu phí, KHÔNG đổi hay khởi động lại dùng thử, KHÔNG tạo khoá. Khoá chỉ xem (nếu có) vốn đã áp theo thu phí từ trước, không do thuê bao sản phẩm.",
  "Khách sẽ thấy thẻ «Sản phẩm của tôi» thay câu «đang thiết lập gói» — kể cả nhãn «Hết hạn — chỉ xem» nếu dùng thử đã qua và thu phí đang bật.",
  "Workspace vào số thuê bao / khách theo sản phẩm (/platform/products) và vào bảng kê nháp với dòng gói theo gói workspace (dùng thử = 0 ₫).",
  "Chạy lại không đẻ dòng thứ hai (chỉ mục duy nhất thuê bao sống).",
];

export type RepairBilling = {
  /** `NONE` = chưa có dòng thu phí; `OFF` = có dòng nhưng chưa bật thu phí; `ON` = đang thu phí. */
  terms: "NONE" | "OFF" | "ON";
  standing: BillingStandingKind;
  paidThrough: string | null;
  lockOn: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialDays: number | null;
  /** Câu tình trạng — đúng câu của dải nhắc trên đầu ERP (`billingNotice`), không câu thứ hai. */
  note: string;
};

export type RepairCandidate = {
  orgCode: string;
  orgStatus: string;
  brand: string;
  /** Sản phẩm thương hiệu bán — chỉ để ĐỐI CHIẾU, không quyết định mở gì. */
  brandProduct: string | null;
  createdAt: string;
  /** Cửa vào của lượt dựng (`settings.onboarding.source`) — `null` = workspace không dựng qua `/start`. */
  onboardingSource: string | null;
  accountCode: string | null;
  inUse: string[];
  live: string[];
  toOpen: string[];
  billing: RepairBilling;
  /** Tình trạng thuê bao SẼ hiện sau khi mở (`null` khi không mở gì). */
  statusAfterOpen: EffectiveSubscriptionStatus | null;
  statusAfterOpenLabel: string | null;
  action: "OPEN" | "SKIP";
  notes: string[];
};

export type RepairReport = {
  apply: boolean;
  at: string;
  candidates: RepairCandidate[];
  /** Kết quả từng workspace khi `apply` (cùng kiểu với bước của `/start`). */
  results: { orgCode: string; outcome: SignupSubscriptionOutcome; liveAfter: string[] }[];
  error: string | null;
};

function billingOf(terms: { billingEnabled: boolean; paidThrough: string | null; graceDays: number } | null, trial: { trialStartedAt: Date | null; trialEndsAt: Date | null; trialDays: number | null }, now: Date): RepairBilling {
  const standing = billingStanding(terms, vnDate(now));
  const onTrial = trial.trialDays !== null || trial.trialEndsAt !== null;
  const kind = !terms ? "NONE" : terms.billingEnabled ? "ON" : "OFF";
  const note =
    kind === "NONE"
      ? "Chưa có dòng thu phí (workspace tạo trước dùng thử 0234, hoặc bước thu phí hỏng lúc đăng ký) — script KHÔNG khởi tạo: bật dùng thử bây giờ là bắt đầu đếm ngày và dẫn tới khoá chỉ xem khi hết hạn; đó là quyết định của chủ shop (/platform/org/<mã>)."
      : kind === "OFF"
        ? `Thu phí chưa bật — không nhắc, không khoá${trial.trialEndsAt ? ` (mốc dùng thử đã chụp lúc đăng ký: tới ${trial.trialEndsAt.toISOString()} — chỉ cổng AI đọc)` : ""}.`
        : (billingNotice(standing, onTrial)?.text ?? `Thu phí đang bật — trả tới ${standing.paidThrough ?? "—"}.`);
  return {
    terms: kind,
    standing: standing.kind,
    paidThrough: standing.paidThrough,
    lockOn: standing.lockOn,
    trialStartedAt: trial.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: trial.trialEndsAt?.toISOString() ?? null,
    trialDays: trial.trialDays,
    note,
  };
}

/**
 * Lập (và khi `apply`, thực hiện) lượt sửa bù. `orgCode` thu hẹp về một workspace (vẫn phải thoả điều kiện đối tượng). Không
 * ném vì dữ liệu của một workspace: mỗi workspace một kết quả.
 */
export async function planSubscriptionRepair(opts: { apply?: boolean; reason?: string | null; orgCode?: string | null; now?: Date } = {}): Promise<RepairReport> {
  const now = opts.now ?? new Date();
  const apply = opts.apply === true;
  const reason = opts.reason?.trim() ?? "";
  const report: RepairReport = { apply, at: now.toISOString(), candidates: [], results: [], error: null };
  if (apply && reason.length < REPAIR_REASON_MIN) {
    report.error = `Sửa bù GHI dữ liệu thuê bao — cần --reason="…" (ít nhất ${REPAIR_REASON_MIN} ký tự, vd «chủ shop duyệt sửa bù F-02 ngày …»). Chưa ghi gì.`;
    return report;
  }

  const registry = await readCommercialRegistry();
  const accounts = new Map(registry.accounts.map((a) => [a.id, a]));
  const targets = registry.workspaces.filter((w) => !w.isHome && w.brand && (!opts.orgCode || w.code === opts.orgCode));
  const pdb = await getPlatformDb();
  const settingsRows = targets.length
    ? await pdb.select({ code: schema.platformOrganizations.code, settings: schema.platformOrganizations.settings }).from(schema.platformOrganizations).where(inArray(schema.platformOrganizations.code, targets.map((w) => w.code)))
    : [];
  const sourceOf = new Map(settingsRows.map((r) => [r.code, ((r.settings as { onboarding?: { source?: unknown } } | null)?.onboarding?.source as string | undefined) ?? null]));
  const paid = await readEverPaidOrgs();

  for (const w of targets) {
    const live = registry.subscriptions.filter((s) => s.orgCode === w.code && !s.endedAt).map((s) => s.productKey);
    const inUse = await productsInUse(w.code);
    const toOpen = inUse.filter((p) => !live.includes(p));
    if (live.length > 0 && toOpen.length === 0) continue; // đủ thuê bao — không phải đối tượng
    const account = w.accountId ? (accounts.get(w.accountId) ?? null) : null;
    const [terms, trial] = await Promise.all([readSubscriptionTerms(w.code, { fresh: true }), readTrialTerms(w.code, { fresh: true })]);
    const billing = billingOf(terms, trial, now);
    const brandProduct = brandProductKey(w.brand);
    const notes: string[] = [];
    let action: RepairCandidate["action"] = "OPEN";
    if (w.status !== "ACTIVE") {
      action = "SKIP";
      notes.push(`Workspace đang ${w.status} — không mở. Dựng hỏng thì «Chạy lại» ở /platform (lượt dựng nay tự mở thuê bao); đình chỉ / lưu trữ thì mở lại workspace trước.`);
    }
    if (!account) {
      action = "SKIP";
      notes.push("Chưa gắn tài khoản khách — gắn ở /platform/customers trước; script không tự tạo tài khoản.");
    }
    if (toOpen.length === 0) {
      action = "SKIP";
      notes.push("Không dùng sản phẩm nào theo module (chỉ lõi thương mại) — không có gì để mở; người vận hành quyết sản phẩm.");
    }
    if (brandProduct && !inUse.includes(brandProduct)) notes.push(`Thương hiệu «${w.brand}» bán «${brandProduct}» nhưng module không dùng sản phẩm đó — mở theo module (cùng luật vỏ app), không theo thương hiệu.`);
    const statusAfterOpen =
      action === "OPEN" && account ? effectiveSubscriptionStatus({ state: "ACTIVE", billingMode: account.billingMode as BillingMode, standing: billing.standing, hasPaidInvoice: paid.has(w.code) }) : null;
    report.candidates.push({
      orgCode: w.code,
      orgStatus: w.status,
      brand: w.brand!,
      brandProduct,
      createdAt: w.createdAt.toISOString(),
      onboardingSource: sourceOf.get(w.code) ?? null,
      accountCode: account?.code ?? null,
      inUse,
      live,
      toOpen,
      billing,
      statusAfterOpen,
      statusAfterOpenLabel: statusAfterOpen ? SUBSCRIPTION_STATUS_LABEL[statusAfterOpen] : null,
      action,
      notes,
    });
  }

  if (!apply) return report;
  for (const c of report.candidates) {
    if (c.action !== "OPEN") continue;
    const outcome = await openSignupSubscriptions(c.orgCode, { actor: null, reason: `Sửa bù F-02 (scripts/saas-subscription-repair.ts): ${reason}`, auditSource: "SCRIPT" });
    const after = await pdb
      .select({ productKey: schema.platformProductSubscriptions.productKey, orgCode: schema.platformProductSubscriptions.orgCode, endedAt: schema.platformProductSubscriptions.endedAt })
      .from(schema.platformProductSubscriptions)
      .where(inArray(schema.platformProductSubscriptions.orgCode, [c.orgCode]));
    report.results.push({ orgCode: c.orgCode, outcome, liveAfter: after.filter((s) => !s.endedAt).map((s) => s.productKey).sort() });
  }
  return report;
}
