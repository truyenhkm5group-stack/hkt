import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit, type AuditParams } from "@/lib/audit";
import { isOpenTransaction, type DbOrTx } from "@/lib/db-transaction";
import { emitDomainEvent } from "@/lib/events/emit";
import {
  APPROVAL_ENFORCE_KEY,
  APPROVAL_ENFORCE_LEGACY_KEY,
  APPROVAL_GROUP_LABEL,
  APPROVAL_GROUP_REASON,
  APPROVAL_GROUPS_WIRED,
  APPROVAL_VALID_HOURS,
  canonicalJson,
  isEnforced,
  overThreshold,
  legacyToV2,
  parseEnforceConfig,
  parseLegacyEnforceConfig,
  type ApprovalDecision,
  type ApprovalGroup,
  type EnforceConfigV2,
} from "@/lib/constants/approval";

/**
 * ═══════ LÕI CỔNG PHÊ DUYỆT HAI BƯỚC — KHÔNG "use server", NHẬN NGƯỜI THAO TÁC TỪ NGOÀI ═══════
 *
 * `lib/actions/approvals.ts` chỉ còn là lớp mỏng: đọc phiên đăng nhập rồi gọi xuống đây. Tách ra để
 * kiểm thử chạy được ĐÚNG đường ghi thật (phiên đăng nhập đọc cookie qua `next/headers`, thứ không
 * tồn tại ngoài một request) — một bài kiểm dựng lại luật bằng tay thì chỉ chứng minh bản sao đúng.
 *
 * Ba điều file này giữ:
 *
 *  1. **TIÊU THỤ ĐÚNG MỘT LẦN.** Yêu cầu đã duyệt mở khoá đúng MỘT lần thực hiện. Phép tiêu thụ là
 *     `UPDATE … WHERE id = ? AND status = 'APPROVED' RETURNING` — hai lượt bấm đồng thời cùng thấy
 *     một yêu cầu, nhưng chỉ một lượt lật được nó; lượt kia rơi về nhánh xin mới.
 *  2. **ĐÚNG VIỆC ĐÃ XIN.** Khớp theo dấu vân tay (nhóm · thao tác · thực thể · payload chuẩn hoá) VÀ
 *     đúng người xin. Đổi một con số là một việc khác; người khác làm hộ là một người khác.
 *  3. **HẾT HẠN LÀ HẾT.** Lời duyệt quá `APPROVAL_VALID_HOURS` không mở khoá được gì. Tính ĐÚNG ngay
 *     trong điều kiện tiêu thụ (nên không bao giờ sai), và trạng thái `EXPIRED` được GHI khi người xin
 *     chạm lại nhóm đó — không cần job định kỳ nào. Hệ quả nói thẳng: một yêu cầu đã quá hạn mà
 *     người xin không bao giờ thử lại thì cột `status` vẫn đọc `APPROVED`; nó vẫn không mở khoá được
 *     gì, và mọi chỗ đọc "còn hiệu lực" phải đọc qua `approvalStillValid()`.
 *  4. **TIÊU THỤ MÀ VIỆC KHÔNG CHẠY ĐƯỢC THÌ LỜI DUYỆT CÒN NGUYÊN** (Company OS · Agent K). Trước bản
 *     này lời duyệt lật `EXECUTED` ngay ở cổng, trước thao tác ghi — thao tác hỏng sau đó là mất lời
 *     duyệt. Nay có ba cách "thanh toán" một lượt tiêu thụ (`ApprovalSettlement`), chọn theo nơi gọi:
 *       · `IN_TRANSACTION` — `db` là giao dịch nghiệp vụ ĐANG MỞ của nơi gọi (cổng gọi TRONG giao dịch):
 *         lật `EXECUTED` + phát `approval.executed` cùng giao dịch với thao tác ghi. Thao tác hỏng ⇒
 *         tất cả cùng huỷ, lời duyệt vẫn `APPROVED`; nơi gọi ghi câu lỗi bằng
 *         `recordApprovalExecutionError`. Dòng nhật ký của cổng phải HOÃN (`auditSink`) tới sau khi
 *         giao dịch chốt — PGlite chỉ có một kết nối, `audit()` giữa giao dịch là khoá chết.
 *       · `DEFERRED` — cổng gọi TRƯỚC thân thao tác (server action có sẵn): lật `EXECUTED` ngay là để
 *         GIỮ CHỖ (hai lượt đồng thời vẫn chỉ một thắng), rồi `lib/approvals/execution.ts` thanh toán
 *         theo kết quả thật: xong ⇒ `confirmApprovalExecution` (phát `approval.executed` trong cùng
 *         giao dịch với lượt khẳng định `status = 'EXECUTED'`); `{ error }` hoặc ném ⇒
 *         `releaseApprovalExecution` trả về `APPROVED` + `execution_error`. Sự kiện KHÔNG phát lúc giữ
 *         chỗ: `domain_events` là append-only, một "đã thực hiện" cho việc rồi hỏng thì không rút lại được.
 *       · `IMMEDIATE` — không có ai thanh toán (lời gọi ngoài phạm vi `withApprovalExecution`): hành vi
 *         cũ — lật + phát sự kiện trong một giao dịch nhỏ.
 */

