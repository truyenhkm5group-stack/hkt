import type { ShipmentStage } from "@/db/schema";
import { CARRIER_DOCUMENT_SOURCES, MANUAL_VERIFICATION_SOURCE, sqlSourceList } from "@/lib/constants/truth";

/**
 * ═══════════ MỐC ĐVVC THẬT SỰ CẦM HÀNG (`carrier_handoff_at`) ═══════════
 *
 * Một câu hỏi, và chỉ một: **sớm nhất là lúc nào ta có CHỨNG TỪ rằng đơn vị vận chuyển đã thực sự
 * nhận kiện hàng này?** Mọi thứ khác — đơn được tạo lúc nào, vận đơn được in lúc nào, kho đóng gói
 * xong lúc nào — đều không trả lời câu đó.
 *
 * ─── ĐO TRƯỚC KHI ĐẶT LUẬT (production 13/09/2026, ops `db-query` chỉ đọc) ───
 *
 *   2.108 vận đơn
 *     · 2.083 có mốc theo LUẬT CŨ
 *     · 1.963 có mốc theo luật này
 *     · **120 kiện mất mốc**
 *     · 1.487 có `picked_up_at`; 1.957 có sự kiện chứng minh; 1.101 cái HAI GIÁ TRỊ LỆCH NHAU
 *
 * ─── ĐO LẠI TRƯỚC KHI DEPLOY (cùng ngày, 2.349 vận đơn — kho đã lớn thêm) ───
 *
 * Bản đầu của đoạn này viết "và không kiện nào được thêm". Câu đó SAI, và lượt đo trước deploy đã
 * bắt được: **3 kiện ĐƯỢC THÊM mốc**. Cả ba có đúng một sự kiện, nguồn `VTP_UI_MANUAL_VERIFICATION`
 * chặng `DELIVERED` — chứng từ Viettel Post do người của shop mở trang web đọc rồi chép lại. Luật cũ
 * chỉ nhìn ba nguồn máy (`VTP_WEBHOOK` · `VTP_IMPORT` · `VTP_POLL`) nên không thấy chúng; luật này
 * CÓ nhìn, và một kiện đã giao tới tay khách thì đương nhiên đã từng được bàn giao. Thêm chúng vào
 * là đúng, không phải một lỗ rò.
 *
 * Số đo trước/sau theo kết quả đơn (`canonical_order_outcome`), 2.349 vận đơn:
 *
 *   kết quả       trước   sau   mất mốc   thêm mốc   lệch giờ
 *   DELIVERED       492   492         0          0         31
 *   RETURNED        988   988         0          0         39
 *   IN_TRANSIT      318   212       106          0         15
 *   NOT_SHIPPED     266   190        76          0         28
 *   CANCELLED        14     1        13          0          0
 *   (chưa tính)     271   273         1          3          0
 *
 * **HAI LÔ QUYẾT ĐỊNH MỌI BÁO CÁO — `DELIVERED` và `RETURNED` — KHÔNG ĐỔI MỘT KIỆN NÀO.** Tỷ lệ
 * giao thành công, doanh thu, lương, quảng cáo: tử số và mẫu số y nguyên.
 *
 * 196 kiện rơi ra đều chưa từng được bàn giao. Toàn bộ sự kiện của chúng, không sót một dòng:
 *   119 "Giao cho Bưu tá đi nhận" (104) · 108 "Đơn hàng chờ xử lý" (102) · 181 "Phân công bưu tá
 *   nhận hàng" · 53 "Khách hàng chưa chuẩn bị xong hàng" · 36 "Phối hợp khách hàng xác nhận đơn
 *   hàng" · 9 "Phân công bưu cục nhận hàng" · 2 "Tiếp nhận đơn hàng từ đối tác" · 2 "Đối tác yêu
 *   cầu hủy qua API" (107).
 * Đọc thành lời: bưu tá ĐANG TỚI LẤY, kho CHƯA ĐÓNG XONG, hoặc shop ĐÃ HUỶ. Không dòng nào nói
 * ĐVVC đã cầm hàng.
 *
 * 113 kiện chỉ LỆCH GIỜ (không đổi lô): `least()` lấy chứng cứ sớm hơn ảnh chụp. Cohort không mất
 * ai, nên báo cáo theo kỳ chỉ dịch vài mốc trong cùng một lô.
 *
 * ─── LỖI THỨ NHẤT: "CÓ SỰ KIỆN" BỊ HIỂU THÀNH "ĐÃ BÀN GIAO" ───
 *
 * Luật cũ nhận mọi sự kiện `normalized_stage is not null` làm bậc dự phòng. Nhưng `PENDING` và
 * `CANCELLED` KHÔNG phải `null` — nên những mã này lọt vào làm mốc bàn giao:
 *
 *   100 "Tiếp nhận đơn hàng"          103/104 "Điều phối bưu cục / bưu tá lấy hàng"
 *   102 "Lấy hàng thất bại"           106 "Đối tác yêu cầu lấy lại hàng"
 *   101 "Viettel Post hủy lấy hàng"   107 "Đối tác yêu cầu hủy qua API"   201 "VTP hủy đơn"
 *
 * Đọc thành lời: một kiện mà bưu tá tới lấy KHÔNG THÀNH CÔNG, hoặc shop đã HUỶ LẤY, vẫn được đóng
 * dấu "đã bàn giao cho ĐVVC" và đi thẳng vào lô hàng "Đã gửi" của tuần đó. Đó là 120 kiện đo được
 * ở trên. Chúng làm mẫu số của tỷ lệ giao thành công phình ra bằng những kiện chưa bao giờ rời kho.
 *
 * ─── ĐIỀU GIẢ THUYẾT BAN ĐẦU ĐÃ SAI, VÀ SỐ ĐO ĐÃ SỬA NÓ ───
 *
 * Cột `shipments.picked_up_at` có HAI người ghi: `viettelpost/state.ts` dựng nó từ sự kiện ĐVVC,
 * còn `pancake/sync.ts` ghi `pickedUpAt: s.pickedUpAt ?? existing?.pickedUpAt` — tức giá trị của
 * Pancake đứng TRƯỚC giá trị đang lưu. Nhìn vào đó, giả thuyết hợp lý là cột này bị Pancake làm
 * bẩn, nên sự kiện ĐVVC phải được xếp trên nó.
 *
 * Số đo nói ngược lại. Trong 1.101 vận đơn mà hai giá trị lệch nhau:
 *
 *   1.040 có `picked_up_at` SỚM HƠN sự kiện đầu tiên — và **1.039 trong số đó sớm hơn MỌI sự
 *         kiện ĐVVC của chính vận đơn đó**. Cả 1.040 đều được dựng từ TỆP NHẬP (`VTP_IMPORT`),
 *         956 cái chưa từng có một gói tin webhook nào.
 *      61 có `picked_up_at` muộn hơn.
 *
 *   Độ lệch: trung vị 88,9 giờ · p90 209,9 giờ · lớn nhất 401,3 giờ.
 *
 * Đọc thành lời: với những vận đơn dựng lại từ tệp nhập, lịch sử sự kiện BẮT ĐẦU SAU khi hàng đã
 * được lấy — tệp nhập là một ảnh chụp trạng thái, không phải toàn bộ hành trình. Ở đó
 * `picked_up_at` giữ đúng mốc lấy hàng thật, còn sự kiện sớm nhất chỉ là lần quét trung chuyển đầu
 * tiên còn lưu được. Xếp sự kiện lên trên sẽ đẩy mốc bàn giao của 1.040 kiện MUỘN ĐI trung bình
 * gần bốn ngày — một bước lùi, không phải một bản sửa.
 *
 * Và `picked_up_at` không hề gắn bừa: cả 120 kiện chưa có chứng cứ bàn giao đều KHÔNG có
 * `picked_up_at`. Cột này chưa lần nào nói "đã lấy" về một kiện chưa được lấy.
 *
 * ─── NÊN: SỚM NHẤT THẮNG, KHÔNG PHẢI BẬC NÀO THẮNG ───
 *
 * Câu hỏi là "SỚM NHẤT khi nào ta có chứng cứ", nên phép toán đúng là `least()` trên các chứng cứ
 * CÓ THẬT, không phải `coalesce()` theo một thứ tự bậc do người viết code chọn. Mọi thứ trong tập
 * chứng cứ đều có gốc từ ĐVVC: sự kiện là chứng từ trực tiếp, `picked_up_at` là mốc lấy hàng của
 * ĐVVC được chuyển tiếp qua khâu đồng bộ.
 *
 * `basis` ghi lại nguồn nào ĐÃ ĐẠT mốc sớm nhất đó, để màn hình nói được vì sao nó tin — và để
 * đếm được bao nhiêu kiện đang dựa vào bậc yếu nhất.
 *
 * So với luật cũ, `least()` chỉ đổi mốc của 61 vận đơn (những cái có chứng cứ sớm hơn ảnh chụp) và
 * bỏ mốc của 120 vận đơn chưa từng được bàn giao. Đó là toàn bộ thay đổi — không phải 1.101.
 *
 * ─── VÀ KHÔNG CÓ NGUỒN THỨ TƯ ───
 *
 * `orders.inserted_at` · `shipments.created_at` · trạng thái Pancake "đã gửi" · `cod_status` ·
 * bất kỳ chứng từ TIỀN nào — tất cả CỐ Ý không được dùng. Ba cái đầu là mốc của ERP hoặc của người
 * bán bấm nút, không phải của ĐVVC. Cái cuối là chiều khác hẳn: tiền không nói gì về việc ai đang
 * giữ gói hàng (`docs/business-rules/ORDER_OUTCOME.md`).
 *
 * Không đủ chứng cứ ⇒ `NULL` ⇒ kiện nằm NGOÀI cohort, và số kiện rơi ra được in ra bên cạnh. Một
 * con số thiếu mà BIẾT là thiếu thì dùng được; một con số đầy đủ giả thì không.
 */

