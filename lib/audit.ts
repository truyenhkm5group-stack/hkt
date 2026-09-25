import { getDb, schema } from "@/db";
import { clearMemo, dangTrongJobNen, staleMemo } from "@/lib/cache";
import type { AuditActorKind } from "@/lib/constants/audit-actor";

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
  /**
   * AI LÀM — người hay máy. Bỏ trống thì suy (xem `inferActorKind`): có `userId` ⇒ `USER`; đang
   * chạy trong job nền ⇒ `SYSTEM`; `userEmail` dạng `job:` / `script:` ⇒ `SYSTEM`; còn lại `NULL`
   * (CHƯA BIẾT — không đoán thành "người dùng").
   */
  actorKind?: AuditActorKind;
  /** Dữ liệu bổ sung tự do (vẫn được che bí mật). */
  detail?: unknown;
};

/**
 * NHỮNG VIỆC CÓ GHI NHẬT KÝ NHƯNG KHÔNG ĐỔI MỘT CON SỐ KINH DOANH NÀO.
 *
 * SỰ CỐ THẬT (10/09/2026). `audit()` xoá sạch đệm báo cáo sau MỌI thao tác ghi — kể cả ĐĂNG NHẬP.
 * Smoke đăng nhập lại trước mỗi màn hình (để tránh hết hạn JWT), nên nó xoá đệm 25 lần trong một
 * lượt chạy và trang chủ LUÔN rơi vào lượt tính nguội 60–95 giây.
 *
 * Đó không chỉ là chuyện của smoke: mỗi lần bất kỳ ai đăng nhập, toàn bộ đệm báo cáo của cả hệ
 * thống bị san phẳng. Đăng nhập không đổi doanh thu, không đổi tồn kho, không đổi lợi nhuận.
 *
 * Danh sách này cố ý HẸP: chỉ những việc chắc chắn không chạm dữ liệu nghiệp vụ. Nghi ngờ thì để
 * ngoài — xoá đệm thừa chỉ tốn thời gian, còn bỏ sót thì trình bày số cũ như số mới.
 */
/*
  Company OS · Agent H: `RECOMMENDATION_DECIDED` là phản ứng của người đọc với một ĐỀ XUẤT (chấp nhận /
  bỏ qua / nhắc lại sau). Nó không chạm một bảng nghiệp vụ nào và không đổi một con số nào; hàng đợi
  "Cần anh quyết" đọc sổ phản ứng thẳng, không qua đệm. Để ngoài danh sách thì MỖI cú bấm trên trang chủ
  xoá sạch đệm báo cáo — và lượt mở trang chủ kế tiếp phải tính lại bảng quyết định quảng cáo (~6 giây nguội).
*/
const KHONG_DOI_SO_LIEU = new Set(["LOGIN", "LOGOUT", "RECOMMENDATION_DECIDED"]);

/**
 * Loại tác nhân cho cột `audit_logs.actor_kind` (Company OS · Agent G).
 *
 * Thứ tự: khai tường minh → có `userId` (`USER`) → đang trong job nền (`SYSTEM`) → email theo quy
 * ước `job:` / `script:` (`SYSTEM`) → `null`.
 *
 * VÌ SAO `userId` ĐỨNG TRƯỚC cờ job nền: `dangTrongJobNen()` là một bộ đếm TOÀN CỤC của tiến trình
 * (lib/cache.ts), không phải ngữ cảnh của riêng lượt gọi. Trong lúc `dashboard-warm` chạy 60 giây,
 * MỌI thao tác của người dùng cùng tiến trình cũng thấy cờ bật. Với đệm thì sai sót đó vô hại (xoá
 * mềm thay vì cứng); với quy kết thì nó biến việc của người thành việc của máy. Job nền trong kho
 * này ghi nhật ký với `userId = null`, nên đặt `userId` trước không làm mất nhãn `SYSTEM` của chúng.
 *
 * Không có nhánh "mặc định USER": một dòng không biết ai làm mà in là người dùng thì thẻ điểm người
 * sẽ đếm việc của máy (AGENTS.md mục 36). `null` = CHƯA BIẾT.
 */
export function inferActorKind(params: Pick<AuditParams, "actorKind" | "userId" | "userEmail">, inJob: boolean): AuditActorKind | null {
  if (params.actorKind) return params.actorKind;
  if (params.userId) return "USER";
  if (inJob) return "SYSTEM";
  if (/^(job|script):/i.test(params.userEmail ?? "")) return "SYSTEM";
  return null;
}

export async function audit(params: AuditParams) {
  // Mọi thao tác ghi đều được ghi nhật ký → làm mới cache báo cáo. NHƯNG mức độ tuỳ ai ghi:
  //
  //  · NGƯỜI bấm lưu  → xoá hẳn. Họ vừa chủ động đổi và phải thấy đúng số mới; chờ là chấp nhận được.
  //  · JOB NỀN ghi     → đánh dấu cũ. Không ai ngồi chờ job, nhưng có người đang mở trang — bắt họ
  //    trả giá dựng lại toàn bộ chỉ vì bộ đồng bộ vừa chạy là lý do trang chủ mất 73–88 giây
  //    (`landing-sheet` chạy MỖI PHÚT, nên đệm bị san phẳng liên tục).
  if (KHONG_DOI_SO_LIEU.has(params.action)) {
    // Không làm gì: xem KHONG_DOI_SO_LIEU.
  } else if (dangTrongJobNen()) staleMemo();
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
      actorKind: inferActorKind(params, dangTrongJobNen()),
      correlationId: params.correlationId?.slice(0, 200) ?? null,
      // Lý do là chữ người gõ — vẫn đi qua bộ che bí mật như mọi thứ khác, và bị cắt độ dài.
      reason: params.reason !== undefined ? String(redactSecrets(params.reason)).slice(0, 2000) : null,
    });
  } catch (error) {
    /*
      KHÔNG CHẶN NGHIỆP VỤ vì lỗi ghi nhật ký — nhưng cũng KHÔNG NUỐT IM LẶNG nữa. Bản cũ `catch {}`
      nên một ràng buộc CSDL hỏng làm nhật ký ngừng ghi mà không ai biết, đúng lúc cần nó nhất.
      In ra log máy chủ (không kèm `detail`: có thể mang dữ liệu khách).
    */
    console.error(`[audit] ghi nhật ký hỏng — ${params.action} · ${params.entity}:${params.entityId ?? ""}:`, error instanceof Error ? error.message : error);
  }
}
