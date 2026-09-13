"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, requireUser, type SessionUser } from "@/lib/auth/session";
import { CS_HUMAN_STATUSES, CS_KINDS, CS_RULES_KEY, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CS_MUTATE_ACTIONS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { CS_HUMAN_KINDS, CS_LOGISTICS_KINDS } from "@/lib/constants/cs-domain";
import { detectCsCases } from "@/lib/cs/detect";
import { addCsNote, applyCsQuickAction, recordCsEvent, setCsCaseFields, type CsActor } from "@/lib/cs/workqueue";
import { findOrderForCase, listCsCaseEvents } from "@/lib/queries/cs";
import { setSettingJson } from "@/lib/settings";

type Result<T = object> = ({ ok: true } & T) | { error: string };

/**
 * NGƯỜI KHÔNG TẠO ĐƯỢC CASE GIAO VẬN, KHÔNG ĐẶT ĐƯỢC TRẠNG THÁI CỦA MÁY.
 *
 *  · `kind`: loại miền `LOGISTICS` (giao không thành) sinh TỪ CHỨNG TỪ ĐVVC, không từ một ô chọn.
 *    Lược đồ vẫn nhận đủ `CS_KINDS` để SỬA một case bot đã tạo mà không đổi loại; đổi SANG loại
 *    giao vận hay tạo mới loại đó bị chặn ở `saveCsCase`.
 *  · `status`: `AUTO_RESOLVED` là kết luận của MÁY (`CS_HUMAN_STATUSES` loại nó ra) — người bấm
 *    được thì con số năng suất CSKH mất nghĩa.
 */
const HUMAN_STATUS = z.enum(CS_HUMAN_STATUSES as [CsStatus, ...CsStatus[]]);
const HUMAN_KIND = z.enum(CS_HUMAN_KINDS as [CsKind, ...CsKind[]]);

const caseSchema = z.object({
  id: z.string().optional(),
  orderId: z.string().trim().max(100).optional().nullable(),
  kind: z.enum(CS_KINDS),
  status: HUMAN_STATUS.default("OPEN"),
  title: z.string().trim().min(2).max(300),
  detail: z.string().trim().max(2000).default(""),
  customerName: z.string().trim().max(200).default(""),
  customerPhone: z.string().trim().max(30).default(""),
  /**
    NGƯỜI PHỤ TRÁCH ĐI BẰNG KHOÁ TÀI KHOẢN, không phải ô chữ.

    Trước bản này ô Phụ trách nhận bất kỳ chuỗi nào. Bốn cách gõ tên một người là bốn người khác
    nhau với máy, nên công của họ bị chia nhỏ tới mức mẫu nào cũng quá bé để nói được gì.
    `null` = GỠ NGƯỜI; `undefined` (ô không gửi lên) = KHÔNG ĐỤNG tới người phụ trách.
  */
  assigneeUserId: z.string().trim().max(60).nullable().optional(),
  resolution: z.string().trim().max(2000).default(""),
});

function revalidate() {
  // `/shipments` nằm trong danh sách vì miền của case quyết định kiện có nằm trong hàng đợi care
  // hay không: đóng một case sai địa chỉ làm đổi số ở CẢ HAI bàn làm việc.
  for (const p of ["/cs", "/shipments", "/alerts", "/"]) revalidatePath(p);
}

/** Người thao tác, theo hình dạng `lib/cs/workqueue.ts` dùng — nguồn `UI` vì đây là Server Action của giao diện. */
function actorOf(user: SessionUser): CsActor {
  return { id: user.id, email: user.email, name: user.name, source: "UI" };
}

async function authorize() {
  const user = await requireUser();
  return { user, error: can(user, "cs:manage") ? null : "Bạn không có quyền xử lý case CSKH" };
}

/**
 * PHẠM VI ÁP LÊN THAO TÁC GHI. Danh sách đã lọc bằng `lib/queries/cs.ts`, nhưng một Server Action
 * nhận `id` từ client thì không đi qua danh sách nào — người phạm vi hẹp vẫn gõ được id case của
 * người khác vào nút "Nhận việc". Hỏi lại đúng mệnh đề mà danh sách dùng (`rowInScope`).
 */
async function caseOutOfScope(user: SessionUser, caseId: string): Promise<string | null> {
  const d = await decideScope("CS", user);
  if (d.allow === "NONE") return `${d.reason} ${d.fix}`;
  return (await rowInScope(d, "cs_cases", "id", caseId)) ? null : "Case này nằm ngoài phạm vi dữ liệu của bạn";
}

export async function saveCsCase(input: unknown): Promise<Result<{ id: string }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const data = parsed.data;
  const db = await getDb();
  const existing = data.id ? await db.query.csCases.findFirst({ where: eq(schema.csCases.id, data.id) }) : null;
  if (data.id && !existing) return { error: "Không tìm thấy case" };
  if (existing) {
    const ngoai = await caseOutOfScope(user, existing.id);
    if (ngoai) return { error: ngoai };
  }
  // Loại giao vận chỉ do chứng từ ĐVVC sinh ra: không tạo tay, không đổi một case khác SANG loại đó.
  if (CS_LOGISTICS_KINDS.includes(data.kind) && existing?.kind !== data.kind) {
    return { error: "Loại case giao vận sinh từ sự kiện Viettel Post, không tạo tay được — kiện giao hụt đã có ở Vận đơn & care" };
  }
  let customerId: string | null = null;
  if (data.orderId) {
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, data.orderId), columns: { id: true, customerId: true, billFullName: true, billPhone: true } });
    if (!order) return { error: "Không tìm thấy đơn hàng" };
    customerId = order.customerId;
    if (!data.customerName) data.customerName = order.billFullName ?? "";
    if (!data.customerPhone) data.customerPhone = order.billPhone ?? "";
  }
  /*
    NGƯỜI PHỤ TRÁCH CHỈ ĐỤNG TỚI KHI THẬT SỰ ĐỔI.

    Hộp thoại sửa case gửi `assigneeUserId = null` cho một case cũ chỉ có TÊN GÕ TAY (chưa nối
    khoá): trước bản này máy chủ hiểu đó là "gỡ người" và xoá luôn cái tên — thứ duy nhất nói ai
    đã làm case. Nay: không gửi, hoặc gửi đúng khoá đang có ⇒ giữ nguyên cả tên lẫn khoá; gửi khoá
    KHÁC ⇒ đổi cả hai và ghi một dòng `cs_case_events` ASSIGN. Tên hiển thị đọc từ `users` ở MÁY
    CHỦ — nhận tên từ client thì khoá nói một đằng, chữ nói một nẻo.
  */
  const doiNguoi = data.assigneeUserId !== undefined && data.assigneeUserId !== (existing?.assigneeUserId ?? null);
  let assigneeName = "";
  if (doiNguoi && data.assigneeUserId) {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, data.assigneeUserId), columns: { id: true, name: true, email: true } });
    if (!u) return { error: "Không tìm thấy người phụ trách" };
    assigneeName = u.name || u.email;
  }
  const actor = actorOf(user);
  const resolvedAt = data.status === "DONE" || data.status === "CANCELLED" ? new Date() : null;
  if (existing) {
    const nguoi = doiNguoi ? { assignee: assigneeName, assigneeUserId: data.assigneeUserId ?? null } : {};
    await db
      .update(schema.csCases)
      .set({ orderId: data.orderId ?? existing.orderId, customerId: customerId ?? existing.customerId, kind: data.kind, status: data.status, title: data.title, detail: data.detail, customerName: data.customerName, customerPhone: data.customerPhone, ...nguoi, resolution: data.resolution, resolvedAt: resolvedAt ?? (data.status === "OPEN" || data.status === "IN_PROGRESS" ? null : existing.resolvedAt), updatedAt: new Date() })
      .where(eq(schema.csCases.id, existing.id));
    // Lịch sử nghiệp vụ (không chỉ audit): người nhận ca sau cần biết ai đổi trạng thái / đổi người, lúc nào.
    if (data.status !== existing.status) await recordCsEvent({ caseId: existing.id, actor, action: "STATUS", previousStatus: existing.status, nextStatus: data.status });
    if (doiNguoi) await recordCsEvent({ caseId: existing.id, actor, action: "ASSIGN", previousAssignee: existing.assignee, nextAssignee: assigneeName });
    await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: existing.id, detail: { before: { status: existing.status, kind: existing.kind, assignee: existing.assignee }, after: data } });
    revalidate();
    return { ok: true, id: existing.id };
  }
  const [row] = await db
    .insert(schema.csCases)
    .values({ orderId: data.orderId ?? null, customerId, kind: data.kind, status: data.status, source: "MANUAL", title: data.title, detail: data.detail, customerName: data.customerName, customerPhone: data.customerPhone, assignee: assigneeName, assigneeUserId: doiNguoi ? (data.assigneeUserId ?? null) : null, resolution: data.resolution, createdBy: user.email, createdByUserId: user.id, resolvedAt })
    .returning({ id: schema.csCases.id });
  if (doiNguoi && data.assigneeUserId) await recordCsEvent({ caseId: row.id, actor, action: "ASSIGN", previousAssignee: "", nextAssignee: assigneeName });
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_CREATE", entity: "CS_CASE", entityId: row.id, detail: data });
  revalidate();
  return { ok: true, id: row.id };
}

