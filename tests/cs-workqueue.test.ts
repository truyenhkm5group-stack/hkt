import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CS_KINDS, classifyFailedReason } from "@/lib/constants/cs";
import { CS_QUICK_ACTIONS_BY_KIND, CS_QUICK_ACTION, CS_MUTATE_ACTIONS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { CS_KIND_DOMAIN, csDomainOf, humanAssignee, isBotAssignee } from "@/lib/constants/cs-domain";
import { addCsNote, applyCsQuickAction, setCsCaseFields, type CsActor } from "@/lib/cs/workqueue";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { csCasesToSurface, csSummary, listCsCases, openCsGroups } from "@/lib/queries/cs";
import { getFunnelHealth } from "@/lib/queries/stage-health";
import { parseListParams, type SearchParams } from "@/lib/search-params";

/**
 * ═══════════ TAB CSKH CHỈ CHỨA VIỆC CỦA CSKH ═══════════
 *
 * Đặc tả: `lib/constants/cs-domain.ts`. Đo trên production 11/09/2026: 232 case CSKH đang mở, 183
 * trong đó là "giao không thành" do bot sinh từ `shipments.stage` — người CSKH mở tab của mình
 * thấy 183 việc mà không việc nào làm được ở đó, còn mọi con số tồn đọng CSKH thì sai đúng 183 đơn
 * vị.
 *
 * Bài kiểm khoá năm điều:
 *
 *  1. **Miền theo NGUỒN, không theo chữ.** Case sinh từ sự kiện Viettel Post là việc giao vận, kể
 *     cả khi tiêu đề nghe rất "chăm khách" (khách không nghe máy).
 *  2. **Miền theo VÒNG ĐỜI với lỗi thông tin.** Sai SĐT khi chưa có vận đơn là việc CSKH; đúng lỗi
 *     đó khi kiện đang chạy là việc care vận đơn — nơi có nút sửa người nhận.
 *  3. **Một gốc, một việc.** Không được vừa có dòng CSKH vừa có dòng care cho cùng một sự việc.
 *  4. **Đóng rồi không quay lại.** Case giao vận đã xong không được rơi ngược vào hàng đợi CSKH.
 *  5. **Bot là người TẠO, không phải người XỬ LÝ.** Case bot nhắn vẫn là case chưa ai nhận.
 */
export async function testCsWorkqueue(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3_600_000);
  const actor: CsActor = { id: "csq-user", email: "cskh-linh@test", name: "Linh CSKH", source: "API" };
  const paramsOf = (raw: SearchParams = {}) => parseListParams(raw, { defaultSort: "createdAt", filterKeys: ["kind", "status", "assignee", "domain"], defaultPeriod: "all", defaultPageSize: 200 });
  const listIds = async (raw: SearchParams = {}) => (await listCsCases(paramsOf(raw))).rows.map((r) => r.id);

  await db.insert(schema.users).values({ id: "csq-user", email: "cskh-linh@test", name: "Linh CSKH", passwordHash: "x", role: "CS", active: true }).onConflictDoNothing();

  // ───────── Lá chắn khai báo: thêm loại case mới mà quên khai miền / nút thì đỏ ngay ─────────
  for (const k of CS_KINDS) {
    assert.ok(CS_KIND_DOMAIN[k], `loại case ${k} chưa khai miền trong CS_KIND_DOMAIN`);
    assert.ok(Array.isArray(CS_QUICK_ACTIONS_BY_KIND[k]), `loại case ${k} chưa khai bộ hành động nhanh`);
    for (const a of CS_QUICK_ACTIONS_BY_KIND[k] as readonly CsQuickActionKey[]) assert.ok(CS_QUICK_ACTION[a], `loại case ${k} khai hành động không tồn tại: ${a}`);
  }
  assert.ok(!CS_MUTATE_ACTIONS.includes("OPEN_POS"), "nút chỉ mở đường dẫn không được nằm trong tập hành động ghi dữ liệu");

  // ═════════ FIXTURE ═════════
  // (1) Giao không thành — chứng từ ĐVVC, kiện còn chạy.
  await db.insert(schema.orders).values({ id: "csq-o1", stage: "SHIPPED", status: 3, insertedAt: gio(60), billFullName: "Khách Một", billPhone: "0911000001", totalPriceAfterDiscount: 480_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "csq-s1", orderId: "csq-o1", carrier: "Viettel Post", vtpOrderNumber: "CSQ001", stage: "DELIVERY_FAILED", isFinal: false, codAmount: 480_000, vtpStatusDate: gio(6), vtpStatusName: "Phát không thành công", vtpNote: "Khách hẹn phát lại chiều mai" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "csq-s1", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", note: "Khách hẹn phát lại chiều mai", occurredAt: gio(6), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();

  // (2) Khách không nghe máy — cũng do bưu tá ghi, nghe rất "chăm khách" nhưng gốc là chuyến giao.
  await db.insert(schema.orders).values({ id: "csq-o2", stage: "SHIPPED", status: 3, insertedAt: gio(50), billFullName: "Khách Hai", billPhone: "0911000002", totalPriceAfterDiscount: 320_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "csq-s2", orderId: "csq-o2", carrier: "Viettel Post", vtpOrderNumber: "CSQ002", stage: "DELIVERY_FAILED", isFinal: false, codAmount: 320_000, vtpStatusDate: gio(5), vtpStatusName: "Phát không thành công", vtpNote: "Gọi khách không liên lạc được" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "csq-s2", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", note: "Gọi khách không liên lạc được", occurredAt: gio(5), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();

  // (3b) Sai địa chỉ TRONG khi kiện đang chạy.
  await db.insert(schema.orders).values({ id: "csq-o4", stage: "SHIPPED", status: 3, insertedAt: gio(20), billFullName: "Khách Bốn", billPhone: "0911000004", totalPriceAfterDiscount: 260_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "csq-s4", orderId: "csq-o4", carrier: "Viettel Post", vtpOrderNumber: "CSQ004", stage: "IN_TRANSIT", isFinal: false, codAmount: 260_000, vtpStatusDate: gio(3), vtpStatusName: "Đang trung chuyển" }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "csq-s4", source: "VTP_WEBHOOK", status: "300", statusName: "Đang trung chuyển", occurredAt: gio(3), normalizedStage: "IN_TRANSIT", legType: "OUTBOUND" }).onConflictDoNothing();

  // (5) Đổi mẫu trước khi gửi — đơn đã lên nhưng CHƯA có vận đơn.
  await db.insert(schema.orders).values({ id: "csq-o5", stage: "CONFIRMED", status: 1, insertedAt: gio(8), billFullName: "Khách Năm", billPhone: "0911000005", totalPriceAfterDiscount: 390_000 }).onConflictDoNothing();

  // (7) Case giao vận ĐÃ XONG, kiện cũng đã kết thúc.
  await db.insert(schema.orders).values({ id: "csq-o7", stage: "DELIVERED", status: 3, insertedAt: gio(200), billFullName: "Khách Bảy", billPhone: "0911000007", totalPriceAfterDiscount: 210_000 }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "csq-s7", orderId: "csq-o7", carrier: "Viettel Post", vtpOrderNumber: "CSQ007", stage: "DELIVERED", isFinal: true, codAmount: 210_000, vtpStatusDate: gio(100), vtpStatusName: "Giao thành công" }).onConflictDoNothing();

  const cases = [
    { id: "csq-c1", kind: "DELIVERY_FAILED", orderId: "csq-o1", source: "AUTO_FAILED_DELIVERY", title: "✅ Đã nhắn khách · Khách hẹn phát lại · đơn #1", assignee: "Bot ERP", createdBy: "failed-delivery-bot", createdAt: gio(6) },
    { id: "csq-c2", kind: "DELIVERY_FAILED", orderId: "csq-o2", source: "AUTO_FAILED_DELIVERY", title: "⛔ Chưa xử lý · Không liên lạc được · đơn #2", assignee: "", createdBy: "failed-delivery-bot", createdAt: gio(5) },
    { id: "csq-c3", kind: "WRONG_PHONE", orderId: null, source: "PANCAKE_CHAT", title: "Sai số điện thoại · Khách Ba", assignee: "", createdBy: "pancake-chat", createdAt: gio(3) },
    { id: "csq-c4", kind: "ORDER_NOT_CREATED", orderId: null, source: "PANCAKE_CHAT", title: "Đủ thông tin tạo đơn · Khách Bốn", assignee: "", createdBy: "pancake-chat", createdAt: gio(6) },
    { id: "csq-c5", kind: "EXCHANGE_COLOR", orderId: "csq-o5", source: "PANCAKE_NOTE", title: "Đổi màu trước khi gửi · Khách Năm", assignee: "", createdBy: "auto", createdAt: gio(2) },
    { id: "csq-c6", kind: "WRONG_ADDRESS", orderId: "csq-o4", source: "PANCAKE_CHAT", title: "Sai địa chỉ · kiện đang trên đường", assignee: "", createdBy: "pancake-chat", createdAt: gio(3) },
    { id: "csq-c7", kind: "DELIVERY_FAILED", orderId: "csq-o7", source: "AUTO_FAILED_DELIVERY", title: "✅ Đã nhắn khách · đơn #7", assignee: "Bot ERP", createdBy: "failed-delivery-bot", createdAt: gio(100), status: "DONE", resolvedAt: gio(90) },
    { id: "csq-c12", kind: "PHONE_VERIFY", orderId: null, source: "AUTO_PHONE_VERIFY", title: "✅ Đã nhắn khách · SĐT mới · Khách Mười Hai", assignee: "Bot ERP", createdBy: "phone-verify-bot", createdAt: gio(9) },
  ];
  await db.insert(schema.csCases).values(cases.map((c) => ({ ...c, status: c.status ?? "OPEN", customerPhone: `0911${c.id.slice(-6)}`, dedupeKey: `test:${c.id}` })));

  clearMemo();
  const csKh = new Set(await listIds());

  // ───────── 1 · VTP "giao không thành công" → care vận đơn, KHÔNG có trong CSKH ─────────
  assert.ok(!csKh.has("csq-c1"), "case sinh từ sự kiện giao hụt của Viettel Post không được nằm trong hàng đợi CSKH");
  const queue = await getCareQueue();
  const caseIds = new Set(queue.cases.map((c) => c.shipmentId));
  assert.ok(caseIds.has("csq-s1"), "kiện giao hụt phải nằm trong hàng đợi care của trang Vận đơn");
  assert.equal(csDomainOf("DELIVERY_FAILED", false), "LOGISTICS", "giao hụt luôn là việc giao vận, không phụ thuộc kiện còn chạy hay không");

  // ───────── 2 · "Khách không nghe máy" do bưu tá ghi → vẫn là care vận đơn ─────────
  assert.equal(classifyFailedReason(["Gọi khách không liên lạc được"]), "NO_CONTACT", "phân loại lý do phải nhận ra 'không liên lạc được'");
  assert.ok(!csKh.has("csq-c2"), "'khách không nghe máy' phát sinh từ chuyến giao là việc giao vận, không phải việc CSKH");
  const s2 = queue.cases.find((c) => c.shipmentId === "csq-s2");
  assert.ok(s2, "kiện khách không nghe máy phải có trong hàng đợi care");
  assert.equal(s2.reason, "NO_CONTACT", "rổ phải đúng lý do bưu tá ghi");
  assert.equal(s2.reasonClass, "CUSTOMER_ACTION", "cần gọi khách — nhưng là việc của bàn care vận đơn, nơi có nút phát lại");

  // ───────── 3 · Khách CHƯA có vận đơn mà thiếu / sai SĐT → CSKH ─────────
  assert.ok(csKh.has("csq-c3"), "sai SĐT khi chưa có vận đơn là việc CSKH: sửa trước khi gửi hàng");
  assert.equal(csDomainOf("WRONG_PHONE", false), "CUSTOMER");
  assert.ok(!queue.cases.some((c) => c.orderId === null && c.reason === "WRONG_INFO"), "case chưa có vận đơn không thể vào hàng đợi care");

  // ───────── 3b · CÙNG loại lỗi, kiện ĐANG CHẠY → care vận đơn ─────────
  assert.ok(!csKh.has("csq-c6"), "sai địa chỉ khi kiện đang trên đường là việc care vận đơn — nơi sửa được người nhận");
  assert.equal(csDomainOf("WRONG_ADDRESS", true), "LOGISTICS");
  const s4 = queue.cases.find((c) => c.shipmentId === "csq-s4");
  assert.ok(s4, "kiện có case sai địa chỉ đang mở phải vào hàng đợi care");
  assert.equal(s4.reason, "WRONG_INFO", "lý do phải nói đúng việc: cần sửa địa chỉ / SĐT");

  // ───────── 4 · Đủ thông tin, chưa tạo đơn → CSKH ─────────
  assert.ok(csKh.has("csq-c4"), "khâu chốt đơn là việc CSKH");

  // ───────── 5 · Đổi mẫu trước khi gửi → CSKH ─────────
  assert.ok(csKh.has("csq-c5"), "đổi màu / size trước khi gửi là việc bán hàng");

  // ───────── 6 · Một gốc, MỘT việc ─────────
  const surfaced = new Set((await csCasesToSurface()).map((c) => c.id));
  assert.ok(!surfaced.has("csq-c6"), "case sai địa chỉ đã thuộc kiện trong hàng đợi care thì không được đẻ thêm dòng việc CSKH");
  assert.ok(surfaced.has("csq-c3"), "case sai SĐT chưa có vận đơn vẫn phải là một dòng việc CSKH — không ai khác làm hộ");
  const demNhom = async (kind: string) => (await openCsGroups()).filter((g) => g.kind === kind).reduce((a, g) => a + g.count, 0);
  assert.equal(await demNhom("DELIVERY_FAILED"), 0, "không có nhóm tồn đọng CSKH nào cho case giao vận");
  const saiDiaChiTruoc = await demNhom("WRONG_ADDRESS");

  /*
    CHIỀU NGƯỢC LẠI CỦA LUẬT VÒNG ĐỜI.

    Kiện kết thúc ⇒ lỗi thông tin không còn cản bưu tá giao ⇒ care vận đơn hết việc với nó, và nếu
    case vẫn mở thì người phải làm là CSKH (sửa cho lần mua sau, hoặc đóng case). Không có luật này
    thì case rơi vào khoảng trống: bàn nào cũng cho là của bàn kia.
  */
  await db.update(schema.shipments).set({ stage: "DELIVERED", isFinal: true }).where(eq(schema.shipments.id, "csq-s4"));
  clearMemo();
  assert.equal(await demNhom("WRONG_ADDRESS"), saiDiaChiTruoc + 1, "kiện đã kết thúc thì case sai địa chỉ còn mở quay về tồn đọng CSKH — trước đó nó KHÔNG được đếm ở đây");
  assert.ok((await listIds()).includes("csq-c6"), "hết cản giao thì việc thuộc về CSKH, không bị bỏ rơi giữa hai bàn");

  // ───────── 7 · Case giao vận ĐÃ XONG không quay lại CSKH ─────────
  assert.ok(!csKh.has("csq-c7"), "case giao vận đã đóng không được rơi ngược vào hàng đợi CSKH");
  const daDong = await listIds({ status: "DONE" });
  assert.ok(!daDong.includes("csq-c7"), "kể cả khi lọc theo trạng thái Đã xong, case giao vận vẫn thuộc miền giao vận");
  assert.ok((await listIds({ domain: "LOGISTICS", status: "DONE" })).includes("csq-c7"), "case KHÔNG bị xoá: bộ lọc Miền vẫn tra ra nó — chỉ đổi chỗ, không mất dữ liệu");

  // ───────── Hàng đợi mặc định không chứa case đã đóng ─────────
  assert.ok(!csKh.has("csq-c7") && !(await listIds()).includes("csq-c7"), "DONE / CANCELLED không nằm trong hàng đợi mặc định");

  // ───────── 8 · Đổi trạng thái / người phụ trách ngay trên dòng ─────────
  const doi = await setCsCaseFields({ id: "csq-c5", status: "IN_PROGRESS", assignee: "Linh CSKH" }, actor);
  assert.ok("ok" in doi, "đổi trạng thái + người phụ trách phải thành công");
  const sauDoi = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "csq-c5") });
  assert.equal(sauDoi?.status, "IN_PROGRESS");
  assert.equal(sauDoi?.assignee, "Linh CSKH");
  assert.equal(sauDoi?.resolvedAt, null, "chuyển sang Đang xử lý phải xoá mốc đóng");
  const suKien5 = await db.select().from(schema.csCaseEvents).where(eq(schema.csCaseEvents.caseId, "csq-c5"));
  assert.equal(suKien5.length, 2, "đổi hai thứ thì ghi hai dòng lịch sử (trạng thái và người), không gộp thành một");
  assert.ok(suKien5.some((e) => e.action === "STATUS" && e.previousStatus === "OPEN" && e.nextStatus === "IN_PROGRESS"));
  assert.ok(suKien5.some((e) => e.action === "ASSIGN" && e.nextAssignee === "Linh CSKH"));

  // ───────── 9 · Ghi chú nhanh ─────────
  const truocGhiChu = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "csq-c4") });
  const ghiChu = await addCsNote({ id: "csq-c4", note: "Gọi lần 1, khách đang bận, hẹn gọi lại chiều." }, actor);
  assert.ok("ok" in ghiChu && ghiChu.data.by === "Linh CSKH", "ghi chú phải ghi lại AI viết");
  const sauGhiChu = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "csq-c4") });
  assert.equal(sauGhiChu?.resolution, truocGhiChu?.resolution, "ghi chú KHÔNG được đè lên kết luận case — đó là hai thứ khác nhau");
  assert.equal(sauGhiChu?.status, truocGhiChu?.status, "ghi chú không tự đổi trạng thái");
  await addCsNote({ id: "csq-c4", note: "Gọi lần 2, khách xác nhận vẫn lấy hàng." }, actor);
  clearMemo();
  const dongC4 = (await listCsCases(paramsOf())).rows.find((r) => r.id === "csq-c4");
  assert.equal(dongC4?.note?.noteCount, 2, "dòng phải đếm đủ số ghi chú");
  assert.match(dongC4?.note?.lastNote ?? "", /lần 2/, "dòng hiện ghi chú MỚI NHẤT, không phải ghi chú đầu tiên");
  assert.ok("error" in (await addCsNote({ id: "csq-c4", note: "   " }, actor)), "ghi chú trống bị từ chối, không tạo một dòng lịch sử rỗng");

  // ───────── 10 · Hẹn lại ─────────
  const quaKhu = await applyCsQuickAction({ id: "csq-c4", action: "SNOOZE", followUpAt: gio(1) }, actor);
  assert.ok("error" in quaKhu, "hẹn về quá khứ phải bị từ chối — nếu không, mọi case hẹn kiểu đó đều đến hạn ngay");
  const hen = new Date(Date.now() + 2 * 3_600_000);
  const henLai = await applyCsQuickAction({ id: "csq-c4", action: "SNOOZE", followUpAt: hen }, actor);
  assert.ok("ok" in henLai && henLai.data.followUpAt?.getTime() === hen.getTime(), "hẹn lại phải lưu đúng mốc");
  assert.equal("ok" in henLai ? henLai.data.status : "", "IN_PROGRESS", "hẹn lại thì case rời trạng thái Mới — đã có người cầm");
  assert.ok((await db.select().from(schema.csCaseEvents).where(eq(schema.csCaseEvents.caseId, "csq-c4"))).some((e) => e.action === "FOLLOW_UP"), "hẹn lại phải để lại một dòng lịch sử");

  // ───────── 11 · Quyền ─────────
  const actionSrc = readFileSync("lib/actions/cs.ts", "utf8");
  for (const fn of ["csQuickAction", "addCsCaseNote", "updateCsCaseQuick"]) {
    const body = actionSrc.slice(actionSrc.indexOf(`export async function ${fn}`), actionSrc.indexOf(`export async function ${fn}`) + 600);
    assert.match(body, /await authorize\(\)/, `${fn} phải kiểm quyền trước khi ghi`);
  }
  assert.match(actionSrc.slice(actionSrc.indexOf("export async function getCsCaseHistory")), /can\(user, "cs:view"\)/, "đọc lịch sử case cũng phải có quyền xem");

  // ───────── 12 · Bot là người TẠO, không phải người XỬ LÝ ─────────
  assert.ok(isBotAssignee("Bot ERP") && humanAssignee("Bot ERP") === "", "bot không phải người phụ trách");
  clearMemo();
  const dongBot = (await listCsCases(paramsOf())).rows.find((r) => r.id === "csq-c12");
  assert.ok(dongBot, "case bot nhắn vẫn nằm trong hàng đợi CSKH (nó là việc chăm khách, không phải việc giao vận)");
  assert.equal(dongBot.owner, "", "bot nhắn xong KHÔNG có nghĩa là đã có người nhận");
  assert.equal(dongBot.botTouched, true, "vẫn phải nói rõ bot đã nhắn — người xử lý cần biết khách đã nhận tin gì");
  assert.equal(dongBot.createdBy, "phone-verify-bot", "người tạo giữ nguyên, tách hẳn khỏi người phụ trách");
  assert.ok(!(await csCasesToSurface()).some((c) => c.id === "csq-c12"), "việc gán cho bot không được tính là việc của một người cụ thể");

  // ───────── 13 · Số liệu không đếm hai lần ─────────
  clearMemo();
  const truoc = await csSummary();
  const funnelTruoc = await getFunnelHealth();
  const leadTruoc = funnelTruoc.stages.find((s) => s.key === "LEAD")?.backlog ?? 0;
  const careTruoc = (await getCareQueue()).counts.care;

  await db.insert(schema.orders).values({ id: "csq-o13", stage: "SHIPPED", status: 3, insertedAt: gio(12), billFullName: "Khách Mười Ba", billPhone: "0911000013", totalPriceAfterDiscount: 175_000 });
  await db.insert(schema.shipments).values({ id: "csq-s13", orderId: "csq-o13", carrier: "Viettel Post", vtpOrderNumber: "CSQ013", stage: "DELIVERY_FAILED", isFinal: false, codAmount: 175_000, vtpStatusDate: gio(4), vtpStatusName: "Phát không thành công", vtpNote: "Khách từ chối nhận" });
  await db.insert(schema.shipmentEvents).values({ shipmentId: "csq-s13", source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", note: "Khách từ chối nhận", occurredAt: gio(4), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" });
  await db.insert(schema.csCases).values({ id: "csq-c13", kind: "DELIVERY_FAILED", orderId: "csq-o13", source: "AUTO_FAILED_DELIVERY", status: "OPEN", title: "✅ Đã nhắn khách · Khách từ chối nhận · đơn #13", customerPhone: "0911000013", assignee: "Bot ERP", createdBy: "failed-delivery-bot", createdAt: gio(4), dedupeKey: "test:csq-c13" });

  clearMemo();
  const sau = await csSummary();
  assert.equal(sau.open, truoc.open, "một kiện giao hụt mới KHÔNG được làm tăng khối lượng việc của CSKH");
  assert.equal(sau.logistics, truoc.logistics + 1, "nhưng vẫn phải đếm được là đã chuyển sang miền giao vận — không im lặng biến mất");
  const leadSau = (await getFunnelHealth()).stages.find((s) => s.key === "LEAD")?.backlog ?? 0;
  assert.equal(leadSau, leadTruoc, "bảng điều hành: khâu CSKH không được tắc thêm vì một sự việc của khâu giao vận");
  clearMemo();
  const careSau = (await getCareQueue()).counts.care;
  assert.equal(careSau, careTruoc + 1, "đúng một việc mới, và nó nằm ở bàn làm việc xử lý được nó");

  console.log(
    `✓ Hàng đợi CSKH: ${sau.open} việc CSKH · ${sau.logistics} case giao vận đã trả về Vận đơn & care (giao hụt · không liên lạc · sai địa chỉ khi kiện đang chạy) · sai SĐT chưa có vận đơn vẫn ở CSKH · một gốc một việc · case đã đóng không quay lại · bot ≠ người nhận · hành động nhanh có lịch sử (trạng thái · người · ghi chú · hẹn lại)`,
  );
}
