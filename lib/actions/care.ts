"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { assignableUsers } from "@/lib/actions/alerts";
import { can, requireUser } from "@/lib/auth/session";
import type { CareDecision } from "@/lib/constants/care-resolution";
import { CARE_ACTION_KINDS } from "@/lib/constants/delivery-tower";
import { getCareCaseDetail, getResolutionNotePresets } from "@/lib/queries/care-workbench";

/**
 * ───────────── GHI NHẬN VIỆC ĐÃ CHĂM MỘT KIỆN HÀNG ─────────────
 *
 * ERP **không** tự nhắn khách ở đây. Việc này chỉ GHI LẠI điều người vừa làm — và đó mới là thứ
 * biến "đội CSKH cứu được bao nhiêu đơn" từ một câu hỏi không có dữ liệu thành một con số đo được.
 *
 * Bối cảnh được chụp lại NGAY LÚC GHI (chặng, tuổi tin cuối, COD, số lần giao hụt). Tính lại về sau
 * là hỏi "kiện này giờ ra sao" chứ không phải "việc chăm có tác dụng gì".
 */
const schemaGhi = z.object({
  shipmentId: z.string().min(1),
  kind: z.enum(CARE_ACTION_KINDS),
  note: z.string().trim().max(500).default(""),
});

export async function recordCareAction(input: z.input<typeof schemaGhi>): Promise<{ error?: string; ok?: true }> {
  const user = await requireUser();
  const parsed = schemaGhi.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, kind, note } = parsed.data;

  const db = await getDb();
  const [s] = await db
    .select({
      id: schema.shipments.id,
      orderId: schema.shipments.orderId,
      stage: schema.shipments.stage,
      cod: schema.shipments.codAmount,
      // Tuổi tin cuối đọc từ SỰ KIỆN ĐVVC, không từ `updated_at` — `updated_at` bị chạm bởi mọi lần ghi.
      tuoi: sql<number | null>`extract(epoch from (now() - (select max(e.occurred_at) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION')))) / 3600`,
      lanHut: sql<number>`(select count(*) from shipment_events e where e.shipment_id = ${schema.shipments.id} and e.normalized_stage = 'DELIVERY_FAILED')::int`,
    })
    .from(schema.shipments)
    .where(eq(schema.shipments.id, shipmentId))
    .limit(1);
  if (!s) return { error: "Không tìm thấy vận đơn" };

  await db.insert(schema.careActions).values({
    shipmentId,
    orderId: s.orderId,
    actorId: user.id,
    actorEmail: user.email ?? "",
    kind,
    note,
    stageAtAction: s.stage,
    // `NULL` = CHƯA BIẾT. Vận đơn không có sự kiện nào thì tuổi là chưa biết, không phải 0 giờ.
    codAtAction: s.cod ?? null,
    eventAgeHoursAtAction: s.tuoi === null ? null : Math.round(Number(s.tuoi)),
    failedAttemptsAtAction: s.lanHut === null ? null : Number(s.lanHut),
  });

  await audit({ userId: user.id, userEmail: user.email ?? "", action: "care.record", entity: "SHIPMENT", entityId: shipmentId, after: { kind, note }, reason: "CSKH ghi nhận việc đã làm với kiện hàng" });
  revalidatePath("/shipments");
  return { ok: true };
}

/**
 * ───────────── BÀN XỬ LÝ MỘT KIỆN: MỘT LƯỢT TẢI, ĐỦ BA CHIỀU ─────────────
 *
 * Ngăn kéo trước đây đọc `getShipmentQuickView` — đủ để GỌI KHÁCH nhưng không đủ để XỬ LÝ: không có
 * trạng thái care, không có người phụ trách, không có hạn, không có kết quả đã quyết, không có mã
 * Viettel Post thật (nên không dựng được liên kết tra cứu). Người trực phải đóng ngăn kéo, tìm lại
 * dòng, thao tác ngoài bảng — đúng thứ ngăn kéo sinh ra để khỏi phải làm.
 *
 * `getCareCaseDetail` đã trả đủ cả ba chiều và đã được dùng cho AI Copilot. Không dựng một phép đọc
 * thứ hai: hai phép đọc cho cùng một màn hình là hai cơ hội để chúng nói hai điều khác nhau.
 */
export async function loadCareWorkspace(shipmentId: string): Promise<CareWorkspace | null> {
  const user = await requireUser();
  if (!can(user, "shipments:view")) return null;
  /*
    MỘT LƯỢT ĐI-VỀ, KHÔNG BA. Panel cần ba thứ mà nó không thể nhận qua props: nó được dựng từ bốn
    màn hình khác nhau (bàn care, danh sách đơn, hàng đợi cảnh báo, ô lệnh ⌘K) và chỉ hai trong số
    đó có sẵn danh sách nhân sự. Bắt cả bốn nơi truyền xuống là bốn chỗ phải nhớ — và chỗ quên đầu
    tiên sẽ hiện một panel không giao việc được mà không báo gì.
  */
  const [detail, staff, resolutionPresets] = await Promise.all([getCareCaseDetail(shipmentId), assignableUsers(), getResolutionNotePresets()]);
  if (!detail) return null;
  return { detail, staff, resolutionPresets, canManage: can(user, "shipments:manage") };
}

export type CareWorkspace = {
  detail: NonNullable<Awaited<ReturnType<typeof getCareCaseDetail>>>;
  staff: { id: string; name: string }[];
  resolutionPresets: Record<CareDecision, string[]>;
  /** Ba nút kết quả gọi `recordBusinessAction`, cần `shipments:manage`. Không có quyền ⇒ panel chỉ đọc. */
  canManage: boolean;
};
