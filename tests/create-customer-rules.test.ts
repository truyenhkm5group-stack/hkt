/**
 * ═══════════ LUẬT THƯƠNG MẠI CỦA WORKSPACE — «TẠO KHÁCH MỚI» VÀ MỌI CỬA KHÁC (kiểm khởi chạy 08/10/2026 · review #682) ═══════════
 *
 * Khách trả tiền đầu tiên của Chốt Đơn được người vận hành tạo ở `/platform/customers`. Bốn mặc định sai đã đo (thương hiệu NULL ⇒
 * menu ERP; gói cũ / `internal` không bị chặn ⇒ giá cũ, không dùng thử, bot im; nút đứng đầu khung mờ không lời; không cài mẫu
 * «Chỉ cần AI bán hàng»), rồi review #682 đo thêm các cửa KHÁC lách cùng luật (`/start` của người vận hành, mã mời, đổi gói / thương
 * hiệu sau lúc tạo, thuê thêm sản phẩm) và bước mẫu hỏng mà không có đường sửa.
 *
 *  1. THUẦN — thương hiệu theo bộ sản phẩm (lựa chọn ngược luật ⇒ từ chối; gợi ý của host ⇒ bộ sản phẩm thắng); gói đọc từ SỔ GIÁ
 *     (phiên bản tương lai / đã bị thay không tính, gói mới tự có mặt); giá cũ chỉ cho nội bộ KHÔNG chỉ-Chốt-Đơn, `internal` không
 *     cho ai; nhãn dùng thử nói «7 ngày hoặc 100 khách AI»; mẫu chỉ cho bộ chỉ-Chốt-Đơn ở gói có AI bán hàng; câu «vì sao» + lúc hiện.
 *  2. MÃ NGUỒN — một hàm máy chủ cho mọi cửa; MỌI lời gọi `provisionOrganization` ngoài tests/ khai `commercial`; bước mẫu đi ĐÚNG bộ
 *     cài của `/start`; không danh sách gói gõ tay; ô lý do + nút SAU các ô nhập.
 *  3. FORM — HTML thật: ô nhập trước, nút sau; câu «vì sao» KHÔNG hiện khi chưa ai chạm (khung khoá thì hiện); gói niêm yết, chọn sẵn
 *     dùng thử; thương hiệu Chốt Đơn khoá; khung pilot in thứ còn thiếu TRƯỚC cách ghi đè.
 *  4. CHỐT ĐƠN qua job — thương hiệu tự đặt, vỏ app bật, mẫu cài (lý do «Job cấp phát <khoá>»), gọi lại bộ cài ⇒ SKIPPED không nhân
 *     đôi; gói Inbox ⇒ không cài mẫu AI bán hàng.
 *  5. TỪ CHỐI ở máy chủ — tạo khách (giá cũ · internal · mã tài khoản mượn loại · VNX cho Chốt Đơn · nội bộ chỉ-Chốt-Đơn + giá cũ),
 *     thuê thêm sản phẩm, đổi gói, đổi thương hiệu, mã mời, cửa ghi `provisionOrganization` — không ghi gì.
 *  6. BƯỚC MẪU HỎNG đi ĐÚNG đường thật — cửa người vận hành báo «CHƯA cài được mẫu», job mang `lastError`, không xanh, cờ «Cấp phát
 *     hỏng»; «Cài lại mẫu» chạy RIÊNG bước mẫu rồi mọi dấu hiệu tắt; job xong hẳn thì không chạy lại.
 *  7. JOB CŨ (xếp trước luật) — chạy lại bị từ chối kèm chỗ sửa, không dựng lại cái sai.
 *  8. `/start` NGƯỜI VẬN HÀNH — gói cũ / internal bị từ chối trước khi dựng; mẫu chỉ AI ⇒ thương hiệu Chốt Đơn dù không truyền.
 *  9. NỘI BỘ / NHÀ — nội bộ + ERP vẫn tạo được bằng gói giá cũ, không mẫu, thương hiệu không bị đặt hộ; nhà không đổi.
 * 10. DẤU VÂN (review #684 · L-c / L-a) — mọi trường của yêu cầu vào dấu vân (đổi gói · thương hiệu · tên workspace · loại tài khoản ·
 *     mẫu ⇒ khác; hoa thường · khoảng trắng · thứ tự · trống ⇔ null ⇒ giống), quên trường là lỗi biên dịch; câu «khoá đã dùng» nói
 *     job cũ ở đâu và lối ra theo trạng thái.
 * 11. «THUÊ SẢN PHẨM» BẰNG CÙNG MỘT FORM (review #684 · M1) — khoá cũ cho sản phẩm khác ⇒ từ chối rõ, KHÔNG báo «đã thuê»; bấm đúp
 *     đúng lượt ⇒ cùng job, câu nói đúng sản phẩm; khoá mới sau lượt thành công ⇒ sản phẩm sau được thuê thật.
 *
 * Mốc thời gian: sổ giá giả dựng quanh MỘT `new Date()`; vòng thật đọc đồng hồ như mã nguồn (luật 50 · 65).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { AI_SALES_BLUEPRINT } from "@/lib/blueprints/templates/ai-sales";
import { AI_PROFILE_SETTING_KEY } from "@/lib/blueprints/types";
import { confirmBlockedReason, confirmReady, confirmWhyVisible, reasonNeed } from "@/lib/constants/confirm-reason";
import { salesAgentShell } from "@/lib/constants/saas-nav";
import { createInvite, invitePlanRefusal } from "@/lib/onboarding/invites";
import { quickModules } from "@/lib/onboarding/quick";
import { createOrganizationFromSignup, type SignupActor } from "@/lib/onboarding/service";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { ORG_BRAND_LABEL, ORG_BRANDS, setOrganizationBrand } from "@/lib/platform/org-brand";
import { setOrganizationPlan } from "@/lib/platform/org-plan";
import { organizationBaseUrl, organizationLinkOrigin } from "@/lib/platform/org-links";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { invalidatePriceBook, loadPriceBook } from "@/lib/pricing/price-book";
import { LEGACY_VERSION_KEY, parsePlanPrice, parsePriceVersion, type PlanPriceRow, type PriceBook } from "@/lib/pricing/versions";
import { getSettingJson } from "@/lib/settings";
import { accountOfWorkspace, liveSubscriptions } from "@/lib/saas/accounts";
import { modulesToProvision, productDef } from "@/lib/saas/catalog";
import { createCustomerAsOperator, loadCustomersConsole, resendActivationAsOperator, retryProvisioningAsOperator, subscribeProductAsOperator } from "@/lib/saas/console";
import {
  catalogPlanKeys,
  createCustomerMissing,
  createCustomerPlanOptions,
  decidedBrand,
  defaultCreatePlanKey,
  lockedBrandFor,
  planAllowed,
  planOptionLabel,
  planRefusal,
  plansForAccountType,
  planTier,
  provisioningTemplateFor,
  resolveCreateBrand,
  SALES_AGENT_TEMPLATE,
  suggestedBrandFor,
  templateSummary,
} from "@/lib/saas/create-customer-rules";
import { readPlans } from "@/lib/saas/customers";
import { legacyPlanOnCreateAllowed } from "@/lib/saas/policy";
import {
  CREATE_CUSTOMER_KEY_REUSED,
  createCustomerFingerprint,
  jobView,
  keyReusedMessage,
  requestProvisioning,
  retryJob,
  SUBSCRIBE_KEY_REUSED,
  subscribeFingerprint,
  TEMPLATE_PENDING_PREFIX,
  validateRequest,
  WORKSPACE_FINGERPRINT_FIELDS,
  type CreateCustomerRequest,
  type FingerprintFields,
  type JobRow,
  type JobStep,
} from "@/lib/saas/provisioning";
import { installProvisioningTemplate, PROVISIONING_TEMPLATE_AUDIT_SUBJECT, setProvisioningTemplateFaultForTests } from "@/lib/saas/provisioning-template";
import { ConfirmWithReason, PilotStageControls } from "@/components/platform/pilot-ops";
import { CreateCustomerForm } from "@/components/saas/operator-actions";

const CHOT = "ccr-chot-ngoai";
const LOI = "ccr-chot-loi";
const NOIBO = "ccr-noi-bo";
const HOPTHU = "ccr-hop-thu";
const START = "ccr-start-ai";
const TUCHOI = "ccr-tu-choi";
const CU = "ccr-job-cu";
const CUA = "ccr-cua-ghi";
const THUE = "ccr-thue-sp";
const ORGS = [CHOT, LOI, NOIBO, HOPTHU, START, TUCHOI, CU, CUA, THUE] as const;
const ACCT_CHOT = "ccr-acct-ngoai";
const ACCT_LOI = "ccr-acct-loi";
const ACCT_NOIBO = "ccr-acct-noi-bo";
const ACCT_HOPTHU = "ccr-acct-hop-thu";

const read = (f: string) => readFileSync(f, "utf8");
/** Mã nguồn bỏ chú thích — một đoạn GIẢI THÍCH nhắc tên hàm không phải là lời gọi. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function priceRow(versionKey: string, planKey: string, position: number, over: Partial<PlanPriceRow> = {}) {
  return parsePlanPrice({ versionKey, planKey, name: planKey.toUpperCase(), description: null, position, listed: true, highlight: false, contactSales: false, monthlyVnd: null, yearlyVnd: null, yearlyFreeMonths: 0, priceFromVnd: null, trialDays: null, included: {}, overage: {}, features: null, addonPrices: {}, limits: {}, commercial: {}, ...over });
}

function versionRow(key: string, kind: "LEGACY_SNAPSHOT" | "CATALOG", effectiveFrom: Date | null) {
  return parsePriceVersion({ key, label: key, kind, effectiveFrom, taxMode: "UNDECLARED", taxNote: null, alertThresholds: null, note: null });
}

/** Sổ giá giả: phiên bản cũ đã bị thay · phiên bản đang hiệu lực (có / không có dòng `trial`) · phiên bản tương lai · legacy. */
function syntheticBook(now: Date, withTrial: boolean): PriceBook {
  const day = 86_400_000;
  return {
    versions: [versionRow(LEGACY_VERSION_KEY, "LEGACY_SNAPSHOT", null), versionRow("cat-cu", "CATALOG", new Date(now.getTime() - 30 * day)), versionRow("cat-nay", "CATALOG", new Date(now.getTime() - 2 * day)), versionRow("cat-sau", "CATALOG", new Date(now.getTime() + 30 * day))],
    prices: [
      priceRow(LEGACY_VERSION_KEY, "trial", 10, { trialDays: 7 }),
      priceRow(LEGACY_VERSION_KEY, "standard", 50, { monthlyVnd: 990_000 }),
      priceRow(LEGACY_VERSION_KEY, "internal", 99),
      priceRow("cat-cu", "goi-cu", 5, { monthlyVnd: 100_000 }),
      ...(withTrial ? [priceRow("cat-nay", "trial", 10, { trialDays: 7, included: { aiCustomers: 100 }, features: ["ai_sales"] })] : []),
      priceRow("cat-nay", "enterprise", 40, { contactSales: true, priceFromVnd: 5_990_000, features: ["ai_sales"] }),
      priceRow("cat-nay", "starter", 20, { monthlyVnd: 790_000, features: ["ai_sales", "multi_page_inbox"] }),
      priceRow("cat-nay", "inbox", 11, { monthlyVnd: 299_000, features: ["multi_page_inbox"] }),
      priceRow("cat-nay", "goi-moi", 30, { monthlyVnd: 1_000_000, features: ["ai_sales"] }),
      priceRow("cat-sau", "starter", 20, { monthlyVnd: 990_000 }),
      priceRow("cat-sau", "mega", 50, { monthlyVnd: 9_000_000 }),
    ],
  };
}