/** Đổi nhanh trạng thái / người phụ trách từ hai ô chọn trên dòng. Người đi bằng khoá, `null` = gỡ người. */
export async function updateCsCaseQuick(input: { id: string; status?: string; assigneeUserId?: string | null }): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), status: HUMAN_STATUS.optional(), assigneeUserId: z.string().trim().max(60).nullable().optional() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const ngoai = await caseOutOfScope(user, parsed.data.id);
  if (ngoai) return { error: ngoai };
  const res = await setCsCaseFields(parsed.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: parsed.data.id, detail: parsed.data });
  revalidate();
  return { ok: true };
}

/**
 * ═══════════ MỘT NÚT TRÊN DÒNG = MỘT Ý ĐỊNH NGHIỆP VỤ ═══════════
 *
 * Cố ý KHÔNG nhận `{status, assignee, followUpAt}` tuỳ ý từ client rồi ghi thẳng. Client nói Ý
 * ĐỊNH ("đã liên hệ", "nhận việc", "hẹn lại"); `lib/cs/workqueue.ts` dịch ý định thành các trường.
 * Nhờ vậy "đã liên hệ mà quên gán người" hay "hẹn lại mà case vẫn ở Mới" không xảy ra được vì một
 * chỗ gọi nào đó quên một trường.
 *
 * Hành động `LINK` (mở Pancake, mở đơn) KHÔNG đi qua đây: chúng không ghi gì, chỉ là đường dẫn.
 */
