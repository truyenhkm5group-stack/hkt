"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth/session";
import { vnEndOfDay, vnDateKey } from "@/lib/format";
import { PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import { promisedDeliveryClear, promisedDeliveryInput } from "@/lib/validation/promised-delivery";

/**
 * ═══════════ GHI / BỎ NGÀY KHÁCH HẸN GIAO ═══════════
 *
 * Đặc tả luật ở `lib/constants/promised-delivery.ts`.
 *
 * ─── QUYỀN: `cs:manage`, KHÔNG PHẢI `orders:read` ───
 *
 * Lời hẹn là một CAM KẾT VỚI KHÁCH và nó TẮT cảnh báo trễ hạn của đơn. Ai ghi được nó thì ghi được
 * một ngày xa và làm đơn biến mất khỏi mọi hàng đợi — nên nó phải là quyền của người thật sự nói
 * chuyện với khách, không phải của mọi người xem được đơn.
 *
 * ─── CHỈ GHI ĐƯỢC KHI ĐƠN CHƯA RỜI KHO ───
 *
 * Hẹn một ngày giao cho kiện hàng đang trên đường là vô nghĩa: chuyến đi do ĐVVC quyết, và một lời
 * hẹn ghi lúc đó chỉ tạo một con số không ai thực hiện được. Đơn đã gửi thì việc theo dõi thuộc về
 * đồng hồ tuổi chặng (`lib/constants/shipment-status-age.ts`).
 *
 * ─── CHUYỂN NGÀY THÀNH MỐC Ở ĐÂY, MỘT CHỖ DUY NHẤT ───
 *
 * `vnEndOfDay()` là nơi duy nhất quyết định "ngày 20" nghĩa là mốc nào. Làm phép đổi đó ở client
 * thì mỗi máy ở một múi giờ sẽ ra một mốc khác.
 */
type Result = { ok: true } | { error: string };

export async function setPromisedDelivery(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:manage")) return { error: "Không đủ quyền ghi ngày khách hẹn giao" };
  const parsed = promisedDeliveryInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const [don] = await db
    .select({ id: schema.orders.id, systemId: schema.orders.systemId, stage: schema.orders.stage, cu: schema.orders.customerPromisedAt })
    .from(schema.orders)
    .where(eq(schema.orders.id, d.orderId))
    .limit(1);
  if (!don) return { error: "Không tìm thấy đơn" };
  if (!PRE_SHIP_STAGES.includes(don.stage)) {
    return { error: "Đơn đã rời khâu chuẩn bị — lời hẹn chỉ ghi được khi hàng còn trong kho" };
  }

  const promisedAt = vnEndOfDay(d.date);
  await db
    .update(schema.orders)
    .set({
      customerPromisedAt: promisedAt,
      customerPromisedNote: d.note,
      // Quy kết bằng KHOÁ tài khoản (AGENTS.md mục 34) — không nhận tên từ client.
      customerPromisedByUserId: user.id,
      customerPromisedSetAt: new Date(),
    })
    .where(eq(schema.orders.id, d.orderId));

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "order.promised-delivery.set",
    entity: "ORDER",
    entityId: d.orderId,
    // TRƯỚC / SAU tách riêng: đổi một lời hẹn từ 18 sang 25 là một sự kiện khác hẳn đặt hẹn lần đầu,
    // và chỉ có cặp giá trị mới lần ngược được.
    before: { promisedDate: don.cu ? vnDateKey(don.cu) : null },
    after: { promisedDate: d.date },
    reason: d.note,
  });
  revalidatePath(`/orders/${d.orderId}`);
  revalidatePath("/operations/preship");
  return { ok: true };
}

/**
 * BỎ LỜI HẸN — và bắt buộc phải có LÝ DO.
 *
 * Xoá im lặng thì người mở đơn ngày mai không biết đã từng có hẹn, và cũng không biết vì sao nó
 * biến mất. Đơn quay lại hạn xử lý thông thường ngay sau lượt ghi này.
 */
export async function clearPromisedDelivery(input: unknown): Promise<Result> {
  const user = await requireUser();
  if (!can(user, "cs:manage")) return { error: "Không đủ quyền sửa ngày khách hẹn giao" };
  const parsed = promisedDeliveryClear.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;

  const db = await getDb();
  const [don] = await db
    .select({ id: schema.orders.id, systemId: schema.orders.systemId, cu: schema.orders.customerPromisedAt })
    .from(schema.orders)
    .where(eq(schema.orders.id, d.orderId))
    .limit(1);
  if (!don) return { error: "Không tìm thấy đơn" };
  if (!don.cu) return { error: "Đơn này không có lời hẹn nào để bỏ" };

  await db
    .update(schema.orders)
    .set({ customerPromisedAt: null, customerPromisedNote: "", customerPromisedByUserId: user.id, customerPromisedSetAt: new Date() })
    .where(eq(schema.orders.id, d.orderId));

  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "order.promised-delivery.clear",
    entity: "ORDER",
    entityId: d.orderId,
    before: { promisedDate: vnDateKey(don.cu) },
    after: { promisedDate: null },
    reason: d.reason,
  });
  revalidatePath(`/orders/${d.orderId}`);
  revalidatePath("/operations/preship");
  return { ok: true };
}
