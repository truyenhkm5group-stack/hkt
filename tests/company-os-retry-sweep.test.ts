import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { deliverNotifications, notificationDeliveryHealth, type DeliveryConfig, type NotificationSenders } from "@/lib/alerts/notification-delivery";
import { guardWithinScope, withApprovalExecution } from "@/lib/approvals/execution";
import { APPROVAL_RESERVATION_TIMEOUT_MINUTES, releaseStuckApprovalReservations, STUCK_RESERVATION_ERROR } from "@/lib/approvals/reservation-sweep";
import { approvalExecutedDedupeKey, confirmApprovalExecution, decideApprovalCore, guardSecondApprovalCore, type ApprovalUser, type GuardInput } from "@/lib/approvals/service";
import { APPROVAL_ENFORCE_KEY } from "@/lib/constants/approval";
import { approvalExecutionNote } from "@/lib/approvals/execution-note";
import { listApprovalSectionItems } from "@/lib/queries/approvals";
import { adaptApprovals } from "@/lib/queries/work-adapters";
import {
  maskDeliveryError,
  NOTIFY_BACKOFF_BASE_MINUTES,
  NOTIFY_MAX_ATTEMPTS,
  NOTIFY_RETRY_WINDOW_MINUTES,
  notifyBackoffMinutes,
  notifyTotalBackoffMinutes,
} from "@/lib/constants/notification-retry";

/**
 * ═══════════ COMPANY OS · AGENT N — GỬI LẠI TIN LARK HỎNG · DỌN LỜI DUYỆT KẸT ═══════════
 *
 * Không gọi mạng: hai kênh gửi được TIÊM (bộ gửi giả ghi lại từng lượt). URL webhook trong cấu hình là
 * URL GIẢ (`.invalid`) — và bài kiểm khẳng định nó không bao giờ lọt vào câu lỗi đã lưu.
 * Mốc thời gian đều TƯƠNG ĐỐI so với đồng hồ thật lúc chạy (luật 50, 65): dòng tạo "bây giờ", lượt gửi
 * lại đi tới "bây giờ + N phút" qua tham số `now`.
 *
 * Dữ liệu mang tiền tố `cos-n-`; dòng thông báo xoá cuối mỗi kịch bản để lượt thử lại của kịch bản sau
 * không nhặt nhầm.
 */

const P = "cos-n-";
const PHUT = 60_000;
const URL_GIA = "https://lark.invalid/open-apis/bot/v2/hook/cosn-bi-mat-khong-duoc-lo";
const CFG: DeliveryConfig = { telegramBotToken: "", telegramChatId: "", larkWebhookUrl: URL_GIA, larkSecret: "", larkBillingWebhookUrl: "", larkBillingSecret: "" };

type LuotGui = { title: string; text: string; ok: boolean };

/** Bộ gửi giả: `hong(text)` quyết định lượt nào hỏng. Câu lỗi cố ý mang URL + chuỗi dạng token. */
function boGuiGia(hong: (text: string) => boolean) {
  const luot: LuotGui[] = [];
  const senders: NotificationSenders = {
    telegram: async () => ({ ok: false, error: "không dùng trong bài này" }),
    lark: async (_url, _secret, title, lines) => {
      await new Promise((r) => setTimeout(r, 2));
      const text = lines.map((l) => l.map((p) => p.text).join(" ")).join("\n");
      const ok = !hong(text);
      luot.push({ title, text, ok });
      return ok ? { ok: true } : { ok: false, error: `connect ETIMEDOUT ${URL_GIA} · bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw` };
    },
  };
  return { luot, senders, guiDuoc: (tieuDe: string) => luot.filter((l) => l.ok && l.text.includes(tieuDe)).length, thu: (tieuDe: string) => luot.filter((l) => l.text.includes(tieuDe)).length };
}

async function taoDong(db: Db, ma: string, kind: string): Promise<{ id: string; kind: string }> {
  const id = `${P}${ma}`;
  await db.insert(schema.notifications).values({ id, kind, severity: "warning", title: `Việc ${id}`, body: "kiểm thử N", href: "/alerts", dedupeKey: id });
  return { id, kind };
}