function testPure() {
  // ── Thương hiệu do BỘ SẢN PHẨM quyết.
  assert.equal(lockedBrandFor(["chotdon"]), "chotdon", "chỉ Chốt Đơn ⇒ khoá thương hiệu Chốt Đơn");
  for (const set of [["erp"], ["erp", "chotdon"], [], ["la"], ["chotdon", "la"]]) assert.equal(lockedBrandFor(set), null, `${JSON.stringify(set)} ⇒ không khoá`);
  assert.deepEqual(resolveCreateBrand(["chotdon"], null), { brand: "chotdon" }, "lựa chọn bỏ trống ⇒ MÁY CHỦ tự đặt");
  assert.deepEqual(resolveCreateBrand(["chotdon"], "chotdon"), { brand: "chotdon" });
  const vnxForChot = resolveCreateBrand(["chotdon"], "vnx");
  assert.ok("error" in vnxForChot && vnxForChot.error.includes("Chốt Đơn Tự Động") && vnxForChot.error.includes("menu ERP"), `CHỌN VNX cho khách chỉ Chốt Đơn ⇒ từ chối, câu nói hệ quả: ${JSON.stringify(vnxForChot)}`);
  assert.deepEqual(resolveCreateBrand(["erp"], null), { brand: null }, "có ERP ⇒ đúng lựa chọn (bỏ trống = không theo dõi, như trước)");
  assert.deepEqual(resolveCreateBrand(["erp", "chotdon"], "vnx"), { brand: "vnx" });
  assert.equal(decidedBrand(["chotdon"], "vnx"), "chotdon", "GỢI Ý của host thua bộ sản phẩm (/start trên host VNX, mẫu chỉ AI)");
  assert.equal(decidedBrand(["erp", "chotdon"], "chotdon"), "chotdon", "không khoá ⇒ giữ gợi ý");
  assert.equal(decidedBrand(["erp"], null), null);
  assert.equal(suggestedBrandFor(["erp", "chotdon"]), "vnx", "gợi ý cho bộ có ERP = thương hiệu của ERP");
  const chotModules = modulesToProvision(productDef("chotdon")!);
  assert.equal(salesAgentShell({ isHome: false, brand: decidedBrand(["chotdon"], null) }, chotModules), true, "thương hiệu máy chủ đặt ⇒ vỏ app 8 mục");
  assert.equal(salesAgentShell({ isHome: false, brand: null }, chotModules), false, "đúng lỗi đã đo: NULL ⇒ menu ERP nội bộ");

  // ── Gói đọc từ SỔ GIÁ.
  const now = new Date();
  const book = syntheticBook(now, false);
  const keys = catalogPlanKeys(book, now);
  assert.deepEqual(keys, ["trial", "inbox", "starter", "goi-moi", "enterprise"], "phiên bản CATALOG đang hiệu lực theo thứ tự + `trial`");
  assert.ok(!keys.includes("mega") && !keys.includes("goi-cu") && !keys.includes("standard"), "phiên bản tương lai / đã bị thay / legacy không tính");
  assert.deepEqual(catalogPlanKeys({ versions: book.versions.filter((v) => v.kind !== "CATALOG"), prices: book.prices }, now), ["trial"], "chưa có bảng giá niêm yết ⇒ chỉ dùng thử (phía hẹp)");
  assert.equal(planTier("internal", [...keys, "internal"]), "HOME_ONLY", "`internal` không bao giờ thành gói bán, kể cả khi lỡ vào sổ");
  assert.equal(planTier("standard", keys), "LEGACY");
  assert.equal(planTier("goi-moi", keys), "CATALOG", "gói mới thêm vào bảng giá tự có mặt — không danh sách gõ tay");
  assert.equal(planTier("trial", ["starter"]), "CATALOG", "`trial` luôn tạo được");

  // ── Ai được gói nào. L2: workspace chỉ-Chốt-Đơn ⇒ chỉ gói niêm yết với MỌI loại tài khoản.
  assert.equal(legacyPlanOnCreateAllowed("INTERNAL"), true);
  for (const t of ["EXTERNAL", null, undefined, "", "internal", "LA"]) assert.equal(legacyPlanOnCreateAllowed(t), false, `${String(t)} ⇒ không (phía hẹp)`);
  assert.equal(planAllowed("LEGACY", "INTERNAL", ["erp"]), true, "nội bộ + ERP giữ luật đang có");
  assert.equal(planAllowed("LEGACY", "INTERNAL", ["chotdon"]), false, "nội bộ CHỈ Chốt Đơn ⇒ không gói cũ (credit AI 0 ⇒ bot im)");
  assert.equal(planAllowed("LEGACY", "EXTERNAL", ["erp"]), false);
  assert.equal(planAllowed("HOME_ONLY", "INTERNAL", ["erp"]), false);
  assert.equal(planAllowed("CATALOG", null, ["chotdon"]), true);
  const listed = ["Dùng thử", "Starter"];
  const legacyExt = planRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: "EXTERNAL", products: ["erp"], listed });
  assert.ok(legacyExt && legacyExt.includes("«Tiêu chuẩn»") && legacyExt.includes("không có dùng thử") && legacyExt.includes("Dùng thử · Starter"), `giá cũ cho khách ngoài ⇒ câu kinh doanh + gói chọn lại: ${legacyExt}`);
  assert.ok(planRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: "INTERNAL", products: ["chotdon"], listed })?.includes("kể cả tài khoản nội bộ"), "L2 nói đúng lý do");
  assert.equal(planRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: "INTERNAL", products: ["erp"], listed }), null);
  assert.ok(planRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: null, listed }), "không tra được loại ⇒ như khách ngoài");
  for (const t of ["INTERNAL", "EXTERNAL"]) assert.ok(planRefusal({ planName: "Nội bộ", tier: "HOME_ONLY", accountType: t, listed })?.includes("workspace nhà"), `${t}: \`internal\` không cấp cho khách`);

  // ── Ô «Gói» của form: dựng từ sổ, lọc bằng ĐÚNG phép của máy chủ.
  const plans = [
    { key: "internal", name: "Nội bộ", priceVnd: null },
    { key: "standard", name: "Tiêu chuẩn", priceVnd: 990_000 },
    { key: "trial", name: "Dùng thử", priceVnd: null },
    { key: "starter", name: "Starter", priceVnd: 790_000 },
    { key: "inbox", name: "Inbox", priceVnd: 299_000 },
    { key: "enterprise", name: "Enterprise", priceVnd: null },
  ];
  const options = createCustomerPlanOptions(plans, syntheticBook(now, true), now);
  assert.deepEqual(options.map((o) => `${o.key}:${o.tier}`), ["trial:CATALOG", "inbox:CATALOG", "starter:CATALOG", "enterprise:CATALOG", "standard:LEGACY", "internal:HOME_ONLY"], "niêm yết trước (thứ tự phiên bản), giá cũ sau");
  const ext = plansForAccountType(options, "EXTERNAL").map((o) => o.key);
  assert.deepEqual(ext, ["trial", "inbox", "starter", "enterprise"], "khách ngoài: chỉ gói niêm yết");
  assert.deepEqual(plansForAccountType(options, "INTERNAL", ["erp"]).map((o) => o.key), [...ext, "standard"], "nội bộ + ERP: thêm giá cũ, KHÔNG `internal`");
  assert.deepEqual(plansForAccountType(options, "INTERNAL", ["chotdon"]).map((o) => o.key), ext, "nội bộ chỉ Chốt Đơn: như khách ngoài");
  assert.equal(defaultCreatePlanKey(plansForAccountType(options, "EXTERNAL")), "trial", "chọn sẵn dùng thử");
  assert.equal(defaultCreatePlanKey([]), null);
  const label = (k: string) => planOptionLabel(options.find((o) => o.key === k)!);
  assert.equal(label("trial"), "Dùng thử — 7 ngày hoặc 100 khách AI (cái nào tới trước), miễn phí", "dùng thử dừng ở mốc nào tới trước — nói cả hai");
  assert.match(label("starter"), /^Starter — 790\.000\s₫\/tháng$/);
  assert.match(label("inbox"), /không có AI bán hàng/, "Inbox nói rõ không có AI bán hàng");
  assert.match(label("enterprise"), /hợp đồng, từ 5\.990\.000\s₫\/tháng/);
  assert.match(label("standard"), /giá cũ/);

  // ── Mẫu: chỉ bộ chỉ-Chốt-Đơn ở gói CÓ AI bán hàng, và là ĐÚNG mẫu của loại hình «Chỉ cần AI bán hàng» ở /start.
  const tpl = provisioningTemplateFor(["chotdon"], { planAiSales: true });
  assert.ok(tpl && SALES_AGENT_TEMPLATE && tpl.templateKey === BUSINESS_TYPE_SPEC.ai_sales.templateKey && tpl.businessType === "ai_sales");
  assert.equal(templateBlueprint(tpl.templateKey)?.key, AI_SALES_BLUEPRINT.key, "khoá mẫu trỏ tới một mẫu có thật trong sổ");
  assert.ok(provisioningTemplateFor(["chotdon"], { planAiSales: null }), "gói chưa khai tính năng ⇒ vẫn cài (Chốt Đơn chính là AI bán hàng)");
  assert.equal(provisioningTemplateFor(["chotdon"], { planAiSales: false }), null, "gói Inbox (không AI bán hàng) ⇒ không cài mẫu AI bán hàng");
  for (const set of [["erp"], ["erp", "chotdon"], []]) assert.equal(provisioningTemplateFor(set, { planAiSales: true }), null, `${JSON.stringify(set)} ⇒ không cài mẫu (khách ERP tự chọn)`);
  const summary = templateSummary(AI_SALES_BLUEPRINT);
  for (const k of ["Nhân viên bán hàng", "Đơn chốt ⇒ báo nhóm", "NHÁP", "hồ sơ cửa hàng cho AI"]) assert.ok(summary.includes(k), `câu kể mẫu phải nói «${k}»: ${summary}`);

  // ── Ô còn thiếu + câu «vì sao» + LÚC NÀO câu ấy hiện (L3).
  const empty = createCustomerMissing({ workspaceCode: "", workspaceName: "", products: [], planKey: null, offeredPlanKeys: ext, adminEmail: "" });
  assert.deepEqual(empty, ["nhập mã workspace (chữ thường, số, gạch ngang)", "nhập tên workspace", "chọn ít nhất một sản phẩm", "chọn gói", "nhập email quản trị"]);
  const full = { workspaceCode: "Shop-Moi", workspaceName: "Shop Mới", products: ["chotdon"], planKey: "trial", offeredPlanKeys: ext, adminEmail: "chu@shop.vn" };
  assert.deepEqual(createCustomerMissing(full), [], "đủ ô ⇒ không thiếu gì (mã viết hoa được hạ chữ như máy chủ)");
  assert.deepEqual(createCustomerMissing({ ...full, planKey: "standard" }), ["chọn gói"], "gói không có trong danh sách của loại tài khoản ⇒ thiếu gói");
  assert.equal(confirmBlockedReason({ label: "Tạo khách…", minReason: 5, reason: "" }), `Chưa bấm được «Tạo khách» — cần ${reasonNeed(5)}.`);
  assert.equal(confirmBlockedReason({ label: "Tạo khách…", lead: "Chưa thể tạo khách", minReason: 5, reason: "ab", missing: ["chọn gói", "nhập email quản trị"] }), "Chưa thể tạo khách — cần chọn gói · nhập email quản trị · nhập lý do (ít nhất 5 ký tự).");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "đủ năm ký tự" }), null, "bấm được ⇒ không câu nào");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "", pending: true }), null, "đang chạy ⇒ không câu nào");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "", disabled: true }), null, "khung khoá mà không khai lý do ⇒ im lặng, không đoán");
  assert.equal(confirmReady({ minReason: 5, reason: "đủ năm ký tự", missing: ["chọn gói"] }), false, "còn ô thiếu ⇒ chưa bấm được dù đủ lý do");
  assert.equal(confirmReady({ minReason: 0, reason: "" }), true, "lý do không bắt buộc");
  assert.equal(confirmWhyVisible({ why: "x", touched: false }), false, "chưa ai chạm khung ⇒ không nhắc thường trực");
  assert.equal(confirmWhyVisible({ why: "x", touched: true }), true);
  assert.equal(confirmWhyVisible({ why: "x", touched: false, disabled: true }), true, "khung khoá có lý do ⇒ hiện luôn (giọng nhạt)");
  assert.equal(confirmWhyVisible({ why: null, touched: true }), false);
}

