import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, type Db } from "@/db";
import { audit, type AuditParams } from "@/lib/audit";
import {
  confirmApprovalExecution,
  guardSecondApprovalCore,
  releaseApprovalExecution,
  type ApprovalUser,
  type GuardInput,
  type GuardResult,
} from "@/lib/approvals/service";
import type { DbTx } from "@/lib/db-transaction";

/**
 * ═══════ THANH TOÁN LƯỢT TIÊU THỤ LỜI DUYỆT THEO KẾT QUẢ THẬT (Company OS · Agent K) ═══════
 *
 * KHÔNG "use server" — và KHÔNG ĐƯỢC là server action: một hàm "trả lời duyệt về APPROVED" mở ra cho
 * trình duyệt gọi thẳng là cửa để dùng MỘT lời duyệt nhiều lần.
 *
 * Hai cách nơi gọi cổng chọn (xem điểm 4 ở đầu `lib/approvals/service.ts`):
 *
 *  · `withApprovalExecution(fn)` — bọc CẢ THÂN server action. Cổng (`guardSecondApproval`) gọi bên trong
 *    thấy phạm vi này qua `AsyncLocalStorage`, tiêu thụ kiểu GIỮ CHỖ (`DEFERRED`) và ghi id vào phạm vi;
 *    thân action chạy xong thì: trả `{ error }` hoặc ném ⇒ trả lời duyệt về `APPROVED` + `execution_error`;
 *    còn lại ⇒ khẳng định + phát `approval.executed`. Dùng cho mọi action có sẵn gọi cổng TRƯỚC thân.
 *  · `guardInTransaction(tx, …)` — cổng gọi TRONG giao dịch nghiệp vụ (`IN_TRANSACTION`): lật + sự kiện
 *    cùng giao dịch với thao tác ghi; dòng nhật ký của cổng gom lại, ghi SAU khi giao dịch chốt
 *    (`flushApprovalAudits`). Dùng khi thân thao tác là MỘT giao dịch và cổng đặt được vào trong nó.
 *
 * Thanh toán hỏng (CSDL chập chờn) KHÔNG che kết quả của thao tác: ghi `console.error` và để yêu cầu ở
 * `EXECUTED` — phía an toàn (không hồi sinh một lời duyệt ngoài ý muốn).
 */

type Consumed = { requestId: string; user: ApprovalUser };
type Scope = { consumed: Consumed[] };

const scopeStore = new AsyncLocalStorage<Scope>();

/** Phạm vi thanh toán đang bao lời gọi hiện tại (nếu có). */
export function currentApprovalScope(): Scope | undefined {
  return scopeStore.getStore();
}

/** Câu lỗi nghiệp vụ trong kết quả của một action (`{ error: string }`), hoặc `null`. */
export function actionErrorOf(r: unknown): string | null {
  if (r && typeof r === "object" && "error" in r) {
    const e = (r as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return null;
}

/** `redirect()` / `notFound()` của Next ném lỗi mang `digest` — đó là THÀNH CÔNG, không phải hỏng. */
function laDieuHuongNext(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/.test(d);
}

async function thanhToan(db: Db, scope: Scope, loi: string | null): Promise<void> {
  for (const c of scope.consumed) {
    try {
      if (loi === null) await confirmApprovalExecution(db, c.requestId, c.user);
      else await releaseApprovalExecution(db, c.requestId, loi, c.user);
    } catch (e) {
      console.error(`[approval] không thanh toán được lượt tiêu thụ ${c.requestId}:`, e);
    }
  }
}

/**
 * Bọc thân một server action gọi cổng duyệt TRƯỚC thao tác ghi. Không có lượt tiêu thụ nào ⇒ không
 * làm gì thêm. Lời gọi lồng nhau: phạm vi TRONG CÙNG nhận lượt tiêu thụ của mình.
 */
export async function withApprovalExecution<R>(fn: () => Promise<R>, dbFactory: () => Promise<Db> = getDb): Promise<R> {
  const scope: Scope = { consumed: [] };
  let r: R;
  try {
    r = await scopeStore.run(scope, fn);
  } catch (e) {
    if (scope.consumed.length) {
      const db = await dbFactory();
      await thanhToan(db, scope, laDieuHuongNext(e) ? null : e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
  if (scope.consumed.length) await thanhToan(await dbFactory(), scope, actionErrorOf(r));
  return r;
}

/**
 * Cổng dùng trong server action (lõi của `guardSecondApproval`): trong phạm vi `withApprovalExecution`
 * ⇒ tiêu thụ GIỮ CHỖ và ghi vào phạm vi; ngoài phạm vi ⇒ `IMMEDIATE` như cũ.
 */
export async function guardWithinScope(db: Db, user: ApprovalUser, input: GuardInput, now: Date = new Date()): Promise<GuardResult> {
  const scope = currentApprovalScope();
  const kq = await guardSecondApprovalCore(db, user, input, now, { deferSettlement: !!scope });
  if (scope && kq.consumed && kq.requestId && kq.settlement === "DEFERRED") scope.consumed.push({ requestId: kq.requestId, user });
  return kq;
}

/**
 * Cổng gọi TRONG giao dịch nghiệp vụ. Trả kết quả cổng + các dòng nhật ký phải ghi SAU khi giao dịch chốt.
 * Giao dịch đổ ⇒ đừng ghi chúng (lượt tiêu thụ / yêu cầu mới trong đó cũng đã huỷ theo).
 */
export async function guardInTransaction(tx: DbTx, user: ApprovalUser, input: GuardInput, now: Date = new Date()): Promise<{ result: GuardResult; audits: AuditParams[] }> {
  const audits: AuditParams[] = [];
  const result = await guardSecondApprovalCore(tx, user, input, now, { auditSink: audits });
  return { result, audits };
}

/** Ghi các dòng nhật ký cổng đã gom — gọi SAU khi giao dịch đã chốt. */
export async function flushApprovalAudits(audits: readonly AuditParams[]): Promise<void> {
  for (const p of audits) await audit(p);
}
