/**
 * ═══════════ PHASE 11 · H1 — TẤN CÔNG CÔ LẬP TỔ CHỨC (docs/platform/phase-11-12-plan.md §H1) ═══════════
 *
 * Hai tổ chức THẬT (`ta-a`, `ta-b` — hai CSDL PGlite riêng, tự cấp, tự dọn). B có ĐỦ mọi loại dữ liệu của Phase 2–10:
 * field tuỳ biến + tệp, đối tượng tuỳ biến + bản ghi + quan hệ, form, trang đã xuất bản, luật + lượt chạy + lời duyệt
 * đang chờ, blueprint đã cài (B dựng qua /start bằng mã mời), bản nháp AI, kết nối có bí mật, thương hiệu + logo.
 *
 * Người quản trị của A — PHIÊN THẬT của A (JWT ký bằng bí mật của ứng dụng, claim `org = ta-a`) — gọi THẲNG server
 * action / route handler / page component / dịch vụ bằng id, khoá, slug, tên tệp, mã mời của B. Lượt gọi chạy trong
 * một phạm vi request dựng tay (work store + request store của Next) để `headers()` / `cookies()` / `revalidatePath`
 * chạy thật: một lượt THÀNH CÔNG không bao giờ bị che bởi lỗi "thiếu store" của môi trường kiểm thử.
 *
 * Mọi lượt phải bị từ chối (lỗi / 401 / 403 / 404 / chuyển hướng / rỗng) — hoặc, với vài cửa không nhận đích (chạy
 * luật, xem trước mẫu), chỉ chạm CHÍNH A — và:
 *  · không kết quả nào mang dấu `MARK` (mọi chữ của B đều có nó) hay bí mật của B;
 *  · ẢNH CHỤP CSDL của B (số dòng + băm nội dung của MỌI bảng) và các dòng mặt phẳng điều khiển của B (dòng tổ chức,
 *    module, mã mời, nhật ký nền tảng) TRƯỚC = SAU;
 *  · không một request mạng nào rời máy (fetch bị thay bằng bản ghi lượt gọi).
 *
 * Thêm bốn đòn không đi qua id: ĐỆM (B vừa dựng trang `chung` ⇒ A dựng `chung` cùng cấu hình phải ra số của A),
 * ĐỆM NĂNG LỰC (module của B vừa được đọc ⇒ phiên A vẫn chỉ có module của A), BẢN MÃ BỊ ĐÁNH CẮP (khoá AI đang bật
 * của B chép sang A, sửa mã tổ chức ⇒ AAD chặn, không gửi gì), PHIÊN GIẢ (claim `org = ta-b` + id quản trị B, ký bằng
 * khoá sai ⇒ về /login / 401).
 *
 * Kiểm đột biến đã chạy (28/09/2026), mỗi cái làm bài này ĐỎ: bỏ tiền tố tổ chức của khoá memo · bỏ mã tổ chức khỏi
 * AAD của bí mật kết nối · bỏ hai chốt "chỉ tổ chức nhà vận hành nền tảng" · đăng nhập tra tài khoản ngoài tổ chức
 * được chọn · bỏ kiểm chữ ký JWT phiên · khoá đệm năng lực không theo tổ chức.
 *
 * Bảo mật cuối (docs/platform/security-final.md) thêm các mặt ra đời SAU Phase 11 hoặc chưa phủ: trang Duyệt lõi
 * `/approvals`, AI Copilot (tổ chức khác nhà TẮT ở cổng: trạng thái «chưa có AI cho tổ chức này», không gọi model, không
 * ghi `ai_interactions`; công cụ gọi thẳng chỉ đọc CSDL của A, module tắt ⇒ MODULE_DISABLED; nhà không đổi), bản mã AI
 * của B chép NGUYÊN VĂN, THAO TÚNG METADATA (trang / form / danh sách / field / luật / gói tự gửi / nháp AI mang khoá của
 * B, field `x_…` không có, nguồn ngoài sổ, `users:manage`, vòng lặp, module tắt — từ chối và ảnh chụp CSDL A trước =
 * sau), xuất gói cấu hình, thẻ trạng thái sao lưu. Đột biến (28/09/2026), mỗi cái ĐỎ: "không tìm thấy lời duyệt" = thành
 * công · bỏ cổng tổ chức của Copilot · `copilotStatus` báo «bật» cho tổ chức khác · công cụ Copilot bỏ qua module tắt · AI
 * Builder của tổ chức khác rơi về khoá nhà · bỏ chốt mã tổ chức của dòng kết nối + AAD lấy từ cột · trang bỏ kiểm field
 * custom · luật bỏ chặn vòng lặp trực tiếp · gói cho vai trò khoá cấm · sao lưu đọc lời khai của nhà · tìm kiếm của
 * Copilot đọc CSDL nhà.
 *
 * Chạy lại cho pilot readiness (29/09/2026 — docs/platform/security-final.md): sổ dùng AI (`/settings/plan` chỉ cộng dòng
 * mang mã tổ chức của PHIÊN, `?org=` không đổi được gì), mọi cửa vận hành pilot / công tắc khẩn / công tắc AI / trang sức
 * khoẻ / tự kiểm khoá bí mật với đích B và đích NHÀ — ở vỏ action VÀ lõi gọi thẳng — bị từ chối VÌ «không phải người vận
 * hành»; đơn / sản phẩm / khách tạo tay của B bằng id; A không tự mở khoá công tắc người vận hành đã đóng với chính A
 * (tạm dừng luật, tắt AI, đình chỉ). Người vận hành NHÀ mở sức khoẻ của B: đúng một dòng SUPPORT_VIEW, CSDL B y nguyên,
 * 0 dữ liệu nghiệp vụ (tên khách, email, số tiền đơn, mã / tên sản phẩm, giá trị field), sao lưu không mượn lời khai nhà.
 * Đột biến (29/09/2026), mỗi cái ĐỎ: lõi công tắc khẩn bỏ câu hỏi người vận hành · lõi công tắc AI bỏ câu hỏi · trang sức
 * khoẻ bỏ câu hỏi · sổ AI bỏ lọc mã tổ chức · trang sức khoẻ không ghi SUPPORT_VIEW · sao lưu của trang sức khoẻ đọc đích
 * nhà · sản phẩm tay bỏ kiểm «mẫu mã thuộc sản phẩm» · `/settings/plan` nhận `?org=` · bỏ qua công tắc AI của tổ chức.
 *
 * Chạy qua `npm test` (cần `./setup-env` + `ensureMigrated()` của bộ chạy chung).
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import * as ReactNs from "react";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { ApprovalSection } from "@/app/(dashboard)/alerts/approval-section";
import ApprovalsPage from "@/app/(dashboard)/approvals/page";
import { BackupStatusCard } from "@/app/(dashboard)/integrations/backup-status-card";
import ObjectRecordsPage from "@/app/(dashboard)/o/[object]/page";
import ObjectRecordPage from "@/app/(dashboard)/o/[object]/[id]/page";
import CustomerDetailPage from "@/app/(dashboard)/customers/[id]/page";
import EditManualOrderPage from "@/app/(dashboard)/orders/[id]/edit/page";
import OrderDetailPage from "@/app/(dashboard)/orders/[id]/page";
import PlatformOrgPage from "@/app/(dashboard)/platform/org/[code]/page";
import PlatformPage from "@/app/(dashboard)/platform/page";
import ProductDetailPage from "@/app/(dashboard)/products/[id]/page";
import PlanPage from "@/app/(dashboard)/settings/plan/page";
import DynamicPage from "@/app/(dashboard)/p/[slug]/page";
import { GET as logoGET } from "@/app/api/branding/logo/route";
import { GET as blueprintExportGET } from "@/app/api/metadata/blueprint-export/route";
import { GET as metadataFileGET } from "@/app/api/metadata/files/[id]/route";
import { POST as syncPOST } from "@/app/api/sync/[job]/route";
import { askCopilot, confirmCopilotActions, copilotStatus } from "@/lib/actions/ai";
import { applyAiDraftAction, createAiDraftAction, discardAiDraftAction, previewAiDraftAction } from "@/lib/actions/ai-builder";
import { setOrgAiControlAction, setPlatformAiEnabledAction } from "@/lib/actions/ai-usage";
import { decideApproval, listPendingApprovals } from "@/lib/actions/approvals";
import { loginAction } from "@/lib/actions/auth";
import { installBlueprintFileAction, installTemplateAction, previewBlueprintFileAction, previewTemplateAction } from "@/lib/actions/blueprints";
import { removeLogoAction } from "@/lib/actions/branding";
import { saveConnectionAction, setConnectionStatusAction, testConnectionAction } from "@/lib/actions/connections";
import { cancelManualOrderAction, createManualOrderAction, updateManualOrderAction } from "@/lib/actions/manual-orders";
import { createProductAction, updateProductAction } from "@/lib/actions/manual-products";
import { saveCustomValuesAction } from "@/lib/actions/metadata";
import {
  archiveFieldAction,
  createFieldAction,
  moveFieldAction,
  publishFormAdminAction,
  publishListAdminAction,
  saveFormDraftAdminAction,
  saveListDraftAdminAction,
  saveStatusOverridesAdminAction,
  updateFieldAction,
} from "@/lib/actions/metadata-admin";
import { saveCustomerProfileAction, uploadCustomerFileAction } from "@/lib/actions/metadata-records";
import { createRecordAction, deleteRecordAction, setObjectArchivedAction, updateObjectAction, updateRecordAction, uploadRecordFileAction } from "@/lib/actions/objects";
import { checkOrgAction, createInviteAction, createOrganizationAction, previewSignupAction, retrySetupAction, revokeInviteAction, setSignupModeAction } from "@/lib/actions/onboarding";
import { runPageAction } from "@/lib/actions/page-actions";
import { addPageToMenuAction, archivePageAction, createPageAction, loadBuilderDraftAction, publishBuilderPageAction, publishPageAction, savePageDraftAction, saveBuilderDraftAction, updatePageMetaAction } from "@/lib/actions/page-admin";
import { previewPageBlock } from "@/lib/actions/page-preview";
import { toggleModuleForOrgAction } from "@/lib/actions/platform-modules";
import { confirmPilotUatAction, disableOrgConnectionAction, setOrgSuspendedAction, setPilotStageAction, setWorkflowsPausedAction } from "@/lib/actions/platform-ops";
import { secretsSelfTestAction } from "@/lib/actions/platform-secrets";
import { previewWorkflowRuleAction, runWorkflowsNowAction, saveWorkflowRuleAction, setWorkflowRuleModeAction, setWorkflowRuleStatusAction } from "@/lib/actions/workflow-admin";
import { readOrgBuilderState } from "@/lib/ai-builder/metadata";
import { BLUEPRINT_TOOL_NAME } from "@/lib/ai-builder/prompt";
import { getBuilderAi, setBuilderAiForTests } from "@/lib/ai-builder/provider";
import { createDraft, loadAiBuilderView, loadDraft, previewDraft } from "@/lib/ai-builder/service";
import { COPILOT_ORG_UNAVAILABLE, copilotOrgDenial, runCopilot } from "@/lib/ai/copilot";
import { FakeProvider, setAiProviderForTests, type AiRequest, type AiResponse } from "@/lib/ai/provider";
import { invalidateAiControl, PLATFORM_AI_SWITCH_KEY, readOrgAiControl, setOrgAiControl, setPlatformAiEnabled } from "@/lib/ai-usage/control";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { AI_DISABLED_BY_OPERATOR } from "@/lib/ai-usage/types";
import { loadOperatorOrgAi, loadOrgAiUsage, loadPlatformAiSummary } from "@/lib/ai-usage/view";
import { getTool, TOOL_MODULE_DISABLED } from "@/lib/ai/tools/registry";
import { verifyLogin } from "@/lib/auth/login";
import { requireUser, setRequestPathSourceForTests, signSession, type SessionUser } from "@/lib/auth/session";
import { loadTemplateCatalog, previewTemplate } from "@/lib/blueprints/admin";
import { WHOLESALE_BLUEPRINT } from "@/lib/blueprints/templates/wholesale";
import { getBranding, readLogo, saveBrandingCore, uploadLogoCore } from "@/lib/branding/service";
import { clearMemo } from "@/lib/cache";
import { ORG_BACKUP_STATUS_SUBDIR, ORG_BACKUP_SUMMARY_FILE } from "@/lib/constants/backup";
import { loadConnectionsView, openActiveConnection, saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { env } from "@/lib/env";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { openCustomFile, saveCustomFile, saveCustomValues } from "@/lib/metadata/values";
import { createObject } from "@/lib/objects/objects";
import { createRecord, getRecord, listRecords, reverseRelations } from "@/lib/objects/records";
import { createManualOrderCore, manualOrderFormValues } from "@/lib/records/order-create";
import { createProductCore } from "@/lib/records/product-create";
import { claimInvite, createInvite } from "@/lib/onboarding/invites";
import { hashIp } from "@/lib/onboarding/rate";
import { createOrganizationFromSignup } from "@/lib/onboarding/service";
import { CORE_MODULES, type SignupDraft } from "@/lib/onboarding/shared";
import { invalidateSignupSetting, SIGNUP_MODE_SETTING_KEY } from "@/lib/onboarding/signup-mode";
import { resolveBlock, resolvePage } from "@/lib/pages/data-sources";
import { createPage, getPageBySlug, publishPage, savePageDraft } from "@/lib/pages/registry";
import type { BlockType, KpiData, PageBlock, PageRenderContext, PageSchema, ResolvedBlock } from "@/lib/pages/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { disableOrgConnection, setOrganizationSuspended, setWorkflowsPaused } from "@/lib/platform/kill-switches";
import { invalidateOrgFlags, readOrgFlag, WORKFLOWS_PAUSED_FLAG } from "@/lib/platform/org-flags";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { confirmPilotUat, setPilotStage } from "@/lib/platform/pilot";
import { runSecretsSelfTest } from "@/lib/platform/secrets-self-test";
import { listOrgSupportSummaries, loadOrgSupport } from "@/lib/platform/support";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadPageBuilder, adminLoadBuilderDraft } from "@/lib/platform-ui/page-builder";
import { loadFormEditor, loadListEditor } from "@/lib/platform-ui/metadata-admin";
import { loadPageEditor } from "@/lib/platform-ui/page-admin";
import { loadWorkflowEditor } from "@/lib/platform-ui/workflow-admin";
import { listApprovalRequests } from "@/lib/queries/approvals";
import { getBackupHealth } from "@/lib/queries/backup-status";
import { parseListParams } from "@/lib/search-params";
import { runWorkflows } from "@/lib/workflow/engine";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";

const A = "ta-a";
const B = "ta-b";
/** Mọi chữ của B mang dấu này — thấy nó ở bất kỳ kết quả nào A nhận được là rò. */
const MARK = "TABIMAT7Q";
/** Dấu của dữ liệu TỔ CHỨC NHÀ gieo riêng cho bài này (khách, lời khai sao lưu) — A cũng không được thấy nó. */
const HOME_MARK = "TANHAMAT4K";
/** Khoá / tên / đường dẫn của B (và của mẫu B đã cài) — tóm tắt cấu hình gửi AI của A không được chứa chuỗi nào. */
const B_KEYS = ["x_b_hd", "b_stage", "b_hang", "b_hop_dong", "trang-b", "b_vip", "cong-no-ai-b", "nhac_no_ai_b", "han_muc_cong_no", "tinh_trang_cong_no", "cong-no-khach-hang", "nhac_cong_no_qua_han", "ke_toan_cong_no", "admin@ta-b.local"];
const NOTE = "ta-h1";
const IP_B = "10.91.0.2";
const IP_A = "10.91.0.1";
const A_EMAIL = "admin@ta-a.local";
const A_PW = "TanCong@A2026";
const B_EMAIL = "admin@ta-b.local";
const B_PW = "TanCong@B2026";
const MASTER = "khoa-thu-nghiem-tan-cong-co-lap-0123456789abcdef";
const LARK_B = "https://open.larksuite.com/open-apis/bot/v2/hook/bbbb2222-cccc-3333-dddd-4444eeee5555";
const SIGN_B = `ky-lark-${MARK}-7c6b`;
const AI_KEY_B = `sk-ant-api03-khoa-bia-${MARK}-0123456789abcdef`;
const SECRETS_B = [LARK_B, SIGN_B, "bbbb2222-cccc-3333", AI_KEY_B];
const PNG_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`logo-${MARK}`), Buffer.alloc(64, 7)]);
const PDF_B = Buffer.from(`%PDF-1.4 hop dong ${MARK}`);
/**
 * Dữ liệu NGHIỆP VỤ của B cho mặt pilot readiness: email khách, số tiền đơn tay (chữ số hiếm — dò được trong JSON), mã
 * sản phẩm tay. Trang sức khoẻ mà người vận hành NHÀ mở cho B không được chứa chuỗi nào (chỉ số đếm, mốc, loại).
 */
