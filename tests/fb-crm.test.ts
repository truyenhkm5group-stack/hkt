/**
 * FACEBOOK FRIEND CRM — lát 1 (0262 · docs/verticals/facebook-friend-crm.md).
 *
 *  1. THUẦN — chuẩn hoá link (trang cá nhân hợp lệ · page / nhóm / bài / hộp thư / Pancake / Messenger / PSID bị loại), cờ tổ chức
 *     chỉ nhận object `{on: true}`, chuyển trạng thái KHÔNG ghi khi không đổi (luật 61), «đã gửi lời mời» chỉ sau khi khách đồng ý,
 *     «không liên hệ» chặn mọi bước tiếp cận, «lâu chưa quay lại» = AT_RISK ∪ CHURNED của `segmentOf`.
 *  2. TỔ CHỨC THẬT (PGlite riêng `fbc-si`): danh sách = khách từng nhắn HOẶC có đơn; «đã mua» theo ORDER_OUTCOME (hoàn / huỷ không
 *     tính); doanh thu thực chưa chứng từ ⇒ `null`; quyền customers:write; nhật ký mang khoá tài khoản; nhiệm vụ CSKH không trùng
 *     trong ngày và bị chặn khi «không liên hệ»; bảng nằm ở CSDL của TỔ CHỨC — tổ chức nhà không thấy dòng nào.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { CRM_RULE } from "@/lib/constants/crm";
import {
  FB_CONNECTION_DEFAULT,
  FB_CRM_SETTING_KEY,
  FB_CRM_TASK_TAG,
  careTaskBlockedReason,
  fbCrmEnabledOf,
  normalizeFacebookProfileUrl,
  planFbCrmOp,
  type FbConnectionState,
} from "@/lib/constants/fb-crm";
import { fbCrmApplyCore, fbCrmCreateTaskCore } from "@/lib/fb-crm/service";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fbCrmEnabled, fbCrmViewCounts, isLapsed, listFbCrm } from "@/lib/queries/fb-crm";
import type { ListParams } from "@/lib/search-params";
import { setSettingJson } from "@/lib/settings";

const ORG = "fbc-si";
const TODAY = "2026-10-27";

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

function testUrlPure() {
  const ok = (raw: string, want: string, scoped: string[] = []) => {
    const r = normalizeFacebookProfileUrl(raw, scoped);
    assert.ok(r.ok, `${raw} phải hợp lệ — nhận ${JSON.stringify(r)}`);
    assert.equal(r.url, want, raw);
  };
  const bad = (raw: string, reason: string, scoped: string[] = []) => {
    const r = normalizeFacebookProfileUrl(raw, scoped);
    assert.ok(!r.ok && r.reason === reason, `${raw} phải bị loại vì ${reason} — nhận ${JSON.stringify(r)}`);
  };
  ok("https://www.facebook.com/Nguyen.Thi.Lan/?mibextid=ZbWKwL", "https://www.facebook.com/nguyen.thi.lan");
  ok("  https://m.facebook.com/lan.hslc#top ", "https://www.facebook.com/lan.hslc");
  ok("https://facebook.com/profile.php?id=100012345678901&sk=about", "https://www.facebook.com/profile.php?id=100012345678901");
  bad("", "EMPTY");
  bad("facebook.com/lan.hslc", "NOT_URL");
  bad("http://www.facebook.com/lan.hslc", "NOT_HTTPS");
  bad("https://pancake.vn/123456789?c_id=123_456", "NOT_FACEBOOK");
  bad("https://pages.fm/123", "NOT_FACEBOOK");
  bad("https://www.messenger.com/t/lan.hslc", "NOT_FACEBOOK");
  bad("https://m.me/lan.hslc", "NOT_FACEBOOK");
  bad("https://fb.com/lan.hslc", "NOT_FACEBOOK");
  bad("https://business.facebook.com/lan.hslc", "NOT_FACEBOOK");
  bad("https://www.facebook.com/groups/123456789", "NOT_PROFILE");
  bad("https://www.facebook.com/groups", "NOT_PROFILE");
  bad("https://www.facebook.com/pages/Shop-HSLC/123456789", "NOT_PROFILE");
  bad("https://www.facebook.com/hslc.shop/posts/pfbid0abc", "NOT_PROFILE");
  bad("https://www.facebook.com/messages/t/1234567890", "NOT_PROFILE");
  bad("https://www.facebook.com/watch", "NOT_PROFILE");
  bad("https://www.facebook.com/permalink.php?story_fbid=1&id=2", "NOT_PROFILE");
  bad("https://www.facebook.com/profile.php?id=abc", "NOT_PROFILE");
  // PSID: dãy số trần không phải username; profile.php?id=<PSID của chính khách> bị loại.
  bad("https://www.facebook.com/24681357924680135", "PSID_LIKE");
  bad("https://www.facebook.com/profile.php?id=24681357924680135", "PAGE_SCOPED_ID", ["24681357924680135"]);

  assert.equal(fbCrmEnabledOf({ on: true }), true);
  for (const v of [true, "true", { on: "true" }, {}, [true], null, undefined, { on: 1 }]) assert.equal(fbCrmEnabledOf(v), false, `cờ ${JSON.stringify(v)} KHÔNG phải bật`);
  console.log("✓ Facebook CRM (thuần): link trang cá nhân chuẩn hoá về www.facebook.com · page / nhóm / bài / hộp thư / Pancake / Messenger / m.me / PSID bị loại · cờ chỉ nhận {on:true}");
}

function testPlanPure() {
  let cur: FbConnectionState = { ...FB_CONNECTION_DEFAULT };
  const apply = (op: Parameters<typeof planFbCrmOp>[1]) => {
    const p = planFbCrmOp(cur, op, TODAY);
    if (p.kind === "CHANGE") cur = p.next;
    return p;
  };
  const inv = apply({ op: "SET_STATUS", to: "INVITE_SENT" });
  assert.equal(inv.kind, "ERROR", "chưa đồng ý thì KHÔNG được đánh dấu đã gửi lời mời");
  const c1 = apply({ op: "SET_STATUS", to: "CONSENTED" });
  assert.ok(c1.kind === "CHANGE" && c1.events.length === 1 && c1.events[0].kind === "CONSENT_RECORDED");
  assert.equal(apply({ op: "SET_STATUS", to: "CONSENTED" }).kind, "NOOP", "bấm lại cùng trạng thái ⇒ KHÔNG ghi (luật 61)");
  assert.equal(apply({ op: "SET_STATUS", to: "INVITE_SENT" }).kind, "CHANGE");
  assert.equal(apply({ op: "SET_STATUS", to: "CONSENTED" }).kind, "ERROR", "không lùi từ «đã mời» về «đồng ý»");
  const fr = apply({ op: "SET_STATUS", to: "FRIENDS" });
  assert.ok(fr.kind === "CHANGE" && fr.events[0].kind === "STATUS_CHANGED" && fr.events[0].fromValue === "INVITE_SENT");
  assert.equal(apply({ op: "SET_NEXT_CARE", on: "2026-10-26" }).kind, "ERROR", "ngày hẹn ở quá khứ");
  assert.equal(apply({ op: "SET_NEXT_CARE", on: TODAY }).kind, "CHANGE");
  assert.equal(apply({ op: "SET_NEXT_CARE", on: TODAY }).kind, "NOOP");
  assert.equal(apply({ op: "SET_DNC", reason: "  " }).kind, "ERROR", "không liên hệ phải có lý do");
  const dnc = apply({ op: "SET_DNC", reason: "Khách yêu cầu không nhắn" });
  assert.ok(dnc.kind === "CHANGE" && dnc.events.map((e) => e.kind).join(",") === "DNC_SET,NEXT_CARE_SET" && cur.nextCareOn === null, "không liên hệ xoá hẹn và nhật ký nói vì sao");
  assert.equal(apply({ op: "SET_DNC", reason: "lần hai" }).kind, "NOOP");
  for (const to of ["CONSENTED", "INVITE_SENT"] as const) assert.equal(planFbCrmOp({ ...cur, connectionStatus: "NOT_ASKED" }, { op: "SET_STATUS", to }, TODAY).kind, "ERROR", `không liên hệ chặn ${to}`);
  assert.equal(apply({ op: "SET_NEXT_CARE", on: "2026-11-01" }).kind, "ERROR", "không liên hệ chặn hẹn chăm sóc");
  assert.ok(careTaskBlockedReason(cur), "không liên hệ chặn tạo nhiệm vụ");
  assert.equal(apply({ op: "SET_STATUS", to: "DECLINED" }).kind, "CHANGE", "«từ chối» vẫn ghi được khi không liên hệ");
  assert.equal(apply({ op: "CLEAR_DNC" }).kind, "CHANGE");
  assert.equal(careTaskBlockedReason(cur), null);
  assert.equal(apply({ op: "CLEAR_URL" }).kind, "NOOP", "chưa có link thì xoá link không ghi gì");

  // «Lâu chưa quay lại» viết bằng SQL (delivered ≥ 1 và days > activeDays) PHẢI trùng AT_RISK ∪ CHURNED của segmentOf.
  for (let delivered = 0; delivered <= 5; delivered += 1) {
    for (const days of [0, 1, CRM_RULE.activeDays - 1, CRM_RULE.activeDays, CRM_RULE.activeDays + 1, CRM_RULE.churnedDays, CRM_RULE.churnedDays + 1, 900]) {
      assert.equal(isLapsed(delivered, days), delivered >= 1 && days > CRM_RULE.activeDays, `lapsed(${delivered}, ${days}) lệch giữa SQL và segmentOf`);
    }
  }
  console.log("✓ Facebook CRM (thuần): chuyển trạng thái không đổi ⇒ không ghi · mời chỉ sau khi đồng ý · không liên hệ chặn đồng ý / mời / hẹn / nhiệm vụ · «lâu chưa quay lại» trùng segmentOf");
}

function testSourceGuards() {
  const goc = path.resolve(__dirname, "..");
  const read = (p: string) => readFileSync(path.join(goc, p), "utf8");
  for (const p of ["lib/queries/fb-crm.ts", "lib/fb-crm/service.ts", "lib/actions/fb-crm.ts", "lib/constants/fb-crm.ts", "app/(dashboard)/customers/facebook-crm/fb-crm-table.tsx", "app/(dashboard)/customers/facebook-crm/page.tsx"]) {
    const src = read(p);
    assert.ok(!src.includes("getPlatformDb"), `${p}: bảng Facebook CRM ở CSDL TỔ CHỨC — không đọc CSDL nền tảng`);
    assert.ok(!/graph\.facebook\.com/.test(src), `${p}: không gọi Graph API`);
    assert.ok(!/facebook\.com\/(?:profile\.php\?id=)?\$\{[^}]*(?:psid|thread|fbId|fb_id|pageScoped)/i.test(src), `${p}: không dựng link Facebook từ PSID / mã hội thoại`);
  }
  const q = read("lib/queries/fb-crm.ts");
  assert.ok(q.includes("ORDER_OUTCOME_FAST") && q.includes("PRIMARY_ATTEMPT") && q.includes("VERIFIED_CASH"), "kết quả đơn + tiền thật chỉ qua biểu thức chung của return-rate.ts");
  assert.ok(!/total_price_after_discount|totalPriceAfterDiscount/.test(q), "doanh thu thực KHÔNG lấy giá trị đơn danh nghĩa");
  const table = read("app/(dashboard)/customers/facebook-crm/fb-crm-table.tsx");
  assert.ok(!/^import (?!type)[^;]*@\/lib\/queries\//m.test(table), "client component chỉ import type từ lib/queries");
}

const params = (over: Partial<ListParams> = {}): ListParams => ({ page: 1, pageSize: 50, sort: "name", dir: "asc", q: "", filters: {}, period: { key: "all", from: null, to: null, label: "", fromKey: null, toKey: null }, ...over });

export async function testFbCrm() {
  testUrlPure();
  testPlanPure();
  testSourceGuards();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "HSLC thử Facebook CRM", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT FB", password: "FbCrm@12345" }, source: "TEST", actor: null });
  let customerA = "";
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "HSLC thử Facebook CRM", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT FB", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      const viewer: SessionUser = { ...admin, role: "VIEWER", permissions: ["customers:view"] };
      const [staff] = await db.insert(schema.users).values({ email: `nv@${ORG}.local`, name: "NV Hoa", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });

      assert.equal(await fbCrmEnabled(), false, "mặc định TẮT");
      await setSettingJson(FB_CRM_SETTING_KEY, { on: true });
      assert.equal(await fbCrmEnabled(), true);

      const [a, b, c, d] = await db
        .insert(schema.customers)
        .values([{ name: "Chị Lan" }, { name: "Anh Hùng" }, { name: "Cô Mai" }, { name: "Bà Tư" }, { name: "Người lạ" }])
        .returning({ id: schema.customers.id });
      customerA = a.id;
      await db.insert(schema.fanpages).values({ externalPageId: "P900", name: "HSLC Official" });
      const [ca, cb, cc] = await db
        .insert(schema.salesChatConversations)
        .values([
          { channel: "FANPAGE", customerId: a.id, pageId: "P900", threadId: "P900_24681357924680135", lastCustomerAt: new Date() },
          { channel: "FANPAGE", customerId: b.id, pageId: "P900", threadId: "P900_111222333444555" },
          { channel: "FANPAGE", customerId: c.id, pageId: "P900", threadId: "P900_666777888999000" },
        ])
        .returning({ id: schema.salesChatConversations.id });
      void ca;
      void cb;
      await db.insert(schema.salesConversationEvents).values({ conversationId: cc.id, type: "quote.given", actorKind: "AI", channel: "FANPAGE", occurredAt: new Date(), dedupeKey: `fbc-quote-${cc.id}` });

      const day = 86_400_000;
      const order = (id: string, customerId: string, stage: string, ageDays: number) => ({ id, customerId, stage: stage as never, insertedAt: new Date(Date.now() - ageDays * day), totalPriceAfterDiscount: 300_000, moneyToCollect: 300_000, cod: 300_000, source: "Facebook" });
      await db.insert(schema.orders).values([
        order("fbc-a1", a.id, "DELIVERED", 10),
        order("fbc-a2", a.id, "DELIVERED", 5),
        order("fbc-b1", b.id, "RETURNED", 8),
        order("fbc-b2", b.id, "CANCELLED", 3),
        order("fbc-d1", d.id, "DELIVERED", 200),
      ]);
      await db.insert(schema.shipments).values([
        { orderId: "fbc-a1", vtpOrderNumber: "FBC-A1", stage: "DELIVERED" as never, pickedUpAt: new Date(Date.now() - 9 * day), codAmount: 300_000, codCollected: 300_000 },
        { orderId: "fbc-a2", vtpOrderNumber: "FBC-A2", stage: "DELIVERED" as never, pickedUpAt: new Date(Date.now() - 4 * day), codAmount: 250_000, codCollected: 250_000 },
        { orderId: "fbc-b1", vtpOrderNumber: "FBC-B1", stage: "RETURNED" as never, pickedUpAt: new Date(Date.now() - 7 * day), codAmount: 300_000 },
        // Giao xong nhưng CHƯA có chứng từ tiền (chưa bảng kê) ⇒ giao thành công theo ORDER_OUTCOME, doanh thu thực CHƯA BIẾT.
        { orderId: "fbc-d1", vtpOrderNumber: "FBC-D1", stage: "DELIVERED" as never, pickedUpAt: new Date(Date.now() - 199 * day), codAmount: 300_000 },
      ]);

      const all = await listFbCrm(params(), "all");
      assert.deepEqual(all.rows.map((r) => r.name).sort(), ["Anh Hùng", "Bà Tư", "Chị Lan", "Cô Mai"], "chỉ khách từng nhắn HOẶC có đơn — «Người lạ» không vào");
      const by = (name: string) => all.rows.find((r) => r.name === name)!;
      assert.deepEqual([by("Chị Lan").deliveredCount, by("Chị Lan").orderCount, by("Chị Lan").realRevenue], [2, 2, 550_000], "doanh thu thực = COD THỰC THU (300K + 250K), không phải giá trị đơn 600K");
      assert.deepEqual([by("Anh Hùng").deliveredCount, by("Anh Hùng").orderCount, by("Anh Hùng").realRevenue], [0, 1, null], "đơn hoàn / huỷ KHÔNG là đã mua; huỷ không đếm đơn; chưa giao ⇒ doanh thu «—»");
      assert.deepEqual([by("Bà Tư").deliveredCount, by("Bà Tư").realRevenue], [1, null], "giao thành công mà chưa chứng từ tiền ⇒ doanh thu thực null, KHÔNG phải 0");
      assert.equal(by("Chị Lan").pageName, "HSLC Official");
      assert.equal(by("Chị Lan").pancakeHref, "https://pancake.vn/P900?c_id=P900_24681357924680135");
      assert.equal(by("Chị Lan").fbProfileUrl, null, "chưa ai dán link ⇒ không có link Facebook — KHÔNG dựng từ PSID");

      const names = async (view: Parameters<typeof listFbCrm>[1]) => (await listFbCrm(params(), view)).rows.map((r) => r.name).sort();
      assert.deepEqual(await names("bought"), ["Bà Tư", "Chị Lan"]);
      assert.deepEqual(await names("not_bought"), ["Anh Hùng", "Cô Mai"]);
      assert.deepEqual(await names("repeat"), ["Chị Lan"], "mua nhiều lần = ≥ 2 đơn GIAO THÀNH CÔNG");
      assert.deepEqual(await names("quoted"), ["Cô Mai"], "hỏi giá chưa đặt: có quote.given, chưa đơn nào còn sống");
      assert.deepEqual(await names("lapsed"), ["Bà Tư"], "lần giao gần nhất 200 ngày > activeDays");
      assert.deepEqual(await names("messaged"), ["Anh Hùng", "Chị Lan", "Cô Mai"]);
      const counts = await fbCrmViewCounts("");
      assert.deepEqual([counts.all, counts.bought, counts.repeat, counts.friends, counts.dnc], [4, 2, 1, 0, 0]);

      // ── Ghi: quyền · chuẩn hoá · idempotent · nhật ký có khoá tài khoản ──
      const forbidden = await fbCrmApplyCore(viewer, a.id, { op: "SET_STATUS", to: "CONSENTED" }, TODAY);
      assert.ok(!forbidden.ok && forbidden.error.includes("customers:write"), "thiếu customers:write ⇒ từ chối");
      const pancake = await fbCrmApplyCore(admin, a.id, { op: "SET_URL", url: "https://pancake.vn/P900?c_id=1", source: "CUSTOMER_PROVIDED" }, TODAY);
      assert.ok(!pancake.ok, "link Pancake không phải trang Facebook");
      const psid = await fbCrmApplyCore(admin, a.id, { op: "SET_URL", url: "https://www.facebook.com/profile.php?id=24681357924680135", source: "STAFF_VERIFIED_FROM_PANCAKE" }, TODAY);
      assert.ok(!psid.ok && psid.error.includes("THEO PAGE"), "link trỏ vào PSID của CHÍNH hội thoại khách bị loại");
      const setUrl = await fbCrmApplyCore(admin, a.id, { op: "SET_URL", url: "https://m.facebook.com/Chi.Lan.HSLC/", source: "CUSTOMER_PROVIDED" }, TODAY);
      assert.ok(setUrl.ok && setUrl.changed);
      const again = await fbCrmApplyCore(admin, a.id, { op: "SET_URL", url: "https://www.facebook.com/chi.lan.hslc", source: "CUSTOMER_PROVIDED" }, TODAY);
      assert.ok(again.ok && !again.changed, "cùng link (sau chuẩn hoá) ⇒ không ghi");
      assert.ok(!(await fbCrmApplyCore(admin, a.id, { op: "SET_STATUS", to: "INVITE_SENT" }, TODAY)).ok, "mời trước khi đồng ý ⇒ từ chối");
      assert.ok((await fbCrmApplyCore(admin, a.id, { op: "SET_STATUS", to: "CONSENTED", note: "khách nói ok qua chat" }, TODAY)).ok);
      const dup = await fbCrmApplyCore(admin, a.id, { op: "SET_STATUS", to: "CONSENTED" }, TODAY);
      assert.ok(dup.ok && !dup.changed);
      assert.ok((await fbCrmApplyCore(admin, a.id, { op: "SET_OWNER", userId: staff.id }, TODAY)).ok);
      const evs = await db.select().from(schema.customerFbConnectionEvents).where(eq(schema.customerFbConnectionEvents.customerId, a.id));
      assert.deepEqual(evs.map((e) => e.kind).sort(), ["CONSENT_RECORDED", "OWNER_CHANGED", "URL_SET"], "ba thay đổi thật = ba dòng nhật ký; bấm lặp không đẻ dòng");
      assert.ok(evs.every((e) => e.actorId === admin.id), "nhật ký đi bằng khoá tài khoản (luật 34)");
      const [conn] = await db.select().from(schema.customerFbConnections).where(eq(schema.customerFbConnections.customerId, a.id));
      assert.deepEqual([conn.fbProfileUrl, conn.fbUrlSource, conn.fbUrlSetByUserId, conn.connectionStatus], ["https://www.facebook.com/chi.lan.hslc", "CUSTOMER_PROVIDED", admin.id, "CONSENTED"]);
      const afterRow = (await listFbCrm(params(), "consented")).rows;
      assert.deepEqual(afterRow.map((r) => [r.name, r.careOwnerName, r.fbProfileUrl]), [["Chị Lan", "NV Hoa", "https://www.facebook.com/chi.lan.hslc"]]);

      // ── Nhiệm vụ CSKH: không liên hệ chặn; một việc mở / khách / ngày ──
      assert.ok((await fbCrmApplyCore(admin, a.id, { op: "SET_DNC", reason: "Khách xin thôi nhắn" }, TODAY)).ok);
      const blocked = await fbCrmCreateTaskCore(admin, a.id, {}, TODAY);
      assert.ok(!blocked.ok, "không liên hệ ⇒ không tạo nhiệm vụ");
      assert.ok(!(await fbCrmApplyCore(admin, a.id, { op: "SET_STATUS", to: "INVITE_SENT" }, TODAY)).ok, "không liên hệ ⇒ không đánh dấu mời");
      assert.deepEqual(await names("dnc"), ["Chị Lan"]);
      assert.ok((await fbCrmApplyCore(admin, a.id, { op: "CLEAR_DNC" }, TODAY)).ok);
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
      const t1 = await fbCrmCreateTaskCore(admin, a.id, { note: "hỏi size mới" }, today);
      assert.ok(t1.ok && t1.changed && t1.taskId);
      const t2 = await fbCrmCreateTaskCore(admin, a.id, {}, today);
      assert.ok(t2.ok && !t2.changed && t2.taskId === t1.taskId, "cùng ngày đã có việc mở ⇒ trả lại việc đó, không tạo trùng");
      const tasks = await db.select().from(schema.workItems).where(and(eq(schema.workItems.businessEntity, "CUSTOMER"), eq(schema.workItems.businessEntityId, a.id)));
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].assigneeId, staff.id, "giao NV phụ trách");
      assert.deepEqual(tasks[0].tags, [FB_CRM_TASK_TAG]);
      const dept = await db.query.departments.findFirst({ where: eq(schema.departments.id, tasks[0].departmentId!) });
      assert.equal(dept?.code, "SALES", "phòng Kinh doanh & CSKH");
      assert.ok(!(await fbCrmCreateTaskCore(viewer, a.id, {}, today)).ok, "thiếu customers:write ⇒ không tạo nhiệm vụ");
    });

    // ── Cách ly tổ chức: dòng nằm ở CSDL của tổ chức `fbc-si`; tổ chức nhà không thấy gì ──
    const homeDb = await getDb();
    const home = await homeDb.select().from(schema.customerFbConnections).where(eq(schema.customerFbConnections.customerId, customerA));
    assert.equal(home.length, 0, "tổ chức nhà KHÔNG đọc được kết nối Facebook của tổ chức khác");
    const homeEvents = await homeDb.select().from(schema.customerFbConnectionEvents).where(eq(schema.customerFbConnectionEvents.customerId, customerA));
    assert.equal(homeEvents.length, 0);
    await withOrganization(ORG, async () => {
      const rows = await (await getDb()).select().from(schema.customerFbConnections).where(eq(schema.customerFbConnections.customerId, customerA));
      assert.equal(rows.length, 1, "trong tổ chức thì có đúng một dòng");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Facebook CRM (CSDL tổ chức): danh sách = khách nhắn / có đơn · đã mua theo ORDER_OUTCOME (hoàn / huỷ không tính) · doanh thu thực chưa chứng từ ⇒ null · quyền customers:write · bấm lặp không ghi · nhiệm vụ không trùng và bị chặn khi không liên hệ · tổ chức nhà không thấy dòng nào");
}