export type ApprovalUser = { id: string; email: string };

/** Cách một lượt tiêu thụ được "thanh toán" — xem điểm 4 ở đầu tệp. */
export type ApprovalSettlement = "IN_TRANSACTION" | "DEFERRED" | "IMMEDIATE";

/** Khoá chống trùng của `approval.executed`: một yêu cầu, một sự kiện — dù thanh toán theo đường nào. */
export function approvalExecutedDedupeKey(requestId: string): string {
  return `approval.executed:${requestId}`;
}

export type GuardOptions = {
  /** Cổng gọi TRƯỚC thân thao tác và nơi gọi SẼ thanh toán (`lib/approvals/execution.ts`). */
  deferSettlement?: boolean;
  /**
   * Nhận dòng nhật ký thay vì ghi ngay. BẮT BUỘC khi `db` là giao dịch đang mở: nơi gọi ghi chúng
   * (`audit()`) SAU khi giao dịch chốt.
   */
  auditSink?: AuditParams[];
};

export type GuardInput = {
  group: ApprovalGroup;
  action: string;
  summary: string;
  entity?: string;
  entityId?: string;
  /** Số tiền liên quan. `undefined` = chưa biết, và chưa biết thì coi như vượt ngưỡng. */
  amount?: number | null;
  payload?: unknown;
};

export type GuardResult = ApprovalDecision & {
  requestId?: string;
  /** `true` khi lần chạy này TIÊU THỤ một yêu cầu đã duyệt. */
  consumed?: boolean;
  /** Khi `consumed`: lượt tiêu thụ được thanh toán theo đường nào. */
  settlement?: ApprovalSettlement;
  /**
   * Khi `consumed`: câu `execution_error` mà lời duyệt mang TRƯỚC lượt tiêu thụ này (lần thực thi trước
   * không hoàn tất — Company OS · Agent N). Lượt tiêu thụ xoá cột đó, nên đây là chỗ duy nhất còn giữ nó;
   * cũng được ghi vào nhật ký `approval.execute:*`. `undefined` = lời duyệt sạch.
   */
  priorExecutionError?: string;
};

/** Dấu vân tay của MỘT việc: sha256 của JSON chuẩn hoá. Không chứa `summary` (chữ đổi được mà việc không đổi). */
export function approvalFingerprint(input: Pick<GuardInput, "group" | "action" | "entity" | "entityId" | "payload">): string {
  const chuoi = canonicalJson({ g: input.group, a: input.action, e: input.entity ?? "", i: input.entityId ?? "", p: input.payload ?? null });
  return createHash("sha256").update(chuoi).digest("hex");
}

/** Mốc mà lời duyệt được đưa ra TRƯỚC nó là đã quá hạn. */
export function approvalValidSince(now: Date): Date {
  return new Date(now.getTime() - APPROVAL_VALID_HOURS * 3_600_000);
}

/** Lời duyệt còn mở khoá được việc không — cùng luật với điều kiện tiêu thụ. */
export function approvalStillValid(req: { status: string; decidedAt: Date | null; executedAt: Date | null }, now: Date): boolean {
  return req.status === "APPROVED" && req.executedAt === null && req.decidedAt !== null && req.decidedAt.getTime() > approvalValidSince(now).getTime();
}

