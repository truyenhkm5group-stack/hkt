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
 * ─── NGUỒN CHỨNG CỨ, XẾP THEO `SOURCE_RANK` ───
 *
 *   NGƯỜI XÁC NHẬN (`shipment_return_reasons` + quan sát `HUMAN_CONFIRMED`) → `CONFIRMED`
 *   KHO / GHI CHÚ CHĂM SÓC / CSKH (quan sát)                              → `STAFF_REPORTED`
 *   MÃ LÝ DO của ĐVVC (`shipments.vtp_reason_code`, quan sát)              → `CARRIER_CODE`
 *   CHỮ trong trạng thái ĐVVC ("Tồn - …")                                 → `CARRIER_TEXT`
 *   CHỮ Pancake (phiếu đổi trả, ghi chú đơn)                               → `EXTERNAL_TEXT`
 *   không có gì                                                           → `UNKNOWN` / `NONE`
 *
 * Đặc biệt KHÔNG suy từ tiền: xem chú thích đầu tệp hằng số.
 */
import { and, desc, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { classifyRaw } from "@/lib/returns/reason-classify";
import {
  carrierCodeText,
  REASON_SOURCE_LABEL,
  SOURCE_RANK,
  isReasonSource,
  vtpCodeOfObservation,
  type ReasonCoverageState,
  type ReasonSource,
} from "@/lib/constants/return-reason-source";
import { resolveEvidence, type ReasonEvidenceItem } from "@/lib/constants/return-reason-evidence";
import {
  boDau,
  isReturnReason,
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
  /**
   * MỌI lời khai đã xếp được của kiện (nguồn · lý do · mốc) — đầu vào của `resolveEvidence()`.
   * Giữ lại để nơi gọi dựng được NHÓM THEO CHỨNG CỨ (cần cả ghi đè của chủ shop) mà không phải
   * truy vấn lại, và để thấy được kiện nào có các nguồn nói khác nhau.
   */
  items: ReasonEvidenceItem[];
};

const KHONG_BIET: ReasonVerdict = { reason: "UNKNOWN", confidence: "NONE", evidence: "Không có mã lý do, không có sự kiện nào nêu lý do.", rawReason: "", manual: false, actorEmail: "", coverage: "NO_EVIDENCE", source: null, items: [] };

/** Phân loại một chuỗi trạng thái ĐVVC. Trả `null` khi chuỗi chỉ là BƯỚC ĐI chứ không phải lý do. */
export function reasonFromStatusText(statusName: string): ReturnReason | null {
  const s = boDau(statusName);
  if (!s) return null;
  if (RETURN_STEP_NOT_REASON.some((b) => s.includes(b))) return null;
  for (const rule of RETURN_REASON_TEXT_RULES) if (s.includes(rule.match)) return rule.reason;
  return null;
}

/**
 * ═══════════ BẬC 3 ĐỌC ĐÚNG MỘT DÒNG MỖI KIỆN, KHÔNG PHẢI MỌI SỰ KIỆN ═══════════
 *
 * Bản cũ kéo MỌI sự kiện có chữ của cả tập kiện rồi chạy `reasonFromStatusText` trên TỪNG dòng, chỉ
 * để giữ lại dòng muộn nhất dịch ra lý do. Đo production 29/09/2026 (`ops perf-probe`, kỳ 90 ngày):
 * báo cáo lý do hoàn kéo 116.416 dòng, tầng quyết định 123.854 dòng (nó gọi hàm này cho cả kỳ
 * trước); hai câu đọc sự kiện của hàm này trong tầng quyết định mất 772 ms và 540 ms tính từ lúc gọi
 * tới lúc Node đọc xong, trong khi EXPLAIN của chính chúng chỉ 70–94 ms — phần còn lại là chờ tới
 * lượt trong bể kết nối và truyền + đọc hàng chục nghìn dòng.
 *
 * Câu chữ lặp lại, dù không ít như tưởng: đo production 29/09/2026, 61.668 sự kiện có chữ của 3.064
 * kiện (120 ngày) chỉ có 9.834 câu KHÁC NHAU (chữ ĐVVC mang cả tên bưu tá, số điện thoại…). Nên làm
 * hai bước — Node đọc ~1/5 số dòng, và mỗi câu chữ chỉ qua bộ dịch một lần:
 *   1. Lấy các câu chữ KHÁC NHAU của tập kiện, phân loại bằng ĐÚNG `reasonFromStatusText`
 *      — cùng một hàm, không dịch lại luật sang SQL.
 *   2. Chỉ kéo sự kiện MUỘN NHẤT mỗi kiện trong số những câu chữ có lý do (`distinct on`).
 *
 * Kết quả bằng hệt bản cũ: bản cũ duyệt theo `occurred_at` tăng dần và dòng có lý do sau cùng thắng
 * — tức đúng dòng muộn nhất trong số dòng có lý do. Hai dòng CÙNG mốc thì bản cũ lấy theo thứ tự
 * ngẫu nhiên của CSDL; ở đây phá hoà bằng `id` giảm dần để chạy hai lần ra cùng một kết quả.
 */
async function suKienCoLyDoMuonNhat(db: Awaited<ReturnType<typeof getDb>>, ids: string[]): Promise<{ shipmentId: string; statusName: string; reason: ReturnReason; at: Date; viaPancake: boolean }[]> {
  const e = schema.shipmentEvents;
  const coChu = sql`${e.shipmentId} in ${ids} and coalesce(${e.statusName}, '') <> ''`;
  const cauChu = await db.selectDistinct({ statusName: e.statusName }).from(e).where(coChu);
  const lyDoCua = new Map<string, ReturnReason>();
  for (const { statusName } of cauChu) {
    const r = reasonFromStatusText(statusName ?? "");
    if (r) lyDoCua.set(statusName, r);
  }
  if (!lyDoCua.size) return [];
  /*
    MUỘN NHẤT MỖI KIỆN, TÁCH THEO ĐƯỜNG TỚI: tối đa một dòng VTP và một dòng Pancake chuyển tiếp.
    Lấy một dòng muộn nhất chung thì sự kiện Pancake mới hơn che mất lời VTP — đúng lỗi đã đo (xem
    `SOURCE_RANK.CARRIER_TEXT_VIA_PANCAKE`). Chọn giữa hai dòng là việc của `resolveEvidence`.
  */
  const quaPancake = sql<boolean>`(${e.source} = 'PANCAKE')`;
  const dong = await db
    .selectDistinctOn([e.shipmentId, quaPancake], { shipmentId: e.shipmentId, statusName: e.statusName, at: e.occurredAt, viaPancake: quaPancake })
    .from(e)
    .where(and(coChu, inArray(e.statusName, [...lyDoCua.keys()])))
    .orderBy(e.shipmentId, quaPancake, desc(e.occurredAt), desc(e.id));
  return dong.map((d) => ({ shipmentId: d.shipmentId, statusName: d.statusName, reason: lyDoCua.get(d.statusName) as ReturnReason, at: d.at, viaPancake: Boolean(d.viaPancake) }));
}

/**
 * Lý do hoàn của một tập vận đơn. MỘT truy vấn cho cả tập, không phải một truy vấn mỗi kiện.
 *
 * Vận đơn không nằm trong kết quả trả về = chưa xét (gọi sai tập), khác với vận đơn trả về
 * `UNKNOWN` = đã xét và không có chứng từ. Hai thứ đó không được lẫn.
 *
 * ═══ MỌI NGUỒN THÀNH MỘT DANH SÁCH LỜI KHAI, MỘT HÀM THUẦN QUYẾT ═══
 *
 * Bản trước chạy bốn bậc nối tiếp, mỗi bậc ghi đè `out` theo luật riêng của nó, và luật "ai đè
 * được ai" nằm rải ở bốn chỗ. Đo được bốn lỗi từ đúng cấu trúc đó:
 *   · ghi chú chăm sóc ĐÈ một kết luận của người trong `shipment_return_reasons` (vì "người" được
 *     tính là cả ghi chú) — và mang nhãn "Người xác nhận";
 *   · quan sát chỉ có `order_id` (phiếu đổi trả Pancake) không bao giờ được đọc;
 *   · quan sát `CARRIER_CODE` được xếp lại bằng chữ mà không truyền mã, nên không bao giờ xếp được;
 *   · một quan sát chữ ĐVVC mới hơn đè được mã lý do có cấu trúc.
 *
 * Nay mọi nguồn — sự kiện ĐVVC, mã lý do, bảng người xác nhận, bảng quan sát — đổ vào MỘT danh
 * sách lời khai mỗi kiện, và `resolveEvidence()` (hàm thuần, kiểm được không cần CSDL) chọn
 * nguyên nhân chính theo `SOURCE_RANK`. Cùng một hàm cho ra cả lý do cũ lẫn nhóm theo chứng cứ —
 * hai cách đọc không thể chọn hai lời khai khác nhau.
 */
export async function reasonsForShipments(shipmentIds: readonly string[]): Promise<Map<string, ReasonVerdict>> {
  const out = new Map<string, ReasonVerdict>();
  if (!shipmentIds.length) return out;
  const ids = [...shipmentIds];
  const db = await getDb();

  const [thuCong, vanDon, suKien] = await Promise.all([
    db.select().from(schema.shipmentReturnReasons).where(inArray(schema.shipmentReturnReasons.shipmentId, ids)),
    db.select({ id: schema.shipments.id, orderId: schema.shipments.orderId, code: schema.shipments.vtpReasonCode, at: schema.shipments.vtpStatusDate }).from(schema.shipments).where(inArray(schema.shipments.id, ids)),
    suKienCoLyDoMuonNhat(db, ids),
  ]);

  /*
    Quan sát gắn ĐƠN chứ không gắn kiện (phiếu đổi trả Pancake, ghi chú đơn) — bản trước chỉ hỏi
    `shipment_id in ids`, nên cả lớp này chưa từng vào báo cáo. Gắn nó cho MỌI kiện của đơn đó
    trong tập: đơn gửi lại hai lần thì cả hai kiện cùng mang lời khai của đơn.
  */
  const kienCuaDon = new Map<string, string[]>();
  for (const s of vanDon) if (s.orderId) kienCuaDon.set(s.orderId, [...(kienCuaDon.get(s.orderId) ?? []), s.id]);
  const donIds = [...kienCuaDon.keys()];
  const r = schema.returnReasonObservations;
  const quanSat = await db
    .select()
    .from(r)
    .where(donIds.length ? sql`(${r.shipmentId} in ${ids} or (${r.shipmentId} is null and ${r.orderId} in ${donIds}))` : sql`${r.shipmentId} in ${ids}`)
    .orderBy(sql`${r.occurredAt} asc`);

  const loiKhai = new Map<string, LoiKhai[]>();
  const tho = new Map<string, LoiKhai>();
  const them = (id: string, k: LoiKhai) => loiKhai.set(id, [...(loiKhai.get(id) ?? []), k]);
  const chuDvvc = new Map<string, string>();

  // Chữ ĐVVC muộn nhất mang lý do — mỗi kiện tối đa MỘT dòng (xem `suKienCoLyDoMuonNhat`).
  for (const e of suKien) {
    const raw = (e.statusName ?? "").trim();
    // Chữ ĐVVC đi kèm kết luận người / mã: chữ đến thẳng từ VTP thắng chữ Pancake chuyển tiếp.
    if (!e.viaPancake || !chuDvvc.has(e.shipmentId)) chuDvvc.set(e.shipmentId, raw);
    them(e.shipmentId, {
      source: e.viaPancake ? "CARRIER_TEXT_VIA_PANCAKE" : "CARRIER_TEXT",
      reason: e.reason,
      at: e.at.getTime(),
      evidence: `${e.viaPancake ? "Sự kiện ĐVVC qua Pancake" : "Sự kiện ĐVVC"}: “${e.statusName}”`,
      rawReason: raw,
      actorEmail: "",
    });
  }
  for (const s of vanDon) {
    if (s.code === null || s.code === undefined) continue;
    const reason = VTP_REASON_TO_RETURN_REASON[s.code];
    if (!reason) continue;
    // Chữ gốc của bậc CHỮ vẫn đi kèm khi mã thắng: mất một cái là mất đường kiểm chứng xem hai
    // chứng từ có mâu thuẫn nhau không.
    them(s.id, { source: "CARRIER_CODE", reason, at: s.at?.getTime() ?? 0, evidence: `Mã lý do ĐVVC ${s.code}`, rawReason: chuDvvc.get(s.id) || carrierCodeText(s.code), actorEmail: "" });
  }
  for (const m of thuCong) {
    if (!isReturnReason(m.reason)) continue;
    /*
      NGƯỜI THẮNG MÁY, NHƯNG KHÔNG XOÁ CHỨNG TỪ CỦA MÁY. `raw_reason` là chữ ĐVVC lúc người đó bấm
      (cột ghi từ 0085; dòng cũ rỗng, KHÔNG backfill) — thiếu thì rơi về chữ máy đang đọc được.
    */
    them(m.shipmentId, {
      source: "HUMAN_CONFIRMED",
      reason: m.reason,
      at: m.updatedAt.getTime(),
      evidence: m.note ? `${m.actorEmail} xác nhận: ${m.note}` : `${m.actorEmail} xác nhận`,
      rawReason: (m.rawReason || "").trim() || chuDvvc.get(m.shipmentId) || "",
      actorEmail: m.actorEmail,
    });
  }
  for (const q of quanSat) {
    if (!isReasonSource(q.source)) continue;
    const kien = q.shipmentId ? [q.shipmentId] : q.orderId ? (kienCuaDon.get(q.orderId) ?? []) : [];
    /*
      Lựa chọn của NGƯỜI là chính nó, không đọc lại qua bảng luật chữ (`reason_at_write` giữ khoá
      người đó chọn). Mọi nguồn khác xếp lại LÚC ĐỌC — sửa luật là số đổi theo, không viết lại lịch sử.
    */
    const reason: ReturnReason =
      q.source === "HUMAN_CONFIRMED" && isReturnReason(q.reasonAtWrite) && q.reasonAtWrite !== "UNKNOWN"
        ? q.reasonAtWrite
        : classifyRaw(q.rawText, q.source, vtpCodeOfObservation(q.source, q.rawText)).reason;
    const k: LoiKhai = {
      source: q.source,
      reason,
      at: q.occurredAt.getTime(),
      evidence: `${REASON_SOURCE_LABEL[q.source]}: “${q.rawText}”${q.note ? ` — ${q.note}` : ""}`,
      rawReason: q.rawText,
      actorEmail: q.actorEmail,
    };
    for (const id of kien) {
      them(id, k);
      if (hon(k, tho.get(id))) tho.set(id, k);
    }
  }

  for (const id of ids) {
    const ds = loiKhai.get(id) ?? [];
    const ket = resolveEvidence(ds);
    const p = ket.primary ? ds.find((k) => k.source === ket.primary?.source && k.reason === ket.primary.reason && k.at === ket.primary.at) : undefined;
    if (p) {
      out.set(id, {
        reason: p.reason,
        confidence: CONFIDENCE_OF_SOURCE[p.source],
        evidence: p.evidence,
        rawReason: p.rawReason,
        manual: p.source === "HUMAN_CONFIRMED",
        actorEmail: p.actorEmail,
        coverage: "CLASSIFIED",
        source: p.source,
        items: ds.map(({ source, reason, at }) => ({ source, reason, at })),
      });
      continue;
    }
    /*
      Có chữ thật mà xếp không được ⇒ `RAW_ONLY`, KHÔNG im lặng trả `NO_EVIDENCE`: một cái là đọc
      chữ rồi chọn lý do, cái kia là đi hỏi khách.
    */
    const t = tho.get(id);
    out.set(
      id,
      t
        ? { reason: "UNKNOWN", confidence: CONFIDENCE_OF_SOURCE[t.source], evidence: t.evidence, rawReason: t.rawReason, manual: false, actorEmail: t.actorEmail, coverage: "RAW_ONLY", source: t.source, items: [] }
        : KHONG_BIET,
    );
  }
  return out;
}

/** Một lời khai kèm phần để HIỂN THỊ — chỉ `source/reason/at` đi vào phép chọn. */
type LoiKhai = ReasonEvidenceItem & { evidence: string; rawReason: string; actorEmail: string };

const hon = (a: LoiKhai, b: LoiKhai | undefined) => !b || SOURCE_RANK[a.source] > SOURCE_RANK[b.source] || (SOURCE_RANK[a.source] === SOURCE_RANK[b.source] && a.at >= b.at);

/**
 * `CONFIRMED` CHỈ cho người bấm xác nhận. Ghi chú chăm sóc / phiếu kho là lời nhân viên GHI NHẬN —
 * bản trước gắn cả hai nhãn "Người xác nhận" (`SOURCE_IS_HUMAN`), nên một câu trong ô ghi chú
 * trông y hệt một kết luận đã chốt.
 */
const CONFIDENCE_OF_SOURCE: Record<ReasonSource, ReasonConfidence> = {
  HUMAN_CONFIRMED: "CONFIRMED",
  WAREHOUSE_INSPECTION: "STAFF_REPORTED",
  CARE_NOTE: "STAFF_REPORTED",
  CS_NOTE: "STAFF_REPORTED",
  CARRIER_CODE: "CARRIER_CODE",
  CARRIER_TEXT: "CARRIER_TEXT",
  CARRIER_TEXT_VIA_PANCAKE: "CARRIER_TEXT",
  PANCAKE_RETURN: "EXTERNAL_TEXT",
  PANCAKE_ORDER_NOTE: "EXTERNAL_TEXT",
};
