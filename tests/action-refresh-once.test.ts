import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ═══════════ LƯU XONG LÀ MỘT LƯỢT DỰNG TRANG, KHÔNG PHẢI HAI ═══════════
 *
 * Cùng gốc với ô đặt số dự tính (tests/report-override-latency.test.ts, 25/09/2026): trên Next 15,
 * server action gọi `revalidatePath(...)` thì TRẢ LUÔN giao diện mới của trang hiện tại trong cùng
 * lượt gọi. Component nào còn gọi `router.refresh()` ngay sau đó là tự gây ra một lượt dựng NGUỘI thứ
 * hai (đệm vừa bị xoá), và nút Lưu quay suốt cả hai lượt.
 *
 * Bài này khoá hai điều, CHỈ trên các tệp đã được soát tay (không phải lệnh cấm toàn kho):
 *  1. Tệp đã gỡ hết `router.refresh()` không được mọc lại nó; tệp còn giữ một số lượt refresh CÓ LÝ
 *     DO (action có nhánh thành công không `revalidatePath`, hoặc không phủ trang đang đứng) giữ đúng
 *     số lượng đó — thêm một lượt mới thì phải soát lại action của nó rồi mới sửa con số ở đây.
 *  2. ĐIỀU KIỆN để bỏ refresh là an toàn vẫn còn: action của các tệp ấy vẫn `revalidatePath` đúng
 *     trang chứa component. Ai gỡ dòng đó ở action thì bài này đỏ — lúc ấy trang sẽ không tự cập nhật.
 *  3. (Đợt 2, 26/09/2026) Nhánh thành công TRẢ SỚM ("không đổi gì", "người khác đã làm", `noop`,
 *     `skipped`, `replayed`, `count 0`) cũng làm mới NGAY TRƯỚC `return` của nó. Trước đây các nhánh ấy
 *     trả `{ ok: true }` trơn nên client phải giữ `router.refresh()` — mà chính lúc đó trang đang cũ
 *     thật (người khác vừa làm). Nay lượt gọi mang luôn giao diện mới: cùng hiệu ứng, một lượt đi-về.
 */