async function docSetting(db: DbOrTx, key: string): Promise<string | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value ?? null;
}

async function ghiSetting(db: Db, key: string, value: unknown) {
  const text = JSON.stringify(value);
  await db.insert(schema.settings).values({ key, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text, updatedAt: new Date() } });
}

/** Cấu hình cưỡng chế CÓ HIỆU LỰC — chỉ khoá v2 do công tắc ADMIN ghi. Xem `parseEnforceConfig`. */
export async function readEnforceConfig(db: DbOrTx): Promise<Record<string, unknown> | null> {
  return parseEnforceConfig(await docSetting(db, APPROVAL_ENFORCE_KEY));
}

/** Dòng CŨ `approval.enforce` (chỉ để hiện cho ADMIN) — `null` khi không có. KHÔNG quyết định cưỡng chế. */
export async function readLegacyEnforce(db: Db): Promise<{ raw: string; groups: ApprovalGroup[]; unknownKeys: string[] } | null> {
  const raw = await docSetting(db, APPROVAL_ENFORCE_LEGACY_KEY);
  if (raw === null) return null;
  const parsed = parseLegacyEnforceConfig(raw);
  return { raw, groups: parsed?.groups ?? [], unknownKeys: parsed ? parsed.unknownKeys : ["(không đọc được JSON)"] };
}

export type AdminUser = ApprovalUser & { isAdmin: boolean };

/**
 * Bật / tắt cưỡng chế MỘT nhóm — ghi hình dạng v2. CHỈ ADMIN (không phải `settings:manage`): bật là đổi
 * AI được làm việc một mình trong cả shop. Nhóm chưa nối không bật được.
 */
export async function setEnforceGroupCore(db: Db, user: AdminUser, group: ApprovalGroup, enforced: boolean): Promise<{ ok: true } | { error: string }> {
  if (!user.isAdmin) return { error: "Chỉ quản trị viên được bật / tắt cưỡng chế duyệt hai bước" };
  if (!APPROVAL_GROUPS_WIRED.includes(group)) return { error: `Nhóm "${APPROVAL_GROUP_LABEL[group]}" chưa nối vào thao tác nào — bật lên cũng không chặn được gì` };
  const truoc = (await readEnforceConfig(db)) ?? {};
  const sau: EnforceConfigV2 = { v: 2, groups: { ...(truoc as EnforceConfigV2["groups"]), [group]: enforced } };
  await ghiSetting(db, APPROVAL_ENFORCE_KEY, sau);
  await audit({
    userId: user.id,
    userEmail: user.email,
    actorKind: "USER",
    action: "approval.enforce",
    entity: "SETTINGS",
    entityId: APPROVAL_ENFORCE_KEY,
    before: { v: 2, groups: truoc },
    after: sau,
    reason: `${enforced ? "BẬT" : "TẮT"} cưỡng chế duyệt hai bước cho nhóm ${APPROVAL_GROUP_LABEL[group]}`,
  });
  return { ok: true };
}

/**
 * Nút "Áp dụng cấu hình này": chuyển dòng CŨ thành v2 và GHI ĐÈ cấu hình có hiệu lực bằng đúng nó.
 * Dòng cũ để nguyên (không xoá, không sửa) — nó là lời khai của một người, và nhật ký ghi trước/sau.
 */
