/**
 * ═══════════ TIN SÁNG «KHÁCH ĐẾN HẠN MUA LẠI» VÀO NHÓM VẬN HÀNH (03/10/2026) — CHỈ MÁY CHỦ ═══════════
 *
 * Chủ shop Hải Sản Làng Chài 03/10/2026: «Khách cũ đã từng mua, có lịch sử mua hàng, giờ hỏi giá lại không mua, làm nào để chốt
 * đơn được những khách này?» ⇒ «Cứ làm theo phương án tối ưu nhất».
 *
 * Ràng buộc cứng: chính sách Messenger của Meta KHÔNG cho page tự nhắn tin mời mua ngoài khung 24 giờ kể từ tin cuối của
 * khách — khách tới hạn mua lại thường đã im nhiều tuần, bot tự nhắn là đặt page vào rủi ro bị hạn chế. Nên:
 *  · trong khung 24 giờ (khách tự nhắn tới): bot chủ động mời đặt lại (khối KHÁCH CŨ, lib/sales-chatbot/returning.ts);
 *  · ngoài khung: NGƯỜI gọi / Zalo — danh sách đến hạn đã có (/customers/reorder, docs/verticals/reorder-reminders.md) nhưng
 *    phải mở màn hình mới thấy. Tin này đưa nó tới đúng nơi nhân viên đang ở: nhóm «báo nhóm vận hành» shop đã cấu hình.
 *
 * MỘT tin mỗi ngày (khoá `reorder-digest:<ngày VN>` trong sổ `messaging_deliveries`), sau 8 giờ sáng giờ VN, chỉ khi có khách
 * ĐẾN HẠN / SẮP ĐẾN HẠN — ngày không ai đến hạn thì im. Chưa cấu hình nhóm ⇒ không gửi, không đoán kênh. Tình trạng đến hạn
 * dùng ĐÚNG `loadReorderBoard()` của màn hình, không tính lần hai.
 */
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { zaloLinkOf } from "@/lib/constants/appointments";
import { formatDate, vnDateKey } from "@/lib/format";
import { deliverMessage } from "@/lib/messaging/service";
import { organizationBaseUrl } from "@/lib/platform/publish";
import { loadReorderBoard, type ReorderRow } from "@/lib/queries/reorder";
import { operationsGroupChannel } from "@/lib/sales-chatbot/alerts";
import { homeRuntimeIdleReason } from "@/lib/sales-chatbot/page-runtime";

/** Giờ VN sớm nhất gửi tin sáng; số khách tối đa liệt kê (phần còn lại ghi «+N khách khác»). */
export const REORDER_DIGEST = { fromHourVn: 8, maxRows: 15 } as const;

export type DigestRow = Pick<ReorderRow, "name" | "phone" | "status" | "daysUntil" | "lastOrderOn"> & { items: string[] };

/** Chữ của tin sáng — `null` khi không ai đến hạn. HÀM THUẦN. */
export function reorderDigestText(rows: readonly DigestRow[], today: string, link: string | null): string | null {
  const due = rows.filter((r) => r.status === "DUE" || r.status === "DUE_SOON");
  if (!due.length) return null;
  const when = (d: number | null) => (d === null ? "" : d < 0 ? `quá hạn ${-d} ngày` : d === 0 ? "đến hạn hôm nay" : `còn ${d} ngày`);
  const lines = due.slice(0, REORDER_DIGEST.maxRows).map((r) => {
    const zalo = zaloLinkOf(r.phone);
    const last = r.lastOrderOn ? `lần trước ${formatDate(r.lastOrderOn).slice(0, 5)}${r.items.length ? `: ${r.items.join(", ")}` : ""}` : "";
    return `• ${r.name} · ${r.phone || "chưa có SĐT"} · ${when(r.daysUntil)}${last ? ` · ${last}` : ""}${zalo ? ` · ${zalo}` : ""}`;
  });
  const more = due.length > REORDER_DIGEST.maxRows ? [`… và ${due.length - REORDER_DIGEST.maxRows} khách khác`] : [];
  return [
    `🔁 Khách đến hạn mua lại (${formatDate(today).slice(0, 5)}): ${due.length} khách`,
    ...lines,
    ...more,
    `Gọi / Zalo mời đặt lại như lần trước, rồi ghi kết quả${link ? ` tại ${link}/customers/reorder` : " ở Khách hàng → Mua lại"} để khách không bị gọi trùng.`,
  ].join("\n");
}

export type DigestResult = { sent: boolean; due: number; reason: string };

/** Một lượt cho tổ chức NGỮ CẢNH (gọi trong job `sales-followup`). Không ném. */
export async function sendReorderDigest(now: Date = new Date()): Promise<DigestResult> {
  try {
    // Workspace nhà chưa page nào LIVE cho bot Chốt Đơn ⇒ runtime mới chưa phục vụ khách nhà, không gửi tin nhóm (page-runtime.ts).
    const idle = await homeRuntimeIdleReason();
    if (idle) return { sent: false, due: 0, reason: idle };
    if ((now.getUTCHours() + 7) % 24 < REORDER_DIGEST.fromHourVn) return { sent: false, due: 0, reason: "trước 8 giờ sáng" };
    const today = vnDateKey(now);
    const key = `reorder-digest:${today}`;
    const db = await getDb();
    const d = schema.messagingDeliveries;
    const [done] = await db.select({ id: d.id }).from(d).where(eq(d.dedupeKey, key)).limit(1);
    if (done) return { sent: false, due: 0, reason: "hôm nay đã gửi" };
    const group = await operationsGroupChannel();
    if (!group) return { sent: false, due: 0, reason: "chưa cấu hình nhóm báo vận hành" };
    const board = await loadReorderBoard({ today });
    const due = board.rows.filter((r) => r.status === "DUE" || r.status === "DUE_SOON");
    if (!due.length) return { sent: false, due: 0, reason: "không khách nào đến hạn" };
    const top = due.slice(0, REORDER_DIGEST.maxRows);
    const oi = schema.orderItems;
    const items = await db
      .select({ orderId: oi.orderId, name: oi.productName, detail: oi.variationDetail, qty: oi.quantity })
      .from(oi)
      .where(inArray(oi.orderId, top.map((r) => r.lastOrderId).filter((x): x is string => Boolean(x))));
    const itemsBy = new Map<string, string[]>();
    for (const i of items) {
      if (!i.name.trim()) continue;
      const list = itemsBy.get(i.orderId) ?? [];
      list.push(`${i.name.trim()}${i.detail.trim() ? ` ${i.detail.trim()}` : ""} × ${i.qty}`);
      itemsBy.set(i.orderId, list);
    }
    const text = reorderDigestText(
      due.map((r) => ({ name: r.name, phone: r.phone, status: r.status, daysUntil: r.daysUntil, lastOrderOn: r.lastOrderOn, items: ((r.lastOrderId && itemsBy.get(r.lastOrderId)) || []).slice(0, 3) })),
      today,
      await organizationBaseUrl().catch(() => null),
    );
    if (!text) return { sent: false, due: 0, reason: "không khách nào đến hạn" };
    const r = await deliverMessage({ connectorKey: group.connectorKey, destination: group.destination, title: "Khách đến hạn mua lại", body: text, dedupeKey: key, event: "crm.reorder_digest" });
    return { sent: r.status === "SENT", due: due.length, reason: r.status === "FAILED" ? r.error.slice(0, 160) : r.status };
  } catch (e) {
    return { sent: false, due: 0, reason: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}
