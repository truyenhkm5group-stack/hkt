/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC CẤU HÌNH MỘT TỔ CHỨC — PHÁN QUYẾT THUẦN (Commercial readiness C) ═══════════
 *
 * `scripts/restore-drill-org-config.ts` dựng MỘT tổ chức thử, cài mẫu + tuỳ biến, xuất blueprint ra tệp, XOÁ hẳn tổ
 * chức (dòng sổ + CSDL), cấp lại CÙNG mã ở dạng trống, cài lại từ tệp, xuất lại. Tệp này KHÔNG đọc / ghi CSDL: nó nhận
 * bằng chứng của hai tiến trình ấy và trả lời một câu — lượt diễn tập ĐẠT hay KHÔNG, và nếu không thì vì sao.
 *
 * Phán quyết tách khỏi kịch bản để bài kiểm đột biến được từng vế (tests/restore-drill-config.test.ts): một phép so
 * luôn-đúng — ví dụ quên kiểm "tổ chức trống khác tổ chức nguồn" — làm diễn tập xanh mà không chứng minh gì.
 */
import { stableStringify } from "@/lib/blueprints/hash";

/**
 * Bảng CẤU HÌNH / METADATA của một tổ chức. Đều là bảng của lược đồ chung (`db/schema.ts`), nên có mặt trong MỌI CSDL
 * tổ chức (`migrateOrganizationDb` chạy cùng bộ migration) và được ghi qua `getDb()` — tức CSDL `erp_org_<mã>` của
 * tổ chức NGỮ CẢNH. `scripts/erp-backup.sh` dump nguyên CSDL ấy (`pg_dump -d erp_org_<mã> -Fc`, không lọc bảng / lược
 * đồ), nên mọi dòng ở đây đi theo bản sao lưu đêm. Diễn tập ĐO điều đó: sau khi tuỳ biến, bảng có dòng trong CSDL tổ
 * chức và KHÔNG thêm dòng nào ở CSDL nhà.
 */
export const ORG_CONFIG_TABLES = [
  "meta_objects",
  "meta_custom_fields",
  "meta_forms",
  "meta_list_views",
  "meta_pages",
  "meta_status_overrides",
  "meta_config_versions",
  "custom_records",
  "custom_values",
  "custom_files",
  "workflow_rules",
  "workflow_runs",
  "workflow_cursors",
  "blueprint_installs",
  "blueprint_items",
  "ai_blueprint_drafts",
  "org_connections",
  "access_roles",
  "settings",
  "users",
] as const;
export type OrgConfigTable = (typeof ORG_CONFIG_TABLES)[number];

/**
 * Bảng mà kịch bản diễn tập CHẮC CHẮN ghi (mẫu `service-business` + tuỳ biến tay + một bản ghi dữ liệu). Bảng nào ở
 * đây mà CSDL tổ chức vẫn rỗng sau khi tuỳ biến ⇒ phép đo phạm vi đang đo nhầm chỗ, diễn tập KHÔNG đạt.
 */
export const DRILL_WRITTEN_TABLES = [
  "meta_objects",
  "meta_custom_fields",
  "meta_pages",
  "meta_status_overrides",
  "custom_records",
  "workflow_rules",
  "blueprint_installs",
  "blueprint_items",
  "access_roles",
  "settings",
  "users",
] as const satisfies readonly OrgConfigTable[];

/**
 * Mặt phẳng điều khiển. Chỉ THẬT ở CSDL nhà (`getPlatformDb()`); trong CSDL tổ chức `migrateOrganizationDb` xoá sạch
 * mỗi lần mở — một bản dump tổ chức không bao giờ mang sổ tổ chức, module đang bật hay mã mời. Chúng đi theo bản sao
 * của NHÀ (`pg_dump -d erp`).
 */
export const CONTROL_PLANE_TABLES = [
  "platform_organizations",
  "platform_organization_modules",
  "platform_flag_overrides",
  "platform_audit_log",
  "platform_plans",
  "platform_signup_invites",
  "platform_signup_attempts",
  "platform_settings",
  "platform_ai_usage",
  "platform_subscriptions",
  "platform_invoices",
  "platform_billing_payments",
  "platform_identities",
  "platform_saas_daily",
  "platform_org_milestones",
  "platform_tenant_usage_daily",
  "platform_messenger_pages",
  "platform_phone_otps",
] as const;
export type ControlPlaneTable = (typeof CONTROL_PLANE_TABLES)[number];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Quét chuỗi của một gói: không chuỗi cấm (bí mật, giá trị bản ghi, mật khẩu), không email, không id nội bộ. Trả danh
 * sách chỗ rò (rỗng = sạch). Dùng chung cho `tests/org-export.test.ts` và kịch bản diễn tập — một định nghĩa "rò".
 */