const quickSchema = z.object({
  id: z.string().min(1),
  action: z.enum(CS_MUTATE_ACTIONS as [CsQuickActionKey, ...CsQuickActionKey[]]),
  /** Chỉ dùng cho `SNOOZE`. Chuỗi ISO từ client; máy chủ tự kiểm tra là mốc trong tương lai. */
  followUpAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function csQuickAction(input: unknown): Promise<Result<{ status: string; assignee: string; followUpAt: string | null }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = quickSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { id, action } = parsed.data;
  if (action === "OPEN_POS" || action === "OPEN_ORDER" || action === "CHAT" || action === "OPEN_CARE") return { error: "Hành động này chỉ mở đường dẫn, không ghi dữ liệu" };
  const ngoai = await caseOutOfScope(user, id);
  if (ngoai) return { error: ngoai };
  const res = await applyCsQuickAction({ id, action, followUpAt: parsed.data.followUpAt ? new Date(parsed.data.followUpAt) : null, note: parsed.data.note }, actorOf(user));
  if ("error" in res) return res;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "CS_CASE_UPDATE",
    entity: "CS_CASE",
    entityId: id,
    detail: { quickAction: action, after: { status: res.data.status, assignee: res.data.assignee, followUpAt: res.data.followUpAt } },
  });
  revalidate();
  return { ok: true, status: res.data.status, assignee: res.data.assignee, followUpAt: res.data.followUpAt ? res.data.followUpAt.toISOString() : null };
}

/** Ghi chú nhanh ngay trên dòng — xem `lib/cs/workqueue.ts::addCsNote` để biết vì sao không đè `resolution`. */
export async function addCsCaseNote(input: unknown): Promise<Result<{ note: string; at: string; by: string }>> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = z.object({ id: z.string().min(1), note: z.string().trim().min(1).max(1000) }).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Ghi chú không hợp lệ" };
  const ngoai = await caseOutOfScope(user, parsed.data.id);
  if (ngoai) return { error: ngoai };
  const res = await addCsNote(parsed.data, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_NOTE", entity: "CS_CASE", entityId: parsed.data.id, detail: { note: parsed.data.note } });
  revalidate();
  return { ok: true, note: res.data.note, at: res.data.at.toISOString(), by: res.data.by };
}

