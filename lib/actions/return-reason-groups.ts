"use server";

/**
 * ═══════════ CHỈNH CÁCH XẾP NHÓM LÝ DO HOÀN ═══════════
 *
 * Xếp lý do vào nhóm là một QUYẾT ĐỊNH KINH DOANH: "Khách đi vắng" thuộc nhóm *giao lâu* hay
 * *boom hàng* đổi theo cách shop nhìn, và nó sẽ đổi.
 *
 * Đường ghi này CHỈ chạm vào một dòng `settings`. Không một dòng `shipment_return_reasons` nào bị
 * viết lại — quan sát (lý do chi tiết + chữ gốc của ĐVVC) là sự thật, cách xếp nhóm là cách nhìn,
 * và chỉ cái thứ hai được phép đổi.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { RETURN_REASONS, RETURN_REASON_GROUPS } from "@/lib/constants/return-reason";
import { canRegroup, sanitizeReasonGroups } from "@/lib/constants/return-reason-mapping";
import { getReasonGroupOverrides, saveReasonGroupOverrides } from "@/lib/queries/return-reason-config";

const input = z.object({
  reason: z.enum(RETURN_REASONS),
  /** `null` = trả về mặc định trong mã, không phải xoá lý do. */
  group: z.enum(RETURN_REASON_GROUPS).nullable(),
});

export async function setReasonGroup(raw: unknown): Promise<{ ok: true } | { error: string }> {
  const user = await requireUser();
  if (!can(user, "work:admin")) return { error: "Không đủ quyền đổi cách xếp nhóm lý do" };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { reason, group } = parsed.data;

  /*
    HAI LÝ DO BỊ GHIM, chặn ở đây LẪN trong `sanitizeReasonGroups`.

    `UNKNOWN` là chỗ TRỐNG, `OTHER` là "có chứng từ nhưng không khớp danh mục". Kéo chúng sang một
    nhóm quy lỗi biến một lỗ hổng dữ liệu thành một lời buộc tội — 299 kiện chưa ai hỏi sẽ nằm
    trong cột "Chất lượng kém" và trông y hệt 299 ca đã có người gọi khách xác minh. Đây là luật
    mà `tests/kpi-clarity.test.ts` đã khoá ở phía máy suy chữ; chặn ở đây là bịt đường vòng.
  */
  if (group) {
    const duoc = canRegroup(reason, group);
    if (!duoc.ok) return { error: duoc.reason ?? "Không đổi nhóm cho lý do này được" };
  }

  const truoc = await getReasonGroupOverrides();
  const sau = { ...truoc };
  if (group === null) delete sau[reason];
  else sau[reason] = group;
  const sach = sanitizeReasonGroups(sau);
  await saveReasonGroupOverrides(sach);

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "RETURN_REASON_GROUP_SET",
    entity: "SETTING",
    entityId: `returns.reason-groups:${reason}`,
    before: { group: truoc[reason] ?? null },
    after: { group: sach[reason] ?? null },
    reason: "Đổi cách xếp nhóm lý do hoàn — KHÔNG sửa một dòng lịch sử nào",
  });

  revalidatePath("/reports/returns");
  revalidatePath("/work/settings");
  return { ok: true };
}
