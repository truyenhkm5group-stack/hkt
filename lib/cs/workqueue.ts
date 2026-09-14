import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CsStatus } from "@/lib/constants/cs";
import type { CsEventAction, CsEventSource, CsQuickActionKey } from "@/lib/constants/cs-actions";

/**
 * ═══════════ NGHIỆP VỤ CỦA HÀNG ĐỢI CSKH, TÁCH KHỎI LỚP XÁC THỰC ═══════════
 *
 * Cùng hình dạng với `lib/care/service.ts` của care vận đơn: Server Action lo QUYỀN và zod, tệp
 * này lo VIỆC. Nhờ vậy bộ kiểm thử gọi thẳng được nghiệp vụ mà không phải dựng phiên đăng nhập
 * giả — và cái được kiểm là luật thật, không phải một bản chép lại của luật trong tệp test.
 *
 * ─── VÌ SAO NHẬN Ý ĐỊNH, KHÔNG NHẬN TRƯỜNG ───
 *
 * Đầu vào là Ý ĐỊNH nghiệp vụ ("đã liên hệ", "nhận việc", "hẹn lại"), không phải
 * `{status, assignee, followUpAt}` tuỳ ý. Nếu để nơi gọi tự ghép trường thì sớm muộn sẽ có chỗ
 * "đã liên hệ" mà quên gán người, hoặc "hẹn lại" mà case vẫn nằm ở Mới — và mỗi chỗ gọi sẽ quên
 * một trường khác nhau.
 */
export type CsActor = { id: string | null; email: string; name: string; source: CsEventSource };

/**
 * TÊN HIỂN THỊ của người thao tác — dùng làm `assignee` khi họ nhận việc.
 *
 * Tên là để NGƯỜI đọc trên dòng. Danh tính đi ở `assignee_user_id` (`actor.id`). Hai thứ tách hẳn
 * nhau: đổi tên hiển thị không được làm mất dấu ai đã làm case, và trùng tên không được làm hai
 * người thành một trong thẻ điểm.
 */
export function actorLabel(actor: CsActor) {
  return actor.name || actor.email;
}

export type CsQuickResult = { ok: true; data: { status: CsStatus; assignee: string; followUpAt: Date | null } } | { error: string };

/** Trạng thái đóng thì đóng mốc `resolved_at`; mở lại thì xoá mốc — một chỗ quyết định, không rải rác. */
export function resolvedAtFor(status: CsStatus, previous: Date | null): Date | null {
  if (status === "DONE" || status === "CANCELLED" || status === "AUTO_RESOLVED") return previous ?? new Date();
  return null;
}

/**
 * MỌI LẦN ĐỘNG VÀO CASE ĐỀU ĐỂ LẠI MỘT DÒNG.
 *
 * `audit_logs` trả lời câu hỏi AN NINH ("ai đụng vào cái gì"), không hiện được trên dòng và không
 * ai đọc nó khi nhận ca. `cs_case_events` trả lời câu hỏi NGHIỆP VỤ mà người xử lý tiếp theo cần
 * trong ba giây: lần trước gọi lúc nào, khách nói gì, vì sao hẹn lại. Hai sổ, hai mục đích.
 */
export async function recordCsEvent(input: {
  caseId: string;
  actor: CsActor;
  action: CsEventAction;
  note?: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  previousAssignee?: string | null;
  nextAssignee?: string | null;
  followUpAt?: Date | null;
}) {
  const db = await getDb();
  await db.insert(schema.csCaseEvents).values({
    caseId: input.caseId,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    actorName: input.actor.name,
    source: input.actor.source,
    action: input.action,
    note: input.note ?? "",
    previousStatus: input.previousStatus ?? null,
    nextStatus: input.nextStatus ?? null,
    previousAssignee: input.previousAssignee ?? null,
    nextAssignee: input.nextAssignee ?? null,
    followUpAt: input.followUpAt ?? null,
  });
}

