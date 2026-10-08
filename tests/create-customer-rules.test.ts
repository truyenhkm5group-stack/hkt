/**
 * ═══════════ «TẠO KHÁCH MỚI» ĐÚNG NGAY TỪ MẶC ĐỊNH (kiểm khởi chạy 08/10/2026 · lib/saas/create-customer-rules.ts) ═══════════
 *
 * Khách trả tiền đầu tiên của Chốt Đơn được người vận hành tạo ở `/platform/customers`. Bốn mặc định sai đã đo: thương hiệu
 * «(mặc định)» = NULL ⇒ khách thấy menu ERP nội bộ; danh sách gói trộn gói cũ + `internal` mà máy chủ không chặn ⇒ giá cũ, không
 * dùng thử, bot im; nút đứng đầu khung mờ không lời; đường người vận hành không cài mẫu «Chỉ cần AI bán hàng» như `/start`.
 *
 *  1. THUẦN — thương hiệu theo bộ sản phẩm (chỉ Chốt Đơn ⇒ khoá `chotdon`, xin `vnx` ⇒ từ chối; có ERP ⇒ người vận hành chọn) và
 *     `salesAgentShell` bật đúng nhờ nó; gói hợp lệ đọc từ SỔ GIÁ (phiên bản CATALOG đang hiệu lực + `trial`; phiên bản tương lai,
 *     phiên bản đã bị thay không tính; gói thêm vào sổ tự có mặt); giá cũ chỉ cho tài khoản nội bộ, `internal` không cho ai; form
 *     chỉ liệt kê gói tạo được, mặc định dùng thử; mẫu chỉ cho bộ chỉ-Chốt-Đơn và là ĐÚNG mẫu của `/start`; câu «vì sao».
 *  2. MÃ NGUỒN — máy chủ quyết (validateRequest + job), form chỉ đọc luật; bước mẫu đi ĐÚNG bộ cài của `/start`; không danh sách
 *     gói gõ tay; ô lý do + nút nằm SAU các ô nhập.
 *  3. FORM — HTML thật của «Tạo khách mới»: ô nhập trước, nút sau, câu «Chưa thể tạo khách — cần …»; gói niêm yết, không
 *     `internal`, không giá cũ với khách ngoài, chọn sẵn dùng thử; thương hiệu Chốt Đơn khoá.
 *  4. MÁY CHỦ TỪ CHỐI — `internal` / giá cũ cho khách NGOÀI (tài khoản mới · tài khoản có sẵn · mã tài khoản có sẵn khai loại khác)
 *     TRƯỚC khi ghi job; bộ chỉ-Chốt-Đơn xin `vnx` ⇒ từ chối; cửa người vận hành trả đúng câu đó.
 *  5. CHỐT ĐƠN — khách ngoài, chỉ Chốt Đơn, KHÔNG khai thương hiệu ⇒ `chotdon`, vỏ app bật; mẫu được cài (vai trò, field, luật ở
 *     NHÁP, hồ sơ AI); chạy lại job ⇒ bước mẫu SKIPPED, không nhân đôi gì.
 *  6. HỎNG CÓ VẾT — lỗi tiêm ở bước mẫu: job vẫn SUCCEEDED, bước TEMPLATE FAILED kèm câu, nhật ký nền tảng `ORG_SETUP`; chạy lại
 *     cài nốt.
 *  7. NỘI BỘ / NHÀ KHÔNG ĐỔI — tài khoản nội bộ vẫn tạo được bằng gói giá cũ (luật đang có), bộ có ERP không cài mẫu, thương hiệu
 *     không bị đặt hộ; workspace nhà không đổi gói / thương hiệu / sổ mẫu và vẫn không cấp lại được.
 *
 * Mốc thời gian: sổ giá giả dựng quanh MỘT `new Date()`; vòng thật đọc đồng hồ như mã nguồn (luật 50 · 65).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { templateBlueprint } from "@/lib/blueprints/templates";
import { AI_SALES_BLUEPRINT } from "@/lib/blueprints/templates/ai-sales";
import { AI_PROFILE_SETTING_KEY } from "@/lib/blueprints/types";
import { confirmBlockedReason, confirmReady, reasonNeed } from "@/lib/constants/confirm-reason";
import { salesAgentShell } from "@/lib/constants/saas-nav";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { ORG_BRAND_LABEL, ORG_BRANDS } from "@/lib/platform/org-brand";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { invalidatePriceBook, loadPriceBook } from "@/lib/pricing/price-book";
import { LEGACY_VERSION_KEY, parsePlanPrice, parsePriceVersion, type PlanPriceRow, type PriceBook } from "@/lib/pricing/versions";
import { getSettingJson } from "@/lib/settings";
import { modulesToProvision, productDef } from "@/lib/saas/catalog";
import { createCustomerAsOperator } from "@/lib/saas/console";
import {
  catalogPlanKeys,
  createCustomerMissing,
  createCustomerPlanOptions,
  createPlanRefusal,
  createPlanTier,
  defaultCreatePlanKey,
  lockedBrandFor,
  planOptionLabel,
  plansForAccountType,
  provisioningTemplateFor,
  resolveCreateBrand,
  SALES_AGENT_TEMPLATE,
  suggestedBrandFor,
  templateSummary,
} from "@/lib/saas/create-customer-rules";
import { readPlans } from "@/lib/saas/customers";
import { legacyPlanOnCreateAllowed } from "@/lib/saas/policy";
import { requestProvisioning, retryJob, validateRequest, type CreateCustomerRequest, type JobRow, type JobStep } from "@/lib/saas/provisioning";
import { PROVISIONING_TEMPLATE_AUDIT_SUBJECT, setProvisioningTemplateFaultForTests } from "@/lib/saas/provisioning-template";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { CreateCustomerForm } from "@/components/saas/operator-actions";

const CHOT = "ccr-chot-ngoai";
const LOI = "ccr-chot-loi";
const NOIBO = "ccr-noi-bo";
const TUCHOI = "ccr-tu-choi";
const ORGS = [CHOT, LOI, NOIBO, TUCHOI] as const;
const ACCT_CHOT = "ccr-acct-ngoai";
const ACCT_LOI = "ccr-acct-loi";
const ACCT_NOIBO = "ccr-acct-noi-bo";
const ACCTS = [ACCT_CHOT, ACCT_LOI, ACCT_NOIBO, "ccr-acct-tu-choi"] as const;

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

/** Sổ giá giả: phiên bản cũ đã bị thay · phiên bản đang hiệu lực (KHÔNG có `trial`) · phiên bản tương lai · legacy. */
function syntheticBook(now: Date): PriceBook {
  const day = 86_400_000;
  return {
    versions: [versionRow(LEGACY_VERSION_KEY, "LEGACY_SNAPSHOT", null), versionRow("cat-cu", "CATALOG", new Date(now.getTime() - 30 * day)), versionRow("cat-nay", "CATALOG", new Date(now.getTime() - 2 * day)), versionRow("cat-sau", "CATALOG", new Date(now.getTime() + 30 * day))],
    prices: [
      priceRow(LEGACY_VERSION_KEY, "trial", 10, { trialDays: 7 }),
      priceRow(LEGACY_VERSION_KEY, "standard", 50, { monthlyVnd: 990_000 }),
      priceRow(LEGACY_VERSION_KEY, "internal", 99),
      priceRow("cat-cu", "goi-cu", 5, { monthlyVnd: 100_000 }),
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
  assert.deepEqual(resolveCreateBrand(["chotdon"], null), { brand: "chotdon" }, "người vận hành bỏ trống ⇒ MÁY CHỦ tự đặt");
  assert.deepEqual(resolveCreateBrand(["chotdon"], undefined), { brand: "chotdon" });
  assert.deepEqual(resolveCreateBrand(["chotdon"], "chotdon"), { brand: "chotdon" });
  const vnxForChot = resolveCreateBrand(["chotdon"], "vnx");
  assert.ok("error" in vnxForChot && vnxForChot.error.includes("Chốt Đơn Tự Động") && vnxForChot.error.includes("menu ERP"), `xin VNX cho khách chỉ Chốt Đơn ⇒ từ chối, câu nói hệ quả: ${JSON.stringify(vnxForChot)}`);
  assert.deepEqual(resolveCreateBrand(["erp"], null), { brand: null }, "có ERP ⇒ đúng lựa chọn của người vận hành (bỏ trống = không theo dõi, như trước)");
  assert.deepEqual(resolveCreateBrand(["erp", "chotdon"], "chotdon"), { brand: "chotdon" }, "có ERP vẫn chọn được Chốt Đơn");
  assert.deepEqual(resolveCreateBrand(["erp", "chotdon"], "vnx"), { brand: "vnx" });
  assert.equal(suggestedBrandFor(["chotdon"]), "chotdon");
  assert.equal(suggestedBrandFor(["erp", "chotdon"]), "vnx", "gợi ý cho bộ có ERP = thương hiệu của ERP");
  // Vỏ app: thương hiệu là đúng cái công tắc mà ô «(mặc định)» làm hỏng.
  const chotModules = modulesToProvision(productDef("chotdon")!);
  const decided = resolveCreateBrand(["chotdon"], null);
  assert.ok(!("error" in decided));
  assert.equal(salesAgentShell({ isHome: false, brand: decided.brand }, chotModules), true, "thương hiệu máy chủ đặt ⇒ vỏ app 8 mục");
  assert.equal(salesAgentShell({ isHome: false, brand: null }, chotModules), false, "đúng lỗi đã đo: NULL ⇒ menu ERP nội bộ");

  // ── Gói hợp lệ đọc từ SỔ GIÁ.
  const now = new Date();
  const book = syntheticBook(now);
  const keys = catalogPlanKeys(book, now);
  assert.deepEqual(keys, ["trial", "inbox", "starter", "goi-moi", "enterprise"], "phiên bản CATALOG đang hiệu lực theo thứ tự của nó + `trial`");
  assert.ok(!keys.includes("mega") && !keys.includes("goi-cu") && !keys.includes("standard"), "phiên bản tương lai / đã bị thay / legacy không tính");
  assert.deepEqual(catalogPlanKeys({ versions: book.versions.filter((v) => v.kind !== "CATALOG"), prices: book.prices }, now), ["trial"], "chưa có bảng giá niêm yết ⇒ chỉ dùng thử (phía hẹp)");
  assert.equal(createPlanTier("internal", keys), "HOME_ONLY");
  assert.equal(createPlanTier("internal", [...keys, "internal"]), "HOME_ONLY", "`internal` không bao giờ thành gói bán, kể cả khi lỡ vào sổ");
  assert.equal(createPlanTier("standard", keys), "LEGACY");
  assert.equal(createPlanTier("goi-moi", keys), "CATALOG", "gói mới thêm vào bảng giá tự có mặt — không danh sách gõ tay");
  assert.equal(createPlanTier("trial", ["starter"]), "CATALOG", "`trial` luôn tạo được");

  assert.equal(legacyPlanOnCreateAllowed("INTERNAL"), true);
  for (const t of ["EXTERNAL", null, undefined, "", "internal", "LA"]) assert.equal(legacyPlanOnCreateAllowed(t), false, `${String(t)} ⇒ không (phía hẹp)`);
  const listed = ["Dùng thử", "Starter"];
  const legacyExt = createPlanRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: "EXTERNAL", listed });
  assert.ok(legacyExt && legacyExt.includes("«Tiêu chuẩn»") && legacyExt.includes("không có dùng thử") && legacyExt.includes("Dùng thử · Starter"), `giá cũ cho khách ngoài ⇒ câu kinh doanh + gói chọn lại: ${legacyExt}`);
  assert.equal(createPlanRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: "INTERNAL", listed }), null, "nội bộ giữ luật đang có");
  assert.ok(createPlanRefusal({ planName: "Tiêu chuẩn", tier: "LEGACY", accountType: null, listed }), "không tra được loại ⇒ như khách ngoài");
  for (const t of ["INTERNAL", "EXTERNAL"]) assert.ok(createPlanRefusal({ planName: "Nội bộ", tier: "HOME_ONLY", accountType: t, listed })?.includes("workspace nhà"), `${t}: \`internal\` không cấp cho khách`);
  assert.equal(createPlanRefusal({ planName: "Starter", tier: "CATALOG", accountType: "EXTERNAL", listed }), null);

  // ── Ô «Gói» của form: dựng từ sổ, lọc theo loại tài khoản bằng ĐÚNG phép của máy chủ.
  const plans = [
    { key: "internal", name: "Nội bộ", priceVnd: null },
    { key: "standard", name: "Tiêu chuẩn", priceVnd: 990_000 },
    { key: "trial", name: "Dùng thử", priceVnd: null },
    { key: "starter", name: "Starter", priceVnd: 790_000 },
    { key: "inbox", name: "Inbox", priceVnd: 299_000 },
    { key: "enterprise", name: "Enterprise", priceVnd: null },
  ];
  const options = createCustomerPlanOptions(plans, book, now);
  assert.deepEqual(options.map((o) => `${o.key}:${o.tier}`), ["inbox:CATALOG", "starter:CATALOG", "enterprise:CATALOG", "trial:CATALOG", "standard:LEGACY", "internal:HOME_ONLY"], "niêm yết trước (thứ tự phiên bản), giá cũ sau");
  const ext = plansForAccountType(options, "EXTERNAL").map((o) => o.key);
  assert.deepEqual(ext, ["inbox", "starter", "enterprise", "trial"], "khách ngoài: chỉ gói niêm yết");
  assert.deepEqual(plansForAccountType(options, "INTERNAL").map((o) => o.key), ["inbox", "starter", "enterprise", "trial", "standard"], "nội bộ: thêm giá cũ, KHÔNG `internal`");
  assert.equal(defaultCreatePlanKey(plansForAccountType(options, "EXTERNAL")), "trial", "chọn sẵn dùng thử");
  assert.equal(defaultCreatePlanKey([]), null);
  const label = (k: string) => planOptionLabel(options.find((o) => o.key === k)!);
  assert.match(label("starter"), /^Starter — 790\.000\s₫\/tháng$/);
  assert.match(label("inbox"), /không có AI bán hàng/, "Inbox nói rõ không có AI bán hàng");
  assert.match(label("enterprise"), /hợp đồng, từ 5\.990\.000\s₫\/tháng/);
  assert.match(label("standard"), /giá cũ/);

  // ── Mẫu: chỉ bộ chỉ-Chốt-Đơn, và là ĐÚNG mẫu của loại hình «Chỉ cần AI bán hàng» ở /start.
  const tpl = provisioningTemplateFor(["chotdon"]);
  assert.ok(tpl && SALES_AGENT_TEMPLATE && tpl.templateKey === BUSINESS_TYPE_SPEC.ai_sales.templateKey && tpl.businessType === "ai_sales");
  assert.equal(templateBlueprint(tpl.templateKey)?.key, AI_SALES_BLUEPRINT.key, "khoá mẫu trỏ tới một mẫu có thật trong sổ");
  for (const set of [["erp"], ["erp", "chotdon"], []]) assert.equal(provisioningTemplateFor(set), null, `${JSON.stringify(set)} ⇒ không cài mẫu (khách ERP tự chọn)`);
  const summary = templateSummary(AI_SALES_BLUEPRINT);
  for (const k of ["Nhân viên bán hàng", "Đơn chốt ⇒ báo nhóm", "NHÁP", "hồ sơ cửa hàng cho AI"]) assert.ok(summary.includes(k), `câu kể mẫu phải nói «${k}»: ${summary}`);

  // ── Ô còn thiếu (lời nhắc của form).
  const empty = createCustomerMissing({ workspaceCode: "", workspaceName: "", products: [], planKey: null, offeredPlanKeys: ext, adminEmail: "" });
  assert.deepEqual(empty, ["nhập mã workspace (chữ thường, số, gạch ngang)", "nhập tên workspace", "chọn ít nhất một sản phẩm", "chọn gói", "nhập email quản trị"]);
  const full = { workspaceCode: "Shop-Moi", workspaceName: "Shop Mới", products: ["chotdon"], planKey: "trial", offeredPlanKeys: ext, adminEmail: "chu@shop.vn" };
  assert.deepEqual(createCustomerMissing(full), [], "đủ ô ⇒ không thiếu gì (mã viết hoa được hạ chữ như máy chủ)");
  assert.deepEqual(createCustomerMissing({ ...full, planKey: "standard" }), ["chọn gói"], "gói không có trong danh sách của loại tài khoản ⇒ thiếu gói");

  // ── Câu «vì sao nút chưa bấm được».
  assert.equal(confirmBlockedReason({ label: "Tạo khách…", minReason: 5, reason: "" }), `Chưa bấm được «Tạo khách» — cần ${reasonNeed(5)}.`);
  assert.equal(confirmBlockedReason({ label: "Tạo khách…", lead: "Chưa thể tạo khách", minReason: 5, reason: "ab", missing: ["chọn gói", "nhập email quản trị"] }), "Chưa thể tạo khách — cần chọn gói · nhập email quản trị · nhập lý do (ít nhất 5 ký tự).");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "đủ năm ký tự" }), null, "bấm được ⇒ không câu nào");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "", pending: true }), null, "đang chạy ⇒ không câu nào");
  assert.equal(confirmBlockedReason({ label: "x", minReason: 5, reason: "", disabled: true }), null, "khung bị khoá mà không khai lý do ⇒ im lặng, không đoán");
  assert.equal(confirmBlockedReason({ label: "Đổi gói…", lead: "Chưa đổi được gói", minReason: 5, reason: "", disabled: true, disabledReason: "chọn một gói khác gói đang dùng" }), "Chưa đổi được gói — chọn một gói khác gói đang dùng.");
  assert.equal(confirmReady({ minReason: 5, reason: "đủ năm ký tự", missing: ["chọn gói"] }), false, "còn ô thiếu ⇒ chưa bấm được dù đủ lý do");
  assert.equal(confirmReady({ minReason: 5, reason: "đủ năm ký tự", missing: [] }), true);
  assert.equal(confirmReady({ minReason: 0, reason: "" }), true, "lý do không bắt buộc");
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

