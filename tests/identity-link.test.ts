/**
 * ═══ CÙNG MỘT KHÁCH QUA HAI HỘI THOẠI — CHỈ BẰNG ĐỊNH DANH NỀN TẢNG (lib/sales-chatbot/identity-link.ts, P0 HSLC 24/10/2026) ═══
 *
 * Ca «Trần Thị Ngọc» (đã che, mã dựng): hội thoại BÌNH LUẬN (from_id = PSID, mã bình luận) và hội thoại HỘP THƯ `<page>_<PSID>` có tin hệ
 * thống Meta mang `comment_id=` của đúng bình luận ⇒ VERIFIED bằng HAI bằng chứng. Khoá: khác page ⇒ NONE · chỉ trùng SĐT ⇒ SAME_PHONE_ONLY
 * (không gộp) · bình luận cũ chưa có commentOrigin ⇒ LEGACY · không so tên (dữ kiện không có trường tên) · bộ nạp đọc đúng CSDL ·
 * `sameCustomerConversations` trả cả hội thoại HANDOFF / người giữ, không trả chính X, lọc mức theo `minLevel`.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import {
  COMMENT_ORIGIN_MAX,
  commentIdTail,
  loadIdentityFacts,
  mergeCommentOrigin,
  metaCommentRefsOf,
  sameCustomerConversations,
  verifiedSameCustomer,
  type ConversationIdentityFacts,
} from "@/lib/sales-chatbot/identity-link";

const PAGE = "100200300400500";
const PSID = "29100200300400500";
const POST = "481260000000001";
const CID = "1132201893038346";
const META_TEXT = `Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/${PAGE}/posts/${POST}/?comment_id=${CID})`;

const base = (over: Partial<ConversationIdentityFacts>): ConversationIdentityFacts => ({
  conversationId: "x",
  pageId: PAGE,
  threadId: null,
  origin: "OTHER",
  psid: null,
  commentFromIds: [],
  commentIds: [],
  metaCommentRefs: [],
  fbIds: [],
  customerId: null,
  customerLinkedBy: null,
  phones: [],
  ...over,
});

export function testIdentityLinkPure() {
  const comment = base({ conversationId: "cmt", origin: "COMMENT", threadId: "m_shyjBB5_xx", commentFromIds: [PSID], commentIds: [`${POST}_${CID}`, `${POST}_${CID}`] });
  const inbox = base({ conversationId: "inb", origin: "INBOX", threadId: `${PAGE}_${PSID}`, psid: PSID, metaCommentRefs: [CID], fbIds: [PSID] });
  const v = verifiedSameCustomer(comment, inbox);
  assert.equal(v.level, "VERIFIED");
  assert.deepEqual(v.evidence.map((e) => e.kind).sort(), ["COMMENT_FROM_ID_IS_PSID", "META_COMMENT_REFERENCE"], `ca Ngọc: hai bằng chứng — ${JSON.stringify(v)}`);
  assert.deepEqual(verifiedSameCustomer(inbox, comment).level, "VERIFIED", "đối xứng");
  // Chỉ một trong hai bằng chứng vẫn đủ.
  assert.equal(verifiedSameCustomer({ ...comment, commentFromIds: [] , origin: "COMMENT" }, inbox).evidence[0]?.kind, "META_COMMENT_REFERENCE", "bình luận cũ (chưa lưu from_id) vẫn nối được bằng comment_id của Meta");
  assert.equal(verifiedSameCustomer(comment, { ...inbox, metaCommentRefs: [] }).evidence[0]?.kind, "COMMENT_FROM_ID_IS_PSID");
  // Khác page ⇒ NONE, kể cả cùng mã người (mã Facebook theo page không so được giữa hai page).
  assert.deepEqual(verifiedSameCustomer(comment, { ...inbox, pageId: "999" }).reason, "DIFFERENT_PAGE");
  // Chỉ trùng SĐT ⇒ SAME_PHONE_ONLY, không phải VERIFIED.
  const a = base({ conversationId: "a", origin: "INBOX", psid: "1", phones: ["0961007101"] });
  const b = base({ conversationId: "b", origin: "INBOX", psid: "2", phones: ["0961007101"] });
  assert.deepEqual([verifiedSameCustomer(a, b).level, verifiedSameCustomer(a, b).evidence[0]?.kind], ["SAME_PHONE_ONLY", "SAME_PHONE"]);
  assert.deepEqual(verifiedSameCustomer({ ...a, phones: [] }, b).reason, "IDS_DIFFER");
  // Bình luận cũ không lưu người bình luận, không có liên kết Meta ⇒ LEGACY, không đoán.
  assert.deepEqual(verifiedSameCustomer(base({ conversationId: "old", origin: "COMMENT" }), inbox).reason, "LEGACY_NO_COMMENT_ORIGIN");
  assert.deepEqual(verifiedSameCustomer(base({ conversationId: "p" }), base({ conversationId: "q" })).reason, "NO_PLATFORM_ID");
  assert.deepEqual(verifiedSameCustomer(comment, comment).evidence, [{ kind: "SAME_CONVERSATION" }]);
  assert.deepEqual(verifiedSameCustomer(base({ conversationId: "t1", threadId: "th" }), base({ conversationId: "t2", threadId: "th" })).evidence[0], { kind: "SAME_THREAD", pageId: PAGE });
  // Không có trường tên nào trong dữ kiện — không thể so tên.
  assert.ok(!Object.keys(base({})).some((k) => /name|ten/i.test(k)), "dữ kiện danh tính không mang tên");
  assert.doesNotMatch(readFileSync("lib/sales-chatbot/identity-link.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""), /customerName|billFullName|\.name\b/, "mã không đọc tên");

  assert.deepEqual(metaCommentRefsOf([META_TEXT, "chữ khác"]), [CID]);
  assert.equal(commentIdTail(`${POST}_${CID}`), CID);
  const o1 = mergeCommentOrigin(undefined, [{ messageId: `${POST}_${CID}`, threadId: `${POST}_${CID}`, fromId: PSID, postId: `${PAGE}_${POST}` }], new Date("2026-10-24T06:55:22Z"));
  assert.deepEqual(o1, { postId: `${PAGE}_${POST}`, commentIds: [`${POST}_${CID}`], fromIds: [PSID], at: "2026-10-24T06:55:22.000Z" }, "không trùng mã");
  const many = Array.from({ length: COMMENT_ORIGIN_MAX + 5 }, (_, i) => ({ messageId: `c${i}`, threadId: "t", fromId: PSID, postId: null }));
  assert.ok((mergeCommentOrigin(o1, many, new Date())?.commentIds.length ?? 0) <= COMMENT_ORIGIN_MAX, "có trần");
  assert.equal(mergeCommentOrigin(o1, [], new Date()), null);
  // Lượt bình luận ghi commentOrigin TRƯỚC lượt chat (chỗ duy nhất còn giữ người bình luận sau khi hội thoại đổi luồng).
  const fp = readFileSync("lib/sales-chatbot/fanpage.ts", "utf8");
  assert.ok(fp.indexOf("mergeCommentOrigin(") > 0 && fp.indexOf("mergeCommentOrigin(") < fp.indexOf("draftCopilotSuggestion({"), "commentOrigin ghi trước lượt chat / gợi ý");
  console.log("  ✓ thuần: ca Ngọc VERIFIED bằng from_id = PSID + comment_id Meta · khác page NONE · chỉ SĐT SAME_PHONE_ONLY · bình luận cũ LEGACY · không đọc tên · commentOrigin có trần");
}

const ORG = "id-link";

async function cleanup() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testDb() {
  await withOrganization(ORG, async () => {
    const db = await getDb();
    const c = schema.salesChatConversations;
    const conv = async (over: Partial<typeof c.$inferInsert>) => (await db.insert(c).values({ channel: "FANPAGE", pageId: PAGE, ...over }).returning({ id: c.id }))[0].id;
    // Hội thoại bình luận đã chuyển (luồng = mã tin «m_…» như production) + commentOrigin.
    const cmt = await conv({ threadId: "m_shyjBB5_xx", visitorKey: fanpageVisitorKey(PAGE, "m_shyjBB5_xx"), state: { postContext: { postId: POST, text: null }, commentOrigin: { postId: POST, commentIds: [`${POST}_${CID}`], fromIds: [PSID], at: new Date().toISOString() } } });
    // Hội thoại hộp thư của chính khách — đang HANDOFF (nhân viên giữ).
    const inbox = await conv({ threadId: `${PAGE}_${PSID}`, visitorKey: fanpageVisitorKey(PAGE, `${PAGE}_${PSID}`), status: "HANDOFF", humanCooldownUntil: new Date(Date.now() + 3_600_000) });
    await db.insert(schema.salesChatInbound).values([
      { pageId: PAGE, threadId: `${PAGE}_${PSID}`, messageId: "idl-meta", text: META_TEXT, status: "DONE", note: "PAGE_REPLY", senderKind: "META_SYSTEM" },
      { pageId: PAGE, threadId: `${PAGE}_${PSID}`, messageId: "idl-cust", text: "Cho 1l nước mắm", status: "DONE", senderId: PSID, transport: "PANCAKE" },
    ]);
    // Người KHÁC cùng SĐT (người nhà) — chỉ SAME_PHONE_ONLY.
    const family = await conv({ threadId: `${PAGE}_29999999999999999`, customerPhone: "0961007101", state: { customer: { phone: "0961007101" } } });
    await db.update(c).set({ customerPhone: "0961007101" }).where(eq(c.id, inbox));
    // Page khác, cùng PSID ⇒ không bao giờ nối.
    await db.insert(c).values({ channel: "FANPAGE", pageId: "999", threadId: `999_${PSID}` });

    const f = await loadIdentityFacts(inbox);
    assert.ok(f && f.origin === "INBOX" && f.psid === PSID && f.metaCommentRefs.includes(CID), `bộ nạp đọc PSID + comment_id Meta: ${JSON.stringify(f)}`);
    const fc = await loadIdentityFacts(cmt);
    assert.ok(fc && fc.origin === "COMMENT" && fc.commentFromIds.includes(PSID), `bộ nạp đọc commentOrigin: ${JSON.stringify(fc)}`);
    assert.equal(await loadIdentityFacts("00000000-0000-0000-0000-000000000000"), null);

    const fromCmt = await sameCustomerConversations(cmt);
    assert.deepEqual(fromCmt.map((x) => x.conversationId), [inbox], `từ bình luận ⇒ đúng hộp thư của chính khách: ${JSON.stringify(fromCmt)}`);
    assert.equal(fromCmt[0].verdict.level, "VERIFIED");
    assert.deepEqual([fromCmt[0].status, fromCmt[0].heldByHuman], ["HANDOFF", true], "trả cả hội thoại HANDOFF / người giữ, kèm trạng thái");
    const fromInbox = await sameCustomerConversations(inbox);
    assert.deepEqual(fromInbox.map((x) => x.conversationId), [cmt], "đối xứng; không trả chính X; người nhà cùng SĐT KHÔNG có ở mức VERIFIED");
    const withPhone = await sameCustomerConversations(inbox, { minLevel: "SAME_PHONE_ONLY" });
    assert.deepEqual(withPhone.map((x) => [x.conversationId, x.verdict.level]).sort(), [[cmt, "VERIFIED"], [family, "SAME_PHONE_ONLY"]].sort(), `minLevel SAME_PHONE_ONLY ⇒ thêm người nhà, đúng mức: ${JSON.stringify(withPhone)}`);
  });
}

export async function testIdentityLink(): Promise<void> {
  testIdentityLinkPure();
  await cleanup();
  await provisionOrganization({ code: ORG, name: ORG, plan: "starter", modules: ["customers", "products", "orders", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "IdLink@12345" }, source: "TEST", actor: null });
  try {
    await testDb();
  } finally {
    await cleanup();
  }
  console.log("✓ Cùng một khách qua hai hội thoại (identity-link): chỉ định danh nền tảng · VERIFIED / SAME_PHONE_ONLY / NONE + lý do · bộ nạp đọc commentOrigin + PSID + comment_id Meta · sameCustomerConversations gồm HANDOFF, không gồm page khác");
}
