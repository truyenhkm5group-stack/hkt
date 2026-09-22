"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { DEFAULT_SIZE_RULES, SIZE_RULES_KEY, type SizeRule } from "@/lib/constants/size-engine";

export type AssignResult = { ok: true; chartLabel: string } | { error: string };

const schemaIn = z.object({
  /** Mã hàng của shop ("Q006"), KHÔNG phải id nội bộ — xem ghi chú ở `SizeLookup.productCode`. */
  productCode: z.string().trim().min(1, "Thiếu mã hàng"),
  /** `version` của bảng, hoặc chuỗi rỗng để BỎ GÁN. */
  chartVersion: z.string().trim(),
});

/**
 * GÁN MỘT MÃ HÀNG CHO MỘT BẢNG SỐ ĐO — đường ghi DUY NHẤT vào phần `keys` của `ai.sizeRules`.
 *
 * ─── VÌ SAO GHI CẢ LƯỢT, KHÔNG SỬA MỘT Ô ───
 *
 * Một mã hàng chỉ được thuộc ĐÚNG MỘT bảng. Nếu chỉ thêm mã vào bảng mới mà không gỡ khỏi bảng cũ
 * thì `resolveSizeRule` thấy hai bảng cùng khớp, lấy bảng có phạm vi hẹp hơn — và khi hai bảng
 * cùng phạm vi `PRODUCT` thì thứ tự quyết định là thứ tự chúng nằm trong mảng. Một quyết định về
 * size phụ thuộc vào thứ tự phần tử trong một tệp JSON là thứ không ai gỡ ra nổi về sau.
 *
 * Nên lượt ghi này GỠ mã khỏi mọi bảng trước, rồi mới thêm vào đúng một bảng.
 *
 * ─── BỎ GÁN LÀ MỘT LỰA CHỌN HỢP LỆ ───
 *
 * `chartVersion` rỗng ⇒ mã hàng không thuộc bảng nào ⇒ máy trả `SIZE_DATA_MISSING` và chuyển
 * người. Đó KHÔNG phải một trạng thái hỏng: mẫu hàng mới chưa đo size thì để người tư vấn vẫn
 * đúng hơn là áp bừa bảng của một mẫu khác.
 */
export async function assignSizeChart(input: z.infer<typeof schemaIn>): Promise<AssignResult> {
  const user = await requireUser();
  // `ai:manage` chứ không phải `ai:view`: đây là đường đổi cách máy tư vấn size cho khách thật,
  // không phải một màn hình đọc.
  if (!can(user, "ai:manage")) return { error: "Bạn không có quyền đổi cấu hình nhân sự AI" };

  const parsed = schemaIn.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { productCode, chartVersion } = parsed.data;

  const db = await getDb();
  const product = await db.query.products.findFirst({
    where: eq(schema.products.customId, productCode),
    columns: { id: true, name: true, customId: true },
  });
  // Gán cho một mã không tồn tại thì dòng khai ấy sẽ nằm im mãi mãi và không bao giờ khớp gì —
  // đúng kiểu hỏng không có triệu chứng. Chặn ngay ở đây.
  if (!product) return { error: `Không có mã hàng "${productCode}" trong ERP` };

  const stored = await getSettingJson<{ version: string; rules: SizeRule[] }>(SIZE_RULES_KEY, DEFAULT_SIZE_RULES);
  const rules = Array.isArray(stored.rules) ? stored.rules.map((r) => ({ ...r })) : [];
  if (!rules.length) return { error: "Chưa nạp bảng số đo nào — chạy ops ai-staging-size-rules trước" };

  const target = chartVersion ? rules.find((r) => r.version === chartVersion) : null;
  if (chartVersion && !target) return { error: `Không có bảng số đo "${chartVersion}"` };

  const norm = productCode.toLowerCase();
  const truoc = rules.find((r) => [r.key ?? "", ...(r.keys ?? [])].some((k) => k.trim().toLowerCase() === norm));

  for (const r of rules) {
    // Gỡ khỏi MỌI bảng — cả `keys` mới lẫn `key` cũ, nếu không một bảng khai theo lối cũ sẽ vẫn
    // âm thầm khớp sau khi người dùng tưởng đã chuyển sang bảng khác.
    r.keys = (r.keys ?? []).filter((k) => k.trim().toLowerCase() !== norm);
    if ((r.key ?? "").trim().toLowerCase() === norm) r.key = "";
  }
  if (target) {
    const t = rules.find((r) => r.version === target.version)!;
    t.keys = [...(t.keys ?? []), product.customId ?? productCode];
  }

  await setSettingJson(SIZE_RULES_KEY, { ...stored, rules });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: chartVersion ? "size_chart.assign" : "size_chart.unassign",
    entity: "product",
    entityId: product.id,
    before: { chart: truoc?.version ?? null },
    after: { chart: chartVersion || null },
    reason: `Gán bảng số đo cho mã hàng ${productCode}`,
  });

  revalidatePath("/ai/size-rules");
  return { ok: true, chartLabel: target?.label || target?.version || "chưa gán bảng nào" };
}