// ─────────────────────────── 10 · DẤU VÂN + CÂU «KHOÁ ĐÃ DÙNG» (thuần) ───────────────────────────

function testFingerprint() {
  const base: CreateCustomerRequest = { kind: "CREATE_CUSTOMER", accountId: null, account: { code: "kh-a", name: "Khách A", accountType: "EXTERNAL" }, workspace: { code: "ws-a", name: "WS A", planKey: "starter", brand: "chotdon" }, products: ["chotdon"], admin: { email: "chu@ws-a.vn", name: "Chủ" } };
  const fp = createCustomerFingerprint;
  const same: CreateCustomerRequest = { ...base, accountId: "", account: { code: " KH-A ", name: "Khách A ", accountType: "EXTERNAL", billingMode: null, taxCode: "" }, workspace: { ...base.workspace, code: "WS-A", name: " WS A" }, admin: { email: " CHU@ws-a.vn", name: "Chủ" } };
  assert.equal(fp(same), fp(base), "hoa thường · khoảng trắng · trống ⇔ null không là khác");
  // MẪU job cài suy từ sản phẩm + gói — đổi mẫu là đổi một trong hai (dòng dưới chứng minh sản phẩm đổi mẫu thật).
  assert.notDeepEqual(provisioningTemplateFor(["chotdon"], { planAiSales: true }), provisioningTemplateFor(["chotdon", "erp"], { planAiSales: true }));
  const changes: [string, CreateCustomerRequest][] = [
    ["đổi gói", { ...base, workspace: { ...base.workspace, planKey: "growth" } }],
    ["đổi thương hiệu", { ...base, workspace: { ...base.workspace, brand: "vnx" } }],
    ["đổi tên workspace", { ...base, workspace: { ...base.workspace, name: "WS B" } }],
    ["đổi loại tài khoản", { ...base, account: { ...base.account!, accountType: "INTERNAL" } }],
    ["đổi mẫu (sản phẩm: chỉ Chốt Đơn ⇒ «Chỉ cần AI bán hàng», thêm ERP ⇒ không mẫu)", { ...base, products: ["chotdon", "erp"] }],
    ["đổi mẫu (gói: Inbox không có AI bán hàng ⇒ không mẫu)", { ...base, workspace: { ...base.workspace, planKey: "inbox" } }],
    ["đổi cách lập chứng từ", { ...base, account: { ...base.account!, billingMode: "EXTERNAL_INVOICE" } }],
    ["đổi mã số thuế", { ...base, account: { ...base.account!, taxCode: "0101234567" } }],
    ["đổi email thu tiền", { ...base, account: { ...base.account!, billingEmail: "ketoan@ws-a.vn" } }],
    ["gắn tài khoản có sẵn", { ...base, accountId: "acct-1" }],
    ["đổi email quản trị", { ...base, admin: { ...base.admin, email: "khac@ws-a.vn" } }],
  ];
  for (const [what, other] of changes) assert.notEqual(fp(other), fp(base), `${what} ⇒ dấu vân KHÁC`);
  // Thêm một trường vào yêu cầu mà quên khai ở bảng dấu vân ⇒ LỖI BIÊN DỊCH. `npm run typecheck` kiểm dòng dưới: nếu bảng thôi bắt buộc
  // đủ trường thì chỉ thị này thành thừa và chính nó đỏ.
  // @ts-expect-error -- thiếu `template`: workspace có thêm trường mà bảng dấu vân chưa khai
  const forgot: FingerprintFields<CreateCustomerRequest["workspace"] & { template: string }> = WORKSPACE_FINGERPRINT_FIELDS;
  void forgot;

  // «Thuê sản phẩm»: workspace · sản phẩm · gói riêng.
  const sub = { kind: "SUBSCRIBE_PRODUCT" as const, orgCode: "ws-a", productKey: "erp", planKey: null };
  assert.equal(subscribeFingerprint({ ...sub, orgCode: " WS-A ", planKey: "" }), subscribeFingerprint(sub));
  for (const other of [{ ...sub, productKey: "chotdon" }, { ...sub, planKey: "growth" }, { ...sub, orgCode: "ws-b" }]) assert.notEqual(subscribeFingerprint(other), subscribeFingerprint(sub), JSON.stringify(other));

  // Câu «khoá đã dùng»: job cũ (mã + trạng thái) và lối ra theo trạng thái — không chỉ «tải lại form» (review #684 · L-a).
  const step = (key: string, status: JobStep["status"]): JobStep => ({ key, status, at: "", detail: null });
  const job = { id: "12345678-90ab-cdef", kind: "CREATE_CUSTOMER", status: "FAILED", orgCode: "ws-a", steps: [step("ACCOUNT", "DONE"), step("WORKSPACE", "DONE"), step("ADMIN", "FAILED")], input: base as unknown as Record<string, unknown> };
  const failed = keyReusedMessage(job, "kh-a");
  assert.ok(failed.startsWith(CREATE_CUSTOMER_KEY_REUSED) && failed.includes("job 12345678 · Hỏng — chạy lại được") && failed.includes("/platform/customers/kh-a") && failed.includes("«Chạy lại»") && failed.includes("«Gửi lại liên kết kích hoạt»"), failed);
  const done = keyReusedMessage({ ...job, status: "SUCCEEDED" }, "kh-a");
  assert.ok(done.includes("job 12345678 · Xong") && !done.includes("«Chạy lại»") && done.includes("«Gửi lại liên kết kích hoạt»"), `job xong ⇒ không bảo chạy lại: ${done}`);
  const early = keyReusedMessage({ ...job, steps: [step("ACCOUNT", "FAILED")] }, null);
  assert.ok(early.includes("chưa tạo workspace") && early.includes("tải lại form") && !early.includes("Gửi lại liên kết"), early);
  const subMsg = keyReusedMessage({ ...job, kind: "SUBSCRIBE_PRODUCT", status: "SUCCEEDED", input: sub as unknown as Record<string, unknown> }, null);
  assert.ok(subMsg.startsWith(SUBSCRIBE_KEY_REUSED) && subMsg.includes("«erp»") && subMsg.includes("job 12345678 · Xong"), subMsg);
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir).sort()) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

