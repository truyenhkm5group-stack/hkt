import type { SessionUser } from "@/lib/auth/session";
import { csQuickAction, updateCsCaseQuick } from "@/lib/actions/cs";
import { setCareOwner } from "@/lib/actions/care-workbench";
import { parseWorkKey } from "@/lib/constants/work";
import { assigneeAuthorityOf, isWorkSource, WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import * as svc from "@/lib/work/service";

/**
 * ═══════════ GIAO / NHẬN VIỆC: MỘT CỬA, DẪN VỀ ĐÚNG NƠI GIỮ NGƯỜI PHỤ TRÁCH ═══════════
 *
 * Mọi nút "Nhận việc" / "Giao cho" / phân việc hàng loạt / phân việc tự động đi qua đây, và đây
 * là nơi DUY NHẤT quyết định người phụ trách được ghi ở đâu:
 *
 *  · Nguồn mà bảng nghiệp vụ giữ người phụ trách (`assigneeAuthority = "SOURCE"`: case CSKH,
 *    care vận đơn) ⇒ gọi ĐÚNG Server Action của miền đó. Miền kiểm quyền của miền (`cs:manage`,
 *    `shipments:view`), ghi lịch sử của miền (`cs_case_events`, `care_case_events`). Hàng đợi
 *    không được là cửa sau đi vòng qua hai thứ đó.
 *  · Nguồn còn lại ⇒ `lib/work/service.ts::assignWork` (lớp ghi chú `work_items`).
 *
 * `lib/work/service.ts` TỪ CHỐI nguồn `SOURCE` — nên một nơi gọi mới quên đi qua đây sẽ nhận lỗi
 * rõ ràng, không lặng lẽ tạo ra sự thật thứ hai. `tests/work-os.test.ts` khoá cả hai chiều.
 *
 * Tệp này KHÔNG phải Server Action (không `"use server"`): nó là bộ dẫn đường được các Server
 * Action gọi, và nó cố ý không kiểm quyền — quyền nằm ở đích đến.
 */
export type AssignRouteResult = { ok: true } | { error: string };

export async function assignByAuthority(key: string, assigneeId: string | null, user: SessionUser, opts: { claim?: boolean } = {}): Promise<AssignRouteResult> {
  const parsed = parseWorkKey(key);
  if (!parsed) return { error: "Khoá việc không hợp lệ" };
  if (!isWorkSource(parsed.sourceType)) return { error: `Nguồn việc không tồn tại: ${parsed.sourceType}` };
  const source = parsed.sourceType as WorkSource;

  if (assigneeAuthorityOf(source) === "WORK") {
    const r = await svc.assignWork(key, assigneeId, { id: user.id, email: user.email, name: user.name, source: "UI" });
    return "error" in r ? r : { ok: true };
  }

  switch (source) {
    case "CS_CASE": {
      // Nhận việc = đúng ý định "CLAIM" của trang CSKH (gán mình + chuyển Đang xử lý); giao cho
      // người khác = ô Phụ trách của trang CSKH. Không tự ghép trường.
      const r = opts.claim && assigneeId === user.id ? await csQuickAction({ id: parsed.sourceKey, action: "CLAIM" }) : await updateCsCaseQuick({ id: parsed.sourceKey, assigneeUserId: assigneeId });
      return "error" in r ? { error: r.error } : { ok: true };
    }
    case "SHIPMENT_CARE": {
      const r = await setCareOwner({ shipmentIds: [parsed.sourceKey], ownerId: assigneeId });
      if ("error" in r) return { error: r.error };
      const skipped = r.data.skipped[0];
      return skipped ? { error: skipped.reason } : { ok: true };
    }
    default:
      return { error: `${WORK_SOURCE_SPEC[source].label}: nguồn giữ người phụ trách nhưng chưa nối hành động giao việc` };
  }
}
