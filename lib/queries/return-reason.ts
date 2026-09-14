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
import { classifyRaw } from "@/lib/returns/reason-classify";
import {
  REASON_SOURCE_LABEL,
  SOURCE_IS_HUMAN,
  SOURCE_RANK,
  isReasonSource,
  type ReasonCoverageState,
  type ReasonSource,
} from "@/lib/constants/return-reason-source";
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
  /**
   * ═══ CHỮ GỐC, NGUYÊN VĂN, KHÔNG CHUẨN HOÁ ═══
   *
   * Đây là thứ ĐVVC (hoặc người của shop) THẬT SỰ ghi, chép lại không sửa một ký tự: "Tồn - Khách
   * từ chối nhận - Không hài lòng về sản phẩm". `reason` chỉ là cách shop XẾP nó vào danh mục.
   *
   * Giữ riêng hai thứ này là điều kiện để làm được hai việc mà bản trước không làm được:
   *
   *  1. NGƯỜI ĐỌC KIỂM CHỨNG ĐƯỢC. Một ca xếp vào "khách từ chối" mà chữ gốc nói "không hài lòng
   *     về sản phẩm" là một ca đáng đi hỏi lại — nhưng chỉ thấy được nếu chữ gốc còn đó.
   *  2. XẾP LẠI ĐƯỢC VỀ SAU. Đổi cách xếp nhóm không cần sửa một dòng lịch sử nào, vì quan sát
   *     (chữ gốc) và cách xếp (danh mục + nhóm) là hai lớp riêng.
   *
   * Rỗng = KHÔNG CÓ CHỨNG TỪ NÀO, khác hẳn với "có chứng từ nhưng không khớp danh mục".
   */
  rawReason: string;
  /** `true` = người xác nhận, đè lên suy luận của máy. */
  manual: boolean;
  actorEmail: string;
  /**
   * BA MỨC ĐỘ PHỦ, KHÔNG GỘP (`lib/constants/return-reason-source.ts`):
   *   `CLASSIFIED`  — xếp được vào danh mục.
   *   `RAW_ONLY`    — CÓ chữ thật nhưng chưa xếp được ⇒ đọc chữ rồi chọn lý do.
   *   `NO_EVIDENCE` — chưa ai nói gì ⇒ phải ĐI HỎI.
   * Gộp hai cái sau thành "chưa xác định" là xoá mất khác biệt giữa hai việc phải làm khác hẳn nhau.
   */
  coverage: ReasonCoverageState;
  /** Nguồn của quan sát đang được dùng. `null` = không có quan sát nào. */
  source: ReasonSource | null;
};

