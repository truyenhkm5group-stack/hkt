/**
 * ═══════════ GHI QUAN SÁT LÝ DO HOÀN — MỘT CỬA CHO CẢ BACKFILL LẪN WEBHOOK ═══════════
 *
 * ─── VÌ SAO PHẢI CHUNG MỘT TỆP ───
 *
 * Hai đường sinh ra quan sát: lượt rút từ dữ liệu cũ (`scripts/return-reason-backfill.ts`) và
 * webhook Viettel Post gửi tới hàng ngày. Nếu chúng dựng khoá chống trùng theo hai cách khác nhau
 * thì cùng một sự kiện sẽ nằm HAI dòng — và mọi phép đếm độ phủ nói quá lên mà không ai thấy, vì
 * hai dòng ấy trông hoàn toàn hợp lệ.
 *
 * ─── KHOÁ LÀ NỘI DUNG, KHÔNG PHẢI SỐ THỨ TỰ ───
 *
 * `kiện · nguồn · mốc · vân tay chữ`. Viettel Post thử lại tối đa 5 lần cho một webhook, và lượt
 * rút chạy lại sau khi bổ sung nguồn mới — cả hai đều phải là không-thao-tác.
 *
 * ─── KHÔNG SUY LÝ DO TỪ TRẠNG THÁI CHUNG ───
 *
 * `dangGhiQuanSat` là bộ lọc CƠ HỌC: bỏ chuỗi rỗng, chuỗi quá ngắn để mang nghĩa, và câu chỉ nói
 * BƯỚC ĐI của kiện ("đang chuyển hoàn", "nhận hàng từ bưu cục"). Mọi thứ còn lại được LƯU, kể cả
 * khi chưa xếp được — "có người viết gì đó mà ta chưa đọc" là một việc phải làm, không phải một
 * khoảng trống.
 */
import { createHash } from "node:crypto";
import type { Db } from "@/db";
import { schema } from "@/db";
import { boDau, RETURN_STEP_NOT_REASON } from "@/lib/constants/return-reason";
import { classifyRaw } from "@/lib/returns/reason-classify";
import { SOURCE_IS_HUMAN, type ReasonSource } from "@/lib/constants/return-reason-source";

export type QuanSatMoi = {
  shipmentId: string | null;
  orderId: string | null;
  source: ReasonSource;
  rawText: string;
  occurredAt: Date;
  sourceRef: string;
  /**
   * QUY KẾT ĐI BẰNG KHOÁ TÀI KHOẢN (AGENTS.md mục 34). `null` là HỢP LỆ và có nghĩa rõ ràng — MÁY
   * rút ra, khác hẳn "chưa biết ai". Ô chữ `actorEmail` chỉ là ảnh chụp tên để người đọc.
   */
  actorId?: string | null;
  actorEmail?: string;
  /** Mã lý do có cấu trúc của ĐVVC, nếu gói tin mang theo. Thắng phép đọc chữ. */
  vtpCode?: number | null;
};

/** Vân tay chữ: cùng một câu, cùng một kiện, cùng một mốc ⇒ cùng một quan sát. */
export function reasonDedupeKey(q: Pick<QuanSatMoi, "shipmentId" | "orderId" | "source" | "rawText" | "occurredAt">): string {
  const van = createHash("sha256").update(boDau(q.rawText)).digest("hex").slice(0, 16);
  return [q.shipmentId ?? `o:${q.orderId}`, q.source, q.occurredAt.toISOString(), van].join("|");
}

/**
 * ═══ DẤU HIỆU MỘT CÂU ĐANG NÓI VỀ LÝ DO, KHÔNG PHẢI VỀ BƯỚC ĐI ═══
 *
 * Viettel Post gắn tiền tố `Tồn - ` cho mọi trạng thái ngoại lệ ("Tồn - Khách từ chối nhận",
 * "Tồn - Khách hàng nghỉ, không có nhà"). Đó là dấu hiệu CÓ CẤU TRÚC đáng tin nhất trong dữ liệu
 * của họ, và nó tách được đúng hai loại câu.
 */
const DAU_HIEU_LY_DO = ["ton -", "ton-", "ly do", "khach hang yeu cau", "nguoi gui yeu cau"];

