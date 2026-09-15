import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { canSend } from "@/lib/ai-workforce/agents/sales/outbound";
import { SAFEST_HARD_LIMITS, type AiSettings } from "@/lib/ai-workforce/config";
import {
  COPILOT_MEANINGFUL_EDIT_RATIO,
  COPILOT_PAGES_KEY,
  COPILOT_REJECT_REASONS,
  COPILOT_TERMINAL_ACTIONS,
  editDistance,
  isMeaningfulEdit,
} from "@/lib/constants/sales-copilot";
import { copilotKpi, copilotPageAllowed, copilotPages, copilotQueue } from "@/lib/queries/sales-copilot";
import { resolvePermissions } from "@/lib/auth/permissions";
import { setSettingJson } from "@/lib/settings";

/**
 * ───────────── NẤC TRỢ LÝ BÁN HÀNG: MÁY SOẠN, NGƯỜI BẤM GỬI ─────────────
 *
 * Câu hỏi mà khối này phải trả lời được, và trả lời bằng phép thử chứ bằng lời:
 *
 *   1. Có tổ hợp nào để MÁY tự gửi không?            → không, và chứng minh bằng cách quét đủ tổ hợp.
 *   2. Một job nền gọi được đường gửi của người không? → không, vì đường ấy đòi một khoá tài khoản
 *                                                       chỉ lấy được từ một phiên đăng nhập.
 *   3. Bấm hai lần có thành hai tin cho khách không?  → không, và chốt nằm ở CSDL.
 *   4. Page ngoài danh sách thí điểm gửi được không?  → không.
 *
 * Câu 2 phải kiểm ở MỨC MÃ NGUỒN: không có phiên đăng nhập trong bộ kiểm thử, nên cách duy nhất để
 * chứng minh "job nền không đi vào được" là chứng minh KHÔNG TỆP NÀO ngoài lớp Server Action truyền
 * một khoá tài khoản vào cổng gửi.
 */

const NEN: AiSettings = {
  enabled: true,
  modelCallsEnabled: false,
  ingestEnabled: true,
  maxRunsPerHour: 600,
  dailyCostCapVnd: 0,
  testConversationIds: [],
  modes: {},
  pricing: {},
  hardLimits: { allowAutoSend: false, allowHumanApprovedSend: true, allowOrderCreate: false },
  pricingVersion: "",
};

/*
  QUÉT ĐĨA, KHÔNG QUÉT CHỈ MỤC GIT.

  Tính chất cần chứng minh ở đây là về mã SẼ CHẠY, và mã sẽ chạy là mã trên đĩa — kể cả tệp vừa
  viết chưa commit. `tests/repo-integrity.test.ts` lo phần "mã đã vào kho không import tệp chưa vào
  kho", nên hai bài không chồng nhau: bài kia giữ tính nhất quán của kho, bài này giữ tính chất an
  toàn của đường gửi.
*/
function tepNguon(goc: string, ra: string[] = []): string[] {
  for (const e of readdirSync(goc, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const duong = `${goc}/${e.name}`;
    if (e.isDirectory()) tepNguon(duong, ra);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) ra.push(duong);
  }
  return ra;
}

function daVaoKho(): string[] {
  return [...tepNguon("lib"), ...tepNguon("app"), ...tepNguon("scripts")];
}