const KHONG_BIET: ReasonVerdict = { reason: "UNKNOWN", confidence: "NONE", evidence: "Không có mã lý do, không có sự kiện nào nêu lý do.", rawReason: "", manual: false, actorEmail: "", coverage: "NO_EVIDENCE", source: null };

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
      rawReason: (e.statusName ?? "").trim(),
      manual: false,
      actorEmail: "",
      coverage: "CLASSIFIED",
      source: "CARRIER_TEXT",
    });
  }

  // Bậc 2 — mã lý do. Đè lên chữ, vì mã là thứ ĐVVC khai có cấu trúc.
  for (const s of vanDon) {
    if (s.code === null || s.code === undefined) continue;
    const r = VTP_REASON_TO_RETURN_REASON[s.code];
    if (!r) continue;
    // Chữ gốc của bậc CHỮ vẫn được giữ khi mã đè lên: hai chứng từ nói về cùng một kiện, mất một
    // cái là mất đường kiểm chứng xem chúng có mâu thuẫn nhau không.
    out.set(s.id, { reason: r, confidence: "CARRIER_CODE", evidence: `Mã lý do ĐVVC ${s.code}`, rawReason: out.get(s.id)?.rawReason || `Mã lý do ĐVVC ${s.code}`, manual: false, actorEmail: "", coverage: "CLASSIFIED", source: "CARRIER_CODE" });
  }

  // Bậc 1 — người xác nhận. Đè lên tất cả: người vừa gọi cho khách biết nhiều hơn mọi suy luận.
  for (const m of thuCong) {
    /*
      NGƯỜI ĐÈ LÊN MÁY, NHƯNG KHÔNG XOÁ CHỨNG TỪ CỦA MÁY.

      `raw_reason` là chữ ĐVVC nói lúc người đó bấm xác nhận (cột ghi từ 0085; dòng cũ để rỗng,
      KHÔNG backfill). Thiếu nó thì rơi về chữ máy đang đọc được — vẫn không bịa ra gì.
    */
    out.set(m.shipmentId, {
      reason: m.reason as ReturnReason,
      confidence: "CONFIRMED",
      evidence: m.note ? `${m.actorEmail} xác nhận: ${m.note}` : `${m.actorEmail} xác nhận`,
      rawReason: (m.rawReason || "").trim() || out.get(m.shipmentId)?.rawReason || "",
      manual: true,
      actorEmail: m.actorEmail,
      coverage: "CLASSIFIED",
      source: "HUMAN_CONFIRMED",
    });
  }

  /*
    ═══════════ BẬC 0 — QUAN SÁT ĐÃ GHI: THẨM QUYỀN CAO NHẤT THẮNG ═══════════

    Ba bậc phía trên suy LẠI TỪ ĐẦU mỗi lượt đọc, và chúng chỉ với tới được chữ của ĐVVC. Bảng
    `return_reason_observations` là chỗ MỌI nguồn cùng đổ về — kể cả những nguồn ba bậc kia không
    bao giờ thấy: khách nhắn qua chat, nhân viên gọi hỏi, kho mở kiện ra xem.

    Chọn quan sát theo `SOURCE_RANK` (người > kho > chăm sóc > mã ĐVVC > chữ ĐVVC), bằng hạng thì
    lấy cái MUỘN HƠN — kiện hẹn lại rồi vẫn hoàn thì lý do cuối mới là lý do nó hoàn.

    Và đây là chỗ `RAW_ONLY` sinh ra: có chữ thật mà xếp không được thì KHÔNG im lặng trả
    `NO_EVIDENCE`. Hai thứ ấy dẫn tới hai việc khác hẳn nhau — một cái là đọc chữ rồi chọn lý do,
    cái kia là đi hỏi khách.
  */
  const quanSat = await db
    .select()
    .from(schema.returnReasonObservations)
    .where(sql`${schema.returnReasonObservations.shipmentId} in ${ids}`)
    .orderBy(sql`${schema.returnReasonObservations.occurredAt} asc`);

  const totNhat = new Map<string, { rank: number; at: number; row: (typeof quanSat)[number] }>();
  for (const q of quanSat) {
    if (!q.shipmentId || !isReasonSource(q.source)) continue;
    const rank = SOURCE_RANK[q.source];
    const at = q.occurredAt.getTime();
    const cu = totNhat.get(q.shipmentId);
    // Hạng cao hơn thắng; bằng hạng thì muộn hơn thắng.
    if (!cu || rank > cu.rank || (rank === cu.rank && at >= cu.at)) totNhat.set(q.shipmentId, { rank, at, row: q });
  }

  for (const [id, { row }] of totNhat) {
    const src = row.source as ReasonSource;
    const xep = classifyRaw(row.rawText, src);
    const nguoi = SOURCE_IS_HUMAN[src];
    const truoc = out.get(id);
    /*
      QUAN SÁT CỦA MÁY KHÔNG ĐƯỢC HẠ CẤP MỘT KẾT LUẬN CỦA NGƯỜI. Bậc 1 phía trên đã ghi
      `HUMAN_CONFIRMED`; một quan sát `CARRIER_TEXT` mới hơn không được đè lên nó.
    */
    if (truoc?.source === "HUMAN_CONFIRMED" && !nguoi) continue;
    out.set(id, {
      reason: xep.reason,
      confidence: nguoi ? "CONFIRMED" : src === "CARRIER_CODE" ? "CARRIER_CODE" : "CARRIER_TEXT",
      evidence: `${REASON_SOURCE_LABEL[src]}: “${row.rawText}”${row.note ? ` — ${row.note}` : ""}`,
      rawReason: row.rawText,
      manual: nguoi,
      actorEmail: row.actorEmail,
      // CÓ chữ mà chưa xếp được là `RAW_ONLY`, không bao giờ là `NO_EVIDENCE`.
      coverage: xep.matched ? "CLASSIFIED" : "RAW_ONLY",
      source: src,
    });
  }

  return out;
}