/** Các lời gọi `provisionOrganization(...)` trong một mã nguồn đã bỏ chú thích — đối số tới ngoặc đóng khớp. */
function provisionCalls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/provisionOrganization\(/g)) {
    const at = m.index ?? 0;
    if (/function\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue;
    let depth = 0;
    let end = at + "provisionOrganization".length;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    out.push(src.slice(at, end + 1));
  }
  return out;
}

/** Chỗ được gọi KHÔNG khai `commercial` — mỗi chỗ một lý do: không phải cửa tạo tổ chức của sản phẩm. */
const PROVISION_WITHOUT_COMMERCIAL: Record<string, string> = {
  "scripts/platform-load-probe.ts": "Script ĐO TẢI chạy tay: cấp rồi GỠ tổ chức thử của chính nó (gói mặc định = dùng thử) — không phải khách.",
  "scripts/restore-drill-org-config.ts": "Script DIỄN TẬP KHÔI PHỤC trên PGlite riêng: tổ chức của lượt diễn tập — không phải khách.",
  "scripts/restore-drill-pg.ts": "Script DIỄN TẬP KHÔI PHỤC trên Postgres tạm: tổ chức của lượt diễn tập — không phải khách.",
};

function testSource() {
  const job = code("lib/saas/provisioning.ts");
  const validate = job.slice(job.indexOf("export async function validateRequest"), job.indexOf("async function cancelGuard"));
  for (const call of ["decideNewWorkspace(", "existingWorkspacePlanRefusal("]) assert.ok(validate.includes(call), `validateRequest (MÁY CHỦ) phải hỏi ${call}`);
  assert.ok(/const req = decidedRequest\(input/.test(job), "job ghi đầu vào ĐÃ QUYẾT (thương hiệu) — lượt chạy lại không suy lại");
  assert.ok(job.includes("commercial: { products: req.products }"), "job khai sản phẩm dự định cho cửa ghi chung");
  for (const f of ["lib/platform/org-plan.ts", "lib/onboarding/invites.ts"]) assert.ok(/\b(existingWorkspacePlanRefusal|workspacePlanRefusal)\(/.test(code(f)), `${f} phải đi qua luật gói chung`);
  assert.ok(/resolveCreateBrand\(/.test(code("lib/platform/org-brand.ts")), "đổi thương hiệu đi qua luật thương hiệu chung");
  for (const f of ["lib/onboarding/service.ts", "lib/platform/provision.ts"]) assert.ok(/decideNewWorkspace\(/.test(code(f)), `${f}: /start và cửa ghi chung hỏi CÙNG một hàm`);

  // MỌI lời gọi `provisionOrganization` ngoài tests/ khai `commercial` (hoặc có lý do) — cửa mới quên khai là ĐỎ ngay ở đây.
  const missing: string[] = [];
  const used = new Set<string>();
  for (const f of ["lib", "app", "components", "scripts"].flatMap((d) => walk(d))) {
    if (f === "lib/platform/provision.ts") continue;
    for (const call of provisionCalls(code(f))) {
      if (call.includes("commercial:")) continue;
      if (PROVISION_WITHOUT_COMMERCIAL[f]) used.add(f);
      else missing.push(`${f}: ${call.slice(0, 90)}`);
    }
  }
  assert.deepEqual(missing, [], "cửa tạo tổ chức ngoài tests/ phải khai `commercial` — không thì lách được luật gói / thương hiệu");
  assert.deepEqual([...used].sort(), Object.keys(PROVISION_WITHOUT_COMMERCIAL).sort(), "miễn trừ không còn khớp lời gọi nào — xoá khỏi danh sách");

  const tpl = code("lib/saas/provisioning-template.ts");
  for (const call of ["buildSignupBlueprint(", "installBlueprint(built.bp, subject, {", "adminSessionUser(", "withOrganization(", "installedVersion("]) assert.ok(tpl.includes(call), `bước mẫu dùng ĐÚNG bộ cài của /start: thiếu ${call}`);
  assert.ok(!/applyBlueprint\(|saveRule\(|createCustomField\(|saveAccessRoleCore\(/.test(tpl), "không đường ghi thứ hai cạnh bộ cài");
  assert.ok(read("lib/onboarding/service.ts").includes("installBlueprint(input.built.bp, subject)"), "/start vẫn cài bằng đúng lời gọi ấy");

  const rules = code("lib/saas/create-customer-rules.ts");
  assert.ok(!/["'`](starter|growth|scale|inbox|enterprise|basic|pro|standard)["'`]/.test(rules), "luật không gõ tay danh sách gói — đọc từ sổ giá");
  assert.ok(!/(accountType|billingMode)\s*[!=]==?/.test(rules), "loại tài khoản chỉ được hỏi qua lib/saas/policy.ts");

  const form = code("components/saas/operator-actions.tsx");
  const create = form.slice(form.indexOf("export function CreateCustomerForm"));
  assert.ok(!create.includes("(mặc định)"), "không còn ô thương hiệu «(mặc định)» = NULL");
  for (const fn of ["plansForAccountType(", "lockedBrandFor(", "createCustomerMissing(", "provisioningTemplateFor("]) assert.ok(create.includes(fn), `form đọc luật chung: thiếu ${fn}`);
  assert.ok(/if \(r\.status !== "SUCCEEDED"\) return \{ error: r\.message \}/.test(create), "job hỏng không thành toast «đã tạo»");
  // «Thuê sản phẩm» (review #684 · M1): khoá MỚI sau mỗi lượt thành công, lựa chọn suy từ danh sách hiện tại, job chưa xong không là «đã thuê».
  const subscribe = form.slice(form.indexOf("export function SubscribeProductForm"), form.indexOf("export function", form.indexOf("export function SubscribeProductForm") + 1));
  assert.ok(/useMemo\(\(\) => key\(`sub-\$\{orgCode\}-\$\{round\}`\), \[orgCode, round\]\)/.test(subscribe) && /setRound\(\(n\) => n \+ 1\)/.test(subscribe), "form «Thuê sản phẩm» sinh khoá MỚI sau lượt thành công");
  assert.ok(subscribe.includes("products.some((p) => p.key === picked) ? picked") && /if \(r\.status !== "SUCCEEDED"\) return \{ error: r\.message \}/.test(subscribe), "lựa chọn theo danh sách hiện tại; job chưa xong không báo thành công");

  const pilot = code("components/platform/pilot-ops.tsx");
  const confirm = pilot.slice(pilot.indexOf("export function ConfirmWithReason"), pilot.indexOf("const toOutcome"));
  const fields = confirm.indexOf("{withFields ? props.children : null}");
  assert.ok(fields > 0 && fields < confirm.indexOf("<Input id={props.id}") && fields < confirm.indexOf("<Button"), "ô nhập TRƯỚC ô lý do + nút");
  assert.ok(confirm.includes("confirmBlockedReason(") && confirm.includes("confirmWhyVisible(") && confirm.includes("aria-describedby"), "câu «vì sao» gắn vào nút, hiện theo luật L3");
  assert.ok(/lg:items-end/.test(read("components/billing/operator-billing.tsx")), "hai hàng nút của hoá đơn canh đáy (L4)");
}

// ─────────────────────────── 3 · FORM (HTML thật) ───────────────────────────

function html(el: React.ReactElement): string {
  // `tsx` biên dịch JSX theo runtime CỔ ĐIỂN ngoài Next ⇒ cần `React` toàn cục (như saas-signup-subscription.test.ts).
  (globalThis as { React?: typeof React }).React ??= React;
  return renderToStaticMarkup(el);
}

const noop = async () => ({ ok: true as const });

async function testForm() {
  const plans = createCustomerPlanOptions(await readPlans(), await loadPriceBook(), new Date());
  const salesTemplate = SALES_AGENT_TEMPLATE ? { label: SALES_AGENT_TEMPLATE.label, summary: templateSummary(templateBlueprint(SALES_AGENT_TEMPLATE.templateKey)!) } : null;
  const page = html(
    createElement(CreateCustomerForm, {
      plans,
      products: [
        { key: "erp", name: "VNX ERP" },
        { key: "chotdon", name: "Chốt Đơn Tự Động" },
      ],
      accounts: [],
      brands: ORG_BRANDS.map((k) => ({ key: k, label: ORG_BRAND_LABEL[k] })),
      salesTemplate,
    }),
  );
  const at = (s: string) => {
    const i = page.indexOf(s);
    assert.ok(i >= 0, `HTML thiếu «${s}»`);
    return i;
  };
  assert.ok(at("Tài khoản khách") < at("Lý do (ít nhất") && at("Email quản trị") < at("Lý do (ít nhất"), "ô nhập TRƯỚC ô lý do");
  assert.ok(!page.includes("Chưa thể tạo khách"), "chưa ai chạm khung ⇒ câu «vì sao» chưa hiện (L3)");
  assert.ok(!page.includes('value="internal"'), "không có gói `internal`");
  for (const o of plans.filter((p) => p.tier !== "CATALOG")) assert.ok(!page.includes(`value="${o.key}"`), `khách ngoài không thấy gói giá cũ ${o.key}`);
  for (const o of plans.filter((p) => p.tier === "CATALOG")) assert.ok(page.includes(`value="${o.key}"`), `thiếu gói niêm yết ${o.key}`);
  assert.match(page, /<option value="trial" selected="">[^<]* — 7 ngày hoặc 100 khách AI \(cái nào tới trước\), miễn phí<\/option>/, "chọn sẵn dùng thử, nói rõ mốc dừng");
  assert.match(page, /<select id="cc-brand"[^>]*disabled=""/, "chỉ Chốt Đơn ⇒ ô thương hiệu khoá");
  assert.match(page, /<option value="chotdon" selected="">/, "…và đang ở Chốt Đơn");
  assert.ok(page.includes("Chỉ cần AI bán hàng") && page.includes("Nhân viên bán hàng"), "form nói trước mẫu sẽ cài");

  // Khung không có ô nhập: một hàng lý do + nút như cũ, không câu thừa.
  const bare = html(createElement(ConfirmWithReason, { id: "ccr-bare", label: "Tạm dừng", title: "t", consequence: "c", minReason: 5, placeholder: "p", run: noop }));
  assert.ok(bare.includes("Lý do (ít nhất 5") && !bare.includes("Chưa bấm được"), "không ô nhập ⇒ không thêm câu");
  // Khung bị khoá có khai lý do ⇒ nói đúng lý do đó ngay (giọng nhạt), sau ô nhập.
  const locked = html(createElement(ConfirmWithReason, { id: "ccr-lock", label: "Đổi gói…", blockedLead: "Chưa đổi được gói", disabled: true, disabledReason: "chọn một gói khác gói đang dùng", title: "t", consequence: "c", minReason: 5, placeholder: "p", run: noop }, createElement("span", null, "Ô-GÓI-MỚI")));
  assert.ok(locked.indexOf("Ô-GÓI-MỚI") < locked.indexOf("Lý do (ít nhất") && locked.includes("Chưa đổi được gói — chọn một gói khác gói đang dùng."), "khung khoá có lý do ⇒ hiện luôn, sau ô nhập");

  // L5: khung chuyển giai đoạn pilot in THỨ CÒN THIẾU trước khi nói cách ghi đè.
  const pilot = html(createElement(PilotStageControls, { orgCode: "ccr-pilot", stage: "CREATED", next: "CONFIGURING", missingNext: ["Chưa có người dùng thứ hai"] }));
  const why = pilot.slice(pilot.indexOf("Chưa chuyển được sang"));
  assert.ok(why.includes("còn thiếu: Chưa có người dùng thứ hai") && why.indexOf("còn thiếu") < why.indexOf("tick «Ghi đè»"), `thiếu gì trước, cách vượt sau: ${why.slice(0, 200)}`);
}

// ─────────────────────────── 4–9 · VÒNG THẬT ───────────────────────────

async function cleanup() {
  setProvisioningTemplateFaultForTests(null);
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "ccr-%"));
  await pdb.delete(schema.platformProductSubscriptions).where(inArray(schema.platformProductSubscriptions.orgCode, [...ORGS]));
  for (const c of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, c) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrgPricing).where(eq(schema.platformOrgPricing.orgCode, c));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code: c, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSignupAttempts).where(inArray(schema.platformSignupAttempts.organizationCode, [...ORGS]));
  await pdb.delete(schema.platformSignupInvites).where(like(schema.platformSignupInvites.note, "ccr %"));
  await pdb.delete(schema.platformAuditLog).where(or(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]), like(schema.platformAuditLog.subject, "account:ccr-%")));
  await pdb.delete(schema.platformAccounts).where(like(schema.platformAccounts.code, "ccr-%"));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePriceBook();
}

function createReq(over: { code: string; planKey: string; products?: string[]; brand?: "vnx" | "chotdon" | null; account?: CreateCustomerRequest["account"]; accountId?: string }): CreateCustomerRequest {
  return {
    kind: "CREATE_CUSTOMER",
    accountId: over.accountId ?? null,
    account: over.accountId ? undefined : (over.account ?? { code: ACCT_CHOT, name: "Khách Chốt Đơn ngoài", accountType: "EXTERNAL" }),
    workspace: { code: over.code, name: `Shop ${over.code}`, planKey: over.planKey, brand: over.brand },
    products: over.products ?? ["chotdon"],
    admin: { email: `chu@${over.code}.local`, name: "Chủ shop" },
  };
}

const ctx = (idempotencyKey: string) => ({ actor: null, email: "op@ccr.local", source: "TEST" as const, idempotencyKey });
const stepsOf = (j: JobRow) => j.steps as JobStep[];
const lastStep = (j: JobRow, key: string) => [...stepsOf(j)].reverse().find((s) => s.key === key);

async function jobByKey(key: string): Promise<JobRow | undefined> {
  const pdb = await getPlatformDb();
  return pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, key) });
}

/** Dòng mẫu sinh ra trong CSDL workspace (+ lý do của lượt cài) — gọi lại bộ cài không được nhân đôi dòng nào. */
async function templateRows(orgCode: string) {
  return withOrganization(orgCode, async () => {
    const db = await getDb();
    const roles = await db.select({ code: schema.accessRoles.code }).from(schema.accessRoles).where(eq(schema.accessRoles.code, "BAN_HANG"));
    const fields = await db.select({ key: schema.metaCustomFields.fieldKey }).from(schema.metaCustomFields).where(inArray(schema.metaCustomFields.fieldKey, (AI_SALES_BLUEPRINT.fields ?? []).map((f) => f.key)));
    const rules = await db.select({ status: schema.workflowRules.status }).from(schema.workflowRules).where(inArray(schema.workflowRules.key, (AI_SALES_BLUEPRINT.workflows ?? []).map((w) => w.key)));
    const installs = await db.select({ status: schema.blueprintInstalls.status }).from(schema.blueprintInstalls).where(eq(schema.blueprintInstalls.blueprintKey, AI_SALES_BLUEPRINT.key));
    const started = await db.select({ reason: schema.auditLogs.reason }).from(schema.auditLogs).where(eq(schema.auditLogs.action, "BLUEPRINT_INSTALL_START"));
    const profile = await getSettingJson<{ businessProfile?: string } | null>(AI_PROFILE_SETTING_KEY, null);
    return { roles: roles.length, fields: fields.length, rules: rules.map((r) => r.status), installs: installs.map((i) => i.status), reasons: started.map((s) => s.reason ?? ""), profile: profile?.businessProfile ?? null };
  });
}

async function testChotDon(): Promise<JobRow> {
  // Khách NGOÀI, chỉ Chốt Đơn, gói dùng thử, KHÔNG khai thương hiệu (đúng cú bấm cũ để «(mặc định)»).
  const r = await requestProvisioning(createReq({ code: CHOT, planKey: "trial", brand: null }), ctx("ccr-chot-1"));
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.job.status, "SUCCEEDED", JSON.stringify(r.job.steps));
  assert.deepEqual(stepsOf(r.job).map((s) => s.key), ["ACCOUNT", "WORKSPACE", "ADMIN", "SUBSCRIPTIONS", "BILLING", "TEMPLATE"]);
  assert.equal(lastStep(r.job, "TEMPLATE")?.status, "DONE", JSON.stringify(lastStep(r.job, "TEMPLATE")));
  assert.equal(r.job.lastError, null);
  assert.deepEqual(jobView(r.job), { label: "Xong", tone: "good", retry: null });
  assert.equal((r.job.input as CreateCustomerRequest).workspace.brand, "chotdon", "job ghi thương hiệu ĐÃ QUYẾT");
  invalidateOrganizations();
  const org = await findOrganization(CHOT);
  assert.equal(org?.brand, "chotdon", "máy chủ tự đặt thương hiệu Chốt Đơn");
  invalidateCapabilities(CHOT);
  assert.equal(salesAgentShell(org, [...(await getEnabledModules(CHOT))]), true, "khách thấy vỏ app 8 mục, không menu ERP");

  const rows = await templateRows(CHOT);
  assert.deepEqual([rows.roles, rows.fields, rows.installs], [1, (AI_SALES_BLUEPRINT.fields ?? []).length, ["DONE"]], JSON.stringify(rows));
  assert.ok(rows.rules.length === (AI_SALES_BLUEPRINT.workflows ?? []).length && rows.rules.every((s) => s === "DRAFT"), `luật của mẫu nằm ở NHÁP: ${JSON.stringify(rows.rules)}`);
  assert.equal(rows.profile, AI_SALES_BLUEPRINT.ai?.businessProfile, "hồ sơ cửa hàng cho AI");
  assert.ok(rows.reasons.length === 1 && rows.reasons[0].includes("Job cấp phát ccr-chot-1"), `lượt cài ghi lý do «Job cấp phát <khoá>» (L6): ${JSON.stringify(rows.reasons)}`);
  assert.equal(salesAgentShell(org, [...(await getEnabledModules(CHOT))]), true, "mẫu không bật module ERP nào — vỏ app giữ nguyên");

  // Gửi lại cùng khoá ⇒ cùng job; gọi lại ĐÚNG bộ cài của bước mẫu ⇒ SKIPPED, không nhân đôi gì; job xong không chạy lại.
  const same = await requestProvisioning(createReq({ code: CHOT, planKey: "trial", brand: null }), ctx("ccr-chot-1"));
  assert.ok(!("error" in same) && same.reused && same.job.id === r.job.id);
  const again = await installProvisioningTemplate({ orgCode: CHOT, adminEmail: `chu@${CHOT}.local`, template: provisioningTemplateFor(["chotdon"], { planAiSales: true })!, actor: null, auditSource: "TEST", note: "Job cấp phát ccr-chot-1" });
  assert.equal(again.status, "SKIPPED", JSON.stringify(again));
  assert.deepEqual(await templateRows(CHOT), rows, "cài lại không thêm vai trò / field / luật / lượt cài nào");
  assert.deepEqual(await retryJob(r.job.id, { actor: null, email: "op@ccr.local", source: "TEST" }), { error: "Job đã xong — không chạy lại." });
  return r.job;
}

