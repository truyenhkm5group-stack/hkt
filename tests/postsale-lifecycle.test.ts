/**
 * ═══════════ HẬU MÃI + AI DỪNG + HÀNG ĐỢI CHUNG (HOTFIX P0 12/10/2026 — ca HSLC «Khanh Nhung», đơn #6495CA72) ═══════════
 *
 * Ca thật: hộp thư «AI đã dừng · chờ 1.500+ phút · KHÔNG CHỦ», đơn «Chưa gửi», khách «Tôi nhận hàng rồi nhưng chưa thử chất lượng».
 * Bài kiểm khoá:
 *  1. THUẦN — giai đoạn khách (`customerPhaseOf`, phép chiếu của ảnh chụp vòng đời): tư vấn · đang chốt · chờ giao · đang giao · đã nhận
 *     (nguồn ĐVVC vs LỜI KHÁCH) · chăm sóc sau bán · khiếu nại; lời khách KHÔNG đổi `fulfillment`. Câu «đã nhận hàng» / «khiếu nại» hẹp.
 *     Lời dặn hậu mãi không mời chốt lại, không lên đơn mới, không nói «đã giao thành công» khi chỉ có lời khách.
 *  2. ĐỒNG HỒ AI HỎNG — mốc thật `state.handoff.at`, không phải `updated_at` (bị mọi lượt ghi đẩy tới): bản thuần ≡ bản SQL trên PGlite.
 *  3. PGlite (tổ chức `hau-mai-ai-dung` + tổ chức thứ hai cho CÁCH LY): watchdog của lượt quét mở lại hội thoại AI hỏng / nhân viên nhường
 *     ĐÃ HẾT HẠN, KHÔNG đụng chuyển người bắt buộc / tiếp quản / luật cũ sau chốt; phòng trống ⇒ hàng đợi chung + MỘT tin quản trị mỗi phòng
 *     mỗi ngày (quét hai lần ⇒ một tin); lõi trả-cho-AI luật cũ: chạy thử không ghi, `--apply` chỉ trả hội thoại không ai cầm, chạy lại
 *     không ghi thêm (idempotent), không đụng tổ chức khác.
 *  4. Nhãn «Chưa gửi» ⇒ «Chưa có vận đơn» (ERP không có vận đơn ≠ shop chưa gửi). Panel đơn: lỗi gọi ⇒ câu nói đúng cách sửa.
 *  5. MÃ NGUỒN — engine không còn chuyển người mặc định sau chốt; ops-vps khai đủ bốn chỗ cho `sales-postorder-handoff-release`.
 * Vòng đời đầu-cuối tư vấn → chốt → hậu mãi → khiếu nại chạy ở bộ hội thoại vàng (`hau-mai-da-nhan-hang`). Mốc theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { AI_DOWN_HANDOFF_REASON, AI_DOWN_UNANSWERED_REASON, aiDownStartedAt, aiHoldOf, FANPAGE_STAFF_REASON, HUMAN_COOLDOWN_MS } from "@/lib/sales-chatbot/ai-hold-shared";
import { DEAD_AI_DOWN_NOTE } from "@/lib/sales-chatbot/inbound-retry";
import { CLAIM_HANDOFF_REASON } from "@/lib/sales-chatbot/claim-guard";
import { TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { sweepHandoffOwnership } from "@/lib/sales-chatbot/handoff-routing";
import { INBOX_OUTCOME_LABEL } from "@/lib/sales-chatbot/inbox-shared";
import { classifyInboxState, needsHumanReasonSql } from "@/lib/sales-chatbot/inbox-states";
import { customerComplaintSignal, customerNotReceivedSignal, customerPhaseOf, customerReceiptClaim, postSalePrompt, type LifecycleSnapshot } from "@/lib/sales-chatbot/lifecycle";
import { orderPanelCallError, INBOX_ORDER_READ_FAILED } from "@/lib/sales-chatbot/order-verification-shared";
import { customerRequestKinds, LEGACY_POST_ORDER_REASON_PREFIX, releaseLegacyPostOrderHandoffs, releaseVerdict } from "@/lib/sales-chatbot/postorder-release";
import { parseReleaseArgs } from "@/scripts/sales-postorder-handoff-release";

const ORG = "hau-mai-ai-dung";
const ORG2 = "hau-mai-cach-ly";
const MIN = 60_000;
const POST_ORDER_REASON = `${LEGACY_POST_ORDER_REASON_PREFIX} — nhân viên xử lý (đổi địa chỉ / lịch giao / hỏi thêm)`;

function testPhases() {
  for (const yes of ["Tôi nhận hàng rồi nhưng chưa thử chất lượng", "em đã nhận được hàng rồi nha", "nhan hang roi shop oi", "hàng về rồi nhé", "mình vừa nhận hàng"]) assert.ok(customerReceiptClaim(yes), `«${yes}» là lời khai đã nhận`);
  for (const no of ["khi nào nhận hàng vậy shop", "chưa nhận được hàng", "nhận hàng ở đâu", "bao giờ nhận hàng", "cho chị 2kg"]) assert.ok(!customerReceiptClaim(no), `«${no}» KHÔNG phải lời khai đã nhận`);
  for (const yes of ["gói ruốc bị mốc rồi", "giao thiếu 1 hộp", "mình muốn trả hàng hoàn tiền", "hàng bị hỏng hết", "sai màu rồi shop", "ăn xong bị đau bụng", "hàng không ngon như lần trước", "hàng dở quá", "ruốc bị chảy dầu", "giao chậm quá 5 ngày chưa thấy"]) assert.ok(customerComplaintSignal(yes), `«${yes}» là khiếu nại`);
  for (const yes of ["chưa nhận được hàng mà bên vận chuyển báo giao rồi", "mình không nhận được hàng", "vẫn chưa thấy hàng đâu"]) assert.ok(customerNotReceivedSignal(yes), `«${yes}» là «chưa nhận hàng»`);
  for (const no of ["Tôi nhận hàng rồi nhưng chưa thử chất lượng", "bao giờ nhận được hàng"]) assert.ok(!customerNotReceivedSignal(no), `«${no}» KHÔNG phải «chưa nhận hàng»`);
  for (const no of ["Tôi nhận hàng rồi nhưng chưa thử chất lượng", "ngon lắm shop", "cảm ơn em", "bảo quản thế nào em"]) assert.ok(!customerComplaintSignal(no), `«${no}» KHÔNG phải khiếu nại`);
  // Review #821 vòng 2 — engine ép chuyển người + bot im theo luật này ⇒ câu khen / trung tính / câu hỏi KHÔNG được bắt nhầm (từ mơ hồ khi
  // bỏ dấu chỉ khớp trên chữ CÒN DẤU, phủ định ngay trước cụm, «chậm … cũng được», câu hỏi chỉ tính khi có từ lỗi rõ).
  for (const no of [
    "ngon không chảy dầu",
    "ruốc ngon, không bị chảy dầu như chỗ khác",
    "loại đó thế nào em",
    "cái đó thế nào",
    "ăn thấy đỡ lắm",
    "chị thấy đỡ quá",
    "chấm quá ngon",
    "chăm quá",
    "giao chậm xíu cũng được",
    "ship chậm cũng được em",
    "phòng ngừa thế nào",
    "đỏ quá",
    "con chị ăn không ngon miệng mấy hôm nay",
    "shop có đổi hàng không?",
    "ăn có bị đau bụng không em?",
  ])
    assert.ok(!customerComplaintSignal(no), `«${no}» KHÔNG phải khiếu nại (bắt nhầm ⇒ bot im với khách đang khen)`);
  for (const yes of ["goi ruoc bi moc roi, minh muon tra hang hoan tien", "hàng bị mốc rồi phải làm sao?", "an xong bi dau bung"]) assert.ok(customerComplaintSignal(yes), `«${yes}» là khiếu nại (gõ không dấu / câu hỏi có từ lỗi rõ)`);
  // Vòng 3: khách gõ KHÔNG DẤU — từ dễ lẫn chỉ tính khi có ngữ cảnh; «sao … vậy» là câu trách; «có (bị) … không» là hỏi giả định.
  for (const yes of ["hang do qua", "ruoc do qua", "giao cham qua", "sao giao cham vay em", "te qua", "khong ngon nhu lan truoc", "ruoc chay dau het", "hop bi vo", "co mui la", "an xong dau bung", "sao giao chậm vậy em?"])
    assert.ok(customerComplaintSignal(yes), `«${yes}» là khiếu nại`);
  for (const no of ["loai do the nao em", "cai do the nao", "an thay do lam", "chi thay do qua", "cham qua ngon", "cham qua", "giao cham xiu cung duoc", "ship cham cung duoc em", "phong ngua the nao", "do qua", "con chi an khong ngon mieng may hom nay", "ngon khong chay dau", "có bị chảy dầu không em?", "co bi chay dau khong em"])
    assert.ok(!customerComplaintSignal(no), `«${no}» KHÔNG phải khiếu nại (không dấu / hỏi giả định)`);

  const snap = (o: Partial<Pick<LifecycleSnapshot, "order" | "fulfillment" | "salesStage" | "orderId">>) => ({ order: "CONFIRMED" as const, fulfillment: "NONE" as const, salesStage: "AWAITING_CONFIRMATION" as const, orderId: "erp-6495ca72-x", ...o });
  const none = { receipt: false, complaint: false };
  assert.equal(customerPhaseOf(snap({ order: "NONE", salesStage: "CONSULTING", orderId: null }), none, null).phase, "PRE_SALE");
  assert.equal(customerPhaseOf(snap({ order: "CREATION_PENDING" }), none, 0).phase, "CLOSING");
  assert.equal(customerPhaseOf(snap({}), none, 1).phase, "AWAITING_SHIPMENT", "đơn đã chốt, ERP chưa có vận đơn ⇒ chờ giao");
  assert.equal(customerPhaseOf(snap({ fulfillment: "SHIPPING" }), none, 2).phase, "IN_TRANSIT");
  const claimed = customerPhaseOf(snap({}), { receipt: true, complaint: false }, 1);
  assert.deepEqual([claimed.phase, claimed.receivedBy], ["RECEIVED", "CUSTOMER_CLAIM"], "ca «Khanh Nhung»: lời khách ⇒ đã nhận THEO LỜI KHÁCH");
  assert.match(claimed.source, /fulfillment=NONE/, "lời khách không đổi chiều logistics (AGENTS 0.1)");
  const carrier = customerPhaseOf(snap({ fulfillment: "DELIVERED" }), none, 2);
  // Review #821 F2: ĐVVC báo đã giao mà khách nói chưa nhận ⇒ KHIẾU NẠI (trước: RECEIVED/CARRIER + lời nhắc CẢM ƠN — sai).
  const disputed = customerPhaseOf(snap({ fulfillment: "DELIVERED" }), { receipt: false, complaint: false, notReceived: true }, 2);
  assert.deepEqual([disputed.phase, disputed.receivedBy], ["COMPLAINT", null], "chứng từ ĐVVC ↔ lời khách mâu thuẫn ⇒ khiếu nại");
  assert.doesNotMatch(postSalePrompt(disputed, null), /Cảm ơn khách đã nhận hàng/, "không bao giờ cảm ơn «đã nhận» khi khách nói chưa nhận");
  assert.equal(customerPhaseOf(snap({ fulfillment: "SHIPPING" }), { receipt: false, complaint: false, notReceived: true }, 2).phase, "IN_TRANSIT", "chưa giao mà khách hỏi chưa nhận ⇒ vẫn đang giao (AI tra trạng thái)");
  assert.deepEqual([carrier.phase, carrier.receivedBy], ["RECEIVED", "CARRIER"]);
  assert.equal(customerPhaseOf(snap({ fulfillment: "DELIVERED" }), none, 9).phase, "AFTER_SALES");
  assert.equal(customerPhaseOf(snap({}), { receipt: true, complaint: true }, 1).phase, "COMPLAINT", "khiếu nại thắng lời đã nhận");
  assert.equal(customerPhaseOf(snap({ order: "NONE", orderId: null, salesStage: "LEAD" }), { receipt: false, complaint: true }, null).phase, "PRE_SALE", "chưa có đơn ⇒ không có gì để khiếu nại về đơn");

  assert.equal(postSalePrompt(customerPhaseOf(snap({ order: "NONE", orderId: null, salesStage: "CONSULTING" }), none, null), null), "", "trước bán ⇒ lời nhắc bán hàng thường");
  const p = postSalePrompt(claimed, "6495CA72");
  assert.match(p, /ĐÃ NHẬN HÀNG — khách ĐÃ CÓ ĐƠN #6495CA72/);
  assert.match(p, /KHÔNG hỏi lại SĐT \/ địa chỉ \/ món/);
  assert.match(p, /KHÔNG mời chốt \/ xác nhận lại đơn/);
  assert.match(p, /KHÔNG gọi create_draft_order trừ khi khách nói RÕ muốn mua THÊM/);
  assert.match(p, /KHÔNG nói đơn «đã giao thành công»/, "chỉ có lời khách ⇒ không nói thay ĐVVC");
  assert.match(p, /Cảm ơn khách đã nhận hàng, hỏi thăm/);
  assert.doesNotMatch(postSalePrompt(carrier, "6495CA72"), /lời khách/, "ĐVVC đã giao ⇒ không gắn nhãn lời khách");
  assert.match(postSalePrompt(customerPhaseOf(snap({}), { receipt: false, complaint: true }, 1), null), /handoff_to_human với reason «Khiếu nại/);
  for (const f of ["NONE", "SHIPPING"] as const) assert.match(postSalePrompt(customerPhaseOf(snap({ fulfillment: f }), none, 1), null), /khiếu nại .*handoff_to_human «Khiếu nại/, `chờ giao / đang giao (${f}) cũng dặn chuyển người khi khách than phiền`);
  console.log("  ✓ giai đoạn khách: trước bán · đang chốt · chờ giao · đang giao · đã nhận (ĐVVC / lời khách) · sau bán · khiếu nại — lời khách không đổi logistics; lời dặn hậu mãi không chốt lại / không lên đơn mới");
}

function testAiDownClockPure() {
  const now = new Date();
  const ago = (m: number) => new Date(now.getTime() - m * MIN);
  const st = (m: number) => ({ handoff: { reason: AI_DOWN_HANDOFF_REASON, at: ago(m).toISOString() } });
  // Ca kẹt: AI hỏng 600 phút trước, `updated_at` vừa bị một lượt ghi khác đẩy tới (5 phút trước).
  const stuck = { status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, state: st(600), updatedAt: ago(5), humanCooldownUntil: null };
  assert.equal(aiDownStartedAt(stuck).getTime(), ago(600).getTime(), "mốc hỏng thật");
  const h = aiHoldOf(stuck, now);
  assert.equal(h.state, "AI_ACTIVE", "hết khoảng thử lại theo mốc THẬT — không bị updated_at kéo dài");
  assert.equal(h.expired?.cause, "AI_DOWN");
  assert.equal(aiHoldOf({ ...stuck, state: st(10) }, now).state, "HUMAN_COOLDOWN", "vừa hỏng 10 phút ⇒ còn chờ thử lại");
  assert.equal(aiDownStartedAt({ state: {}, updatedAt: ago(5) }).getTime(), ago(5).getTime(), "dòng cũ không có mốc ⇒ updated_at như cũ");
  assert.equal(aiDownStartedAt({ state: { handoff: { reason: "khác", at: ago(600).toISOString() } }, updatedAt: ago(5) }).getTime(), ago(5).getTime(), "mốc của lý do khác không dùng");
  assert.equal(aiDownStartedAt({ state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: new Date(now.getTime() + MIN).toISOString() } }, updatedAt: ago(5) }).getTime(), ago(5).getTime(), "mốc sau updated_at ⇒ không tin");
  for (const bad of ["2026-02-31T10:00:00.000Z", "2026-04-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-10-12", "hôm qua"]) assert.equal(aiDownStartedAt({ state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: bad } }, updatedAt: ago(5) }).getTime(), ago(5).getTime(), `«${bad}» không phải mốc hợp lệ ⇒ updated_at`);
  const base = { updatedAt: ago(5), humanCooldownUntil: null, lastCustomerAt: ago(3), lastBotAt: ago(700), lastStaffAt: null, staffSeenAt: null, historyUntil: null, pageReplyAfterCustomer: false, orderUnderReview: false };
  assert.equal(classifyInboxState({ ...base, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, state: st(600) }, now, false).needsHuman, null, "hộp thư: AI hỏng đã quá khoảng thử lại ⇒ không còn «AI dừng»");
  assert.equal(classifyInboxState({ ...base, status: "HANDOFF", handoffReason: AI_DOWN_HANDOFF_REASON, state: st(10) }, now, false).needsHuman, "AI_DOWN");
  assert.equal(HUMAN_COOLDOWN_MS, 30 * MIN);
  console.log("  ✓ đồng hồ AI hỏng đọc mốc thật state.handoff.at (dòng cũ / mốc lạ ⇒ updated_at), hộp thư cùng kết luận");
}

function testLabelsAndPanel() {
  assert.equal(INBOX_OUTCOME_LABEL.NOT_SHIPPED, "Chưa có vận đơn", "ERP không có vận đơn ≠ shop chưa gửi");
  assert.ok(!Object.values(INBOX_OUTCOME_LABEL).includes("Chưa gửi"));
  assert.match(orderPanelCallError(new Error('Server Action "abc" was not found on the server.')), /tải lại trang/);
  assert.match(orderPanelCallError(new Error("Failed to fetch")), /kết nối/);
  assert.match(INBOX_ORDER_READ_FAILED, /ghi nhật ký/);
  const panel = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/order-panel.tsx", "utf8");
  assert.ok(!panel.includes("Không đọc được đơn — thử lại."), "panel không còn câu lỗi chung chung");
  const action = readFileSync("lib/actions/inbox-order-panel.ts", "utf8");
  assert.match(action, /catch \(e\) \{\n\s+console\.error\(`\[inbox-order-panel\]/, "lỗi máy chủ ghi nhật ký + trả lỗi đọc được");
  console.log("  ✓ nhãn «Chưa có vận đơn» · panel đơn: lỗi máy chủ ghi nhật ký, lỗi gọi nói đúng cách sửa (tải lại trang / kiểm mạng)");
}

function testSource() {
  const engine = readFileSync("lib/sales-chatbot/engine.ts", "utf8");
  assert.ok(!engine.includes('const reason = "Khách nhắn sau khi đã chốt đơn'), "engine không còn chuyển người MẶC ĐỊNH sau khi chốt đơn");
  assert.match(engine, /postSale \? postSalePrompt\(phase!, phase!\.shortCode\) : ""/, "lời dặn hậu mãi vào lời nhắc hệ thống");
  assert.match(engine, /handoff: \{ reason: AI_DOWN_HANDOFF_REASON, at: now\.toISOString\(\) \}/, "mọi đường AI hỏng ghi mốc thật");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- sales-postorder-handoff-release\s+#/);
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bsales-postorder-handoff-release\b/);
  assert.match(ops, /DOC_NANG="[^"]*\bsales-postorder-handoff-release\b/);
  assert.match(ops, /sales-postorder-handoff-release\)\n[\s\S]*?scripts\/sales-postorder-handoff-release\.ts ;;/);
  assert.deepEqual(parseReleaseArgs(["hslc"]), { ok: true, args: { code: "hslc", all: false, apply: false } }, "mặc định CHẠY THỬ");
  assert.deepEqual(parseReleaseArgs(["--all", "--apply"]), { ok: true, args: { code: null, all: true, apply: true } });
  for (const bad of [[], ["HSLC"], ["a", "--all"], ["a", "--force"]]) assert.ok(!parseReleaseArgs(bad).ok, JSON.stringify(bad));
  const now = new Date();
  assert.equal(releaseVerdict({ state: { control: { mode: "HUMAN" } }, assigneeUserId: null, assigneeActive: false, lastStaffAt: null, since: now }), "TAKEOVER");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: "u", assigneeActive: true, lastStaffAt: null, since: now }), "HELD_BY_PERSON");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: "u", assigneeActive: false, lastStaffAt: null, since: now }), "RELEASE", "người cầm đã khoá ⇒ không ai cầm");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: null, assigneeActive: false, lastStaffAt: new Date(now.getTime() + MIN), since: now }), "STAFF_REPLIED");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: null, assigneeActive: false, lastStaffAt: new Date(now.getTime() - MIN), since: now }), "RELEASE", "câu nhân viên TRƯỚC khi chuyển không tính");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: null, assigneeActive: false, lastStaffAt: null, since: now, waiting: true }), "CUSTOMER_WAITING", "khách đang chờ ⇒ không trả AI (F3)");
  assert.equal(releaseVerdict({ state: {}, assigneeUserId: null, assigneeActive: false, lastStaffAt: null, since: now, requests: ["CANCEL"] }), "CUSTOMER_REQUEST");
  assert.deepEqual(customerRequestKinds(["cho chị đổi địa chỉ sang 5 Hai Bà Trưng", "thôi huỷ đơn giúp chị", "ăn xong bị đau bụng", "chị ck rồi nhé"]), ["EDIT", "COMPLAINT", "CANCEL", "PAYMENT"]);
  assert.deepEqual(customerRequestKinds(["cảm ơn shop", "ok em"]), []);
  console.log("  ✓ mã nguồn: engine bỏ chuyển người mặc định sau chốt · AI hỏng ghi mốc thật · ops khai đủ bốn chỗ · trả-cho-AI mặc định chạy thử");
}

async function dropOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testDb() {
  await dropOrg(ORG);
  await dropOrg(ORG2);
  try {
    for (const code of [ORG, ORG2]) await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: "Chủ shop", password: "HauMai@123456" }, source: "TEST", actor: null });
    // Tổ chức thứ hai: một hội thoại kẹt luật cũ — lượt trả-cho-AI của tổ chức thứ nhất KHÔNG được đụng tới.
    await withOrganization(ORG2, async () => {
      const db = await getDb();
      await db.insert(schema.salesChatConversations).values({ id: "x1", channel: "FANPAGE", status: "HANDOFF", handoffReason: POST_ORDER_REASON, visitorKey: "cl:x1", pageId: "pg-cl", threadId: "x1" });
    });
    await withOrganization(ORG, async () => {
      clearMemo();
      const db = await getDb();
      const c = schema.salesChatConversations;
      const now = new Date();
      const ago = (m: number) => new Date(now.getTime() - m * MIN);
      const conv = (id: string, v: Partial<typeof c.$inferInsert>) => db.insert(c).values({ id, channel: "FANPAGE", status: "HANDOFF", visitorKey: `hm:${id}`, pageId: "pg-hm", threadId: id, lastCustomerAt: ago(3), lastBotAt: ago(700), ...v });
      // d1 AI hỏng 600 phút trước (mốc thật cũ) · d2 AI hỏng 10 phút · s1 nhân viên nhường đã hết · s2 còn hạn · p1 khách báo chuyển khoản ·
      // t1 tiếp quản · o1..o3 luật cũ sau chốt (o1 không ai cầm · o2 có người phụ trách · o3 nhân viên đã trả lời sau khi chuyển).
      await conv("d1", { handoffReason: AI_DOWN_HANDOFF_REASON, state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: ago(600).toISOString() } } });
      await conv("d2", { handoffReason: AI_DOWN_HANDOFF_REASON, state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: ago(10).toISOString() } } });
      await conv("s1", { handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: ago(5) });
      await conv("s2", { handoffReason: FANPAGE_STAFF_REASON, humanCooldownUntil: new Date(now.getTime() + 20 * MIN) });
      await conv("p1", { handoffReason: CLAIM_HANDOFF_REASON.PAYMENT_TEXT, state: { handoff: { reason: CLAIM_HANDOFF_REASON.PAYMENT_TEXT, at: ago(5 * 1440).toISOString() } } });
      // d3 AI hỏng 500 phút trước, còn tin khách bị chốt «AI hỏng» (DEAD) sau câu bot cuối, chưa ai trả lời (review #821 F5).
      await conv("d3", { handoffReason: AI_DOWN_HANDOFF_REASON, state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: ago(500).toISOString() } } });
      await db.insert(schema.salesChatInbound).values({ pageId: "pg-hm", threadId: "d3", messageId: "d3-dead", text: "shop ơi còn hàng không", status: "DEAD", note: DEAD_AI_DOWN_NOTE, createdAt: ago(400) });
      // d4 mốc AI hỏng SAI ngày (31/02) ⇒ cả bản SQL lẫn bản thuần lùi về updated_at (vừa ghi) — câu SQL không được hỏng vì ép kiểu.
      await conv("d4", { handoffReason: AI_DOWN_HANDOFF_REASON, state: { handoff: { reason: AI_DOWN_HANDOFF_REASON, at: "2026-02-31T10:00:00.000Z" } } });
      await conv("t1", { status: "OPEN", handoffReason: TAKEOVER_REASON, state: { control: { mode: "HUMAN" } } });
      const admin = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(admin);
      // o1 không ai cầm, bot đã trả lời sau tin khách cuối · o4 khách đang chờ câu trả lời · o5 khách xin ĐỔI ĐỊA CHỈ sau khi chuyển người.
      await conv("o1", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } }, handoffQueuedAt: ago(1520), lastCustomerAt: ago(2000), lastBotAt: ago(1990) });
      await conv("o4", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } } });
      await conv("o5", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } }, lastCustomerAt: ago(900), lastBotAt: ago(890) });
      await db.insert(schema.salesChatInbound).values({ pageId: "pg-hm", threadId: "o5", messageId: "o5-c", text: "cho chị đổi địa chỉ sang 5 Hai Bà Trưng nhé", status: "SKIPPED", createdAt: ago(900) });
      // o6: CHÍNH tin gây chuyển người («đổi ngày giao») tới TRƯỚC mốc handoff.at một phút — mốc lùi phải giữ nó (review #821 vòng 2).
      await conv("o6", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } }, lastCustomerAt: ago(1521), lastBotAt: ago(1500) });
      await db.insert(schema.salesChatInbound).values({ pageId: "pg-hm", threadId: "o6", messageId: "o6-c", text: "cho chị đổi ngày giao sang thứ 7 nhé", status: "SKIPPED", createdAt: ago(1521) });
      await conv("o2", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } }, assigneeUserId: admin.id });
      await conv("o3", { handoffReason: POST_ORDER_REASON, state: { handoff: { reason: POST_ORDER_REASON, at: ago(1520).toISOString() } }, lastStaffAt: ago(1000) });

      // ═══ Bản SQL của đồng hồ AI hỏng ≡ bản thuần ═══
      const sqlDown = new Set((await db.select({ id: c.id }).from(c).where(needsHumanReasonSql("AI_DOWN", now))).map((r) => r.id));
      assert.deepEqual([...sqlDown].sort(), ["d2", "d4"], `SQL: d2 còn trong khoảng thử lại; d4 mốc sai ngày ⇒ lùi updated_at (vừa ghi); d1 hỏng 600 phút: ${[...sqlDown]}`);
      const rows = await db.select().from(c).where(eq(c.handoffReason, AI_DOWN_HANDOFF_REASON));
      for (const r of rows) assert.equal(aiHoldOf(r, now).state === "HUMAN_COOLDOWN", sqlDown.has(r.id), `${r.id}: thuần ≡ SQL`);

      // ═══ Watchdog + hàng đợi chung ═══
      const sw = await sweepHandoffOwnership(now);
      const st = new Map((await db.select({ id: c.id, status: c.status, reason: c.handoffReason }).from(c)).map((r) => [r.id, r]));
      assert.equal(sw.recovered, 2, `watchdog mở lại đúng d1 + s1: ${JSON.stringify(sw)} ${JSON.stringify([...st.entries()])}`);
      assert.equal(st.get("d1")?.status, "OPEN", "AI hỏng đã quá khoảng thử lại ⇒ AI nhận lại");
      assert.equal(st.get("s1")?.status, "OPEN", "nhân viên nhường đã hết hạn ⇒ AI nhận lại");
      for (const id of ["d2", "d4", "s2", "p1", "o1", "o2", "o3"]) assert.equal(st.get(id)?.status, "HANDOFF", `${id}: watchdog KHÔNG đụng (còn hạn / chuyển người bắt buộc / luật cũ chờ chủ shop duyệt)`);
      assert.deepEqual([st.get("d3")?.status, st.get("d3")?.reason], ["HANDOFF", AI_DOWN_UNANSWERED_REASON], "AI hỏng hết hạn nhưng còn tin khách chưa trả lời ⇒ KHÔNG trả AI, ở lại hàng đợi người");
      const resumed = await db.select({ id: schema.salesConversationEvents.conversationId, actor: schema.salesConversationEvents.actorUserId }).from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.type, "ai.resumed"), eq(schema.salesConversationEvents.reasonCode, "COOLDOWN_EXPIRED")));
      assert.deepEqual(resumed.map((r) => r.id).sort(), ["d1", "s1"], "mọi lần hết nhường (nhân viên · AI hỏng) có vết ai.resumed");
      assert.ok(resumed.every((r) => r.actor === null), "người thao tác NULL = MÁY (luật 34–36)");
      const moved = await db.select({ actor: schema.salesConversationEvents.actorUserId, code: schema.salesConversationEvents.reasonCode }).from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, "d3"), eq(schema.salesConversationEvents.type, "handoff.requested")));
      assert.deepEqual(moved, [{ actor: null, code: "AI_DOWN" }], "đổi sang hàng đợi người vì còn tin chưa trả lời ⇒ một vết của MÁY");
      assert.equal(sw.unowned.unowned, 0, `không hội thoại nào «KHÔNG CHỦ» khi tổ chức có người xem hộp thư: ${JSON.stringify(sw.unowned)}`);
      assert.equal(sw.unowned.responders, 0, "tổ chức mới cấp: phòng phụ trách chưa có thành viên");
      assert.ok(sw.unowned.viewers >= 1 && sw.unowned.shared > 0, "phòng trống, chủ shop xem được hộp thư ⇒ hàng đợi chung");
      assert.equal(sw.noResponderAlerts, 1, "phòng trống + có việc STALE (p1 vỡ hạn > 24 giờ, chưa ai cầm) ⇒ một tin quản trị");
      const again = await sweepHandoffOwnership(new Date(now.getTime() + 5 * MIN));
      assert.equal(again.noResponderAlerts, 0, "quét lại trong ngày ⇒ không báo thêm (luật 26)");
      const n = await db.select({ k: schema.notifications.dedupeKey, title: schema.notifications.title }).from(schema.notifications).where(like(schema.notifications.dedupeKey, "sales-chat:handoff-no-responder:%"));
      assert.equal(n.length, 1);
      assert.match(n[0].title, /hàng đợi chung/, "có người xem hộp thư ⇒ tin nói đúng «hàng đợi chung»");

      // ═══ Lõi trả-cho-AI luật cũ: chạy thử không ghi · --apply chỉ hội thoại không ai cầm · chạy lại không ghi thêm ═══
      const dry = await releaseLegacyPostOrderHandoffs({ apply: false, now });
      assert.deepEqual({ c: dry.candidates, r: dry.released, ...dry.byVerdict }, { c: 6, r: 0, RELEASE: 1, HELD_BY_PERSON: 1, STAFF_REPLIED: 1, TAKEOVER: 0, CUSTOMER_WAITING: 1, CUSTOMER_REQUEST: 2 });
      assert.ok(dry.waiting >= 1 && dry.requests.EDIT === 2, `chạy thử in số khách đang chờ + yêu cầu theo loại: ${JSON.stringify({ w: dry.waiting, r: dry.requests })}`);
      assert.equal((await db.select({ s: c.status }).from(c).where(eq(c.id, "o1")))[0]?.s, "HANDOFF", "chạy thử không ghi");
      const ap = await releaseLegacyPostOrderHandoffs({ apply: true, now });
      assert.equal(ap.released, 1);
      const o1 = (await db.select().from(c).where(eq(c.id, "o1")))[0];
      assert.deepEqual([o1.status, o1.handoffReason, o1.handoffQueuedAt, (o1.state as { handoff?: unknown }).handoff], ["OPEN", null, null, undefined], "o1 về AI, rời hàng đợi");
      for (const id of ["o2", "o3", "o4", "o5", "o6", "p1"]) assert.equal((await db.select({ s: c.status }).from(c).where(eq(c.id, id)))[0]?.s, "HANDOFF", `${id} để nguyên (người cầm / khách đang chờ / khách có yêu cầu / chuyển người bắt buộc)`);
      const ap2 = await releaseLegacyPostOrderHandoffs({ apply: true, now });
      assert.deepEqual([ap2.candidates, ap2.released], [5, 0], "chạy lại không ghi thêm");
      const ev = await db.select({ n: sql<number>`count(*)::int` }).from(schema.salesConversationEvents).where(and(eq(schema.salesConversationEvents.conversationId, "o1"), eq(schema.salesConversationEvents.type, "ai.resumed")));
      assert.equal(ev[0]?.n, 1, "một vết ai.resumed");
    });
    await withOrganization(ORG2, async () => {
      const db = await getDb();
      const [x] = await db.select({ s: schema.salesChatConversations.status }).from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, "x1"));
      assert.equal(x?.s, "HANDOFF", "CÁCH LY: lượt của tổ chức khác không đụng hội thoại ở đây");
    });
    console.log("  ✓ PGlite: SQL ≡ thuần (AI hỏng) · watchdog mở lại AI hỏng / nhường đã hết, KHÔNG đụng chuyển khoản / tiếp quản / luật cũ · phòng trống ⇒ hàng đợi chung + 1 tin quản trị/ngày · AI hỏng còn tin chưa trả lời ⇒ ở lại hàng đợi người · ai.resumed của MÁY · trả-cho-AI: chạy thử 0 ghi, --apply 1/6 (loại khách đang chờ · khách có yêu cầu, kể cả tin gây chuyển người trước mốc), chạy lại 0 · cách ly tổ chức");
  } finally {
    await dropOrg(ORG);
    await dropOrg(ORG2);
  }
}

export async function testPostSaleLifecycle() {
  console.log("Hậu mãi + AI dừng + hàng đợi chung (HOTFIX P0 12/10/2026, ca «Khanh Nhung»):");
  testPhases();
  testAiDownClockPure();
  testLabelsAndPanel();
  testSource();
  await testDb();
}

if (process.argv[1] && /postsale-lifecycle\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testPostSaleLifecycle)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