/** Lịch sử case cho popover — đọc, nên chỉ cần quyền xem. */
export async function getCsCaseHistory(id: string): Promise<Result<{ events: { id: string; action: string; note: string; actor: string; at: string; previousStatus: string | null; nextStatus: string | null; followUpAt: string | null }[] }>> {
  const user = await requireUser();
  if (!can(user, "cs:view")) return { error: "Bạn không có quyền xem case CSKH" };
  const rows = await listCsCaseEvents(id);
  return {
    ok: true,
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      note: r.note,
      actor: r.actorName || r.actorEmail,
      at: r.createdAt.toISOString(),
      previousStatus: r.previousStatus,
      nextStatus: r.nextStatus,
      followUpAt: r.followUpAt ? r.followUpAt.toISOString() : null,
    })),
  };
}

/**
 * "XOÁ" MỘT CASE = HUỶ, KHÔNG XOÁ DÒNG.
 *
 * Case đã có lịch sử (ghi chú, đổi người, hẹn lại) là bằng chứng ai đã làm gì với khách; xoá cứng
 * là mất bằng chứng đó và làm thẻ điểm hụt mẫu. Nên case có sự kiện chuyển sang `CANCELLED` (qua
 * chính đường đổi trạng thái, có dòng lịch sử STATUS). Chỉ case CHƯA có sự kiện nào — tạo nhầm,
 * chưa ai chạm — mới xoá thật; `dedupe_key` của case bot vẫn giữ để job không tạo lại.
 */
export async function deleteCsCase(id: string): Promise<Result> {
  const { user, error } = await authorize();
  if (error) return { error };
  const ngoai = await caseOutOfScope(user, id);
  if (ngoai) return { error: ngoai };
  const db = await getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.csCaseEvents).where(eq(schema.csCaseEvents.caseId, id));
  if (Number(n) === 0) {
    await db.delete(schema.csCases).where(eq(schema.csCases.id, id));
    await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_DELETE", entity: "CS_CASE", entityId: id });
    revalidate();
    return { ok: true };
  }
  const res = await setCsCaseFields({ id, status: "CANCELLED" }, actorOf(user));
  if ("error" in res) return res;
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_CANCEL", entity: "CS_CASE", entityId: id, detail: { reason: "xoá từ giao diện — case có lịch sử nên chuyển Huỷ thay vì xoá dòng" } });
  revalidate();
  return { ok: true };
}

export async function runCsDetection(): Promise<Result<{ created: number; scanned: number }>> {
  const { error } = await authorize();
  if (error) return { error };
  const r = await detectCsCases();
  revalidate();
  return { ok: true, ...r };
}

export async function searchOrdersForCase(term: string): Promise<Result<{ orders: Awaited<ReturnType<typeof findOrderForCase>> }>> {
  const { error } = await authorize();
  if (error) return { error };
  if (!term || term.trim().length < 2) return { ok: true, orders: [] };
  return { ok: true, orders: await findOrderForCase(term.trim()) };
}

// Luật từ khoá chỉ trỏ tới loại của NGƯỜI: một thẻ đơn không thể sinh ra case "giao không thành".
const rulesSchema = z.object({
  lookbackDays: z.number().int().min(1).max(365),
  tagRules: z.array(z.object({ keyword: z.string().trim().min(2).max(60), kind: HUMAN_KIND })).max(100),
  noteRules: z.array(z.object({ keyword: z.string().trim().min(2).max(60), kind: HUMAN_KIND })).max(200),
});

export async function saveCsRules(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:config")) return { error: "Không có quyền" };
  const parsed = rulesSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  await setSettingJson(CS_RULES_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "SETTINGS_UPDATE", entity: "SETTINGS", entityId: CS_RULES_KEY, detail: parsed.data });
  revalidate();
  return { ok: true };
}

/**
 * ═══════════ BẤM HÀNG LOẠT — CHỈ NHỮNG VIỆC CÓ CÙNG NGHĨA TRÊN MỌI LOẠI CASE ═══════════
 *
 * Hàng đợi theo khách cho chọn nhiều dòng, mỗi dòng là một khách với N case. Nhận việc cho mười
 * khách là một thao tác thật (người trực gom một loạt để gọi trong ca), và bắt họ bấm bốn mươi lần
 * là lý do người ta bỏ hàng đợi mà quay lại làm bằng Excel.
 *
 * NHƯNG chỉ ba việc được phép: **nhận việc · gán người · hẹn lại**. Cả ba nói về AI LÀM và LÀM LÚC
 * NÀO — nghĩa của chúng không đổi dù case là khiếu nại hay đổi size.
 *
 * "Đã xử lý" thì KHÔNG bao giờ. Đóng một lượt 40 case thuộc bảy loại là khẳng định bảy việc khác
 * nhau đều đã hoàn tất; không ai kiểm được câu đó, và nó xoá luôn hàng đợi thật. Danh sách được
 * khai ở `lib/constants/cs-next-action.ts::CS_BULK_ACTIONS` và chặn ở CẢ lược đồ đầu vào LẪN lúc
 * tính — `tests/cs-customer-queue.test.ts` khoá lại.
 */