async function testInboxPlanNoAiTemplate() {
  // INFO review #682: gói Inbox không có AI bán hàng ⇒ không cài mẫu «Chỉ cần AI bán hàng».
  const r = await requestProvisioning(createReq({ code: HOPTHU, planKey: "inbox", account: { code: ACCT_HOPTHU, name: "Khách hộp thư", accountType: "EXTERNAL" } }), ctx("ccr-hop-thu-1"));
  assert.ok(!("error" in r) && r.job.status === "SUCCEEDED", JSON.stringify(r));
  const t = lastStep(r.job, "TEMPLATE");
  assert.ok(t?.status === "SKIPPED" && t.detail?.includes("không có AI bán hàng"), `gói Inbox ⇒ không cài mẫu AI bán hàng: ${JSON.stringify(t)}`);
  assert.equal(r.job.lastError, null, "bỏ qua có chủ đích không phải việc dở");
  assert.deepEqual((await templateRows(HOPTHU)).installs, []);
}

async function testRefusals(op: SessionUser, chotJob: JobRow) {
  const pdb = await getPlatformDb();
  const accountsBefore = (await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts)).length;
  const refused = async (label: string, req: Parameters<typeof requestProvisioning>[0], key: string, expect: RegExp) => {
    const r = await requestProvisioning(req, ctx(key));
    assert.ok("error" in r && expect.test(r.error), `${label}: ${JSON.stringify(r)}`);
    assert.equal(await jobByKey(key), undefined, `${label}: từ chối TRƯỚC khi ghi job`);
  };
  const external = { code: "ccr-acct-tu-choi", name: "Khách bị chặn", accountType: "EXTERNAL" as const };
  await refused("khách ngoài + giá cũ", createReq({ code: TUCHOI, planKey: "standard", account: external }), "ccr-tc-legacy", /chỉ còn giữ giá cho khách cũ/);
  await refused("khách ngoài + gói nhà", createReq({ code: TUCHOI, planKey: "internal", account: external }), "ccr-tc-internal", /workspace nhà/);
  await refused("nội bộ + gói nhà", createReq({ code: TUCHOI, planKey: "internal", products: ["erp"], account: { ...external, accountType: "INTERNAL" } }), "ccr-tc-internal-nb", /workspace nhà/);
  await refused("nội bộ CHỈ Chốt Đơn + giá cũ (L2)", createReq({ code: TUCHOI, planKey: "standard", account: { ...external, accountType: "INTERNAL" } }), "ccr-tc-l2", /kể cả tài khoản nội bộ/);
  await refused("tài khoản có sẵn (ngoài) + giá cũ", createReq({ code: TUCHOI, planKey: "basic", accountId: chotJob.accountId! }), "ccr-tc-existing", /chỉ còn giữ giá cho khách cũ/);
  await refused("mã tài khoản có sẵn khai «nội bộ»", createReq({ code: TUCHOI, planKey: "standard", products: ["erp"], account: { code: ACCT_CHOT, name: "Mượn loại", accountType: "INTERNAL" } }), "ccr-tc-borrow", /chỉ còn giữ giá cho khách cũ/);
  await refused("chỉ Chốt Đơn + CHỌN VNX", createReq({ code: TUCHOI, planKey: "trial", brand: "vnx", account: external }), "ccr-tc-brand", /phải mang thương hiệu/);
  // Thuê thêm sản phẩm với gói riêng — CÙNG luật (L1).
  await refused("thuê thêm + giá cũ", { kind: "SUBSCRIBE_PRODUCT", orgCode: CHOT, productKey: "erp", planKey: "standard" }, "ccr-tc-sub-legacy", /chỉ còn giữ giá cho khách cũ/);
  await refused("thuê thêm + gói nhà", { kind: "SUBSCRIBE_PRODUCT", orgCode: CHOT, productKey: "erp", planKey: "internal" }, "ccr-tc-sub-internal", /workspace nhà/);
  // Cửa người vận hành trả ĐÚNG câu của máy chủ.
  const viaConsole = await createCustomerAsOperator(op, { account: external, workspace: { code: TUCHOI, name: "Shop bị chặn", planKey: "pro" }, products: ["chotdon"], admin: { email: "chu@ccr-tu-choi.local", name: "Chủ" }, idempotencyKey: "ccr-tc-console", reason: "Thử gói cũ cho khách mới" });
  assert.ok("error" in viaConsole && /chỉ còn giữ giá cho khách cũ/.test(viaConsole.error), JSON.stringify(viaConsole));

  // Đổi gói / thương hiệu SAU lúc tạo (L1) — lượt bị từ chối không đổi một byte.
  const legacyPlan = await setOrganizationPlan(op, { orgCode: CHOT, planKey: "standard", reason: "Khách xin lại gói cũ" });
  assert.ok("error" in legacyPlan && legacyPlan.error.includes("giá cũ"), JSON.stringify(legacyPlan));
  const vnx = await setOrganizationBrand(op, { orgCode: CHOT, brand: "vnx", reason: "Đổi về VNXcommerce" });
  assert.ok("error" in vnx && vnx.error.includes("phải mang thương hiệu"), JSON.stringify(vnx));
  invalidateOrganizations();
  const kept = await findOrganization(CHOT);
  assert.deepEqual([kept?.plan, kept?.brand], ["trial", "chotdon"], "lượt bị từ chối không đổi gì");
  const growth = await setOrganizationPlan(op, { orgCode: CHOT, planKey: "growth", reason: "Khách nâng lên gói niêm yết" });
  assert.ok("ok" in growth && growth.changed, `gói niêm yết vẫn đổi được: ${JSON.stringify(growth)}`);

  // Mã mời mang gói (L1): mã mời dẫn tới /start, nơi tạo tài khoản khách NGOÀI.
  assert.equal(await invitePlanRefusal("starter"), null);
  assert.equal(await invitePlanRefusal(null), null, "không gắn gói = dùng thử");
  assert.ok((await invitePlanRefusal("standard"))?.includes("giá cũ"));
  assert.ok((await invitePlanRefusal("internal"))?.includes("workspace nhà"));
  await assert.rejects(() => createInvite({ actor: null, note: "ccr gói cũ", planKey: "standard" }), /giá cũ/);
  assert.equal((await pdb.select({ id: schema.platformSignupInvites.id }).from(schema.platformSignupInvites).where(like(schema.platformSignupInvites.note, "ccr %"))).length, 0, "mã mời gói cũ không được tạo");

  // Cửa ghi chung: lời gọi khai `commercial` mà xin gói cũ ⇒ ném TRƯỚC khi ghi dòng tổ chức.
  await assert.rejects(() => provisionOrganization({ code: CUA, name: "Cửa ghi", plan: "standard", modules: ["customers"], source: "TEST", actor: null, commercial: {} }), /chỉ còn giữ giá cho khách cũ/);
  invalidateOrganizations();
  assert.equal(await findOrganization(CUA), null, "cửa ghi chung từ chối trước khi ghi");
  assert.equal(await findOrganization(TUCHOI), null, "không workspace nào được tạo");
  assert.equal((await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts)).length, accountsBefore, "không tài khoản mồ côi");
}