export function blueprintLeaks(bp: unknown, forbidden: readonly string[]): string[] {
  const text = JSON.stringify(bp);
  const out: string[] = [];
  for (const s of forbidden) if (text.includes(s)) out.push(`chứa «${s}»`);
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (emails) out.push(`có email: ${[...new Set(emails)].join(", ")}`);
  const uuid = UUID.exec(text);
  if (uuid) out.push(`có id nội bộ ${uuid[0]}`);
  return out;
}

export type ExportCounts = Record<string, number>;

/** Bằng chứng của tiến trình NGUỒN: tổ chức thử đã cài + tuỳ biến, rồi xuất. */
export type SourceEvidence = {
  orgCode: string;
  contentHash: string;
  fileSha256: string;
  fileBytes: number;
  valid: boolean;
  counts: ExportCounts;
  omitted: number;
  lossy: number;
  /** Bản ghi dữ liệu có trong CSDL nguồn — phải > 0 để câu "dữ liệu không đi theo gói" được thử thật. */
  customRecords: number;
  /** Dòng của từng bảng cấu hình trong CSDL TỔ CHỨC sau khi tuỳ biến. */
  orgRows: Record<OrgConfigTable, number | null>;
  /** Dòng THÊM ở cùng bảng trong CSDL NHÀ trong suốt lượt tuỳ biến (sau − trước). */
  homeDelta: Record<OrgConfigTable, number | null>;
  /** Dòng mặt phẳng điều khiển trong CSDL TỔ CHỨC — phải 0 hết. */
  controlPlaneRowsInOrg: Record<ControlPlaneTable, number | null>;
  /** Dòng sổ tổ chức + module THÊM ở CSDL nhà cho tổ chức này — phải > 0 (nó sống ở nhà). */
  registryDeltaInHome: number;
  /** Số bảng lược đồ `public` ở CSDL tổ chức và CSDL nhà — một lược đồ, nên phải bằng nhau. */
  orgTableCount: number;
  homeTableCount: number;
};

/** Bằng chứng của tiến trình KHÔI PHỤC: CSDL tổ chức đã mất, cấp lại cùng mã ở dạng trống, cài từ tệp, xuất lại. */
export type RestoreEvidence = {
  orgCode: string;
  /** Thư mục / CSDL của tổ chức KHÔNG còn lúc tiến trình khôi phục bắt đầu. */
  orgDatabaseGone: boolean;
  /** Dòng sổ tổ chức KHÔNG còn lúc bắt đầu (xoá cả ở mặt phẳng điều khiển). */
  registryGone: boolean;
  fileSha256: string;
  emptyContentHash: string;
  customRecordsBefore: number;
  planOk: boolean;
  conflicts: number;
  blocked: number;
  installOk: boolean;
  installErrors: string[];
  contentHash: string;
  valid: boolean;
  counts: ExportCounts;
  customRecordsAfter: number;
  /** Xem trước lại CÙNG tệp sau khi cài: số mục còn phải tạo / sửa — phải 0. */
  reinstallWrites: number;
  leaks: string[];
};

export type DrillVerdict = { ok: boolean; failures: string[] };