export async function applyLegacyEnforceCore(db: Db, user: AdminUser): Promise<{ ok: true; applied: ApprovalGroup[]; ignored: string[] } | { error: string }> {
  if (!user.isAdmin) return { error: "Chỉ quản trị viên được áp dụng cấu hình cưỡng chế" };
  const legacy = await readLegacyEnforce(db);
  if (!legacy) return { error: "Không có cấu hình cưỡng chế cũ nào để áp dụng" };
  const { config, applied, ignored } = legacyToV2(legacy);
  const truoc = await readEnforceConfig(db);
  await ghiSetting(db, APPROVAL_ENFORCE_KEY, config);
  await audit({
    userId: user.id,
    userEmail: user.email,
    actorKind: "USER",
    action: "approval.enforce.apply-legacy",
    entity: "SETTINGS",
    entityId: APPROVAL_ENFORCE_KEY,
    before: truoc ? { v: 2, groups: truoc } : null,
    after: config,
    reason: `Áp dụng cấu hình cưỡng chế cũ (khoá ${APPROVAL_ENFORCE_LEGACY_KEY}): ${applied.map((g) => APPROVAL_GROUP_LABEL[g]).join(", ") || "không nhóm nào"}${ignored.length ? ` · bỏ qua: ${ignored.join(", ")}` : ""}`,
    detail: { legacyRaw: legacy.raw },
  });
  return { ok: true, applied, ignored };
}

/**
 * Có người nào KHÁC người xin đủ tư cách duyệt không.
 *
 * GIỮ NGUYÊN luật cũ (vai ADMIN / MANAGER đang hoạt động). Nó HẸP hơn tập người thật sự duyệt được
 * (`approvals:decide` còn gồm người có `settings:manage`), nên sai về phía CHẶN — một người như thế
 * tồn tại mà máy vẫn báo "không có người duyệt". Mở rộng phải tính quyền của mọi tài khoản bằng
 * `lib/auth/access.ts`; chưa làm ở bản này, nêu ở docs/company-os/handoff-g.md.
 */
async function coNguoiDuyetKhac(db: DbOrTx, requesterId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.users)
    .where(and(eq(schema.users.active, true), sql`${schema.users.id} <> ${requesterId}`, sql`${schema.users.role} in ('ADMIN','MANAGER')`));
  return Number(row?.n ?? 0) > 0;
}

/**
 * Ghi `EXPIRED` cho mọi lời duyệt ĐÃ QUÁ HẠN mà chưa dùng của người này trong nhóm này ("chạm thì
 * ghi"). Trả số dòng đã lật để còn ghi nhật ký.
 */
export async function expireStaleApprovals(db: DbOrTx, requesterId: string, group: ApprovalGroup, now: Date): Promise<string[]> {
  const a = schema.approvalRequests;
  const rows = await db
    .update(a)
    .set({ status: "EXPIRED" })
    .where(and(eq(a.status, "APPROVED"), eq(a.requestedBy, requesterId), eq(a.group, group), isNull(a.executedAt), sql`${a.decidedAt} <= ${approvalValidSince(now)}`))
    .returning({ id: a.id });
  return rows.map((r) => r.id);
}

/**
 * TIÊU THỤ một yêu cầu đã duyệt khớp đúng việc này. Trả id đã tiêu thụ, hoặc `null`.
 *
 * Đọc ứng viên trước rồi lật TỪNG cái bằng điều kiện `status = 'APPROVED'`: lượt nào lật hụt (một
 * lượt song song đã lấy mất) thì thử ứng viên kế tiếp, hết ứng viên thì trả `null`.
 */
export async function consumeApprovedRequest(
  db: DbOrTx,
  input: { requesterId: string; group: ApprovalGroup; action: string; fingerprint: string; now: Date },
  /** Nhận câu `execution_error` của lời duyệt vừa tiêu thụ (nếu có) — tuỳ chọn, không đổi kiểu trả về. */
  out?: { priorExecutionError?: string },
): Promise<string | null> {
  const a = schema.approvalRequests;
  const ungVien = await db
    .select({ id: a.id, executionError: a.executionError })
    .from(a)
    .where(
      and(
        eq(a.status, "APPROVED"),
        eq(a.requestedBy, input.requesterId),
        eq(a.group, input.group),
        eq(a.action, input.action),
        eq(a.payloadFingerprint, input.fingerprint),
        isNull(a.executedAt),
        sql`${a.decidedAt} > ${approvalValidSince(input.now)}`,
      ),
    )
    .orderBy(asc(a.decidedAt));
  for (const u of ungVien) {
    const [lat] = await db
      .update(a)
      .set({ status: "EXECUTED", executedAt: input.now, executionError: null })
      .where(and(eq(a.id, u.id), eq(a.status, "APPROVED")))
      .returning({ id: a.id });
    if (lat) {
      if (out && u.executionError) out.priorExecutionError = u.executionError;
      return lat.id;
    }
  }
  return null;
}

