import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { DEFAULT_ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { grantedPermissions, type CustomRole } from "@/lib/auth/access";
import { ROLE_BUILDER_FORBIDDEN } from "@/lib/constants/access-scope";
import { TEAM_DEPARTMENT } from "@/lib/constants/departments";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import {
  checkCostFinalize,
  checkOverride,
  checkSampleReview,
  checkSendWithoutDesign,
  checkTopicTransition,
  computeCostSheet,
  COST_LINE_KINDS,
  diffCells,
  lifecycleTarget,
  LIFECYCLE_FOLLOW,
  REQUIRE_APPROVED_DESIGN_KEY,
  SAMPLE_REVIEW_DECISIONS,
  SAMPLE_STATUSES,
  SAMPLE_STATUS_TO_WORK,
  TOPIC_MESSAGE_KINDS,
  TOPIC_STATUSES,
  TOPIC_STATUS_TO_WORK,
  type SuggestedCellsSnapshot,
} from "@/lib/constants/production-os";
import { DEFAULT_SLA_MAP } from "@/lib/constants/work-sla";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { PROJECTED_SOURCES, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { createCostSheetCore, finalizeCostSheetCore, updateCostSheetDraftCore } from "@/lib/production/costing";
import { savePoPlanCore } from "@/lib/production/orders";
import { createSampleCore, reviewSampleCore, submitSampleCore } from "@/lib/production/samples";
import { addTopicMessageCore, createTopicCore, setTopicStatusCore } from "@/lib/production/topics";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import { getTopicDetail, listTopics, requireApprovedDesignFlag } from "@/lib/queries/production-os";
import type { ListParams } from "@/lib/search-params";
import { adaptProductionTopics, adaptSampleReviews, collectWorkItems } from "@/lib/queries/work-adapters";
import { setSettingJson } from "@/lib/settings";
import { saveAccessRoleSchema } from "@/lib/validation/access";

/**
 * ═══════════ COMPANY OS · AGENT C — SẢN XUẤT NỬA ĐẦU ═══════════
 *
 * topic → trao đổi → giá thành V1 nháp → V2 chốt (bất biến, V1 còn nguyên) → mẫu V1 yêu cầu sửa → V2 duyệt
 * → bản thiết kế bất biến (ảnh chụp) → lệnh sản xuất trỏ vào nó; vòng đời mẫu đi theo từng bước bằng
 * lượt chuyển SYSTEM trỏ về sự kiện gây ra nó.
 *
 * Khoá thêm: ba bảng append-only (quét mã nguồn), bảng chốt không sửa được (mã + CHECK), yêu cầu sửa /
 * loại bắt buộc ghi chú, duyệt cần `production:approve`, cờ bắt buộc bản duyệt (tắt = cảnh báo, bật = chặn
 * ĐÚNG lượt DRAFT → SENT), lý do bắt buộc khi số chốt khác gợi ý máy, giá ước tính chỉ có MỘT đường ghi,
 * việc hiện / rời hàng đợi theo nguồn.
 *
 * Không mốc thời gian tuyệt đối, không cửa sổ "N giờ trước" (luật 50, 65): mọi khẳng định đọc lại từ
 * chính dữ liệu vừa gieo; `now` chỉ dùng để chấm điểm việc.
 */

const P = "cosc-";
const NOW = new Date();

function nguon(rel: string) {
  return readFileSync(rel, "utf8");
}

function viPhamRangBuoc(ten: string) {
  return (e: unknown) => {
    const chuoi: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      chuoi.push(String((cur as { message?: string })?.message ?? cur));
      cur = (cur as { cause?: unknown })?.cause;
    }
    return chuoi.join(" | ").includes(ten);
  };
}

const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*--.*$/gm, "");

function tepMaNguon(): string[] {
  return execSync("git ls-files lib app scripts components && git ls-files --others --exclude-standard lib app scripts components", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|mjs|js|sql)$/.test(f) && existsSync(f));
}

