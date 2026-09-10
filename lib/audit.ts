import { getDb, schema } from "@/db";
import { clearMemo, dangTrongJobNen, staleMemo } from "@/lib/cache";

/**
 * ───────────── NHẬT KÝ TRUY VẾT ─────────────
 *
 * Một dòng nhật ký chỉ có ích khi trả lời được đủ SÁU câu: AI làm · làm GÌ · trên CÁI GÌ ·
 * TRƯỚC ra sao · SAU ra sao · VÌ SAO. Thiếu "trước/sau" thì khi số liệu lệch không ai lần ngược
 * được, mà đó chính là lúc cần nhật ký nhất.
 *
 * `correlationId` nối các thay đổi cùng thuộc MỘT lần chạy (một lần nhập bảng kê, một lần dựng lại
 * lịch sử, một gói tin webhook được xử lý lại) — không có nó thì 300 dòng nhật ký của một lần chạy
 * trông y hệt 300 lần sửa tay rời rạc.
 *
 * KHÔNG BAO GIỜ ghi bí mật vào nhật ký. `redactSecrets()` che token/mật khẩu/webhook trước khi ghi;
 * kho mã này là PUBLIC nên một lần lộ là lộ vĩnh viễn.
 */

/** Tên trường mang bí mật — che giá trị, giữ lại việc "có" hay "không" để còn chẩn đoán được. */
const SECRET_KEYS = /(token|secret|password|passwd|pwd|api[_-]?key|authorization|webhook|cookie|credential)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactSecrets(v, depth + 1));
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) out[key] = v ? "***" : "";
    else out[key] = redactSecrets(v, depth + 1);
  }
  return out;
}

export type AuditParams = {
  userId?: string | null;
  /** AI làm: email người dùng, hoặc `job:<tên>` / `script:<tên>` cho luồng tự động. */
  userEmail: string;
  action: string;
  entity: string;
  entityId?: string;
  /** Giá trị TRƯỚC khi đổi — thiếu nó thì không lần ngược được. */
  before?: unknown;
  /** Giá trị SAU khi đổi. */
  after?: unknown;
  /** VÌ SAO: quy tắc nào, ai yêu cầu, chứng từ nào. */
  reason?: string;
  /** Nối các thay đổi cùng một lần chạy / một gói tin. */
  correlationId?: string;
  /** Dữ liệu bổ sung tự do (vẫn được che bí mật). */
  detail?: unknown;
};

export async function audit(params: AuditParams) {
  // Mọi thao tác ghi đều được ghi nhật ký → làm mới cache báo cáo. NHƯNG mức độ tuỳ ai ghi:
  //
  //  · NGƯỜI bấm lưu  → xoá hẳn. Họ vừa chủ động đổi và phải thấy đúng số mới; chờ là chấp nhận được.
  //  · JOB NỀN ghi     → đánh dấu cũ. Không ai ngồi chờ job, nhưng có người đang mở trang — bắt họ
  //    trả giá dựng lại toàn bộ chỉ vì bộ đồng bộ vừa chạy là lý do trang chủ mất 73–88 giây
  //    (`landing-sheet` chạy MỖI PHÚT, nên đệm bị san phẳng liên tục).
  if (dangTrongJobNen()) staleMemo();
  else clearMemo();
  try {
    const db = await getDb();
    const structured =
      params.before !== undefined || params.after !== undefined || params.reason !== undefined || params.correlationId !== undefined
        ? {
            ...(params.detail && typeof params.detail === "object" ? (params.detail as Record<string, unknown>) : params.detail !== undefined ? { detail: params.detail } : {}),
            ...(params.before !== undefined ? { before: params.before } : {}),
            ...(params.after !== undefined ? { after: params.after } : {}),
            ...(params.reason !== undefined ? { reason: params.reason } : {}),
            ...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
          }
        : params.detail;
    await db.insert(schema.auditLogs).values({
      userId: params.userId ?? null,
      userEmail: params.userEmail,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? "",
      detail: (redactSecrets(structured) as object) ?? null,
    });
  } catch {
    // không chặn nghiệp vụ vì lỗi ghi log
  }
}