type ExecutedEvent = {
  requestId: string;
  /** Người THỰC HIỆN (= người xin — chỉ người xin tiêu thụ được lời duyệt của mình). */
  actorId: string;
  group: string;
  action: string;
  entity: string;
  entityId: string;
  summary: string;
  amount: number | null;
  settlement: ApprovalSettlement;
  now: Date;
};

/**
 * Phát `approval.executed` — trong giao dịch ĐANG MỞ của nơi gọi, cùng lượt ghi trạng thái. Khoá chống
 * trùng = id yêu cầu: một yêu cầu, một sự kiện, dù thanh toán theo đường nào và dù phát lại.
 */
async function emitApprovalExecuted(tx: DbOrTx, e: ExecutedEvent): Promise<string | null> {
  return emitDomainEvent(tx, {
    name: "approval.executed",
    subjectType: "approval_request",
    subjectId: e.requestId,
    modelId: null,
    payload: { group: e.group, action: e.action, entity: e.entity, entityId: e.entityId, summary: e.summary, amount: e.amount, settlement: e.settlement },
    actorKind: "USER",
    actorId: e.actorId,
    source: `approval:${e.action}`,
    correlationId: e.requestId,
    dedupeKey: approvalExecutedDedupeKey(e.requestId),
    occurredAt: e.now,
  });
}

/** Câu lỗi lưu vào `execution_error` — cắt ngắn, không để một stack trace dài chiếm dòng. */
function cauLoi(error: string): string {
  const t = error.trim() || "Thao tác hỏng mà không có câu lỗi";
  return t.length > 1000 ? `${t.slice(0, 1000)}…` : t;
}

/**
 * `DEFERRED` · thao tác ĐÃ XONG: khẳng định lượt tiêu thụ (vẫn `EXECUTED`, xoá câu lỗi cũ nếu có) và phát
 * `approval.executed` trong CÙNG giao dịch. Yêu cầu không còn ở `EXECUTED` (đã bị trả lại ở đâu đó) ⇒
 * không phát gì. Gọi lại ⇒ sự kiện trùng khoá, không ghi lần hai.
 */
export async function confirmApprovalExecution(db: Db, requestId: string, actor: ApprovalUser, now: Date = new Date()): Promise<{ confirmed: boolean; eventId: string | null }> {
  const a = schema.approvalRequests;
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(a)
      .set({ executionError: null })
      .where(and(eq(a.id, requestId), eq(a.status, "EXECUTED")))
      .returning({ group: a.group, action: a.action, entity: a.entity, entityId: a.entityId, summary: a.summary, amount: a.amount });
    if (!r) return { confirmed: false, eventId: null };
    const eventId = await emitApprovalExecuted(tx, { requestId, actorId: actor.id, ...r, settlement: "DEFERRED", now });
    return { confirmed: true, eventId };
  });
}

/**
 * `DEFERRED` · thao tác HỎNG (trả `{ error }` hoặc ném): trả lời duyệt về `APPROVED` (bỏ `executed_at`)
 * và ghi `execution_error` — người xin làm lại được mà không phải xin lại. Hàng rào: chỉ khi đang
 * `EXECUTED` VÀ chưa có `approval.executed` — một lượt đã khẳng định xong thì không bao giờ bị hồi sinh.
 * Hạn 72 giờ vẫn tính từ lúc DUYỆT, không từ lúc trả lại.
 */
export async function releaseApprovalExecution(db: Db, requestId: string, error: string, actor: ApprovalUser): Promise<boolean> {
  const a = schema.approvalRequests;
  const loi = cauLoi(error);
  const [r] = await db
    .update(a)
    .set({ status: "APPROVED", executedAt: null, executionError: loi })
    .where(
      and(
        eq(a.id, requestId),
        eq(a.status, "EXECUTED"),
        sql`not exists (select 1 from ${schema.domainEvents} where ${schema.domainEvents.dedupeKey} = ${approvalExecutedDedupeKey(requestId)})`,
      ),
    )
    .returning({ id: a.id, group: a.group, action: a.action });
  if (!r) return false;
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    actorKind: "USER",
    action: `approval.execute_failed:${r.action}`,
    entity: "APPROVAL_REQUEST",
    entityId: requestId,
    correlationId: requestId,
    reason: "Thao tác đã được duyệt nhưng KHÔNG chạy được — lời duyệt trả lại nguyên vẹn, làm lại không cần xin lại.",
    detail: { group: r.group, executionError: loi },
  });
  return true;
}