export function testCompanyOsProductionPure() {
  // ───────── 1. Giá thành: công thức một chỗ, % hao hụt tính trên cơ sở KHÔNG lãi kép ─────────
  const c = computeCostSheet([
    { kind: "FABRIC", description: "Vải đũi", qty: 1.5, unit: "m", unitCost: 60_000 },
    { kind: "LABOR", description: "Công may", qty: 1, unit: "cái", unitCost: 35_000 },
    { kind: "WASTAGE", description: "Hao hụt", qty: 10, unit: "%", unitCost: 999 },
    { kind: "WASTAGE", description: "Hao hụt 2", qty: 5, unit: "%", unitCost: 0 },
  ]);
  assert.ok(!("error" in c));
  if (!("error" in c)) {
    assert.equal(c.base, 125_000, "cơ sở = tổng các dòng KHÔNG phải %");
    assert.deepEqual(c.lines.map((l) => l.amount), [90_000, 35_000, 12_500, 6_250], "mỗi dòng % tính trên CÙNG một cơ sở");
    assert.equal(c.total, 143_750);
    assert.equal(c.lines[2].unitCost, 0, "dòng % không mang đơn giá (số lạc không bị đọc nhầm là tiền)");
  }
  const dao = computeCostSheet([
    { kind: "WASTAGE", description: "", qty: 5, unit: "%", unitCost: 0 },
    { kind: "WASTAGE", description: "", qty: 10, unit: "%", unitCost: 0 },
    { kind: "LABOR", description: "", qty: 1, unit: "", unitCost: 35_000 },
    { kind: "FABRIC", description: "", qty: 1.5, unit: "m", unitCost: 60_000 },
  ]);
  assert.ok(!("error" in dao) && dao.total === 143_750, "đảo thứ tự dòng không được đổi tổng");
  assert.ok("error" in computeCostSheet([{ kind: "FABRIC", description: "", qty: 3, unit: "%", unitCost: 0 }]), "chỉ dòng Hao hụt được tính theo %");
  assert.ok("error" in computeCostSheet([]), "bảng rỗng không lập được");
  assert.ok("error" in computeCostSheet([{ kind: "FABRIC", description: "", qty: 1, unit: "m", unitCost: 1.5 }]), "đơn giá phải là số nguyên VND");

  // ───────── 2. Duyệt mẫu: ai được làm gì ─────────
  const base = { status: "SUBMITTED" as const, reviewerUserId: "u1", canApprove: true };
  assert.ok("error" in checkSampleReview({ ...base, decision: "APPROVE", note: "", canApprove: false }), "duyệt cần production:approve");
  assert.ok("error" in checkSampleReview({ ...base, decision: "REJECT", note: "vải co rút mạnh", canApprove: false }), "loại cũng cần production:approve");
  assert.ok("ok" in checkSampleReview({ ...base, decision: "REQUEST_CHANGES", note: "sửa cổ áo rộng thêm 1cm", canApprove: false }), "yêu cầu sửa chỉ cần production:write");
  assert.ok("error" in checkSampleReview({ ...base, decision: "REQUEST_CHANGES", note: "  " }), "yêu cầu sửa BẮT BUỘC ghi chú");
  assert.ok("error" in checkSampleReview({ ...base, decision: "REJECT", note: "" }), "loại BẮT BUỘC ghi chú");
  assert.ok("ok" in checkSampleReview({ ...base, decision: "APPROVE", note: "" }), "duyệt không bắt buộc ghi chú");
  assert.ok("error" in checkSampleReview({ ...base, decision: "APPROVE", note: "", reviewerUserId: null }), "không có đường máy: người duyệt phải có users.id");
  assert.ok("error" in checkSampleReview({ ...base, status: "IN_PROGRESS", decision: "APPROVE", note: "" }), "chỉ duyệt mẫu đã gửi");
  assert.ok("error" in checkCostFinalize({ status: "DRAFT", finalizerUserId: "u1", canApprove: false }), "chốt giá thành cần production:approve");
  assert.ok("error" in checkCostFinalize({ status: "FINAL", finalizerUserId: "u1", canApprove: true }), "bảng đã chốt không chốt lại");
  assert.ok("error" in checkCostFinalize({ status: "DRAFT", finalizerUserId: null, canApprove: true }), "chốt phải là một người");

  // ───────── 3. Vòng đời: CHỈ cạnh tiến từ trạng thái hiện tại ─────────
  assert.equal(lifecycleTarget("WINNER", "production_topic.created"), "PRODUCTION_DISCUSSION");
  assert.equal(lifecycleTarget("SELLING", "production_topic.created"), null, "mẫu đang bán mở topic tái sản xuất ⇒ KHÔNG kéo lùi vòng đời");
  assert.equal(lifecycleTarget(null, "production_topic.created"), null, "mẫu CHƯA KHAI ⇒ không tự khai hộ");
  assert.equal(lifecycleTarget("SAMPLE_REVIEW", "sample.reviewed"), "SAMPLING", "yêu cầu sửa là cạnh tiến SAMPLE_REVIEW → SAMPLING");
  assert.equal(lifecycleTarget("SELLING", "production_order.linked_design"), "PRODUCTION_PLANNING", "tái sản xuất là cạnh tiến");
  assert.equal(lifecycleTarget("WINNER", "sample.approved"), null, "nhảy cóc không được");
  for (const ev of Object.keys(LIFECYCLE_FOLLOW)) assert.equal(DOMAIN_EVENT_BY_NAME[ev]?.status, "LIVE", `${ev} làm vòng đời đi theo thì phải là sự kiện LIVE`);

  // ───────── 4. Gợi ý máy vs số chốt: KHÔNG ngưỡng ─────────
  assert.deepEqual(diffCells({ "Đen|M": 10, "Đen|L": 5 }, { "Đen|M": 10, "Đen|L": 5, "Trắng|M": 0 }), [], "ô 0 và ô vắng là một");
  assert.ok("ok" in checkOverride(null, { "Đen|M": 99 }, ""), "không có gợi ý ⇒ không có gì để so");
  const lech1 = checkOverride({ "Đen|M": 10 }, { "Đen|M": 11 }, "");
  assert.ok("error" in lech1 && lech1.diff.length === 1, "lệch MỘT sản phẩm ở MỘT ô cũng phải ghi lý do");
  const coLyDo = checkOverride({ "Đen|M": 10 }, { "Đen|M": 11 }, "Khách sỉ đặt thêm 1");
  assert.ok("ok" in coLyDo && coLyDo.reason === "Khách sỉ đặt thêm 1");
  const khop = checkOverride({ "Đen|M": 10 }, { "Đen|M": 10 }, "lý do thừa");
  assert.ok("ok" in khop && khop.reason === null, "khớp gợi ý ⇒ không lưu lý do");

  // ───────── 5. Cờ bắt buộc bản duyệt: tắt = cảnh báo, bật = chặn, CHỈ lượt DRAFT → SENT ─────────
  assert.deepEqual(checkSendWithoutDesign({ from: "DRAFT", to: "SENT", designVersionId: null, requireApprovedDesign: false }), { ok: true, warn: true });
  assert.ok("error" in checkSendWithoutDesign({ from: "DRAFT", to: "SENT", designVersionId: null, requireApprovedDesign: true }), "bật ⇒ chặn gửi xưởng");
  assert.deepEqual(checkSendWithoutDesign({ from: "DRAFT", to: "SENT", designVersionId: "d1", requireApprovedDesign: true }), { ok: true, warn: false });
  assert.deepEqual(checkSendWithoutDesign({ from: "SENT", to: "RECEIVED", designVersionId: null, requireApprovedDesign: true }), { ok: true, warn: false }, "lệnh đã gửi từ trước KHÔNG bị hồi tố");
  assert.deepEqual(checkSendWithoutDesign({ from: "DRAFT", to: "CANCELLED", designVersionId: null, requireApprovedDesign: true }), { ok: true, warn: false });

  // ───────── 6. Topic: chuyển trạng thái ─────────
  assert.deepEqual(checkTopicTransition("DISCUSSING", "DISCUSSING", {}), { ok: true, noop: true }, "bấm hai lần không ghi gì");
  assert.ok("error" in checkTopicTransition("WAITING_QUOTE", "SELECTED", { selectedOption: "A" }), "chưa có báo giá / phương án thì chưa chốt");
  assert.ok("error" in checkTopicTransition("OPTIONS_READY", "SELECTED", { selectedOption: " " }), "chốt phải nói chốt phương án nào");
  assert.ok("error" in checkTopicTransition("CLOSED", "DISCUSSING", { note: "" }), "mở lại topic đã đóng phải có lý do");

  // ───────── 7. Bản đồ trạng thái PHỦ HẾT; CHECK của migration = hằng số ─────────
  for (const s of TOPIC_STATUSES) assert.ok(TOPIC_STATUS_TO_WORK[s], `thiếu ánh xạ việc cho topic ${s}`);
  for (const s of SAMPLE_STATUSES) assert.ok(SAMPLE_STATUS_TO_WORK[s], `thiếu ánh xạ việc cho mẫu ${s}`);
  const mig = nguon("drizzle/0135_company_os_production.sql");
  const danhSach = (ten: string) => {
    const m = new RegExp(`"${ten}" CHECK \\(\\(?"[a-z_]+" IN \\(([^)]+)\\)`).exec(mig);
    assert.ok(m, `migration 0135 phải có CHECK ${ten}`);
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(danhSach("production_topics_status_check"), [...TOPIC_STATUSES]);
  assert.deepEqual(danhSach("production_topic_messages_kind_check"), [...TOPIC_MESSAGE_KINDS]);
  assert.deepEqual(danhSach("cost_sheet_lines_kind_check"), [...COST_LINE_KINDS]);
  assert.deepEqual(danhSach("samples_status_check"), [...SAMPLE_STATUSES]);
  assert.deepEqual(danhSach("sample_reviews_decision_check"), [...SAMPLE_REVIEW_DECISIONS]);
  assert.ok(!/INSERT INTO "settings"/i.test(mig) && !/UPDATE "production_orders"/i.test(mig), "0135 không gieo cờ, không backfill lệnh cũ");

  // ───────── 8. Quyền ─────────
  assert.ok(ROLE_BUILDER_FORBIDDEN.includes("production:approve"), "vai trò tuỳ chỉnh không được tự bó quyền duyệt");
  const tuBo = saveAccessRoleSchema.safeParse({ code: "TU_DUYET", name: "Tự duyệt mẫu", baseRole: "LEADER", permissions: ["production:write", "production:approve"], defaultScope: "ALL" });
  assert.equal(tuBo.success, false, "lược đồ phải từ chối bó quyền chứa production:approve");
  const tinh = grantedPermissions("LEADER", null, { id: "r", code: "X", name: "X", baseRole: "LEADER", permissions: ["production:approve", "production:write"], defaultScope: "ALL", active: true } satisfies CustomRole);
  assert.ok(!tinh.permissions.includes("production:approve") && tinh.permissions.includes("production:write"), "lúc TÍNH cũng cắt production:approve khỏi vai tuỳ chỉnh");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.MANAGER.includes("production:approve") && DEFAULT_ROLE_PERMISSIONS.MANAGER.includes("production:write"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.LEADER.includes("production:write") && !DEFAULT_ROLE_PERMISSIONS.LEADER.includes("production:approve"), "trưởng nhóm lập được, không ký được");
  for (const r of ["WAREHOUSE", "CS", "MARKETING", "ACCOUNTANT", "VIEWER"] as const) {
    assert.ok(!DEFAULT_ROLE_PERMISSIONS[r].includes("production:approve"), `${r} không có quyền duyệt mẫu`);
  }
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.WAREHOUSE.includes("production:write"), "kho không bàn giá với xưởng");

  // ───────── 9. Nguồn việc: phép chiếu, phòng theo TEAM_DEPARTMENT (luật 69), hạn lấy từ sổ nguồn ─────────
  for (const s of ["PRODUCTION_TOPIC", "SAMPLE_REVIEW"] as const) {
    assert.ok(PROJECTED_SOURCES.includes(s), `${s} là phép chiếu (SOURCE)`);
    assert.equal(WORK_SOURCE_SPEC[s].department, TEAM_DEPARTMENT.PRODUCTION, `${s} đi theo route nhóm Sản xuất (hôm nay → Kho), không gõ thẳng PRODUCTION`);
    assert.equal(DEFAULT_SLA_MAP[s]?.hours, WORK_SOURCE_SPEC[s].slaHours, `${s}: hạn mặc định LẤY LẠI từ sổ nguồn`);
    assert.equal(DEFAULT_OWNERSHIP_MAP[s]?.department, WORK_SOURCE_SPEC[s].department);
    assert.ok(WORK_SOURCE_SPEC[s].actions.every((a) => a === "OPEN_SOURCE"), `${s}: không nút "xong" nào ở hàng đợi — đóng qua action của miền`);
  }

  // ───────── 10. Quét mã nguồn ─────────
  const tep = tepMaNguon();
  assert.ok(tep.length > 200, `đọc hụt mã nguồn (${tep.length} tệp)`);
  const BAT_BIEN = { productionTopicMessages: "production_topic_messages", sampleReviews: "sample_reviews", designVersions: "design_versions" } as const;
  const viPham: string[] = [];
  const ghiDesign: string[] = [];
  const ghiGiaThanh: string[] = [];
  const ghiBaCot: string[] = [];
  const ghiGiaUocTinh: string[] = [];
  for (const f of tep) {
    const src = boChuThich(readFileSync(f, "utf8"));
    for (const [ts, sqlName] of Object.entries(BAT_BIEN)) {
      const biDanh = [`schema.${ts}`, ...[...src.matchAll(new RegExp(`const (\\w+) = schema\\.${ts}\\b`, "g"))].map((m) => m[1])];
      for (const b of biDanh) {
        if (new RegExp(`\\.(update|delete)\\(\\s*${b.replace(/\./g, "\\.")}\\b`).test(src)) viPham.push(`${f}: .update/.delete(${b})`);
        if (ts === "designVersions" && new RegExp(`\\.insert\\(\\s*${b.replace(/\./g, "\\.")}\\b`).test(src)) ghiDesign.push(f);
      }
      if (new RegExp(`\\b(update|delete\\s+from|truncate)\\s+"?${sqlName}\\b`, "i").test(src) && !f.startsWith("drizzle/")) viPham.push(`${f}: SQL ghi đè ${sqlName}`);
    }
    for (const ts of ["costSheets", "costSheetLines"]) {
      const biDanh = [`schema.${ts}`, ...[...src.matchAll(new RegExp(`const (\\w+) = schema\\.${ts}\\b`, "g"))].map((m) => m[1])];
      if (biDanh.some((b) => new RegExp(`\\.(insert|update|delete)\\(\\s*${b.replace(/\./g, "\\.")}\\b`).test(src)) && !ghiGiaThanh.includes(f)) ghiGiaThanh.push(f);
    }
    {
      // Mọi lượt .update(<bảng lệnh SX>).set({…}) / .insert(<bảng lệnh SX>).values({…}) có nhắc một trong ba cột.
      const biDanh = ["schema\\.productionOrders", ...[...src.matchAll(/const (\w+) = schema\.productionOrders\b/g)].map((m) => m[1])];
      for (const b of biDanh) {
        for (const m of src.matchAll(new RegExp(`\\.(update|insert)\\(\\s*${b}\\s*\\)\\s*\\.(set|values)\\(([\\s\\S]*?)\\)\\s*(\\.where|\\.returning|;|\\.onConflict)`, "g"))) {
          if (/\b(designVersionId|suggestedCells|overrideReason)\b/.test(m[3]) && !ghiBaCot.includes(f)) ghiBaCot.push(f);
        }
      }
    }
    if (/ESTIMATED_COST_KEY|profit\.estimatedCosts/.test(src) && /setSettingJson\(/.test(src)) ghiGiaUocTinh.push(f);
  }
  assert.deepEqual(viPham, [], "tin trao đổi / lượt duyệt / bản thiết kế đã duyệt là APPEND-ONLY");
  assert.deepEqual(ghiDesign, ["lib/production/samples.ts"], "bản thiết kế đã duyệt sinh ra DUY NHẤT từ lượt duyệt mẫu");
  assert.deepEqual(ghiGiaThanh, ["lib/production/costing.ts"], "chỉ lõi giá thành ghi hai bảng giá thành");
  assert.deepEqual(ghiBaCot, ["lib/production/orders.ts"], "ba cột bản duyệt / gợi ý / lý do của lệnh SX chỉ ghi ở lib/production/orders.ts");
  assert.deepEqual(ghiGiaUocTinh, ["lib/actions/estimated-cost.ts"], "giá ước tính chỉ có MỘT đường ghi — không có người ghi thứ hai");

  const costing = boChuThich(nguon("lib/production/costing.ts"));
  const capNhat = [...costing.matchAll(/\.update\(cs\)([\s\S]*?)\.returning/g)];
  assert.ok(capNhat.length >= 2, "phải thấy các lượt UPDATE cost_sheets");
  for (const m of capNhat) assert.match(m[1], /eq\(cs\.status, "DRAFT"\)/, "mọi UPDATE cost_sheets mang điều kiện status = 'DRAFT' — bản chốt không sửa được");
  assert.match(costing, /\.for\("update"\)[\s\S]*?cha\.status !== "DRAFT"[\s\S]*?\.delete\(cl\)/, "dòng chi phí chỉ thay SAU KHI khoá bảng cha và thấy nó còn nháp");

  for (const f of ["lib/actions/production-costing.ts", "lib/actions/production-samples.ts"]) {
    assert.match(nguon(f), /canApprove: can\(user, "production:approve"\)/, `${f}: quyền duyệt đọc từ phiên đăng nhập và truyền vào lõi`);
  }
  assert.match(nguon("app/(dashboard)/production/_components/cost-sheets.tsx"), /import \{ setEstimatedCost \} from "@\/lib\/actions\/estimated-cost"/, "nút Dùng làm giá ước tính đi qua ĐÚNG action có sẵn");
  for (const f of tep.filter((x) => x.startsWith("lib/production/"))) assert.ok(!/^\s*["']use server["'];?\s*$/m.test(nguon(f)),`${f}: lõi dịch vụ KHÔNG "use server"`);

  const hanhDongPo = boChuThich(nguon("lib/actions/production.ts"));
  const luu = hanhDongPo.slice(hanhDongPo.indexOf("export async function saveProductionOrder("), hanhDongPo.indexOf("export async function setProductionStatus("));
  assert.ok(luu.indexOf("buildMatrixForProduct(") > 0 && luu.indexOf("validatePoPlan(") > 0, "gợi ý máy TÍNH Ở MÁY CHỦ và số chốt được kiểm");
  assert.ok(luu.indexOf("validatePoPlan(") < luu.indexOf("guardSecondApproval("), "kiểm lý do TRƯỚC cổng duyệt và trước mọi lượt ghi");
  assert.ok(/if \("error" in ke\) return \{ error: ke\.error \};/.test(luu.slice(luu.indexOf("validatePoPlan("), luu.indexOf("guardSecondApproval("))), "lỗi của kiểm lý do / bản duyệt phải DỪNG lượt lưu trước cổng duyệt");
  assert.ok(!/suggestion\s*:\s*d\./.test(luu) && !/d\.suggest(ed|ion)Cells/.test(luu), "không nhận gợi ý từ trình duyệt");
  assert.match(hanhDongPo.slice(hanhDongPo.indexOf("export async function setProductionStatus(")), /checkSendWithoutDesign\(/, "gửi xưởng đi qua luật bắt buộc bản duyệt");
  const khoiValues = luu.slice(luu.indexOf("const values = {"), luu.indexOf("};", luu.indexOf("const values = {")));
  assert.ok(khoiValues.length > 20 && !/\b(designVersionId|suggestedCells|overrideReason)\b/.test(khoiValues), "ô số lượng ghi riêng; ba cột kia chỉ đi qua persistPoPlanTx");

  // Không truy vấn lợi nhuận / giá vốn / lương / sổ kho nào đọc bảng của miền này (luật 13, 15).
  const docSai = tep.filter(
    (f) => f.startsWith("lib/queries/") && /(profit|cost-engine|cost-allocation|payroll|stock|planning|marketing-daily|nominal)/.test(f) && /schema\.(costSheets|costSheetLines|samples|designVersions|productionTopics)\b/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(docSai, [], "giá thành tạm tính không được lặng lẽ vào lợi nhuận / giá vốn / tồn kho");

  console.log("✓ Company OS · C (thuần): giá thành một công thức (% không lãi kép), duyệt cần quyền + ghi chú, vòng đời chỉ cạnh tiến, lý do khi lệch gợi ý máy (không ngưỡng), cờ bản duyệt chỉ chặn DRAFT → SENT, quyền duyệt không bó được vào vai tuỳ chỉnh, ba bảng append-only, giá ước tính một đường ghi");
}

export async function testCompanyOsProductionDb(db: Db) {
  const W = `${P}writer`;
  const A = `${P}approver`;
  const writer = { id: W, label: "Trưởng nhóm kiểm C" };
  const approver = { id: A, label: "Quản lý kiểm C" };
  await db.insert(schema.users).values([
    { id: W, email: "cos-c-w@test.local", name: "Trưởng nhóm kiểm C", passwordHash: "x", role: "LEADER" },
    { id: A, email: "cos-c-a@test.local", name: "Quản lý kiểm C", passwordHash: "x", role: "MANAGER" },
  ]);
  await db.insert(schema.products).values([
    { id: `${P}p1`, name: "Đầm COSC1", customId: "COSC1" },
    { id: `${P}p2`, name: "Áo COSC2", customId: "COSC2" },
  ]);
  const [m1] = await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSC1", name: "Đầm COSC1", productId: `${P}p1`, lifecycleState: "WINNER", registeredBy: "USER" }).returning();
  const [m2] = await db.insert(schema.productModels).values({ id: `${P}m2`, code: "COSC2", name: "Áo COSC2", productId: `${P}p2`, lifecycleState: null, registeredBy: "USER" }).returning();
  const [sup] = await db.insert(schema.suppliers).values({ name: `${P}Xưởng A` }).returning({ id: schema.suppliers.id });
  const evidence = { kind: "SNAPSHOT" as const, capturedAt: NOW.toISOString(), basis: "kiểm thử", productId: `${P}p1`, orders30d: 12, ordersTotal: 40, adSpend30d: null };
  const req = { material: "Đũi", colors: ["Đen", "Trắng"], sizes: ["M", "L"], trims: "Cúc gỗ", designNotes: "Cổ V", targetPrice: 120_000, expectedQty: 300, deadline: null };

  // ═══ 1. TOPIC ═══
  assert.ok("error" in (await createTopicCore(db, { modelId: m1.id, title: "Hỏi giá", requirements: req, supplierId: null, evidence, actor: { id: null, label: "máy" } })), "mở topic phải là một người");
  const t = await createTopicCore(db, { modelId: m1.id, title: "Hỏi giá may COSC1", requirements: req, supplierId: sup.id, evidence, firstMessage: "Chào xưởng, báo giá giúp shop", actor: writer });
  assert.ok("ok" in t, "mở topic được");
  if (!("ok" in t)) return;
  assert.equal(t.lifecycle.moved, true, "WINNER → PRODUCTION_DISCUSSION đi theo khi mở topic");
  const [topicRow] = await db.select().from(schema.productionTopics).where(eq(schema.productionTopics.id, t.topicId));
  assert.equal(topicRow.status, "WAITING_QUOTE");
  assert.equal((topicRow.evidenceSnapshot as { kind?: string; basis?: string }).kind, "SNAPSHOT", "chứng cứ lưu dạng ẢNH CHỤP có nhãn");
  assert.equal((topicRow.evidenceSnapshot as { adSpend30d?: number | null }).adSpend30d, null, "chưa biết giữ nguyên null, không thành 0");

  assert.ok("error" in (await addTopicMessageCore(db, { topicId: t.topicId, kind: "QUOTE", body: "báo giá", attachments: [], quotedUnitPrice: null, actor: writer })), "báo giá phải có giá");
  assert.ok("ok" in (await addTopicMessageCore(db, { topicId: t.topicId, kind: "QUOTE", body: "Xưởng A báo 118k", attachments: ["https://anh.local/1.jpg"], quotedUnitPrice: 118_000, actor: writer })));
  assert.ok("ok" in (await addTopicMessageCore(db, { topicId: t.topicId, kind: "OPTION", body: "PA1: vải đũi Nhật · PA2: đũi TQ", attachments: [], quotedUnitPrice: null, actor: writer })));

  // Việc: topic chờ báo giá hiện ở hàng đợi.
  const truoc = await adaptProductionTopics(NOW);
  assert.ok(truoc.some((w) => w.sourceKey === t.topicId && w.status === "WAITING" && w.statusAuthority === "SOURCE"), "topic chờ báo giá là một việc (đang chờ xưởng)");

  assert.ok("error" in (await setTopicStatusCore(db, { topicId: t.topicId, to: "SELECTED", selectedOption: "PA1", actor: writer })), "WAITING_QUOTE → SELECTED không phải nước đi hợp lệ");
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: t.topicId, to: "OPTIONS_READY", actor: writer })));
  const lap = await setTopicStatusCore(db, { topicId: t.topicId, to: "OPTIONS_READY", actor: writer });
  assert.ok("ok" in lap && lap.noop, "bấm lại cùng trạng thái ⇒ noop");
  const ra = await adaptProductionTopics(NOW);
  assert.equal(ra.find((w) => w.sourceKey === t.topicId)?.status, "NEW", "có phương án ⇒ việc CẦN NGƯỜI QUYẾT");
  // Hai người đổi cùng lúc từ CÙNG một trạng thái: người sau nhận lỗi, không ghi đè lời của người trước.
  const [dua1, dua2] = await Promise.all([
    setTopicStatusCore(db, { topicId: t.topicId, to: "WAITING_DECISION", actor: writer }),
    setTopicStatusCore(db, { topicId: t.topicId, to: "DISCUSSING", actor: approver }),
  ]);
  assert.deepEqual([("ok" in dua1), ("ok" in dua2)].sort(), [false, true], "hàng rào trạng thái cũ: đúng MỘT trong hai lượt đồng thời được ghi");
  assert.ok("error" in (await setTopicStatusCore(db, { topicId: t.topicId, to: "SELECTED", selectedOption: "  ", actor: writer })), "chốt phải ghi phương án");
  await assert.rejects(() => db.update(schema.productionTopics).set({ status: "SELECTED", selectedOption: null }).where(eq(schema.productionTopics.id, t.topicId)), viPhamRangBuoc("production_topics_selected_check"), "CSDL chặn SELECTED không có phương án");
  assert.ok("ok" in (await setTopicStatusCore(db, { topicId: t.topicId, to: "SELECTED", selectedOption: "PA1: vải đũi Nhật", note: "Chốt theo giá 118k", actor: writer })));
  const msgs = await db.select().from(schema.productionTopicMessages).where(eq(schema.productionTopicMessages.topicId, t.topicId)).orderBy(asc(schema.productionTopicMessages.createdAt));
  assert.equal(msgs.length, 6, "mở đầu + báo giá + phương án + 3 lượt đổi trạng thái (noop và lượt thua hàng rào không ghi)");
  assert.equal(msgs.at(-1)?.kind, "DECISION", "chốt phương án để lại một lượt QUYẾT ĐỊNH trong luồng");
  assert.ok(!(await adaptProductionTopics(NOW)).some((w) => w.sourceKey === t.topicId), "chốt xong ⇒ việc tự rời hàng đợi (không ai đóng hộ)");

  // ═══ 2. GIÁ THÀNH ═══
  const dong = [
    { kind: "FABRIC" as const, description: "Đũi Nhật", qty: 1.4, unit: "m", unitCost: 55_000 },
    { kind: "LABOR" as const, description: "Công", qty: 1, unit: "cái", unitCost: 38_000 },
    { kind: "WASTAGE" as const, description: "Hao hụt", qty: 4, unit: "%", unitCost: 0 },
  ];
  const v1 = await createCostSheetCore(db, { modelId: m1.id, topicId: t.topicId, lines: dong, notes: "Bản đầu", actor: writer });
  assert.ok("ok" in v1 && v1.version === 1 && v1.totalUnitCost === 119_600, "V1 nháp, tổng tính ở máy chủ");
  if (!("ok" in v1)) return;
  assert.equal(v1.lifecycle.moved, true, "PRODUCTION_DISCUSSION → COSTING khi có giá thành V1");
  assert.ok("ok" in (await updateCostSheetDraftCore(db, { costSheetId: v1.costSheetId, lines: dong.slice(0, 2), notes: "Bỏ hao hụt", actor: writer })), "bản nháp sửa được");
  const v2 = await createCostSheetCore(db, { modelId: m1.id, topicId: t.topicId, lines: dong, notes: "Xưởng báo lại", actor: writer });
  assert.ok("ok" in v2 && v2.version === 2);
  if (!("ok" in v2)) return;
  assert.equal(v2.lifecycle.moved, false, "V2 không kéo vòng đời đi đâu (COSTING → COSTING không phải cạnh)");
  assert.ok("error" in (await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: writer, canApprove: false })), "chốt cần production:approve");
  assert.ok("error" in (await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: { id: null, label: "máy" }, canApprove: true })), "máy không chốt được");
  const chot = await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: approver, canApprove: true });
  assert.ok("ok" in chot && chot.totalUnitCost === 119_600);
  const truocSua = await db.select().from(schema.costSheetLines).where(eq(schema.costSheetLines.costSheetId, v2.costSheetId));
  assert.ok("error" in (await updateCostSheetDraftCore(db, { costSheetId: v2.costSheetId, lines: [{ kind: "OTHER", description: "lén", qty: 1, unit: "", unitCost: 1 }], notes: "", actor: writer })), "bảng ĐÃ CHỐT không sửa được");
  const sauSua = await db.select().from(schema.costSheetLines).where(eq(schema.costSheetLines.costSheetId, v2.costSheetId));
  assert.deepEqual(sauSua.map((l) => l.id).sort(), truocSua.map((l) => l.id).sort(), "dòng của bảng đã chốt còn nguyên");
  const [v2Row] = await db.select().from(schema.costSheets).where(eq(schema.costSheets.id, v2.costSheetId));
  assert.equal(v2Row.totalUnitCost, 119_600, "tổng bảng đã chốt không đổi");
  assert.equal(v2Row.finalizedByUserId, A, "người chốt là một users.id");
  assert.ok("error" in (await finalizeCostSheetCore(db, { costSheetId: v2.costSheetId, actor: approver, canApprove: true })), "chốt lại bảng đã chốt ⇒ lỗi");
  const [v1Row] = await db.select().from(schema.costSheets).where(eq(schema.costSheets.id, v1.costSheetId));
  assert.equal(v1Row.status, "DRAFT", "V1 vẫn còn nguyên (không bị đè bởi V2)");
  assert.equal(v1Row.totalUnitCost, 115_000, "V1 giữ số của lần sửa của nó");
  await assert.rejects(() => db.update(schema.costSheets).set({ status: "FINAL" }).where(eq(schema.costSheets.id, v1.costSheetId)), viPhamRangBuoc("cost_sheets_final_check"), "CSDL chặn FINAL không có người chốt");
  // V3 NHÁP mới hơn V2 đã chốt: bản duyệt về sau phải trỏ bảng CHỐT, không phải phiên bản mới nhất.
  const v3 = await createCostSheetCore(db, { modelId: m1.id, topicId: t.topicId, lines: [{ kind: "LABOR", description: "Xưởng B báo thử", qty: 1, unit: "", unitCost: 150_000 }], notes: "Đang hỏi xưởng khác", actor: writer });
  assert.ok("ok" in v3 && v3.version === 3);

  // ═══ 3. MẪU V1 → YÊU CẦU SỬA ═══
  const fields = { supplierId: sup.id, costVnd: 250_000, images: ["https://anh.local/mau1.jpg"], notes: "Mẫu đầu", problems: "" };
  const s1 = await createSampleCore(db, { modelId: m1.id, topicId: t.topicId, fields, actor: writer });
  assert.ok("ok" in s1 && s1.version === 1);
  if (!("ok" in s1)) return;
  assert.equal(s1.lifecycle.moved, true, "COSTING → SAMPLING");
  assert.ok("error" in (await createSampleCore(db, { modelId: m1.id, topicId: t.topicId, fields, actor: writer })), "một mẫu tối đa MỘT phiên bản đang mở");
  const g1 = await submitSampleCore(db, { sampleId: s1.sampleId, actor: writer });
  assert.ok("ok" in g1 && !g1.noop && g1.lifecycle?.moved, "SAMPLING → SAMPLE_REVIEW khi gửi duyệt");
  const g1b = await submitSampleCore(db, { sampleId: s1.sampleId, actor: writer });
  assert.ok("ok" in g1b && g1b.noop, "gửi duyệt hai lần ⇒ noop");
  assert.ok((await adaptSampleReviews(NOW)).some((w) => w.sourceKey === s1.sampleId && w.status === "NEW"), "mẫu chờ duyệt là một việc");
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "REQUEST_CHANGES", note: "", actor: writer, canApprove: false })), "yêu cầu sửa mà không nói sửa gì ⇒ từ chối");
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "APPROVE", note: null, actor: writer, canApprove: false })), "không có production:approve thì không duyệt được");
  const r1 = await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "REQUEST_CHANGES", note: "Cổ V sâu thêm 1cm", actor: writer, canApprove: false });
  assert.ok("ok" in r1 && r1.status === "CHANGES_REQUESTED" && r1.designVersionId === null);
  if (!("ok" in r1)) return;
  assert.equal(r1.lifecycle?.moved, true, "SAMPLE_REVIEW → SAMPLING (vòng sửa mẫu)");
  const [s1Row] = await db.select().from(schema.samples).where(eq(schema.samples.id, s1.sampleId));
  assert.equal(s1Row.requestedChanges, "Cổ V sâu thêm 1cm", "yêu cầu sửa chép lên mẫu để phiên bản sau đọc ngay");
  assert.ok(!(await adaptSampleReviews(NOW)).some((w) => w.sourceKey === s1.sampleId), "có phán quyết ⇒ việc rời hàng đợi");
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s1.sampleId, decision: "APPROVE", note: null, actor: approver, canApprove: true })), "mỗi phiên bản đúng MỘT phán quyết");
  await assert.rejects(
    () => db.insert(schema.sampleReviews).values({ sampleId: s1.sampleId, decision: "APPROVE", reviewerUserId: A }),
    viPhamRangBuoc("sample_reviews_sample_id_unique"),
    "CSDL chặn phán quyết thứ hai",
  );
  const [sTam] = await db.insert(schema.samples).values({ modelId: m2.id, version: 99, status: "SUBMITTED", submittedAt: NOW }).returning({ id: schema.samples.id });
  await assert.rejects(
    () => db.insert(schema.sampleReviews).values({ sampleId: sTam.id, decision: "REJECT", note: "   ", reviewerUserId: A }),
    viPhamRangBuoc("sample_reviews_note_check"),
    "CSDL chặn lượt loại mẫu không ghi chú (kể cả đường ghi đi vòng ứng dụng)",
  );
  await assert.rejects(
    () => db.insert(schema.sampleReviews).values({ sampleId: sTam.id, decision: "APPROVE", reviewerUserId: null as unknown as string }),
    () => true,
    "CSDL chặn lượt duyệt không có người duyệt",
  );
  await db.delete(schema.samples).where(eq(schema.samples.id, sTam.id));

  // ═══ 4. MẪU V2 → DUYỆT ⇒ BẢN THIẾT KẾ BẤT BIẾN ═══
  const s2 = await createSampleCore(db, { modelId: m1.id, topicId: t.topicId, fields: { ...fields, notes: "Mẫu sửa cổ", costVnd: null }, actor: writer });
  assert.ok("ok" in s2 && s2.version === 2);
  if (!("ok" in s2)) return;
  assert.ok("ok" in (await submitSampleCore(db, { sampleId: s2.sampleId, actor: writer })));
  const [chuaDuyet] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sampleReviews).where(eq(schema.sampleReviews.sampleId, s2.sampleId));
  assert.ok("error" in (await reviewSampleCore(db, { sampleId: s2.sampleId, decision: "REJECT", note: "không đẹp", actor: writer, canApprove: false })), "loại cũng cần production:approve");
  const [vanChua] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sampleReviews).where(eq(schema.sampleReviews.sampleId, s2.sampleId));
  assert.equal(Number(vanChua.n), Number(chuaDuyet.n), "lượt bị từ chối không để lại dòng duyệt nào");
  const r2 = await reviewSampleCore(db, { sampleId: s2.sampleId, decision: "APPROVE", note: null, actor: approver, canApprove: true });
  assert.ok("ok" in r2 && r2.status === "APPROVED" && r2.designVersion === 1, "duyệt ⇒ bản thiết kế V1");
  if (!("ok" in r2) || !r2.designVersionId) return;
  assert.equal(r2.lifecycle?.moved, true, "SAMPLE_REVIEW → APPROVED");
  const [dv] = await db.select().from(schema.designVersions).where(eq(schema.designVersions.id, r2.designVersionId));
  assert.equal(dv.sampleId, s2.sampleId);
  assert.equal(dv.costSheetId, v2.costSheetId, "bản duyệt trỏ bảng giá thành CHỐT mới nhất lúc duyệt");
  assert.equal(dv.approvedByUserId, A, "người duyệt là một users.id");
  const spec = dv.spec as { sample: { version: number; costVnd: number | null; supplierName: string | null }; topic: { requirements: { material: string } } | null; costSheet: { totalUnitCost: number; lines: unknown[] } | null };
  assert.equal(spec.sample.version, 2);
  assert.equal(spec.sample.costVnd, null, "tiền mẫu chưa biết giữ null trong ảnh chụp");
  assert.equal(spec.sample.supplierName, `${P}Xưởng A`);
  assert.equal(spec.topic?.requirements.material, "Đũi", "ảnh chụp mang yêu cầu của topic");
  assert.equal(spec.costSheet?.totalUnitCost, 119_600);
  assert.equal(spec.costSheet?.lines.length, 3, "ảnh chụp chép dòng giá thành");
  // Sửa topic về sau KHÔNG đổi bản đã duyệt.
  await db.update(schema.productionTopics).set({ requirements: { ...req, material: "Lụa" } }).where(eq(schema.productionTopics.id, t.topicId));
  const [dvSau] = await db.select({ spec: schema.designVersions.spec }).from(schema.designVersions).where(eq(schema.designVersions.id, dv.id));
  assert.equal((dvSau.spec as typeof spec).topic?.requirements.material, "Đũi", "bản thiết kế đã duyệt là ẢNH CHỤP bất biến");
  const suKienDuyet = await db.select({ name: schema.domainEvents.name, actorKind: schema.domainEvents.actorKind, actorId: schema.domainEvents.actorId }).from(schema.domainEvents).where(inArray(schema.domainEvents.subjectId, [s2.sampleId, dv.id]));
  assert.deepEqual(suKienDuyet.map((e) => e.name).sort(), ["design_version.approved", "sample.approved", "sample.created", "sample.reviewed", "sample.submitted"], "đủ chuỗi sự kiện của mẫu V2");
  assert.ok(suKienDuyet.every((e) => e.actorKind === "USER" && e.actorId), "sự kiện của người mang khoá tài khoản");

  // ═══ 5. LỆNH SẢN XUẤT TRỎ BẢN DUYỆT · GỢI Ý MÁY vs SỐ CHỐT ═══
  const cells = { "Đen|M": 120, "Đen|L": 80, "Trắng|M": 60 };
  await db.insert(schema.productionOrders).values({ id: `${P}po1`, code: `${P}PO-1`, productId: `${P}p1`, productName: "Đầm COSC1", colors: ["Đen", "Trắng"], sizes: ["M", "L"], cells, totalQty: 260 });
  const goiY: SuggestedCellsSnapshot = { cells: { "Đen|M": 100, "Đen|L": 80, "Trắng|M": 60 }, basis: { source: "buildMatrixForProduct", coverDays: 30, countIncoming: true, leadTimeDays: 20 }, computedAt: NOW.toISOString() };
  const [s3] = await db.insert(schema.samples).values({ modelId: m2.id, version: 1, status: "APPROVED", submittedAt: NOW, decidedAt: NOW }).returning({ id: schema.samples.id });
  const [rv3] = await db.insert(schema.sampleReviews).values({ sampleId: s3.id, decision: "APPROVE", reviewerUserId: A }).returning({ id: schema.sampleReviews.id });
  const [dvKhac] = await db.insert(schema.designVersions).values({ modelId: m2.id, sampleId: s3.id, reviewId: rv3.id, version: 1, spec: {}, approvedByUserId: A }).returning({ id: schema.designVersions.id });
  assert.ok("error" in (await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: dvKhac.id, suggestion: null, overrideReason: null, actor: writer })), "lệnh chỉ trỏ được bản duyệt của CHÍNH mẫu đang đặt");
  const thieuLyDo = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: dv.id, suggestion: goiY, overrideReason: "", actor: writer });
  assert.ok("error" in thieuLyDo && thieuLyDo.diff?.length === 1, "lệch gợi ý máy ở một ô ⇒ bắt buộc lý do, và chỉ ra ô lệch");
  const [poChuaDoi] = await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po1`));
  assert.equal(poChuaDoi.designVersionId, null, "lỗi ⇒ không cột nào bị ghi");
  const lienKet = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: dv.id, suggestion: goiY, overrideReason: "Khách sỉ đặt thêm 20 Đen M", actor: writer });
  assert.ok("ok" in lienKet && lienKet.lifecycle?.moved, "APPROVED → PRODUCTION_PLANNING khi lệnh trỏ bản duyệt");
  const [po] = await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po1`));
  assert.equal(po.designVersionId, dv.id);
  assert.deepEqual(po.suggestedCells?.cells, goiY.cells, "ảnh chụp gợi ý máy lưu trên lệnh");
  assert.equal(po.overrideReason, "Khách sỉ đặt thêm 20 Đen M");
  const demSuKienPo = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.domainEvents).where(eq(schema.domainEvents.subjectId, `${P}po1`)))[0].n);
  assert.equal(await demSuKienPo(), 2, "linked_design + plan.overridden");
  const lai = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: dv.id, suggestion: goiY, overrideReason: "Khách sỉ đặt thêm 20 Đen M", actor: writer });
  assert.ok("ok" in lai && lai.lifecycle === null, "lưu lại y hệt ⇒ không sự kiện mới, vòng đời không đi đâu");
  assert.equal(await demSuKienPo(), 2, "lưu lại y hệt không đẻ sự kiện thứ hai");
  const khopGoiY = await savePoPlanCore(db, { poId: `${P}po1`, designVersionId: dv.id, suggestion: { ...goiY, cells }, overrideReason: "thừa", actor: writer });
  assert.ok("ok" in khopGoiY);
  const [poKhop] = await db.select({ overrideReason: schema.productionOrders.overrideReason }).from(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po1`));
  assert.equal(poKhop.overrideReason, null, "khớp gợi ý ⇒ không lưu lý do");

  // ═══ 6. CHUỖI VÒNG ĐỜI: SYSTEM + sự kiện gây ra ═══
  const hist = await db
    .select({ from: schema.productModelStateHistory.fromState, to: schema.productModelStateHistory.toState, actorKind: schema.productModelStateHistory.actorKind, actorId: schema.productModelStateHistory.actorId, ev: schema.domainEvents.name })
    .from(schema.productModelStateHistory)
    .leftJoin(schema.domainEvents, eq(schema.domainEvents.id, schema.productModelStateHistory.sourceEventId))
    .where(eq(schema.productModelStateHistory.modelId, m1.id))
    .orderBy(asc(schema.productModelStateHistory.occurredAt), asc(schema.productModelStateHistory.id));
  assert.deepEqual(
    hist.map((h) => `${h.from}>${h.to}@${h.ev}`),
    [
      "WINNER>PRODUCTION_DISCUSSION@production_topic.created",
      "PRODUCTION_DISCUSSION>COSTING@costing.version_created",
      "COSTING>SAMPLING@sample.created",
      "SAMPLING>SAMPLE_REVIEW@sample.submitted",
      "SAMPLE_REVIEW>SAMPLING@sample.reviewed",
      "SAMPLING>SAMPLE_REVIEW@sample.submitted",
      "SAMPLE_REVIEW>APPROVED@sample.approved",
      "APPROVED>PRODUCTION_PLANNING@production_order.linked_design",
    ],
    "vòng đời đi theo đúng chuỗi, mỗi bước trỏ về sự kiện gây ra nó",
  );
  assert.ok(hist.every((h) => h.actorKind === "SYSTEM" && h.actorId === null), "lượt chuyển do luật ghi là SYSTEM — người bấm không đứng tên lượt đổi vòng đời");

  // Mẫu CHƯA KHAI: hành động sản xuất KHÔNG tự khai vòng đời hộ.
  const t2 = await createTopicCore(db, { modelId: m2.id, title: "Hỏi giá COSC2", requirements: req, supplierId: null, evidence, actor: writer });
  assert.ok("ok" in t2 && !t2.lifecycle.moved && t2.lifecycle.reason === "UNDECLARED");
  const [{ n: hist2 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, m2.id));
  assert.equal(Number(hist2), 0, "không một dòng lịch sử nào cho mẫu chưa khai");

  // ═══ 7. HÀNG ĐỢI CHUNG + HÀM ĐỌC CHO TRANG 360 ═══
  const hangDoi = await collectWorkItems({ sources: ["PRODUCTION_TOPIC", "SAMPLE_REVIEW"], now: NOW });
  assert.deepEqual(hangDoi.failed, []);
  assert.ok(hangDoi.items.some((w) => "ok" in t2 && w.sourceKey === t2.topicId && w.department === TEAM_DEPARTMENT.PRODUCTION), "topic mở hiện ở hàng đợi, đúng phòng đang route");
  assert.ok(!hangDoi.items.some((w) => w.sourceKey === t.topicId || w.sourceKey === s2.sampleId), "việc đã xử lý ở nguồn không còn ở hàng đợi");
  const tomTat = await getModelProductionSummary(m1.id);
  assert.ok(tomTat);
  if (tomTat) {
    assert.equal(tomTat.openTopics, 0);
    assert.equal(tomTat.finalCosting?.version, 2);
    assert.equal(tomTat.draftCostings, 2, "V1 và V3 nháp vẫn được đếm");
    assert.equal(tomTat.latestSample?.version, 2);
    assert.equal(tomTat.approvedDesign?.id, dv.id);
    assert.deepEqual(tomTat.openOrders.map((o) => [o.code, o.plannedQty, o.receivedViaLinkedReceipts]), [[`${P}PO-1`, 260, null]], "chưa có phiếu nhập nối vào lệnh ⇒ đã nhận CHƯA BIẾT (null), không phải 0");
  }

  // Hàm đọc của màn hình chạy được trên dữ liệu thật (câu con tương quan không được mơ hồ cột).
  const ds = await listTopics({ page: 1, pageSize: 25, sort: "updatedAt", dir: "desc", q: "COSC", filters: {}, period: { from: null, to: null, key: "all", label: "", fromKey: null, toKey: null } } satisfies ListParams);
  const dong1 = ds.rows.find((r) => r.id === t.topicId);
  assert.equal(dong1?.messages, 6, "danh sách đếm đúng số lượt trao đổi của TỪNG topic");
  assert.equal(dong1?.lastQuote, 118_000, "báo giá gần nhất đọc từ lượt QUOTE");
  const chiTiet = await getTopicDetail(t.topicId);
  assert.equal(chiTiet?.costSheets.length, 3);
  assert.equal(chiTiet?.samples.find((x) => x.id === s2.sampleId)?.design?.id, dv.id, "trang topic thấy bản duyệt sinh từ mẫu V2");

  // ═══ 8. CỜ BẮT BUỘC BẢN DUYỆT: chỉ đúng boolean true ═══
  assert.equal(await requireApprovedDesignFlag(), false, "không có dòng settings ⇒ TẮT");
  await setSettingJson(REQUIRE_APPROVED_DESIGN_KEY, "true");
  assert.equal(await requireApprovedDesignFlag(), false, "chuỗi 'true' không bật được cờ");
  await setSettingJson(REQUIRE_APPROVED_DESIGN_KEY, true);
  assert.equal(await requireApprovedDesignFlag(), true);

  // ═══ DỌN: hàng đợi và cờ trả về như trước (bảng append-only / chữ ký giữ nguyên — CSDL dùng một lần) ═══
  await db.delete(schema.settings).where(eq(schema.settings.key, REQUIRE_APPROVED_DESIGN_KEY));
  if ("ok" in t2) await setTopicStatusCore(db, { topicId: t2.topicId, to: "CLOSED", actor: writer });
  await db.update(schema.productionOrders).set({ status: "CANCELLED" }).where(like(schema.productionOrders.id, `${P}%`));
  assert.equal((await adaptProductionTopics(NOW)).filter((w) => w.title.includes("COSC")).length, 0, "dọn xong: không còn việc sản xuất nào của bài kiểm");
  const [conMo] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.samples).where(and(like(schema.samples.modelId, `${P}%`), eq(schema.samples.status, "SUBMITTED")));
  assert.equal(Number(conMo.n), 0);

  console.log(
    `✓ Company OS · C (CSDL): topic → ${msgs.length} lượt trao đổi → giá thành V1 nháp / V2 chốt bất biến → mẫu V1 yêu cầu sửa → V2 duyệt ⇒ bản thiết kế V${dv.version} (ảnh chụp) → lệnh SX trỏ vào; vòng đời ${hist.length} bước SYSTEM trỏ sự kiện; việc hiện / rời hàng đợi theo nguồn; cờ bản duyệt chỉ nhận boolean true`,
  );
}
