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
 */
const doc = (p: string) => readFileSync(p, "utf8");
const boChuThich = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const demRefresh = (f: string) => (boChuThich(doc(f)).match(/router\.refresh\s*\(/g) ?? []).length;

const D = "app/(dashboard)/";

/** Đã gỡ HẾT `router.refresh()` — mọi lượt refresh cũ đều đứng sau một action đã revalidate trang này. */
const SACH: string[] = [
  "alerts/approval-actions.tsx",
  "alerts/approval-enforce-toggle.tsx",
  "alerts/marketing-digest-form.tsx",
  "bank/import-tab.tsx",
  "bank/manual-dialog.tsx",
  "bank/supplier-link-dialog.tsx",
  "bank/unlink-button.tsx",
  "cs/case-dialog.tsx",
  "cs/cs-table.tsx",
  "cs/customer-queue-table.tsx",
  "expenses/ad-spend-dialog.tsx",
  "expenses/ads-billing.tsx",
  "expenses/allocation-dialog.tsx",
  "expenses/campaign-mapping.tsx",
  "expenses/row-actions.tsx",
  "ideas/feedback-form.tsx",
  "ideas/idea-form.tsx",
  "ideas/idea-manage.tsx",
  "inventory/planning/orders/[id]/order-actions.tsx",
  "inventory/planning/planning-form.tsx",
  "inventory/planning/slow-moving-rules-editor.tsx",
  "inventory/purchasing/supplier-catalog.tsx",
  "inventory/receipts/delete-receipt-button.tsx",
  "inventory/receipts/receipt-dialog.tsx",
  "inventory/returns/exception-queues.tsx",
  "inventory/returns/inspection-station.tsx",
  "inventory/returns/item-inspection-drawer.tsx",
  "inventory/workshop/marketer-price-forms.tsx",
  "inventory/workshop/sheet-import-dialog.tsx",
  "landing/import-button.tsx",
  "landing/landing-config.tsx",
  "landing/landing-table.tsx",
  "marketing/creatives/config-form.tsx",
  "marketing/creatives/import-buttons.tsx",
  "marketing/creatives/kill-switch.tsx",
  "marketing/creatives/live-actions.tsx",
  "marketing/creatives/manual-form.tsx",
  "marketing/creatives/scale-actions.tsx",
  "marketing/creatives/source-form.tsx",
  "marketing/creatives/variant-select.tsx",
  "marketing/fanpages/assign-panel.tsx",
  "marketing/fanpages/reconcile-button.tsx",
  "models/[id]/suggestion-transition.tsx",
  "models/registry-actions.tsx",
  "my-payslip/respond-form.tsx",
  "outreach/outreach-config.tsx",
  "outreach/outreach-table.tsx",
  "payroll/adjustments/adjustment-manager.tsx",
  "payroll/assignments/assignment-manager.tsx",
  "payroll/employee-dialog.tsx",
  "payroll/finalize-button.tsx",
  "payroll/policies/policy-manager.tsx",
  "payroll/product-owners-form.tsx",
  "payroll/run-workflow.tsx",
  "production/_components/cost-sheets.tsx",
  "reports/returns/action-board.tsx",
  "settings/users/access-cell.tsx",
  "settings/users/department-cell.tsx",
  "settings/users/permissions-dialog.tsx",
  "settings/users/revoke-sessions-dialog.tsx",
  "settings/users/role-matrix.tsx",
  "settings/users/user-dialog.tsx",
  "shipments/reconcile-panel.tsx",
  "tech/agents/agent-controls.tsx",
  "tech/deployments/deployment-form.tsx",
  "tech/incidents/incident-form.tsx",
  "tech/tasks/[id]/run-verdict.tsx",
  "tech/tasks/task-form.tsx",
  "work/okr/toolbar.tsx",
  "work/settings/logistics-panel.tsx",
  "work/settings/panels.tsx",
  "work/settings/people-panel.tsx",
  "work/settings/reason-groups-panel.tsx",
  "work/settings/rules-panel.tsx",
  "work/settings/staffing-panel.tsx",
  "work/settings/targets-panel.tsx",
  "work/settings/weights-panel.tsx",
  "work/today/panels.tsx",
].map((f) => D + f).concat(["components/work/bsc-editor.tsx", "components/work/manual-task-dialog.tsx", "components/work/okr-editor.tsx"]);

/**
 * Còn giữ refresh CÓ LÝ DO — số lượng phải đúng bằng số lượt được giữ:
 * action có nhánh "không đổi gì / người khác đã làm" trả `{ ok: true }` mà KHÔNG revalidate (lúc ấy
 * trang đang cũ thật), action không phủ trang đang đứng, hoặc refresh theo đồng hồ.
 */
const GIU: Record<string, number> = {
  "alerts/alerts-actions.tsx": 3, // acknowledgeCase · startCase (nhánh đã làm rồi) · saveAlertConfig (chỉ revalidate /integrations)
  "inventory/returns/hmt-upload.tsx": 1, // uploadHmtWorkbook: nhánh `reused` không revalidate
  "inventory/returns/unidentified-section.tsx": 1, // chay(): restock nhánh `already` không revalidate
  "inventory/shortage/decision-buttons.tsx": 1, // clearShortageDecision: nhánh không có quyết định cũ
  "marketing/creatives/batch-actions.tsx": 1, // rejectVariant: mẫu đã bị loại từ trước
  "marketing/creatives/manual-gen.tsx": 1, // đồng hồ 8 giây theo dõi lượt gen — không đứng sau action
  "models/[id]/model-controls.tsx": 1, // setModelOwner: nhánh `!changed`
  "production/_components/samples-panel.tsx": 1, // submitSample: nhánh `noop`
  "production/topics/[id]/topic-controls.tsx": 1, // setProductionTopicStatus: nhánh `noop`
  "settings/users/positions-panel.tsx": 1, // setPositionActive: nhánh không đổi
  "settings/users/roles-panel.tsx": 1, // setAccessRoleActive: nhánh không đổi
  "tech/cto/cto-controls.tsx": 1, // approveTechProposalAction: lỗi giữa chừng sau khi đã tạo việc, không revalidate
  "tech/incidents/[id]/incident-actions.tsx": 1, // setTechIncidentStatusAction: nhánh `skipped`
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
  for (const m of src.matchAll(/const (\w+) = "([^"]+)";/g)) if (m[2] === trang && src.includes(`revalidatePath(${m[1]})`)) return true;
  for (const m of src.matchAll(/const (\w+) = \[([^\]]*)\]/g)) if (m[2].includes(`"${trang}"`) && new RegExp(`of ${m[1]}\\)\\s*revalidatePath\\(`).test(src)) return true;
  for (const m of src.matchAll(/revalidatePath\("([^"]*)", "layout"\)/g)) if (trang === m[1] || trang.startsWith(m[1] === "/" ? "/" : m[1] + "/")) return true;
  return false;
}

/** Module action → trang mà component (đã bỏ refresh) đứng trên. */
const PHU: [string, string[]][] = [
  ["alerts.ts", ["/alerts", "/ads"]],
  ["approvals.ts", ["/alerts"]],
  ["marketing-alerts.ts", ["/alerts"]],
  ["bank.ts", ["/bank"]],
  ["workshop-ledger.ts", ["/bank", "/inventory/workshop"]],
  ["cs.ts", ["/cs"]],
  ["expenses.ts", ["/expenses", "/ads"]],
  ["ads-mapping.ts", ["/ads"]],
  ["ideas.ts", ["/ideas", "/ideas/${"]],
  ["production.ts", ["/inventory/planning/orders/${"]],
  ["planning.ts", ["/inventory/planning"]],
  ["slow-moving.ts", ["/inventory/planning"]],
  ["suppliers.ts", ["/inventory/purchasing"]],
  ["stock.ts", ["/inventory/receipts"]],
  ["return-exceptions.ts", ["/inventory/returns"]],
  ["hmt-returns.ts", ["/inventory/returns"]],
  ["returns-warehouse.ts", ["/inventory/returns"]],
  ["returns-unidentified.ts", ["/inventory/returns"]],
  ["stock-shortage.ts", ["/inventory/shortage"]],
  ["marketer-price.ts", ["/inventory/workshop"]],
  ["landing.ts", ["/landing"]],
  ["creative.ts", ["/marketing/creatives"]],
  ["creative-config.ts", ["/marketing/creatives"]],
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
  ["payroll-policy.ts", ["/payroll/adjustments", "/payroll/assignments", "/payroll/policies"]],
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
  ["okr.ts", ["/work/okr"]],
  ["return-reason-groups.ts", ["/work/settings"]],
  ["metric-targets.ts", ["/work/settings"]],
];

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
  // Bộ nhận dạng không được dễ dãi: trang con không nằm dưới revalidate một trang thường.
  assert.equal(phu('revalidatePath("/orders");', "/orders/123"), false);
  assert.equal(phu('revalidatePath("/work", "layout");', "/work/okr"), true);
  assert.equal(phu('revalidatePath("/work", "layout");', "/workshop"), false);
  console.log(`✓ Lưu xong chỉ dựng trang một lần: ${SACH.length} tệp không còn router.refresh() sau action · ${Object.keys(GIU).length} tệp giữ refresh có lý do · ${PHU.length} module action vẫn revalidatePath đúng trang`);
}
