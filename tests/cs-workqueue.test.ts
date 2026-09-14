import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CS_KINDS, classifyFailedReason } from "@/lib/constants/cs";
import { CS_QUICK_ACTIONS_BY_KIND, CS_QUICK_ACTION, CS_MUTATE_ACTIONS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { CS_ASSIGNEE_FACET_BOT, CS_HUMAN_KINDS, CS_KIND_DOMAIN, csDomainOf, humanAssignee, isBotAssignee } from "@/lib/constants/cs-domain";
import { addCsNote, applyCsQuickAction, setCsCaseFields, type CsActor } from "@/lib/cs/workqueue";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { botMessageFailuresByShipment, csCasesToSurface, csFacets, csSummary, listCsCases, openCsGroups } from "@/lib/queries/cs";
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
  // Người / luật từ khoá không sinh được case giao vận — loại đó đến từ chứng từ ĐVVC.
  assert.ok(!CS_HUMAN_KINDS.includes("DELIVERY_FAILED") && CS_HUMAN_KINDS.includes("COMPLAINT"), "CS_HUMAN_KINDS loại đúng miền giao vận");
  const csActionSrc = readFileSync("lib/actions/cs.ts", "utf8");
  assert.match(csActionSrc.slice(csActionSrc.indexOf("const rulesSchema")), /kind: HUMAN_KIND/, "luật từ khoá chỉ được trỏ tới loại của người");
  assert.ok(!/z\.enum\(CS_STATUSES\)/.test(csActionSrc), "người không đặt được trạng thái của máy (AUTO_RESOLVED) — dùng CS_HUMAN_STATUSES");

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
  // Giao việc đi bằng KHOÁ tài khoản; TÊN hiển thị do máy chủ đọc từ `users`, không nhận từ nơi gọi.
  const doi = await setCsCaseFields({ id: "csq-c5", status: "IN_PROGRESS", assigneeUserId: "csq-user" }, actor);
  assert.ok("ok" in doi, "đổi trạng thái + người phụ trách phải thành công");
  const sauDoi = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, "csq-c5") });
  assert.equal(sauDoi?.status, "IN_PROGRESS");
  assert.equal(sauDoi?.assigneeUserId, "csq-user", "người phụ trách phải được nối bằng khoá tài khoản");
  assert.equal(sauDoi?.assignee, "Linh CSKH", "tên hiển thị là ảnh chụp lấy từ `users`, không phải chuỗi nơi gọi gửi lên");

  // Khoá lạ thì TỪ CHỐI — không im lặng ghi một khoá trỏ tới hư không.
  const khoaLa = await setCsCaseFields({ id: "csq-c5", assigneeUserId: "khong-ton-tai" }, actor);
  assert.ok("error" in khoaLa, "giao việc cho một khoá không có trong `users` phải bị từ chối");
  assert.equal(sauDoi?.resolvedAt, null, "chuyển sang Đang xử lý phải xoá mốc đóng");
  const suKien5 = await db.select().from(schema.csCaseEvents).where(eq(schema.csCaseEvents.caseId, "csq-c5"));
  assert.equal(suKien5.length, 2, "đổi hai thứ thì ghi hai dòng lịch sử (trạng thái và người), không gộp thành một");
  assert.ok(suKien5.some((e) => e.action === "STATUS" && e.previousStatus === "OPEN" && e.nextStatus === "IN_PROGRESS"));
  assert.ok(suKien5.some((e) => e.action === "ASSIGN" && e.nextAssignee === "Linh CSKH"));

  // ───────── 8b · Ô lọc "Phụ trách" đi bằng KHOÁ tài khoản, bot và tên gõ tay là hai rổ riêng ─────────
  clearMemo();
  const facets = await csFacets(paramsOf());
  const rieng = facets.assignees.find((a) => a.value === "csq-user");
  assert.ok(rieng && rieng.label === "Linh CSKH" && rieng.count >= 1, "người phụ trách hiện theo khoá tài khoản với tên đọc từ `users`");
  const botBucket = facets.assignees.find((a) => a.value === CS_ASSIGNEE_FACET_BOT);
  assert.ok(botBucket && botBucket.count >= 1, "Bot ERP đứng ở rổ MÁY, không đứng chung hàng với nhân viên");
  assert.ok(!facets.assignees.some((a) => a.value === "Bot ERP" || a.value === "Linh CSKH"), "không còn mục nào là ô chữ trần");
  const theoKhoa = await listIds({ assignee: "csq-user" });
  assert.ok(theoKhoa.includes("csq-c5") && !theoKhoa.includes("csq-c12"), "lọc theo khoá ra đúng case của người đó, không lẫn case bot");

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

  // ───────── 12b · Bot KHÔNG NHẮN ĐƯỢC: kết luận nằm ở dòng ẩn, bàn care phải tra ra được theo kiện ─────────
  const botBoTay = await botMessageFailuresByShipment(["csq-s1", "csq-s2", "csq-s4"]);
  assert.ok(botBoTay.has("csq-s2"), "kiện mà bot không nhắn được (⛔, chưa ai — người lẫn máy — chạm tới khách) phải tra ra được theo shipmentId");
  assert.equal(botBoTay.get("csq-s2")?.caseId, "csq-c2");
  assert.ok(!botBoTay.has("csq-s1"), "kiện bot ĐÃ nhắn được (assignee = Bot ERP) không phải thất bại");
  assert.ok(!botBoTay.has("csq-s4"), "kiện không có case giao hụt thì không có gì để báo");

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

  // Và một dòng bot BÓ TAY (assignee rỗng, ⛔) cũng KHÔNG phải việc của người CSKH: nó là việc của bàn care.
  await db.insert(schema.csCases).values({ id: "csq-c14", kind: "DELIVERY_FAILED", orderId: "csq-o13", source: "AUTO_FAILED_DELIVERY", status: "OPEN", title: "⛔ Chưa xử lý · Khách từ chối nhận · đơn #13", customerPhone: "0911000013", assignee: "", createdBy: "failed-delivery-bot", createdAt: gio(3), dedupeKey: "failed-delivery:csq-s13:2026-09-13" });

  clearMemo();
  const sau = await csSummary();
  assert.equal(sau.open, truoc.open, "một kiện giao hụt mới KHÔNG được làm tăng khối lượng việc của CSKH");
  assert.equal(sau.unassigned, truoc.unassigned, "dòng bot bó tay (assignee rỗng) KHÔNG được đếm thành 'chưa ai nhận' của CSKH — nó thuộc bàn care");
  assert.equal(sau.logistics, truoc.logistics + 2, "cả hai dòng giao vận đều đếm được ở phía giao vận — không im lặng biến mất");
  assert.equal((await botMessageFailuresByShipment(["csq-s13"])).get("csq-s13")?.caseId, "csq-c14", "khoá ghép chính là dedupe_key dạng failed-delivery:<shipmentId>:<ngày>");
  const leadSau = (await getFunnelHealth()).stages.find((s) => s.key === "LEAD")?.backlog ?? 0;
  assert.equal(leadSau, leadTruoc, "bảng điều hành: khâu CSKH không được tắc thêm vì một sự việc của khâu giao vận");
  clearMemo();
  const careSau = (await getCareQueue()).counts.care;
  assert.equal(careSau, careTruoc + 1, "đúng một việc mới, và nó nằm ở bàn làm việc xử lý được nó");

  // ───────── 14 · SAO CHÉP NHANH: CHÉP ĐÚNG GIÁ TRỊ, KHÔNG CHÉP THỨ MÁY TỰ CHỌN ─────────
  //
  // CSKH dán SĐT sang Pancake và mã vận đơn sang trang Viettel Post cả ngày. Hai luật:
  // (a) chuỗi chép được phải là chuỗi TRONG CSDL, không phải chữ đang vẽ trên màn hình;
  // (b) đơn có nhiều lần gửi thì KHÔNG được im lặng đưa ra một mã — mã đã huỷ dán sang ĐVVC là
  //     một cuộc gọi hỏng mà không ai biết vì sao tra không ra.
  await db.insert(schema.orders).values({ id: "csq-o15", stage: "SHIPPED", status: 3, insertedAt: gio(60), billFullName: "Khách Mười Lăm", billPhone: "0911000015", totalPriceAfterDiscount: 320_000 });
  // Lần gửi ĐẦU đã huỷ (bưu tá không lấy được), lần gửi SAU đang chạy. Cố ý cho lần đã huỷ mang
  // `created_at` mới hơn để bài kiểm không thể đạt chỉ nhờ "lấy cái mới nhất".
  await db.insert(schema.shipments).values({ id: "csq-s15a", orderId: "csq-o15", carrier: "Viettel Post", vtpOrderNumber: "PKE15HUY0001", stage: "CANCELLED", isFinal: true, createdAt: gio(10) });
  await db.insert(schema.shipments).values({ id: "csq-s15b", orderId: "csq-o15", carrier: "Viettel Post", vtpOrderNumber: "PKE15DANGDI2", stage: "IN_TRANSIT", isFinal: false, createdAt: gio(40) });
  // Loại `COMPLAINT` (miền CUSTOMER) chứ không phải `WRONG_ADDRESS`: loại kia là `BY_SHIPMENT`
  // nên khi đơn có kiện đang chạy nó chuyển sang bàn care và rơi khỏi hàng đợi CSKH.
  await db.insert(schema.csCases).values({ id: "csq-c15", kind: "COMPLAINT", orderId: "csq-o15", source: "MANUAL", status: "OPEN", title: "Khách phàn nàn đơn đi chậm", customerPhone: "0911000015", assignee: "", createdAt: gio(2), dedupeKey: "test:csq-c15" });

  // Đơn mà MỌI lần gửi đã kết thúc — 304 case như thế trên production 14/09/2026, và màn hình cũ
  // không hiện cho họ một ký tự mã vận đơn nào.
  await db.insert(schema.orders).values({ id: "csq-o16", stage: "SHIPPED", status: 3, insertedAt: gio(200), billFullName: "Khách Mười Sáu", billPhone: "0911000016", totalPriceAfterDiscount: 210_000 });
  await db.insert(schema.shipments).values({ id: "csq-s16", orderId: "csq-o16", carrier: "Viettel Post", vtpOrderNumber: "PKE16DAHOAN", stage: "RETURNED", isFinal: true, createdAt: gio(190) });
  await db.insert(schema.csCases).values({ id: "csq-c16", kind: "RETURN", orderId: "csq-o16", source: "MANUAL", status: "OPEN", title: "Khách hỏi lại đơn đã hoàn", customerPhone: "0911000016", assignee: "", createdAt: gio(1), dedupeKey: "test:csq-c16" });

  // Case KHÔNG có đơn ⇒ không có mã nào để chép, và giao diện không được vẽ nút rỗng.
  await db.insert(schema.csCases).values({ id: "csq-c17", kind: "OTHER", orderId: null, source: "MANUAL", status: "OPEN", title: "Khách hỏi chung", customerPhone: "0911000017", assignee: "", createdAt: gio(1), dedupeKey: "test:csq-c17" });

  const dsChep = (await listCsCases(paramsOf())).rows;
  const c15 = dsChep.find((r) => r.id === "csq-c15");
  const c16 = dsChep.find((r) => r.id === "csq-c16");
  const c17 = dsChep.find((r) => r.id === "csq-c17");
  assert.ok(c15 && c16 && c17, "ba case vừa dựng phải có trong hàng đợi");

  // (1) SĐT chép được là ĐÚNG chuỗi trong CSDL. (2) Số 0 đầu không được mất.
  assert.equal(c15.customerPhone, "0911000015", "chép SĐT phải ra đúng chuỗi đã lưu");
  assert.ok(c15.customerPhone.startsWith("0"), "số 0 đầu không được mất — đây là thứ hỏng khi ai đó ép kiểu số");

  // (3)(5) Nhiều lần gửi: lần ĐANG CHẠY đứng đầu, mã đã huỷ KHÔNG phải mã mặc định, và mã kia
  // vẫn liệt kê được chứ không biến mất.
  assert.equal(c15.shipments.length, 2, "phải thấy ĐỦ hai lần gửi, không được cắt bớt");
  assert.equal(c15.shipments[0]?.tracking, "PKE15DANGDI2", "mã mặc định phải là lần gửi ĐANG CHẠY, không phải lần mới tạo gần nhất");
  assert.equal(c15.shipment?.tracking, "PKE15DANGDI2", "lần gửi đang quyết định giữ nguyên nghĩa cũ (is_final = false)");
  assert.ok(c15.shipments.some((x) => x.tracking === "PKE15HUY0001"), "mã đã huỷ vẫn phải liệt kê được — giấu nó đi là giấu mất bối cảnh");
  assert.equal(c15.shipments.filter((x) => !x.isFinal).length, 1, "chỉ một lần gửi đang chạy");

  // Ổn định: chạy lại phải ra CÙNG thứ tự, nếu không mỗi lần tải trang CSKH thấy một mã khác.
  const c15Lan2 = (await listCsCases(paramsOf())).rows.find((r) => r.id === "csq-c15");
  assert.deepEqual(c15Lan2?.shipments.map((x) => x.tracking), c15.shipments.map((x) => x.tracking), "thứ tự lần gửi phải ổn định giữa hai lượt đọc");

  // Đơn đã kết thúc: vẫn có mã để chép, nhưng KHÔNG được kéo case sang miền vận đơn.
  assert.equal(c16.shipment, null, "không còn lần gửi đang chạy");
  assert.equal(c16.shipments[0]?.tracking, "PKE16DAHOAN", "kiện đã hoàn vẫn phải đưa được mã cho CSKH gọi ĐVVC");
  assert.equal(c16.shipments[0]?.isFinal, true, "và phải nói rõ nó đã kết thúc");
  assert.equal(c16.domain, csDomainOf("RETURN", false), "phân miền KHÔNG được đổi vì nay nhìn thấy cả kiện đã kết thúc");

  // (4) Không có đơn ⇒ không có mã ⇒ giao diện không vẽ nút.
  assert.equal(c17.shipments.length, 0, "case không đơn thì không có mã vận đơn nào");
  assert.equal(c17.shipment, null);

  // ───────── Hợp đồng của chính cái nút, đọc thẳng mã nguồn ─────────
  const nguonNut = readFileSync("components/misc.tsx", "utf8");
  // (6) Bấm nút KHÔNG được kích hoạt dòng — và bàn phím đi qua đúng đường đó.
  assert.match(nguonNut, /e\.stopPropagation\(\)/, "nút chép phải chặn nổi bọt, nếu không bấm nó sẽ mở dòng");
  assert.match(nguonNut, /e\.preventDefault\(\)/, "và chặn hành vi mặc định khi nút nằm trong thẻ liên kết");
  // (7)(8) Báo thành công, và HỎNG THÌ NÓI THẲNG — không im lặng giả vờ đã chép.
  assert.match(nguonNut, /toast\.success/, "chép xong phải có phản hồi");
  assert.match(nguonNut, /toast\.error/, "chép hỏng phải báo lỗi");
  assert.match(nguonNut, /document\.execCommand\("copy"\)/, "phải có đường lui cho ngữ cảnh không bảo mật (navigator.clipboard không tồn tại)");
  // (9) Trợ năng: nhãn nói RÕ chép cái gì, không phải mười nút "Sao chép" giống hệt nhau.
  assert.match(nguonNut, /aria-label=\{ten\}/, "nhãn trợ năng phải lấy từ tên cụ thể của giá trị");
  assert.match(nguonNut, /title=\{ten\}/, "tooltip dùng cùng câu với nhãn trợ năng");
  assert.match(nguonNut, /focus-visible:opacity-100/, "nút mờ mà không có trạng thái focus thì người dùng bàn phím không biết mình đang ở đâu");

  // (10) QUYỀN & CHE SỐ: nút chép KHÔNG được là một đường vòng để lấy dữ liệu màn hình không cho
  // xem. Bất biến giữ điều đó đúng là **chép đúng thứ đang hiện**: cùng một biểu thức được vẽ ra
  // màn hình cũng là biểu thức truyền vào `value`. Kho mã hiện KHÔNG che số ở bàn CSKH
  // (`maskPhone` không được gọi ở đâu), nên nút chép không lộ thêm gì; ngày nào có che thì bài
  // kiểm này đỏ và bắt phải xử lý tử tế thay vì lặng lẽ chép số đầy đủ.
  const nguonBang = readFileSync("app/(dashboard)/cs/cs-table.tsx", "utf8");
  assert.match(nguonBang, /<span className="font-mono text-xs text-muted-foreground">\{r\.customerPhone\}<\/span>\s*\n?\s*\{\/\*[\s\S]*?\*\/\}\s*\n?\s*<CopyButton value=\{r\.customerPhone\}/, "giá trị chép phải là ĐÚNG giá trị đang hiện — không chép nhiều hơn thứ màn hình cho xem");
  assert.ok(!nguonBang.includes("maskPhone"), "bàn CSKH chưa che số; nếu thêm che thì phải xử lý cả nút chép, không để nó thành đường vòng");
  assert.match(nguonBang, /\{r\.customerPhone \?/, "không có SĐT thì không vẽ nút — một nút bấm vào không được gì làm mất tin vào cả hàng nút");

  console.log(
    `✓ Hàng đợi CSKH: ${sau.open} việc CSKH · ${sau.logistics} case giao vận đã trả về Vận đơn & care (giao hụt · không liên lạc · sai địa chỉ khi kiện đang chạy) · sai SĐT chưa có vận đơn vẫn ở CSKH · một gốc một việc · case đã đóng không quay lại · bot ≠ người nhận · hành động nhanh có lịch sử (trạng thái · người · ghi chú · hẹn lại) · sao chép SĐT/mã vận đơn chép đúng giá trị, nhiều lần gửi thì liệt kê chứ không chọn hộ`,
  );
}
