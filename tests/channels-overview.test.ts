/**
 * ═══════════ KÊNH KẾT NỐI HỢP NHẤT (lib/channels/*) ═══════════
 *
 * Khoá:
 *  · gộp page nối thẳng + Pancake + Zalo thành MỘT dòng mỗi page (page có ở hai đường không bị nhân đôi; Zalo không bao giờ đè
 *    page Facebook trùng chữ số); đường nhận tin lấy ĐÚNG `transportOwnerOf` (một nguồn sự thật);
 *  · sức khoẻ ba mức — «Sẵn sàng» đòi chứng cứ, lỗi một tin (ngoài 24 giờ / khách chặn) không hạ mức, mỗi mức khác luôn kèm việc;
 *  · câu khách không chứa thuật ngữ kỹ thuật (quét chuỗi) và không bao giờ mang câu gốc của Meta;
 *  · Configuration ID: thiếu ⇒ nói rõ đang xin bằng danh sách quyền; Meta từ chối cấu hình ⇒ câu ánh xạ; cấu hình thiếu quyền ⇒
 *    câu theo quyền thiếu, thừa quyền chỉ cảnh báo người vận hành; không ghi cứng mã cấu hình;
 *  · lớp đọc: người vận hành thấy chi tiết kỹ thuật, khách không; page của tổ chức khác không hiện; Pancake + nối thẳng cùng page
 *    là một dòng, đồng bộ cuối của Pancake đọc từ tin sống.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  CHANNELS_ROUTE,
  CHANNEL_HEALTH_LABEL,
  CHANNEL_OWNER_LABEL,
  aiControlOf,
  channelHealth,
  connectOutcome,
  connectionLabel,
  customerTextViolations,
  lastSyncOf,
  mergeChannelSources,
  pageAvatarUrl,
  type ChannelRowFacts,
  type ConnectionFacts,
  type DirectFacts,
  type DirectPageInput,
} from "@/lib/channels/overview-shared";
import { loadChannelsOverview } from "@/lib/channels/overview";
import { DISCOVERY_REASONS, MESSENGER_REQUIRED_PERMISSIONS, WEBHOOK_STATES, type DiscoveryReason } from "@/lib/integrations/messenger/graph";
import { CUSTOMER_GRAPH_ERROR_TEXT, GRAPH_ERROR_HINT, graphErrorKindOfText } from "@/lib/integrations/messenger/graph-errors";
import { CUSTOMER_DISCOVERY_TEXT, CUSTOMER_WEBHOOK_TEXT, DISCOVERY_GUIDE, classifyMetaConnectError, configPermissionAudit, customerDiscoveryIssue, loginConfigMode, loginModeText } from "@/lib/integrations/messenger/permission-guide";
import { currentOrganization } from "@/lib/platform/context";
import { transportOwnerOf, type TransportFacts } from "@/lib/sales-chatbot/channel-ownership";

const isReason = (x: string): x is DiscoveryReason => (DISCOVERY_REASONS as readonly string[]).includes(x);
const T0 = "2026-10-01T08:00:00.000Z";
const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-01T10:00:00.000Z";

const direct = (over: Partial<DirectFacts> = {}): DirectFacts => ({ status: "ACTIVE", kind: "PAGE", parentPageId: null, aiEnabled: true, lastEventAt: null, lastErrorAt: null, errorKind: null, hasError: false, legacy: false, ...over });
const conn = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({ status: "ACTIVE", lastTestOk: true, lastActivityAt: null, ...over });
const row = (over: Partial<ChannelRowFacts>): ChannelRowFacts => ({ key: "100000001", pageId: "100000001", name: "Shop A", platform: "FACEBOOK", owner: "MESSENGER", direct: direct(), pancake: null, zalo: null, ...over });

function testMerge() {
  const A = "100000001";
  const B = "100000002";
  const IG = "17841400000000001";
  const facts: TransportFacts = { pancake: { active: true, pageId: A }, messenger: { active: true, pageIds: [A, IG] } };
  const dp = (id: string, name: string, f: Partial<DirectFacts>): DirectPageInput => ({ id, name, ...direct(f) });
  const rows = mergeChannelSources({
    direct: [dp(A, "Shop A", {}), dp(IG, "Instagram @shopa", { kind: "INSTAGRAM", parentPageId: A }), dp(B, "Shop B", { status: "DISABLED" }), dp(A, "trùng", {})],
    pancake: { pageId: A, facts: conn() },
    // OA trùng CHỮ SỐ với page B — vẫn là dòng riêng.
    zalo: { oaId: B, facts: conn() },
    ownerOf: (id) => transportOwnerOf(facts, id),
  });
  assert.equal(rows.length, 4, `một dòng mỗi page, không nhân đôi: ${rows.map((r) => r.key).join(",")}`);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "khoá dòng không trùng");
  const a = rows.find((r) => r.key === A)!;
  assert.ok(a.direct && a.pancake, "page có ở hai đường là MỘT dòng mang cả hai bộ sự thật");
  assert.equal(a.name, "Shop A", "tên lấy từ đường nối thẳng");
  assert.equal(a.owner, "PANCAKE", "cả hai cùng bật ⇒ đúng kết luận của transportOwnerOf");
  assert.equal(rows.find((r) => r.key === IG)?.owner, "MESSENGER");
  assert.equal(rows.find((r) => r.key === B)?.owner, null, "page đã gỡ ⇒ không đường nào");
  assert.equal(rows.find((r) => r.key === `zalo:${B}`)?.owner, "ZALO");
  assert.equal(connectionLabel(rows.find((r) => r.key === B)!), "Đã gỡ");
  // Pancake một mình (không nối thẳng) ⇒ dòng riêng, tên mặc định.
  const solo = mergeChannelSources({ direct: [], pancake: { pageId: "200000009", facts: conn() }, zalo: null, ownerOf: (id) => transportOwnerOf({ pancake: { active: true, pageId: "200000009" }, messenger: { active: false, pageIds: [] } }, id) });
  assert.deepEqual(solo.map((r) => [r.key, r.owner, r.name]), [["200000009", "PANCAKE", "Fanpage 200000009"]]);
  assert.equal(aiControlOf(a).kind, "GLOBAL", "page đi Pancake ⇒ AI theo cấu hình chung (không bịa công tắc theo page)");
  assert.deepEqual(aiControlOf(row({})), { kind: "PAGE", on: true });
  assert.equal(pageAvatarUrl(row({})), "https://graph.facebook.com/100000001/picture?type=square&width=96&height=96");
  assert.equal(pageAvatarUrl(row({ platform: "INSTAGRAM" })), null, "Instagram không có ảnh công khai theo mã ⇒ chữ cái đầu");
  assert.equal(pageAvatarUrl(row({ pageId: "abc_pancake" })), null);
  assert.equal(CHANNELS_ROUTE, "/ai/channels");
}

function testHealth() {
  const h = (r: ChannelRowFacts, wh: Parameters<typeof channelHealth>[1] = null, appReady = true) => channelHealth(r, wh, appReady);
  assert.equal(h(row({ direct: direct({ lastEventAt: T1 }) })).level, "READY", "có tin ⇒ sẵn sàng");
  assert.equal(h(row({}), { state: "OK", at: T1 }).level, "READY", "kiểm đạt ⇒ sẵn sàng");
  const none = h(row({}));
  assert.equal(none.level, "NEEDS_ACTION", "chưa kiểm, chưa nhận tin ⇒ CHƯA BIẾT, không được in thành sẵn sàng");
  assert.ok(none.issue && /Nhắn thử/.test(none.issue.action));
  assert.equal(h(row({}), { state: "UNKNOWN", at: T1 }).level, "NEEDS_ACTION", "kiểm không đọc được ⇒ không kết luận khoẻ");
  assert.equal(h(row({ direct: direct({ lastEventAt: T0 }) }), { state: "TOKEN_EXPIRED", at: T1 }).level, "DISCONNECTED");
  assert.equal(h(row({ direct: direct({ lastEventAt: T0 }) }), { state: "NOT_SUBSCRIBED", at: T1 }).level, "DISCONNECTED");
  assert.equal(h(row({ direct: direct({ lastEventAt: T2 }) }), { state: "NOT_SUBSCRIBED", at: T1 }).level, "READY", "tin về SAU lần kiểm hỏng ⇒ chứng cứ mới hơn thắng");
  assert.equal(h(row({ direct: direct({ lastEventAt: T0 }) }), { state: "MISSING_FIELDS", at: T1 }).level, "NEEDS_ACTION");
  assert.equal(h(row({ direct: direct({ lastEventAt: T0, hasError: true, lastErrorAt: T1, errorKind: "TOKEN" }) })).level, "DISCONNECTED");
  assert.equal(h(row({ direct: direct({ lastEventAt: T0, hasError: true, lastErrorAt: T1, errorKind: "PERMISSION" }) })).level, "DISCONNECTED");
  assert.equal(h(row({ direct: direct({ lastEventAt: T2, hasError: true, lastErrorAt: T1, errorKind: "TOKEN" }) })).level, "READY", "lỗi cũ hơn tin gần nhất ⇒ đã hồi");
  for (const k of ["WINDOW", "RECIPIENT", "RATE_LIMIT"] as const) assert.equal(h(row({ direct: direct({ lastEventAt: T0, hasError: true, lastErrorAt: T1, errorKind: k }) })).level, "READY", `${k}: một tin không gửi được, kết nối KHÔNG hỏng`);
  assert.equal(h(row({ direct: direct({ lastEventAt: T0, hasError: true, lastErrorAt: T1, errorKind: null }) })).level, "NEEDS_ACTION", "lỗi không nhận ra loại ⇒ cần xử lý, không đoán là mất kết nối");
  const down = h(row({ direct: direct({ lastEventAt: T1 }) }), null, false);
  assert.ok(down.level === "NEEDS_ACTION" && down.issue?.who === "SUPPORT", "app nền tảng chưa cấu hình ⇒ việc của đội hỗ trợ, không đẩy khách");
  assert.equal(h(row({ owner: null, direct: direct({ status: "DISABLED", lastEventAt: T1 }) })).level, "DISCONNECTED", "đã gỡ");
  // Pancake / Zalo
  assert.equal(h(row({ owner: "PANCAKE", direct: null, pancake: conn() })).level, "READY");
  assert.equal(h(row({ owner: null, direct: null, pancake: conn({ status: "DRAFT", lastTestOk: null }) })).level, "NEEDS_ACTION");
  assert.equal(h(row({ owner: null, direct: null, pancake: conn({ status: "DISABLED" }) })).level, "DISCONNECTED");
  assert.equal(h(row({ owner: "ZALO", platform: "ZALO", direct: null, zalo: conn({ lastTestOk: false }) })).level, "NEEDS_ACTION");
  assert.notEqual(h(row({ owner: null, direct: null, pancake: null, zalo: null })).level, "READY", "không đường nào ⇒ không bao giờ sẵn sàng");
  const dual = h(row({ owner: "PANCAKE", pancake: conn(), direct: direct() }));
  assert.ok(dual.level === "READY" && dual.note && /Pancake/.test(dual.note), "nối hai đường ⇒ sức khoẻ của đường đang nhận + ghi chú");
  // Đồng bộ cuối theo ĐÚNG đường đang nhận tin; chưa có ⇒ null (không phải 0).
  assert.equal(lastSyncOf(row({ owner: "PANCAKE", direct: direct({ lastEventAt: T0 }), pancake: conn({ lastActivityAt: T2 }) })), T2);
  assert.equal(lastSyncOf(row({ direct: direct({ lastEventAt: T1 }) })), T1);
  assert.equal(lastSyncOf(row({})), null);
  // Mỗi mức khác «Sẵn sàng» luôn kèm MỘT việc phải làm.
  const matrix: ChannelRowFacts[] = [];
  for (const st of ["ACTIVE", "DISABLED"] as const) for (const kind of [null, "TOKEN", "PERMISSION", "OTHER"] as const) matrix.push(row({ owner: st === "ACTIVE" ? "MESSENGER" : null, direct: direct({ status: st, hasError: kind !== null, lastErrorAt: kind ? T1 : null, errorKind: kind === null ? null : kind }) }));
  for (const st of ["ACTIVE", "DRAFT", "DISABLED"] as const) matrix.push(row({ owner: st === "ACTIVE" ? "PANCAKE" : null, direct: null, pancake: conn({ status: st }) }), row({ key: "zalo:1", platform: "ZALO", owner: st === "ACTIVE" ? "ZALO" : null, direct: null, zalo: conn({ status: st, lastTestOk: st === "ACTIVE" ? false : null }) }));
  for (const r of matrix)
    for (const wh of [null, ...WEBHOOK_STATES.map((s) => ({ state: s, at: T1 }))]) {
      const x = channelHealth(r, wh, true);
      if (x.level !== "READY") assert.ok(x.issue && x.issue.title.length > 5 && x.issue.action.length > 10, `${x.level} phải kèm việc phải làm: ${JSON.stringify(r)}`);
      for (const s of [x.issue?.title ?? "", x.issue?.action ?? "", x.note ?? ""]) assert.deepEqual(customerTextViolations(s), [], `câu sức khoẻ có từ kỹ thuật: ${s}`);
    }
  assert.deepEqual(Object.keys(CHANNEL_HEALTH_LABEL).sort(), ["DISCONNECTED", "NEEDS_ACTION", "READY"], "đúng ba mức");
}

function testCustomerText() {
  // Bộ quét thật sự bắt được từ cấm (chống bộ quét câm): hướng dẫn KỸ THUẬT phải bị gắn cờ.
  assert.ok(customerTextViolations(DISCOVERY_GUIDE.PERMISSION_NOT_IN_APP.steps.join(" ")).length > 0, "bộ quét phải bắt được pages_* / App Dashboard");
  assert.ok(customerTextViolations("Token page hết hạn").length > 0 && customerTextViolations("Webhook chưa đăng ký").length > 0 && customerTextViolations("Verify token").length > 0 && customerTextViolations("lỗi API").length > 0);
  const texts: string[] = [];
  const push = (i: { title: string; action: string } | null | undefined) => {
    if (i) texts.push(i.title, i.action);
  };
  Object.values(CUSTOMER_DISCOVERY_TEXT).forEach(push);
  Object.values(CUSTOMER_WEBHOOK_TEXT).forEach(push);
  Object.values(CUSTOMER_GRAPH_ERROR_TEXT).forEach(push);
  texts.push(...Object.values(CHANNEL_OWNER_LABEL));
  for (const r of DISCOVERY_REASONS) push(customerDiscoveryIssue(r, { missing: ["pages_messaging", "pages_manage_metadata", "instagram_basic"], pageNames: ["Shop X"] }));
  for (const loi of ["quyen", "app", "huy", "state", "khongpage", "fb", "la"]) {
    for (const lydo of ["", ...DISCOVERY_REASONS]) {
      const o = connectOutcome({ loi, lydo, msg: "(#100) Invalid config_id token EAAGbimat", ct: "pages_messaging" }, { reason: lydo || null, missing: ["pages_messaging"], withoutMessaging: [{ name: "Shop X", tasks: [] }] }, isReason);
      assert.equal(o?.kind, "ERROR");
      if (o?.kind === "ERROR") {
        push(o.issue);
        assert.ok(!`${o.issue.title} ${o.issue.action}`.includes("EAAGbimat") && !`${o.issue.title} ${o.issue.action}`.includes("Invalid"), "câu gốc của Meta không bao giờ tới khách");
      }
    }
  }
  const declined = customerDiscoveryIssue("PERMISSION_DECLINED", { missing: ["pages_messaging"] });
  assert.match(declined.title, /quyền nhắn tin/, "nói quyền bằng tên thường");
  assert.match(declined.action, /Kết nối lại/);
  assert.equal(customerDiscoveryIssue("PERMISSION_NOT_IN_APP").who, "SUPPORT", "lỗi phía app ⇒ không bắt khách sửa");
  assert.match(customerDiscoveryIssue("NO_MESSAGING_TASK", { pageNames: ["Shop X"] }).title, /«Shop X»/);
  push(classifyMetaConnectError({ message: "Invalid Configuration ID" }, { configId: "123456789", appId: "999" })?.customer);
  push(classifyMetaConnectError({ message: "Something else" }, { configId: null, appId: "999" })?.customer);
  push(configPermissionAudit(["pages_show_list"], loginConfigMode("123456789"), MESSENGER_REQUIRED_PERMISSIONS).customer);
  const bad = texts.filter((t) => customerTextViolations(t).length).map((t) => `${t} [${customerTextViolations(t).join(",")}]`);
  assert.deepEqual(bad, [], `câu khách chứa từ kỹ thuật: ${bad.join(" | ")}`);
  assert.equal(connectOutcome({ chon: "1" }, null, isReason)?.kind, "PICK");
  assert.deepEqual(connectOutcome({ ok: "1", webhook: "NOT_SUBSCRIBED" }, null, isReason), { kind: "OK", webhook: "NOT_SUBSCRIBED" });
  assert.deepEqual(connectOutcome({ ok: "1", webhook: "LẠ" }, null, isReason), { kind: "OK", webhook: null });
  assert.equal(connectOutcome({}, null, isReason), null);
  // Loại lỗi đọc lại từ câu đã lưu: gợi ý của graph-errors ⇒ đúng loại; câu lạ ⇒ CHƯA BIẾT.
  assert.equal(graphErrorKindOfText(`Gửi tin: Facebook từ chối: Error validating — ${GRAPH_ERROR_HINT.TOKEN}`), "TOKEN");
  assert.equal(graphErrorKindOfText(`Facebook từ chối: x — ${GRAPH_ERROR_HINT.WINDOW}`), "WINDOW");
  assert.equal(graphErrorKindOfText("Không gọi được Facebook: timeout"), null);
  assert.equal(graphErrorKindOfText(null), null);
}

function testLoginConfig() {
  const scope = loginConfigMode("  ");
  assert.deepEqual(scope, { mode: "SCOPE" });
  assert.match(loginModeText(scope), /danh sách quyền \(không có Configuration ID\)/, "thiếu config ⇒ nói rõ đang xin bằng danh sách quyền");
  const cfg = loginConfigMode(" 555000111 ");
  assert.deepEqual(cfg, { mode: "CONFIG", configId: "555000111" });
  assert.match(loginModeText(cfg), /Configuration ID 555000111/);
  // Meta từ chối cấu hình ⇒ câu ánh xạ, nguyên văn chỉ cho người vận hành.
  const rej = classifyMetaConnectError({ message: "Facebook từ chối: Invalid config_id for this app" }, { configId: "555000111", appId: "777000222" });
  assert.ok(rej && rej.kind === "CONFIG_REJECTED");
  assert.match(rej.operator, /Configuration ID 555000111 không khớp app Messenger 777000222 — kiểm ở Meta: Facebook Login for Business → Configurations/);
  assert.match(rej.operator, /Invalid config_id/, "người vận hành thấy nguyên văn");
  assert.ok(!/Invalid|555000111|777000222/.test(`${rej.customer.title} ${rej.customer.action}`), "khách không thấy nguyên văn / mã");
  assert.match(rej.customer.title, /Kết nối Facebook chưa hoàn tất/);
  const rej2 = classifyMetaConnectError({ errorCode: "100", errorMessage: "Configuration not found" }, { configId: "", appId: "777000222" });
  assert.ok(rej2?.kind === "CONFIG_REJECTED" && /không có Configuration ID/.test(rej2.operator), "Meta đòi cấu hình mà ERP không khai ⇒ nói đúng chỗ");
  assert.equal(classifyMetaConnectError({ message: "Facebook từ chối: (#1) An unknown error" }, { configId: "555000111", appId: "1" })?.kind, "OTHER");
  assert.equal(classifyMetaConnectError({ message: "  " }, { configId: "1" }), null);
  // Đi bằng config mà thiếu quyền ⇒ câu theo quyền thiếu; thừa ⇒ chỉ cảnh báo người vận hành.
  const miss = configPermissionAudit(["public_profile", "pages_show_list", "pages_manage_metadata", "pages_read_engagement", "instagram_basic", "business_management"], cfg, MESSENGER_REQUIRED_PERMISSIONS);
  assert.deepEqual(miss.missing, ["pages_messaging"]);
  assert.deepEqual(miss.excess, ["instagram_basic", "business_management"]);
  assert.ok(miss.operator.some((l) => l === "Cấu hình Login for Business 555000111 thiếu quyền pages_messaging — thêm vào Configuration."), miss.operator.join(" | "));
  assert.ok(miss.operator.some((l) => /cấp thừa instagram_basic, business_management/.test(l) && /chỉ cảnh báo/.test(l)));
  assert.ok(miss.customer && /quyền nhắn tin/.test(miss.customer.title) && /Kết nối lại/.test(miss.customer.action) && miss.customer.who === "SHOP", "khách: câu dễ hiểu + nút kết nối lại");
  const excessOnly = configPermissionAudit([...MESSENGER_REQUIRED_PERMISSIONS, "instagram_manage_messages"], cfg, MESSENGER_REQUIRED_PERMISSIONS);
  assert.ok(excessOnly.customer === null && excessOnly.operator.length === 1, "thừa quyền không làm phiền khách");
  assert.deepEqual(configPermissionAudit(["pages_show_list"], scope, MESSENGER_REQUIRED_PERMISSIONS).operator, [], "đi bằng danh sách quyền ⇒ chẩn đoán cũ lo, không kết luận theo cấu hình");
  assert.equal(configPermissionAudit(null, cfg, MESSENGER_REQUIRED_PERMISSIONS).customer, null, "không đọc được quyền ⇒ không kết luận");
  // Không ghi cứng Configuration ID của chủ shop ở mã nguồn — chỉ đọc biến môi trường.
  const realId = ["2789212601", "473965"].join("");
  for (const f of ["lib/integrations/messenger/graph.ts", "lib/integrations/messenger/permission-guide.ts", "lib/env.ts", "lib/channels/overview-shared.ts", "lib/channels/overview.ts", "app/(dashboard)/ai/channels/page.tsx", "app/(dashboard)/platform/page.tsx", "app/(dashboard)/ai/sales-chatbot/messenger/page.tsx", "app/api/connect/messenger/start/route.ts"]) {
    assert.ok(!readFileSync(f, "utf8").includes(realId), `${f}: không ghi cứng Configuration ID`);
  }
  // Luồng OAuth không đổi: callback vẫn quay về trang Messenger; trang đó chỉ CHUYỂN TIẾP khi lượt bắt đầu từ màn Kênh kết nối.
  const cb = readFileSync("app/api/connect/messenger/callback/route.ts", "utf8");
  assert.match(cb, /new URL\(`\$\{MESSENGER_SETTINGS_PATH\}\?\$\{q\}`, origin\)/);
  const mp = readFileSync("app/(dashboard)/ai/sales-chatbot/messenger/page.tsx", "utf8");
  assert.match(mp, /get\(CHANNELS_RETURN_COOKIE\)\?\.value === "1" && \(one\("chon"\) \|\| one\("ok"\) \|\| one\("loi"\)\)/, "chỉ chuyển tiếp kết quả callback khi có cờ");
  assert.ok(!/one\("msg"\) \|\| "Facebook từ chối\."\s*:/.test(mp), "trang Messenger không còn in nguyên văn lỗi Meta cho mọi người");
}

async function testOverviewDb() {
  const ctx = await currentOrganization();
  const db = await getDb();
  const P = { A: "910000001", B: "910000002", OTHER: "910000003" } as const;
  const RAW = "Gửi tin: Facebook từ chối: Error validating access token: session invalidated — " + GRAPH_ERROR_HINT.TOKEN;
  const cp = schema.orgChannelPages;
  const oc = schema.orgConnections;
  const savedPancake = await db.select().from(oc).where(eq(oc.connectorKey, "pancake-fanpage"));
  const inboundIds: string[] = [];
  try {
    await db.delete(cp).where(inArray(cp.pageId, Object.values(P)));
    await db.insert(cp).values([
      { orgCode: ctx.code, connectorKey: "facebook-messenger", pageId: P.A, kind: "PAGE", name: "Shop A", status: "ACTIVE", lastEventAt: new Date(T0) },
      { orgCode: ctx.code, connectorKey: "facebook-messenger", pageId: P.B, kind: "PAGE", name: "Shop B", status: "ACTIVE", lastEventAt: new Date(T0), lastError: RAW, lastErrorAt: new Date(T1) },
      // Dây bẫy: hàng mang mã tổ chức KHÁC trong CSDL đang đọc ⇒ không bao giờ hiện.
      { orgCode: `${ctx.code}-khac`, connectorKey: "facebook-messenger", pageId: P.OTHER, kind: "PAGE", name: "Shop của tổ chức khác", status: "ACTIVE", lastEventAt: new Date(T0) },
    ]);
    await db.delete(oc).where(eq(oc.connectorKey, "pancake-fanpage"));
    await db.insert(oc).values({ orgCode: ctx.code, connectorKey: "pancake-fanpage", status: "ACTIVE", lastTestOk: true, settings: { pageId: P.A } });
    const inbound = await db.insert(schema.salesChatInbound).values({ pageId: P.A, threadId: "kenh-t1", messageId: `kenh-test-${Date.now()}`, text: "alo", status: "DONE" }).returning({ id: schema.salesChatInbound.id });
    inboundIds.push(...inbound.map((r) => r.id));

    const customer = await loadChannelsOverview({ operator: false });
    const mine = customer.rows.filter((r) => (Object.values(P) as string[]).includes(r.pageId));
    assert.deepEqual(mine.map((r) => r.pageId).sort(), [P.A, P.B], "page của tổ chức khác không hiện; page có hai đường là MỘT dòng");
    const a = mine.find((r) => r.pageId === P.A)!;
    assert.ok(a.direct && a.pancake && a.owner === "PANCAKE", "Pancake + nối thẳng cùng page ⇒ một dòng, Pancake nhận tin");
    assert.ok(a.pancake.lastActivityAt && lastSyncOf(a) === a.pancake.lastActivityAt, "đồng bộ cuối của Pancake đọc từ tin sống");
    const b = mine.find((r) => r.pageId === P.B)!;
    assert.equal(b.direct?.errorKind, "TOKEN", "loại lỗi đọc lại từ câu đã lưu");
    assert.equal(channelHealth(b, b.webhook, true).level, "DISCONNECTED");
    for (const r of customer.rows) assert.equal(r.technical, null, "khách không bao giờ nhận chi tiết kỹ thuật");
    assert.ok(!JSON.stringify(customer).includes("session invalidated"), "câu lỗi gốc không đi ra cho khách");

    const op = await loadChannelsOverview({ operator: true });
    const opB = op.rows.find((r) => r.pageId === P.B)!;
    assert.ok(opB.technical?.some((t) => t.includes("session invalidated")), "người vận hành thấy câu lỗi gốc");
    assert.ok(op.rows.find((r) => r.pageId === P.A)?.technical?.some((t) => /transportOwnerOf = PANCAKE/.test(t)));
    assert.ok(!op.rows.some((r) => r.pageId === P.OTHER), "kể cả người vận hành: lớp đọc chỉ thấy tổ chức ngữ cảnh");
  } finally {
    await db.delete(cp).where(inArray(cp.pageId, Object.values(P)));
    await db.delete(oc).where(eq(oc.connectorKey, "pancake-fanpage"));
    if (savedPancake.length) await db.insert(oc).values(savedPancake);
    if (inboundIds.length) await db.delete(schema.salesChatInbound).where(and(inArray(schema.salesChatInbound.id, inboundIds), eq(schema.salesChatInbound.threadId, "kenh-t1")));
  }
}

export async function testChannelsOverview() {
  testMerge();
  testHealth();
  testCustomerText();
  testLoginConfig();
  await testOverviewDb();
  console.log("✓ Kênh kết nối: gộp nối thẳng + Pancake + Zalo một dòng mỗi page, đường nhận tin theo transportOwnerOf · sức khoẻ ba mức (sẵn sàng đòi chứng cứ, lỗi một tin không hạ mức, mức khác luôn kèm việc) · câu khách không từ kỹ thuật, không nguyên văn Meta · Configuration ID: thiếu / bị từ chối / thiếu quyền / thừa quyền, không ghi cứng · người vận hành thấy chi tiết, khách không · page của tổ chức khác không hiện");
}

if (/channels-overview\.test\.ts$/.test(process.argv[1] ?? "")) {
  testChannelsOverview()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
