/**
 * FACEBOOK FRIEND CRM — lát 2 (docs/verticals/facebook-friend-crm.md): nguồn việc /work · khối Customer 360 · thẻ số + tương quan.
 *
 *  1. KHAI BÁO — `FB_CRM_CARE` có trong sổ nguồn, có luật hạn + phòng (SALES), không chạm cảnh báo nào (ALERT_KINDS_OWNED_ELSEWHERE
 *     không đổi), không có nút «xong» (chỉ OPEN_SOURCE).
 *  2. TỔ CHỨC THẬT (PGlite riêng `fbs2-si`):
 *     · cờ tắt ⇒ không việc nào; khách tới hẹn (≤ hôm nay giờ VN) ⇒ MỘT dòng SOURCE; tương lai / không liên hệ ⇒ không; khách đã có
 *       nhiệm vụ tay `fb-crm` còn mở ⇒ KHÔNG sinh dòng chiếu (không đếm hai lần); việc tay đã xong ⇒ dòng chiếu quay lại;
 *     · đóng việc = thao tác thật của miền (đặt ngày mới) ⇒ rời hàng đợi; giao việc đi qua miền (NV phụ trách);
 *     · khối Customer 360: trạng thái, link + nguồn, phụ trách, hẹn, ≤ 5 dòng nhật ký mới nhất;
 *     · tương quan «kết bạn rồi mua»: chỉ đơn GIAO THÀNH CÔNG sau mốc kết bạn, tiền chưa chứng từ ⇒ null, độ phủ mốc in đúng;
 *     · tổ chức nhà không thấy dòng nào của tổ chức khác.
 *  3. MÃ NGUỒN — nhãn «tương quan, KHÔNG phải doanh thu do CRM mang lại» và độ phủ đứng cạnh con số.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { FB_CRM_CORRELATION_LABEL, FB_CRM_SETTING_KEY, FB_CRM_TASK_TAG } from "@/lib/constants/fb-crm";
import { workKey } from "@/lib/constants/work";
import { DEFAULT_OWNERSHIP_MAP } from "@/lib/constants/work-ownership";
import { DEFAULT_SLA_MAP, SOURCES_WITHOUT_SLA } from "@/lib/constants/work-sla";
import { ALERT_KINDS_OWNED_ELSEWHERE, WORK_SOURCES, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { WORK_ACTION } from "@/lib/constants/work-actions";
import { fbCrmApplyCore, fbCrmCreateTaskCore } from "@/lib/fb-crm/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { FB_CRM_PANEL_EVENTS, fbCrmCustomerPanel, fbCrmDueCare, fbCrmFriendCorrelation, fbCrmOverview } from "@/lib/queries/fb-crm";
import { collectWorkItems, duplicateKeys } from "@/lib/queries/work-adapters";
import { setSettingJson } from "@/lib/settings";
import { assignByAuthority } from "@/lib/work/assign";

const ORG = "fbs2-si";
const DAY = 86_400_000;
const vnDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function testDeclarations() {
  assert.ok((WORK_SOURCES as readonly string[]).includes("FB_CRM_CARE"));
  const spec = WORK_SOURCE_SPEC.FB_CRM_CARE;
  assert.deepEqual([spec.statusAuthority, spec.assigneeAuthority, spec.department, spec.businessEntity], ["SOURCE", "SOURCE", "SALES", "CUSTOMER"], "phép chiếu: miền giữ trạng thái + người phụ trách, phòng SALES (không tới cá nhân)");
  assert.ok(spec.actions.every((a) => WORK_ACTION[a].mode === "LINK"), "không có nút «đánh dấu xong» — chỉ MỞ chỗ làm thao tác thật (luật 19)");
  assert.ok(!SOURCES_WITHOUT_SLA.includes("FB_CRM_CARE") && "FB_CRM_CARE" in DEFAULT_SLA_MAP, "có luật hạn (cố ý bỏ trống giờ, có lý do)");
  assert.equal(DEFAULT_OWNERSHIP_MAP.FB_CRM_CARE?.department, "SALES", "luật phòng trỏ tới PHÒNG");
  assert.ok(!(ALERT_KINDS_OWNED_ELSEWHERE as string[]).some((k) => /FB|CRM|CARE_DUE/.test(k)), "không cảnh báo nào trùng độ mịn với hẹn chăm sóc");
}

function testSource() {
  const goc = path.resolve(__dirname, "..");
  const page = readFileSync(path.join(goc, "app/(dashboard)/customers/facebook-crm/page.tsx"), "utf8");
  assert.ok(page.includes("FB_CRM_CORRELATION_LABEL") && page.includes("độ phủ"), "con số tương quan luôn đứng cạnh nhãn «KHÔNG phải doanh thu do CRM» và độ phủ mốc");
  assert.match(FB_CRM_CORRELATION_LABEL, /KHÔNG phải doanh thu do CRM mang lại/);
  const detail = readFileSync(path.join(goc, "app/(dashboard)/customers/[id]/page.tsx"), "utf8");
  assert.ok(detail.includes("<CustomerFbCrmSection"), "Customer 360 dựng khối Facebook CRM");
  const section = readFileSync(path.join(goc, "components/fb-crm/customer-fb-crm-section.tsx"), "utf8");
  assert.ok(section.includes("fbCrmEnabled()"), "khối tự ẩn khi cờ tắt");
}

export async function testFbCrmS2() {
  testDeclarations();
  testSource();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "HSLC thử FB CRM lát 2", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT lát 2", password: "FbCrmS2@12345" }, source: "TEST", actor: null });
  const ids: string[] = [];
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "HSLC thử FB CRM lát 2", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT lát 2", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      const [staff] = await db.insert(schema.users).values({ email: `nv@${ORG}.local`, name: "NV Thu", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });

      const now = new Date();
      const today = vnDay(now);
      const yesterday = vnDay(new Date(now.getTime() - DAY));
      const tomorrow = vnDay(new Date(now.getTime() + DAY));
      const cs = await db
        .insert(schema.customers)
        .values(["Quá hẹn A", "Không liên hệ B", "Ngày mai C", "Có việc tay D", "Việc tay xong E", "Kết bạn F", "Kết bạn không mốc G"].map((name) => ({ name })))
        .returning({ id: schema.customers.id });
      const [a, b, c, d, e, f, g] = cs.map((x) => x.id);
      ids.push(...cs.map((x) => x.id));
      await db.insert(schema.customerFbConnections).values([
        { customerId: a, nextCareOn: yesterday, careOwnerUserId: staff.id, connectionStatus: "CONSENTED" },
        { customerId: b, nextCareOn: today, doNotContact: true, doNotContactReason: "khách xin thôi" },
        { customerId: c, nextCareOn: tomorrow },
        { customerId: d, nextCareOn: today },
        { customerId: e, nextCareOn: today },
        // Đã kết bạn mà KHÔNG có dòng nhật ký (ghi ngoài đường ghi) ⇒ không có mốc ⇒ đứng ngoài phép đếm tương quan.
        { customerId: g, connectionStatus: "FRIENDS" },
      ]);

      // ── Cờ tắt ⇒ không việc nào ──
      assert.deepEqual(await fbCrmDueCare(today), [], "cờ tổ chức tắt ⇒ nguồn rỗng");
      await setSettingJson(FB_CRM_SETTING_KEY, { on: true });

      // Việc tay `fb-crm` của lát 1: D còn MỞ (che dòng chiếu), E đã XONG (không che).
      const td = await fbCrmCreateTaskCore(admin, d, {}, today);
      const te = await fbCrmCreateTaskCore(admin, e, {}, today);
      assert.ok(td.ok && te.ok && td.taskId && te.taskId);
      await db.update(schema.workItems).set({ status: "DONE" }).where(eq(schema.workItems.id, te.taskId!));

      const due = await fbCrmDueCare(today);
      assert.deepEqual(due.map((r) => r.customerId).sort(), [a, e].sort(), "tới hẹn = A (quá hẹn) + E; B không liên hệ, C ngày mai, D đã có việc tay mở");

      const { items, failed } = await collectWorkItems({ now, sources: ["FB_CRM_CARE", "MANUAL_TASK"] });
      assert.deepEqual(failed, []);
      assert.deepEqual(duplicateKeys(items), []);
      const care = items.filter((i) => i.sourceType === "FB_CRM_CARE");
      assert.deepEqual(care.map((i) => i.businessEntityId).sort(), [a, e].sort());
      const ia = care.find((i) => i.businessEntityId === a)!;
      assert.deepEqual([ia.statusAuthority, ia.department, ia.assignee?.id, ia.priority, ia.key], ["SOURCE", "SALES", staff.id, "HIGH", workKey("FB_CRM_CARE", a)]);
      assert.equal(ia.sourceUrl, `/customers/facebook-crm?c=${a}`, "nút mở ĐÚNG khách trên trang miền");
      assert.equal(items.filter((i) => i.businessEntityId === d).length, 1, "khách D chỉ là MỘT việc (việc tay) — không đếm hai lần");
      assert.equal(items.filter((i) => i.businessEntityId === d)[0].sourceType, "MANUAL_TASK");

      // ── Giao việc đi qua miền; đóng việc = thao tác thật của miền ──
      const assigned = await assignByAuthority(workKey("FB_CRM_CARE", e), staff.id, admin);
      assert.ok("ok" in assigned, JSON.stringify(assigned));
      const [eRow] = await db.select({ owner: schema.customerFbConnections.careOwnerUserId }).from(schema.customerFbConnections).where(eq(schema.customerFbConnections.customerId, e));
      assert.equal(eRow.owner, staff.id, "giao việc ghi vào NV phụ trách của miền, không ghi work_items");
      const moved = await fbCrmApplyCore(admin, a, { op: "SET_NEXT_CARE", on: tomorrow }, today);
      assert.ok(moved.ok && moved.changed);
      const after = await collectWorkItems({ now, sources: ["FB_CRM_CARE"] });
      assert.deepEqual(after.items.map((i) => i.businessEntityId), [e], "đặt ngày hẹn mới ⇒ việc A rời hàng đợi, không cần nút «xong»");

      // ── Khối Customer 360 ──
      await fbCrmApplyCore(admin, f, { op: "SET_URL", url: "https://www.facebook.com/khach.f.hslc", source: "STAFF_VERIFIED_FROM_PANCAKE" }, today);
      for (const step of ["CONSENTED", "INVITE_SENT", "FRIENDS"] as const) assert.ok((await fbCrmApplyCore(admin, f, { op: "SET_STATUS", to: step }, today)).ok);
      await fbCrmApplyCore(admin, f, { op: "SET_OWNER", userId: staff.id }, today);
      await fbCrmApplyCore(admin, f, { op: "SET_NEXT_CARE", on: tomorrow }, today);
      const panel = await fbCrmCustomerPanel(f);
      assert.ok(panel);
      assert.deepEqual([panel.connectionStatus, panel.fbProfileUrl, panel.fbUrlSource, panel.careOwnerName, panel.nextCareOn], ["FRIENDS", "https://www.facebook.com/khach.f.hslc", "STAFF_VERIFIED_FROM_PANCAKE", "NV Thu", tomorrow]);
      assert.equal(panel.events.length, FB_CRM_PANEL_EVENTS, "6 thao tác ⇒ chỉ 5 dòng mới nhất");
      assert.equal(panel.events[0].kind, "NEXT_CARE_SET", "mới nhất đứng đầu");
      assert.equal(panel.events[0].actorName, "QT lát 2", "người làm đọc từ users (luật 34)");
      const blank = await fbCrmCustomerPanel(c.replace(/./g, "x"));
      assert.deepEqual([blank?.connectionStatus, blank?.events.length], ["NOT_ASKED", 0], "khách chưa có dòng ⇒ «Chưa hỏi», không lỗi");

      // ── Tương quan «kết bạn rồi mua» ──
      const order = (id: string, customerId: string, at: Date) => ({ id, customerId, stage: "DELIVERED" as never, insertedAt: at, totalPriceAfterDiscount: 300_000, moneyToCollect: 300_000, cod: 300_000, source: "Facebook" });
      const later = new Date(Date.now() + 60_000);
      await db.insert(schema.orders).values([order("fbs2-before", f, new Date(now.getTime() - 2 * DAY)), order("fbs2-after-nocash", f, later), order("fbs2-g", g, later)]);
      await db.insert(schema.shipments).values([
        { orderId: "fbs2-before", vtpOrderNumber: "FBS2-B", stage: "DELIVERED" as never, codAmount: 300_000, codCollected: 300_000 },
        { orderId: "fbs2-after-nocash", vtpOrderNumber: "FBS2-N", stage: "DELIVERED" as never, codAmount: 300_000 },
        { orderId: "fbs2-g", vtpOrderNumber: "FBS2-G", stage: "DELIVERED" as never, codAmount: 300_000, codCollected: 300_000 },
      ]);
      let corr = await fbCrmFriendCorrelation();
      assert.deepEqual(corr, { friends: 2, withMilestone: 1, buyersAfter: 1, deliveredOrdersAfter: 1, verifiedCashAfter: null }, "đơn TRƯỚC mốc không tính; khách không mốc đứng ngoài; chưa chứng từ tiền ⇒ null, không 0");
      await db.insert(schema.orders).values([order("fbs2-after-cash", f, later), { ...order("fbs2-after-returned", f, later), stage: "RETURNED" as never }]);
      await db.insert(schema.shipments).values([
        { orderId: "fbs2-after-cash", vtpOrderNumber: "FBS2-C", stage: "DELIVERED" as never, codAmount: 250_000, codCollected: 250_000 },
        { orderId: "fbs2-after-returned", vtpOrderNumber: "FBS2-R", stage: "RETURNED" as never, codAmount: 300_000 },
      ]);
      corr = await fbCrmFriendCorrelation();
      assert.deepEqual(corr, { friends: 2, withMilestone: 1, buyersAfter: 1, deliveredOrdersAfter: 2, verifiedCashAfter: 250_000 }, "đơn hoàn không tính; tiền = COD thực thu của đơn giao thành công sau mốc");

      const ov = await fbCrmOverview("");
      assert.ok(ov);
      assert.equal(ov.statuses.FRIENDS, 2, "thẻ số theo trạng thái đếm trên cùng tập khách của trang");
    });

    // ── Cách ly tổ chức ──
    const home = await getDb();
    const leaked = await home.select({ id: schema.customerFbConnections.id }).from(schema.customerFbConnections).where(and(eq(schema.customerFbConnections.customerId, ids[0])));
    assert.equal(leaked.length, 0, "tổ chức nhà không thấy kết nối của tổ chức khác");
    const homeTasks = await home.select({ id: schema.workItems.id }).from(schema.workItems).where(and(eq(schema.workItems.businessEntity, "CUSTOMER"), eq(schema.workItems.businessEntityId, ids[3])));
    assert.equal(homeTasks.length, 0);
    const homeDue = await collectWorkItems({ sources: ["FB_CRM_CARE"] });
    assert.ok(!homeDue.items.some((i) => ids.includes(i.businessEntityId)), "hàng đợi của tổ chức nhà không có khách của tổ chức khác");
    assert.ok(FB_CRM_TASK_TAG);
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Facebook CRM lát 2: nguồn việc FB_CRM_CARE là phép chiếu (SOURCE, phòng SALES, chỉ nút MỞ) · tới hẹn mới hiện · không liên hệ / ngày mai / đã có việc tay mở ⇒ không · giao & đóng qua miền · khối Customer 360 (5 dòng nhật ký) · tương quan kết bạn rồi mua chỉ đơn giao thành công sau mốc, chưa chứng từ ⇒ null, độ phủ mốc · cách ly tổ chức");
}