const doc = (p: string) => readFileSync(p, "utf8");
const boChuThich = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const demRefresh = (f: string) => (boChuThich(doc(f)).match(/router\.refresh\s*\(/g) ?? []).length;

const D = "app/(dashboard)/";

/** Đã gỡ HẾT `router.refresh()` — mọi lượt refresh cũ đều đứng sau một action đã revalidate trang này. */
const SACH: string[] = [
  "alerts/alerts-actions.tsx",
  "alerts/approval-actions.tsx",
  "alerts/approval-enforce-toggle.tsx",
  "alerts/marketing-digest-form.tsx",
  "bank/accounts-tab.tsx",
  "bank/import-tab.tsx",
  "bank/manual-dialog.tsx",
  "bank/match-actions.tsx",
  "bank/supplier-link-dialog.tsx",
  "bank/unlink-button.tsx",
  "cockpit/decision-controls.tsx",
  "cs/case-dialog.tsx",
  "cs/cs-table.tsx",
  "cs/customer-queue-table.tsx",
  "data-quality/receive-returns.tsx",
  "expenses/ad-spend-dialog.tsx",
  "expenses/ads-billing.tsx",
  "expenses/allocation-dialog.tsx",
  "expenses/campaign-mapping.tsx",
  "expenses/expense-dialog.tsx",
  "expenses/row-actions.tsx",
  "finance-ops/link-existing-dialog.tsx",
  "finance-ops/queue-actions.tsx",
  "ideas/feedback-form.tsx",
  "ideas/idea-form.tsx",
  "ideas/idea-manage.tsx",
  "inventory/planning/orders/[id]/order-actions.tsx",
  "inventory/planning/planning-form.tsx",
  "inventory/planning/slow-moving-rules-editor.tsx",
  "inventory/purchasing/supplier-catalog.tsx",
  "inventory/receipts/delete-receipt-button.tsx",
  "inventory/receipts/receipt-dialog.tsx",
  "inventory/returns/disposition-section.tsx",
  "inventory/returns/exception-queues.tsx",
  "inventory/returns/hmt-upload.tsx",
  "inventory/returns/inspection-station.tsx",
  "inventory/returns/item-inspection-drawer.tsx",
  "inventory/returns/receive-queue.tsx",
  "inventory/returns/unidentified-section.tsx",
  "inventory/shortage/decision-buttons.tsx",
  "inventory/workshop/marketer-price-forms.tsx",
  "inventory/workshop/sheet-import-dialog.tsx",
  "inventory/workshop/workshop-forms.tsx",
  "landing/import-button.tsx",
  "landing/landing-config.tsx",
  "landing/landing-table.tsx",
  "marketing/creatives/batch-actions.tsx",
  "marketing/creatives/config-form.tsx",
  "marketing/creatives/copy-editor.tsx",
  "marketing/creatives/design-actions.tsx",
  "marketing/creatives/import-buttons.tsx",
  "marketing/creatives/kill-switch.tsx",
  "marketing/creatives/live-actions.tsx",
  "marketing/creatives/manual-form.tsx",
  "marketing/creatives/names-editor.tsx",
  "marketing/creatives/scale-actions.tsx",
  "marketing/creatives/source-form.tsx",
  "marketing/creatives/variant-select.tsx",
  "marketing/fanpages/assign-panel.tsx",
  "marketing/fanpages/reconcile-button.tsx",
  "models/[id]/model-controls.tsx",
  "models/[id]/suggestion-transition.tsx",
  "models/registry-actions.tsx",
  "my-payslip/respond-form.tsx",
  "outreach/outreach-config.tsx",
  "outreach/outreach-table.tsx",
  "payroll/adjustments/adjustment-manager.tsx",
  "payroll/assignments/assignment-manager.tsx",
  "payroll/employee-dialog.tsx",
  "payroll/finalize-button.tsx",
  "payroll/migration/migration-table.tsx",
  "payroll/policies/policy-manager.tsx",
  "payroll/product-owners-form.tsx",
  "payroll/run-workflow.tsx",
  "payroll/settings/settings-form.tsx",
  "production/_components/cost-sheets.tsx",
  "production/_components/samples-panel.tsx",
  "production/topics/[id]/topic-controls.tsx",
  "reports/returns/action-board.tsx",
  "settings/users/access-cell.tsx",
  "settings/users/department-cell.tsx",
  "settings/users/permissions-dialog.tsx",
  "settings/users/positions-panel.tsx",
  "settings/users/revoke-sessions-dialog.tsx",
  "settings/users/role-matrix.tsx",
  "settings/users/roles-panel.tsx",
  "settings/users/user-dialog.tsx",
  "settings/users/users-table.tsx",
  "shipments/reconcile-panel.tsx",
  "tech/agents/agent-controls.tsx",
  "tech/deployments/deployment-form.tsx",
  "tech/incidents/[id]/incident-actions.tsx",
  "tech/incidents/incident-form.tsx",
  "tech/tasks/[id]/request-fix.tsx",
  "tech/tasks/[id]/run-verdict.tsx",
  "tech/tasks/[id]/task-actions.tsx",
  "tech/tasks/bulk-approve.tsx",
  "tech/tasks/task-form.tsx",
  "work/okr/toolbar.tsx",
  "work/review/panel.tsx",
  "work/settings/logistics-panel.tsx",
  "work/settings/panels.tsx",
  "work/settings/people-panel.tsx",
  "work/settings/reason-groups-panel.tsx",
  "work/settings/rules-panel.tsx",
  "work/settings/staffing-panel.tsx",
  "work/settings/targets-panel.tsx",
  "work/settings/weights-panel.tsx",
  "work/today/panels.tsx",
].map((f) => D + f).concat(["components/ai-copilot.tsx", "components/work/bsc-editor.tsx", "components/work/manual-task-dialog.tsx", "components/work/okr-editor.tsx", "components/work/work-list.tsx"]);

/**
 * Còn giữ refresh CÓ LÝ DO — số lượng phải đúng bằng số lượt được giữ: action lỗi GIỮA CHỪNG sau
 * khi đã ghi (không revalidate), action dùng chung với một màn hình cố ý không dựng lại, hoặc refresh
 * theo đồng hồ.
 */
const GIU: Record<string, number> = {
  "marketing/creatives/manual-gen.tsx": 1, // đồng hồ 8 giây theo dõi lượt gen — không đứng sau action
  "tech/cto/cto-controls.tsx": 1, // approveTechProposalAction: lỗi giữa chừng SAU khi đã tạo việc, không revalidate
  // requestCarrierAction: bàn làm việc care (workbench.tsx) gọi CÙNG action và cố ý KHÔNG dựng lại cả
  // hàng đợi sau mỗi dòng — thêm revalidatePath vào action là bắt bàn ấy dựng lại mỗi cú bấm.
  "shipments/care-drawer.tsx": 1,
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Action trong `src` có `revalidatePath` phủ trang `trang` không. Nhận các dạng đang dùng trong kho:
 * chuỗi thẳng, mảng duyệt bằng for-of, hằng `PATH`/`PATHS`, `ORG_DEPENDENT_PATHS` đi kèm
 * `revalidatePath("/", "layout")`, `revalidatePath(<tiền tố>, "layout")`, và mẫu `/x/${id}` cho trang
 * động (truyền `trang` dạng "/x/${").
 */
function phu(src: string, trang: string): boolean {
  if (trang.endsWith("${")) return src.includes("revalidatePath(`" + trang);
  if (src.includes(`revalidatePath("${trang}")`)) return true;
  if (new RegExp(`\\[[^\\]]*"${esc(trang)}"[^\\]]*\\]\\)\\s*revalidatePath\\(`).test(src)) return true;
  for (const m of src.matchAll(/const (\w+) = "([^"]+)";/g)) {
    if (m[2] === trang && src.includes(`revalidatePath(${m[1]})`)) return true;
    if ((trang === m[2] || trang.startsWith(m[2] + "/")) && src.includes(`revalidatePath(${m[1]}, "layout")`)) return true;
  }
  for (const m of src.matchAll(/const (\w+) = \[([^\]]*)\]/g)) if (m[2].includes(`"${trang}"`) && new RegExp(`of ${m[1]}\\)\\s*revalidatePath\\(`).test(src)) return true;
  for (const m of src.matchAll(/revalidatePath\("([^"]*)", "layout"\)/g)) if (trang === m[1] || trang.startsWith(m[1] === "/" ? "/" : m[1] + "/")) return true;
  return false;
}

/** Module action → trang mà component (đã bỏ refresh) đứng trên. */
const PHU: [string, string[]][] = [
  ["alerts.ts", ["/alerts", "/ads", "/orders", "/shipments"]],
  ["approvals.ts", ["/alerts"]],
  ["marketing-alerts.ts", ["/alerts"]],
  ["bank.ts", ["/bank", "/finance-ops"]],
  ["workshop-ledger.ts", ["/bank", "/inventory/workshop", "/inventory/workshop/[id]"]],
  ["cs.ts", ["/cs"]],
  ["expenses.ts", ["/expenses", "/ads", "/finance-ops"]],
  ["ads-mapping.ts", ["/ads"]],
  ["ideas.ts", ["/ideas", "/ideas/${"]],
  ["production.ts", ["/inventory/planning/orders/${"]],
  ["planning.ts", ["/inventory/planning"]],
  ["slow-moving.ts", ["/inventory/planning"]],
  ["suppliers.ts", ["/inventory/purchasing"]],
  ["stock.ts", ["/inventory/receipts"]],
  ["return-exceptions.ts", ["/inventory/returns"]],
  ["hmt-returns.ts", ["/inventory/returns"]],
  ["returns-warehouse.ts", ["/inventory/returns", "/data-quality"]],
  ["return-dispositions.ts", ["/inventory/returns"]],
  ["returns-unidentified.ts", ["/inventory/returns"]],
  ["stock-shortage.ts", ["/inventory/shortage"]],
  ["marketer-price.ts", ["/inventory/workshop"]],
  ["landing.ts", ["/landing"]],
  ["creative.ts", ["/marketing/creatives"]],
  ["creative-config.ts", ["/marketing/creatives"]],
  ["creative-copy.ts", ["/marketing/creatives"]],
  ["creative-design.ts", ["/marketing/creatives"]],
  ["creative-names.ts", ["/marketing/creatives"]],
  ["creative-import.ts", ["/marketing/creatives"]],
  ["creative-extend.ts", ["/marketing/creatives"]],
  ["creative-manual.ts", ["/marketing/creatives"]],
  ["creative-manual-gen.ts", ["/marketing/creatives"]],
  ["creative-scale.ts", ["/marketing/creatives"]],
  ["creative-sources.ts", ["/marketing/creatives"]],
  ["ads-kill-switch.ts", ["/marketing/creatives"]],
  ["fanpage-attribution.ts", ["/marketing/fanpages"]],
  ["models.ts", ["/models", "/models/${"]],
  ["payroll-autopilot.ts", ["/my-payslip"]],
  ["outreach.ts", ["/outreach"]],
  ["payroll-policy.ts", ["/payroll/adjustments", "/payroll/assignments", "/payroll/policies", "/payroll/settings", "/payroll/migration"]],
  ["payroll.ts", ["/payroll", "/ads"]],
  ["payroll-period.ts", ["/payroll"]],
  ["payroll-run.ts", ["/payroll"]],
  ["production-costing.ts", ["/production/models", "/production/topics"]],
  ["production-samples.ts", ["/production/models", "/production/topics"]],
  ["production-topics.ts", ["/production/topics/${"]],
  ["work.ts", ["/work/settings", "/work/all", "/reports/returns"]],
  ["org.ts", ["/settings/users", "/work/settings"]],
  ["access.ts", ["/settings/users"]],
  ["workforce.ts", ["/work/settings", "/work/today"]],
  ["users.ts", ["/settings/users"]],
  ["session-revoke.ts", ["/settings/users"]],
  ["logistics-config.ts", ["/shipments", "/work/settings"]],
  ["tech.ts", ["/tech/agents", "/tech/cto", "/tech/deployments", "/tech/incidents", "/tech/incidents/${", "/tech/tasks", "/tech/tasks/${"]],
  ["okr.ts", ["/work/okr", "/work/review"]],
  ["owner-decisions.ts", ["/", "/cockpit"]],
  ["ai.ts", ["/", "/orders", "/shipments"]],
  ["work-quick.ts", ["/work", "/work/all", "/work/department"]],
  ["return-reason-groups.ts", ["/work/settings"]],
  ["metric-targets.ts", ["/work/settings"]],
];

/**
 * Nhánh thành công trả sớm phải làm mới NGAY TRƯỚC `return` của chính nó: [tệp, mở nhánh, lời gọi
 * làm mới, câu return]. Giữa "mở nhánh" và "lời gọi" không được có `return` nào — nếu không, lời gọi
 * nằm ở nhánh khác. Lời gọi bắt đầu bằng xuống dòng + hai dấu cách nghĩa là nó đứng NGOÀI khối `if`
 * (chạy cho cả nhánh `noop` / `skipped`), không phải bên trong.
 */
const NHANH_SOM: [string, string, string, string][] = [
  ["alerts.ts", "if (before.acknowledgedAt) {", 'revalidatePath("/alerts");', "return { ok: true };"],
  ["alerts.ts", "if (before.startedAt) {", 'revalidatePath("/alerts");', "return { ok: true };"],
  ["alerts.ts", 'revalidatePath("/integrations");', 'revalidatePath("/alerts");', "return { ok: true };"],
  ["alerts.ts", 'action: "case.resolve"', 'revalidatePath("/", "layout");', "return { ok: true };"],
  ["bank.ts", "(status === undefined || status === truoc.status)) {", "revalidateAll();", "return { ok: true };"],
  ["bank.ts", "if (!chacChan.length) {", "revalidateAll();", "return { ok: true, confirmed: 0"],
  ["owner-decisions.ts", "if (r.skipped) {", 'revalidatePath("/cockpit");', "return { ok: true, skipped: true };"],
  ["returns-warehouse.ts", "if (!count) {", "revalidate();", 'return { ok: true, count: 0, message: "Các vận đơn đã được ghi nhận'],
  ["returns-warehouse.ts", "if (blocked) return", "revalidate();", 'return { ok: true, count: 0, message: "Không có vận đơn nào'],
  ["returns-warehouse.ts", "if (!ids.length) {", "revalidate();", "return { ok: true, count: 0"],
  ["return-dispositions.ts", "if (res.replayed) {", "revalidate();", "return res;"],
  ["hmt-returns.ts", "if (daCo) {", "revalidate();", "return { ok: true, sha256, bytes: buffer.length, filename: parsed.data.filename, reused: true };"],
  ["returns-unidentified.ts", "if (r.already) {", "revalidate();", "return { ok: true, row: r.row, restocked: 0, already: true"],
  ["stock-shortage.ts", "if (!previous) {", 'revalidatePath("/inventory/shortage");', "return { ok: true };"],
  ["workshop-ledger.ts", "if (truoc.status === status) {", "refresh(id);", "return { ok: true };"],
  ["creative.ts", 'if (row.v.status === "REJECTED") {', "revalidatePath(PATH);", "return { ok: true };"],
  ["creative-design.ts", 'if (on === (cu.status === "PRODUCTION")) {', "revalidatePath(DUONG);", "return { ok: true, status: cu.status };"],
  ["creative-copy.ts", "if (!r.changed) {", "revalidatePath(PATH);", "return { ok: true, changed: false"],
  ["creative-names.ts", "if (!r.changed) {", "revalidatePath(PATH);", "return { ok: true, changed: false };"],
  ["models.ts", "if (!r.changed) {", "modelPaths(d.modelId);", "return { ok: true };"],
  ["production-samples.ts", 'action: "SAMPLE_SUBMIT"', "\n  revalidateProduction();", "return { ok: true, noop: r.noop"],
  ["production-topics.ts", 'action: "PRODUCTION_TOPIC_STATUS"', "\n  revalidateProduction(parsed.data.topicId);", "return { ok: true, noop: r.noop };"],
  ["access.ts", 'Không tìm thấy vai trò" };\n  if (cu.active === active) {', "refreshOrgViews();", "return { ok: true, id };"],
  ["access.ts", 'Không tìm thấy chức danh" };\n  if (cu.active === active) {', "refreshOrgViews();", "return { ok: true, id };"],
  ["users.ts", "if (target.active === active) {", 'revalidatePath("/settings/users");', "return { ok: true, id };"],
  ["tech.ts", 'action: "TECH_TASK_STATUS"', "\n  lamMoi(data.taskId);", "return { ok: true };"],
  ["tech.ts", 'action: "TECH_INCIDENT_STATUS"', "\n  lamMoi();\n  revalidatePath(`/tech/incidents/${data.incidentId}`);", "return { ok: true };"],
  ["tech.ts", 'action: "TECH_TASK_APPROVAL_BULK"', "\n  lamMoi();", "return { ok: true, daKy"],
  ["tech.ts", "Giao lại cho agent sửa theo review", "lamMoi(res.taskId);", "return { ok: true, taskCode"],
  ["tech.ts", "Giao việc cho agent từ ERP", "lamMoi(res.taskId);", "return { ok: true, taskCode"],
  ["okr.ts", "if (existing) {", "revalidate();", "return { ok: true, id: existing.id };"],
  ["payroll-policy.ts", "truoc.note === parsed.data.note) {", "revalidate();", "return { ok: true };"],
  ["ai.ts", "const r = await confirmCore(", 'revalidatePath("/", "layout");', "return r;"],
  ["work-quick.ts", "const res = await chayHanhDong(input);", "revalidatePath(p);", "return res;"],
];

/** Lời gọi làm mới đứng ngay trước câu return (chỉ cách nhau khoảng trắng / dòng chú thích). */
function lamMoiTruocReturn(src: string, moNhanh: string, goi: string, traVe: string): boolean {
  const re = new RegExp(`${esc(moNhanh)}(?:(?!return )[\\s\\S]){0,600}?${esc(goi)}\\s*(?://[^\\n]*\\s*)*${esc(traVe)}`);
  return re.test(src);
}

export function testActionRefreshOnce() {
  for (const f of SACH) {
    assert.equal(demRefresh(f), 0, `${f}: gọi router.refresh() sau server action đã revalidatePath — trang dựng hai lần, nút Lưu quay gấp đôi`);
  }
  for (const [f, n] of Object.entries(GIU)) {
    assert.equal(demRefresh(D + f), n, `${D + f}: số lượt router.refresh() đổi (${n} → ${demRefresh(D + f)}) — soát action đứng trước nó: đã revalidatePath trang này thì bỏ refresh, chưa thì sửa con số ở GIU kèm lý do`);
  }
  for (const [m, trang] of PHU) {
    const src = doc(`lib/actions/${m}`);
    for (const t of trang) {
      assert.ok(phu(src, t), `lib/actions/${m}: không còn revalidatePath phủ ${t} — component trên trang đó đã bỏ router.refresh() nên sẽ KHÔNG tự cập nhật sau khi lưu`);
    }
  }
  for (const [m, moNhanh, goi, traVe] of NHANH_SOM) {
    assert.ok(
      lamMoiTruocReturn(doc(`lib/actions/${m}`), moNhanh, goi, traVe),
      `lib/actions/${m}: nhánh "${moNhanh}" không còn làm mới (${goi.trim()}) ngay trước "${traVe}" — client đã bỏ router.refresh() nên trang sẽ đứng ở dữ liệu cũ`,
    );
  }
  // Bộ khoá nhánh không được dễ dãi: lời gọi nằm SAU câu return, hay lọt vào trong khối `if`, đều phải trượt.
  assert.equal(lamMoiTruocReturn('if (x) {\n    return { ok: true };\n  }\n  revalidate();', "if (x) {", "revalidate();", "return { ok: true };"), false);
  assert.equal(lamMoiTruocReturn('if (!r.noop) {\n    audit();\n    lamMoi();\n  }\n  return { ok: true };', "if (!r.noop) {", "\n  lamMoi();", "return { ok: true };"), false);
  // Bộ nhận dạng không được dễ dãi: trang con không nằm dưới revalidate một trang thường.
  assert.equal(phu('revalidatePath("/orders");', "/orders/123"), false);
  assert.equal(phu('revalidatePath("/work", "layout");', "/work/okr"), true);
  assert.equal(phu('revalidatePath("/work", "layout");', "/workshop"), false);
  console.log(`✓ Lưu xong chỉ dựng trang một lần: ${SACH.length} tệp không còn router.refresh() sau action · ${Object.keys(GIU).length} tệp giữ refresh có lý do · ${PHU.length} module action vẫn revalidatePath đúng trang · ${NHANH_SOM.length} nhánh trả sớm vẫn làm mới`);
}
