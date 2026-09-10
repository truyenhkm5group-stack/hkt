import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import { memo } from "@/lib/cache";
import { KIND_TO_CASE, type CaseType } from "@/lib/constants/action-queue";

/**
 * ═══════════ BỘ ƯỚC LƯỢNG TIỀN THU HỒI ═══════════
 *
 * Câu hỏi thứ tư của hệ vận hành: *"xử lý việc này thì thu về được bao nhiêu?"*
 *
 * ─── LUẬT KHÔNG NHÂN NHƯỢNG: SỰ THẬT VÀ ƯỚC TÍNH KHÔNG BAO GIỜ GỘP LÀM MỘT SỐ ───
 *
 *   · `moneyAtRisk`          — SỰ THẬT. Tổng tiền đang nằm trong các việc đang mở. Đếm từ đơn và
 *                              vận đơn có thật, không nhân hệ số nào.
 *   · `estimatedRecoverable` — ƯỚC TÍNH. Bằng tiền đang treo nhân TỶ LỆ CỨU ĐƯỢC ĐO TỪ LỊCH SỬ.
 *
 * Hai con số này phải hiện thành hai dòng riêng, luôn luôn. Gộp chúng lại sẽ tạo ra một con số
 * trông như tiền thật mà không ai truy được nó từ đâu ra — và người ta sẽ ra quyết định trên đó.
 *
 * ─── TỶ LỆ CỨU ĐƯỢC ĐO TỪ ĐÂU ───
 *
 * KHÔNG lấy `RECOVERABILITY` trong sổ hàng đợi việc. Trọng số đó là để XẾP THỨ TỰ việc — nó do
 * người viết ước lượng, và nhân tiền thật với một hệ số phỏng đoán thì ra một con số phỏng đoán
 * mang hình dạng của tiền thật.
 *
 * Thay vào đó: đếm lịch sử. Trong những việc cùng loại ĐÃ ĐÓNG, bao nhiêu phần trăm đơn cuối cùng
 * vẫn về đích? Đó là một con số đo được, kèm cỡ mẫu, và nói được nó dựa trên cái gì.
 *
 * ─── KHI CHƯA ĐỦ MẪU: KHÔNG ƯỚC TÍNH ───
 *
 * Dưới `CO_MAU_TOI_THIEU` việc lịch sử thì trả `null`. Màn hình khi đó chỉ hiện "10tr đang treo" —
 * đúng và đủ. Bịa ra "cứu được 6tr" từ 3 mẫu thì con số ấy nói về sự ngẫu nhiên, không nói về shop.
 *
 * ─── CHỈ ĐẾM VIỆC CÓ NGƯỜI ĐÓNG (`MANUAL`) ───
 *
 * Đây là chỗ dễ tự lừa mình nhất. Câu hỏi là *"nếu CÓ NGƯỜI XỬ LÝ thì cứu được bao nhiêu"* — nên
 * mẫu phải gồm những ca THẬT SỰ có người xử lý. Ca tự đóng vì điều kiện hết (`AUTO`) đo chuyện
 * khác hẳn: đơn tự đi tiếp, không ai làm gì. Ca đóng vì tắt loại cảnh báo (`STALE`) thì thậm chí
 * không ai nhìn. Trộn cả ba vào là đo "đơn từng bị cảnh báo thì kết cục thế nào", rồi dán lên đó
 * cái nhãn "xử lý thì thu về được" — hai câu hoàn toàn khác nhau.
 *
 * Đo trên production 10/09/2026: 96 ca đã đóng có kết quả đơn, **cả 96 đều là `UNKNOWN`** — đóng
 * từ trước khi có cột ghi nguồn gốc. Nghĩa là hiện chưa có một ca nào chứng minh được là có người
 * xử lý. Nếu đếm cả chúng thì máy sẽ báo "đơn mới chưa xử lý: cứu được 4,8%" — một con số nghe rất
 * cụ thể, dựng trên 62 ca mà không ai biết có ai đụng vào hay không.
 *
 * Nên bộ ước lượng hiện KHÔNG trả ra ước tính nào, và nói thẳng vì sao. Nó tự bật khi người vận
 * hành bắt đầu bấm đóng việc — chính vòng phản hồi việc-làm → kết-quả mà hệ này cần.
 */

/** Dưới ngần này việc lịch sử thì tỷ lệ đo được chỉ là nhiễu. */
export const CO_MAU_TOI_THIEU = 20;