function testSource() {
  const job = code("lib/saas/provisioning.ts");
  const validate = job.slice(job.indexOf("export async function validateRequest"), job.indexOf("async function cancelGuard"));
  for (const call of ["resolveCreateBrand(", "createPlanRefusal(", "catalogPlanKeys("]) assert.ok(validate.includes(call), `validateRequest (MÁY CHỦ) phải gọi ${call}`);
  assert.ok(/const req = decidedRequest\(input/.test(job), "job ghi đầu vào ĐÃ QUYẾT (thương hiệu) — lượt chạy lại không suy lại");
  assert.ok(job.includes("installProvisioningTemplate(") && job.includes("provisioningTemplateFor(req.products, catalog)"), "job cài mẫu theo luật của bộ sản phẩm");

  const tpl = code("lib/saas/provisioning-template.ts");
  for (const call of ["buildSignupBlueprint(", "installBlueprint(built.bp, subject)", "adminSessionUser(", "withOrganization(", "installedVersion("]) assert.ok(tpl.includes(call), `bước mẫu dùng ĐÚNG bộ cài của /start: thiếu ${call}`);
  assert.ok(!/applyBlueprint\(|saveRule\(|createCustomField\(|saveAccessRoleCore\(/.test(tpl), "không đường ghi thứ hai cạnh bộ cài");
  assert.ok(read("lib/onboarding/service.ts").includes("installBlueprint(input.built.bp, subject)"), "/start vẫn cài bằng đúng lời gọi ấy");

  const rules = code("lib/saas/create-customer-rules.ts");
  assert.ok(!/["'`](starter|growth|scale|inbox|enterprise|basic|pro|standard)["'`]/.test(rules), "luật không gõ tay danh sách gói — đọc từ sổ giá");
  assert.ok(!/(accountType|billingMode)\s*[!=]==?/.test(rules), "loại tài khoản chỉ được hỏi qua lib/saas/policy.ts");

  const form = code("components/saas/operator-actions.tsx");
  const create = form.slice(form.indexOf("export function CreateCustomerForm"));
  assert.ok(!create.includes("(mặc định)"), "không còn ô thương hiệu «(mặc định)» = NULL");
  for (const fn of ["plansForAccountType(", "lockedBrandFor(", "createCustomerMissing(", "provisioningTemplateFor("]) assert.ok(create.includes(fn), `form đọc luật chung: thiếu ${fn}`);

  const pilot = code("components/platform/pilot-ops.tsx");
  const confirm = pilot.slice(pilot.indexOf("export function ConfirmWithReason"), pilot.indexOf("const toOutcome"));
  const fields = confirm.indexOf("{withFields ? props.children : null}");
  assert.ok(fields > 0 && fields < confirm.indexOf("<Input id={props.id}") && fields < confirm.indexOf("<Button"), "ô nhập TRƯỚC ô lý do + nút");
  assert.ok(confirm.includes("confirmBlockedReason(") && confirm.includes("aria-describedby"), "câu «vì sao» gắn vào nút");
}

// ─────────────────────────── 3 · FORM (HTML thật) ───────────────────────────

function html(el: React.ReactElement): string {
  // `tsx` biên dịch JSX theo runtime CỔ ĐIỂN ngoài Next ⇒ cần `React` toàn cục (như saas-signup-subscription.test.ts).
  (globalThis as { React?: typeof React }).React ??= React;
  return renderToStaticMarkup(el);
}

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
  assert.ok(at("Lý do (ít nhất") < at("Chưa thể tạo khách — cần"), "câu «vì sao» ngay dưới nút");
  assert.ok(page.includes("Chưa thể tạo khách — cần nhập mã workspace"), "câu nói đúng ô còn thiếu");
  assert.ok(!page.includes('value="internal"'), "không có gói `internal`");
  for (const o of plans.filter((p) => p.tier !== "CATALOG")) assert.ok(!page.includes(`value="${o.key}"`), `khách ngoài không thấy gói giá cũ ${o.key}`);
  for (const o of plans.filter((p) => p.tier === "CATALOG")) assert.ok(page.includes(`value="${o.key}"`), `thiếu gói niêm yết ${o.key}`);
  assert.match(page, /<option value="trial" selected="">/, "chọn sẵn dùng thử");
  assert.match(page, /<select id="cc-brand"[^>]*disabled=""/, "chỉ Chốt Đơn ⇒ ô thương hiệu khoá");
  assert.match(page, /<option value="chotdon" selected="">/, "…và đang ở Chốt Đơn");
  assert.ok(page.includes("Chỉ cần AI bán hàng") && page.includes("Nhân viên bán hàng"), "form nói trước mẫu sẽ cài");

  // Khung không có ô nhập: một hàng lý do + nút như cũ, không câu thừa.
  const bare = html(createElement(ConfirmWithReason, { id: "ccr-bare", label: "Tạm dừng", title: "t", consequence: "c", minReason: 5, placeholder: "p", run: async () => ({ ok: true as const }) }));
  assert.ok(bare.includes("Lý do (ít nhất 5") && !bare.includes("Chưa bấm được"), "không ô nhập ⇒ không thêm câu");
  // Khung bị khoá có khai lý do ⇒ nói đúng lý do đó, sau ô nhập.
  const locked = html(createElement(ConfirmWithReason, { id: "ccr-lock", label: "Đổi gói…", blockedLead: "Chưa đổi được gói", disabled: true, disabledReason: "chọn một gói khác gói đang dùng", title: "t", consequence: "c", minReason: 5, placeholder: "p", run: async () => ({ ok: true as const }) }, createElement("span", null, "Ô-GÓI-MỚI")));
  assert.ok(locked.indexOf("Ô-GÓI-MỚI") < locked.indexOf("Lý do (ít nhất") && locked.includes("Chưa đổi được gói — chọn một gói khác gói đang dùng."));
}

// ─────────────────────────── 4–7 · VÒNG THẬT ───────────────────────────

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
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.subject, ACCTS.map((a) => `account:${a}`)));
  await pdb.delete(schema.platformAccounts).where(inArray(schema.platformAccounts.code, [...ACCTS]));
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

/** Số dòng mẫu sinh ra trong CSDL workspace — chạy lại không được nhân đôi dòng nào. */
async function templateRows(orgCode: string) {
  return withOrganization(orgCode, async () => {
    const db = await getDb();
    const roles = await db.select({ code: schema.accessRoles.code }).from(schema.accessRoles).where(eq(schema.accessRoles.code, "BAN_HANG"));
    const fields = await db.select({ key: schema.metaCustomFields.fieldKey }).from(schema.metaCustomFields).where(inArray(schema.metaCustomFields.fieldKey, (AI_SALES_BLUEPRINT.fields ?? []).map((f) => f.key)));
    const rules = await db.select({ status: schema.workflowRules.status }).from(schema.workflowRules).where(inArray(schema.workflowRules.key, (AI_SALES_BLUEPRINT.workflows ?? []).map((w) => w.key)));
    const installs = await db.select({ status: schema.blueprintInstalls.status }).from(schema.blueprintInstalls).where(eq(schema.blueprintInstalls.blueprintKey, AI_SALES_BLUEPRINT.key));
    const profile = await getSettingJson<{ businessProfile?: string } | null>(AI_PROFILE_SETTING_KEY, null);
    return { roles: roles.length, fields: fields.length, rules: rules.map((r) => r.status), installs: installs.map((i) => i.status), profile: profile?.businessProfile ?? null };
  });
}

/** Mô phỏng tiến trình chết ngay sau lượt chạy: job về FAILED để «Chạy lại» đi lại MỌI bước (đường idempotent thật). */
async function rerun(job: JobRow): Promise<JobRow> {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformProvisioningJobs).set({ status: "FAILED", lastError: "bài kiểm: tiến trình chết ngay sau lượt chạy" }).where(eq(schema.platformProvisioningJobs.id, job.id));
  const again = await retryJob(job.id, { actor: null, email: "op@ccr.local", source: "TEST" });
  assert.ok(!("error" in again), JSON.stringify(again));
  return again;
}

async function jobsWithKey(key: string) {
  const pdb = await getPlatformDb();
  return pdb.select({ id: schema.platformProvisioningJobs.id }).from(schema.platformProvisioningJobs).where(eq(schema.platformProvisioningJobs.idempotencyKey, key));
}

async function testChotDon() {
  // Khách NGOÀI, chỉ Chốt Đơn, gói dùng thử, KHÔNG khai thương hiệu (đúng cú bấm cũ để «(mặc định)»).
  const r = await requestProvisioning(createReq({ code: CHOT, planKey: "trial", brand: null }), ctx("ccr-chot-1"));
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal(r.job.status, "SUCCEEDED", JSON.stringify(r.job.steps));
  assert.deepEqual(stepsOf(r.job).map((s) => s.key), ["ACCOUNT", "WORKSPACE", "ADMIN", "SUBSCRIPTIONS", "BILLING", "TEMPLATE"]);
  assert.equal(lastStep(r.job, "TEMPLATE")?.status, "DONE", JSON.stringify(lastStep(r.job, "TEMPLATE")));
  assert.equal((r.job.input as CreateCustomerRequest).workspace.brand, "chotdon", "job ghi thương hiệu ĐÃ QUYẾT");
  invalidateOrganizations();
  const org = await findOrganization(CHOT);
  assert.equal(org?.brand, "chotdon", "máy chủ tự đặt thương hiệu Chốt Đơn");
  invalidateCapabilities(CHOT);
  const modules = [...(await getEnabledModules(CHOT))];
  assert.equal(salesAgentShell(org, modules), true, "khách thấy vỏ app 8 mục, không menu ERP");

  const rows = await templateRows(CHOT);
  assert.deepEqual([rows.roles, rows.fields, rows.installs], [1, (AI_SALES_BLUEPRINT.fields ?? []).length, ["DONE"]], JSON.stringify(rows));
  assert.ok(rows.rules.length === (AI_SALES_BLUEPRINT.workflows ?? []).length && rows.rules.every((s) => s === "DRAFT"), `luật của mẫu nằm ở NHÁP: ${JSON.stringify(rows.rules)}`);
  assert.equal(rows.profile, AI_SALES_BLUEPRINT.ai?.businessProfile, "hồ sơ cửa hàng cho AI");
  assert.equal(salesAgentShell(org, [...(await getEnabledModules(CHOT))]), true, "mẫu không bật module ERP nào — vỏ app giữ nguyên");

  // Gửi lại cùng khoá ⇒ cùng job; chạy lại ⇒ bước mẫu SKIPPED, không nhân đôi.
  const same = await requestProvisioning(createReq({ code: CHOT, planKey: "trial", brand: null }), ctx("ccr-chot-1"));
  assert.ok(!("error" in same) && same.reused && same.job.id === r.job.id);
  const again = await rerun(r.job);
  assert.equal(again.status, "SUCCEEDED", JSON.stringify(again.steps));
  assert.equal(lastStep(again, "TEMPLATE")?.status, "SKIPPED", JSON.stringify(lastStep(again, "TEMPLATE")));
  assert.deepEqual(await templateRows(CHOT), rows, "chạy lại không thêm vai trò / field / luật / lượt cài nào");
  return r.job;
}

async function testRefusals(op: SessionUser, chotJob: JobRow) {
  const pdb = await getPlatformDb();
  const accountsBefore = (await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts)).length;
  const refused = async (label: string, req: CreateCustomerRequest, key: string, expect: RegExp) => {
    const r = await requestProvisioning(req, ctx(key));
    assert.ok("error" in r && expect.test(r.error), `${label}: ${JSON.stringify(r)}`);
    assert.equal((await jobsWithKey(key)).length, 0, `${label}: từ chối TRƯỚC khi ghi job`);
  };
  const external = { code: "ccr-acct-tu-choi", name: "Khách bị chặn", accountType: "EXTERNAL" as const };
  await refused("khách ngoài + giá cũ", createReq({ code: TUCHOI, planKey: "standard", account: external }), "ccr-tc-legacy", /chỉ còn giữ giá cho khách cũ/);
  await refused("khách ngoài + gói nhà", createReq({ code: TUCHOI, planKey: "internal", account: external }), "ccr-tc-internal", /workspace nhà/);
  await refused("nội bộ + gói nhà", createReq({ code: TUCHOI, planKey: "internal", account: { ...external, accountType: "INTERNAL" } }), "ccr-tc-internal-nb", /workspace nhà/);
  await refused("tài khoản có sẵn (ngoài) + giá cũ", createReq({ code: TUCHOI, planKey: "basic", accountId: chotJob.accountId! }), "ccr-tc-existing", /chỉ còn giữ giá cho khách cũ/);
  await refused("mã tài khoản có sẵn khai «nội bộ»", createReq({ code: TUCHOI, planKey: "standard", account: { code: ACCT_CHOT, name: "Mượn loại", accountType: "INTERNAL" } }), "ccr-tc-borrow", /chỉ còn giữ giá cho khách cũ/);
  await refused("chỉ Chốt Đơn + VNX", createReq({ code: TUCHOI, planKey: "trial", brand: "vnx", account: external }), "ccr-tc-brand", /phải mang thương hiệu/);
  // Cửa người vận hành trả ĐÚNG câu của máy chủ.
  const viaConsole = await createCustomerAsOperator(op, { account: external, workspace: { code: TUCHOI, name: "Shop bị chặn", planKey: "pro" }, products: ["chotdon"], admin: { email: "chu@ccr-tu-choi.local", name: "Chủ" }, idempotencyKey: "ccr-tc-console", reason: "Thử gói cũ cho khách mới" });
  assert.ok("error" in viaConsole && /chỉ còn giữ giá cho khách cũ/.test(viaConsole.error), JSON.stringify(viaConsole));
  invalidateOrganizations();
  assert.equal(await findOrganization(TUCHOI), null, "không workspace nào được tạo");
  assert.equal((await pdb.select({ id: schema.platformAccounts.id }).from(schema.platformAccounts)).length, accountsBefore, "không tài khoản mồ côi");
}

async function testTemplateFailureLeavesTrace() {
  setProvisioningTemplateFaultForTests(() => {
    throw new Error("lỗi tiêm ở bước mẫu");
  });
  let job: JobRow;
  try {
    const r = await requestProvisioning(createReq({ code: LOI, planKey: "trial", account: { code: ACCT_LOI, name: "Khách lỗi mẫu", accountType: "EXTERNAL" } }), ctx("ccr-loi-1"));
    assert.ok(!("error" in r), JSON.stringify(r));
    job = r.job;
  } finally {
    setProvisioningTemplateFaultForTests(null);
  }
  assert.equal(job.status, "SUCCEEDED", "lỗi cài mẫu KHÔNG làm hỏng cấp phát");
  const t = lastStep(job, "TEMPLATE");
  assert.equal(t?.status, "FAILED");
  assert.ok(t?.detail?.includes("lỗi tiêm ở bước mẫu") && t.detail.includes("cấp phát vẫn xong"), JSON.stringify(t));
  const pdb = await getPlatformDb();
  const trace = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, LOI), eq(schema.platformAuditLog.action, "ORG_SETUP"), eq(schema.platformAuditLog.subject, PROVISIONING_TEMPLATE_AUDIT_SUBJECT)));
  assert.equal(trace.length, 1, "một dòng nhật ký nền tảng cho lỗi cài mẫu");
  assert.ok(String(trace[0].reason).includes("lỗi tiêm"));
  assert.deepEqual((await templateRows(LOI)).installs, [], "lỗi trước bộ cài ⇒ chưa có lượt cài nào");
  // Chạy lại ⇒ cài nốt.
  const again = await rerun(job);
  assert.equal(lastStep(again, "TEMPLATE")?.status, "DONE", JSON.stringify(lastStep(again, "TEMPLATE")));
  assert.deepEqual((await templateRows(LOI)).installs, ["DONE"]);
}