async function testTemplateFailureRealPath(op: SessionUser) {
  // MEDIUM-1: lỗi THẬT ở bước mẫu, qua ĐÚNG cửa của người vận hành (form «Tạo khách» → createCustomerAsOperator). Không ghi tay trạng thái.
  setProvisioningTemplateFaultForTests(() => {
    throw new Error("lỗi tiêm ở bước mẫu");
  });
  let created: Awaited<ReturnType<typeof createCustomerAsOperator>>;
  try {
    created = await createCustomerAsOperator(op, { account: { code: ACCT_LOI, name: "Khách lỗi mẫu", accountType: "EXTERNAL" }, workspace: { code: LOI, name: "Shop lỗi mẫu", planKey: "trial" }, products: ["chotdon"], admin: { email: `chu@${LOI}.local`, name: "Chủ" }, idempotencyKey: "ccr-loi-console", reason: "Thử lỗi bước mẫu" });
  } finally {
    setProvisioningTemplateFaultForTests(null);
  }
  assert.ok("ok" in created && created.status === "SUCCEEDED", JSON.stringify(created));
  assert.ok(created.message.startsWith("Đã tạo khách — CHƯA cài được mẫu: lỗi tiêm ở bước mẫu") && created.message.includes("Cài lại mẫu"), `cửa người vận hành nói thẳng: ${created.message}`);
  assert.ok(created.activationLink, "cấp phát vẫn xong ⇒ quản trị vẫn có liên kết kích hoạt");
  // Liên kết kích hoạt về ĐÚNG host của thương hiệu workspace (Finish Line Round 2: thương hiệu trống ⇒ liên kết mang APP_URL miền VNX
  // cả với khách Chốt Đơn). Kỳ vọng dựng từ CÙNG nguồn mã dùng (`organizationBaseUrl`, luật 65); thương hiệu ⇒ host kiểm thuần.
  const loiOrg = await findOrganization(LOI);
  assert.equal(loiOrg?.brand, "chotdon");
  const brandOrigin = new URL(await organizationBaseUrl(LOI)).origin;
  assert.equal(new URL(created.activationLink).origin, brandOrigin, "liên kết kích hoạt của «Tạo khách» dùng gốc theo thương hiệu workspace");
  assert.equal(organizationLinkOrigin(loiOrg, { baseDomain: null, appUrl: "https://erp.vi-du.vn", chotdonOrigin: "https://app.chot-don.vi-du.vn" }), "https://app.chot-don.vi-du.vn", "thương hiệu chotdon ⇒ host Chốt Đơn, không phải APP_URL");
  const job = (await jobByKey("ccr-loi-console"))!;
  assert.ok(job.lastError?.startsWith(TEMPLATE_PENDING_PREFIX) && job.lastError.includes("lỗi tiêm"), `job xong mà mang câu việc dở: ${job.lastError}`);
  assert.deepEqual(jobView(job), { label: "Xong — CHƯA cài được mẫu", tone: "bad", retry: "TEMPLATE" }, "trang khách không tô xanh «Xong»");
  const pdb = await getPlatformDb();
  const trace = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, LOI), eq(schema.platformAuditLog.action, "ORG_SETUP"), eq(schema.platformAuditLog.subject, PROVISIONING_TEMPLATE_AUDIT_SUBJECT)));
  assert.equal(trace.length, 1, "một dòng nhật ký nền tảng cho lỗi cài mẫu");
  assert.deepEqual((await templateRows(LOI)).installs, [], "lỗi trước bộ cài ⇒ chưa có lượt cài nào");
  const listed = await loadCustomersConsole(op);
  assert.ok(!("error" in listed), JSON.stringify(listed));
  const customer = listed.customers.find((c) => c.account.code === ACCT_LOI);
  assert.ok(customer?.flags.includes("PROVISIONING_FAILED") && customer.failedJobs === 1, `danh sách khách bật cờ «Cấp phát hỏng»: ${JSON.stringify(customer?.flags)}`);

  // «Cài lại mẫu» — ĐÚNG lõi của nút trên trang khách (retryProvisioningAction → retryProvisioningAsOperator) ⇒ chạy RIÊNG bước mẫu.
  const fixed = await retryProvisioningAsOperator(op, { jobId: job.id });
  assert.ok("ok" in fixed && fixed.status === "SUCCEEDED" && !fixed.templatePending && fixed.message === "Job đã chạy xong.", JSON.stringify(fixed));
  const after = (await jobByKey("ccr-loi-console"))!;
  assert.equal(after.lastError, null, "cài xong ⇒ câu việc dở tắt");
  assert.deepEqual(jobView(after), { label: "Xong", tone: "good", retry: null });
  assert.equal(after.attempts, 2);
  assert.deepEqual(stepsOf(after).map((s) => `${s.key}:${s.status}`).slice(-2), ["TEMPLATE:FAILED", "TEMPLATE:DONE"], "lượt sau chỉ chạy bước mẫu — không đụng tài khoản / workspace / thuê bao / thu phí");
  const rows = await templateRows(LOI);
  assert.ok(rows.installs.length === 1 && rows.installs[0] === "DONE" && rows.reasons[0]?.includes("Job cấp phát ccr-loi-console"), JSON.stringify(rows));
  const again = await retryProvisioningAsOperator(op, { jobId: job.id });
  assert.ok("error" in again && again.error.includes("đã xong"), "xong hẳn ⇒ không chạy lại");
  const listedAfter = await loadCustomersConsole(op);
  assert.ok(!("error" in listedAfter) && !listedAfter.customers.find((c) => c.account.code === ACCT_LOI)?.flags.includes("PROVISIONING_FAILED"), "cờ tắt sau khi cài xong");
  // «Gửi lại liên kết kích hoạt» (quản trị chưa vào) — cùng gốc theo thương hiệu.
  const resent = await resendActivationAsOperator(op, { orgCode: LOI, reason: "Khách chưa nhận được liên kết" });
  assert.ok("ok" in resent && new URL(resent.link).origin === brandOrigin, `gửi lại kích hoạt dùng gốc theo thương hiệu: ${JSON.stringify(resent)}`);
}