export async function applyCsQuickAction(
  input: { id: string; action: Extract<CsQuickActionKey, "CLAIM" | "CONTACTED" | "INFO_FIXED" | "DONE" | "SNOOZE">; followUpAt?: Date | null; note?: string },
  actor: CsActor,
): Promise<CsQuickResult> {
  const db = await getDb();
  const before = await db.query.csCases.findFirst({
    where: eq(schema.csCases.id, input.id),
    columns: { id: true, status: true, assignee: true, assigneeUserId: true, resolution: true, resolvedAt: true, followUpAt: true },
  });
  if (!before) return { error: "Không tìm thấy case" };

  const me = actorLabel(actor);
  let status = before.status as CsStatus;
  let assignee = before.assignee;
  /*
    DANH TÍNH ĐI CÙNG TÊN, KHÔNG BAO GIỜ LỆCH.

    Mọi nhánh dưới đây gán `assignee = me` đều phải gán kèm `assigneeUserId = actor.id`. Để lệch
    một nhánh là tạo ra một case mang tên một người nhưng quy kết về người khác (hoặc về không
    ai) — và lỗi đó im lặng cho tới lúc ai đó bị chấm sai trên thẻ điểm.
  */
  let assigneeUserId = before.assigneeUserId;
  const nhanViec = () => {
    assignee = me;
    assigneeUserId = actor.id;
  };
  let followUpAt: Date | null = before.followUpAt;
  let resolution = before.resolution;
  let eventAction: CsEventAction = "STATUS";
  let note = input.note ?? "";

  switch (input.action) {
    case "CLAIM":
      // Nhận việc = gán MÌNH. Không nhận tên người khác từ nơi gọi: giao việc cho người khác là
      // thao tác khác, đi qua ô Phụ trách và ghi một sự kiện ASSIGN riêng.
      nhanViec();
      if (status === "OPEN") status = "IN_PROGRESS";
      eventAction = "ASSIGN";
      break;
    case "CONTACTED":
      status = "IN_PROGRESS";
      nhanViec();
      eventAction = "NOTE";
      note = note || "Đã liên hệ khách";
      break;
    case "INFO_FIXED":
      status = "DONE";
      resolution = resolution || "Khách đã cho thông tin đúng, đã cập nhật trước khi gửi hàng.";
      if (!assignee) nhanViec();
      break;
    case "DONE":
      status = "DONE";
      if (!assignee) nhanViec();
      break;
    case "SNOOZE": {
      if (!input.followUpAt) return { error: "Chưa chọn thời điểm hẹn lại" };
      const at = input.followUpAt;
      if (Number.isNaN(at.getTime())) return { error: "Thời điểm hẹn lại không hợp lệ" };
      // Hẹn về quá khứ nghe thì vô hại, nhưng nó biến cái hẹn thành vô nghĩa: mọi case hẹn kiểu đó
      // đều đến hạn ngay và cùng lúc nổi lên đầu hàng đợi.
      if (at.getTime() <= Date.now()) return { error: "Thời điểm hẹn lại phải ở tương lai" };
      followUpAt = at;
      if (status === "OPEN") status = "IN_PROGRESS";
      if (!assignee) nhanViec();
      eventAction = "FOLLOW_UP";
      break;
    }
  }

  await db
    .update(schema.csCases)
    .set({ status, assignee, assigneeUserId, followUpAt, resolution, resolvedAt: resolvedAtFor(status, before.resolvedAt), updatedAt: new Date() })
    .where(eq(schema.csCases.id, input.id));
  await recordCsEvent({
    caseId: input.id,
    actor,
    action: eventAction,
    note,
    previousStatus: before.status,
    nextStatus: status,
    previousAssignee: before.assignee,
    nextAssignee: assignee,
    followUpAt,
  });
  return { ok: true, data: { status, assignee, followUpAt } };
}

/**
 * Ghi chú nhanh. KHÔNG đè lên `resolution` và không đụng trạng thái: ghi lại việc đã xảy ra không
 * phải là kết luận case — trộn hai thứ đó chính là lý do lịch sử CSKH trước đây chỉ còn lại đúng
 * một dòng chữ cuối cùng.
 */
