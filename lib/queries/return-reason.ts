/**
 * ═══════════ SUY LÝ DO HOÀN — CHỈ TỪ CHỨNG TỪ, CÓ XUẤT XỨ TỪNG DÒNG ═══════════
 *
 * Taxonomy và lý lẽ ở `lib/constants/return-reason.ts`.
 *
 * ─── TỆP NÀY KHÔNG ĐỊNH NGHĨA "HOÀN" ───
 *
 * Câu hỏi "đơn này có hoàn không" đã có MỘT câu trả lời duy nhất trong kho mã: `ORDER_OUTCOME`
 * (`lib/queries/return-rate.ts`), khoá bằng `tests/contract-order-outcome.test.ts`. Tệp này chỉ
 * trả lời câu SAU đó — "vì sao" — và nó nhận tập vận đơn hoàn từ bên ngoài truyền vào. Viết lại
 * một điều kiện hoàn ở đây là tạo ra bộ số thứ hai cho cùng một câu hỏi, đúng thứ AGENTS.md mục
 * 8 cấm.
 *
 * ─── BỐN BẬC CHỨNG CỨ, HẸP DẦN ───
 *
 *   1. NGƯỜI XÁC NHẬN (`shipment_return_reasons`)  → `CONFIRMED`
 *   2. MÃ LÝ DO của ĐVVC (`shipments.vtp_reason_code`) → `CARRIER_CODE`
 *   3. CHỮ trong trạng thái ĐVVC ("Tồn - …")       → `CARRIER_TEXT`
 *   4. không có gì                                  → `UNKNOWN` / `NONE`
 *
 * Không có bậc thứ năm. Đặc biệt KHÔNG suy từ tiền: xem chú thích đầu tệp hằng số.
 */
import { inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  boDau,
  RETURN_REASON_TEXT_RULES,
  RETURN_STEP_NOT_REASON,
  VTP_REASON_TO_RETURN_REASON,
  type ReasonConfidence,
  type ReturnReason,
} from "@/lib/constants/return-reason";

export type ReasonVerdict = {
  reason: ReturnReason;
  confidence: ReasonConfidence;
  /** Chứng từ cụ thể dẫn tới kết luận — để người đọc kiểm chứng được, không phải tin lời. */
  evidence: string;
  /** `true` = người xác nhận, đè lên suy luận của máy. */
  manual: boolean;
  actorEmail: string;
};

const KHONG_BIET: ReasonVerdict = { reason: "UNKNOWN", confidence: "NONE", evidence: "Không có mã lý do, không có sự kiện nào nêu lý do.", manual: false, actorEmail: "" };

/** Phân loại một chuỗi trạng thái ĐVVC. Trả `null` khi chuỗi chỉ là BƯỚC ĐI chứ không phải lý do. */
export function reasonFromStatusText(statusName: string): ReturnReason | null {
  const s = boDau(statusName);
  if (!s) return null;
  if (RETURN_STEP_NOT_REASON.some((b) => s.includes(b))) return null;
  for (const rule of RETURN_REASON_TEXT_RULES) if (s.includes(rule.match)) return rule.reason;
  return null;
}

/**
 * Lý do hoàn của một tập vận đơn. MỘT truy vấn cho cả tập, không phải một truy vấn mỗi kiện.
 *
 * Vận đơn không nằm trong kết quả trả về = chưa xét (gọi sai tập), khác với vận đơn trả về
 * `UNKNOWN` = đã xét và không có chứng từ. Hai thứ đó không được lẫn.
 */
export async function reasonsForShipments(shipmentIds: readonly string[]): Promise<Map<string, ReasonVerdict>> {
  const out = new Map<string, ReasonVerdict>();
  if (!shipmentIds.length) return out;
  const ids = [...shipmentIds];
  const db = await getDb();

  const [thuCong, vanDon, suKien] = await Promise.all([
    db.select().from(schema.shipmentReturnReasons).where(inArray(schema.shipmentReturnReasons.shipmentId, ids)),
    db.select({ id: schema.shipments.id, code: schema.shipments.vtpReasonCode }).from(schema.shipments).where(inArray(schema.shipments.id, ids)),
    db
      .select({ shipmentId: schema.shipmentEvents.shipmentId, statusName: schema.shipmentEvents.statusName, occurredAt: schema.shipmentEvents.occurredAt })
      .from(schema.shipmentEvents)
      .where(sql`${schema.shipmentEvents.shipmentId} in ${ids} and coalesce(${schema.shipmentEvents.statusName}, '') <> ''`)
      .orderBy(sql`${schema.shipmentEvents.occurredAt} asc`),
  ]);

  for (const id of ids) out.set(id, KHONG_BIET);

  // Bậc 3 — chữ trong trạng thái. Duyệt theo thời gian tăng dần, giữ lý do MUỘN NHẤT:
  // kiện hẹn lại rồi vẫn không giao được thì lý do cuối mới là lý do nó hoàn.
  for (const e of suKien) {
    const r = reasonFromStatusText(e.statusName ?? "");
    if (!r) continue;
    out.set(e.shipmentId, {
      reason: r,
      confidence: "CARRIER_TEXT",
      evidence: `Sự kiện ĐVVC: “${e.statusName}”`,
      manual: false,
      actorEmail: "",
    });
  }

  // Bậc 2 — mã lý do. Đè lên chữ, vì mã là thứ ĐVVC khai có cấu trúc.
  for (const s of vanDon) {
    if (s.code === null || s.code === undefined) continue;
    const r = VTP_REASON_TO_RETURN_REASON[s.code];
    if (!r) continue;
    out.set(s.id, { reason: r, confidence: "CARRIER_CODE", evidence: `Mã lý do ĐVVC ${s.code}`, manual: false, actorEmail: "" });
  }

  // Bậc 1 — người xác nhận. Đè lên tất cả: người vừa gọi cho khách biết nhiều hơn mọi suy luận.
  for (const m of thuCong) {
    out.set(m.shipmentId, {
      reason: m.reason as ReturnReason,
      confidence: "CONFIRMED",
      evidence: m.note ? `${m.actorEmail} xác nhận: ${m.note}` : `${m.actorEmail} xác nhận`,
      manual: true,
      actorEmail: m.actorEmail,
    });
  }

  return out;
}