/** Phán quyết. Mỗi vế hỏng là MỘT câu nói rõ hỏng ở đâu; rỗng ⇒ ĐẠT. */
export function judgeConfigRestoreDrill(src: SourceEvidence, res: RestoreEvidence): DrillVerdict {
  const f: string[] = [];
  // ── Nguồn ──
  if (!src.valid) f.push("Gói xuất từ tổ chức nguồn KHÔNG qua validateBlueprint.");
  if (!(src.customRecords > 0)) f.push("Tổ chức nguồn không có bản ghi dữ liệu nào — câu «dữ liệu không đi theo gói» chưa được thử.");
  for (const t of DRILL_WRITTEN_TABLES) {
    const n = src.orgRows[t];
    if (!(typeof n === "number" && n > 0)) f.push(`Bảng ${t} RỖNG / không đọc được trong CSDL tổ chức sau khi tuỳ biến — phép đo phạm vi đang đo nhầm chỗ.`);
  }
  for (const t of Object.keys(src.homeDelta) as OrgConfigTable[]) {
    const n = src.homeDelta[t];
    if (n === null) f.push(`Không đếm được bảng ${t} ở CSDL nhà — CHƯA BIẾT cấu hình có rò sang nhà không.`);
    else if (n !== 0) f.push(`Tuỳ biến tổ chức ghi ${n} dòng vào bảng ${t} của CSDL NHÀ — cấu hình tổ chức không nằm trọn trong CSDL của nó, bản dump tổ chức sẽ thiếu.`);
  }
  for (const t of Object.keys(src.controlPlaneRowsInOrg) as ControlPlaneTable[]) {
    const n = src.controlPlaneRowsInOrg[t];
    if (n === null) f.push(`Không đếm được bảng ${t} trong CSDL tổ chức.`);
    else if (n !== 0) f.push(`CSDL tổ chức có ${n} dòng ${t} — mặt phẳng điều khiển chỉ được sống ở CSDL nhà.`);
  }
  if (!(src.registryDeltaInHome > 0)) f.push("Sổ tổ chức / module không có dòng nào ở CSDL nhà cho tổ chức thử — không chứng minh được mặt phẳng điều khiển đi theo bản sao của nhà.");
  if (!(src.orgTableCount > 0) || src.orgTableCount !== src.homeTableCount) f.push(`CSDL tổ chức có ${src.orgTableCount} bảng, CSDL nhà ${src.homeTableCount} — hai CSDL phải cùng một lược đồ.`);
  // ── Mất ──
  if (!res.orgDatabaseGone) f.push("CSDL tổ chức VẪN CÒN lúc khôi phục bắt đầu — đây không phải diễn tập mất CSDL.");
  if (!res.registryGone) f.push("Dòng sổ tổ chức VẪN CÒN lúc khôi phục bắt đầu — module có thể đến từ sổ cũ chứ không từ tệp.");
  if (res.fileSha256 !== src.fileSha256) f.push("Tệp đọc lúc khôi phục KHÁC tệp đã xuất (sha256 lệch).");
  // ── Khôi phục ──
  if (res.emptyContentHash === src.contentHash) f.push("Tổ chức TRỐNG đã có cùng băm với nguồn — phép so băm mù, không chứng minh được gì.");
  if (res.customRecordsBefore !== 0) f.push(`Tổ chức cấp lại không trống: ${res.customRecordsBefore} bản ghi có sẵn.`);
  if (!res.planOk) f.push("Kế hoạch cài từ tệp có bước BỊ CHẶN / không hợp lệ.");
  if (res.conflicts !== 0) f.push(`Kế hoạch cài từ tệp có ${res.conflicts} XUNG ĐỘT trên tổ chức trống.`);
  if (res.blocked !== 0) f.push(`Kế hoạch cài từ tệp có ${res.blocked} bước BỊ CHẶN.`);
  if (!res.installOk) f.push(`Cài từ tệp THẤT BẠI: ${res.installErrors.join(" · ") || "không rõ lỗi"}`);
  if (!res.valid) f.push("Gói xuất lại sau khôi phục KHÔNG qua validateBlueprint.");
  if (res.contentHash !== src.contentHash) f.push(`Băm nội dung sau khôi phục ${res.contentHash} ≠ nguồn ${src.contentHash} — cấu hình KHÔNG được khôi phục nguyên vẹn.`);
  if (stableStringify(res.counts) !== stableStringify(src.counts)) f.push(`Số mục theo loại lệch: nguồn ${stableStringify(src.counts)} · khôi phục ${stableStringify(res.counts)}.`);
  if (res.reinstallWrites !== 0) f.push(`Cài lại cùng tệp còn ${res.reinstallWrites} mục phải ghi — khôi phục chưa hội tụ.`);
  if (res.customRecordsAfter !== 0) f.push(`Sau khôi phục có ${res.customRecordsAfter} bản ghi — gói cấu hình đã mang DỮ LIỆU.`);
  for (const l of res.leaks) f.push(`Gói rò: ${l}`);
  return { ok: f.length === 0, failures: f };
}