/**
 * `IN_TRANSACTION` · giao dịch nghiệp vụ đã ĐỔ (lượt lật cũng đã huỷ theo, lời duyệt vẫn `APPROVED`): chỉ
 * ghi lại câu lỗi để người xin / người duyệt thấy vì sao việc chưa xong. Không đổi trạng thái.
 */
export async function recordApprovalExecutionError(db: Db, requestId: string, error: string, actor: ApprovalUser): Promise<boolean> {
  const a = schema.approvalRequests;
  const loi = cauLoi(error);
  const [r] = await db
    .update(a)
    .set({ executionError: loi })
    .where(and(eq(a.id, requestId), eq(a.status, "APPROVED")))
    .returning({ id: a.id, group: a.group, action: a.action });
  if (!r) return false;
  await audit({
    userId: actor.id,
    userEmail: actor.email,
    actorKind: "USER",
    action: `approval.execute_failed:${r.action}`,
    entity: "APPROVAL_REQUEST",
    entityId: requestId,
    correlationId: requestId,
    reason: "Thao tác đã được duyệt nhưng giao dịch đổ — lượt tiêu thụ huỷ theo, lời duyệt còn nguyên.",
    detail: { group: r.group, executionError: loi },
  });
  return true;
}

/**
 * Hỏi cổng: việc này làm luôn được, hay phải chờ người thứ hai?
 *
 * Gọi TRƯỚC khi ghi dữ liệu. `PROCEED` thì cứ làm; hai mode còn lại thì dừng và trả thông điệp.
 * Khi cưỡng chế TẮT (mặc định) hành vi y hệt bản trước: làm luôn và để lại dòng `approval.skip:*`.
 *
 * `db` là giao dịch nghiệp vụ đang mở ⇒ tiêu thụ `IN_TRANSACTION` (bắt buộc kèm `auditSink`);
 * `opts.deferSettlement` ⇒ `DEFERRED`; còn lại ⇒ `IMMEDIATE`. Xem điểm 4 ở đầu tệp.
 */
