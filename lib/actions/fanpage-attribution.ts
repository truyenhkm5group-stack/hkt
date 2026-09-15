"use server";

/**
 * Server Actions cho màn hình Marketing → Fanpage & quy kết.
 *
 * Quyền dùng lại `payroll:manage` — chính quyền mà kho mã này đã mô tả là "khai báo nhân sự & chia
 * mã, fanpage → marketer" (`lib/auth/permissions.ts`). Thêm một quyền thứ hai cho cùng một việc là
 * chia đôi một thẩm quyền và làm hai màn hình cho ra hai câu trả lời cho câu hỏi "ai được sửa".
 *
 * MỌI lượt ghi ở đây đều CHỈ đụng ba bảng quy kết. Không đường nào ghi vào `orders`, `shipments`,
 * `expenses` hay tồn kho.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { assignFanpageMarketer, revokeFanpageAssignment, runFanpageAttributionJob, setFanpageActive, setFanpageAlias } from "@/lib/attribution/fanpage";

export type ActionResult = { ok: true; id?: string; message?: string } | { error: string };

const PATHS = ["/marketing/fanpages", "/payroll", "/ads", "/reports"];
function revalidate() {
  for (const p of PATHS) revalidatePath(p);
}

const DENIED = "Chỉ người có quyền khai báo lương / marketer mới được sửa phân công fanpage";

const assignSchema = z.object({
  fanpageId: z.string().min(1, "Thiếu fanpage"),
  marketerId: z.string().min(1, "Chưa chọn marketer"),
  /** Ngày (giờ Việt Nam) bắt đầu hiệu lực. Người khai nhập NGÀY; máy quy về đầu ngày VN. */
  effectiveFrom: z.string().min(1, "Chưa chọn ngày hiệu lực"),
  note: z.string().max(300).optional(),
});

/** `YYYY-MM-DD` (giờ VN) → mốc UTC đầu ngày hôm đó. Cùng quy ước với `vnStartOfDay` của bộ lọc kỳ. */
function vnDayStart(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GÁN MARKETER KỂ TỪ MỘT NGÀY.
 *
 * Không có nút "đổi người" nào ghi đè dòng cũ — đổi người là ĐÓNG một khoảng và MỞ một khoảng. Đó
 * là toàn bộ lý do báo cáo tháng trước không đổi số khi shop chuyển fanpage sang người khác.
 */
export async function assignFanpage(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: DENIED };
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const from = vnDayStart(parsed.data.effectiveFrom);
  if (!from) return { error: "Ngày hiệu lực không hợp lệ" };

  const result = await assignFanpageMarketer({
    fanpageId: parsed.data.fanpageId,
    marketerId: parsed.data.marketerId,
    effectiveFrom: from,
    note: parsed.data.note,
    actorUserId: user.id,
  });
  if ("error" in result) return { error: result.error };

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `fanpage:${parsed.data.fanpageId}`,
    reason: `Gán marketer cho fanpage kể từ ${parsed.data.effectiveFrom}`,
    after: { assignmentId: result.assignmentId, marketerId: parsed.data.marketerId, effectiveFrom: from.toISOString() },
    detail: { closedAssignmentId: result.closedId },
  });
  revalidate();
  return { ok: true, id: result.assignmentId, message: "Đã gán. Chạy 'Đối soát lại' để áp cho các đơn liên quan." };
}

/** Thu hồi một dòng khai sai. Tắt chứ không xoá — đơn đã quy kết bằng nó còn trỏ tới nó. */
export async function revokeAssignment(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: DENIED };
  const parsed = z.object({ assignmentId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { error: "Thiếu mã phân công" };
  const result = await revokeFanpageAssignment(parsed.data.assignmentId);
  if ("error" in result) return { error: result.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `fanpage-assignment:${parsed.data.assignmentId}`,
    reason: "Thu hồi một phân công fanpage khai sai",
  });
  revalidate();
  return { ok: true, message: "Đã thu hồi. Chạy 'Đối soát lại' để tính lại các đơn liên quan." };
}

/**
 * ĐẶT TÊN GỢI NHỚ cho một fanpage — để page KHÔNG còn quyền đọc tên vẫn quản lý được.
 *
 * Ghi vào `alias`, không phải `name`: `name` thuộc API Pancake và sẽ bị đồng bộ cập nhật đè.
 * Không đụng `page_id` — đó là danh tính, và mọi đơn đã quy kết đều trỏ tới nó.
 */
export async function renameFanpage(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: DENIED };
  const parsed = z.object({ fanpageId: z.string().min(1), alias: z.string().max(120) }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const result = await setFanpageAlias(parsed.data.fanpageId, parsed.data.alias);
  if ("error" in result) return { error: result.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `fanpage:${parsed.data.fanpageId}`,
    reason: parsed.data.alias.trim() ? `Đặt tên gợi nhớ cho fanpage: "${parsed.data.alias.trim()}"` : "Xoá tên gợi nhớ của fanpage",
  });
  revalidate();
  return { ok: true };
}

/** Bật / tắt một fanpage trong sổ. Không đụng tới quy kết đã chụp. */
export async function toggleFanpage(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: DENIED };
  const parsed = z.object({ fanpageId: z.string().min(1), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { error: "Dữ liệu không hợp lệ" };
  const result = await setFanpageActive(parsed.data.fanpageId, parsed.data.active);
  if ("error" in result) return { error: result.error };
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "SETTINGS_UPDATE",
    entity: "SETTINGS",
    entityId: `fanpage:${parsed.data.fanpageId}`,
    reason: parsed.data.active ? "Bật lại fanpage" : "Tắt fanpage (không dùng nữa)",
  });
  revalidate();
  return { ok: true };
}

/**
 * ĐỐI SOÁT LẠI — phát hiện fanpage mới rồi dựng lại ảnh chụp quy kết.
 *
 * Chạy lại bao nhiêu lần cũng ra một kết quả (khoá duy nhất trên `order_id`), nên nút này an toàn
 * để bấm bất cứ lúc nào. `dryRun` để xem trước bao nhiêu đơn sẽ đổi kết quả trước khi ghi thật.
 */
export async function reconcileAttribution(input?: unknown): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payroll:manage")) return { error: DENIED };
  const parsed = z.object({ dryRun: z.boolean().optional() }).safeParse(input ?? {});
  const dryRun = parsed.success ? parsed.data.dryRun === true : false;
  const { registry, attribution } = await runFanpageAttributionJob({ dryRun, actor: user.email });
  revalidate();
  const head = dryRun ? "Chạy thử" : "Đã đối soát";
  return {
    ok: true,
    message: `${head}: ${attribution.scanned} đơn · ${attribution.changed} đơn đổi kết quả · ${attribution.byStatus.ATTRIBUTED} quy kết được · ${attribution.byStatus.DUPLICATE} trùng đơn · ${attribution.byStatus.NO_ASSIGNMENT} chưa gán · ${registry.discovered} fanpage mới`,
  };
}