/**
 * ĐỊNH NGHĨA "CỨU ĐƯỢC" CHO TỪNG LOẠI VIỆC.
 *
 * Chỉ khai những loại mà câu "cứu được" có một nghĩa DUY NHẤT, đo được trên dữ liệu có sẵn: việc
 * gắn với một đơn, và cứu được nghĩa là đơn đó cuối cùng vẫn giao thành công.
 *
 * Loại nào không nằm ở đây thì KHÔNG có ước tính — cố ý. Vài ví dụ vì sao:
 *
 *  · `CANCELLED_BUT_SHIPPING` — cứu được nghĩa là chặn được kiện hàng, tức đơn KHÔNG giao tới
 *    khách. Dùng chung định nghĩa "giao thành công" ở đây sẽ đo ngược hoàn toàn.
 *  · `COD_OVERDUE` — cứu được nghĩa là tiền về; kết quả đơn không nói gì về việc đó.
 *  · `RETURN_RECEIVED_PENDING_INSPECTION` — cứu được nghĩa là hàng vào lại tồn, đo ở sổ kho.
 *  · `DATA_ERROR`, `ORPHAN_SHIPMENT` — sửa số liệu, không có đồng nào chảy vào.
 *
 * Ngày nào đo được những định nghĩa đó thì thêm vào đây, không phải sửa rải rác.
 */
export const RECOVERY_MEASURABLE: Partial<Record<CaseType, string>> = {
  NEW_ORDER_UNPROCESSED: "đơn được xử lý rồi vẫn giao thành công",
  ORDER_CONFIRMATION_STALE: "đơn chốt muộn rồi vẫn giao thành công",
  ORDER_INCOMPLETE: "đơn bổ sung thông tin rồi vẫn giao thành công",
  ORDER_ADDRESS_NOT_NORMALIZED: "đơn sửa địa chỉ rồi vẫn giao thành công",
  DELIVERY_FAILED: "đơn giao hụt rồi phát lại thành công",
  DELIVERY_STALE: "vận đơn treo rồi vẫn giao thành công",
  RISKY_ORDER: "đơn rủi ro vẫn giao thành công",
};

/** Vì sao một loại việc chưa có tỷ lệ đo được. Hiện thẳng lên màn hình, không để trống. */
export type NoRateReason = { type: CaseType; sample: number; note: string };

export type RecoveryRate = {
  type: CaseType;
  /** Tỷ lệ 0–1 đo từ lịch sử. */
  rate: number;
  /** Bao nhiêu việc lịch sử đã đóng được dùng để tính. */
  sample: number;
  /** Trong đó bao nhiêu về đích. */
  recovered: number;
  /** "Cứu được" ở loại việc này nghĩa là gì. */
  basis: string;
};

/**
 * ĐO TỶ LỆ CỨU ĐƯỢC TỪ LỊCH SỬ THẬT.
 *
 * Ba bộ lọc, mỗi cái chặn một cách đo sai:
 *
 *  · `resolution = 'MANUAL'` — chỉ ca CÓ NGƯỜI đóng. Xem phần đầu tệp: đây là khác biệt giữa "xử lý
 *    thì cứu được bao nhiêu" và "đơn từng bị cảnh báo thì kết cục ra sao".
 *  · việc còn mở bị loại — kết quả chưa ngã ngũ, đưa vào mẫu thì kéo tỷ lệ xuống một cách giả tạo.
 *  · đơn còn đang đi bị loại — chưa thuộc về bên nào, xếp vào "không cứu được" là kết tội sớm.
 *
 * Đọc thẳng bảng kết quả đơn đã vật chất hoá — cùng một `ORDER_OUTCOME`, không tự tính lại.
 */
export async function getRecoveryRates(): Promise<Map<CaseType, RecoveryRate>> {
  return memo("impact:recovery-rates", 600_000, async () => {
    const db = await getDb();
    const kinds = Object.entries(KIND_TO_CASE)
      .filter(([, t]) => RECOVERY_MEASURABLE[t])
      .map(([kind]) => kind);
    const out = new Map<CaseType, RecoveryRate>();
    if (!kinds.length) return out;

    const rows = rowsOf<{ kind: string; sample: number; recovered: number }>(
      await db.execute(sql`
        select n.kind,
               count(distinct n.id)::int as sample,
               count(distinct n.id) filter (where m.outcome = 'DELIVERED')::int as recovered
          from notifications n
          join canonical_order_outcome m on m.order_id = n.entity_id and n.entity_type = 'ORDER'
         where n.resolution = 'MANUAL'
           and n.kind in ${kinds}
           -- Đơn còn đang đi CHƯA ngã ngũ. Xếp nó vào "không cứu được" là kết tội sớm và kéo tỷ lệ
           -- xuống một cách giả tạo, đúng lúc người vận hành cần con số này nhất.
           and m.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE','CANCELLED')
         group by n.kind
      `),
    );

    for (const r of rows) {
      const type = KIND_TO_CASE[r.kind];
      const sample = Number(r.sample ?? 0);
      const recovered = Number(r.recovered ?? 0);
      if (!type || sample < CO_MAU_TOI_THIEU) continue;
      out.set(type, { type, rate: recovered / sample, sample, recovered, basis: RECOVERY_MEASURABLE[type] ?? "" });
    }
    return out;
  });
}

