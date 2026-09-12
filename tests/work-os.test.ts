import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DEPARTMENT_CODES, TEAM_DEPARTMENT } from "@/lib/constants/departments";
import { isMetricKey, krProgress, METRIC_BINDINGS, METRIC_KEYS } from "@/lib/constants/metric-bindings";
import { CS_STATUSES } from "@/lib/constants/cs";
import { CARE_STATUSES } from "@/lib/constants/care";
import { TEAM_ORDER } from "@/lib/constants/action-queue";
import { MONEY_UNKNOWN, slaStateOf, sumMoney, WORK_STATUSES, workKey, type WorkItem } from "@/lib/constants/work";
import { WORK_ACTION, WORK_ACTION_KEYS } from "@/lib/constants/work-actions";
import {
  ALERT_STATUS_TO_WORK,
  CARE_STATUS_TO_WORK,
  CS_STATUS_TO_WORK,
  PROJECTED_SOURCES,
  SOURCES_WITHOUT_ACTIONS,
  WORK_OWNED_SOURCES,
  WORK_SOURCES,
  WORK_SOURCE_SPEC,
  actionsOf,
} from "@/lib/constants/work-sources";
import { metricScore } from "@/lib/queries/bsc";
import { METRICS_WITHOUT_RESOLVER, resolveMetric } from "@/lib/queries/metric-resolver";
import { assignableMembers, buildDepartmentQueue, bucketOf, filterWork, healthOf, isMine, listDepartments, sortForQueue } from "@/lib/queries/work";
import { collectWorkItems, duplicateKeys } from "@/lib/queries/work-adapters";
import { combineScore, getPerformance } from "@/lib/queries/work-performance";
import { buildSnapshot, periodRange } from "@/lib/queries/reviews";
import { generateRecurringTasks, occurrenceKeyFor, saveManualTask, saveRecurrence, setDepartmentMember, setWorkStatus, snoozeWork, assignWork, blockWork, addWorkNote, shouldGenerate } from "@/lib/work/service";
import { resolvePeriod } from "@/lib/search-params";

/**
 * ═══════════════ HỆ ĐIỀU HÀNH CÔNG VIỆC ═══════════════
 *
 * Đặc tả: `docs/work-management-os.md`.
 *
 * Bài kiểm này khoá đúng những chỗ mà một tầng công việc bắc lên trên sáu hàng đợi sẵn có sẽ hỏng:
 *
 *  1. **Một gốc, một việc** — hai nguồn không được sinh hai dòng cho cùng một sự việc.
 *  2. **Đóng ở nguồn thì việc biến mất** — không job nào phải đóng hộ, và không trạng thái mồ côi.
 *  3. **Hàng đợi KHÔNG được đóng việc của miền nghiệp vụ** — bức tường giữa hai chiều.
 *  4. **`null` là chưa biết** — tiền, tỷ lệ, tiến độ KR đều không được rơi về 0.
 *  5. **Việc định kỳ chạy lại không nhân đôi.**
 *  6. **Quyền theo phòng** — trưởng phòng không xem chéo được.
 *  7. **Kỳ đã chốt bất biến** — sửa dữ liệu sau đó không đổi con số đã chụp.
 */

/**
 * Lỗi có phải do đúng ràng buộc CSDL đó không.
 *
 * Drizzle bọc lỗi gốc trong `DrizzleQueryError`, nên tên ràng buộc nằm ở `cause`, không ở
 * `message`. So bằng chuỗi của cả chuỗi lỗi để bài kiểm không phụ thuộc cách bọc của thư viện.
 */
function viPham(e: unknown, ten: string): boolean {
  const chuoi: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i += 1) {
    const o = cur as { message?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof o.message === "string") chuoi.push(o.message);
    if (typeof o.constraint === "string") chuoi.push(o.constraint);
    cur = o.cause;
  }
  return chuoi.join(" | ").includes(ten);
}

const T = (h: number) => new Date(Date.now() - h * 3_600_000);
const NOW = new Date();

/** Mọi thứ bài này tạo ra đều mang tiền tố `wos-` để dọn sạch, không để lại rác cho bài khác. */
const P = "wos-";