export async function testSalesCopilot(db: Db) {
  // ═════════ 1. MỘT ĐƯỜNG GỬI, VÀ NÓ ĐÒI MỘT KHOÁ TÀI KHOẢN ═════════
  //
  // Quét MÃ ĐÃ VÀO KHO (không đọc đĩa): chỉ lớp Server Action được truyền `approvedByUserId` vào
  // cổng gửi. Một job nền không có phiên đăng nhập nên không có khoá — nhưng nếu một ngày ai đó
  // viết `approvedByUserId: "system"` trong một job, dòng dưới đây đỏ trước khi nó chạy lần nào.
  const tep = daVaoKho();
  const goiCong: string[] = [];
  const duyet: string[] = [];
  for (const f of tep) {
    const noiDung = readFileSync(f, "utf8");
    if (/\bsendSalesMessage\s*\(/.test(noiDung)) goiCong.push(f);
    if (/approvedByUserId\s*:/.test(noiDung)) duyet.push(f);
  }
  assert.deepEqual(goiCong.sort(), ["lib/actions/sales-copilot.ts", "lib/ai-workforce/agents/sales/outbound.ts"], "chỉ lớp Server Action được gọi cổng gửi (ngoài chính cổng)");
  // ĐÚNG MỘT TỆP trong toàn bộ kho mã đặt khoá người duyệt — và tệp ấy là một Server Action, tức
  // là chỉ chạy được từ một lượt bấm mang phiên đăng nhập. Đây là câu trả lời đầy đủ nhất có thể
  // cho "một job nền có gửi thay nhân viên được không".
  assert.deepEqual(duyet.sort(), ["lib/actions/sales-copilot.ts"], "chỉ lớp Server Action được đặt khoá người duyệt");

  // Và chính lớp ấy đòi phiên đăng nhập + quyền TRƯỚC khi chạm tới cổng gửi.
  const mãAction = readFileSync("lib/actions/sales-copilot.ts", "utf8");
  assert.ok(mãAction.startsWith('"use server"'), "phải là Server Action — không có URL nào gọi thẳng vào bằng một khoá API");
  assert.ok(mãAction.indexOf("requireUser()") < mãAction.indexOf("sendSalesMessage("), "phiên đăng nhập phải được đòi TRƯỚC khi gọi cổng gửi");
  assert.match(mãAction, /can\(user, "ai:send"\)/, "quyền gửi phải được kiểm, và là quyền RIÊNG chứ không phải ai:view");
  assert.match(mãAction, /modeAtLeast\(agent\.mode, "COPILOT"\)/, "nấc quyền hạn phải đọc lại từ CSDL");
  assert.match(mãAction, /copilotPageAllowed\(/, "page phải nằm trong danh sách thí điểm");

  // Lớp ĐỌC không được chứa một lệnh ghi nào.
  const mãQuery = readFileSync("lib/queries/sales-copilot.ts", "utf8");
  for (const cam of [".insert(", ".update(", ".delete("]) {
    assert.ok(!mãQuery.includes(cam), `lớp đọc hàng đợi không được chứa ${cam}`);
  }

  // ═════════ 2. QUYỀN GỬI TÁCH KHỎI QUYỀN XEM ═════════
  const cs = resolvePermissions("CS", null);
  assert.ok(cs.includes("ai:send"), "người trực chat (CS) phải bấm gửi được");
  for (const vai of ["VIEWER", "ACCOUNTANT", "WAREHOUSE", "MARKETING"] as const) {
    const q = resolvePermissions(vai, null);
    if (q.includes("ai:send")) assert.fail(`${vai} không được có quyền bấm gửi tin cho khách`);
  }

  // ═════════ 3. DANH SÁCH TRẮNG PAGE — RỖNG NGHĨA LÀ KHÔNG AI GỬI ĐƯỢC ═════════
  await setSettingJson(COPILOT_PAGES_KEY, [] as unknown as Record<string, unknown>);
  assert.deepEqual(await copilotPages(db), [], "chưa khai thì danh sách rỗng");
  assert.equal(await copilotPageAllowed("page-thi-diem", db), false, "rỗng ⇒ KHÔNG page nào gửi được (mặc định hẹp)");

  await db
    .insert(schema.settings)
    .values({ key: COPILOT_PAGES_KEY, value: JSON.stringify(["page-thi-diem"]) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(["page-thi-diem"]) } });
  assert.equal(await copilotPageAllowed("page-thi-diem", db), true);
  assert.equal(await copilotPageAllowed("page-khac", db), false, "page khác KHÔNG được thí điểm lây sang");
  assert.equal(await copilotPageAllowed("", db), false, "page trống không bao giờ hợp lệ");

  // Cấu hình hỏng ⇒ rơi về phía HẸP HƠN, không phải mở toang.
  await db.update(schema.settings).set({ value: "{khong-phai-json" }).where(eq(schema.settings.key, COPILOT_PAGES_KEY));
  assert.deepEqual(await copilotPages(db), [], "cấu hình hỏng ⇒ không page nào gửi được");
  await db.update(schema.settings).set({ value: JSON.stringify(["page-thi-diem"]) }).where(eq(schema.settings.key, COPILOT_PAGES_KEY));

  // ═════════ 4. KHOẢNG CÁCH SỬA — HÀM THUẦN ═════════
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("Dạ 499k", "Dạ 499K"), 1);
  assert.equal(isMeaningfulEdit("Dạ mẫu này 499.000đ chị nhé ạ", "Dạ mẫu này 499.000đ chị nhé ạ."), false, "thêm một dấu chấm KHÔNG phải sửa đáng kể");
  assert.equal(isMeaningfulEdit("Dạ mẫu này 499.000đ chị nhé ạ", "Chị ơi mẫu này bên em 499k, chị lấy màu nào ạ?"), true, "viết lại nửa câu LÀ sửa đáng kể");
  assert.equal(isMeaningfulEdit("", "bất cứ gì"), true, "câu gốc rỗng thì mọi thứ gõ vào đều đáng kể");
  assert.ok(COPILOT_MEANINGFUL_EDIT_RATIO > 0 && COPILOT_MEANINGFUL_EDIT_RATIO < 1);

  // ═════════ 5. SỔ THAO TÁC: BẤM HAI LẦN KHÔNG THÀNH HAI TIN ═════════
  const nguoi = "u-copilot-sale";
  await db
    .insert(schema.users)
    .values({ id: nguoi, email: "sale-copilot@test.local", name: "Chị Hà", passwordHash: "x", role: "CS", active: true })
    .onConflictDoNothing();

  const convId = "conv-copilot-1";
  await db
    .insert(schema.salesConversations)
    .values({ id: convId, pageId: "page-thi-diem", externalId: "ext-copilot-1", pancakeCustomerId: "pc-1", customerName: "Chị Lan", stage: "SIZE_SELECTION", sourceType: "WIN" })
    .onConflictDoNothing();
  const goiY = "s-copilot-1";
  await db
    .insert(schema.salesSuggestions)
    .values({ id: goiY, conversationId: convId, suggestedReply: "Dạ Đầm Q004 giá 499.000 ₫, phí ship 25.000 ₫, tổng 524.000 ₫ ạ.", action: "ANSWER_QUESTION", productionAction: "NO_SEND" })
    .onConflictDoNothing();

  const ghi = (patch: Partial<typeof schema.salesCopilotActions.$inferInsert>) =>
    db.insert(schema.salesCopilotActions).values({
      conversationId: convId,
      suggestionId: goiY,
      pageId: "page-thi-diem",
      action: "SEND",
      suggestedText: "x",
      finalText: "x",
      sendStatus: "SENT",
      actorUserId: nguoi,
      actorName: "Chị Hà",
      ...patch,
    });

  await ghi({});
  await assert.rejects(ghi({}), "bấm Gửi lần thứ hai trên cùng câu gợi ý phải bị CSDL từ chối");
  await assert.rejects(ghi({ action: "EDIT_SEND" }), "gửi rồi thì không sửa-rồi-gửi lại được");
  await assert.rejects(ghi({ action: "REJECT", sendStatus: "NONE" }), "gửi rồi thì không từ chối được nữa");

  // Nhưng SOẠN LẠI và NHẬN VIỆC không phải việc kết thúc — chúng vẫn ghi được.
  await ghi({ action: "REGENERATE", sendStatus: "NONE", suggestionId: null });
  await ghi({ action: "TAKEOVER", sendStatus: "NONE", suggestionId: null });
  assert.deepEqual([...COPILOT_TERMINAL_ACTIONS].sort(), ["EDIT_SEND", "REJECT", "SEND"]);

  // Gửi HỎNG thì phải bấm lại được — mạng đứt không được biến thành một khách vĩnh viễn không được trả lời.
  const goiY2 = "s-copilot-2";
  await db.insert(schema.salesSuggestions).values({ id: goiY2, conversationId: convId, suggestedReply: "câu hai", action: "ANSWER_QUESTION" }).onConflictDoNothing();
  await ghi({ suggestionId: goiY2, sendStatus: "FAILED", sendError: "mạng đứt" });
  await ghi({ suggestionId: goiY2, sendStatus: "SENT" });
  const lanHai = await db.query.salesCopilotActions.findMany({ where: eq(schema.salesCopilotActions.suggestionId, goiY2) });
  assert.equal(lanHai.length, 2, "lượt hỏng không chặn lượt thử lại");

  // Danh sách ĐÓNG chặn ở CSDL, không chỉ ở lược đồ đầu vào.
  await assert.rejects(ghi({ suggestionId: null, action: "KHONG_CO_VIEC_NAY" }), "việc lạ phải bị CSDL từ chối");
  await assert.rejects(ghi({ suggestionId: null, action: "REGENERATE", sendStatus: "DA_GUI_ROI" }), "trạng thái gửi lạ phải bị CSDL từ chối");
  assert.equal(COPILOT_REJECT_REASONS.length, 11, "mười một lý do từ chối — thêm lý do thì phải thêm nhãn");

  // ═════════ 6. HÀNG ĐỢI: CÂU ĐÃ XỬ LÝ BIẾN MẤT, CÂU CŨ BỊ ĐÁNH DẤU ═════════
  const q = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  assert.ok(!q.some((r) => r.suggestionId === goiY), "câu đã gửi không còn nằm trong hàng đợi");

  const convCu = "conv-copilot-cu";
  await db
    .insert(schema.salesConversations)
    .values({ id: convCu, pageId: "page-thi-diem", externalId: "ext-copilot-cu", pancakeCustomerId: "pc-2", customerName: "Chị Mai", stage: "SIZE_SELECTION", sourceType: "WIN" })
    .onConflictDoNothing();
  const lauRoi = new Date(Date.now() - 120 * 60_000);
  await db
    .insert(schema.salesSuggestions)
    .values({ id: "s-copilot-cu", conversationId: convCu, suggestedReply: "câu soạn từ hai tiếng trước", action: "ANSWER_QUESTION", createdAt: lauRoi })
    .onConflictDoNothing();
  const q2 = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  const dongCu = q2.find((r) => r.conversationId === convCu);
  assert.ok(dongCu, "hội thoại chưa ai xử lý phải nằm trong hàng đợi");
  assert.ok(dongCu.stale, "câu soạn hai tiếng trước phải bị đánh dấu là cũ");
  assert.match(dongCu.stale, /phút/);

  // Khách nhắn thêm sau khi máy soạn ⇒ câu ấy trả lời một hội thoại không còn tồn tại.
  await db.insert(schema.salesMessages).values({
    id: "m-copilot-moi",
    conversationId: convCu,
    externalId: "ext-m-moi",
    direction: "IN",
    fromPage: false,
    senderType: "CUSTOMER",
    text: "chị đổi ý, lấy màu đen nhé",
    sentAt: new Date(),
  });
  const q3 = await copilotQueue({ pageIds: ["page-thi-diem"], db });
  assert.match(q3.find((r) => r.conversationId === convCu)!.stale!, /nhắn thêm/, "có tin khách mới hơn thì phải nói rõ là vì thế");

  // Page ngoài danh sách KHÔNG lọt vào hàng đợi.
  assert.deepEqual(await copilotQueue({ pageIds: [], db }), [], "không page nào ⇒ hàng đợi rỗng, không phải 'lấy hết'");

  // ═════════ 7. CHỈ SỐ: MẪU SỐ RỖNG LÀ CHƯA BIẾT, KHÔNG PHẢI 0% ═════════
  const kpi = await copilotKpi(7, db);
  assert.ok(kpi.actuallySent >= 2, "đếm được số tin THẬT SỰ đã ghi là đã gửi");
  assert.equal(kpi.failedSends, 1, "lượt gửi hỏng đếm riêng, không lẫn vào lượt thành công");
  assert.ok(kpi.acceptanceRate !== null, "đã có lượt quyết định thì tính được tỷ lệ dùng được");
  const trong = await copilotKpi(0, db);
  assert.equal(trong.acceptanceRate, null, "chưa lượt nào trong kỳ ⇒ CHƯA BIẾT, không phải 0%");
  assert.equal(trong.meaningfulEditRate, null);
  assert.equal(trong.medianReviewSeconds, null);

  // ═════════ 8. VÀ NẤC AUTO VẪN ĐÓNG ═════════
  //
  // Khối 5 của `sales-agent.test.ts` quét đủ tổ hợp; ở đây chốt lại đúng câu mà chủ shop hỏi:
  // với cấu hình ĐANG CHẠY của giai đoạn thí điểm, có đường nào để máy tự gửi không.
  const base = { conversationExternalId: "ext-copilot-1", text: "Dạ em chào chị", humanTakeover: false };
  for (const mode of ["OFF", "SHADOW", "COPILOT", "AUTO"] as const) {
    assert.equal(canSend({ ...base, mode }, NEN).allowed, false, `cấu hình thí điểm: máy KHÔNG tự gửi được ở nấc ${mode}`);
  }
  assert.equal(canSend({ ...base, mode: "COPILOT", approvedByUserId: nguoi }, NEN).allowed, true, "nhưng nhân viên bấm gửi thì được");
  assert.equal(canSend({ ...base, mode: "COPILOT", approvedByUserId: nguoi }, { ...NEN, hardLimits: SAFEST_HARD_LIMITS }).allowed, false, "và chặn cứng vẫn đè lên tất cả");

  console.log(
    `✓ Nấc trợ lý bán hàng: một đường gửi duy nhất đòi khoá tài khoản (quét ${tep.length} tệp đã vào kho) · quyền gửi tách khỏi quyền xem · danh sách trắng page rỗng ⇒ không ai gửi được · bấm hai lần bị CSDL chặn, gửi hỏng vẫn thử lại được · câu cũ / có tin mới hơn bị đánh dấu · máy KHÔNG tự gửi ở cả 4 nấc`,
  );
}