export type MoneyImpact = {
  /** SỰ THẬT: tiền đang nằm trong các việc đang mở của khâu này. */
  moneyAtRisk: number;
  /**
   * ƯỚC TÍNH: phần có thể thu về nếu xử lý. `null` = CHƯA ĐO ĐƯỢC, không phải 0.
   * Nói "0đ" khi chưa đủ mẫu là nói dối theo hướng ngược lại.
   */
  estimatedRecoverable: number | null;
  /** Câu giải thích ước tính đến từ đâu — không có nó thì con số không dùng được để ra quyết định. */
  estimateBasis: string | null;
  /** Cỡ mẫu lịch sử đứng sau ước tính. */
  sample: number | null;
  /** Phần tiền nằm ở loại việc CHƯA đo được tỷ lệ — nói ra để người đọc biết ước tính bỏ sót gì. */
  unestimatedAtRisk: number;
};

/**
 * Cộng tác động tiền cho một nhóm việc đang mở.
 *
 * Ước tính cộng theo TỪNG LOẠI việc rồi mới tổng lại — mỗi loại có tỷ lệ cứu riêng, dùng một tỷ lệ
 * trung bình cho cả nhóm sẽ đổi kết quả khi cơ cấu loại việc đổi, dù không có gì thật sự thay đổi.
 */
export function combineImpact(perType: { type: CaseType; amount: number }[], rates: Map<CaseType, RecoveryRate>): MoneyImpact {
  let moneyAtRisk = 0;
  let recoverable = 0;
  let unestimated = 0;
  let sample = 0;
  const bases: string[] = [];

  for (const row of perType) {
    moneyAtRisk += row.amount;
    const r = rates.get(row.type);
    if (!r) {
      unestimated += row.amount;
      continue;
    }
    recoverable += row.amount * r.rate;
    sample += r.sample;
    if (row.amount > 0) bases.push(`${Math.round(r.rate * 100)}% ${r.basis} (${r.sample} ca)`);
  }

  const daDo = moneyAtRisk - unestimated;
  return {
    moneyAtRisk,
    // Không có đồng nào thuộc loại đo được ⇒ CHƯA ĐO ĐƯỢC, không phải "cứu được 0đ".
    estimatedRecoverable: daDo > 0 ? Math.round(recoverable) : null,
    estimateBasis: bases.length ? bases.join(" · ") : null,
    sample: daDo > 0 ? sample : null,
    unestimatedAtRisk: unestimated,
  };
}

export type EstimatorStatus = {
  /** Số ca đã đóng CÓ NGƯỜI bấm — chính là mẫu mà bộ ước lượng ăn vào. */
  manualClosures: number;
  /** Số loại việc đã đủ mẫu để có tỷ lệ. */
  typesReady: number;
  /** Vì sao chưa có ước tính, nói bằng con số. */
  note: string;
};

/**
 * VÌ SAO CHƯA CÓ ƯỚC TÍNH THU HỒI — nói ra, đừng để một ô trống.
 *
 * Ô trống làm người dùng tưởng máy hỏng; câu "cần thêm N ca có người đóng" làm họ hiểu rằng chính
 * việc bấm đóng mỗi ngày sẽ bật con số này lên. Đó là vòng phản hồi, không phải lời xin lỗi.
 */
export async function getEstimatorStatus(): Promise<EstimatorStatus> {
  return memo("impact:estimator-status", 600_000, async () => {
    const db = await getDb();
    const [row] = rowsOf<{ manual: number }>(
      await db.execute(sql`select count(*)::int as manual from notifications where resolution = 'MANUAL'`),
    );
    const manualClosures = Number(row?.manual ?? 0);
    const rates = await getRecoveryRates();
    const typesReady = rates.size;
    const note = typesReady
      ? `Đo trên ${typesReady} loại việc đã đủ mẫu.`
      : manualClosures === 0
        ? "Chưa ca nào được người bấm đóng, nên chưa đo được xử lý thì thu về bao nhiêu. Mỗi lần bấm XONG một việc là góp một mẫu."
        : `Mới có ${manualClosures} ca do người đóng, chưa loại việc nào đủ ${CO_MAU_TOI_THIEU} mẫu để tỷ lệ có nghĩa.`;
    return { manualClosures, typesReady, note };
  });
}