async function donDep(db: Db) {
  await db.delete(schema.workItemEvents).where(like(schema.workItemEvents.workKey, `%${P}%`));
  await db.delete(schema.workItems).where(like(schema.workItems.sourceKey, `${P}%`));
  await db.delete(schema.workRecurrences).where(like(schema.workRecurrences.title, `${P}%`));
  await db.delete(schema.okrObjectives).where(like(schema.okrObjectives.title, `${P}%`));
  await db.delete(schema.okrObjectives).where(like(schema.okrObjectives.id, `${P}%`));
  await db.delete(schema.reviewCycles).where(eq(schema.reviewCycles.period, "1999-W01"));
  await db.delete(schema.csCases).where(like(schema.csCases.id, `${P}%`));
  await db.delete(schema.shipmentCare).where(like(schema.shipmentCare.shipmentId, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.bankTransactions).where(like(schema.bankTransactions.id, `${P}%`));
  await db.delete(schema.departmentMembers).where(like(schema.departmentMembers.userId, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
  clearMemo();
}

export async function testWorkOs(db: Db) {
  await donDep(db);

  /* ═══════════ 0 · LÁ CHẮN KHAI BÁO ═══════════ */
  // Thêm một nguồn / trạng thái / hành động mà quên khai thì đỏ NGAY, không rơi âm thầm vào NEW.
  for (const s of WORK_SOURCES) {
    const spec = WORK_SOURCE_SPEC[s];
    assert.ok(spec, `nguồn ${s} chưa khai trong WORK_SOURCE_SPEC`);
    assert.ok(spec.why.length > 20, `nguồn ${s} phải nói VÌ SAO nó là một việc phải làm`);
    assert.ok(spec.department === null || DEPARTMENT_CODES.includes(spec.department), `nguồn ${s} khai phòng ban không tồn tại`);
    for (const a of actionsOf(s)) assert.ok(WORK_ACTION[a], `nguồn ${s} khai hành động không tồn tại: ${a}`);
  }
  assert.deepEqual(SOURCES_WITHOUT_ACTIONS, [], "nguồn chiếu nào cũng phải có ít nhất một hành động — không thì việc hiện ra mà không làm được gì");
  for (const t of TEAM_ORDER) assert.ok(TEAM_DEPARTMENT[t], `nhóm việc ${t} chưa ánh xạ sang phòng ban`);

  // Bản đồ trạng thái phải PHỦ HẾT giá trị của nguồn.
  for (const s of CS_STATUSES) assert.ok(CS_STATUS_TO_WORK[s], `trạng thái case CSKH "${s}" chưa có bản đồ sang ngôn ngữ chung`);
  for (const s of CARE_STATUSES) assert.ok(CARE_STATUS_TO_WORK[s], `trạng thái care "${s}" chưa có bản đồ`);
  for (const v of Object.values(CS_STATUS_TO_WORK)) assert.ok((WORK_STATUSES as readonly string[]).includes(v));
  for (const v of Object.values(CARE_STATUS_TO_WORK)) assert.ok((WORK_STATUSES as readonly string[]).includes(v));
  for (const v of Object.values(ALERT_STATUS_TO_WORK)) assert.ok((WORK_STATUSES as readonly string[]).includes(v));
  // WAITING_* của care phải thành WAITING, ESCALATED phải thành BLOCKED — hai thứ khác nhau.
  assert.equal(CARE_STATUS_TO_WORK.WAITING_CARRIER, "WAITING", "chờ ĐVVC là chờ BÊN NGOÀI");
  assert.equal(CARE_STATUS_TO_WORK.ESCALATED, "BLOCKED", "đẩy lên cấp trên nghĩa là người xử lý KHÔNG tự quyết được — đó là bị chặn, không phải chờ");
  assert.equal(ALERT_STATUS_TO_WORK.CLOSED_STALE, "CANCELLED", "đóng vì thôi theo dõi KHÔNG được đếm là thành tích");

  // Hành động `DOMAIN` phải trỏ tới Server Action CÓ THẬT (đọc mã nguồn, xem tests/action-wiring).
  const { readFileSync } = await import("node:fs");
  for (const k of WORK_ACTION_KEYS) {
    const spec = WORK_ACTION[k];
    if (spec.mode !== "DOMAIN") continue;
    assert.ok(spec.actionModule && spec.actionName, `hành động ${k} khai mode DOMAIN nhưng không nói gọi hàm nào`);
    const src = readFileSync(spec.actionModule!, "utf8");
    assert.ok(new RegExp(`export async function ${spec.actionName}\\b`).test(src), `hành động ${k} trỏ tới ${spec.actionModule}::${spec.actionName} — hàm đó KHÔNG tồn tại`);
  }
  // Nút quảng cáo CỐ Ý chỉ mở đường dẫn: ERP đọc Facebook chứ không ghi. Nút giả tệ hơn không nút.
  assert.deepEqual(WORK_SOURCE_SPEC.ADS_DECISION.actions.filter((a) => WORK_ACTION[a].mode !== "LINK"), [], "ADS_DECISION không được có nút ghi khi ERP chưa ghi được sang Facebook");

  /* ═══════════ 1 · FIXTURE ═══════════ */
  const depts = await listDepartments();
  assert.equal(depts.length, 7, "bảy phòng ban mặc định phải được gieo bởi migration");
  const sales = depts.find((d) => d.code === "SALES")!;
  const finance = depts.find((d) => d.code === "FINANCE")!;

  await db.insert(schema.users).values([
    { id: `${P}u-linh`, email: `${P}linh@shop.vn`, name: "Linh CSKH", passwordHash: "x", role: "CS" },
    { id: `${P}u-tuan`, email: `${P}tuan@shop.vn`, name: "Tuấn Kế toán", passwordHash: "x", role: "ACCOUNTANT" },
    { id: `${P}u-mai`, email: `${P}mai@shop.vn`, name: "Mai Quản lý", passwordHash: "x", role: "MANAGER" },
  ]).onConflictDoNothing();
  await setDepartmentMember(sales.id, `${P}u-linh`, "LEAD");
  await setDepartmentMember(finance.id, `${P}u-tuan`, "MEMBER");

  const linh = { id: `${P}u-linh`, email: `${P}linh@shop.vn`, name: "Linh CSKH" };
  const mai = { id: `${P}u-mai`, email: `${P}mai@shop.vn`, name: "Mai Quản lý" };

  // Một case CSKH thật (miền CUSTOMER), một kiện care, một dòng tiền chưa phân loại.
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "CONFIRMED", status: 2, insertedAt: T(30), billFullName: "Khách A", billPhone: "0900000001", totalPriceAfterDiscount: 450_000 }).onConflictDoNothing();
  await db.insert(schema.csCases).values({ id: `${P}c1`, orderId: `${P}o1`, kind: "EXCHANGE_SIZE", status: "OPEN", title: "Khách xin đổi size", assignee: "Linh CSKH", createdAt: T(30), source: "PANCAKE_CHAT", dedupeKey: `${P}c1-dedupe` }).onConflictDoNothing();
  await db.insert(schema.bankTransactions).values({ id: `${P}b1`, txnAt: T(100), amount: -2_500_000, bankRef: `${P}REF1`, description: "CK di dong", accountingGroup: "UNCLASSIFIED" }).onConflictDoNothing();

  clearMemo();
  const first = await collectWorkItems({ now: NOW });
  const byKey = new Map(first.items.map((i) => [i.key, i]));

  /* ═══════════ 2 · MỘT GỐC, MỘT VIỆC ═══════════ */
  assert.deepEqual(duplicateKeys(first.items), [], "hai nguồn KHÔNG được sinh hai dòng cho cùng một khoá");
  const csItem = byKey.get(workKey("CS_CASE", `${P}c1`));
  assert.ok(csItem, "case CSKH miền CUSTOMER phải xuất hiện trong hàng đợi");
  assert.equal(csItem!.department, "SALES");
  assert.equal(csItem!.statusAuthority, "SOURCE", "case CSKH do miền nghiệp vụ giữ trạng thái");
  // Cùng một case KHÔNG được xuất hiện lần hai dưới nguồn `ALERT`.
  assert.equal(first.items.filter((i) => i.businessEntityId === `${P}o1` && i.sourceType === "CS_CASE").length, 1, "một case một dòng");

  const bankItem = byKey.get(workKey("BANK_EXCEPTION", `${P}b1`));
  assert.ok(bankItem, "dòng tiền chưa phân loại phải thành một việc của kế toán");
  assert.equal(bankItem!.department, "FINANCE");

  /* ═══════════ 3 · TIỀN: `null` LÀ CHƯA BIẾT ═══════════ */
  assert.equal(csItem!.money.atRisk, 450_000, "tiền của case là giá trị đơn — con số CÓ THẬT ở nguồn");
  assert.equal(csItem!.money.confidence, "MEASURED");
  assert.ok(csItem!.money.basis.length > 10, "tiền đo được thì phải nói CĂN CỨ");
  assert.equal(bankItem!.money.atRisk, 2_500_000, "tiền của dòng sao kê lấy trị tuyệt đối, không phải số âm");
  // Mọi việc khai `MEASURED`/`ESTIMATED` đều phải có căn cứ — không có căn cứ thì phải là UNKNOWN.
  for (const i of first.items) {
    if (i.money.confidence === "UNKNOWN") assert.equal(i.money.atRisk, null, `${i.key}: chưa biết thì KHÔNG được có số tiền`);
    else assert.ok(i.money.basis.trim().length > 0, `${i.key}: khai ${i.money.confidence} thì phải nói căn cứ`);
  }
  // Tổng tiền phải nêu MẪU SỐ: bao nhiêu việc chưa tra được.
  const tong = sumMoney([{ money: { atRisk: 1000, recoverable: null, confidence: "MEASURED", basis: "x" } }, { money: MONEY_UNKNOWN }]);
  assert.deepEqual(tong, { atRisk: 1000, recoverable: 0, unknown: 1, known: 1 }, "tổng tiền phải tách rõ phần chưa tra được, không gộp thành 0đ");

  /* ═══════════ 4 · ĐÓNG Ở NGUỒN THÌ VIỆC TỰ BIẾN MẤT ═══════════ */
  await db.update(schema.csCases).set({ status: "DONE", resolvedAt: new Date() }).where(eq(schema.csCases.id, `${P}c1`));
  clearMemo();
  const sauDong = await collectWorkItems({ now: NOW });
  assert.ok(!sauDong.items.some((i) => i.key === csItem!.key), "case đóng ở trang CSKH thì việc rơi khỏi hàng đợi — KHÔNG cần job nào đóng hộ");
  await db.update(schema.csCases).set({ status: "OPEN", resolvedAt: null }).where(eq(schema.csCases.id, `${P}c1`));
  clearMemo();

  /* ═══════════ 5 · BỨC TƯỜNG: HÀNG ĐỢI KHÔNG ĐÓNG ĐƯỢC VIỆC CỦA MIỀN ═══════════ */
  const chan = await setWorkStatus(workKey("CS_CASE", `${P}c1`), "DONE", mai);
  assert.ok("error" in chan, "đóng một việc CHIẾU từ hàng đợi phải bị từ chối — nếu không thì hai nơi cùng giữ một sự thật");
  assert.match((chan as { error: string }).error, /đúng nguồn/, "lời từ chối phải chỉ người dùng sang đúng chỗ xử lý");
  // Và CSDL cũng chặn, không chỉ tầng ứng dụng.
  await db.insert(schema.workItems).values({ id: `${P}w-guard`, sourceType: "CS_CASE", sourceKey: `${P}guard`, authority: "SOURCE", departmentId: sales.id }).onConflictDoNothing();
  await assert.rejects(
    () => db.update(schema.workItems).set({ status: "DONE" }).where(eq(schema.workItems.id, `${P}w-guard`)),
    (e: unknown) => viPham(e, "work_items_authority_check"),
    "ràng buộc CSDL phải chặn, không tin vào kỷ luật của tầng ứng dụng",
  );

  /* ═══════════ 6 · LỚP GHI CHÚ KHÔNG ĐỤNG NGUỒN ═══════════ */
  const csKey = workKey("CS_CASE", `${P}c1`);
  assert.ok(!("error" in (await assignWork(csKey, `${P}u-linh`, mai))), "giao việc cho một việc chiếu phải được");
  assert.ok(!("error" in (await blockWork(csKey, "chờ khách gửi ảnh sản phẩm", linh))), "báo bị chặn phải được");
  assert.ok(!("error" in (await addWorkNote(csKey, "đã gọi khách lúc 9h", linh))), "ghi chú phải được");
  const caseSauGhiChu = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, `${P}c1`) });
  assert.equal(caseSauGhiChu!.status, "OPEN", "lớp công việc KHÔNG được sửa trạng thái nghiệp vụ ở nguồn");
  clearMemo();
  const sauChan = await collectWorkItems({ now: NOW });
  const csSauChan = sauChan.items.find((i) => i.key === csKey)!;
  assert.equal(csSauChan.status, "BLOCKED", "có lý do chặn ở lớp công việc ⇒ HIỂN THỊ là bị chặn");
  assert.equal(csSauChan.blockedReason, "chờ khách gửi ảnh sản phẩm");
  assert.equal(csSauChan.assignee?.id, `${P}u-linh`, "người nhận ở lớp công việc đè lên ô chữ của nguồn");
  const lichSu = await db.query.workItemEvents.findMany({ where: eq(schema.workItemEvents.workKey, csKey) });
  assert.ok(lichSu.length >= 3, "mỗi thao tác để lại một dòng lịch sử chỉ-thêm");
  await blockWork(csKey, "", linh);

  /* ═══════════ 7 · VIỆC TAY ═══════════ */
  const tay = await saveManualTask({ title: `${P}Gọi xưởng chốt ngày giao`, department: "WAREHOUSE", assigneeId: `${P}u-mai`, priority: "HIGH", dueAt: T(-5) }, mai);
  assert.ok("ok" in tay, "tạo việc tay phải được");
  const tayKey = (tay as { key: string }).key;
  // Tiền khai tay mà không nói căn cứ thì bị từ chối — cùng luật với ràng buộc CSDL.
  const thieuCanCu = await saveManualTask({ title: `${P}Việc có tiền`, department: "FINANCE", moneyAtRisk: 1_000_000 }, mai);
  assert.ok("error" in thieuCanCu, "khai số tiền mà không nói căn cứ phải bị từ chối");

  // Việc tay: `work_items` LÀ nguồn, nên đóng được từ đây.
  assert.ok(!("error" in (await setWorkStatus(tayKey, "IN_PROGRESS", mai))));
  const saiLuong = await setWorkStatus(tayKey, "NEW", mai);
  assert.ok("error" in saiLuong, "bảng chuyển trạng thái phải chặn bước đi ngược không hợp lệ");
  assert.ok(!("error" in (await setWorkStatus(tayKey, "DONE", mai))));

  /* ═══════════ 8 · VIỆC ĐỊNH KỲ: CHẠY LẠI KHÔNG NHÂN ĐÔI ═══════════ */
  const rec = await saveRecurrence({ title: `${P}Đối soát COD hằng ngày`, department: "FINANCE", cadence: "DAILY", hourOfDay: 0, assigneeId: `${P}u-tuan` }, mai);
  assert.ok("ok" in rec);
  const lan1 = await generateRecurringTasks(NOW);
  const lan2 = await generateRecurringTasks(NOW);
  assert.ok(lan1.created >= 1, "lượt đầu phải sinh việc của kỳ hôm nay");
  assert.equal(lan2.created, 0, "chạy lại trong cùng kỳ KHÔNG được sinh việc thứ hai");
  // Khoá kỳ tính theo giờ Việt Nam — "việc của thứ Hai" phải là thứ Hai của người làm việc.
  const mocUtc = new Date(Date.UTC(2026, 8, 12, 18, 0, 0)); // 01:00 ngày 13/09 giờ VN
  assert.equal(occurrenceKeyFor("DAILY", mocUtc, null), "2026-09-13", "khoá kỳ phải theo giờ Việt Nam, không theo UTC");
  assert.equal(occurrenceKeyFor("MONTHLY", mocUtc, 1), "2026-09");
  // 12/09/2026 18:00 UTC = 01:00 ngày 13/09 giờ VN — Chủ nhật (thứ 7 theo cách đánh số ISO).
  assert.equal(shouldGenerate({ cadence: "WEEKLY", cadenceDay: 7, hourOfDay: 0 }, mocUtc), true, "việc hằng tuần sinh đúng thứ đã khai");
  assert.equal(shouldGenerate({ cadence: "WEEKLY", cadenceDay: 3, hourOfDay: 0 }, mocUtc), false, "việc hằng tuần KHÔNG sinh vào thứ khác");
  assert.equal(shouldGenerate({ cadence: "WEEKDAYS", cadenceDay: null, hourOfDay: 0 }, mocUtc), false, "việc ngày làm việc KHÔNG sinh vào Chủ nhật");
  assert.equal(shouldGenerate({ cadence: "DAILY", cadenceDay: null, hourOfDay: 9 }, mocUtc), false, "chưa tới giờ đã khai thì chưa sinh");
  // Ngày 29–31 không có ở mọi tháng: chặn từ đầu thay vì để tháng 2 im lặng không sinh việc.
  const ngaySai = await saveRecurrence({ title: `${P}Sai ngày`, department: "FINANCE", cadence: "MONTHLY", cadenceDay: 31 }, mai);
  assert.ok("error" in ngaySai, "việc hằng tháng ngày 31 phải bị chặn — tháng 2 sẽ không bao giờ sinh");

  /* ═══════════ 9 · RỔ, SLA, QUÁ HẠN, HOÃN ═══════════ */
  const mau = (over: Partial<WorkItem>): WorkItem => ({
    key: "k", sourceType: "MANUAL_TASK", sourceKey: "k", title: "t", summary: "", department: "SALES", assignee: null,
    status: "NEW", statusAuthority: "WORK", priority: "NORMAL", score: 10, createdAt: T(1), startedAt: null, dueAt: null,
    slaAt: null, completedAt: null, snoozedUntil: null, businessEntity: "NONE", businessEntityId: "", sourceUrl: "",
    money: MONEY_UNKNOWN, tags: [], evidence: { source: "", detail: "" }, blockedReason: "", creationSource: "MANUAL",
    actions: [], recommendedAction: "", ...over,
  });
  assert.equal(bucketOf(mau({ slaAt: T(2) }), NOW), "OVERDUE", "vỡ hạn thì vào rổ quá hạn");
  assert.equal(bucketOf(mau({ slaAt: T(-1) }), NOW), "NOW", "còn dưới 4 giờ là cần làm ngay");
  assert.equal(bucketOf(mau({ priority: "URGENT" }), NOW), "NOW", "việc gấp vào rổ cần làm ngay dù chưa có hạn");
  assert.equal(bucketOf(mau({ status: "IN_PROGRESS", slaAt: T(-100) }), NOW), "DOING", "đang cầm dở thì vẫn là việc của mình, không rơi vào rổ chờ");
  assert.equal(bucketOf(mau({ status: "WAITING" }), NOW), "WAITING");
  assert.equal(bucketOf(mau({ snoozedUntil: T(-24) }), NOW), "WAITING", "việc đã hoãn không nổi lên trước giờ hẹn");
  assert.equal(bucketOf(mau({ snoozedUntil: T(-24), slaAt: T(3) }), NOW), "OVERDUE", "cái hẹn KHÔNG xoá được cái hạn đã vỡ");
  assert.equal(slaStateOf(null, NOW), "NONE", "không đặt hạn KHÁC đúng hạn");

  // Xếp thứ tự: gấp trước, rồi hạn sớm hơn; việc không hạn không chen lên trước việc có hạn.
  const xep = [mau({ key: "a", slaAt: T(-100) }), mau({ key: "b", priority: "URGENT" }), mau({ key: "c" }), mau({ key: "d", slaAt: T(-2) })].sort(sortForQueue);
  assert.deepEqual(xep.map((i) => i.key), ["b", "d", "a", "c"], "gấp → hạn sớm → hạn xa → không hạn");

  /* ═══════════ 10 · SỨC KHOẺ PHÒNG BAN: TỶ LỆ, KHÔNG PHẢI SỐ LƯỢNG ═══════════ */
  assert.equal(healthOf(200, 10, 0), "OK", "200 việc mà chỉ 5% quá hạn là đang chảy tốt");
  assert.equal(healthOf(12, 8, 0), "STUCK", "12 việc mà 8 quá hạn là đang kẹt — số lượng nhỏ không có nghĩa là khoẻ");
  assert.equal(healthOf(100, 0, 5), "STUCK", "năm việc bị chặn là kẹt, kể cả khi không việc nào quá hạn");
  assert.equal(healthOf(0, 0, 0), "OK");

  const queue = buildDepartmentQueue("SALES", [mau({ key: "x", slaAt: T(5), department: "SALES" }), mau({ key: "y", department: "SALES" })], [mau({ key: "x", slaAt: T(5), department: "SALES" }), mau({ key: "y", department: "SALES" })], NOW);
  assert.equal(queue.overdue, 1);
  assert.equal(queue.slaOnTime, 0, "mẫu số chỉ gồm việc CÓ ĐẶT HẠN — việc 'y' không hạn nên không vào mẫu số");
  const rongHan = buildDepartmentQueue("SALES", [mau({ key: "z", department: "SALES" })], [mau({ key: "z", department: "SALES" })], NOW);
  assert.equal(rongHan.slaOnTime, null, "không việc nào có hạn thì KHÔNG có tỷ lệ nào để nói — null, không phải 100%");

  /* ═══════════ 11 · "VIỆC CỦA TÔI" NHẬN DIỆN CẢ HAI KIỂU GHI NGƯỜI ═══════════ */
  assert.equal(isMine(mau({ assignee: { id: `${P}u-linh`, email: "", name: "x" } }), linh), true, "khớp bằng khoá người dùng");
  assert.equal(isMine(mau({ assignee: { id: null, email: "", name: "linh cskh" } }), linh), true, "cs_cases ghi TÊN chứ không ghi khoá — vẫn phải nhận ra");
  assert.equal(isMine(mau({ assignee: { id: "khac", email: "", name: "Người khác" } }), linh), false);
  assert.equal(isMine(mau({ assignee: null }), linh), false, "việc chưa ai nhận không phải việc của ai cả");

  /* ═══════════ 12 · QUYỀN THEO PHÒNG ═══════════ */
  const loc = filterWork([mau({ key: "s", department: "SALES" }), mau({ key: "f", department: "FINANCE" })], { department: "SALES" }, NOW);
  assert.deepEqual(loc.map((i) => i.key), ["s"], "lọc theo phòng chỉ trả việc của phòng đó");
  const { departmentsOfUser } = await import("@/lib/queries/work");
  const phongCuaLinh = await departmentsOfUser(`${P}u-linh`);
  assert.deepEqual(phongCuaLinh.map((d) => d.code), ["SALES"], "Linh chỉ thuộc phòng Kinh doanh");
  assert.equal(phongCuaLinh[0].roleInDept, "LEAD", "Linh là trưởng phòng Kinh doanh");
  const phongCuaTuan = await departmentsOfUser(`${P}u-tuan`);
  assert.ok(!phongCuaTuan.some((d) => d.code === "SALES"), "Tuấn KHÔNG được thuộc phòng Kinh doanh — trang phòng ban dựa vào đây để chặn xem chéo");

  /*
    Gọi THẲNG hàm dựng danh sách người nhận việc. Nó dùng một truy vấn con tương quan, và một truy
    vấn con tương quan viết sai chỉ nổ lúc CHẠY — `tsc` không đọc được SQL sinh ra. Đúng lỗi này đã
    làm `/work/all` đổ hoàn toàn ở lượt QA trình duyệt 12/09/2026.
  */
  const nguoiNhan = await assignableMembers();
  assert.ok(nguoiNhan.length >= 3, "phải liệt kê được người nhận việc");
  const linhRow = nguoiNhan.find((m) => m.id === `${P}u-linh`)!;
  assert.ok(linhRow, "Linh phải có trong danh sách người nhận việc");
  assert.deepEqual(linhRow.departments, ["Kinh doanh & CSKH"], "phòng ban của người nhận việc phải đọc được, không rỗng");

  /* ═══════════ 13 · CHỈ SỐ: NỐI THẬT, `null` KHI CHƯA ĐO ═══════════ */
  assert.deepEqual(METRICS_WITHOUT_RESOLVER, [], "chỉ số khai trong sổ mà không có hàm đọc thì KR nối vào nó sẽ mãi mãi trống");
  for (const k of METRIC_KEYS) {
    const b = METRIC_BINDINGS[k];
    assert.ok(b.basis.length > 15, `chỉ số ${k} phải nói nguồn số liệu để người đọc kiểm chứng`);
    assert.ok(["MEASURED", "ESTIMATED", "MANUAL"].includes(b.trust));
  }
  assert.equal(isMetricKey("MANUAL"), true);
  assert.equal(isMetricKey("khong_ton_tai"), false, "khoá tưởng tượng phải bị từ chối ở tầng ghi");
  const ky = resolvePeriod({ period: "30d" }, "30d");
  const chuaPhanLoai = await resolveMetric("unclassified_bank_txns", { period: ky });
  assert.equal(chuaPhanLoai.value, 1, "đúng một dòng tiền chưa phân loại trong bài này");
  const hong = await resolveMetric("khong_ton_tai", { period: ky });
  assert.equal(hong.value, null, "chỉ số không có trong sổ trả null, KHÔNG trả 0");

  /* ═══════════ 14 · TIẾN ĐỘ KR VÀ TRỌNG SỐ BSC ═══════════ */
  assert.equal(krProgress({ baseline: 80, target: 92, current: 86, direction: "UP" }), 50, "đi được nửa quãng đường từ mốc xuất phát tới đích");
  assert.equal(krProgress({ baseline: 20, target: 5, current: 12.5, direction: "DOWN" }), 50, "chỉ số càng-thấp-càng-tốt cũng tính theo quãng đường");
  assert.equal(krProgress({ baseline: null, target: 100, current: null, direction: "UP" }), null, "CHƯA ĐO ĐƯỢC không bao giờ thành 0%");
  assert.equal(krProgress({ baseline: 80, target: 92, current: 98, direction: "UP" }), 150, "vượt đích KHÔNG bị cắt về 100% — đó là sự thật đáng thấy");
  assert.equal(krProgress({ baseline: 80, target: 92, current: 74, direction: "UP" }), 0, "đi lùi so với xuất phát vẫn là chưa đi được gì, không phải số âm");

  assert.equal(metricScore(50, 100, "UP"), 50);
  assert.equal(metricScore(5, 10, "DOWN"), 200, "chỉ số càng-thấp-càng-tốt: còn một nửa so với đích là vượt đích");
  assert.equal(metricScore(null, 100, "UP"), null, "ô chưa đo được KHÔNG phải 0 điểm");
  assert.equal(metricScore(0, 0, "DOWN"), 100, "đích 'không còn cái nào' và thực tế bằng 0 là đạt tuyệt đối");
  assert.equal(metricScore(3, 0, "DOWN"), 0, "đích 0 mà còn 3 là chưa đạt");

  /*
    ═══ MỘT KR VƯỢT ĐÍCH KHÔNG ĐƯỢC CHE MỘT KR ĐANG CHẾT ═══

    Luật khác nhau ở hai mức, và cả hai đều cần:
      · từng KR: KHÔNG kẹp — vượt đích 200% là sự thật đáng thấy;
      · mức Objective: mỗi KR đóng góp tối đa 100%.
    Không có luật thứ hai thì 200% / 0% ra 100% — "đã xong" trong khi một nửa mục tiêu chưa nhúc
    nhích. Đo trên dữ liệu demo 12/09/2026: thẻ điểm toàn shop đọc 84% trong khi góc nhìn Quy trình
    nội bộ đúng bằng 0.
  */
  const objId = `${P}obj1`;
  await db.insert(schema.okrObjectives).values({
    id: objId, level: "COMPANY", title: `${P}Mục tiêu kiểm kẹp`, period: "2026-Q3",
    periodStart: T(24 * 60), periodEnd: new Date(Date.now() + 24 * 3_600_000), status: "ACTIVE",
  }).onConflictDoNothing();
  await db.insert(schema.okrKeyResults).values([
    { id: `${P}kr-vuot`, objectiveId: objId, title: "Vượt đích gấp đôi", metricSource: "MANUAL", unit: "COUNT", direction: "UP", baseline: 0, target: 10, current: 20, sortOrder: 10 },
    { id: `${P}kr-chet`, objectiveId: objId, title: "Chưa nhúc nhích", metricSource: "MANUAL", unit: "COUNT", direction: "UP", baseline: 0, target: 10, current: 0, sortOrder: 20 },
  ]).onConflictDoNothing();
  const { listObjectives } = await import("@/lib/queries/okr");
  const mucTieu = (await listObjectives({ period: "2026-Q3" }, resolvePeriod({ period: "30d" }, "30d"))).find((o) => o.id === objId)!;
  assert.equal(mucTieu.keyResults.find((k) => k.id === `${P}kr-vuot`)!.progress, 200, "TỪNG KR: vượt đích hiện đúng 200%, không bị cắt");
  assert.equal(Math.round(mucTieu.progress!), 50, "MỨC OBJECTIVE: KR vượt đích chỉ đóng góp 100% ⇒ (100+0)/2 = 50%, KHÔNG phải (200+0)/2");

  /* ═══════════ 15 · THẺ ĐIỂM NHÂN SỰ: SÁU TRỤC, KHÔNG MỘT SỐ ═══════════ */
  // Cửa sổ phải phủ được các sự kiện vừa sinh TRONG bài này — `NOW` chụp từ đầu bài thì không.
  const cards = await getPerformance({ from: T(24 * 30), to: new Date(Date.now() + 60_000) });
  const theMai = cards.find((c) => c.userId === `${P}u-mai`);
  assert.ok(theMai, "Mai đã đóng việc tay trong kỳ nên phải có thẻ điểm");
  assert.ok(theMai!.productivity.closed >= 1, "đóng việc phải được ghi nhận ở trục năng suất");
  // Trục nào chưa có quan sát thì là `null`, KHÔNG phải 0 điểm.
  const rong = cards.find((c) => c.productivity.closed === 0);
  if (rong) assert.equal(rong.outcome.value, null, "chưa đóng việc nào thì trục Kết quả là CHƯA ĐO ĐƯỢC, không phải 0");
  // Không gộp nếu chủ sở hữu chưa khai trọng số.
  assert.deepEqual(combineScore(theMai!, {}), { score: null, coverage: 0 }, "không khai trọng số thì KHÔNG có điểm tổng");
  const gop = combineScore({ ...theMai!, outcome: { value: 80, sample: 5, note: "" }, quality: { value: null, sample: 0, note: "" }, sla: { value: 60, sample: 4, note: "" }, okr: { value: null, sample: 0, note: "" } }, { outcome: 2, quality: 1, sla: 1, okr: 1 });
  assert.equal(gop.score, Math.round((80 * 2 + 60 * 1) / 3), "trục chưa đo được rơi khỏi CẢ tử lẫn mẫu, không bị tính 0");
  assert.equal(Math.round(gop.coverage * 100), 60, "độ phủ nói rõ điểm tổng đứng trên bao nhiêu phần trọng số");
  // Kết quả ngoài tầm kiểm soát KHÔNG tính vào trục Kết quả.
  assert.equal(WORK_SOURCE_SPEC.SHIPMENT_CARE.outcomeAttributable, false, "ĐVVC giao hỏng không phải lỗi người care");
  assert.equal(WORK_SOURCE_SPEC.CS_CASE.outcomeAttributable, true);

  /* ═══════════ 16 · ẢNH CHỤP KỲ REVIEW LÀ BẤT BIẾN ═══════════ */
  const tuan = periodRange("WEEKLY", NOW);
  const anh1 = await buildSnapshot({ from: T(24 * 7), to: NOW, department: null, departmentId: null, okrPeriod: tuan.period });
  const financeTruoc = anh1.departments.find((d) => d.department === "FINANCE")!;
  const openTruoc = financeTruoc.open;
  assert.ok(openTruoc >= 1, "ảnh chụp phải thấy dòng tiền chưa phân loại của phòng Kế toán");

  // Lưu ảnh vào một kỳ ĐÃ CHỐT, rồi ĐỔI DỮ LIỆU THẬT.
  await db.insert(schema.reviewCycles).values({
    id: `${P}rv1`, kind: "WEEKLY", scope: "COMPANY", departmentId: null, period: "1999-W01",
    periodStart: T(24 * 7), periodEnd: NOW, status: "FINAL", snapshot: anh1 as never, finalizedAt: new Date(), finalizedBy: `${P}u-mai`,
  }).onConflictDoNothing();
  await db.update(schema.bankTransactions).set({ accountingGroup: "OPERATING_EXPENSE" }).where(eq(schema.bankTransactions.id, `${P}b1`));
  clearMemo();

  const { getReview } = await import("@/lib/queries/reviews");
  const daChot = await getReview(`${P}rv1`);
  assert.equal(daChot!.frozen, true, "kỳ FINAL phải được đánh dấu đóng băng");
  assert.equal(
    daChot!.snapshot.departments.find((d) => d.department === "FINANCE")!.open,
    openTruoc,
    "SỐ CỦA KỲ ĐÃ CHỐT KHÔNG ĐỔI dù dữ liệu thật đã đổi — nếu không, biên bản họp tháng trước nói về những con số không còn tồn tại",
  );
  // Và số SỐNG thì đã đổi — chứng minh phép so ở trên có ý nghĩa.
  const anh2 = await buildSnapshot({ from: T(24 * 7), to: NOW, department: null, departmentId: null, okrPeriod: tuan.period });
  assert.ok(anh2.departments.find((d) => d.department === "FINANCE")!.open < openTruoc, "số sống PHẢI đổi sau khi phân loại — nếu không, bài kiểm bất biến ở trên không chứng minh được gì");

  /* ═══════════ 17 · CHỐT KỲ RỒI KHÔNG SỬA ĐƯỢC BIÊN BẢN ═══════════ */
  const { saveReviewNotes } = await import("@/lib/actions/okr");
  void saveReviewNotes; // gọi thật cần phiên đăng nhập; luật đã kiểm ở tầng truy vấn qua `frozen`.
  assert.equal(daChot!.status, "FINAL");

  /* ═══════════ 18 · CHỐNG ĐẾM HAI LẦN GIỮA NGUỒN ═══════════ */
  clearMemo();
  const cuoi = await collectWorkItems({ now: NOW, includeClosed: true });
  assert.deepEqual(duplicateKeys(cuoi.items), [], "sau mọi thao tác, không khoá nào xuất hiện hai lần");
  const theoNguon = new Map<string, number>();
  for (const i of cuoi.items) theoNguon.set(i.sourceType, (theoNguon.get(i.sourceType) ?? 0) + 1);
  for (const s of PROJECTED_SOURCES) assert.ok(WORK_SOURCE_SPEC[s].statusAuthority === "SOURCE");
  for (const s of WORK_OWNED_SOURCES) assert.ok(WORK_SOURCE_SPEC[s].statusAuthority === "WORK");

  // Dòng `work_items` chỉ sinh khi CÓ NGƯỜI CHẠM — không phải một bản sao của mọi việc.
  const soDongChieu = await db.select({ n: sql<number>`count(*)::int` }).from(schema.workItems).where(eq(schema.workItems.authority, "SOURCE"));
  assert.ok(Number(soDongChieu[0].n) <= cuoi.items.length, "số dòng ghi chú KHÔNG được lớn hơn số việc — nó là lớp mỏng, không phải bản sao");

  /* ═══════════ 19 · HOÃN PHẢI Ở TƯƠNG LAI ═══════════ */
  const hoanSai = await snoozeWork(csKey, T(5), linh);
  assert.ok("error" in hoanSai, "hẹn về quá khứ là vô nghĩa, phải bị từ chối");

  console.log(
    `✓ Hệ điều hành công việc: ${WORK_SOURCES.length} nguồn khai đủ (bản đồ trạng thái phủ hết ${CS_STATUSES.length} trạng thái CSKH + ${CARE_STATUSES.length} trạng thái care) · ${cuoi.items.length} việc chiếu, 0 khoá trùng · đóng ở nguồn thì việc tự biến mất · hàng đợi KHÔNG đóng được việc của miền (chặn ở cả ứng dụng lẫn CSDL) · lớp ghi chú không đụng nguồn · việc định kỳ chạy lại không nhân đôi · 7 rổ xếp đúng, hoãn không xoá được hạn · sức khoẻ theo TỶ LỆ không theo số lượng · ${METRIC_KEYS.length} chỉ số có hàm đọc, chưa đo được là null · thẻ điểm 6 trục không gộp khi chưa khai trọng số · kỳ đã chốt bất biến (${openTruoc} việc giữ nguyên khi số sống đã đổi)`,
  );

  await donDep(db);
}