/**
 * Chặng chứng minh ĐVVC ĐÃ cầm hàng. Bằng đúng `LEFT_WAREHOUSE_EVENT_STAGES` của vòng đời care —
 * cùng một câu hỏi thì phải cùng một danh sách, nếu không một kiện "đã gửi" ở báo cáo này lại
 * "chưa gửi" ở báo cáo kia.
 *
 * `RETURNING` / `RETURNED` NẰM TRONG danh sách: hàng không thể quay về nếu chưa từng được lấy đi.
 * Mốc lấy từ chúng muộn hơn sự thật, nhưng nó vẫn là chứng cứ rằng việc bàn giao ĐÃ xảy ra — và
 * phép lấy sớm nhất chỉ dùng tới chúng khi không còn chứng cứ nào sớm hơn.
 *
 * KHÔNG có `PENDING` (chờ lấy · đang điều phối · LẤY THẤT BẠI), KHÔNG có `CANCELLED` (shop huỷ
 * lấy · VTP huỷ · tiêu huỷ), KHÔNG có `UNKNOWN`.
 */
export const CARRIER_HANDOFF_STAGES: readonly ShipmentStage[] = [
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RETURNING",
  "RETURNED",
] as const;

/** Bậc chứng cứ đã dùng để kết luận mốc bàn giao. `NONE` = chưa đủ căn cứ, KHÔNG phải "chưa gửi". */
export type HandoffBasis = "CARRIER_DOCUMENT" | "MANUAL_DOCUMENT" | "PICKUP_SNAPSHOT" | "NONE";