export async function addCsNote(input: { id: string; note: string }, actor: CsActor): Promise<{ ok: true; data: { note: string; at: Date; by: string } } | { error: string }> {
  const note = input.note.trim();
  if (!note) return { error: "Ghi chú trống" };
  const db = await getDb();
  const before = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, input.id), columns: { id: true } });
  if (!before) return { error: "Không tìm thấy case" };
  const at = new Date();
  await recordCsEvent({ caseId: input.id, actor, action: "NOTE", note });
  await db.update(schema.csCases).set({ updatedAt: at }).where(eq(schema.csCases.id, input.id));
  return { ok: true, data: { note, at, by: actorLabel(actor) } };
}

/**
 * ĐỔI NHANH TRẠNG THÁI / NGƯỜI PHỤ TRÁCH từ hai ô chọn trên dòng.
 *
 * ─── GIAO VIỆC BẰNG KHOÁ, KHÔNG BẰNG TÊN GÕ TAY ───
 *
 * Ô Phụ trách trước đây là một ô CHỮ: gõ gì cũng được. Hệ quả không thấy ngay: "Lan", "lan",
 * "Lan CS" và "Nguyễn Thị Lan" là bốn người khác nhau với máy, nên thẻ điểm chia công của một
 * người thành bốn phần, mỗi phần mẫu quá bé để kết luận gì.
 *
 * Nay nơi gọi truyền `assigneeUserId` (khoá tài khoản ERP, `null` = gỡ người). TÊN HIỂN THỊ do
 * MÁY CHỦ đọc từ `users`, không nhận từ client — client gửi tên khác với khoá thì dòng dữ liệu
 * nói một đằng, quy kết một nẻo.
 *
 * `assignee` (ô chữ) vẫn được ghi, làm ẢNH CHỤP TÊN lúc giao việc: người nghỉ việc và tài khoản
 * bị xoá thì dòng vẫn còn đọc được ai đã làm.
 */
export async function setCsCaseFields(input: { id: string; status?: CsStatus; assigneeUserId?: string | null }, actor: CsActor): Promise<CsQuickResult> {
  const db = await getDb();
  const before = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, input.id), columns: { id: true, status: true, assignee: true, assigneeUserId: true, resolvedAt: true, followUpAt: true } });
  if (!before) return { error: "Không tìm thấy case" };
  const status = input.status ?? (before.status as CsStatus);

  let assignee = before.assignee;
  let assigneeUserId = before.assigneeUserId;
  if (input.assigneeUserId !== undefined) {
    if (input.assigneeUserId === null) {
      // GỠ NGƯỜI: xoá cả khoá LẪN tên. Giữ lại tên mà bỏ khoá sẽ tạo đúng thứ vừa bỏ đi — một
      // case mang tên một người mà không quy kết được về ai.
      assignee = "";
      assigneeUserId = null;
    } else {
      const u = await db.query.users.findFirst({ where: eq(schema.users.id, input.assigneeUserId), columns: { id: true, name: true, email: true } });
      if (!u) return { error: "Không tìm thấy người phụ trách" };
      assignee = u.name || u.email;
      assigneeUserId = u.id;
    }
  }

  await db
    .update(schema.csCases)
    .set({ status, assignee, assigneeUserId, resolvedAt: resolvedAtFor(status, before.resolvedAt), updatedAt: new Date() })
    .where(eq(schema.csCases.id, input.id));
  if (input.status && input.status !== before.status) {
    await recordCsEvent({ caseId: input.id, actor, action: "STATUS", previousStatus: before.status, nextStatus: input.status });
  }
  if (input.assigneeUserId !== undefined && assigneeUserId !== before.assigneeUserId) {
    await recordCsEvent({ caseId: input.id, actor, action: "ASSIGN", previousAssignee: before.assignee, nextAssignee: assignee });
  }
  return { ok: true, data: { status, assignee, followUpAt: before.followUpAt } };
}