const bulkSchema = z.object({
  /**
   * Trần 200 case một lượt. Không phải để bảo vệ máy chủ mà để bảo vệ NGƯỜI BẤM: một thao tác
   * chạm tới nhiều hơn thế thì họ không còn kiểm được mình vừa làm gì, và không có nút hoàn tác.
   */
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(["CLAIM", "SNOOZE", "ASSIGN"]),
  followUpAt: z.string().datetime({ offset: true }).optional(),
  assigneeUserId: z.string().trim().max(60).nullable().optional(),
});

export type CsBulkResult = Result<{ done: number; skipped: number; message: string }>;

export async function csBulkAction(input: unknown): Promise<CsBulkResult> {
  const { user, error } = await authorize();
  if (error) return { error };
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { action } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];
  if (action === "SNOOZE" && !parsed.data.followUpAt) return { error: "Chưa chọn thời điểm hẹn lại" };
  if (action === "ASSIGN" && !parsed.data.assigneeUserId) return { error: "Chưa chọn người phụ trách" };

  /*
    PHẠM VI LỌC BẰNG MỘT TRUY VẤN, KHÔNG PHẢI 200 TRUY VẤN.

    `rowInScope` hỏi từng dòng — đúng cho một nút trên một dòng, sai cho một lượt hàng loạt. Ở đây
    mệnh đề phạm vi được nhúng thẳng vào một câu lệnh lọc cả danh sách, nên chi phí không phụ thuộc
    số case người dùng chọn.
  */
  const d = await decideScope("CS", user);
  if (d.allow === "NONE") return { error: `${d.reason} ${d.fix}` };
  const db = await getDb();
  const trongPhamVi =
    d.allow === "ALL"
      ? ids
      : (await db.select({ id: schema.csCases.id }).from(schema.csCases).where(sql`${schema.csCases.id} in ${ids} and (${d.where})`)).map((r) => r.id);
  const boQua = ids.length - trongPhamVi.length;
  if (!trongPhamVi.length) return { error: "Không case nào trong danh sách nằm trong phạm vi dữ liệu của bạn" };

  const actor = actorOf(user);
  const followUpAt = parsed.data.followUpAt ? new Date(parsed.data.followUpAt) : null;
  let done = 0;
  const loi: string[] = [];
  for (const id of trongPhamVi) {
    // Đi qua ĐÚNG đường ghi của một nút đơn lẻ: cùng luật, cùng dòng lịch sử, cùng cách xử lý lỗi.
    // Một lối ghi hàng loạt viết riêng là một lối ghi thứ hai, và nó sẽ quên một trường.
    const res =
      action === "ASSIGN"
        ? await setCsCaseFields({ id, assigneeUserId: parsed.data.assigneeUserId ?? null }, actor)
        : await applyCsQuickAction({ id, action, followUpAt }, actor);
    if ("error" in res) loi.push(res.error);
    else done += 1;
  }
  await audit({ userId: user.id, userEmail: user.email, action: "CS_CASE_UPDATE", entity: "CS_CASE", entityId: `bulk:${action}`, detail: { action, requested: ids.length, done, outOfScope: boQua, errors: loi.slice(0, 5) } });
  revalidate();
  const nhan = action === "CLAIM" ? "nhận việc" : action === "ASSIGN" ? "giao việc" : "hẹn lại";
  return {
    ok: true,
    done,
    skipped: boQua + loi.length,
    // Nói THẲNG phần không làm được. Một thông báo "đã xong" khi 12/40 case bị bỏ qua là thông báo
    // dạy người dùng đừng tin cái nút.
    message: `Đã ${nhan} ${done} case${boQua ? ` · ${boQua} ngoài phạm vi` : ""}${loi.length ? ` · ${loi.length} lỗi: ${loi[0]}` : ""}`,
  };
}