export const HANDOFF_BASIS_LABEL: Record<HandoffBasis, string> = {
  CARRIER_DOCUMENT: "Chứng từ ĐVVC",
  MANUAL_DOCUMENT: "Chép tay từ trang ĐVVC",
  PICKUP_SNAPSHOT: "Mốc lấy hàng trên vận đơn",
  NONE: "Chưa có chứng cứ bàn giao",
};

export const HANDOFF_BASIS_HINT: Record<HandoffBasis, string> = {
  CARRIER_DOCUMENT: "Sự kiện đến thẳng hệ thống Viettel Post (webhook · tệp bảng kê · tra API). Mốc là giờ sự kiện của ĐVVC.",
  MANUAL_DOCUMENT: "Người của shop mở trang Viettel Post, đọc trạng thái rồi chép lại. Là chứng từ của ĐVVC qua tay người.",
  PICKUP_SNAPSHOT: "Mốc lấy hàng đã lưu trên vận đơn, sớm hơn mọi sự kiện còn giữ được. Thường gặp ở vận đơn dựng lại từ tệp nhập: tệp là ảnh chụp trạng thái nên lịch sử sự kiện bắt đầu sau lúc lấy hàng.",
  NONE: "Chưa có chứng từ nào nói ĐVVC đã cầm kiện này. KHÔNG kết luận là chưa gửi — chỉ là chưa biết.",
};