const EMAIL_KHACH_B = `khach.${MARK}@ta-b.local`;
const TIEN_DON_B = 7_319_007;
const MA_SP_B = "TAB-SP-7Q";
/** Sổ dùng AI: số token HIẾM của từng tổ chức — `/settings/plan` của A chỉ được cộng dòng của A. */
const TOKEN_AI_B = { input: 918_273, output: 564_738 };
const TOKEN_AI_A = { input: 111_222, output: 333_444 };

// ─────────────────────────── dựng / dọn ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [A, B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
  }
  await pdb.delete(schema.platformSignupInvites).where(or(like(schema.platformSignupInvites.note, `${NOTE}%`), inArray(schema.platformSignupInvites.organizationCode, [A, B])));
  await pdb.delete(schema.platformSignupAttempts).where(or(inArray(schema.platformSignupAttempts.organizationCode, [A, B]), inArray(schema.platformSignupAttempts.ipHash, [hashIp(IP_A), hashIp(IP_B)])));
  // Sổ dùng AI + nhật ký nền tảng của hai tổ chức thử (mặt pilot readiness gieo / ghi vào đó).
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [A, B]));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [A, B]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateOrgFlags();
  invalidateAiControl();
}

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

async function signupSettingRow(): Promise<string | null> {
  const pdb = await getPlatformDb();
  const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY) });
  return row ? String(row.value) : null;
}

async function putSignupSetting(mode: string | null) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, SIGNUP_MODE_SETTING_KEY));
  if (mode !== null) await pdb.insert(schema.platformSettings).values({ key: SIGNUP_MODE_SETTING_KEY, value: mode });
  invalidateSignupSetting();
}

/** Mở ĐÚNG một cửa vào của /start: trần môi trường VÀ cài đặt control plane cùng bằng `mode` (hiệu lực = min của hai). */
async function withSignupMode<T>(mode: "invite" | "open", fn: () => Promise<T>): Promise<T> {
  const before = await signupSettingRow();
  return withEnv("PLATFORM_SIGNUP_MODE", mode, async () => {
    try {
      await putSignupSetting(mode);
      return await fn();
    } finally {
      await putSignupSetting(before);
    }
  });
}

async function adminOf(org: string, email: string): Promise<SessionUser> {
  const modules = [...(await getEnabledModules(org))];
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, email) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false }, modules };
  });
}

function block<T extends BlockType>(id: string, type: T, config: PageBlock<T>["config"], span: PageBlock["span"] = 12): PageBlock<T> {
  return { id, type, span, config };
}

const ctxOf = (searchParams: Record<string, string | undefined> = {}): PageRenderContext => ({ searchParams, period: "30d" });

/** Trang `chung` — CÙNG cấu hình ở cả hai tổ chức: KPI đếm là đầu dò của đệm. */
const CHUNG: PageSchema = {
  version: 1,
  sections: [
    {
      key: "so",
      blocks: [
        block("c_dem", "kpi", { aggregate: { objectKey: "x_chung", fn: "count" } }, 4),
        block("c_bang", "table", { source: "x_chung", columns: ["system:title", "custom:trang_thai"], rowLink: true, pageSize: 20, rowActions: [{ action: "open_record", label: "Mở" }] }),
        block("c_kanban", "kanban", { objectKey: "x_chung", statusField: "custom:trang_thai", cardFields: [], allowMove: true }),
      ],
    },
  ],
};

const TRANG_B: PageSchema = {
  version: 1,
  sections: [
    {
      key: "b",
      title: `Trang ${MARK}`,
      blocks: [
        block("b_dem", "kpi", { aggregate: { objectKey: "x_b_hd", fn: "sum", field: "custom:gia_tri" }, label: `Tổng ${MARK}` }, 4),
        block("b_bang", "table", { source: "x_b_hd", columns: ["system:title", "custom:gia_tri", "custom:khach"], rowLink: true, pageSize: 20, rowActions: [{ action: "open_record", label: "Mở" }] }),
        block("b_nut", "button", { action: "open_page", label: `Sang ${MARK}`, input: { slug: "chung" } }, 3),
      ],
    },
  ],
};

function flat(resolved: Awaited<ReturnType<typeof resolvePage>>): Map<string, ResolvedBlock> {
  const out = new Map<string, ResolvedBlock>();
  for (const s of resolved.sections) for (const b of s.blocks) out.set(b.block.id, b);
  return out;
}

function kpiOf(m: Map<string, ResolvedBlock>, id: string): number | null {
  const b = m.get(id);
  assert.ok(b && b.ok, `khối ${id}: ${JSON.stringify(b && !b.ok ? b.issue : null)}`);
  return (b.data as KpiData).value;
}

type Step = (req: AiRequest, round: number) => Omit<AiResponse, "usage" | "model" | "latencyMs">;
function toolCall(input: unknown): Step {
  return () => ({ content: [{ type: "tool_use", id: `call-${Math.random().toString(36).slice(2, 8)}`, name: BLUEPRINT_TOOL_NAME, input: JSON.parse(JSON.stringify(input)) }], stopReason: "tool_use" });
}

/** Gói AI của B: mẫu bán sỉ đổi tên / khoá, mang dấu MARK. */
function aiBodyB(): Record<string, unknown> {
  const bp = JSON.parse(JSON.stringify(WHOLESALE_BLUEPRINT)) as Record<string, unknown>;
  bp.name = `Gói AI ${MARK}`;
  (bp.pages as { slug: string; name: string }[])[0].slug = "cong-no-ai-b";
  (bp.pages as { slug: string; name: string }[])[0].name = `Công nợ ${MARK}`;
  (bp.workflows as { key: string }[])[0].key = "nhac_no_ai_b";
  return bp;
}

/** Model giả của Copilot: lượt 1 gọi đúng các công cụ cho trước, lượt 2 trả lời — mọi kết quả công cụ nằm trong `calls[1]`. */
function copilotModel(uses: { name: string; input: Record<string, unknown> }[]): FakeProvider {
  return new FakeProvider([
    () => ({ content: uses.map((u, i) => ({ type: "tool_use" as const, id: `cp-${i}`, name: u.name, input: u.input })), stopReason: "tool_use" as const }),
    () => ({ content: [{ type: "text" as const, text: "xong" }], stopReason: "end_turn" as const }),
  ]);
}

/**
 * Gói cấu hình A tự gửi lên (tệp khôi phục / đầu ra AI): mẫu bán sỉ đổi khoá — HỢP LỆ — rồi cài đúng MỘT chỗ độc.
 * Gói gốc hợp lệ là đối chứng: lời từ chối của từng biến thể phải là vì CHỖ ĐỘC, không vì gói hỏng sẵn.
 */
type RawBlueprint = { [k: string]: unknown; roles: unknown[]; workflows: unknown[]; pages: unknown[]; forms: unknown[]; fields: unknown[] };
function poisonedBlueprint(poison: (bp: RawBlueprint) => void): string {
  const bp = JSON.parse(JSON.stringify(WHOLESALE_BLUEPRINT)) as RawBlueprint;
  bp.key = "ta-goi-a";
  bp.name = "Gói tự gửi của A";
  poison(bp);
  return JSON.stringify(bp);
}
const pageOf = (slug: string, blocks: unknown[], moduleKey = "customers") => ({ slug, name: `Trang ${slug}`, moduleKey, nav: { enabled: false, label: "", zone: null, order: 100 }, schema: { version: 1, sections: [{ key: "s", blocks }] } });

// ─────────────────────────── ảnh chụp CSDL của B ───────────────────────────

type Snapshot = Map<string, string>;

function rowsOf<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
}

/** Số dòng + băm nội dung của MỌI bảng trong CSDL của tổ chức ngữ cảnh. */
async function snapshotOrgDb(): Promise<Snapshot> {
  const db = await getDb();
  const tables = rowsOf<{ s: string; t: string }>(
    await db.execute(sql`select table_schema as s, table_name as t from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`),
  );
  assert.ok(tables.length > 100, `phải thấy toàn bộ bảng của CSDL tổ chức — mới thấy ${tables.length}`);
  const out: Snapshot = new Map();
  for (const { s, t } of tables) {
    const q = `select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from "${s}"."${t}" x`;
    const [r] = rowsOf<{ n: number; h: string }>(await db.execute(sql.raw(q)));
    out.set(`${s}.${t}`, `${r.n}:${r.h}`);
  }
  return out;
}

/** Các dòng mặt phẳng điều khiển (CSDL nhà) thuộc về B. */
async function snapshotControlPlane(inviteIds: string[]): Promise<Snapshot> {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, B) });
  assert.ok(org);
  const one = async (label: string, q: ReturnType<typeof sql>) => {
    const [r] = rowsOf<{ n: number; h: string }>(await pdb.execute(q));
    return [label, `${r.n}:${r.h}`] as const;
  };
  const ids = sql.join(inviteIds.map((i) => sql`${i}`), sql`, `);
  return new Map([
    await one("platform_organizations", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_organizations x where code = ${B}`),
    await one("platform_organization_modules", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_organization_modules x where organization_id = ${org.id}`),
    await one("platform_flag_overrides", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_flag_overrides x where organization_id = ${org.id}`),
    await one("platform_signup_invites", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_signup_invites x where organization_code = ${B} or id in (${ids})`),
    await one("platform_audit_log", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_audit_log x where target_org_code = ${B}`),
    // Pilot readiness: sổ dùng AI của B, công tắc AI toàn nền tảng, và dòng tổ chức NHÀ (A không được đổi hộ nhà).
    await one("platform_ai_usage", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_ai_usage x where org_code = ${B}`),
    await one("platform_settings[platform.ai.enabled]", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_settings x where key = ${PLATFORM_AI_SWITCH_KEY}`),
    await one("platform_organizations[nhà]", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_organizations x where is_home`),
    await one("platform_flag_overrides[nhà]", sql`select count(*)::int as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h from platform_flag_overrides x where organization_id in (select id from platform_organizations where is_home)`),
  ]);
}

function diff(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).map((k) => `${k}: ${before.get(k) ?? "(không có)"} → ${after.get(k) ?? "(không có)"}`);
}

// ─────────────────────────── một lượt gọi "như request thật" ───────────────────────────

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * Ngoài máy chủ Next, `globalThis.AsyncLocalStorage` không được dựng nên hai kho ngữ cảnh request của Next là bản GIẢ
 * (`getStore()` luôn rỗng, `run()` ném). Gắn tạm một AsyncLocalStorage THẬT của Node vào đúng hai đối tượng ấy (thuộc
 * tính riêng che phương thức của bản giả) để `headers()` / `cookies()` / `revalidatePath()` chạy như trong request;
 * gỡ ra khi xong — ngoài `asRequest`, `getStore()` vẫn rỗng y như trước.
 */
const NEXT_STORES = [workAsyncStorage, workUnitAsyncStorage] as unknown as Record<string, unknown>[];
const ALS_METHODS = ["run", "getStore", "exit", "enterWith", "disable"] as const;
function installRealStores() {
  for (const store of NEXT_STORES) {
    if (store instanceof AsyncLocalStorage || Object.prototype.hasOwnProperty.call(store, "run")) continue;
    const real = new AsyncLocalStorage<unknown>() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ALS_METHODS) store[m] = real[m].bind(real);
  }
}
function removeRealStores() {
  for (const store of NEXT_STORES) if (!(store instanceof AsyncLocalStorage)) for (const m of ALS_METHODS) delete store[m];
}

/**
 * Chạy `fn` như MỘT request của trình duyệt: token phiên + đường dẫn (cổng module) + work store / request store của
 * Next, để `headers()` / `cookies()` / `revalidatePath()` / `redirect()` / `notFound()` chạy đúng như trong ứng dụng.
 */
async function asRequest(token: string | null, reqPath: string, fn: () => Promise<unknown>): Promise<Settled> {
  installRealStores();
  setSessionTokenSourceForTests(async () => token ?? undefined);
  setRequestPathSourceForTests(() => reqPath);
  const workStore = { route: reqPath, page: reqPath, incrementalCache: {}, isStaticGeneration: false, forceStatic: false, dynamicShouldError: false, pendingRevalidatedTags: [] as string[] };
  const requestStore = {
    type: "request",
    phase: "action",
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname: reqPath, search: "" },
    headers: new Headers({ "x-forwarded-for": IP_A, "x-erp-path": reqPath }),
    cookies: new RequestCookies(new Headers()),
    mutableCookies: new ResponseCookies(new Headers()),
    userspaceMutableCookies: new ResponseCookies(new Headers()),
    draftMode: { isEnabled: false },
  };
  try {
    const value = await workAsyncStorage.run(workStore as unknown as Parameters<typeof workAsyncStorage.run>[0], () =>
      workUnitAsyncStorage.run(requestStore as unknown as Parameters<typeof workUnitAsyncStorage.run>[0], fn),
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

function digestOf(e: unknown): string {
  return e && typeof e === "object" && "digest" in e ? String((e as { digest: unknown }).digest) : "";
}

/** Lý do lượt gọi bị từ chối, hoặc `null` nếu nó THÀNH CÔNG. */
function refusal(s: Settled): string | null {
  if (!s.ok) {
    const d = digestOf(s.error);
    if (d.startsWith("NEXT_REDIRECT")) return `chuyển hướng ${d.split(";")[2]}`;
    if (d.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return "404";
    const msg = s.error instanceof Error ? s.error.message : String(s.error);
    // Lỗi của CHÍNH hạ tầng kiểm thử không được tính là "bị chặn" — nó che một lượt có thể đã thành công.
    assert.ok(!/Invariant|outside a request scope|static generation store/i.test(msg), `hạ tầng kiểm thử hỏng: ${msg}`);
    // Lỗi LẬP TRÌNH (ReferenceError, TypeError…) không phải một lời từ chối — nó làm lượt gọi chết trước khi tới cổng.
    assert.ok(!(s.error instanceof ReferenceError || s.error instanceof TypeError || s.error instanceof SyntaxError || s.error instanceof RangeError), `lượt gọi chết vì lỗi lập trình, không phải vì bị chặn: ${msg}`);
    return `ném ${(s.error as Error)?.name ?? "lỗi"}: ${msg.slice(0, 80)}`;
  }
  const v = s.value;
  if (v instanceof Response) return v.status >= 400 ? `HTTP ${v.status}` : null;
  if (v === null || v === undefined) return "rỗng";
  if (Array.isArray(v)) return v.length === 0 ? "rỗng" : null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.error === "string" && o.error) return `lỗi: ${o.error.slice(0, 80)}`;
    // Chạy thử luật: "không khớp" kèm lý do là câu trả lời RỖNG, không phải một lượt chạy.
    if (o.matched === false && Array.isArray(o.wouldDo) && o.wouldDo.length === 0) return `không khớp: ${String(o.reason ?? "").slice(0, 80)}`;
    if (o.ok === false) {
      const why = o.error ?? o.code ?? o.reason ?? (Array.isArray(o.errors) ? (o.errors as { message?: string }[])[0]?.message : undefined) ?? (o.issue as { code?: string } | undefined)?.code;
      return `từ chối: ${String(why ?? "").slice(0, 80)}`;
    }
  }
  return null;
}

/** JSON an toàn cho mọi thứ (bigint, Buffer, vòng tham chiếu, hàm, JSX) — để dò rò. */
function serialize(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) => {
        if (typeof x === "bigint") return x.toString();
        if (typeof x === "function" || typeof x === "symbol") return undefined;
        if (x && typeof x === "object") {
          if (seen.has(x)) return undefined;
          seen.add(x);
          if (Buffer.isBuffer(x)) return x.toString("latin1");
          if (x instanceof Uint8Array) return Buffer.from(x).toString("latin1");
          if (x instanceof Map) return Object.fromEntries(x);
          if (x instanceof Set) return [...x];
        }
        return x;
      }) ?? ""
    );
  } catch {
    return String(v);
  }
}

async function payloadOf(s: Settled): Promise<string> {
  if (s.ok && s.value instanceof Response) {
    const buf = Buffer.from(await s.value.clone().arrayBuffer());
    return `${s.value.status} ${buf.toString("latin1")}`;
  }
  if (!s.ok) return `${(s.error as Error)?.message ?? ""} ${digestOf(s.error)}`;
  return serialize(s.value);
}

type Attempt = { loai: string; mat: string; ket: string };
const log: Attempt[] = [];

type AttackOpts = {
  token?: string | null;
  path?: string;
  /** Cửa không nhận đích (chạy luật của tổ chức mình, xem trước mẫu): được phép thành công, nhưng phải CHỈ chạm A. */
  ownOnly?: (value: unknown) => void;
};

let TOKEN_A = "";

async function attack(loai: string, mat: string, fn: () => Promise<unknown>, opts: AttackOpts = {}) {
  const s = await asRequest(opts.token === undefined ? TOKEN_A : opts.token, opts.path ?? "/", fn);
  const text = await payloadOf(s);
  for (const secret of [MARK, ...SECRETS_B]) assert.ok(!text.includes(secret), `${loai} · ${mat}: kết quả mang dữ liệu của B («${secret}»): ${text.slice(0, 400)}`);
  const why = refusal(s);
  if (opts.ownOnly) {
    if (why === null) opts.ownOnly(s.ok ? s.value : undefined);
    log.push({ loai, mat, ket: why ?? "chỉ chạm A" });
    return s;
  }
  assert.ok(why !== null, `${loai} · ${mat}: lượt gọi bằng dữ liệu của B phải bị từ chối — nhận ${text.slice(0, 400)}`);
  log.push({ loai, mat, ket: why });
  return s;
}