export async function guardSecondApprovalCore(db: DbOrTx, user: ApprovalUser, input: GuardInput, now: Date = new Date(), opts: GuardOptions = {}): Promise<GuardResult> {
  const trongGiaoDich = isOpenTransaction(db);
  if (trongGiaoDich && !opts.auditSink) {
    throw new Error("guardSecondApprovalCore gọi TRONG giao dịch phải kèm auditSink — audit() giữa giao dịch là khoá chết trên PGlite (một kết nối)");
  }
  const ghi = async (p: AuditParams) => {
    if (opts.auditSink) opts.auditSink.push(p);
    else await audit(p);
  };
  const enforce = isEnforced(await readEnforceConfig(db), input.group);
  const vuotNguong = overThreshold(input.group, input.amount);

  // ── Chưa bật cưỡng chế, hoặc dưới ngưỡng: LÀM LUÔN nhưng vẫn để lại dấu vết ──
  //
  // Dấu vết này là thứ khiến ngày bật cưỡng chế lên không phải bắt đầu từ con số không: shop nhìn
  // được sáu tháng qua nhóm việc đó xảy ra bao nhiêu lần và do ai.
  if (!enforce || !vuotNguong) {
    await ghi({
      userId: user.id,
      userEmail: user.email,
      actorKind: "USER",
      action: `approval.skip:${input.action}`,
      entity: input.entity ?? "APPROVAL",
      entityId: input.entityId ?? "",
      detail: {
        group: input.group,
        summary: input.summary,
        amount: input.amount ?? null,
        lyDo: !enforce ? "nhóm chưa bật cưỡng chế" : "dưới ngưỡng",
      },
    });
    return { mode: "PROCEED", recorded: true, group: input.group };
  }

  const reason = APPROVAL_GROUP_REASON[input.group];
  const fingerprint = approvalFingerprint(input);

  // ── Lời duyệt quá hạn của chính người này, nhóm này: ghi EXPIRED ngay lúc chạm ──
  for (const id of await expireStaleApprovals(db, user.id, input.group, now)) {
    await ghi({
      userId: null,
      userEmail: "system:approval-expiry",
      actorKind: "SYSTEM",
      action: "approval.expire",
      entity: "APPROVAL_REQUEST",
      entityId: id,
      correlationId: id,
      reason: `Lời duyệt quá ${APPROVAL_VALID_HOURS} giờ mà chưa dùng — hết hiệu lực, phải xin lại.`,
      detail: { group: input.group },
    });
  }

  // ── Đã có lời duyệt còn hạn cho ĐÚNG việc này: tiêu thụ nó và làm ──
  //
  // Đứng TRƯỚC nhánh "không có người duyệt": lời duyệt đã có là do một người khác đưa ra; người đó
  // hôm nay nghỉ việc không làm lời duyệt hôm qua mất giá trị.
  const settlement: ApprovalSettlement = trongGiaoDich ? "IN_TRANSACTION" : opts.deferSettlement ? "DEFERRED" : "IMMEDIATE";
  const tieuThu = { requesterId: user.id, group: input.group, action: input.action, fingerprint, now };
  const phat = { actorId: user.id, group: input.group, action: input.action, entity: input.entity ?? "", entityId: input.entityId ?? "", summary: input.summary, amount: input.amount ?? null, now };
  let daTieuThu: string | null;
  const truoc: { priorExecutionError?: string } = {};
  if (isOpenTransaction(db)) {
    // Cùng giao dịch với thao tác ghi của nơi gọi: lật + sự kiện sống chết cùng nó.
    daTieuThu = await consumeApprovedRequest(db, tieuThu, truoc);
    if (daTieuThu) await emitApprovalExecuted(db, { ...phat, requestId: daTieuThu, settlement });
  } else if (settlement === "DEFERRED") {
    // GIỮ CHỖ: lật EXECUTED để lượt đồng thời không lấy được; sự kiện chờ kết quả thật của thao tác.
    daTieuThu = await consumeApprovedRequest(db, tieuThu, truoc);
  } else {
    daTieuThu = await db.transaction(async (tx) => {
      const id = await consumeApprovedRequest(tx, tieuThu, truoc);
      if (id) await emitApprovalExecuted(tx, { ...phat, requestId: id, settlement });
      return id;
    });
  }
  if (daTieuThu) {
    await ghi({
      userId: user.id,
      userEmail: user.email,
      actorKind: "USER",
      action: `approval.execute:${input.action}`,
      entity: "APPROVAL_REQUEST",
      entityId: daTieuThu,
      correlationId: daTieuThu,
      reason:
        settlement === "IMMEDIATE"
          ? "Thực hiện đúng việc đã được người thứ hai duyệt — lời duyệt đã dùng, lần sau phải xin lại."
          : "Thực hiện đúng việc đã được người thứ hai duyệt — thao tác hỏng thì lời duyệt được trả lại kèm câu lỗi (execution_error).",
      detail: { group: input.group, summary: input.summary, amount: input.amount ?? null, settlement, ...(truoc.priorExecutionError ? { priorExecutionError: truoc.priorExecutionError } : {}) },
    });
    return { mode: "PROCEED", recorded: true, group: input.group, requestId: daTieuThu, consumed: true, settlement, ...(truoc.priorExecutionError ? { priorExecutionError: truoc.priorExecutionError } : {}) };
  }

  // ── Cần duyệt nhưng KHÔNG CÓ AI để duyệt ──
  if (!(await coNguoiDuyetKhac(db, user.id))) {
    await ghi({
      userId: user.id,
      userEmail: user.email,
      actorKind: "USER",
      action: `approval.blocked:${input.action}`,
      entity: input.entity ?? "APPROVAL",
      entityId: input.entityId ?? "",
      detail: { group: input.group, summary: input.summary, lyDo: "không có người duyệt nào khác" },
    });
    return { mode: "BLOCKED_NO_APPROVER", group: input.group, reason };
  }

  // ── Đang có yêu cầu CHỜ cho đúng việc này: trả lại nó, KHÔNG đẻ yêu cầu thứ hai ──
  //
  // Chỉ mục duy nhất `approval_pending_fingerprint_uq` chặn cả hai lượt bấm đồng thời; chèn hụt thì
  // đọc lại dòng đang chờ.
  const a = schema.approvalRequests;
  const [moi] = await db
    .insert(a)
    .values({
      group: input.group,
      action: input.action,
      entity: input.entity ?? "",
      entityId: input.entityId ?? "",
      amount: input.amount ?? null,
      summary: input.summary,
      payload: (input.payload ?? null) as never,
      requestedBy: user.id,
      requestedByEmail: user.email,
      payloadFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: a.id });

  if (!moi) {
    const [dangCho] = await db
      .select({ id: a.id })
      .from(a)
      .where(and(eq(a.status, "PENDING"), eq(a.requestedBy, user.id), eq(a.group, input.group), eq(a.payloadFingerprint, fingerprint)))
      .limit(1);
    return { mode: "NEEDS_APPROVAL", group: input.group, reason, requestId: dangCho?.id };
  }

  await ghi({
    userId: user.id,
    userEmail: user.email,
    actorKind: "USER",
    action: `approval.request:${input.action}`,
    entity: "APPROVAL_REQUEST",
    entityId: moi.id,
    correlationId: moi.id,
    detail: { group: input.group, summary: input.summary, amount: input.amount ?? null },
  });
  return { mode: "NEEDS_APPROVAL", group: input.group, reason, requestId: moi.id };
}