/**
 * Chữ này có đáng coi là một quan sát không.
 *
 * ─── VÌ SAO KHÔNG PHẢI "GIỮ MỌI THỨ TRỪ VÀI CÂU BƯỚC ĐI" ───
 *
 * Bản đầu của hàm này giữ mọi chuỗi dài hơn 5 ký tự, trừ ba câu bước đi đã biết. Trên dữ liệu
 * thật, hành trình của một kiện có hàng chục dòng và gần hết là bước đi ("Đang chuyển hoàn",
 * "Nhận hàng từ bưu cục", "Đã tới bưu cục phát") — KHÔNG câu nào trong số đó khớp ba mẫu ấy.
 *
 * Hậu quả nếu để nguyên: mỗi bước đi thành một dòng "có chứng từ, chưa xếp được", và màn hình độ
 * phủ bảo nhân viên "mở chữ ra đọc rồi chọn lý do" cho hàng nghìn ca KHÔNG CÓ GÌ ĐỂ ĐỌC. Một hàng
 * đợi toàn việc giả là hàng đợi bị bỏ, và nó kéo theo cả những việc thật nằm cùng chỗ.
 *
 * Nên luật đảo chiều: GIỮ khi có căn cứ, bỏ khi không — ba căn cứ, mỗi cái đứng độc lập:
 *
 *   1. XẾP ĐƯỢC ngay ⇒ đây đúng là một lý do;
 *   2. mang DẤU HIỆU lý do của ĐVVC (`Tồn - …`) ⇒ họ đang khai một ngoại lệ, dù ta chưa đọc được;
 *   3. do NGƯỜI của shop gõ ⇒ người ta không gõ tay một bước đi; mọi câu họ viết đều đáng giữ.
 *
 * Và bộ lọc bước đi cũ vẫn đứng trước tất cả: "Tồn - Thông báo chuyển hoàn bưu cục gốc" mang dấu
 * hiệu ở căn cứ 2 nhưng vẫn chỉ nói kiện đang trên đường về.
 *
 * ─── `source` BẮT BUỘC, CỐ Ý ───
 *
 * Bản nháp để `source` tuỳ chọn với mặc định `CARRIER_TEXT`. Lượt rút quan sát gọi thiếu nó ở năm
 * chỗ, nên MỌI ghi chú của nhân viên bị chấm như chữ ĐVVC — và một câu như "khách bảo vải xù" bị
 * CHẶN, vì lý do ấy chỉ người mới kết luận được. Tức là bộ lọc vứt đi đúng những quan sát giá trị
 * nhất, trong im lặng. Để tham số BẮT BUỘC biến cả lớp lỗi ấy thành lỗi biên dịch.
 */
export function dangGhiQuanSat(text: string, source: ReasonSource, vtpCode?: number | null): boolean {
  const t = text.trim();
  if (t.length < 5) return false;
  const s = boDau(t);
  if (RETURN_STEP_NOT_REASON.some((b) => s.includes(b))) return false;
  // Nguồn do người gõ: giữ tất. Không ai gõ tay một bước đi vào ô ghi chú.
  if (SOURCE_IS_HUMAN[source]) return true;
  if (vtpCode !== null && vtpCode !== undefined) return true;
  if (DAU_HIEU_LY_DO.some((d) => s.includes(d))) return true;
  // Còn lại: chỉ giữ khi bảng luật xếp được. Xếp không được VÀ không có dấu hiệu nào ⇒ bước đi.
  return classifyRaw(text, source, vtpCode).matched;
}

/** Dòng sẵn sàng ghi vào bảng, phân loại đã tính. */
export function dungDongQuanSat(q: QuanSatMoi) {
  const xep = classifyRaw(q.rawText, q.source, q.vtpCode);
  return {
    shipmentId: q.shipmentId,
    orderId: q.orderId,
    source: q.source,
    rawText: q.rawText.slice(0, 1000),
    reasonAtWrite: xep.reason,
    occurredAt: q.occurredAt,
    sourceRef: q.sourceRef.slice(0, 200),
    actorId: q.actorId ?? null,
    actorEmail: q.actorEmail ?? "",
    note: "",
    dedupeKey: reasonDedupeKey(q),
  };
}

/**
 * Ghi một loạt quan sát. Trả về số dòng ĐÃ GỬI (không phải số dòng mới — phần chênh là dòng trùng
 * bị khoá nội dung chặn, và đó chính là hành vi mong muốn).
 *
 * KHÔNG BAO GIỜ được làm hỏng lượt gọi của nó: webhook Viettel Post phải trả HTTP 200 trong dưới
 * một giây, và một quan sát không ghi được là mất một dòng ghi chú — không phải mất một vận đơn.
 * Nơi gọi vì vậy bắt lỗi ở ngoài; ở đây chỉ lo không ghi trùng.
 */
export async function ghiQuanSat(db: Db, ds: QuanSatMoi[]): Promise<number> {
  const loc = ds.filter((q) => (q.shipmentId || q.orderId) && dangGhiQuanSat(q.rawText, q.source, q.vtpCode));
  if (!loc.length) return 0;
  /* Cùng một lượt có thể mang hai dòng trùng khoá — Postgres từ chối cả câu lệnh nếu để lọt. */
  const theoKhoa = new Map(loc.map((q) => [reasonDedupeKey(q), q]));
  const rows = [...theoKhoa.values()].map(dungDongQuanSat);
  await db.insert(schema.returnReasonObservations).values(rows).onConflictDoNothing({ target: schema.returnReasonObservations.dedupeKey });
  return rows.length;
}