async function dong(db: Db, id: string) {
  const [r] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  return r;
}

async function xoaDong(db: Db) {
  await db.delete(schema.notifications).where(like(schema.notifications.id, `${P}%`));
}

// ─────────────────────────── THUẦN ───────────────────────────

export function testNotificationRetryPure() {
  assert.deepEqual([1, 2, 3, 4].map(notifyBackoffMinutes), [10, 20, 40, 80].map((x) => (x / 10) * NOTIFY_BACKOFF_BASE_MINUTES), "nhịp lùi gấp đôi mỗi lần");
  assert.ok(notifyTotalBackoffMinutes() < NOTIFY_RETRY_WINDOW_MINUTES, "cửa sổ phải phủ trọn mọi lần thử — nếu không, trần số lần là lời nói dối");
  assert.ok(NOTIFY_MAX_ATTEMPTS >= 2, "phải có ít nhất một lần GỬI LẠI");
  const che = maskDeliveryError(`HTTP 500 ${URL_GIA}?x=1 · https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage · bot987654321:ZZHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`);
  assert.ok(!/https?:|lark\.invalid|AAHdq|ZZHdq|bi-mat/.test(che), `câu lỗi phải che URL và token: ${che}`);
  assert.ok(che.startsWith("HTTP 500"), "phần không bí mật của câu lỗi còn nguyên để chẩn đoán");
  assert.ok(maskDeliveryError("x".repeat(5000)).length <= 301, "câu lỗi bị cắt ngắn");
  assert.equal(maskDeliveryError(""), "Gửi hỏng mà không có câu lỗi");
  // Câu nhắc lần thực thi không hoàn tất: có ⇔ execution_error khác rỗng.
  assert.deepEqual([approvalExecutionNote(null), approvalExecutionNote(undefined), approvalExecutionNote("   ")], [null, null, null]);
  assert.equal(approvalExecutionNote("Hết kết nối"), "Lần thực thi trước không hoàn tất: Hết kết nối — kiểm tra việc đã được ghi chưa trước khi làm lại");
  console.log("✓ Company OS · N (thuần): nhịp lùi 10·20·40·80 phút nằm trọn trong cửa sổ 6 giờ · câu lỗi che URL / token, cắt ngắn");
}

// ─────────────────────────── 1. GỬI LẠI TIN CẢNH BÁO ───────────────────────────

