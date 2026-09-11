import assert from "node:assert/strict";
import { and, eq, isNull, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { evaluateAlerts } from "@/lib/alerts/rules";
import { clearMemo } from "@/lib/cache";
import { CS_SURFACE_MODE } from "@/lib/constants/cs";
import { getActionQueue } from "@/lib/queries/action-queue";
import { getFunnelHealth } from "@/lib/queries/stage-health";

/**
 * ═══════ CASE CSKH: GOM THÔNG BÁO, KHÔNG GOM VIỆC ═══════
 *
 * Production 11/09/2026: 364 dòng "Case CSKH" trong hàng đợi, 338 "trễ hạn", cùng tiêu đề, cùng
 * hành động. Ba trăm dòng giống nhau không phải ba trăm việc — nó là một khối tồn đọng mà không ai
 * đọc nổi. Luật ở lib/constants/cs.ts:
 *   · sai địa chỉ / sai SĐT (và xác nhận SĐT bot gửi hỏng) — mỗi case một việc;
 *   · còn lại gom theo (loại · người phụ trách) thành MỘT việc: đếm, quá hạn, cũ nhất, tiền đơn;
 *   · case khách-đang-chờ đã quá hạn mà còn trong cửa sổ cứu, hoặc case đã có NGƯỜI nhận mà quá
 *     hạn, vẫn tách riêng;
 *   · hết case thì việc tổng hợp tự đóng (AUTO); bảng điều hành đếm CASE GỐC, không đếm thông báo.
 */
export async function testCsCaseGrouping(db: Db) {
  const gio = (h: number) => new Date(Date.now() - h * 3_600_000);
  await db.insert(schema.orders).values({ id: "csg-order-1", stage: "DELIVERED", cod: 0, prepaid: 0, insertedAt: gio(30), totalPriceAfterDiscount: 450_000 });
  const rows = [
    { id: "csg-1", kind: "WRONG_ADDRESS", title: "Khách báo sai địa chỉ", customerPhone: "0900000001", createdAt: gio(1), assignee: "" },
    { id: "csg-2", kind: "EXCHANGE_COLOR", title: "Khách muốn đổi màu", customerPhone: "0900000002", createdAt: gio(6), assignee: "", orderId: "csg-order-1" },
    { id: "csg-3", kind: "EXCHANGE_COLOR", title: "Khách muốn đổi màu", customerPhone: "0900000003", createdAt: gio(1), assignee: "" },
    { id: "csg-4", kind: "EXCHANGE_COLOR", title: "Khách muốn đổi màu — Lan đang lo", customerPhone: "0900000004", createdAt: gio(6), assignee: "Lan" },
    { id: "csg-5", kind: "DELIVERY_FAILED", title: "Bot đã nhắn", customerPhone: "0900000005", createdAt: gio(6), assignee: "Bot ERP" },
    { id: "csg-6", kind: "ORDER_NOT_CREATED", title: "Khách đủ thông tin", customerPhone: "0900000006", createdAt: gio(6), assignee: "" },
    { id: "csg-7", kind: "ORDER_NOT_CREATED", title: "Khách đủ thông tin · cũ", customerPhone: "0900000007", createdAt: gio(200), assignee: "" },
  ];
  await db.insert(schema.csCases).values(rows.map((r) => ({ ...r, status: "OPEN", source: "MANUAL", dedupeKey: `test:${r.id}` })));

  await evaluateAlerts();
  const open = async (key: string) => db.select().from(schema.notifications).where(and(eq(schema.notifications.dedupeKey, key), isNull(schema.notifications.resolvedAt)));

  // ── Việc riêng: đúng những case cần can thiệp từng đơn ──
  assert.equal((await open("cs-case:csg-1")).length, 1, "sai địa chỉ phải là một việc riêng");
  assert.equal((await open("cs-case:csg-2")).length, 0, "đổi màu chưa ai nhận thì nằm trong nhóm, không phải dòng riêng");
  assert.equal((await open("cs-case:csg-3")).length, 0, "case mới trong hạn nằm trong nhóm");
  assert.equal((await open("cs-case:csg-4")).length, 1, "case đã có NGƯỜI nhận mà quá hạn phải hiện trong hàng đợi của người đó");
  assert.equal((await open("cs-case:csg-5")).length, 0, "việc gán cho bot không phải việc của 'ai đó'");
  assert.equal((await open("cs-case:csg-6")).length, 1, "khách đủ thông tin chờ 6 giờ (quá hạn, còn trong cửa sổ cứu) phải tách riêng");
  assert.equal((await open("cs-case:csg-7")).length, 0, "quá cửa sổ cứu thì ở lại trong tổng hợp, không thành việc riêng");

  // ── Việc tổng hợp: một dòng cho (loại · người phụ trách), nói đủ số ──
  const [nhomTra] = await open("cs-group:EXCHANGE_COLOR:-");
  assert.ok(nhomTra, "phải có một việc tổng hợp cho đổi màu chưa ai nhận (loại không có trong fixture, đếm được chính xác)");
  assert.match(nhomTra.title, /2 case đang mở/, "đếm đúng số case chưa có dòng riêng (csg-2, csg-3)");
  assert.match(nhomTra.body, /1 quá hạn/, "đếm số quá hạn");
  assert.match(nhomTra.body, /450\.000/, "tiền đơn gắn vào case phải hiện ra");
  assert.match(nhomTra.body, /Xem danh sách/);
  assert.equal(nhomTra.href, "/cs?kind=EXCHANGE_COLOR&status=OPEN");
  assert.equal(nhomTra.severity, "warning", "có case quá hạn thì mức cảnh báo");
  assert.equal((await open("cs-group:EXCHANGE_COLOR:Lan")).length, 0, "case của Lan đã tách riêng nên không còn nhóm của Lan");
  const [nhomBot] = await open("cs-group:DELIVERY_FAILED:Bot ERP");
  assert.ok(nhomBot && nhomBot.href.includes("assignee=Bot"), "nhóm theo người phụ trách trỏ đúng bộ lọc");
  const tatCaCsCase = await db.select().from(schema.notifications).where(and(like(schema.notifications.dedupeKey, "cs-case:csg-%"), isNull(schema.notifications.resolvedAt)));
  assert.equal(tatCaCsCase.length, 3, "7 case → 3 dòng riêng + các dòng tổng hợp, không phải 7 dòng");

  // ── Hàng đợi việc: việc tổng hợp có tiền, không có hạn riêng ──
  clearMemo();
  const queue = await getActionQueue({ limit: 500, filter: { type: "CS_BACKLOG" } });
  const viecTra = queue.cases.find((c) => c.id === nhomTra.id);
  assert.ok(viecTra, "việc tổng hợp phải vào hàng đợi");
  assert.equal(viecTra.financialImpact, 450_000, "tiền treo của việc tổng hợp = tổng đơn gắn vào case của nhóm");
  assert.equal(viecTra.sla, null, "việc tổng hợp không có hạn riêng — số quá hạn nằm trong nội dung");
  assert.equal(viecTra.team, "CS");

  // ── Bảng điều hành: đếm CASE GỐC, không đếm thông báo ──
  clearMemo();
  const funnel = await getFunnelHealth();
  const lead = funnel.stages.find((s) => s.key === "LEAD");
  assert.ok(lead, "khâu khách nhắn phải có");
  assert.ok(lead.backlog >= 7, `tồn đọng khâu CSKH phải đếm cả 7 case gốc, đang thấy ${lead.backlog}`);

  // ── Nội dung tổng hợp đổi theo số, khoá không đổi; hết case thì tự đóng ──
  await db.update(schema.csCases).set({ status: "DONE", resolvedAt: new Date() }).where(eq(schema.csCases.id, "csg-3"));
  await evaluateAlerts();
  const [sauDong] = await open("cs-group:EXCHANGE_COLOR:-");
  assert.ok(sauDong && sauDong.id === nhomTra.id, "đóng bớt case thì việc tổng hợp CẬP NHẬT, không đóng rồi tạo mới");
  assert.match(sauDong.title, /1 case đang mở/);
  await db.update(schema.csCases).set({ status: "DONE", resolvedAt: new Date() }).where(eq(schema.csCases.id, "csg-2"));
  await evaluateAlerts();
  assert.equal((await open("cs-group:EXCHANGE_COLOR:-")).length, 0, "hết case thì việc tổng hợp tự đóng");
  const [daDong] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, nhomTra.id));
  assert.equal(daDong.resolution, "AUTO", "tự đóng phải ghi là HỆ THỐNG đóng, không phải người");

  // Mọi loại case đều được khai cách hiện — thêm loại mới mà quên thì lá chắn này đỏ.
  for (const k of Object.keys(CS_SURFACE_MODE)) assert.ok(["EACH", "GROUP"].includes(CS_SURFACE_MODE[k as keyof typeof CS_SURFACE_MODE]));

  console.log("✓ Case CSKH: sai địa chỉ / có người nhận quá hạn / khách chờ trong cửa sổ → việc riêng · còn lại một việc tổng hợp có đếm, quá hạn, tiền, danh sách · bảng điều hành đếm case gốc · hết case tự đóng AUTO");
}