async function testStaleJobInput() {
  // L7: job xếp TRƯỚC luật — dữ liệu LỊCH SỬ, đường ghi hiện hành không còn tạo được nên chỉ dựng được bằng cách chèn dòng.
  const pdb = await getPlatformDb();
  const base = { kind: "CREATE_CUSTOMER" as const, account: { code: "ccr-acct-cu", name: "Khách cũ", accountType: "EXTERNAL" }, admin: { email: "chu@ccr-job-cu.local", name: "Chủ" } };
  await pdb.insert(schema.platformProvisioningJobs).values([
    { kind: "CREATE_CUSTOMER", idempotencyKey: "ccr-cu-brand", orgCode: CU, input: { ...base, workspace: { code: CU, name: "Shop cũ", planKey: "trial", brand: null }, products: ["chotdon"] }, status: "FAILED", attempts: 1, lastError: "lỗi cũ" },
    { kind: "CREATE_CUSTOMER", idempotencyKey: "ccr-cu-plan", orgCode: CU, input: { ...base, workspace: { code: CU, name: "Shop cũ", planKey: "standard", brand: "vnx" }, products: ["erp"] }, status: "FAILED", attempts: 1, lastError: "lỗi cũ" },
  ]);
  for (const [key, expect] of [
    ["ccr-cu-brand", /thương hiệu đã lưu trên job là «trống»/],
    ["ccr-cu-plan", /chỉ còn giữ giá cho khách cũ/],
  ] as const) {
    const job = (await jobByKey(key))!;
    const r = await retryJob(job.id, { actor: null, email: "op@ccr.local", source: "TEST" });
    assert.ok("error" in r && /xếp trước luật «Tạo khách» hiện hành/.test(r.error) && expect.test(r.error) && r.error.includes(`/platform/org/${CU}`), `${key}: ${JSON.stringify(r)}`);
    assert.equal((await jobByKey(key))?.attempts, 1, `${key}: không chạy theo đầu vào cũ`);
  }
  invalidateOrganizations();
  assert.equal(await findOrganization(CU), null, "không dựng lại cái sai");
}