function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

// ─────────────────────────── bài kiểm ───────────────────────────

export async function testTenantAttack() {
  const realFetch = globalThis.fetch;
  // tsx biên dịch JSX của page component theo kiểu cổ điển (`React.createElement`) — Next thì tự chèn; ở đây gắn tạm.
  const g = globalThis as { React?: unknown };
  const hadReact = "React" in g;
  g.React ??= ReactNs;
  const netCalls: string[] = [];
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  let backupDir: string | null = null;
  process.env.PLATFORM_SECRETS_KEY = MASTER;
  await cleanup();
  for (const code of [A, B]) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  clearMemo();

  try {
    // ══════════ B: dựng qua /start bằng MÃ MỜI (blueprint bán sỉ đã cài + trạng thái dựng + mã mời đã gắn) ══════════
    const inviteB = await createInvite({ actor: null, note: `${NOTE} mã mời của B` });
    const spareInvite = await createInvite({ actor: null, note: `${NOTE} mã mời chưa dùng` });
    const planModules = [...WHOLESALE_BLUEPRINT.modules.filter((m) => m !== "purchasing" && !CORE_MODULES.includes(m)), "apps", "alerts"];
    const draftB: SignupDraft = {
      invite: inviteB.code,
      org: { name: `Tổ chức ${MARK}`, code: B },
      admin: { name: `QT ${MARK}`, email: B_EMAIL, password: B_PW },
      plan: { businessType: "wholesale", templateKey: "wholesale", modules: planModules },
      planKey: null,
    };
    const madeB = await withSignupMode("invite", () => createOrganizationFromSignup(draftB, { kind: "public", ip: IP_B }, { issue: async () => undefined }));
    assert.ok("ok" in madeB && madeB.created, `B dựng qua /start: ${JSON.stringify(madeB)}`);

    // ══════════ A: cấp thẳng, KHÔNG có Kho / Tài chính (để đòn đệm năng lực thấy được) ══════════
    await provisionOrganization({ code: A, name: "Tổ chức A", modules: ["customers", "products", "orders", "alerts", "apps"], admin: { email: A_EMAIL, name: "QT A", password: A_PW }, source: "TEST", actor: null });

    const qtA = await adminOf(A, A_EMAIL);
    const qtB = await adminOf(B, B_EMAIL);
    assert.ok(qtB.modules?.includes("finance") && !qtA.modules?.includes("finance"), `tiền đề: B có Tài chính, A không — A ${qtA.modules} · B ${qtB.modules}`);
    const actorA: MetadataActor = { id: qtA.id, email: qtA.email };
    const actorB: MetadataActor = { id: qtB.id, email: qtB.email };
    const idB: Record<string, string> = {};

    // ══════════ B có ĐỦ mọi loại dữ liệu ══════════
    const wholesalePlanB = await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "ta-b-cus1", name: `Khách ${MARK}` });
      const field = async (objectKey: string, input: Record<string, unknown>) => {
        const r = await createCustomField(objectKey, input, actorB);
        assert.ok(r.ok, `B · ${objectKey}.${String(input.key)}: ${JSON.stringify(r)}`);
      };
      // Field tuỳ biến + tệp trên khách.
      await field("customer", { key: "b_hang", label: `Hạng ${MARK}`, type: "text" });
      await field("customer", { key: "b_stage", label: "Giai đoạn", type: "status", options: [{ value: "lead", label: "Tiềm năng" }, { value: "vip", label: "VIP" }] });
      await field("customer", { key: "b_hop_dong", label: "Hợp đồng", type: "file" });
      assert.ok((await saveCustomValues("customer", "ta-b-cus1", { b_hang: `Vàng ${MARK}` }, qtB)).ok);
      const f1 = await saveCustomFile("customer", "ta-b-cus1", "b_hop_dong", { filename: `hd-${MARK}.pdf`, mime: "application/pdf", data: PDF_B }, qtB);
      assert.ok(f1.ok, JSON.stringify(f1));
      idB.customerFile = f1.file.id;

      // Đối tượng tuỳ biến + quan hệ + tệp; và `x_chung` — CÙNG khoá với A.
      for (const [key, label] of [
        ["x_b_hd", `Hợp đồng ${MARK}`],
        ["x_chung", `Chung ${MARK}`],
      ] as const) {
        const r = await createObject(qtB, { key, label, labelPlural: label, icon: "file-text" });
        assert.ok(r.ok, JSON.stringify(r));
      }
      await field("x_b_hd", { key: "gia_tri", label: "Giá trị", type: "currency" });
      await field("x_b_hd", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" });
      await field("x_b_hd", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "nhap", label: "Nháp" }, { value: "xong", label: "Xong" }] });
      await field("x_b_hd", { key: "tai_lieu", label: "Tài liệu", type: "file" });
      await field("x_chung", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }], transitions: { moi: ["xong"] } });
      const rec = await createRecord("x_b_hd", { system: { title: `HĐ ${MARK}` }, custom: { gia_tri: 7_000_000, khach: "ta-b-cus1", trang_thai: "nhap" } }, qtB);
      assert.ok(rec.ok, JSON.stringify(rec));
      idB.record = rec.id;
      const f2 = await saveCustomFile("x_b_hd", rec.id, "tai_lieu", { filename: `tl-${MARK}.pdf`, mime: "application/pdf", data: PDF_B }, qtB);
      assert.ok(f2.ok, JSON.stringify(f2));
      idB.recordFile = f2.file.id;
      for (let i = 1; i <= 3; i++) {
        const r = await createRecord("x_chung", { system: { title: `Việc ${i} ${MARK}` }, custom: { trang_thai: "moi" } }, qtB);
        assert.ok(r.ok, JSON.stringify(r));
        if (i === 1) idB.chung = r.id;
      }

      // Trang đã xuất bản: `trang-b` (riêng B) + `chung` (cùng slug, cùng cấu hình với A).
      for (const [slug, name, s] of [
        ["trang-b", `Trang ${MARK}`, TRANG_B],
        ["chung", `Chung ${MARK}`, CHUNG],
      ] as const) {
        const p = await createPage({ slug, name, moduleKey: "apps", nav: { enabled: true } }, actorB);
        assert.ok(p.ok, JSON.stringify(p));
        assert.ok((await savePageDraft(p.page.id, s, actorB)).ok);
        assert.ok((await publishPage(p.page.id, actorB)).ok);
        if (slug === "trang-b") idB.page = p.page.id;
      }

      // Luật + lượt chạy + lời duyệt đang chờ.
      const rule = await saveRule(
        { key: "b_vip", name: `Luật ${MARK}`, trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "b_stage", to: ["vip"] }, conditions: null, actions: [{ kind: "notify", message: `Tin ${MARK}` }], gate: { kind: "approval", reason: `Duyệt ${MARK}` } },
        actorB,
      );
      assert.ok(rule.ok, JSON.stringify(rule));
      idB.rule = rule.rule.id;
      assert.ok((await setRuleStatus(rule.rule.id, "ACTIVE", actorB)).ok);
      assert.ok((await setRuleMode(rule.rule.id, "LIVE", actorB)).ok);
      assert.ok((await saveCustomValues("customer", "ta-b-cus1", { b_stage: "vip" }, qtB)).ok);
      const run = await runWorkflows();
      assert.equal(run.waiting, 1, `B: một lượt chờ duyệt — ${JSON.stringify(run)}`);
      const [req] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.group, "WORKFLOW"), eq(schema.approvalRequests.status, "PENDING")));
      assert.ok(req, "B: lời duyệt đang chờ");
      idB.approval = req.id;

      // Bản nháp AI (provider giả, không mạng).
      setBuilderAiForTests({ provider: new FakeProvider([toolCall(aiBodyB())]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      const d = await createDraft(qtB, { mode: "new", prompt: `Công ty bán buôn ${MARK} cần CRM, đơn và kho.` });
      assert.ok(d.ok && d.value.valid, JSON.stringify(d));
      idB.aiDraft = d.value.id;
      const dp = await previewDraft(qtB, d.value.id);
      assert.ok(dp.ok, JSON.stringify(dp));
      idB.aiPlanHash = dp.value.plan.planHash;
      setBuilderAiForTests(undefined);

      // Copilot của tổ chức khác nhà TẮT ở cổng: kể cả khi có model (giả), không gọi model, không ghi `ai_interactions`.
      const bModel = new FakeProvider([() => ({ content: [{ type: "text", text: `Trả lời ${MARK}` }], stopReason: "end_turn" })]);
      setAiProviderForTests(bModel);
      try {
        const asked = await runCopilot({ user: qtB, message: `Khách ${MARK} còn nợ bao nhiêu?`, context: { route: "/customers", entityType: "customer", entityId: "ta-b-cus1" } });
        assert.equal(asked.status, "DISABLED", `B (tổ chức khác nhà): Copilot tắt — ${JSON.stringify(asked)}`);
        assert.equal(asked.error, COPILOT_ORG_UNAVAILABLE);
        assert.equal(asked.interactionId, null);
        assert.equal(bModel.calls.length, 0, "không gọi model");
        assert.equal((await db.select().from(schema.aiInteractions)).length, 0, "B: không một dòng ai_interactions nào");
      } finally {
        setAiProviderForTests(undefined);
      }
      // Một dòng lượt hỏi CŨ của B (ghi trước bản vá này) — A sẽ thử xác nhận hành động của lượt ấy bằng id.
      const [cu] = await db.insert(schema.aiInteractions).values({ userId: qtB.id, userEmail: qtB.email, provider: "fake", model: "fake-model", prompt: `Khách ${MARK}`, answer: `Trả lời ${MARK}`, status: "OK" }).returning({ id: schema.aiInteractions.id });
      idB.copilot = cu.id;

      // Kết nối có bí mật, đã kiểm tra (fetch giả) và BẬT.
      const larkOk = async () => new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      assert.ok("ok" in (await saveConnection(qtB, { connectorKey: "lark-webhook", settings: {}, secrets: { webhookUrl: LARK_B, signSecret: SIGN_B } })));
      assert.ok("ok" in (await testOrgConnection(qtB, "lark-webhook", { tester: { fetch: larkOk } })));
      assert.ok("ok" in (await setConnectionStatus(qtB, "lark-webhook", "ACTIVE")));
      // Khoá AI của chính B (BYOK) — kết nối DUY NHẤT có luồng đọc bí mật lúc chạy (AI Builder).
      const probe = async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      assert.ok("ok" in (await saveConnection(qtB, { connectorKey: "anthropic-byok", settings: {}, secrets: { apiKey: AI_KEY_B } })));
      assert.ok("ok" in (await testOrgConnection(qtB, "anthropic-byok", { tester: { fetch: probe } })));
      assert.ok("ok" in (await setConnectionStatus(qtB, "anthropic-byok", "ACTIVE")));
      const own = await openActiveConnection("anthropic-byok");
      assert.ok(own.ok && own.secrets.apiKey === AI_KEY_B, `B mở được khoá AI của chính mình: ${JSON.stringify(own.ok ? "ok" : own.reason)}`);

      // Thương hiệu + logo.
      assert.ok("ok" in (await saveBrandingCore(qtB, { displayName: `Thương hiệu ${MARK}`, accent: null })));
      const logo = await uploadLogoCore(qtB, { data: PNG_B });
      assert.ok("ok" in logo, JSON.stringify(logo));
      idB.logoFile = logo.branding.logoFileId ?? "";

      // Pilot readiness (B1 · B2 · A3): sản phẩm TẠO TAY + đơn TẠO TAY qua ĐÚNG lõi của action, email khách, sổ dùng AI.
      await db.update(schema.customers).set({ emails: [EMAIL_KHACH_B] }).where(eq(schema.customers.id, "ta-b-cus1"));
      const sp = await createProductCore(qtB, { name: `Áo ${MARK}`, code: MA_SP_B, unit: "cái", retailPrice: 250_000, cost: null, variants: [{ sku: `${MA_SP_B}-M`, size: "M", color: "Đỏ", selling: true }] });
      assert.ok(sp.ok, `B tạo sản phẩm tay: ${JSON.stringify(sp)}`);
      idB.product = sp.id;
      const [vB] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, sp.id));
      idB.variant = vB.id;
      const don = await createManualOrderCore(qtB, { customerId: "ta-b-cus1", stage: "NEW", lines: [{ variantId: vB.id, quantity: 1, unitPrice: TIEN_DON_B }], note: `Ghi chú ${MARK}`, channel: "Zalo" });
      assert.ok(don.ok, `B tạo đơn tay: ${JSON.stringify(don)}`);
      idB.order = don.id;
      await recordAiUsage({ orgCode: B, feature: "ai_builder", source: "BYOK", provider: "fake", model: "fake-model-b", requests: 3, inputTokens: TOKEN_AI_B.input, outputTokens: TOKEN_AI_B.output, costUsd: 0.4242, status: "OK", actorId: qtB.id, ref: idB.aiDraft });

      // Kế hoạch mẫu bán sỉ của B (đã cài ⇒ mọi mục UNCHANGED) — A sẽ thử cài bằng đúng planHash này.
      const pv = await previewTemplate(qtB, "wholesale");
      assert.ok(pv.ok && pv.value.plan.installedVersion, "B đã cài mẫu bán sỉ qua /start");
      return pv.value.plan.planHash;
    });
    // Mã mời thứ hai GẮN cho B (khách được cấp hai mã, dùng một) — A sẽ thử dùng lại.
    assert.ok(await claimInvite(spareInvite.id, B));
    const freeInvite = await createInvite({ actor: null, note: `${NOTE} mã mời còn trống` });
    const inviteIds = [inviteB.id, spareInvite.id, freeInvite.id];

    // ══════════ A: dữ liệu CỦA MÌNH cho các đòn cùng khoá ══════════
    const editorsA = await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "ta-a-cus1", name: "Khách A1" });
      assert.ok((await createObject(qtA, { key: "x_chung", label: "Chung A", labelPlural: "Chung A", icon: "file-text" })).ok);
      assert.ok((await createCustomField("x_chung", { key: "trang_thai", label: "Trạng thái", type: "status", options: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }], transitions: { moi: ["xong"] } }, actorA)).ok);
      assert.ok((await createCustomField("x_chung", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" }, actorA)).ok);
      assert.ok((await createCustomField("x_chung", { key: "tep", label: "Tệp", type: "file" }, actorA)).ok);
      assert.ok((await createRecord("x_chung", { system: { title: "Việc của A" }, custom: { trang_thai: "moi" } }, qtA)).ok);
      const p = await createPage({ slug: "chung", name: "Chung A", moduleKey: "apps", nav: { enabled: true } }, actorA);
      assert.ok(p.ok, JSON.stringify(p));
      assert.ok((await savePageDraft(p.page.id, CHUNG, actorA)).ok);
      assert.ok((await publishPage(p.page.id, actorA)).ok);
      idB.pageA = p.page.id;
      // Sản phẩm tay CỦA A (đòn "cài mẫu mã của B vào sản phẩm của mình") + một dòng sổ AI của A.
      const spA = await createProductCore(qtA, { name: "Áo của A", code: "TA-A-SP", unit: "cái", retailPrice: 100_000, cost: null, variants: [{ sku: "TA-A-SP-M", size: "M", color: "Xanh", selling: true }] });
      assert.ok(spA.ok, `A tạo sản phẩm tay: ${JSON.stringify(spA)}`);
      idB.productA = spA.id;
      idB.variantA = (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, spA.id)))[0].id;
      await recordAiUsage({ orgCode: A, feature: "ai_builder", source: "BYOK", provider: "fake", model: "fake-model-a", requests: 1, inputTokens: TOKEN_AI_A.input, outputTokens: TOKEN_AI_A.output, costUsd: 0.01, status: "OK", actorId: qtA.id, ref: null });
      // Bản nháp form / danh sách THẬT của A — đòn thao túng metadata chỉ cài đúng một tham chiếu độc vào đó.
      const f = await loadFormEditor(qtA, "customer", "profile");
      const l = await loadListEditor(qtA, "customer", "default");
      assert.ok(f.ok && l.ok, "A mở được trình soạn form / danh sách khách của mình");
      return { form: f.value.draft, list: l.value.draft };
    });
    // Dữ liệu của TỔ CHỨC NHÀ mang dấu riêng — Copilot của A không được đọc tới nó (dọn ở finally).
    await (await getDb()).insert(schema.customers).values({ id: "ta-home-cus1", name: `Khách nhà ${HOME_MARK}` }).onConflictDoNothing();
    assert.ok(serialize(await (await getDb()).select().from(schema.customers).where(eq(schema.customers.id, "ta-home-cus1"))).includes(HOME_MARK), "tiền đề: khách mang dấu nằm ở CSDL NHÀ");

    TOKEN_A = await signSession({ id: qtA.id, email: qtA.email, name: "QT A", role: "ADMIN", orgCode: A });
    const now = Math.floor(Date.now() / 1000);
    const FORGED = await new SignJWT({ email: B_EMAIL, name: "QT B", role: "ADMIN", org: B, lgn: now })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(qtB.id)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(`khoa-gia-cua-ke-tan-cong-${"x".repeat(40)}`));
    assert.notEqual(env.authSecret, `khoa-gia-cua-ke-tan-cong-${"x".repeat(40)}`);

    // ══════════ ẢNH CHỤP TRƯỚC ══════════
    const before = await withOrganization(B, snapshotOrgDb);
    const cpBefore = await snapshotControlPlane(inviteIds);

    // Không một request mạng nào được rời máy trong lúc tấn công.
    globalThis.fetch = (async (input: string | URL | Request) => {
      netCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("chặn trong bài kiểm", { status: 599 });
    }) as typeof fetch;

    // ══════════ ĐÒN 0 · TRẠNG THÁI TIẾN TRÌNH: đệm, đệm năng lực ══════════
    clearMemo();
    const pubB = await withOrganization(B, () => getPageBySlug("chung"));
    assert.ok(pubB);
    const seenB = await withOrganization(B, async () => kpiOf(flat(await resolvePage(pubB.schema, qtB, ctxOf(), "chung")), "c_dem"));
    assert.equal(seenB, 3, "tiền đề: B đếm 3 việc của mình (đệm đã ấm)");
    const pageA = await attack("Đệm", "dựng /p/chung cùng cấu hình ngay sau B (khoá memo)", async () => {
      const pub = await getPageBySlug("chung");
      assert.ok(pub && pub.page.name === "Chung A", "slug `chung` mở trang của A");
      return kpiOf(flat(await resolvePage(pub.schema, qtA, ctxOf(), "chung")), "c_dem");
    }, { path: "/p/chung", ownOnly: () => undefined });
    assert.ok(pageA.ok && pageA.value === 1, `ĐỆM RÒ: A dựng trang cùng cấu hình ngay sau B phải ra số của A (1), nhận ${pageA.ok ? String(pageA.value) : "lỗi"}`);

    await getEnabledModules(B); // đệm năng lực của B vừa được đọc
    const sessA = await attack("Đệm năng lực", "phiên A ngay sau khi module của B được đọc", () => requireUser(), { ownOnly: () => undefined });
    assert.ok(sessA.ok, "phiên A hợp lệ");
    const modsA = (sessA.value as SessionUser).modules ?? [];
    assert.ok(!modsA.includes("finance") && !modsA.includes("inventory"), `ĐỆM NĂNG LỰC RÒ: phiên A mang module của B — ${modsA.join(", ")}`);

    /** Lượt gọi phải bị từ chối VÌ đúng lý do (khớp câu), không chỉ «có lỗi». */
    const tuChoiVi = async (loai: string, mat: string, fn: () => Promise<unknown>, why: RegExp, reqPath = "/") => {
      const s = await attack(loai, mat, fn, { path: reqPath });
      const text = await payloadOf(s);
      assert.match(text, why, `${loai} · ${mat}: bị từ chối nhưng không vì lý do mong đợi — ${text.slice(0, 300)}`);
      return s;
    };

    // ══════════ ĐÒN 0b · SỔ DÙNG AI (pilot readiness A3) — `/settings/plan` lấy mã tổ chức từ PHIÊN ══════════
    // Sổ `platform_ai_usage` nằm ở CSDL NHÀ (mặt phẳng điều khiển) — silo không che nó; chỉ bộ lọc `org_code` của máy chủ
    // tách sổ của A khỏi sổ của B. B có một dòng mang số token HIẾM; màn của A chỉ được cộng đúng các dòng của A.
    const Q = "Sổ dùng AI";
    const soCuaA = async () => {
      const [r] = rowsOf<{ n: number; i: string }>(await (await getPlatformDb()).execute(sql`select count(*)::int as n, coalesce(sum(input_tokens), 0)::text as i from platform_ai_usage where org_code = ${A} and status <> 'BLOCKED_QUOTA'`));
      return { turns: Number(r.n), input: Number(r.i) };
    };
    const khongSoCuaB = (v: unknown) => {
      const text = serialize(v);
      assert.ok(!text.includes(String(TOKEN_AI_B.input)) && !text.includes(String(TOKEN_AI_B.output)) && !text.includes("fake-model-b"), `sổ AI của B lọt sang A: ${text.slice(0, 300)}`);
    };
    await attack(Q, "/settings/plan (page component) — sổ AI của CHÍNH A, không dòng của B", () => PlanPage(), {
      path: "/settings/plan",
      ownOnly: (v) => {
        khongSoCuaB(v);
        // 07/10/2026: sổ AI (token · tiền) là số NỘI BỘ — workspace khách không thấy cả dòng của CHÍNH mình (lib/saas/visibility.ts).
        // Đối chứng cách ly sổ AI nằm ở lượt gọi loadOrgAiUsage ngay dưới.
        assert.ok(!serialize(v).includes(String(TOKEN_AI_A.input)), "khách không thấy token trên màn Gói & hạn mức");
      },
    });
    const PlanPageVoiThamSo = PlanPage as unknown as (p: unknown) => Promise<unknown>;
    await attack(Q, "/settings/plan?org=ta-b — tham số URL không đổi được tổ chức", () => PlanPageVoiThamSo({ params: Promise.resolve({ org: B }), searchParams: Promise.resolve({ org: B, orgCode: B }) }), {
      path: "/settings/plan",
      ownOnly: (v) => {
        khongSoCuaB(v);
        assert.ok(!serialize(v).includes(String(TOKEN_AI_A.input)), "tham số URL không mở lại sổ AI cho khách");
      },
    });
    const soA = await attack(Q, "loadOrgAiUsage(mã tổ chức của PHIÊN A)", async () => loadOrgAiUsage((await requireUser()).organization!.code), { path: "/settings/plan", ownOnly: khongSoCuaB });
    const thangA = (soA.ok ? (soA.value as { month: { turns: number; inputTokens: number }[] }).month : []) ?? [];
    const soThat = await soCuaA();
    assert.equal(thangA.reduce((n, r) => n + r.turns, 0), soThat.turns, "số lượt AI tháng của A = đúng số dòng sổ mang mã A");
    assert.equal(thangA.reduce((n, r) => n + r.inputTokens, 0), soThat.input, "token vào tháng của A = đúng tổng sổ mang mã A");
    await tuChoiVi(Q, "màn AI của người vận hành cho B (loadOperatorOrgAi)", () => loadOperatorOrgAi(qtA, B), /Chỉ người của tổ chức nhà/);
    await tuChoiVi(Q, "tổng hợp AI toàn nền tảng (loadPlatformAiSummary)", () => loadPlatformAiSummary(qtA), /Chỉ người của tổ chức nhà/);

    // ══════════ ĐÒN 1 · FIELD / GIÁ TRỊ / TỆP (Phase 2–3) ══════════
    const M = "Field & giá trị";
    await attack(M, "ghi giá trị field lên khách của B", () => saveCustomValuesAction({ objectKey: "customer", recordId: "ta-b-cus1", values: { b_hang: "chiếm" } }), { path: "/customers" });
    await attack(M, "tạo field trên đối tượng của B", () => createFieldAction("x_b_hd", { key: "chen", label: "Chèn", type: "text" }), { path: "/settings/data-model" });
    await attack(M, "sửa field của B", () => updateFieldAction("customer", "b_hang", { label: "Đổi" }), { path: "/settings/data-model" });
    await attack(M, "lưu trữ field của B", () => archiveFieldAction("x_b_hd", "gia_tri"), { path: "/settings/data-model" });
    await attack(M, "đổi thứ tự field của B", () => moveFieldAction("customer", "b_stage", 1), { path: "/settings/data-model" });
    await attack(M, "lưu nháp form của đối tượng B", () => saveFormDraftAdminAction("x_b_hd", "create", { sections: [] }), { path: "/settings/forms" });
    await attack(M, "xuất bản form của đối tượng B", () => publishFormAdminAction("x_b_hd", "create"), { path: "/settings/forms" });
    await attack(M, "lưu nháp danh sách của đối tượng B", () => saveListDraftAdminAction("x_b_hd", "default", { columns: [] }), { path: "/settings/lists" });
    await attack(M, "xuất bản danh sách của đối tượng B", () => publishListAdminAction("x_b_hd", "default"), { path: "/settings/lists" });
    await attack(M, "sửa nhãn trạng thái của B", () => saveStatusOverridesAdminAction("x_b_hd", "trang_thai", [{ value: "nhap", label: "Chiếm" }]), { path: "/settings/statuses" });
    await attack(M, "tải tệp lên field tệp của khách B", () => uploadCustomerFileAction(form({ recordId: "ta-b-cus1", field: "b_hop_dong", file: new File([PDF_B], "x.pdf", { type: "application/pdf" }) })), { path: "/customers" });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<tệp khách của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.customerFile}`), { params: Promise.resolve({ id: idB.customerFile }) }), { path: `/api/metadata/files/${idB.customerFile}` });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<tệp bản ghi của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.recordFile}`), { params: Promise.resolve({ id: idB.recordFile }) }), { path: `/api/metadata/files/${idB.recordFile}` });
    await attack("Tệp tuỳ biến", "GET /api/metadata/files/<id tệp logo của B>", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.logoFile}`), { params: Promise.resolve({ id: idB.logoFile }) }), { path: `/api/metadata/files/${idB.logoFile}` });
    await attack("Tệp tuỳ biến", "openCustomFile(id tệp của B)", () => openCustomFile(idB.customerFile, qtA));
    const xuat = await attack("Tệp tuỳ biến", "GET /api/metadata/blueprint-export — gói của A, không khoá nào của B", () => blueprintExportGET(), { path: "/api/metadata/blueprint-export", ownOnly: () => undefined });
    assert.ok(xuat.ok && xuat.value instanceof Response && xuat.value.status === 200, "A tải được gói cấu hình của CHÍNH mình");
    const goiA = await (xuat.value as Response).clone().text();
    const roGoi = B_KEYS.filter((k) => goiA.includes(k));
    assert.ok(goiA.includes("x_chung") && roGoi.length === 0, `gói xuất của A: có đối tượng của A, không khoá nào của B — lọt: ${roGoi.join(", ")}`);

    // ══════════ ĐÒN 2 · ĐỐI TƯỢNG TUỲ BIẾN + BẢN GHI + QUAN HỆ (Phase 6) ══════════
    const O = "Đối tượng & bản ghi";
    await attack(O, "sửa định nghĩa đối tượng của B", () => updateObjectAction("x_b_hd", { label: "Chiếm" }), { path: "/settings/objects" });
    await attack(O, "lưu trữ đối tượng của B", () => setObjectArchivedAction("x_b_hd", true), { path: "/settings/objects" });
    await attack(O, "tạo bản ghi trong đối tượng của B", () => createRecordAction("x_b_hd", { system: { title: "chen" }, custom: {} }), { path: "/o/x_b_hd" });
    await attack(O, "sửa bản ghi của B", () => updateRecordAction("x_b_hd", idB.record, { system: { title: "đổi" }, custom: { gia_tri: 1 } }), { path: "/o/x_b_hd" });
    await attack(O, "sửa bản ghi của B qua khoá đối tượng TRÙNG (x_chung)", () => updateRecordAction("x_chung", idB.chung, { system: { title: "đổi" }, custom: {} }), { path: "/o/x_chung" });
    await attack(O, "xoá bản ghi của B", () => deleteRecordAction("x_b_hd", idB.record), { path: "/o/x_b_hd" });
    await attack(O, "xoá bản ghi của B qua khoá TRÙNG", () => deleteRecordAction("x_chung", idB.chung), { path: "/o/x_chung" });
    await attack(O, "tải tệp lên bản ghi của B", () => uploadRecordFileAction(form({ objectKey: "x_chung", recordId: idB.chung, field: "tep", file: new File([PDF_B], "x.pdf", { type: "application/pdf" }) })), { path: "/o/x_chung" });
    await attack(O, "tạo bản ghi A trỏ quan hệ tới khách của B", () => createRecordAction("x_chung", { system: { title: "Trỏ B" }, custom: { khach: "ta-b-cus1" } }), { path: "/o/x_chung" });
    await attack(O, "getRecord(x_chung, id của B)", () => getRecord("x_chung", idB.chung, qtA));
    await attack(O, "listRecords(x_b_hd)", () => listRecords("x_b_hd", parseListParams({}, { defaultSort: "" }), qtA));
    await attack(O, "reverseRelations(khách của B)", () => reverseRelations("customer", "ta-b-cus1", qtA));
    await attack(O, "listRecords(x_chung) — chỉ bản ghi của A", () => listRecords("x_chung", parseListParams({}, { defaultSort: "" }), qtA), {
      ownOnly: (v) => assert.equal((v as { total: number }).total, 1, "khoá trùng: A chỉ thấy MỘT bản ghi của mình"),
    });
    await attack(O, "mở /o/x_chung/<id của B> (page component)", async () => {
      const el = await ObjectRecordPage({ params: Promise.resolve({ object: "x_chung", id: idB.chung }) });
      assert.ok(/"ok":false|NOT_FOUND/.test(serialize(el)), "trang chi tiết phải là thông báo từ chối");
      return { ok: false, error: "GateMessage" };
    }, { path: `/o/x_chung/${idB.chung}` });
    await attack(O, "mở /o/x_b_hd (page component)", async () => {
      const el = await ObjectRecordsPage({ params: Promise.resolve({ object: "x_b_hd" }), searchParams: Promise.resolve({}) });
      assert.ok(/"ok":false|NOT_FOUND/.test(serialize(el)), "trang danh sách phải là thông báo từ chối");
      return { ok: false, error: "GateMessage" };
    }, { path: "/o/x_b_hd" });

    // ══════════ ĐÒN 3 · TRANG ĐỘNG + TRÌNH DỰNG (Phase 4–5) ══════════
    const P = "Trang động";
    await attack(P, "getPageBySlug(trang-b)", () => getPageBySlug("trang-b"));
    await attack(P, "mở /p/trang-b (page component)", () => DynamicPage({ params: Promise.resolve({ slug: "trang-b" }), searchParams: Promise.resolve({}) }), { path: "/p/trang-b" });
    await attack(P, "mở /p/cong-no-khach-hang (trang của mẫu B đã cài)", () => DynamicPage({ params: Promise.resolve({ slug: "cong-no-khach-hang" }), searchParams: Promise.resolve({}) }), { path: "/p/cong-no-khach-hang" });
    await attack(P, "runPageAction(trang-b, nút của B)", () => runPageAction("trang-b", "b_nut", {}), { path: "/p/trang-b" });
    await attack(P, "runPageAction(trang-b, hành động dòng trên bản ghi B)", () => runPageAction("trang-b", "b_bang", {}, { recordId: idB.record, actionIndex: 0 }), { path: "/p/trang-b" });
    await attack(P, "runPageAction(chung, kéo thẻ kanban = bản ghi B)", () => runPageAction("chung", "c_kanban", { recordId: idB.chung, value: "xong" }), { path: "/p/chung" });
    await attack(P, "runPageAction(chung, mở dòng = bản ghi B)", () => runPageAction("chung", "c_bang", {}, { recordId: idB.chung, actionIndex: 0 }), { path: "/p/chung" });
    await attack(P, "previewPageBlock(trang của B)", () => previewPageBlock(idB.page, block("x", "kpi", { aggregate: { objectKey: "x_chung", fn: "count" } })), { path: "/settings/pages" });
    await attack(P, "previewPageBlock(trang A, khối đọc đối tượng của B)", () => previewPageBlock(idB.pageA, block("x", "table", { source: "x_b_hd" })), { path: "/settings/pages" });
    await attack(P, "resolveBlock(bảng x_b_hd)", () => resolveBlock(block("x", "table", { source: "x_b_hd" }), qtA, ctxOf()));
    await attack(P, "resolveBlock(KPI tổng x_b_hd)", () => resolveBlock(block("x", "kpi", { aggregate: { objectKey: "x_b_hd", fn: "sum", field: "custom:gia_tri" } }), qtA, ctxOf()));
    await attack(P, "resolveBlock(form sửa khách, ?id=khách của B)", () => resolveBlock(block("x", "form", { objectKey: "customer", formKey: "profile", mode: "edit", recordParam: "id" }), qtA, ctxOf({ id: "ta-b-cus1" })));
    await attack(P, "resolveBlock(dòng thời gian bản ghi x_chung của B)", () => resolveBlock(block("x", "timeline", { source: "custom_record_x_chung", recordParam: "id" }), qtA, ctxOf({ id: idB.chung })));
    await attack(P, "sửa thông tin trang của B", () => updatePageMetaAction(idB.page, { slug: "trang-b", name: "Chiếm", moduleKey: "apps", requiredPermission: null, nav: { enabled: true } }), { path: "/settings/pages" });
    await attack(P, "lưu nháp trang của B", () => savePageDraftAction(idB.page, CHUNG), { path: "/settings/pages" });
    await attack(P, "xuất bản trang của B", () => publishPageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "lưu trữ trang của B", () => archivePageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: lưu nháp trang của B", () => saveBuilderDraftAction(idB.page, CHUNG, 1), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: tải nháp trang của B", () => loadBuilderDraftAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: xuất bản trang của B", () => publishBuilderPageAction(idB.page), { path: "/settings/pages" });
    await attack(P, "trình kéo-thả: đưa trang của B vào menu", () => addPageToMenuAction(idB.page), { path: "/settings/pages" });
    await attack(P, "mở trình soạn trang của B (loader)", () => loadPageEditor(qtA, idB.page));
    await attack(P, "mở trình kéo-thả trang của B (loader)", () => loadPageBuilder(qtA, idB.page));
    await attack(P, "tải nháp trang của B (lõi)", () => adminLoadBuilderDraft(qtA, idB.page));

    // ══════════ ĐÒN 4 · LUẬT + LƯỢT CHẠY + LỜI DUYỆT (Phase 3) ══════════
    const W = "Luật & duyệt";
    await attack(W, "sửa luật của B", () => saveWorkflowRuleAction(idB.rule, { key: "b_vip", name: "Chiếm", trigger: { kind: "event", event: "custom_status.changed" }, actions: [{ kind: "notify", message: "x" }] }), { path: "/settings/workflows" });
    await attack(W, "tạm dừng luật của B", () => setWorkflowRuleStatusAction(idB.rule, "PAUSED"), { path: "/settings/workflows" });
    await attack(W, "đổi chế độ luật của B", () => setWorkflowRuleModeAction(idB.rule, "DRY_RUN"), { path: "/settings/workflows" });
    await attack(W, "chạy thử luật của B trên khách của B", () => previewWorkflowRuleAction(idB.rule, { objectKey: "customer", recordId: "ta-b-cus1" }), { path: "/settings/workflows" });
    await attack(W, "mở trình soạn luật của B (loader)", () => loadWorkflowEditor(qtA, idB.rule));
    await attack(W, "duyệt lời duyệt của B", () => decideApproval(idB.approval, true, "chiếm"), { path: "/alerts" });
    await attack(W, "từ chối lời duyệt của B", () => decideApproval(idB.approval, false, "phá"), { path: "/alerts" });
    await attack(W, "danh sách chờ duyệt không có lời duyệt của B", () => listPendingApprovals(), {
      path: "/alerts",
      ownOnly: (v) => assert.ok(!serialize(v).includes(idB.approval), "danh sách chờ duyệt của A không có lời duyệt của B"),
    });
    await attack(W, "«chạy luật ngay» — chỉ luật của A", () => runWorkflowsNowAction(), {
      path: "/settings/workflows",
      ownOnly: (v) => assert.equal((v as { runs?: number }).runs ?? 0, 0, "A không có luật nào ⇒ 0 lượt chạy (lượt chờ của B không bị chạm)"),
    });

    // ══════════ ĐÒN 4b · TRANG DUYỆT LÕI /approvals (PR #366) ══════════
    const D = "Duyệt lõi /approvals";
    const khongCoLoiDuyetB = (v: unknown) => assert.ok(!serialize(v).includes(idB.approval), "khối Duyệt của A không mang lời duyệt của B");
    await attack(D, "mở /approvals (page component)", () => ApprovalsPage(), { path: "/approvals", ownOnly: khongCoLoiDuyetB });
    await attack(D, "dựng khối Duyệt đứng riêng của /approvals", () => ApprovalSection({ standalone: true }), { path: "/approvals", ownOnly: khongCoLoiDuyetB });
    await attack(D, "danh sách chờ duyệt đọc từ /approvals", () => listPendingApprovals(), { path: "/approvals", ownOnly: khongCoLoiDuyetB });
    await attack(D, "sổ yêu cầu duyệt kể cả đã quyết (lõi)", () => listApprovalRequests({ includeDecided: true, limit: 500 }), { path: "/approvals", ownOnly: khongCoLoiDuyetB });
    await attack(D, "duyệt lời duyệt của B bằng id từ /approvals", () => decideApproval(idB.approval, true, "chiếm"), { path: "/approvals" });
    await attack(D, "từ chối lời duyệt của B bằng id từ /approvals", () => decideApproval(idB.approval, false, "phá"), { path: "/approvals" });

    // ══════════ ĐÒN 5 · BLUEPRINT (Phase 7) ══════════
    const T = "Blueprint";
    await attack(T, "xem trước mẫu bán sỉ — kế hoạch của A, không phải trạng thái đã cài của B", () => previewTemplateAction("wholesale", {}), {
      path: "/settings/templates",
      ownOnly: (v) => {
        const plan = (v as { plan: { installedVersion: string | null; planHash: string } }).plan;
        assert.equal(plan.installedVersion, null, "A chưa cài ⇒ phiên bản đã cài phải là null (B đã cài)");
        assert.notEqual(plan.planHash, wholesalePlanB, "kế hoạch của A khác kế hoạch của B");
      },
    });
    await attack(T, "cài mẫu bằng planHash B đã xem", () => installTemplateAction("wholesale", { planHash: wholesalePlanB, resolutions: {} }), { path: "/settings/templates" });
    await attack(T, "lịch sử cài của A không có lượt cài của B", () => loadTemplateCatalog(qtA), {
      ownOnly: (v) => assert.equal((v as { value: { history: unknown[] } }).value.history.length, 0, "A chưa cài lượt nào"),
    });

    // ══════════ ĐÒN 6 · AI BUILDER (Phase 8) ══════════
    const I = "AI Builder";
    await attack(I, "xem trước nháp AI của B", () => previewAiDraftAction(idB.aiDraft, { excludedKeys: [], resolutions: {} }), { path: "/settings/ai-builder" });
    await attack(I, "áp dụng nháp AI của B (đúng planHash)", () => applyAiDraftAction(idB.aiDraft, { planHash: idB.aiPlanHash, excludedKeys: [], resolutions: {} }), { path: "/settings/ai-builder" });
    await attack(I, "bỏ nháp AI của B", () => discardAiDraftAction(idB.aiDraft), { path: "/settings/ai-builder" });
    await attack(I, "đọc nháp AI của B (lõi)", () => loadDraft(qtA, idB.aiDraft));
    await attack(I, "ngữ cảnh AI của A (readOrgBuilderState)", () => readOrgBuilderState(), {
      ownOnly: (v) => {
        const s = serialize(v);
        assert.ok(!s.includes("x_b_hd") && !s.includes("b_stage") && !s.includes("b_hang"), "ngữ cảnh AI của A không có khoá của B");
      },
    });
    const spy = new FakeProvider([() => ({ content: [{ type: "text", text: "không có gói" }], stopReason: "end_turn" })]);
    setBuilderAiForTests({ provider: spy, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
    try {
      await attack(I, "soạn nháp «sửa lặp» — tóm tắt gửi AI là của A", () => createAiDraftAction({ mode: "edit", prompt: "Thêm field hạng khách cho đối tượng chung." }), {
        path: "/settings/ai-builder",
        ownOnly: () => undefined,
      });
    } finally {
      setBuilderAiForTests(undefined);
    }
    assert.ok(spy.calls.length >= 1, "provider giả phải được gọi (lượt soạn chạy thật)");
    const sent = serialize(spy.calls);
    assert.ok(sent.includes("Chung A") && !sent.includes(MARK), "tóm tắt cấu hình gửi AI: có khoá của A, không chữ nào của B");
    // TOÀN BỘ prompt (system + user + công cụ) quét theo từng khoá / tên / đường dẫn của B và của mẫu B đã cài.
    const roB = B_KEYS.filter((k) => sent.includes(k));
    assert.deepEqual(roB, [], `prompt gửi AI của A mang khoá của B: ${roB.join(", ")}`);
    assert.ok(!sent.includes(HOME_MARK), "prompt gửi AI của A không mang dữ liệu của nhà");
    await attack(I, "màn AI Builder của A không liệt kê nháp của B", () => loadAiBuilderView(qtA), {
      path: "/settings/ai-builder",
      ownOnly: (v) => assert.ok(!serialize(v).includes(idB.aiDraft), "danh sách nháp AI của A không có nháp của B"),
    });

    // ══════════ ĐÒN 6b · AI COPILOT (lib/ai/copilot.ts + lib/ai/tools/*) ══════════
    // Copilot gọi model bằng khoá môi trường = khoá của NHÀ, nên tổ chức khác nhà TẮT ngay ở cổng (`copilotOrgDenial`):
    // trạng thái nói «chưa có AI cho tổ chức này», câu hỏi không tới model — kể cả khi môi trường có khoá hay có model
    // (giả) được tiêm — và không ghi một dòng `ai_interactions` nào vào CSDL của A. Lớp thứ hai (phòng khi cổng hỏng):
    // công cụ đọc gọi thẳng trong phiên A chỉ đọc CSDL của A, và công cụ của module A không bật bị từ chối.
    const K = "AI Copilot";
    const hoi = (message: string) => askCopilot({ message, context: { route: "/customers", entityType: "customer", entityId: "ta-b-cus1" } });
    const soDongAiA = () => withOrganization(A, async () => (await (await getDb()).select().from(schema.aiInteractions)).length);
    const dongAiTruoc = await soDongAiA();
    const tatVoiToChuc = (v: unknown) => {
      const r = v as { status?: string; error?: string; interactionId?: string | null; enabled?: boolean; scope?: string };
      if ("enabled" in r) assert.ok(r.enabled === false && r.scope === "ORGANIZATION", `trạng thái Copilot của A phải TẮT theo tổ chức: ${serialize(v).slice(0, 300)}`);
      else assert.ok(r.status === "DISABLED" && r.error === COPILOT_ORG_UNAVAILABLE && r.interactionId === null, `câu hỏi của A phải dừng ở cổng tổ chức: ${serialize(v).slice(0, 300)}`);
    };
    setAiProviderForTests(undefined);
    await withEnv("AI_PROVIDER", "anthropic", () =>
      withEnv("OPENAI_API_KEY", undefined, () =>
        withEnv("ANTHROPIC_API_KEY", "sk-ant-khoa-cua-nha-trong-moi-truong-0000", async () => {
          await attack(K, "trạng thái Copilot của A khi máy chủ có khoá AI của NHÀ", () => copilotStatus(), { path: "/customers", ownOnly: tatVoiToChuc });
          const r = await attack(K, "hỏi Copilot bằng khoá AI của NHÀ (model thật)", () => hoi("Khách này là ai?"), { path: "/customers" });
          assert.ok(r.ok, "askCopilot trả lời (không ném)");
          tatVoiToChuc(r.value);
          await attack(K, "AI Builder của A khi môi trường có khoá AI của NHÀ (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((x) => (x.ok ? { ok: true, source: x.ai.source } : { ok: false, error: x.reason })));
        }),
      ),
    );
    const modelTiem = copilotModel([{ name: "search_customer", input: { query: "hách A" } }]);
    setAiProviderForTests(modelTiem);
    try {
      const r = await attack(K, "hỏi Copilot khi có model được tiêm sẵn", () => hoi("Tra giúp khách này."), { path: "/customers" });
      assert.ok(r.ok, "askCopilot trả lời (không ném)");
      tatVoiToChuc(r.value);
      assert.equal(modelTiem.calls.length, 0, "cổng tổ chức đứng TRƯỚC model — không một lượt gọi model nào");
    } finally {
      setAiProviderForTests(undefined);
    }
    await attack(K, "xác nhận hành động của lượt hỏi Copilot của B (id)", () => confirmCopilotActions({ interactionId: idB.copilot, tokens: ["token-gia-0123456789"] }), { path: "/customers" });
    assert.equal(await soDongAiA(), dongAiTruoc, "Copilot tắt ở tổ chức khác nhà ⇒ không một dòng ai_interactions nào được ghi vào CSDL của A");

    // Lớp thứ hai — công cụ gọi thẳng trong phiên A. Tìm theo MỘT ĐOẠN của dấu (`ilike %…%`): lượt gọi không tự vang
    // lại dấu đầy đủ, nên dấu đầy đủ xuất hiện ở kết quả chỉ có thể là tên khách của B / của nhà.
    const congCu = (mat: string, name: string, input: Record<string, unknown>, check?: (text: string) => void) =>
      attack(
        K,
        `công cụ ${name} gọi thẳng — ${mat}`,
        async () => {
          const u = await requireUser();
          const tool = getTool(name);
          assert.ok(tool, `công cụ ${name} có trong sổ`);
          return tool.run({ user: u, actor: { id: u.id, email: u.email, name: u.name, source: "AI" }, route: "/customers", entityType: "customer", entityId: "", now: new Date() }, input);
        },
        {
          path: "/customers",
          ownOnly: (v) => {
            const text = serialize(v);
            assert.ok(!text.includes(HOME_MARK) && !text.includes("ta-home-cus1"), `${name}: kết quả mang dữ liệu của nhà: ${text.slice(0, 300)}`);
            check?.(text);
          },
        },
      );
    await congCu("đối chứng: đoạn tên khách CỦA A", "search_customer", { query: "hách A" }, (t) => assert.ok(t.includes("ta-a-cus1"), `đối chứng: công cụ thật sự chạy trên CSDL của A — ${t.slice(0, 300)}`));
    await congCu("đoạn tên khách của B", "search_customer", { query: MARK.slice(0, 7) }, (t) => assert.ok(!t.includes("ta-b-cus1")));
    await congCu("đoạn tên khách của nhà", "search_customer", { query: HOME_MARK.slice(0, 8) });
    await congCu("id khách của B", "get_customer_history", { customerId: "ta-b-cus1" });
    await congCu("id khách của nhà", "get_customer_history", { customerId: "ta-home-cus1" });
    await congCu("bản tin chủ shop", "get_owner_brief", { period: "30d" });
    for (const [mat, name, input] of [
      ["module Giao vận của A tắt", "get_care_case", { shipmentId: "ta-b-ship" }],
      ["module Tài chính của A tắt", "get_profit_summary", { period: "30d" }],
    ] as const) {
      const s = await congCu(mat, name, input);
      assert.ok(!s.ok && (s.error as { code?: string }).code === TOOL_MODULE_DISABLED, `${name}: module tắt phải bị từ chối MODULE_DISABLED trước khi chạy — ${serialize(s.ok ? s.value : (s.error as Error).message).slice(0, 200)}`);
    }
    // Tổ chức NHÀ không đổi: cổng mở, câu hỏi tới model (giả) và trả lời bình thường (sổ ai_interactions của nhà: tests/ai-copilot.test.ts).
    assert.equal(await copilotOrgDenial(), null, "tổ chức nhà: Copilot không bị cổng tổ chức chặn");
    const nhaModel = new FakeProvider([() => ({ content: [{ type: "text", text: "nhà trả lời" }], stopReason: "end_turn" })]);
    setAiProviderForTests(nhaModel);
    try {
      const cauNha = `Câu hỏi của nhà ${HOME_MARK}`;
      const rNha = await runCopilot({ user: { ...qtA, modules: undefined, organization: undefined }, message: cauNha, context: { route: "/", entityType: "", entityId: "" } });
      assert.equal(rNha.status, "OK", `tổ chức nhà: Copilot chạy như trước — ${JSON.stringify(rNha).slice(0, 300)}`);
      assert.equal(nhaModel.calls.length, 1, "tổ chức nhà: câu hỏi tới model");
      await (await getDb()).delete(schema.aiInteractions).where(eq(schema.aiInteractions.prompt, cauNha));
    } finally {
      setAiProviderForTests(undefined);
    }

    // ══════════ ĐÒN 7 · KẾT NỐI + BÍ MẬT (Phase 9) ══════════
    const C = "Kết nối & bí mật";
    await attack(C, "kiểm tra kết nối lark-webhook (của B)", () => testConnectionAction("lark-webhook"), { path: "/settings/connections" });
    await attack(C, "bật kết nối lark-webhook (của B)", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "ACTIVE" }), { path: "/settings/connections" });
    await attack(C, "tắt kết nối lark-webhook (của B)", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "DISABLED" }), { path: "/settings/connections" });
    await attack(C, "lưu kết nối với ô bí mật TRỐNG (mong «giữ bí mật cũ» của B)", () => saveConnectionAction({ connectorKey: "lark-webhook", settings: {}, secrets: {} }), { path: "/settings/connections" });
    await attack(C, "đọc khoá AI đang bật (openActiveConnection anthropic-byok)", () => openActiveConnection("anthropic-byok"));
    await attack(C, "AI Builder của A mượn khoá AI của B (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((r) => (r.ok ? { ok: true, source: r.ai.source } : { ok: false, error: r.reason })));
    await attack(C, "kiểm tra khoá AI (anthropic-byok của B)", () => testConnectionAction("anthropic-byok"), { path: "/settings/connections" });
    await attack(C, "màn Kết nối của A không có dấu vết của B", () => loadConnectionsView(qtA), {
      ownOnly: (v) => {
        const lark = (v as { groups: { rows: { key: string; connection: unknown }[] }[] }).groups.flatMap((g) => g.rows).find((r) => r.key === "lark-webhook");
        assert.equal(lark?.connection ?? null, null, "A không thấy kết nối của B");
      },
    });
    // Bản mã bị đánh cắp: dòng khoá AI ĐANG BẬT của B chép vào A, mã tổ chức SỬA thành A ⇒ chỉ còn AAD đứng chặn.
    const stolen = await withOrganization(B, async () => (await (await getDb()).select().from(schema.orgConnections).where(eq(schema.orgConnections.connectorKey, "anthropic-byok")))[0]);
    assert.ok(stolen?.secretsEnc && stolen.status === "ACTIVE", "tiền đề: B có bản mã đang bật");
    await withOrganization(A, async () => (await getDb()).insert(schema.orgConnections).values({ ...stolen, id: "ta-danh-cap", orgCode: A }));
    try {
      const read = await attack(C, "đọc khoá AI từ bản mã của B chép sang A (AAD)", () => openActiveConnection("anthropic-byok"));
      assert.ok(read.ok && /giải mã/i.test(serialize(read.value)), `bản mã của B không giải được ở A: ${serialize(read.ok ? read.value : read.error)}`);
      await attack(C, "AI Builder của A dùng bản mã đánh cắp (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((r) => (r.ok ? { ok: true, source: r.ai.source } : { ok: false, error: r.reason })));
      await attack(C, "kiểm tra kết nối bằng bản mã đánh cắp", () => testConnectionAction("anthropic-byok"), { path: "/settings/connections" });
    } finally {
      await withOrganization(A, async () => (await getDb()).delete(schema.orgConnections).where(eq(schema.orgConnections.id, "ta-danh-cap")));
    }
    // Chép NGUYÊN VĂN (mã tổ chức vẫn là B): nếu máy chủ lấy AAD từ CỘT của dòng thay vì từ ngữ cảnh thì bản này giải được.
    await withOrganization(A, async () => (await getDb()).insert(schema.orgConnections).values({ ...stolen, id: "ta-danh-cap-nguyen-van" }));
    try {
      const read = await attack(C, "đọc khoá AI từ bản mã của B chép NGUYÊN VĂN sang A (dòng mang mã tổ chức B)", () => openActiveConnection("anthropic-byok"));
      assert.ok(read.ok && /mã tổ chức khác ngữ cảnh/.test(serialize(read.value)), `dòng mang mã tổ chức khác bị từ chối trước khi giải mã: ${serialize(read.ok ? read.value : read.error)}`);
      await attack(C, "AI Builder của A dùng bản mã chép nguyên văn (getBuilderAi)", () => getBuilderAi({ fetch: globalThis.fetch }).then((r) => (r.ok ? { ok: true, source: r.ai.source } : { ok: false, error: r.reason })));
      await attack(C, "soạn nháp AI bằng bản mã chép nguyên văn", () => createAiDraftAction({ mode: "new", prompt: "Dựng ERP bán buôn có CRM và kho." }), { path: "/settings/ai-builder" });
    } finally {
      await withOrganization(A, async () => (await getDb()).delete(schema.orgConnections).where(eq(schema.orgConnections.id, "ta-danh-cap-nguyen-van")));
    }

    // ══════════ ĐÒN 8 · THƯƠNG HIỆU / LOGO / TỰ PHỤC VỤ / ĐĂNG NHẬP / VẬN HÀNH NỀN TẢNG (Phase 10 + 1) ══════════
    const S = "Thương hiệu & tự phục vụ";
    await attack(S, "GET /api/branding/logo (A không có logo ⇒ 404, không phải byte của B)", () => logoGET(), { path: "/api/branding/logo" });
    await attack(S, "readLogo()", () => readLogo());
    await attack(S, "thương hiệu của A không mang tên B", () => getBranding(), { ownOnly: () => undefined });
    await attack(S, "gỡ logo — chỉ gỡ của A", () => removeLogoAction(), { path: "/settings/branding", ownOnly: () => undefined });
    await attack(S, "tạo mã mời (không phải người vận hành)", () => createInviteAction({ note: `${NOTE} kẻ lạ` }), { path: "/platform" });
    await attack(S, "thu hồi mã mời CÒN TRỐNG", () => revokeInviteAction(freeInvite.id), { path: "/platform" });
    await attack(S, "thu hồi mã mời đã gắn B", () => revokeInviteAction(inviteB.id), { path: "/platform" });
    await attack(S, "chạy lại việc dựng tổ chức B", () => retrySetupAction(B), { path: "/platform" });
    await attack(S, "tắt module Ứng dụng của B", () => toggleModuleForOrgAction({ orgCode: B, moduleKey: "apps", enabled: false, reason: "kẻ lạ tắt hộ" }), { path: "/platform" });
    await attack(S, "bật module Sản xuất cho B", () => toggleModuleForOrgAction({ orgCode: B, moduleKey: "production", enabled: true, reason: "kẻ lạ bật hộ" }), { path: "/platform" });
    // Cổng mở bán B: đổi chế độ đăng ký /start là việc của người vận hành nền tảng — tổ chức khác không mở được cửa.
    const signupBefore = await signupSettingRow();
    await attack(S, "mở đăng ký /start cho cả nền tảng", () => setSignupModeAction({ mode: "open", reason: "kẻ lạ mở cửa" }), { path: "/platform" });
    await attack(S, "mở đăng ký /start bằng mã mời", () => setSignupModeAction({ mode: "invite", reason: "kẻ lạ mở cửa" }), { path: "/platform" });
    assert.equal(await signupSettingRow(), signupBefore, "lượt đổi chế độ đăng ký của tổ chức khác không để lại dòng cài đặt nào");
    await withSignupMode("invite", async () => {
      await attack(S, "/start: kiểm mã tổ chức ta-b bằng mã mời còn trống", () => checkOrgAction({ name: "Chiếm B", code: B }, freeInvite.code), { path: "/start" });
      const redo = (invite: string, email: string, password: string): SignupDraft => ({ ...draftB, invite, admin: { name: "Kẻ lạ", email, password } });
      await attack(S, "/start: tạo tổ chức mã ta-b bằng mã mời còn trống", () => createOrganizationAction(redo(freeInvite.code, "ke-la@ta-a.local", "KeLa@2026x")), { path: "/start" });
      await attack(S, "/start: dùng lại mã mời đã gắn B (email lạ)", () => createOrganizationAction(redo(spareInvite.code, "ke-la@ta-a.local", "KeLa@2026x")), { path: "/start" });
      await attack(S, "/start: dùng lại mã mời dựng B + email quản trị B, sai mật khẩu", () => createOrganizationAction(redo(inviteB.code, B_EMAIL, "SaiMatKhau@2026")), { path: "/start" });
      await attack(S, "/start: xem trước bằng mã mời của B", () => previewSignupAction({ invite: inviteB.code, orgCode: B, plan: draftB.plan, planKey: null }), {
        path: "/start",
        ownOnly: (v) => assert.ok(!serialize(v).includes("x_b_hd"), "xem trước dựng trên tổ chức TRẮNG, không đọc gì của B"),
      });
    });
    await withSignupMode("open", async () => {
      await attack(S, "/start (mở): tạo tổ chức mã ta-b", () => createOrganizationAction({ ...draftB, invite: null, admin: { name: "Kẻ lạ", email: "ke-la@ta-a.local", password: "KeLa@2026x" } }), { path: "/start" });
    });
    const login = await attack(S, "đăng nhập VÀO B bằng tài khoản của A", () => loginAction(undefined, form({ email: A_EMAIL, password: A_PW, org: B, next: "/da-vao-b" })), { path: "/login" });
    assert.ok(login.ok && typeof (login.value as { error?: unknown }).error === "string", `đăng nhập phải TRẢ LỖI (không chuyển hướng vào trong): ${serialize(login.ok ? login.value : digestOf(login.error))}`);
    let issued = false;
    await attack(S, "verifyLogin(email + mật khẩu của A, tổ chức B)", () => verifyLogin({ email: A_EMAIL, password: A_PW, orgCode: B }, async () => void (issued = true)));
    assert.equal(issued, false, "không một phiên nào mang org = B được ký cho tài khoản của A");
    await attack(S, "POST /api/sync/<job>?org=ta-b bằng phiên A", () => syncPOST(new NextLikeRequest(`http://erp.local/api/sync/alerts?org=${B}`) as never, { params: Promise.resolve({ job: "alerts" }) }), { path: "/api/sync/alerts" });

    // ══════════ ĐÒN 10 · THAO TÚNG METADATA — A gửi thẳng cấu hình mang khoá / id / field của B, hoặc thứ ngoài sổ ══════════
    // Mọi lượt ghi vào tài nguyên CỦA CHÍNH A (trang `chung`, form / danh sách khách, luật mới, gói tự gửi) nhưng cài
    // một tham chiếu độc. Máy chủ phải từ chối VÀ không ghi gì — ảnh chụp CSDL của A (mọi bảng) trước = sau.
    const X = "Thao túng metadata";
    // Đối chứng TRƯỚC ảnh chụp: bản nháp form thật của A lưu được, gói gốc (mẫu bán sỉ đổi khoá) đọc được — lời từ chối
    // phía dưới là vì CHỖ ĐỘC, không vì đầu vào hỏng sẵn.
    const formSach = await asRequest(TOKEN_A, "/settings/forms", () => saveFormDraftAdminAction("customer", "profile", editorsA.form));
    assert.ok(formSach.ok && (formSach.value as { ok: boolean }).ok, `đối chứng: bản nháp form của A tự nó lưu được — ${serialize(formSach.ok ? formSach.value : formSach.error).slice(0, 300)}`);
    const goiSach = poisonedBlueprint(() => undefined);
    const doiChung = await asRequest(TOKEN_A, "/settings/templates", () => previewBlueprintFileAction(goiSach, {}));
    assert.ok(doiChung.ok && (doiChung.value as { ok: boolean }).ok, `đối chứng: gói gốc (mẫu bán sỉ đổi khoá) đọc được — ${serialize(doiChung.ok ? doiChung.value : doiChung.error).slice(0, 300)}`);
    const hashSach = (doiChung.value as { plan: { planHash: string } }).plan.planHash;
    const aBefore = await withOrganization(A, snapshotOrgDb);
    const trangA = (blocks: unknown[]) => ({ version: 1, sections: [{ key: "so", blocks }] });
    const tuChoi = async (mat: string, fn: () => Promise<unknown>, why: RegExp, reqPath: string) => {
      const s = await attack(X, mat, fn, { path: reqPath });
      const text = await payloadOf(s);
      assert.match(text, why, `${mat}: bị từ chối nhưng không vì chỗ độc — ${text.slice(0, 300)}`);
    };
    // Trang
    await tuChoi("trang A: bảng đọc đối tượng của B (x_b_hd)", () => savePageDraftAction(idB.pageA, trangA([block("x1", "table", { source: "x_b_hd" })])), /x_b_hd/, "/settings/pages");
    await tuChoi("trang A: bảng trên khách với field của B (custom:b_hang)", () => savePageDraftAction(idB.pageA, trangA([block("x1", "table", { source: "customer", columns: ["system:name", "custom:b_hang"] })])), /b_hang/, "/settings/pages");
    await tuChoi("trang A: KPI tổng field chỉ B có (x_chung.gia_tri)", () => savePageDraftAction(idB.pageA, trangA([block("x1", "kpi", { aggregate: { objectKey: "x_chung", fn: "sum", field: "custom:gia_tri" } })])), /gia_tri/, "/settings/pages");
    await tuChoi("trang A: bảng đọc đối tượng x_… không tồn tại", () => savePageDraftAction(idB.pageA, trangA([block("x1", "table", { source: "x_khong_ton_tai" })])), /x_khong_ton_tai/, "/settings/pages");
    await tuChoi("trang A: KPI đọc nguồn ngoài sổ", () => savePageDraftAction(idB.pageA, trangA([block("x1", "kpi", { metric: "sql_ngoai_so" } as never)])), /sql_ngoai_so/, "/settings/pages");
    await tuChoi("trang A: dòng thời gian bản ghi của đối tượng B", () => savePageDraftAction(idB.pageA, trangA([block("x1", "timeline", { source: "custom_record_x_b_hd", recordParam: "id" })])), /custom_record_x_b_hd|x_b_hd/, "/settings/pages");
    const revA = await withOrganization(A, () => adminLoadBuilderDraft(qtA, idB.pageA));
    assert.ok(revA.ok, "A đọc được số hiệu nháp trang của mình");
    await tuChoi("trình kéo-thả A: lưu nháp (đúng số hiệu) mang nguồn của B", () => saveBuilderDraftAction(idB.pageA, trangA([block("x1", "table", { source: "x_b_hd" })]), revA.draftRevision), /x_b_hd/, "/settings/pages");
    await tuChoi("trang A: gắn vào module A không bật (finance)", () => updatePageMetaAction(idB.pageA, { slug: "chung", name: "Chung A", moduleKey: "finance", requiredPermission: null, nav: { enabled: true } }), /Tài chính|finance|đang tắt/i, "/settings/pages");
    await tuChoi("tạo trang trong module A không bật (finance)", () => createPageAction({ slug: "trang-tai-chinh", name: "Tài chính", moduleKey: "finance", nav: { enabled: false } }), /Tài chính|finance|đang tắt/i, "/settings/pages");
    // Form / danh sách / field
    const formDoc = (ref: string) => {
      const f = JSON.parse(JSON.stringify(editorsA.form)) as { sections: { fields: unknown[] }[] };
      f.sections[0].fields.push({ ref, visible: true, readOnly: false, required: false });
      return f;
    };
    const listDoc = (ref: string) => {
      const l = JSON.parse(JSON.stringify(editorsA.list)) as { columns: unknown[] };
      l.columns.push({ ref, visible: true });
      return l;
    };
    await tuChoi("form khách của A: ô field của B (custom:b_hang)", () => saveFormDraftAdminAction("customer", "profile", formDoc("custom:b_hang")), /b_hang/, "/settings/forms");
    await tuChoi("form khách của A: ô field x_… không tồn tại", () => saveFormDraftAdminAction("customer", "profile", formDoc("custom:x_khong_co")), /x_khong_co/, "/settings/forms");
    await tuChoi("danh sách khách của A: cột field của B (custom:b_stage)", () => saveListDraftAdminAction("customer", "default", listDoc("custom:b_stage")), /b_stage/, "/settings/lists");
    await tuChoi("field quan hệ của A trỏ đối tượng của B", () => createFieldAction("x_chung", { key: "tro_b", label: "Trỏ B", type: "relation", relationObject: "x_b_hd" }), /relationObject/, "/settings/data-model");
    // Luật
    const luat = (over: Record<string, unknown>) => ({ key: "luat_doc", name: "Luật độc", trigger: { kind: "custom_status", objectKey: "x_chung", fieldKey: "trang_thai", to: ["xong"] }, conditions: null, actions: [{ kind: "notify", message: "x" }], gate: null, ...over });
    await tuChoi("luật A nghe field trạng thái của B (customer.b_stage)", () => saveWorkflowRuleAction(null, luat({ trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "b_stage", to: ["vip"] } })), /b_stage/, "/settings/workflows");
    await tuChoi("luật A nghe đối tượng của B (x_b_hd)", () => saveWorkflowRuleAction(null, luat({ trigger: { kind: "event", event: "custom_record.created", objectKey: "x_b_hd" } })), /x_b_hd|đối tượng/i, "/settings/workflows");
    await tuChoi("luật A điều kiện trên field của B", () => saveWorkflowRuleAction(null, luat({ conditions: { field: "custom:gia_tri", op: "eq", value: 1 } })), /gia_tri/, "/settings/workflows");
    await tuChoi("luật ghi lại CHÍNH field kích hoạt (vòng lặp)", () => saveWorkflowRuleAction(null, luat({ actions: [{ kind: "set_custom_value", field: "trang_thai", value: "moi" }] })), /vòng lặp/, "/settings/workflows");
    await tuChoi("luật nghe mọi lượt đổi trạng thái rồi ghi field (vòng lặp)", () => saveWorkflowRuleAction(null, luat({ trigger: { kind: "event", event: "custom_status.changed", objectKey: "x_chung" }, actions: [{ kind: "set_custom_value", field: "trang_thai", value: "moi" }] })), /vòng lặp/, "/settings/workflows");
    await tuChoi("luật nghe sự kiện do chính workflow phát", () => saveWorkflowRuleAction(null, luat({ trigger: { kind: "event", event: "workflow.run_finished" } })), /vòng lặp|workflow/, "/settings/workflows");
    // Gói cấu hình tự gửi (tệp khôi phục) — sáu biến thể độc của gói sạch ở trên
    const goiDoc: [string, string, RegExp][] = [
      ["vai trò cấp users:manage", poisonedBlueprint((bp) => (bp.roles[0] as { permissions: string[] }).permissions.push("users:manage")), /users:manage|quản lý người dùng|tài khoản/i],
      ["luật ghi lại chính field kích hoạt (vòng lặp)", poisonedBlueprint((bp) => ((bp.workflows[0] as { actions: unknown[] }).actions = [{ kind: "set_custom_value", field: "tinh_trang_cong_no", value: "tam_khoa" }])), /vòng lặp/],
      ["trang trỏ module gói không bật (marketing)", poisonedBlueprint((bp) => ((bp.pages[0] as { moduleKey: string }).moduleKey = "marketing")), /marketing|Marketing|module/i],
      ["form trên đối tượng của B không khai trong gói", poisonedBlueprint((bp) => bp.forms.push({ objectKey: "x_b_hd", formKey: "create", schema: { version: 1, sections: [] } })), /x_b_hd/],
      ["field trên đối tượng của B không khai trong gói", poisonedBlueprint((bp) => bp.fields.push({ objectKey: "x_b_hd", key: "gia_tri", label: "Giá trị", type: "currency" })), /x_b_hd/],
      ["trang đọc nguồn ngoài sổ", poisonedBlueprint((bp) => bp.pages.push(pageOf("trang-doc", [{ id: "k1", type: "kpi", span: 4, config: { metric: "sql_ngoai_so" } }]))), /sql_ngoai_so/],
    ];
    for (const [ten, goi, why] of goiDoc) {
      await tuChoi(`gói tự gửi — xem trước: ${ten}`, () => previewBlueprintFileAction(goi, {}), why, "/settings/templates");
      await tuChoi(`gói tự gửi — cài (planHash của gói sạch): ${ten}`, () => installBlueprintFileAction(goi, { planHash: hashSach, resolutions: {} }), why, "/settings/templates");
    }
    assert.deepEqual(diff(aBefore, await withOrganization(A, snapshotOrgDb)), [], "mọi lượt thao túng metadata bị từ chối KHÔNG ghi một dòng nào vào CSDL của A");

    // Module tắt: nháp được phép mang cảnh báo (module có thể bật sau), nhưng XUẤT BẢN và DỰNG phải chặn.
    const chungTruoc = await withOrganization(A, () => getPageBySlug("chung"));
    await asRequest(TOKEN_A, "/settings/pages", () => savePageDraftAction(idB.pageA, trangA([block("tc", "kpi", { metric: "delivered_revenue" })])));
    await tuChoi("xuất bản trang A có khối của module A không bật (finance)", () => publishPageAction(idB.pageA), /finance|Tài chính|TẮT|tắt/i, "/settings/pages");
    await attack(X, "dựng khối của module A không bật (finance) ngay trên máy chủ", () => resolveBlock(block("tc", "kpi", { metric: "delivered_revenue" }), qtA, ctxOf()));
    const chungSau = await withOrganization(A, () => getPageBySlug("chung"));
    assert.deepEqual(chungSau?.schema, chungTruoc?.schema, "bản đã xuất bản của trang `chung` không đổi");
    await asRequest(TOKEN_A, "/settings/pages", () => savePageDraftAction(idB.pageA, CHUNG));

    // AI trả về gói có vai trò users:manage ⇒ nháp được GHI (để người đọc lỗi) nhưng xem trước / áp dụng bị chặn.
    const aiDoc = JSON.parse(poisonedBlueprint((bp) => (bp.roles[0] as { permissions: string[] }).permissions.push("users:manage"))) as Record<string, unknown>;
    setBuilderAiForTests({ provider: new FakeProvider([toolCall(aiDoc)]), source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
    let draftDoc = "";
    try {
      const made = await attack(X, "AI trả gói có vai trò users:manage — nháp ghi ở A, đánh dấu KHÔNG hợp lệ", () => createAiDraftAction({ mode: "new", prompt: "Dựng ERP bán buôn có vai trò quản trị người dùng." }), {
        path: "/settings/ai-builder",
        ownOnly: (v) => {
          const d = (v as { value: { id: string; valid: boolean } }).value;
          assert.equal(d.valid, false, "nháp có users:manage không được đánh dấu hợp lệ");
          draftDoc = d.id;
        },
      });
      assert.ok(made.ok && draftDoc, "nháp độc được ghi để người đọc lỗi");
    } finally {
      setBuilderAiForTests(undefined);
    }
    const planDoc = await asRequest(TOKEN_A, "/settings/ai-builder", () => previewAiDraftAction(draftDoc, { excludedKeys: [], resolutions: {} }));
    const planOfDoc = planDoc.ok ? (planDoc.value as { value?: { plan?: { planHash: string; ok: boolean } } }).value?.plan : undefined;
    assert.ok(planOfDoc && planOfDoc.ok === false, `xem trước nháp độc: kế hoạch phải BỊ CHẶN — ${serialize(planDoc.ok ? planDoc.value : planDoc.error).slice(0, 300)}`);
    const hashDoc = planOfDoc.planHash;
    await tuChoi("áp dụng nháp AI có vai trò users:manage", () => applyAiDraftAction(draftDoc, { planHash: hashDoc, excludedKeys: [], resolutions: {} }), /users:manage|người dùng|tài khoản|bị chặn/i, "/settings/ai-builder");
    const rolesA = await withOrganization(A, async () => (await (await getDb()).select().from(schema.accessRoles)).map((r) => ({ code: r.code, permissions: r.permissions })));
    assert.ok(!serialize(rolesA).includes("users:manage"), `không vai trò nào của A mang users:manage: ${serialize(rolesA)}`);

    // ══════════ ĐÒN 11 · SAO LƯU (PR #365) — thẻ trạng thái sao lưu ══════════
    // Thư mục trạng thái có lời khai của NHÀ (+ tổng hợp tổ chức, nhắc tên CSDL B) và thư mục riêng của B: A chỉ được
    // thấy "chưa có bản sao" của CHÍNH CSDL mình — không lời khai nào của nhà, không dòng nào của B.
    const L = "Sao lưu";
    backupDir = mkdtempSync(path.join(tmpdir(), "ta-sao-luu-"));
    const luc = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const nha = { schema: 1, kind: "backup", result: "OK", trigger: "cron", finishedAt: luc, db: { file: `erp-${HOME_MARK}.dump`, bytes: 1, tableData: 3 }, chatbot: { state: "OK" }, offsite: { state: "OK", remote: `gcrypt:${HOME_MARK}` }, retention: { daily: 7 } };
    const cuaB = { ...nha, kind: "org-backup", database: "erp_org_ta_b", chatbot: undefined, db: { file: `erp_org_ta_b-${MARK}.dump`, bytes: 1, tableData: 9 }, offsite: { state: "OK", remote: `gcrypt:${MARK}` } };
    for (const f of ["last-run.json", "last-success.json"]) writeFileSync(path.join(backupDir, f), JSON.stringify(nha));
    writeFileSync(path.join(backupDir, "last-drill.json"), JSON.stringify({ schema: 1, kind: "restore-drill", result: "OK", finishedAt: luc, tables: [] }));
    writeFileSync(path.join(backupDir, ORG_BACKUP_SUMMARY_FILE), JSON.stringify({ schema: 1, kind: "org-backup-summary", finishedAt: luc, listError: null, organizations: [{ database: "erp_org_ta_b", result: "FAILED", reason: `hỏng ${MARK}` }], missingDatabases: [] }));
    mkdirSync(path.join(backupDir, ORG_BACKUP_STATUS_SUBDIR, "erp_org_ta_b"), { recursive: true });
    for (const f of ["last-run.json", "last-success.json"]) writeFileSync(path.join(backupDir, ORG_BACKUP_STATUS_SUBDIR, "erp_org_ta_b", f), JSON.stringify(cuaB));
    const dir = backupDir;
    await withEnv("ERP_BACKUP_STATUS_DIR", dir, async () => {
      clearMemo();
      const cuaNha = serialize(await getBackupHealth());
      assert.ok(cuaNha.includes(HOME_MARK) && cuaNha.includes("erp_org_ta_b"), `đối chứng: NHÀ đọc được lời khai của mình và tổng hợp tổ chức — ${cuaNha.slice(0, 300)}`);
      const khongCuaAi = (v: unknown) => {
        const s = serialize(v);
        assert.ok(!s.includes(HOME_MARK) && !s.includes("erp_org_ta_b"), `thẻ sao lưu của A mang lời khai của nhà / của B: ${s.slice(0, 300)}`);
      };
      await attack(L, "getBackupHealth() của A — không lời khai của nhà, không tổng hợp tổ chức", () => getBackupHealth(), {
        path: "/integrations",
        ownOnly: (v) => {
          khongCuaAi(v);
          const h = v as { state: string; lastSuccess: unknown; organizations: unknown; target: { scope: string } };
          assert.equal(h.target.scope, "ORGANIZATION");
          assert.equal(h.lastSuccess, null, "A chưa có bản sao nào của CHÍNH nó");
          assert.equal(h.organizations, null, "tổng hợp các tổ chức chỉ nhà thấy");
          assert.notEqual(h.state, "HEALTHY");
        },
      });
      await attack(L, "thẻ «Sao lưu dữ liệu» (BackupStatusCard) của A", () => BackupStatusCard(), { path: "/integrations", ownOnly: khongCuaAi });
    });
    clearMemo();

    // ══════════ ĐÒN 12 · VẬN HÀNH PILOT / CÔNG TẮC KHẨN / HỖ TRỢ / AI (pilot readiness A3 · A4) ══════════
    // Mọi cửa của người vận hành nền tảng, gọi bởi QUẢN TRỊ của A với đích B và đích NHÀ — hai lớp: vỏ action (phiên thật,
    // `requirePermission("platform:operate")`) VÀ lõi gọi thẳng với người dùng của A (phòng khi vỏ hỏng). Mỗi lượt phải bị
    // từ chối VÌ «không phải người vận hành» (khớp câu), không vì lý do phụ (lý do ngắn, sai giai đoạn…).
    const V = "Vận hành pilot · công tắc · hỗ trợ";
    const home = await getHomeOrganization();
    const KHONG_VAN_HANH = /Chỉ người của tổ chức nhà mới vận hành|forbidden=1/;
    const LY_DO = "kẻ lạ thử đổi hộ tổ chức khác";
    for (const [dich, code] of [
      ["B", B],
      ["NHÀ", home.code],
    ] as const) {
      const p = `/platform/org/${code}`;
      const hai = async (ten: string, action: () => Promise<unknown>, loi: () => Promise<unknown>) => {
        await tuChoiVi(V, `${ten} của ${dich} (action)`, action, KHONG_VAN_HANH, p);
        await tuChoiVi(V, `${ten} của ${dich} (lõi, bỏ qua vỏ action)`, loi, KHONG_VAN_HANH, p);
      };
      await hai("lùi giai đoạn pilot (kèm ghi đè + lý do)", () => setPilotStageAction({ orgCode: code, stage: "CREATED", reason: LY_DO, override: true }), () => setPilotStage(qtA, { orgCode: code, stage: "CREATED", reason: LY_DO, override: true }));
      await hai("xác nhận UAT", () => confirmPilotUatAction({ orgCode: code, note: LY_DO }), () => confirmPilotUat(qtA, { orgCode: code, note: LY_DO }));
      await hai("đình chỉ tổ chức", () => setOrgSuspendedAction({ orgCode: code, suspend: true, reason: LY_DO }), () => setOrganizationSuspended(qtA, { orgCode: code, suspend: true, reason: LY_DO }));
      await hai("tạm dừng luật tự động", () => setWorkflowsPausedAction({ orgCode: code, paused: true, reason: LY_DO }), () => setWorkflowsPaused(qtA, { orgCode: code, paused: true, reason: LY_DO }));
      await hai("tắt kết nối lark-webhook", () => disableOrgConnectionAction({ orgCode: code, connectorKey: "lark-webhook", reason: LY_DO }), () => disableOrgConnection(qtA, { orgCode: code, connectorKey: "lark-webhook", reason: LY_DO }));
      await hai("tắt AI + hạ hạn mức AI", () => setOrgAiControlAction({ orgCode: code, disabled: true, limits: { requestsPerDay: 0 }, reason: LY_DO }), () => setOrgAiControl(qtA, { orgCode: code, disabled: true, limits: { requestsPerDay: 0 }, reason: LY_DO }));
      await tuChoiVi(V, `trang sức khoẻ của ${dich} (loadOrgSupport — không ghi SUPPORT_VIEW)`, () => loadOrgSupport(qtA, code), KHONG_VAN_HANH, p);
      await tuChoiVi(V, `mở /platform/org/${code} (page component)`, () => PlatformOrgPage({ params: Promise.resolve({ code }) }), KHONG_VAN_HANH, p);
    }
    await tuChoiVi(V, "tắt AI toàn nền tảng (action)", () => setPlatformAiEnabledAction({ enabled: false, reason: LY_DO }), KHONG_VAN_HANH, "/platform");
    await tuChoiVi(V, "tắt AI toàn nền tảng (lõi)", () => setPlatformAiEnabled(qtA, { enabled: false, reason: LY_DO }), KHONG_VAN_HANH, "/platform");
    await tuChoiVi(V, "tự kiểm khoá bí mật của nền tảng (action)", () => secretsSelfTestAction(), KHONG_VAN_HANH, "/platform");
    await tuChoiVi(V, "tự kiểm khoá bí mật của nền tảng (lõi)", () => runSecretsSelfTest(qtA), KHONG_VAN_HANH, "/platform");
    await tuChoiVi(V, "mở /platform?org=ta-b (page component)", () => PlatformPage({ searchParams: Promise.resolve({ org: B }) }), KHONG_VAN_HANH, "/platform");
    await attack(V, "tóm tắt hỗ trợ mọi tổ chức (listOrgSupportSummaries) — rỗng", () => listOrgSupportSummaries(qtA), {
      path: "/platform",
      ownOnly: (v) => assert.deepEqual(v, {}, "người không vận hành không nhận dòng tóm tắt nào (kể cả của chính A)"),
    });

    // ══════════ ĐÒN 13 · ĐƠN / SẢN PHẨM / KHÁCH TẠO TAY (pilot readiness B1 · B2) — id của B ══════════
    // A là tổ chức KHÔNG đồng bộ Pancake nên cổng tạo tay MỞ với A: mọi lời từ chối dưới đây là vì id / khách / mẫu mã
    // không có trong CSDL của A (khớp câu), không vì cổng tổ chức.
    const R = "Đơn · sản phẩm · khách tạo tay";
    const donVoi = (customerId: string, variantId: string, stage = "NEW") => ({ customerId, stage, lines: [{ variantId, quantity: 1, unitPrice: 1_000 }], orderDiscount: 0, shippingFee: 0, note: "", channel: "" });
    const spVoi = (code: string, variants: Record<string, unknown>[]) => ({ name: "Sản phẩm của A", code, unit: "cái", retailPrice: 120_000, cost: null, variants });
    await tuChoiVi(R, "sửa đơn tay của B bằng id (dòng hàng của A)", () => updateManualOrderAction(idB.order, donVoi("ta-a-cus1", idB.variantA)), /Không có đơn này/, "/orders");
    await tuChoiVi(R, "xác nhận đơn tay của B (CONFIRMED, đúng khách + mẫu mã của B)", () => updateManualOrderAction(idB.order, donVoi("ta-b-cus1", idB.variant, "CONFIRMED")), /Không có đơn này/, "/orders");
    await tuChoiVi(R, "huỷ đơn tay của B bằng id", () => cancelManualOrderAction(idB.order, { reason: "kẻ lạ huỷ hộ" }), /Không có đơn này/, "/orders");
    await tuChoiVi(R, "tạo đơn ở A cho khách của B", () => createManualOrderAction(donVoi("ta-b-cus1", idB.variantA)), /Khách hàng không tồn tại trong tổ chức này/, "/orders/new");
    await tuChoiVi(R, "tạo đơn ở A với mẫu mã của B", () => createManualOrderAction(donVoi("ta-a-cus1", idB.variant)), /Mẫu mã không tồn tại trong tổ chức này/, "/orders/new");
    await attack(R, "đọc giá trị form sửa đơn của B (lõi)", () => manualOrderFormValues(idB.order), { path: "/orders" });
    await tuChoiVi(R, "mở /orders/<đơn B>/edit (page component)", () => EditManualOrderPage({ params: Promise.resolve({ id: idB.order }) }), /^404|NEXT_HTTP_ERROR_FALLBACK;404/, `/orders/${idB.order}/edit`);
    await tuChoiVi(R, "mở /orders/<đơn B> (page component)", () => OrderDetailPage({ params: Promise.resolve({ id: idB.order }) }), /NEXT_HTTP_ERROR_FALLBACK;404/, `/orders/${idB.order}`);
    await tuChoiVi(R, "sửa sản phẩm tay của B bằng id", () => updateProductAction(idB.product, spVoi("TA-A-CHIEM", [{ sku: "TA-A-CHIEM-M", size: "M", color: "Đỏ", selling: true }])), /Không tìm thấy sản phẩm trong tổ chức này/, "/products");
    await tuChoiVi(R, "cài mẫu mã của B vào sản phẩm tay của A", () => updateProductAction(idB.productA, spVoi("TA-A-SP", [{ id: idB.variant, sku: "TA-A-SP-X", size: "M", color: "Đỏ", selling: true }])), /Mẫu mã không thuộc sản phẩm này/, "/products");
    await tuChoiVi(R, "mở /products/<sản phẩm B> (page component)", () => ProductDetailPage({ params: Promise.resolve({ id: idB.product }) }), /NEXT_HTTP_ERROR_FALLBACK;404/, `/products/${idB.product}`);
    await tuChoiVi(R, "mở /products/<mẫu mã B> (page component — lối tra ngược mẫu mã)", () => ProductDetailPage({ params: Promise.resolve({ id: idB.variant }) }), /NEXT_HTTP_ERROR_FALLBACK;404/, `/products/${idB.variant}`);
    await tuChoiVi(R, "sửa thông tin cơ bản của khách B (form profile)", () => saveCustomerProfileAction({ recordId: "ta-b-cus1", system: { name: "Chiếm" }, custom: {} }), /Không tìm thấy khách trong tổ chức này/, "/customers");
    await tuChoiVi(R, "mở /customers/<khách B> (page component)", () => CustomerDetailPage({ params: Promise.resolve({ id: "ta-b-cus1" }) }), /NEXT_HTTP_ERROR_FALLBACK;404/, "/customers/ta-b-cus1");
    // Mã / SKU là duy nhất THEO TỔ CHỨC: A dùng lại đúng mã của B phải lưu được — nếu bị chặn thì lời chặn là một máy dò
    // danh mục của B.
    await attack(R, "tạo sản phẩm ở A trùng mã + SKU của B (không có máy dò chéo tổ chức)", () => createProductAction(spVoi(MA_SP_B, [{ sku: `${MA_SP_B}-M`, size: "M", color: "Đỏ", selling: true }])), {
      path: "/products/new",
      ownOnly: (v) => assert.equal((v as { ok?: boolean }).ok, true, "mã của B không chặn A"),
    });

    // ══════════ ĐÒN 14 · A KHÔNG TỰ MỞ KHOÁ CÔNG TẮC NGƯỜI VẬN HÀNH ĐÃ ĐÓNG VỚI CHÍNH A ══════════
    // Người vận hành NHÀ (lõi, người dùng tổ chức nhà có `platform:operate`) tạm dừng luật + tắt AI của A, rồi đình chỉ A.
    // A gọi đúng các cửa ấy với ĐÍCH LÀ CHÍNH MÌNH ⇒ bị từ chối, công tắc đứng nguyên; đối chứng: công tắc có hiệu lực thật.
    const OP: SessionUser = { id: "ta-op", email: "van-hanh@ta-nha.local", name: "Người vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
    const phaiDat = (r: unknown, what: string) => assert.ok(r && typeof r === "object" && "ok" in r, `${what}: ${serialize(r)}`);
    const Z = "Công tắc của người vận hành";
    phaiDat(await setWorkflowsPaused(OP, { orgCode: A, paused: true, reason: "tạm dừng để thử cổng" }), "người vận hành tạm dừng luật của A");
    phaiDat(await setOrgAiControl(OP, { orgCode: A, disabled: true, reason: "tắt AI để thử cổng" }), "người vận hành tắt AI của A");
    try {
      const pA = `/platform/org/${A}`;
      await tuChoiVi(Z, "A tự bỏ tạm dừng luật của mình (action)", () => setWorkflowsPausedAction({ orgCode: A, paused: false, reason: "tự mở khoá cho mình" }), KHONG_VAN_HANH, pA);
      await tuChoiVi(Z, "A tự bỏ tạm dừng luật của mình (lõi)", () => setWorkflowsPaused(qtA, { orgCode: A, paused: false, reason: "tự mở khoá cho mình" }), KHONG_VAN_HANH, pA);
      await tuChoiVi(Z, "A tự bật lại AI của mình (action)", () => setOrgAiControlAction({ orgCode: A, disabled: false, reason: "tự mở khoá cho mình" }), KHONG_VAN_HANH, pA);
      await tuChoiVi(Z, "A tự bật lại AI + nâng hạn mức của mình (lõi)", () => setOrgAiControl(qtA, { orgCode: A, disabled: false, limits: { requestsPerDay: 999_999 }, reason: "tự mở khoá cho mình" }), KHONG_VAN_HANH, pA);
      await tuChoiVi(Z, "A tự đẩy giai đoạn pilot của mình", () => setPilotStage(qtA, { orgCode: A, stage: "CREATED", reason: "tự đẩy cho mình" }), KHONG_VAN_HANH, pA);
      assert.equal((await readOrgFlag(A, WORKFLOWS_PAUSED_FLAG, { fresh: true }))?.enabled, true, "luật của A vẫn tạm dừng");
      assert.equal((await readOrgAiControl(A, { fresh: true })).disabled, true, "AI của A vẫn tắt");
      // Đối chứng: công tắc AI có hiệu lực THẬT — AI Builder của A dừng trước provider (model giả được tiêm vẫn 0 lượt gọi).
      const spyTat = new FakeProvider([() => ({ content: [{ type: "text", text: "không được tới đây" }], stopReason: "end_turn" })]);
      setBuilderAiForTests({ provider: spyTat, source: "ORG_CONNECTION", connectorKey: "anthropic-byok" });
      try {
        await tuChoiVi(Z, "đối chứng: AI Builder của A khi người vận hành đã tắt AI", () => createAiDraftAction({ mode: "new", prompt: "Dựng ERP bán buôn có CRM và kho." }), new RegExp(AI_DISABLED_BY_OPERATOR), "/settings/ai-builder");
      } finally {
        setBuilderAiForTests(undefined);
      }
      assert.equal(spyTat.calls.length, 0, "AI tắt ⇒ model không được gọi");
    } finally {
      phaiDat(await setWorkflowsPaused(OP, { orgCode: A, paused: false, reason: "trả lại sau bài thử" }), "người vận hành bỏ tạm dừng luật của A");
      phaiDat(await setOrgAiControl(OP, { orgCode: A, disabled: false, reason: "trả lại sau bài thử" }), "người vận hành bật lại AI của A");
    }
    phaiDat(await setOrganizationSuspended(OP, { orgCode: A, suspend: true, reason: "đình chỉ để thử cổng" }), "người vận hành đình chỉ A");
    try {
      await attack(Z, "A (đã bị đình chỉ) tự bỏ đình chỉ (action, phiên thật)", () => setOrgSuspendedAction({ orgCode: A, suspend: false, reason: "tự mở khoá cho mình" }), { path: `/platform/org/${A}` });
      await tuChoiVi(Z, "A (đã bị đình chỉ) tự bỏ đình chỉ (lõi)", () => setOrganizationSuspended(qtA, { orgCode: A, suspend: false, reason: "tự mở khoá cho mình" }), KHONG_VAN_HANH, `/platform/org/${A}`);
      invalidateOrganizations();
      assert.equal((await findOrganization(A))?.status, "SUSPENDED", "A vẫn bị đình chỉ");
    } finally {
      phaiDat(await setOrganizationSuspended(OP, { orgCode: A, suspend: false, reason: "trả lại sau bài thử" }), "người vận hành bật lại A");
    }
    // Không một dòng nhật ký nền tảng nào mang người của A làm tác nhân (A không đổi được gì ở mặt phẳng điều khiển).
    const [cuaA] = rowsOf<{ n: number }>(await (await getPlatformDb()).execute(sql`select count(*)::int as n from platform_audit_log where actor_org_code = ${A}`));
    assert.equal(cuaA.n, 0, "platform_audit_log không có dòng nào do người của A ghi");

    // ══════════ ĐÒN 9 · PHIÊN GIẢ (claim org = ta-b, sub = quản trị B, ký bằng khoá sai) ══════════
    const F = "Phiên giả";
    await attack(F, "tạo bản ghi trong x_b_hd", () => createRecordAction("x_b_hd", { system: { title: "giả" }, custom: {} }), { token: FORGED, path: "/o/x_b_hd" });
    await attack(F, "duyệt lời duyệt của B", () => decideApproval(idB.approval, true, "giả"), { token: FORGED, path: "/alerts" });
    await attack(F, "mở /approvals rồi duyệt lời duyệt của B", async () => {
      await ApprovalsPage();
      return decideApproval(idB.approval, true, "giả");
    }, { token: FORGED, path: "/approvals" });
    await attack(F, "xác nhận hành động Copilot của B", () => confirmCopilotActions({ interactionId: idB.copilot, tokens: ["token-gia-0123456789"] }), { token: FORGED, path: "/customers" });
    await attack(F, "xuất bản trang của B", () => publishPageAction(idB.page), { token: FORGED, path: "/settings/pages" });
    await attack(F, "áp dụng nháp AI của B", () => applyAiDraftAction(idB.aiDraft, { planHash: idB.aiPlanHash, excludedKeys: [], resolutions: {} }), { token: FORGED, path: "/settings/ai-builder" });
    await attack(F, "bật kết nối của B", () => setConnectionStatusAction({ connectorKey: "lark-webhook", status: "DISABLED" }), { token: FORGED, path: "/settings/connections" });
    await attack(F, "tải tệp của B qua route", () => metadataFileGET(new Request(`http://erp.local/api/metadata/files/${idB.customerFile}`), { params: Promise.resolve({ id: idB.customerFile }) }), { token: FORGED, path: `/api/metadata/files/${idB.customerFile}` });
    await attack(F, "tải logo của B qua route", () => logoGET(), { token: FORGED, path: "/api/branding/logo" });
    await attack(F, "tải gói cấu hình của B qua route xuất", () => blueprintExportGET(), { token: FORGED, path: "/api/metadata/blueprint-export" });
    await attack(F, "mở /p/trang-b", () => DynamicPage({ params: Promise.resolve({ slug: "trang-b" }), searchParams: Promise.resolve({}) }), { token: FORGED, path: "/p/trang-b" });
    await attack(F, "huỷ đơn tay của B", () => cancelManualOrderAction(idB.order, { reason: "phiên giả huỷ" }), { token: FORGED, path: "/orders" });
    await attack(F, "sửa sản phẩm tay của B", () => updateProductAction(idB.product, { name: "giả", code: MA_SP_B, unit: "cái", retailPrice: 1, cost: null, variants: [{ id: idB.variant, sku: `${MA_SP_B}-M`, selling: true }] }), { token: FORGED, path: "/products" });
    await attack(F, "bật lại AI / đổi hạn mức AI của B", () => setOrgAiControlAction({ orgCode: B, disabled: false, limits: { requestsPerDay: 999_999 }, reason: "phiên giả đổi hạn mức" }), { token: FORGED, path: `/platform/org/${B}` });

    // ══════════ SAU: B không đổi một dòng, không request mạng nào ══════════
    globalThis.fetch = realFetch;
    assert.deepEqual(netCalls, [], "không một lượt tấn công nào được gửi request ra mạng");
    const after = await withOrganization(B, snapshotOrgDb);
    assert.deepEqual(diff(before, after), [], "CSDL của B phải y nguyên sau mọi lượt tấn công (số dòng + băm nội dung từng bảng)");
    assert.deepEqual(diff(cpBefore, await snapshotControlPlane(inviteIds)), [], "dòng mặt phẳng điều khiển của B (tổ chức, module, mã mời, nhật ký nền tảng) phải y nguyên");
    await withOrganization(B, async () => {
      assert.ok((await openActiveConnection("anthropic-byok")).ok, "B vẫn mở được khoá AI của mình");
      assert.equal((await readLogo())?.data.equals(PNG_B), true, "logo của B còn nguyên");
      assert.ok(await getPageBySlug("trang-b"), "trang của B còn xuất bản");
    });

    // ══════════ SAU · NGƯỜI VẬN HÀNH NHÀ MỞ TRANG SỨC KHOẺ CỦA B (A4 — hỗ trợ có vết, không dữ liệu nghiệp vụ) ══════════
    // Chạy SAU ảnh chụp: lượt mở chính đáng ghi đúng một dòng SUPPORT_VIEW vào nhật ký nền tảng của B. CSDL của B vẫn y
    // nguyên (xem là chỉ ĐẾM), và kết quả không chứa dữ liệu nghiệp vụ nào của B: tên khách, email, số tiền đơn, giá trị
    // field, tên sản phẩm, ghi chú đơn — tên TỔ CHỨC là dữ liệu của mặt phẳng điều khiển nên được tách riêng ra.
    const supportViews = async () => rowsOf<{ n: number }>(await (await getPlatformDb()).execute(sql`select count(*)::int as n from platform_audit_log where target_org_code = ${B} and action = 'SUPPORT_VIEW' and actor_org_code = ${home.code} and actor_email = ${OP.email}`))[0].n;
    const v0 = await supportViews();
    const bk = backupDir;
    assert.ok(bk, "thư mục trạng thái sao lưu của đòn 11 còn đó (nhà có bản sao THÀNH CÔNG)");
    const hoTro = await withEnv("ERP_BACKUP_STATUS_DIR", bk, () => loadOrgSupport(OP, B));
    assert.ok(hoTro.ok, `người vận hành nhà mở được trang sức khoẻ của B: ${serialize(hoTro)}`);
    assert.equal(await supportViews(), v0 + 1, "mỗi lượt mở trang sức khoẻ = đúng một dòng SUPPORT_VIEW mang người vận hành");
    const { organization: toChucB, ...sucKhoe } = hoTro.value;
    assert.equal(toChucB.code, B);
    const chuSucKhoe = serialize(sucKhoe);
    for (const bi of [MARK, EMAIL_KHACH_B, String(TIEN_DON_B), MA_SP_B, B_EMAIL, HOME_MARK, ...SECRETS_B]) assert.ok(!chuSucKhoe.includes(bi), `trang sức khoẻ của B mang dữ liệu nghiệp vụ / bí mật («${bi}»): ${chuSucKhoe.slice(0, 400)}`);
    assert.ok((hoTro.value.users.value?.active ?? 0) >= 1 && (hoTro.value.connections.value?.active ?? 0) >= 2, `đối chứng: trang sức khoẻ ĐO THẬT CSDL của B (người dùng, kết nối) — ${serialize({ u: hoTro.value.users, c: hoTro.value.connections })}`);
    assert.equal(hoTro.value.backup.lastSuccessAt, null, "sao lưu của B không mượn lời khai THÀNH CÔNG của nhà (đích sao lưu theo tổ chức)");
    assert.equal(hoTro.value.aiUsage.value?.requestsMonth, rowsOf<{ n: number }>(await (await getPlatformDb()).execute(sql`select coalesce(sum(requests), 0)::int as n from platform_ai_usage where org_code = ${B} and status <> 'BLOCKED_QUOTA'`))[0].n, "ô Dùng AI của B = đúng sổ mang mã B");
    const aiB = await loadOperatorOrgAi(OP, B);
    assert.ok(aiB.ok && serialize(aiB.value).includes(String(TOKEN_AI_B.input)) && !serialize(aiB.value).includes(String(TOKEN_AI_A.input)), `màn AI của người vận hành cho B: đúng sổ của B, không dòng của A — ${serialize(aiB).slice(0, 300)}`);
    assert.deepEqual(diff(after, await withOrganization(B, snapshotOrgDb)), [], "người vận hành xem sức khoẻ B chỉ ĐẾM — không ghi một dòng nào vào CSDL của B");

    const byType = new Map<string, number>();
    for (const a of log) byType.set(a.loai, (byType.get(a.loai) ?? 0) + 1);
    console.log(
      `✓ Phase 11 · H1 tấn công cô lập: phiên thật của A gọi thẳng ${log.length} mặt bằng id / khoá / slug / tệp / mã mời của B — ` +
        [...byType].map(([k, n]) => `${k} ${n}`).join(" · ") +
        ` — mọi lượt bị từ chối hoặc chỉ chạm A, 0 kết quả mang dữ liệu / bí mật của B, 0 request mạng; CSDL B (${before.size} bảng) + ${cpBefore.size} nhóm dòng mặt phẳng điều khiển (B + công tắc AI + dòng nhà) y nguyên; người vận hành nhà xem sức khoẻ B: 1 dòng SUPPORT_VIEW, 0 dữ liệu nghiệp vụ. Mặt đã tấn công: ` +
        log.map((a) => `[${a.loai}] ${a.mat} ⇒ ${a.ket}`).join("; "),
    );
  } finally {
    if (!hadReact) delete g.React;
    removeRealStores();
    globalThis.fetch = realFetch;
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    setBuilderAiForTests(undefined);
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    setAiProviderForTests(undefined);
    await (await getDb()).delete(schema.customers).where(eq(schema.customers.id, "ta-home-cus1"));
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    await cleanup();
    clearMemo();
  }
}

/** `NextRequest` tối thiểu cho route job: `nextUrl.searchParams` + `headers`. */
class NextLikeRequest extends Request {
  readonly nextUrl: URL;
  constructor(url: string) {
    super(url, { method: "POST" });
    this.nextUrl = new URL(url);
  }
}