/** Nguồn nào được coi là đủ để đưa kiện vào cohort "Đã gửi". Cả ba bậc có mốc đều được. */
export const HANDOFF_KNOWN: readonly HandoffBasis[] = ["CARRIER_DOCUMENT", "MANUAL_DOCUMENT", "PICKUP_SNAPSHOT"] as const;

const STAGE_LIST = CARRIER_HANDOFF_STAGES.map((s) => `'${s}'`).join(",");
const DOC_SOURCES = sqlSourceList(CARRIER_DOCUMENT_SOURCES);
const MANUAL_SOURCES = sqlSourceList([MANUAL_VERIFICATION_SOURCE, "MANUAL"]);
const ALL_SOURCES = sqlSourceList([...CARRIER_DOCUMENT_SOURCES, MANUAL_VERIFICATION_SOURCE, "MANUAL"]);

/**
 * MỘT LƯỢT QUÉT, HAI CON SỐ.
 *
 * Cách viết hiển nhiên là hai truy vấn con — một cho chứng từ máy, một cho bản chép tay — rồi
 * `least()` chúng lại. Nhưng biểu thức này nằm trong `where` của những báo cáo chạy trên toàn bộ
 * vận đơn, nên mỗi truy vấn con là một lượt quét cho MỖI DÒNG. Kho mã này đã gặp đúng kiểu hỏng
 * đó một lần (bản 13/09: một biểu thức tự nhân bản năm lượt, câu lệnh phình lên 180 KB).
 *
 * `min(...) filter (where ...)` cho cả hai con số trong MỘT lượt quét. Và khi không có dòng sự
 * kiện nào khớp, truy vấn con tổng hợp vẫn trả về ĐÚNG MỘT DÒNG toàn `NULL` — nhờ vậy
 * `least(NULL, NULL, picked_up_at)` vẫn ra mốc lấy hàng, đúng như khi viết rời.
 *
 * Dùng TÊN BẢNG ĐẦY ĐỦ `"shipments"` chứ không phải bí danh `s`: Drizzle phát ra tên bảng thật
 * trong câu lệnh, nên một chuỗi SQL thô mang bí danh sẽ hỏng với "missing FROM-clause entry".
 */
const EVIDENCE = `(select
    min(e.occurred_at) filter (where e.source in (${DOC_SOURCES})) as doc_at,
    min(e.occurred_at) filter (where e.source in (${MANUAL_SOURCES})) as manual_at
  from shipment_events e
  where e.shipment_id = "shipments"."id"
    and e.source in (${ALL_SOURCES})
    and e.normalized_stage::text in (${STAGE_LIST}))`;

/**
 * MỐC BÀN GIAO CHUẨN — SỚM NHẤT trong các chứng cứ CÓ THẬT.
 *
 * `least()` của Postgres BỎ QUA `NULL` (khác `min()` theo dòng), nên kiện chỉ có một loại chứng cứ
 * vẫn ra đúng chứng cứ đó, và kiện không có cái nào ra `NULL`.
 */
export const CARRIER_HANDOFF_AT_SQL = `(select least(ev.doc_at, ev.manual_at, "shipments"."picked_up_at") from ${EVIDENCE} ev)`;

/**
 * ĐÃ CÓ CHỨNG TỪ BÀN GIAO CHƯA — dạng BOOLEAN, cùng một câu hỏi với `CARRIER_HANDOFF_AT_SQL`.
 *
 * `ORDER_OUTCOME` chỉ cần biết CÓ hay KHÔNG, không cần biết lúc nào. Viết `(...) is not null` quanh
 * biểu thức mốc ở trên cũng ra đúng kết quả, nhưng nó bắt Postgres chạy `min()` trên toàn bộ sự
 * kiện của kiện rồi mới so `NULL` — trong khi `exists` dừng ngay ở dòng khớp đầu tiên. Biểu thức
 * này nằm trong `where` của những báo cáo quét cả kho vận đơn, nên khác biệt đó có thật.
 *
 * Danh sách chặng và danh sách nguồn LẤY TỪ CÙNG hằng số với biểu thức mốc, nên không có đường nào
 * để hai câu trả lời lệch nhau: sửa `CARRIER_HANDOFF_STAGES` là cả hai đổi theo.
 *
 * `picked_up_at` nằm trong phép hoặc vì nó là mốc lấy hàng của ĐVVC được chuyển tiếp qua khâu đồng
 * bộ — cùng tập chứng cứ mà `least()` ở trên dùng.
 */