async function testStartOperator() {
  // MEDIUM-2: /start của NGƯỜI VẬN HÀNH (tạo hộ) đi CÙNG luật với form «Tạo khách».
  const home = await getHomeOrganization();
  const opActor: SignupActor = { kind: "operator", ip: "10.99.0.7", actor: { orgCode: home.code, userId: "ccr-op", email: "op@ccr.local" } };
  const draft = (planKey: string) => ({ invite: null, org: { name: "Shop AI ccr", code: START }, admin: { name: "Chủ shop", email: `chu@${START}.local`, password: "CcrStart@2026!" }, plan: { businessType: "ai_sales" as const, ...quickModules("ai_sales") }, planKey });
  const legacy = await createOrganizationFromSignup(draft("standard"), opActor);
  assert.ok("error" in legacy && legacy.error.includes("giá cũ") && !legacy.setupFailed, `/start người vận hành + gói cũ ⇒ từ chối trước khi dựng: ${JSON.stringify(legacy)}`);
  const internal = await createOrganizationFromSignup(draft("internal"), opActor);
  assert.ok("error" in internal && internal.error.includes("workspace nhà"), JSON.stringify(internal));
  invalidateOrganizations();
  assert.equal(await findOrganization(START), null, "không tổ chức «Dựng hỏng» nào");
  const ok = await createOrganizationFromSignup(draft("trial"), opActor);
  assert.ok("ok" in ok && ok.created, JSON.stringify(ok));
  invalidateOrganizations();
  const org = await findOrganization(START);
  assert.equal(org?.brand, "chotdon", "tạo hộ (không truyền thương hiệu) + mẫu chỉ AI ⇒ cửa ghi chung đặt Chốt Đơn");
  invalidateCapabilities(START);
  assert.equal(salesAgentShell(org, [...(await getEnabledModules(START))]), true, "khách vào vỏ app 8 mục, không menu ERP");
  assert.equal((await accountOfWorkspace(START))?.accountType, "EXTERNAL");
}

async function testSubscribeSameForm(op: SessionUser) {
  // M1 (review #684): «Thuê sản phẩm» bằng CÙNG một form. Workspace chưa thuê gì — tổ chức thử dựng thẳng (bộ dữ liệu kiểm thử).
  await provisionOrganization({ code: THUE, name: "Shop thuê thêm", modules: [], source: "TEST", actor: null });
  const chot = productDef("chotdon")!.name;
  const erp = productDef("erp")!.name;
  const live = async () => (await liveSubscriptions(THUE)).map((s) => s.productKey).sort();
  const first = await subscribeProductAsOperator(op, { orgCode: THUE, productKey: "chotdon", idempotencyKey: "ccr-thue-k1", reason: "Khách mua Chốt Đơn" });
  assert.ok("ok" in first && first.status === "SUCCEEDED" && first.message === `Đã thuê ${chot}.`, JSON.stringify(first));
  // Form CŨ (một khoá suốt vòng đời form): chọn sản phẩm khác, bấm tiếp ⇒ từ chối RÕ, không job nào chạy, KHÔNG báo «đã thuê».
  const stale = await subscribeProductAsOperator(op, { orgCode: THUE, productKey: "erp", idempotencyKey: "ccr-thue-k1", reason: "Khách mua thêm ERP" });
  assert.ok("error" in stale && stale.error.startsWith(SUBSCRIBE_KEY_REUSED) && stale.error.includes("«chotdon»"), `khoá cũ cho sản phẩm khác ⇒ từ chối rõ: ${JSON.stringify(stale)}`);
  assert.deepEqual(await live(), ["chotdon"], "ERP chưa được thuê — và không ai được báo là đã thuê");
  // Bấm đúp ĐÚNG lượt đầu (mạng chập) ⇒ cùng job, câu nói đúng sản phẩm job đã thuê.
  const twice = await subscribeProductAsOperator(op, { orgCode: THUE, productKey: "chotdon", idempotencyKey: "ccr-thue-k1", reason: "Bấm đúp" });
  assert.ok("ok" in twice && twice.status === "SUCCEEDED" && twice.message === `Đã thuê ${chot}.`, JSON.stringify(twice));
  // Form MỚI: khoá mới sau lượt thành công ⇒ sản phẩm sau được thuê THẬT.
  const next = await subscribeProductAsOperator(op, { orgCode: THUE, productKey: "erp", idempotencyKey: "ccr-thue-k2", reason: "Khách mua thêm ERP" });
  assert.ok("ok" in next && next.status === "SUCCEEDED" && next.message === `Đã thuê ${erp}.`, JSON.stringify(next));
  assert.deepEqual(await live(), ["chotdon", "erp"]);
  const pdb = await getPlatformDb();
  assert.equal((await pdb.select({ id: schema.platformProvisioningJobs.id }).from(schema.platformProvisioningJobs).where(like(schema.platformProvisioningJobs.idempotencyKey, "ccr-thue-%"))).length, 2, "lượt bị từ chối không đẻ job");
}

async function testInternalAndHomeUnchanged() {
  const home = await getHomeOrganization();
  const homeBefore = { plan: home.plan ?? null, brand: home.brand ?? null };
  const homeInstalls = async () => withOrganization(home.code, async () => (await (await getDb()).select({ id: schema.blueprintInstalls.id }).from(schema.blueprintInstalls).where(eq(schema.blueprintInstalls.blueprintKey, AI_SALES_BLUEPRINT.key))).length);
  const installsBefore = await homeInstalls();

  // Tài khoản NỘI BỘ + ERP: gói giá cũ vẫn tạo được (luật đang có); không mẫu; thương hiệu không bị đặt hộ.
  const r = await requestProvisioning(createReq({ code: NOIBO, planKey: "standard", products: ["erp"], account: { code: ACCT_NOIBO, name: "Kho nội bộ", accountType: "INTERNAL" } }), ctx("ccr-noibo-1"));
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.job.status, "SUCCEEDED", JSON.stringify(r.job.steps));
  assert.equal(lastStep(r.job, "TEMPLATE")?.status, "SKIPPED", "bộ có ERP: quản trị tự chọn mẫu ngành");
  invalidateOrganizations();
  const org = await findOrganization(NOIBO);
  assert.deepEqual([org?.plan, org?.brand ?? null], ["standard", null], "gói đúng như chọn, thương hiệu không bị đặt hộ");
  assert.deepEqual((await templateRows(NOIBO)).installs, [], "không cài mẫu Chốt Đơn cho khách ERP");

  // Nhà: không cấp lại được; gói / thương hiệu / sổ mẫu không đổi; không phải vỏ Chốt Đơn.
  assert.equal(await validateRequest(createReq({ code: home.code, planKey: "trial" })), "Không cấp lại workspace nhà.");
  invalidateOrganizations();
  const homeAfter = await getHomeOrganization();
  assert.deepEqual({ plan: homeAfter.plan ?? null, brand: homeAfter.brand ?? null }, homeBefore);
  assert.equal(await homeInstalls(), installsBefore, "sổ mẫu của nhà không đổi");
  assert.equal(salesAgentShell(homeAfter, [...(await getEnabledModules(home.code))]), false);
}

export async function testCreateCustomerRules() {
  testPure();
  testFingerprint();
  testSource();
  await cleanup();
  try {
    await testForm();
    const home = await getHomeOrganization();
    const op: SessionUser = { id: "ccr-op", email: "op@ccr.local", name: "OP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const chotJob = await testChotDon();
    await testInboxPlanNoAiTemplate();
    await testRefusals(op, chotJob);
    await testTemplateFailureRealPath(op);
    await testStaleJobInput();
    await testStartOperator();
    await testSubscribeSameForm(op);
    await testInternalAndHomeUnchanged();
    console.log("✓ Luật thương mại của workspace: thương hiệu theo bộ sản phẩm (chọn ngược ⇒ từ chối, gợi ý host ⇒ bộ sản phẩm thắng) · gói niêm yết + dùng thử ở MỌI cửa (tạo khách · thuê thêm · đổi gói · đổi thương hiệu · mã mời · /start người vận hành · cửa ghi chung; giá cũ chỉ nội bộ không chỉ-Chốt-Đơn, internal không cho ai) · mẫu «Chỉ cần AI bán hàng» bằng bộ cài /start (Inbox thì không), hỏng ⇒ báo thẳng + «Cài lại mẫu» chạy riêng bước mẫu · job cũ sai luật không chạy lại · câu «vì sao» hiện khi chạm · dấu vân đủ trường + câu «khoá đã dùng» theo trạng thái · «Thuê sản phẩm» cùng form không báo thành công giả · nội bộ / nhà không đổi");
  } finally {
    await cleanup();
  }
}
