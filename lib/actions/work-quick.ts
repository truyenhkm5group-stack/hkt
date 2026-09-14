"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { parseWorkKey } from "@/lib/constants/work";
import { WORK_ACTION, type WorkActionKey } from "@/lib/constants/work-actions";
import { addCareNote, setCareFollowUp, setCareOwner, setCareStatus } from "@/lib/actions/care-workbench";
import { csQuickAction } from "@/lib/actions/cs";
import { classifyBankTransactions } from "@/lib/actions/bank";
import { confirmReturnReceived } from "@/lib/actions/returns-warehouse";
import { addWorkNote, assignWork, blockWork, claimWork, setWorkPriority, setWorkStatus, snoozeWork } from "@/lib/actions/work";

/**
 * ═══════════ MỘT NÚT TRÊN HÀNG ĐỢI = MỘT HÀNH ĐỘNG MIỀN THẬT ═══════════
 *
 * Hàm này là chỗ duy nhất dịch "người bấm nút X trên hàng đợi" thành "gọi Server Action Y của
 * miền Z". Không có nhánh nào chỉ đánh dấu xong.
 *
 * VÌ SAO PHẢI ĐI VÒNG QUA ĐÂY thay vì gọi thẳng từ client: mỗi Server Action của miền có hình
 * dạng tham số riêng (`csQuickAction` nhận `{id, action}`, `setCareStatus` nhận `{shipmentIds[],
 * status}`, `classifyBankTransactions` nhận `{ids[], group}`). Nếu client tự dịch thì mỗi màn hình
 * lại dịch một kiểu, và một ngày nào đó có màn hình quên gọi hàm thật.
 *
 * Kiểm quyền KHÔNG nằm ở đây — nó nằm trong chính Server Action của miền. Đó là điểm mấu chốt:
 * hàng đợi không được là một cửa sau đi vòng qua kiểm quyền của miền. Người không có `cs:manage`
 * bấm "Hoàn thành" trên một case CSKH sẽ nhận đúng lỗi mà trang CSKH trả về.
 */

type Result = { ok: true; message?: string } | { error: string };

const schema = z.object({
  key: z.string().trim().min(3).max(300),
  action: z.string().trim().min(2).max(40),
  /** Tham số phụ tuỳ hành động: ghi chú, giờ hẹn, nhóm kế toán… */
  note: z.string().trim().max(2000).optional(),
  at: z.string().datetime().optional(),
  value: z.string().trim().max(100).optional(),
});

export async function runWorkAction(input: unknown): Promise<Result> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const { key, action, note, at, value } = parsed.data;
  const spec = WORK_ACTION[action as WorkActionKey];
  if (!spec) return { error: `Hành động không tồn tại: ${action}` };
  if (spec.mode === "LINK") return { error: "Hành động này chỉ mở đường dẫn, không ghi dữ liệu" };

  const parsedKey = parseWorkKey(key);
  if (!parsedKey) return { error: "Khoá việc không hợp lệ" };
  const { sourceKey } = parsedKey;

  // ─── Lớp công việc: giao / ghi chú / hoãn / hạn / ưu tiên / chặn / trạng thái việc tay ───
  if (spec.mode === "WORK") {
    switch (action as WorkActionKey) {
      case "WORK_CLAIM":
        return claimWork(key);
      case "WORK_NOTE":
        return addWorkNote({ key, note });
      case "WORK_SNOOZE":
        return snoozeWork({ key, until: at ?? null });
      case "WORK_BLOCK":
        return blockWork({ key, reason: note ?? "" });
      case "WORK_PRIORITY":
        return setWorkPriority({ key, priority: value || null });
      case "WORK_STATUS":
        return setWorkStatus({ key, status: value, blockedReason: note });
      case "WORK_ASSIGN":
        return assignWork({ key, assigneeId: value || null });
      default:
        return { error: `Hành động lớp công việc chưa nối: ${action}` };
    }
  }

  // ─── Hành động miền: gọi ĐÚNG Server Action của module sở hữu sự việc ───
  switch (action as WorkActionKey) {
    case "CS_CLAIM":
      return normalize(await csQuickAction({ id: sourceKey, action: "CLAIM" }));
    case "CS_CONTACTED":
      return normalize(await csQuickAction({ id: sourceKey, action: "CONTACTED", note }));
    case "CS_DONE":
      return normalize(await csQuickAction({ id: sourceKey, action: "DONE", note }));
    case "CS_SNOOZE":
      return normalize(await csQuickAction({ id: sourceKey, action: "SNOOZE", followUpAt: at }));

    case "CARE_NOTE":
      return normalize(await addCareNote({ shipmentId: sourceKey, note: note ?? "", kind: "OTHER" }));
    case "CARE_FOLLOW_UP":
      return normalize(await setCareFollowUp({ shipmentId: sourceKey, at: at ?? null, waitingFor: "WAITING_CUSTOMER" }));
    case "CARE_OWNER":
      return normalize(await setCareOwner({ shipmentIds: [sourceKey], ownerId: value || null }));
    case "CARE_RESOLVE":
      /*
        ĐÓNG CA CARE — KHÔNG ĐỔI TRẠNG THÁI ĐVVC.
        `setCareStatus` chỉ ghi `shipment_care.care_status`. Chứng từ Viettel Post (`shipments.stage`)
        không bị đụng tới, đúng luật hai chiều riêng của `lib/constants/care.ts`.
      */
      return normalize(await setCareStatus({ shipmentIds: [sourceKey], status: "RESOLVED", note: note ?? "" }));

    case "BANK_CLASSIFY":
      if (!value) return { error: "Chọn nhóm kế toán trước" };
      return normalize(await classifyBankTransactions({ ids: [sourceKey], group: value, note }));

    case "RETURN_RECEIVE":
      return normalize(await confirmReturnReceived({ ids: [sourceKey], note }));

    default:
      return { error: `Hành động miền chưa nối: ${action}` };
  }
}

/** Mọi Server Action của miền trả `{ok}` hoặc `{error}`; gộp về một hình dạng cho client. */
function normalize(res: unknown): Result {
  if (res && typeof res === "object" && "error" in res) {
    const e = (res as { error: unknown }).error;
    return { error: typeof e === "string" ? e : "Không thực hiện được" };
  }
  return { ok: true };
}