/**
 * Duyệt / từ chối. `canDecide` do lớp gọi tính bằng quyền `approvals:decide` — lõi không đọc phiên.
 *
 * Lật trạng thái có điều kiện `status = 'PENDING'`: hai người cùng bấm thì chỉ một quyết định thắng,
 * không có chuyện người sau đè lên quyết định của người trước.
 */
export async function decideApprovalCore(
  db: Db,
  user: ApprovalUser & { canDecide: boolean },
  id: string,
  dongY: boolean,
  note: string | undefined,
  now: Date = new Date(),
): Promise<{ ok: true } | { error: string }> {
  if (!user.canDecide) return { error: "Không có quyền duyệt" };
  const a = schema.approvalRequests;
  const [req] = await db.select().from(a).where(eq(a.id, id));
  if (!req) return { error: "Không tìm thấy yêu cầu" };
  if (req.status !== "PENDING") return { error: `Yêu cầu đã ở trạng thái ${req.status}, không quyết lại được` };

  // LÝ DO TỒN TẠI CỦA CẢ CƠ CHẾ. Không có dòng này thì nó chỉ là một nút bấm thêm.
  if (req.requestedBy && req.requestedBy === user.id) return { error: "Người xin không được tự duyệt việc của mình" };
  if (!dongY && !note?.trim()) return { error: "Từ chối phải nêu lý do — người xin cần biết vì sao" };

  const lat = await db
    .update(a)
    .set({ status: dongY ? "APPROVED" : "REJECTED", decidedBy: user.id, decidedByEmail: user.email, decidedAt: now, note: note?.trim() || null })
    .where(and(eq(a.id, id), eq(a.status, "PENDING")))
    .returning({ id: a.id });
  if (!lat.length) return { error: "Yêu cầu vừa được người khác quyết — tải lại trang để xem kết quả" };

  await audit({
    userId: user.id,
    userEmail: user.email,
    actorKind: "USER",
    action: dongY ? "approval.approve" : "approval.reject",
    entity: "APPROVAL_REQUEST",
    entityId: id,
    correlationId: id,
    before: { status: "PENDING" },
    after: { status: dongY ? "APPROVED" : "REJECTED" },
    ...(note?.trim() ? { reason: note.trim() } : {}),
    detail: { group: req.group, summary: req.summary, requestedBy: req.requestedByEmail, note: note ?? null },
  });
  return { ok: true };
}