export async function testNotificationRetryDb(db: Db) {
  const t0 = new Date();
  const luc = (phut: number) => new Date(t0.getTime() + phut * PHUT);
  await xoaDong(db);
  try {
    // ── (a) hỏng → thử lại → được: gửi ĐÚNG MỘT lần thành công; nhịp lùi được tôn trọng ──
    {
      let hongNua = true;
      const g = boGuiGia(() => hongNua);
      const senders = g.senders;
      const a = await taoDong(db, "a", "COSN_A");
      const r1 = await deliverNotifications(db, CFG, { created: [a], now: luc(0), senders });
      assert.deepEqual([r1.sent, r1.failed, r1.gaveUp], [0, 1, 0], "lần đầu hỏng ⇒ đếm là hỏng, còn lượt sau");
      const sau1 = await dong(db, a.id);
      assert.deepEqual([sau1.notifyAttempts, sau1.notifiedAt], [1, null]);
      assert.ok(sau1.notifyLastError && !/https?:|lark\.invalid|AAHdq|bi-mat/.test(sau1.notifyLastError), `câu lỗi đã lưu phải che URL / token: ${sau1.notifyLastError}`);
      assert.ok(r1.lark.error && !/https?:|lark\.invalid/.test(r1.lark.error), "câu lỗi trả về job cũng đã che");
      hongNua = false;
      await deliverNotifications(db, CFG, { created: [], now: luc(NOTIFY_BACKOFF_BASE_MINUTES - 1), senders });
      assert.equal(g.thu(a.id), 1, "nhịp lùi chưa qua ⇒ không gõ cửa lần hai");
      const r3 = await deliverNotifications(db, CFG, { created: [], now: luc(NOTIFY_BACKOFF_BASE_MINUTES + 1), senders });
      assert.ok(r3.retried >= 1, "nhịp lùi qua ⇒ gửi lại được, đếm là GỬI LẠI");
      const sau3 = await dong(db, a.id);
      assert.deepEqual([sau3.notifyAttempts, sau3.notifyLastError, sau3.notifiedAt?.getTime()], [2, null, luc(NOTIFY_BACKOFF_BASE_MINUTES + 1).getTime()]);
      assert.ok(g.luot.some((l) => l.ok && l.title.includes("gửi lại")), "tin gửi lại nói rõ là gửi lại");
      await deliverNotifications(db, CFG, { created: [a], now: luc(200), senders });
      assert.equal(g.guiDuoc(a.id), 1, "đã gửi là xong — không bao giờ gửi lần hai");
      await xoaDong(db);
    }

    // ── (b) hai lượt chạy chồng: lần đầu lẫn gửi lại, mỗi dòng ĐÚNG MỘT tin ──
    {
      const g = boGuiGia(() => false);
      const b = await taoDong(db, "b", "COSN_B");
      const hai = await Promise.all([0, 1].map(() => deliverNotifications(db, CFG, { created: [b], now: luc(0), senders: g.senders })));
      assert.equal(g.guiDuoc(b.id), 1, "hai lượt cùng nhận dòng vừa tạo ⇒ chỉ một lượt gửi");
      assert.equal(hai.reduce((s, r) => s + r.sent, 0), 1);
      const hong = boGuiGia((t) => t.includes(`${P}c`));
      const c = await taoDong(db, "c", "COSN_C");
      await deliverNotifications(db, CFG, { created: [c], now: luc(0), senders: hong.senders });
      const lai = boGuiGia(() => false);
      await Promise.all([0, 1, 2].map(() => deliverNotifications(db, CFG, { created: [], now: luc(NOTIFY_BACKOFF_BASE_MINUTES + 1), senders: lai.senders })));
      assert.equal(lai.guiDuoc(c.id), 1, "ba lượt gửi lại chồng nhau ⇒ đúng một tin");
      assert.equal((await dong(db, c.id)).notifyAttempts, 2, "chỉ một lượt nhận được dòng — số lần thử tăng đúng một");
      await xoaDong(db);
    }

    // ── (c) tới trần ⇒ bỏ cuộc, ĐẾM được và HIỆN được; lượt sau không gõ nữa ──
    {
      const g = boGuiGia(() => true);
      const d = await taoDong(db, "d", "COSN_D");
      let moc = 0;
      let lanCuoi = 0;
      let boCuoc = 0;
      for (let k = 1; k <= NOTIFY_MAX_ATTEMPTS; k++) {
        const r = await deliverNotifications(db, CFG, { created: k === 1 ? [d] : [], now: luc(moc), senders: g.senders });
        lanCuoi = moc;
        boCuoc += r.gaveUp;
        if (k < NOTIFY_MAX_ATTEMPTS) assert.equal(r.gaveUp, 0, `lần ${k} chưa phải lần cuối`);
        moc += notifyBackoffMinutes(k) + 1;
      }
      assert.equal(boCuoc, 1, "đúng lần thử cuối ⇒ bỏ cuộc");
      assert.equal(g.thu(d.id), NOTIFY_MAX_ATTEMPTS, "đúng trần số lần gõ cửa");
      // Lượt kiểm: nhịp lùi SAU lần cuối đã qua, vẫn trong cửa sổ ⇒ chỉ còn TRẦN giữ dòng lại.
      const kiem = lanCuoi + notifyBackoffMinutes(NOTIFY_MAX_ATTEMPTS) + 1;
      assert.ok(kiem < NOTIFY_RETRY_WINDOW_MINUTES, "tiền đề: mọi lần thử và lượt kiểm sau đó nằm trong cửa sổ");
      await deliverNotifications(db, CFG, { created: [], now: luc(kiem), senders: g.senders });
      assert.equal(g.thu(d.id), NOTIFY_MAX_ATTEMPTS, "đã bỏ cuộc ⇒ không gõ nữa");
      const sau = await dong(db, d.id);
      assert.deepEqual([sau.notifyAttempts, sau.notifiedAt, sau.resolvedAt], [NOTIFY_MAX_ATTEMPTS, null, null], "dòng vẫn MỞ trên /alerts, chỉ thôi gửi");
      const suc = await notificationDeliveryHealth(db, luc(kiem));
      assert.ok(suc.gaveUp >= 1, "trang Cần xử lý thấy dòng bỏ cuộc");
      assert.ok(suc.lastError && !/https?:|lark\.invalid|bi-mat/.test(suc.lastError), "câu lỗi hiện trên trang đã che");
      await xoaDong(db);
    }

    // ── (d) đã đóng ⇒ không gửi lại; (e) quá cửa sổ ⇒ không gửi lại; chưa từng thử ⇒ không "gửi lại" ──
    {
      const hong = boGuiGia(() => true);
      const e = await taoDong(db, "e", "COSN_E");
      const f = await taoDong(db, "f", "COSN_F");
      const cu = await taoDong(db, "g", "COSN_G"); // dòng "trước 0145": chưa từng thử
      await deliverNotifications(db, CFG, { created: [e, f], now: luc(0), senders: hong.senders });
      await db.update(schema.notifications).set({ resolvedAt: luc(1), resolution: "AUTO" }).where(eq(schema.notifications.id, e.id));
      const g = boGuiGia(() => false);
      await deliverNotifications(db, CFG, { created: [], now: luc(NOTIFY_RETRY_WINDOW_MINUTES + 1), senders: g.senders });
      assert.equal(g.thu(f.id), 0, "quá cửa sổ ⇒ không gửi lại (dòng vẫn nằm trên /alerts)");
      await deliverNotifications(db, CFG, { created: [], now: luc(NOTIFY_BACKOFF_BASE_MINUTES + 1), senders: g.senders });
      assert.equal(g.thu(e.id), 0, "đã đóng ⇒ không gửi lại");
      assert.equal(g.thu(cu.id), 0, "chưa từng thử ⇒ không bao giờ bị 'gửi lại' — đó là gửi mới lén");
      assert.equal(g.guiDuoc(f.id), 1, "đối chứng: cùng lượt ấy, dòng hỏng còn trong cửa sổ thì gửi lại được");
      assert.equal((await dong(db, cu.id)).notifyAttempts, null);
      // Không kênh nào ⇒ không nhận dòng, không đốt lượt thử.
      const h = await taoDong(db, "h", "COSN_H");
      const r = await deliverNotifications(db, { ...CFG, larkWebhookUrl: "" }, { created: [h], now: luc(0), senders: g.senders });
      assert.deepEqual([r.sent, r.failed, (await dong(db, h.id)).notifyAttempts], [0, 0, null], "chưa cấu hình kênh ⇒ không đốt lượt thử");
      await xoaDong(db);
    }

    // ── Mã nguồn: gửi trong job `alerts` có sẵn, không lịch mới, không in bí mật ──
    const goc = path.resolve(__dirname, "..");
    const rules = readFileSync(path.join(goc, "lib/alerts/rules.ts"), "utf8");
    assert.ok(rules.includes("deliverNotifications(db, cfg, { created: created.map("), "job `alerts` gửi dòng VỪA TẠO qua đường chung (lần đầu và gửi lại cùng một đường)");
    assert.ok(!/sendLark\(|sendTelegram\(/.test(rules), "rules.ts không tự gửi nữa — mọi lần gửi đi qua đường có ghi vết");
    const jobs = readFileSync(path.join(goc, "lib/sync/jobs.ts"), "utf8");
    assert.ok(!/"(notification-retry|approval-sweep)"\s*:/.test(jobs), "không thêm job / lịch mới");
    const giao = readFileSync(path.join(goc, "lib/alerts/notification-delivery.ts"), "utf8");
    assert.ok(!/console\.(log|info|error|warn)/.test(giao), "không in gì ra nhật ký (kho PUBLIC)");
  } finally {
    await xoaDong(db);
  }
  console.log("✓ Company OS · N1: tin Lark hỏng được gửi lại trong job `alerts` — nhịp lùi, trần, cửa sổ · hai lượt chồng không gửi trùng · đã gửi / đã đóng / quá cửa sổ / chưa từng thử không gửi lại · bỏ cuộc đếm được và hiện trên trang · câu lỗi đã che");
}

// ─────────────────────────── 2. DỌN LỜI DUYỆT KẸT ───────────────────────────

export async function testApprovalReservationSweep(db: Db) {
  const R = `${P}xin`;
  const A = `${P}duyet`;
  await db
    .insert(schema.users)
    .values([
      { id: R, email: "cos-n-xin@test.local", name: "Người xin N", passwordHash: "x", role: "LEADER" },
      { id: A, email: "cos-n-duyet@test.local", name: "Người duyệt N", passwordHash: "x", role: "MANAGER" },
    ])
    .onConflictDoNothing();
  const xin: ApprovalUser = { id: R, email: "cos-n-xin@test.local" };
  const [cauHinhCu] = await db.select().from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  const batCuongChe = JSON.stringify({ v: 2, groups: { EXPENSE_EDIT: true } });
  await db.insert(schema.settings).values({ key: APPROVAL_ENFORCE_KEY, value: batCuongChe }).onConflictDoUpdate({ target: schema.settings.key, set: { value: batCuongChe } });

  let so = 0;
  const viec = (): GuardInput => ({ group: "EXPENSE_EDIT", action: "expense.update", entity: "EXPENSE", entityId: `${P}chi-${++so}`, summary: "Sửa khoản chi kiểm N", amount: 9_000_000, payload: { so, p: P } });
  const duocDuyet = async (v: GuardInput): Promise<string> => {
    const g = await guardSecondApprovalCore(db, xin, v);
    assert.equal(g.mode, "NEEDS_APPROVAL", "tiền đề: cưỡng chế bật ⇒ phải xin");
    const d = await decideApprovalCore(db, { id: A, email: "cos-n-duyet@test.local", canDecide: true }, g.requestId!, true, undefined);
    assert.ok("ok" in d);
    return g.requestId!;
  };
  /** Giữ chỗ DEFERRED rồi "tiến trình chết": không thanh toán gì cả. */
  const giuChoRoiChet = async (v: GuardInput): Promise<string> => {
    const g = await guardSecondApprovalCore(db, xin, v, new Date(), { deferSettlement: true });
    assert.ok(g.consumed && g.settlement === "DEFERRED" && g.requestId, "tiền đề: giữ chỗ DEFERRED");
    return g.requestId;
  };
  const yeuCau = async (id: string) => (await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id)))[0];
  const demSuKien = async (id: string) => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, approvalExecutedDedupeKey(id))))[0].n);
  const demNhatKyTraLai = async (id: string) =>
    Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, id), like(schema.auditLogs.action, "approval.reservation_released:%"))))[0].n);
  const quaHan = () => new Date(Date.now() + (APPROVAL_RESERVATION_TIMEOUT_MINUTES + 1) * PHUT);
  const chuaHan = () => new Date(Date.now() + (APPROVAL_RESERVATION_TIMEOUT_MINUTES - 1) * PHUT);

  try {
    // ── (a) kẹt quá hạn ⇒ trả về APPROVED + execution_error; người xin làm lại được bằng ĐÚNG lời duyệt ──
    const v1 = viec();
    const id1 = await duocDuyet(v1);
    assert.equal(await giuChoRoiChet(v1), id1);
    const truoc = await releaseStuckApprovalReservations(db, chuaHan());
    assert.ok(!truoc.released.includes(id1), "(c) còn trong hạn giữ chỗ ⇒ KHÔNG động vào — thao tác có thể còn đang chạy");
    assert.equal((await yeuCau(id1)).status, "EXECUTED");
    const quet = await releaseStuckApprovalReservations(db, quaHan());
    assert.ok(quet.released.includes(id1), "quá hạn giữ chỗ, không sự kiện ⇒ trả lại");
    const sau1 = await yeuCau(id1);
    assert.deepEqual([sau1.status, sau1.executedAt, sau1.executionError], ["APPROVED", null, STUCK_RESERVATION_ERROR]);
    assert.equal(await demNhatKyTraLai(id1), 1, "lượt trả lại để lại đúng một dòng nhật ký (máy làm)");
    assert.deepEqual((await releaseStuckApprovalReservations(db, quaHan())).released.filter((x) => x === id1), [], "lũy đẳng: quét lại không đổi gì");

    // ── (a') câu nhắc HIỆN ở nơi người xin / người duyệt nhìn thấy yêu cầu — TRƯỚC khi ai bấm làm lại ──
    const choDuyet = await guardSecondApprovalCore(db, xin, viec()); // một yêu cầu ĐANG CHỜ, không có lỗi
    assert.equal(choDuyet.mode, "NEEDS_APPROVAL");
    const sach = await duocDuyet(viec()); // đã duyệt, CHƯA thực thi, không lỗi — không phải "bị trả lại"
    const nhac = approvalExecutionNote(STUCK_RESERVATION_ERROR);
    const mucXin = await listApprovalSectionItems({ id: R, canDecide: false }, new Date());
    assert.ok(!mucXin.some((x) => x.id === sach), "lời duyệt sạch chưa dùng không hiện là 'bị trả lại'");
    const dongTraLai = mucXin.find((x) => x.id === id1);
    assert.ok(dongTraLai, "lời duyệt bị trả lại phải hiện ở mục duyệt của trang Cần xử lý");
    assert.deepEqual([dongTraLai.returned, dongTraLai.isRequester, dongTraLai.canDecide, dongTraLai.executionNote], [true, true, false, nhac]);
    assert.ok(dongTraLai.executionFailedAt instanceof Date, "kèm LÚC lần thực thi bị dọn (từ nhật ký)");
    const dongCho = mucXin.find((x) => x.id === choDuyet.requestId);
    assert.ok(dongCho && dongCho.executionNote === null && !dongCho.returned, "yêu cầu không có execution_error ⇒ KHÔNG có câu nhắc");
    const mucDuyet = await listApprovalSectionItems({ id: A, canDecide: true }, new Date());
    assert.equal(mucDuyet.find((x) => x.id === id1)?.canDecide, false, "người duyệt thấy câu nhắc nhưng không có gì để duyệt lại");
    assert.equal(mucDuyet.find((x) => x.id === id1)?.executionNote, nhac);
    const viecWork = (await adaptApprovals(new Date(), true)).find((w) => w.sourceKey === id1);
    assert.ok(viecWork && viecWork.evidence.detail.includes(nhac ?? "∅") && viecWork.summary.includes(nhac ?? "∅"), "việc APPROVAL trên /work mang câu nhắc ở tóm tắt và bằng chứng");
    assert.ok(!(await adaptApprovals(new Date(), true)).find((w) => w.sourceKey === choDuyet.requestId)?.evidence.detail.includes("không hoàn tất"), "việc không có lỗi ⇒ bằng chứng không có câu nhắc");
    const src = readFileSync(path.join(path.resolve(__dirname, ".."), "app/(dashboard)/alerts/approval-section.tsx"), "utf8");
    assert.ok(/\{r\.executionNote \? \(/.test(src) && src.includes("r.executionFailedAt"), "mục duyệt trên /alerts vẽ câu nhắc + lúc hỏng");

    const lai = await withApprovalExecution(async () => {
      const g = await guardWithinScope(db, xin, v1);
      assert.ok(g.consumed && g.requestId === id1, "làm lại ĐÚNG việc ⇒ dùng lại ĐÚNG lời duyệt đã trả");
      assert.equal(g.priorExecutionError, STUCK_RESERVATION_ERROR, "lượt tiêu thụ mang câu lỗi của lần trước (cột bị xoá ngay sau đó)");
      return { ok: true as const };
    });
    assert.ok("ok" in lai);
    assert.deepEqual([(await yeuCau(id1)).status, await demSuKien(id1)], ["EXECUTED", 1]);
    assert.ok(!(await listApprovalSectionItems({ id: R, canDecide: false }, new Date())).some((x) => x.id === id1), "làm lại xong ⇒ câu nhắc biến mất");
    const [nhatKyThucThi] = await db
      .select({ detail: schema.auditLogs.detail })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityId, id1), like(schema.auditLogs.action, "approval.execute:%")))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(1);
    assert.equal((nhatKyThucThi?.detail as { priorExecutionError?: string } | null)?.priorExecutionError, STUCK_RESERVATION_ERROR, "nhật ký lượt làm lại giữ câu lỗi của lần trước");

    // ── (b) CÓ approval.executed ⇒ không bao giờ động vào, dù giữ chỗ cũ đến đâu ──
    const v2 = viec();
    const id2 = await duocDuyet(v2);
    await giuChoRoiChet(v2);
    await confirmApprovalExecution(db, id2, xin);
    assert.equal(await demSuKien(id2), 1);
    const q2 = await releaseStuckApprovalReservations(db, new Date(Date.now() + 1000 * APPROVAL_RESERVATION_TIMEOUT_MINUTES * PHUT));
    assert.ok(!q2.released.includes(id2) && !q2.released.includes(id1), "có dấu hiệu thành công ⇒ KHÔNG hồi sinh");
    assert.equal((await yeuCau(id2)).status, "EXECUTED");

    // ── (b') EXECUTED không sự kiện NHƯNG không phải giữ chỗ DEFERRED (dòng trước khi sự kiện LIVE) ⇒ không động vào ──
    const v3 = viec();
    const id3 = await duocDuyet(v3);
    await db.update(schema.approvalRequests).set({ status: "EXECUTED", executedAt: new Date() }).where(eq(schema.approvalRequests.id, id3));
    const q3 = await releaseStuckApprovalReservations(db, quaHan());
    assert.ok(!q3.released.includes(id3), "không có nhật ký giữ chỗ DEFERRED ⇒ việc đã chạy thật theo đường cũ, KHÔNG hồi sinh");
    assert.ok(!(await listApprovalSectionItems({ id: R, canDecide: false }, new Date())).some((x) => x.id === id3 || x.id === id2), "yêu cầu đã thực thi (có hoặc không sự kiện) không hiện là 'bị trả lại'");

    // ── (d) hai lượt quét đồng thời ⇒ một hiệu lực ──
    const v4 = viec();
    const id4 = await duocDuyet(v4);
    await giuChoRoiChet(v4);
    const hai = await Promise.all([0, 1].map(() => releaseStuckApprovalReservations(db, quaHan())));
    assert.equal(hai.flatMap((r) => r.released).filter((x) => x === id4).length, 1, "hai lượt quét chồng ⇒ đúng một lượt trả lại");
    assert.equal(await demNhatKyTraLai(id4), 1, "đúng một dòng nhật ký");
    assert.equal((await yeuCau(id4)).status, "APPROVED");

    // ── Mã nguồn: chạy trong job `alerts` có sẵn ──
    const rules = readFileSync(path.join(path.resolve(__dirname, ".."), "lib/alerts/rules.ts"), "utf8");
    assert.ok(rules.includes("releaseStuckApprovalReservations(db)"), "lượt dọn chạy trong job `alerts`, không lịch mới");
    assert.ok(!/^\s*["']use server["'];?\s*$/m.test(readFileSync(path.join(path.resolve(__dirname, ".."), "lib/approvals/reservation-sweep.ts"), "utf8")), "hàm trả lời duyệt về APPROVED KHÔNG được là server action");
  } finally {
    if (cauHinhCu) await db.update(schema.settings).set({ value: cauHinhCu.value }).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
    // Yêu cầu (b') còn EXECUTED không sự kiện — để nguyên: không có nhật ký giữ chỗ DEFERRED nên không lượt quét nào chạm tới.
  }
  console.log(`✓ Company OS · N2: lời duyệt kẹt quá ${APPROVAL_RESERVATION_TIMEOUT_MINUTES} phút giữa giữ chỗ và thanh toán được trả về APPROVED + execution_error · có approval.executed / không phải giữ chỗ DEFERRED / còn trong hạn ⇒ không động vào · hai lượt quét chồng ⇒ một hiệu lực · làm lại dùng đúng lời duyệt cũ`);
}
