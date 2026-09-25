import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import {
  APPROVAL_ENFORCE_KEY,
  APPROVAL_GROUP_REASON,
  APPROVAL_VALID_HOURS,
  canonicalJson,
  isEnforced,
  overThreshold,
  parseEnforceConfig,
  type ApprovalDecision,
  type ApprovalGroup,
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
 *
 * Không phát sự kiện `approval.executed` ở đây: tên đó đang RESERVED trong sổ sự kiện của Agent A.
 */

export type ApprovalUser = { id: string; email: string };

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

/** Cấu hình cưỡng chế theo nhóm — đã PARSE (cột `settings.value` là TEXT). Xem `parseEnforceConfig`. */
export async function readEnforceConfig(db: Db): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, APPROVAL_ENFORCE_KEY));
  return parseEnforceConfig(row?.value ?? null);
}

/**
 * Có người nào KHÁC người xin đủ tư cách duyệt không.
 *
 * GIỮ NGUYÊN luật cũ (vai ADMIN / MANAGER đang hoạt động). Nó HẸP hơn tập người thật sự duyệt được
 * (`approvals:decide` còn gồm người có `settings:manage`), nên sai về phía CHẶN — một người như thế
 * tồn tại mà máy vẫn báo "không có người duyệt". Mở rộng phải tính quyền của mọi tài khoản bằng
 * `lib/auth/access.ts`; chưa làm ở bản này, nêu ở docs/company-os/handoff-g.md.
 */
async function coNguoiDuyetKhac(db: Db, requesterId: string): Promise<boolean> {
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
export async function expireStaleApprovals(db: Db, requesterId: string, group: ApprovalGroup, now: Date): Promise<string[]> {
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
  db: Db,
  input: { requesterId: string; group: ApprovalGroup; action: string; fingerprint: string; now: Date },
): Promise<string | null> {
  const a = schema.approvalRequests;
  const ungVien = await db
    .select({ id: a.id })
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
      .set({ status: "EXECUTED", executedAt: input.now })
      .where(and(eq(a.id, u.id), eq(a.status, "APPROVED")))
      .returning({ id: a.id });
    if (lat) return lat.id;
  }
  return null;
}

/**
 * Hỏi cổng: việc này làm luôn được, hay phải chờ người thứ hai?
 *
 * Gọi TRƯỚC khi ghi dữ liệu. `PROCEED` thì cứ làm; hai mode còn lại thì dừng và trả thông điệp.
 * Khi cưỡng chế TẮT (mặc định) hành vi y hệt bản trước: làm luôn và để lại dòng `approval.skip:*`.
 */
export async function guardSecondApprovalCore(db: Db, user: ApprovalUser, input: GuardInput, now: Date = new Date()): Promise<GuardResult> {
  const enforce = isEnforced(await readEnforceConfig(db), input.group);
  const vuotNguong = overThreshold(input.group, input.amount);

  // ── Chưa bật cưỡng chế, hoặc dưới ngưỡng: LÀM LUÔN nhưng vẫn để lại dấu vết ──
  //
  // Dấu vết này là thứ khiến ngày bật cưỡng chế lên không phải bắt đầu từ con số không: shop nhìn
  // được sáu tháng qua nhóm việc đó xảy ra bao nhiêu lần và do ai.
  if (!enforce || !vuotNguong) {
    await audit({
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
    await audit({
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
  const daTieuThu = await consumeApprovedRequest(db, { requesterId: user.id, group: input.group, action: input.action, fingerprint, now });
  if (daTieuThu) {
    await audit({
      userId: user.id,
      userEmail: user.email,
      actorKind: "USER",
      action: `approval.execute:${input.action}`,
      entity: "APPROVAL_REQUEST",
      entityId: daTieuThu,
      correlationId: daTieuThu,
      reason: "Thực hiện đúng việc đã được người thứ hai duyệt — lời duyệt đã dùng, lần sau phải xin lại.",
      detail: { group: input.group, summary: input.summary, amount: input.amount ?? null },
    });
    return { mode: "PROCEED", recorded: true, group: input.group, requestId: daTieuThu, consumed: true };
  }

  // ── Cần duyệt nhưng KHÔNG CÓ AI để duyệt ──
  if (!(await coNguoiDuyetKhac(db, user.id))) {
    await audit({
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

  await audit({
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