export const CARRIER_HANDOFF_KNOWN_SQL = `("shipments"."picked_up_at" is not null or exists (
  select 1 from shipment_events e
  where e.shipment_id = "shipments"."id"
    and e.source in (${ALL_SOURCES})
    and e.normalized_stage::text in (${STAGE_LIST})
))`;

/**
 * Nguồn nào ĐẠT mốc sớm nhất. Bằng nhau thì chứng từ máy thắng — nó giải thích được, còn ảnh chụp
 * thì không mang theo xuất xứ của chính nó.
 *
 * Tính `least()` MỘT LẦN trong lớp lồng rồi so lại, thay vì viết `least(...)` ở từng vế `when`.
 */
export const CARRIER_HANDOFF_BASIS_SQL = `(select case
    when x.at is null then 'NONE'
    when x.doc_at = x.at then 'CARRIER_DOCUMENT'
    when x.manual_at = x.at then 'MANUAL_DOCUMENT'
    else 'PICKUP_SNAPSHOT'
  end
  from (select ev.doc_at, ev.manual_at, least(ev.doc_at, ev.manual_at, "shipments"."picked_up_at") as at from ${EVIDENCE} ev) x)`;

export type HandoffEvent = {
  source: string;
  /** Chặng ĐÃ quy đổi theo chiều (`leg_type`) nếu nơi gọi có quy đổi; chưa quy đổi cũng cho cùng kết quả. */
  normalizedStage: ShipmentStage | null;
  occurredAt: Date | null;
};

export type HandoffVerdict = { at: Date | null; basis: HandoffBasis };

const DOC_SET = new Set<string>(CARRIER_DOCUMENT_SOURCES);
const MANUAL_SET = new Set<string>([MANUAL_VERIFICATION_SOURCE, "MANUAL"]);
const STAGE_SET = new Set<string>(CARRIER_HANDOFF_STAGES);

/**
 * BẢN SINH ĐÔI BẰNG TYPESCRIPT của biểu thức SQL ở trên.
 *
 * Hàm THUẦN: cùng tập sự kiện ⇒ cùng kết quả, không phụ thuộc thứ tự gọi, không phụ thuộc số lần
 * gọi. Nhờ vậy phát lại một gói tin webhook mười lần vẫn ra đúng một mốc — kiểm thử chứng minh
 * điều đó thay vì tin lời.
 */
export function carrierHandoffFrom(events: readonly HandoffEvent[], pickedUpAt: Date | null): HandoffVerdict {
  const soonest = (allowed: Set<string>): number | null => {
    let best: number | null = null;
    for (const e of events) {
      if (!allowed.has(e.source)) continue;
      if (!e.normalizedStage || !STAGE_SET.has(e.normalizedStage)) continue;
      if (!(e.occurredAt instanceof Date) || !Number.isFinite(e.occurredAt.getTime())) continue;
      const t = e.occurredAt.getTime();
      if (best === null || t < best) best = t;
    }
    return best;
  };

  const doc = soonest(DOC_SET);
  const manual = soonest(MANUAL_SET);
  const snap = pickedUpAt instanceof Date && Number.isFinite(pickedUpAt.getTime()) ? pickedUpAt.getTime() : null;

  // Thứ tự trong mảng CHÍNH LÀ luật phá hoà: bằng nhau thì chứng từ máy thắng ảnh chụp.
  const candidates: { at: number; basis: HandoffBasis }[] = [];
  if (doc !== null) candidates.push({ at: doc, basis: "CARRIER_DOCUMENT" });
  if (manual !== null) candidates.push({ at: manual, basis: "MANUAL_DOCUMENT" });
  if (snap !== null) candidates.push({ at: snap, basis: "PICKUP_SNAPSHOT" });
  if (!candidates.length) return { at: null, basis: "NONE" };

  let win = candidates[0];
  for (const c of candidates) if (c.at < win.at) win = c;
  return { at: new Date(win.at), basis: win.basis };
}