async function testInternalAndHomeUnchanged() {
  const home = await getHomeOrganization();
  const homeBefore = { plan: home.plan ?? null, brand: home.brand ?? null };
  const homeInstalls = async () => withOrganization(home.code, async () => (await (await getDb()).select({ id: schema.blueprintInstalls.id }).from(schema.blueprintInstalls).where(eq(schema.blueprintInstalls.blueprintKey, AI_SALES_BLUEPRINT.key))).length);
  const installsBefore = await homeInstalls();

  // Tài khoản NỘI BỘ: gói giá cũ vẫn tạo được (luật đang có); bộ có ERP ⇒ không mẫu, thương hiệu không bị đặt hộ.
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
  testSource();
  await cleanup();
  try {
    await testForm();
    const home = await getHomeOrganization();
    const op: SessionUser = { id: "ccr-op", email: "op@ccr.local", name: "OP", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const chotJob = await testChotDon();
    await testRefusals(op, chotJob);
    await testTemplateFailureLeavesTrace();
    await testInternalAndHomeUnchanged();
    console.log("✓ Tạo khách mới: thương hiệu theo bộ sản phẩm (chỉ Chốt Đơn ⇒ chotdon, vỏ app bật) · gói theo bảng giá niêm yết + dùng thử (giá cũ chỉ nội bộ, internal không cho ai — chặn ở máy chủ) · mẫu «Chỉ cần AI bán hàng» cài bằng bộ cài /start, chạy lại không nhân đôi, hỏng có vết · ô lý do + nút dưới ô nhập, nói vì sao chưa bấm được · nội bộ / nhà không đổi");
  } finally {
    await cleanup();
  }
}
