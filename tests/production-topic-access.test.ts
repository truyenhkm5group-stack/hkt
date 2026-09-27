import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Role } from "@/db/schema";
import { DEFAULT_ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { buildTopicEvidenceSnapshot, EMPTY_REQUIREMENTS } from "@/lib/constants/production-os";
import { registerProvisionalModelCore } from "@/lib/models/service";
import { canOpenTopic, loadTopicAccess, topicAccess, topicAudience, type TopicViewer } from "@/lib/production/topic-access";
import { notifyTopicMessage, notifyTopicTagged, TOPIC_INBOX_KIND } from "@/lib/production/topic-notify";
import { addTopicMembersCore, createTopicCore, removeTopicMemberCore } from "@/lib/production/topics";
import { getModelProductionSummary } from "@/lib/queries/model-production";
import { listTopics } from "@/lib/queries/production-os";
import { adaptProductionTopics } from "@/lib/queries/work-adapters";
import { parseListParams } from "@/lib/search-params";

/**
 * ═══ TOPIC SẢN XUẤT: TAG NGƯỜI · TOPIC RIÊNG · MARKETING MỞ TOPIC (chủ shop 27/09/2026) ═══
 *
 * "Những người được tag mới xem được topic": luật sống ở `lib/production/topic-access.ts`, bản THUẦN
 * (`topicAccess`) và bản SQL (`topicVisibleSql`) — bài này chạy cả hai trên cùng tình huống.
 */

const P = "pta-";
const vw = (id: string, role: Role, permissions: string[]): TopicViewer => ({ id, role, permissions });

export function testProductionTopicAccessPure() {
  const rieng = (createdByUserId: string | null, isMember = false) => ({ restricted: true, createdByUserId, isMember });
  const cu = (createdByUserId: string | null, isMember = false) => ({ restricted: false, createdByUserId, isMember });

  // Topic RIÊNG: người ngoài có đủ quyền sản xuất vẫn KHÔNG thấy.
  const sx = vw("sx", "LEADER", ["planning:view", "production:write"]);
  assert.deepEqual(topicAccess(sx, rieng("mkt")), { view: false, post: false, setStatus: false, tag: false, untag: false }, "không được tag ⇒ không xem, không ghi");
  // Người mở: đủ mọi quyền trong topic của mình.
  const mkt = vw("mkt", "MARKETING", ["planning:view", "production:topic-open"]);
  assert.deepEqual(topicAccess(mkt, rieng("mkt")), { view: true, post: true, setStatus: true, tag: true, untag: true });
  // Người được tag: xem, trao đổi, tag thêm; không bỏ tag người khác, không đổi trạng thái nếu không có quyền sản xuất.
  const kho = vw("kho", "WAREHOUSE", []);
  assert.deepEqual(topicAccess(kho, rieng("mkt", true)), { view: true, post: true, setStatus: false, tag: true, untag: false }, "được tag ⇒ xem được kể cả không có planning:view");
  assert.equal(topicAccess(sx, rieng("mkt", true)).setStatus, true, "được tag + quyền sản xuất ⇒ đổi trạng thái được");
  // ADMIN (chủ shop) xem mọi topic.
  assert.equal(topicAccess(vw("ad", "ADMIN", []), rieng("mkt")).view, true);
  // Topic CŨ (trước 0153): tầm nhìn cũ — planning:view xem, production:write ghi.
  assert.deepEqual(topicAccess(vw("x", "VIEWER", ["planning:view"]), cu("ai-do")), { view: true, post: false, setStatus: false, tag: false, untag: false });
  assert.equal(topicAccess(sx, cu("ai-do")).post, true);
  assert.equal(topicAccess(vw("x", "VIEWER", []), cu("ai-do")).view, false, "không có planning:view ⇒ topic cũ cũng không xem");
  assert.equal(topicAccess(mkt, rieng(null)).view, false, "người mở đã xoá tài khoản (NULL) không trùng với ai");

  // Marketing mở được topic bằng khoá HẸP, không nhận quyền sản xuất đầy đủ.
  assert.ok(DEFAULT_ROLE_PERMISSIONS.MARKETING.includes("production:topic-open"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.MARKETING.includes("production:write"), "marketing KHÔNG nhận production:write (giá thành / mẫu thử)");
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.WAREHOUSE.includes("production:topic-open"));
  assert.equal(canOpenTopic(vw("m", "MARKETING", [...DEFAULT_ROLE_PERMISSIONS.MARKETING])), true);
  assert.equal(canOpenTopic(vw("k", "WAREHOUSE", [...DEFAULT_ROLE_PERMISSIONS.WAREHOUSE])), false);
  assert.equal(canOpenTopic(vw("l", "LEADER", ["production:write"])), true, "quyền sản xuất đầy đủ vẫn mở được");

  // Mọi đường đọc / ghi hỏi CÙNG một chỗ — quét mã nguồn.
  const route = readFileSync("app/api/production/files/[id]/route.ts", "utf8");
  assert.ok(route.includes("loadTopicAccess(") && !route.includes('can(user, "planning:view")'), "ảnh / video phục vụ theo quyền xem TOPIC");
  const files = readFileSync("lib/actions/production-topic-files.ts", "utf8");
  assert.ok(files.includes("loadTopicAccess(") && !files.includes('"production:write"'), "đính kèm theo quyền ghi trong topic");
  const acts = readFileSync("lib/actions/production-topics.ts", "utf8");
  assert.ok(acts.includes("canOpenTopic(user)") && acts.includes("restricted: true") && !acts.includes('can(user, "production:write")'), "mở topic = canOpenTopic; topic mới là topic riêng");
  const detail = readFileSync("app/(dashboard)/production/topics/[id]/page.tsx", "utf8");
  assert.ok(detail.includes("loadTopicAccess(") && detail.includes("if (!acc?.view) notFound()"), "trang topic 404 với người không được xem");
  assert.ok(readFileSync("lib/queries/work-adapters.ts", "utf8").includes("eq(t.restricted, false)"), "topic riêng không lên hàng đợi phòng");
  const nav = readFileSync("lib/constants/department-modules.ts", "utf8");
  assert.ok(nav.includes('href: "/marketing/topics"') && nav.includes('permission: "production:topic-open"'), "menu Marketing có Topic gửi sản xuất");
  assert.ok(readFileSync("app/(dashboard)/production/topics/new/page.tsx", "utf8").includes("redirect("), "đường cũ chuyển sang biểu mẫu Marketing");

  // Ảnh hiện TRỌN, bấm vào xem lớn trong trang — không mở tab ngoài.
  const tf = readFileSync("app/(dashboard)/production/_components/topic-files.tsx", "utf8");
  assert.ok(!tf.includes('target="_blank"'), "bấm ảnh không mở link ngoài");
  assert.ok(tf.includes("<ImageLightbox") && !/<img[^>]*object-cover/.test(tf), "ảnh không bị cắt (object-contain) và có popup xem lớn");
  const form = readFileSync("app/(dashboard)/marketing/topics/new/topic-form.tsx", "utf8");
  assert.ok(form.includes("<PeoplePicker") && form.includes("memberIds,"), "biểu mẫu tag được nhiều người");

  console.log("✓ Topic sản xuất: topic riêng chỉ người mở + người được tag + ADMIN · topic cũ giữ tầm nhìn cũ · marketing mở topic bằng khoá hẹp · ảnh xem trọn + popup");
}

export async function testProductionTopicAccessDb(db: Db) {
  const MKT = `${P}mkt`;
  const SX = `${P}sx`;
  const NGOAI = `${P}ngoai`;
  const KHOA = `${P}khoa`;
  await db.insert(schema.users).values([
    { id: MKT, email: "pta-mkt@test.local", name: "Marketer A", passwordHash: "x", role: "MARKETING" },
    { id: SX, email: "pta-sx@test.local", name: "Sản xuất B", passwordHash: "x", role: "WAREHOUSE" },
    { id: NGOAI, email: "pta-ngoai@test.local", name: "Trưởng nhóm C", passwordHash: "x", role: "LEADER" },
    { id: KHOA, email: "pta-khoa@test.local", name: "Đã nghỉ", passwordHash: "x", role: "LEADER", active: false },
  ]);
  const mkt = { id: MKT, label: "Marketer A" };
  const vMkt = vw(MKT, "MARKETING", [...DEFAULT_ROLE_PERMISSIONS.MARKETING]);
  const vSx = vw(SX, "WAREHOUSE", []);
  const vNgoai = vw(NGOAI, "LEADER", [...DEFAULT_ROLE_PERMISSIONS.LEADER]);
  const vAdmin = vw(`${P}admin`, "ADMIN", []);

  const reg = await registerProvisionalModelCore(db, { name: "Đầm test tag", state: "ADS_TESTING", actor: mkt, source: "test" });
  assert.ok("ok" in reg);
  if (!("ok" in reg)) return;
  const evidence = buildTopicEvidenceSnapshot({ orders30d: null, ordersTotal: null, adSpend30d: null }, null, new Date());
  const req = { ...EMPTY_REQUIREMENTS, material: "Thun rayon", salePrice: 499_000, targetPrice: 160_000 };

  // ─── Mở topic riêng, tag lúc mở: tự tag chính mình / tài khoản khoá / trùng đều bị loại ───
  const t = await createTopicCore(db, { modelId: reg.modelId, title: "Hỏi giá PTA", requirements: req, supplierId: null, evidence, restricted: true, memberIds: [SX, SX, MKT, KHOA], actor: mkt });
  assert.ok("ok" in t);
  if (!("ok" in t)) return;
  const mb = schema.productionTopicMembers;
  const dsTag = await db.select({ userId: mb.userId, addedByUserId: mb.addedByUserId }).from(mb).where(eq(mb.topicId, t.topicId));
  assert.deepEqual(dsTag, [{ userId: SX, addedByUserId: MKT }], "chỉ người thật sự mới, còn bật, không phải người mở");
  // Topic cũ (không riêng) để so tầm nhìn.
  const cu = await createTopicCore(db, { modelId: reg.modelId, title: "Topic cũ PTA", requirements: req, supplierId: null, evidence, actor: mkt });
  assert.ok("ok" in cu);
  if (!("ok" in cu)) return;

  // ─── Quyền theo topic: bản SQL khớp bản thuần ───
  assert.equal((await loadTopicAccess(db, t.topicId, vNgoai))?.view, false, "người ngoài không xem được dù có production:write");
  assert.equal((await loadTopicAccess(db, t.topicId, vSx))?.post, true, "người được tag trao đổi được");
  assert.equal((await loadTopicAccess(db, t.topicId, vMkt))?.untag, true);
  assert.equal(await loadTopicAccess(db, `${P}khong-co`, vMkt), null);
  const params = parseListParams({ q: "PTA" }, { defaultSort: "updatedAt", defaultDir: "desc", filterKeys: [], sortable: ["updatedAt"], defaultPeriod: "all" });
  const ids = async (v: TopicViewer, mine = false) => (await listTopics(params, v, { mine })).rows.map((r) => r.id).sort();
  assert.deepEqual(await ids(vNgoai), [cu.topicId], "người ngoài chỉ thấy topic cũ");
  assert.deepEqual(await ids(vSx), [t.topicId], "người được tag (không planning:view) chỉ thấy topic mình được tag");
  assert.deepEqual(await ids(vAdmin), [t.topicId, cu.topicId].sort(), "ADMIN thấy hết");
  assert.deepEqual(await ids(vMkt, true), [t.topicId, cu.topicId].sort(), "Marketing · của tôi: mọi topic mình mở");
  assert.deepEqual(await ids(vAdmin, true), [], "ADMIN · của tôi: không mở / không được tag topic nào");
  const dong = (await listTopics(params, vAdmin)).rows.find((r) => r.id === t.topicId);
  assert.equal(dong?.members, 1);
  assert.equal(dong?.restricted, true);

  // Trang mẫu: topic riêng vẫn ĐẾM nhưng không lộ tiêu đề với người ngoài.
  const tomTat = await getModelProductionSummary(reg.modelId, vNgoai);
  const an = tomTat?.topics.find((x) => x.id === t.topicId);
  assert.equal(an?.hidden, true);
  assert.equal(an?.title, "");
  assert.equal(tomTat?.topics.find((x) => x.id === cu.topicId)?.hidden, false);
  assert.equal((await getModelProductionSummary(reg.modelId))?.topics.every((x) => !x.hidden), true, "không có người xem ⇒ không ẩn");
  // Hàng đợi phòng không mang topic riêng.
  const viec = await adaptProductionTopics(new Date());
  assert.ok(!viec.some((w) => w.sourceKey === t.topicId), "topic riêng không lên hàng đợi");
  assert.ok(viec.some((w) => w.sourceKey === cu.topicId));

  // ─── Tag thêm (nhiều người một lượt), bỏ tag ───
  const them = await addTopicMembersCore(db, { topicId: t.topicId, userIds: [NGOAI, SX], actor: mkt });
  assert.ok("ok" in them && them.added.length === 1 && them.added[0] === NGOAI, "người đã ở trong topic không bị tag lại");
  assert.equal((await loadTopicAccess(db, t.topicId, vNgoai))?.view, true, "được tag ⇒ xem được ngay");
  assert.deepEqual((await topicAudience(db, t.topicId, SX)).sort(), [MKT, NGOAI].sort(), "người nhận tin = người mở + người được tag, trừ người vừa viết");
  const bo = await removeTopicMemberCore(db, { topicId: t.topicId, userId: NGOAI, actor: mkt });
  assert.ok("ok" in bo && bo.removed);
  assert.equal((await loadTopicAccess(db, t.topicId, vNgoai))?.view, false, "bỏ tag ⇒ thôi xem");
  assert.ok("error" in (await addTopicMembersCore(db, { topicId: t.topicId, userIds: [NGOAI], actor: { id: null, label: "máy" } })), "mục 34: tag phải mang khoá tài khoản");

  // ─── Tin hộp thư: vào đúng người, không nhân đôi ───
  const at = new Date("2026-09-27T10:00:00Z");
  assert.equal(await notifyTopicTagged(db, { topicId: t.topicId, title: "Hỏi giá PTA", userIds: [SX], byName: "Marketer A", at }), 1);
  assert.equal(await notifyTopicTagged(db, { topicId: t.topicId, title: "Hỏi giá PTA", userIds: [SX], byName: "Marketer A", at }), 0, "cùng lượt tag không gửi hai lần");
  assert.equal(await notifyTopicMessage(db, { topicId: t.topicId, title: "Hỏi giá PTA", messageId: `${P}msg1`, authorId: SX, authorName: "Sản xuất B" }), 1, "chỉ người mở nhận (người viết không tự nhận)");
  const hop = await db
    .select({ userId: schema.userMessages.userId, kind: schema.userMessages.kind, href: schema.userMessages.href })
    .from(schema.userMessages)
    .where(and(eq(schema.userMessages.href, `/production/topics/${t.topicId}`)));
  assert.deepEqual(
    hop.map((h) => [h.userId, h.kind]).sort(),
    [
      [MKT, TOPIC_INBOX_KIND.MESSAGE],
      [SX, TOPIC_INBOX_KIND.TAGGED],
    ].sort(),
  );

  console.log("✓ Topic sản xuất (CSDL): tag lúc mở loại trùng / tự tag / tài khoản khoá · danh sách lọc đúng theo người xem · trang mẫu đếm nhưng ẩn tiêu đề · hàng đợi bỏ topic riêng · tag thêm / bỏ tag đổi quyền xem ngay · tin hộp thư không nhân đôi");
}
