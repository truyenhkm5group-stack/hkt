import { ITEM_CONDITIONS, ITEM_CONDITION_RESTOCKS } from "@/lib/constants/return-lifecycle";
import type { ReturnCondition } from "@/lib/constants/returns-condition";

/**
 * ═══════════ KẾT CỤC CỦA HÀNG HOÀN KHÔNG TÁI NHẬP (Company OS · Agent E) ═══════════
 *
 * Tệp THUẦN — client import được. Lõi ghi ở `lib/returns/disposition.ts`, đọc ở
 * `lib/queries/return-dispositions.ts`.
 *
 * ─── LỖ HỔNG ĐƯỢC LẤP ───
 *
 * Trạm kiểm đếm chỉ cho hàng hoàn HAI lối ra: `OK` ⇒ phiếu tái nhập; mọi kết luận khác ⇒ … không
 * gì cả. Món hỏng, bẩn, sai hàng nằm trên kệ với một dòng ghi chú, không có trạng thái tiếp theo,
 * không có giá trị, không có vết trên sổ nào. Ba tháng sau không ai trả lời được "12 cái áo rách
 * tháng 9 đâu rồi — giặt lại bán, trả xưởng, hay vứt?".
 *
 * ─── NĂM KẾT CỤC, HAI LOẠI ───
 *
 *  · TRẠNG THÁI (không tiêu số lượng): `PENDING_DECISION` (chưa ai quyết) · `REWORK` (đang giặt /
 *    sửa / đóng gói lại). Nói phần CÒN LẠI đang ở đâu.
 *  · KẾT CỤC CUỐI (tiêu số lượng): `RESTOCK_AFTER_REWORK` (làm xong, ĐẾM LẠI, nhập tồn qua phiếu
 *    `RETURN`) · `WRITE_OFF` (huỷ bỏ — ghi GIÁ TRỊ ƯỚC TÍNH, KHÔNG đụng sổ kho vì hàng chưa từng
 *    quay lại tồn) · `RETURN_TO_SUPPLIER` (trả xưởng / nhà cung cấp).
 *
 * Một món hàng (dòng kiểm từng món, hoặc phần "không bán được" của một kiện kiểm cả kiện) có thể đi
 * NHIỀU kết cục cuối: giặt 3 cái, 2 cái sạch nhập lại, 1 cái huỷ. Nên bảng là SỔ GHI THÊM, và phần
 * còn mở = số món − tổng số món đã có kết cục cuối. Phần còn mở mang trạng thái của dòng TRẠNG THÁI
 * gần nhất (mặc định "chưa quyết").
 *
 * ─── BA LUẬT KHÔNG ĐƯỢC NỚI ───
 *
 *  1. HÀNG HOÀN KHÔNG TỰ VÀO TỒN (ORDER_OUTCOME §9, luật 10). `RESTOCK_AFTER_REWORK` chỉ đi SAU
 *     `REWORK` (đã quyết "sửa được"), mang SỐ ĐẾM THỰC TẾ, và đi qua ĐÚNG đường lập phiếu tái nhập
 *     của trạm kiểm (`createRestockReceipt`) — không có đường ghi phiếu thứ hai.
 *  2. HUỶ BỎ KHÔNG GHI SỔ KHO. Hàng chưa từng vào lại tồn thì không có gì để trừ; một phiếu xuất ở
 *     đây là trừ hai lần. Giá trị ghi lại là ƯỚC TÍNH (giá vốn gần nhất), và bản này KHÔNG đưa nó vào
 *     báo cáo lợi nhuận. Huỷ bỏ BẮT BUỘC lý do và đi qua cổng duyệt hai bước `INVENTORY_WRITE_OFF`
 *     có sẵn — không thêm ngưỡng mới.
 *  3. NGƯỜI LÀM CÓ KHOÁ TÀI KHOẢN (luật 34). Không có "máy tự huỷ hàng".
 */

export const RETURN_DISPOSITIONS = ["PENDING_DECISION", "REWORK", "RESTOCK_AFTER_REWORK", "WRITE_OFF", "RETURN_TO_SUPPLIER"] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export function isReturnDisposition(v: unknown): v is ReturnDisposition {
  return typeof v === "string" && (RETURN_DISPOSITIONS as readonly string[]).includes(v);
}

export const DISPOSITION_LABEL: Record<ReturnDisposition, string> = {
  PENDING_DECISION: "Chưa quyết",
  REWORK: "Đang sửa / giặt lại",
  RESTOCK_AFTER_REWORK: "Sửa xong · nhập lại tồn",
  WRITE_OFF: "Huỷ bỏ",
  RETURN_TO_SUPPLIER: "Trả xưởng / nhà cung cấp",
};

/** Nhãn NÚT — người kho nhìn nút, không đọc câu. */
export const DISPOSITION_ACTION_LABEL: Record<ReturnDisposition, string> = {
  PENDING_DECISION: "Để chưa quyết",
  REWORK: "Đưa đi sửa / giặt",
  RESTOCK_AFTER_REWORK: "Sửa xong · nhập lại",
  WRITE_OFF: "Huỷ bỏ",
  RETURN_TO_SUPPLIER: "Trả xưởng",
};

export const DISPOSITION_HINT: Record<ReturnDisposition, string> = {
  PENDING_DECISION: "Món đã kiểm là không bán ngay được nhưng chưa ai quyết đi đâu. Đây là trạng thái mặc định — không cần bấm.",
  REWORK: "Đang giặt / ủi / sửa / đóng gói lại. CHƯA vào tồn: chỉ vào tồn khi làm xong và đếm lại.",
  RESTOCK_AFTER_REWORK: "Làm xong và ĐẾM LẠI được bao nhiêu món bán được. Chỉ số đếm được vào tồn, qua một phiếu tái nhập (RETURN). Phần còn lại vẫn ở đây chờ kết cục.",
  WRITE_OFF: "Không cứu được — huỷ / thanh lý. Bắt buộc lý do. KHÔNG ghi sổ kho (hàng chưa từng vào lại tồn); giá trị ghi lại là ước tính theo giá vốn gần nhất.",
  RETURN_TO_SUPPLIER: "Gửi trả xưởng / nhà cung cấp (lỗi sản xuất). Không vào tồn.",
};

export const DISPOSITION_TONE: Record<ReturnDisposition, "slate" | "amber" | "green" | "rose" | "blue"> = {
  PENDING_DECISION: "amber",
  REWORK: "blue",
  RESTOCK_AFTER_REWORK: "green",
  WRITE_OFF: "rose",
  RETURN_TO_SUPPLIER: "slate",
};

/** Kết cục CUỐI tiêu số lượng; hai trạng thái còn lại chỉ nói phần còn mở đang ở đâu. */
export const TERMINAL_DISPOSITIONS = ["RESTOCK_AFTER_REWORK", "WRITE_OFF", "RETURN_TO_SUPPLIER"] as const satisfies readonly ReturnDisposition[];
export type TerminalDisposition = (typeof TERMINAL_DISPOSITIONS)[number];
export const OPEN_STATES = ["PENDING_DECISION", "REWORK"] as const satisfies readonly ReturnDisposition[];
export type OpenDispositionState = (typeof OPEN_STATES)[number];

export function isTerminalDisposition(d: ReturnDisposition): d is TerminalDisposition {
  return (TERMINAL_DISPOSITIONS as readonly string[]).includes(d);
}

/** Kết cục BẮT BUỘC lý do. Cùng danh sách với CHECK `return_dispositions_note_check` của migration 0136. */
export const DISPOSITION_NEEDS_NOTE: Record<ReturnDisposition, boolean> = {
  PENDING_DECISION: false,
  REWORK: false,
  RESTOCK_AFTER_REWORK: false,
  WRITE_OFF: true,
  RETURN_TO_SUPPLIER: false,
};
export const DISPOSITION_NOTE_MIN = 5;

/**
 * Kết cục cuối được đi TỪ trạng thái nào của phần còn mở.
 *
 * `RESTOCK_AFTER_REWORK` CHỈ từ `REWORK`: kết luận kiểm đã nói "không bán được"; nhập lại mà không
 * qua bước sửa là lật ngược kết luận ấy bằng một cú bấm — đúng đường vòng qua trạm kiểm mà luật
 * "hàng hoàn không tự vào tồn" tồn tại để chặn. Muốn sửa kết luận kiểm thì lập phiếu điều chỉnh.
 */
export const DISPOSITION_ALLOWED_FROM: Record<ReturnDisposition, readonly OpenDispositionState[]> = {
  PENDING_DECISION: ["REWORK"],
  REWORK: ["PENDING_DECISION"],
  RESTOCK_AFTER_REWORK: ["REWORK"],
  WRITE_OFF: ["PENDING_DECISION", "REWORK"],
  RETURN_TO_SUPPLIER: ["PENDING_DECISION", "REWORK"],
};

// ───────────────────────── ĐỐI TƯỢNG CẦN KẾT CỤC ─────────────────────────

/**
 * HAI ĐỘ MỊN, vì trạm kiểm có hai đường ghi:
 *  · `ITEM`   — một dòng `return_inspection_items` mang kết luận KHÔNG cộng tồn và `actual_qty > 0`
 *    (có hàng thật trên bàn). Số món = `actual_qty`. Mẫu mã = mẫu THỰC NHẬN (sai hàng thì là món
 *    khách trả, không phải món đã gửi).
 *  · `PARCEL` — kiện kiểm CẢ KIỆN (đường đếm nhanh / hàng loạt — KHÔNG có dòng từng món) có
 *    `unsellable_qty > 0`. Số món = `unsellable_qty`. Không biết mẫu mã nào ⇒ nhập lại phải CHỌN
 *    mẫu mã trong danh sách hàng kỳ vọng của kiện; huỷ bỏ không biết giá ⇒ giá trị CHƯA BIẾT.
 *
 * Kiện kết luận "Thiếu hàng" cả kiện KHÔNG vào hàng đợi: đường hàng loạt ghi `unsellable_qty` = số
 * KỲ VỌNG cho mọi kết luận không nhận đủ, nên với "thiếu" con số ấy là hàng KHÔNG có mặt. Đưa nó vào
 * là bắt kho quyết số phận cho những món không nằm trên kệ. Số kiện bị loại được đếm và in ra.
 */
export const DISPOSITION_GRAINS = ["ITEM", "PARCEL"] as const;
export type DispositionGrain = (typeof DISPOSITION_GRAINS)[number];

/** Kết luận CẢ KIỆN mà `unsellable_qty` KHÔNG phải hàng có mặt. */
export const PARCEL_CONDITIONS_WITHOUT_GOODS: readonly ReturnCondition[] = ["MISSING"];

/** Kết luận từng món KHÔNG cộng tồn — dẫn xuất từ `ITEM_CONDITION_RESTOCKS`, không phải danh sách thứ hai. */
export const NON_RESTOCK_ITEM_CONDITIONS = ITEM_CONDITIONS.filter((c) => !ITEM_CONDITION_RESTOCKS[c]);

export function subjectKeyOf(grain: DispositionGrain, id: string): string {
  return grain === "ITEM" ? `item:${id}` : `parcel:${id}`;
}

export function parseSubjectKey(key: string): { grain: DispositionGrain; id: string } | null {
  const m = /^(item|parcel):(.+)$/.exec(key.trim());
  if (!m || !m[2]) return null;
  return { grain: m[1] === "item" ? "ITEM" : "PARCEL", id: m[2] };
}

// ───────────────────────── GẬP SỔ GHI THÊM ─────────────────────────

export type DispositionEntry = { disposition: ReturnDisposition; qty: number; createdAt: Date | string; id: string };

export type FoldedDisposition = {
  subjectQty: number;
  restocked: number;
  writtenOff: number;
  returnedToSupplier: number;
  /** Phần CHƯA có kết cục cuối. Không bao giờ âm. */
  remaining: number;
  /** Trạng thái của phần còn mở; `null` khi đã hết phần mở. */
  state: OpenDispositionState | null;
};

/**
 * Hàm THUẦN: sổ ghi thêm → tình trạng hiện tại. Thứ tự theo `(createdAt, id)` để hai lần gập cùng sổ
 * ra cùng kết quả dù CSDL trả dòng theo thứ tự nào.
 */
export function foldDispositions(subjectQty: number, entries: readonly DispositionEntry[]): FoldedDisposition {
  const sorted = [...entries].sort((a, b) => {
    const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  let restocked = 0;
  let writtenOff = 0;
  let returnedToSupplier = 0;
  let state: OpenDispositionState = "PENDING_DECISION";
  for (const e of sorted) {
    if (e.disposition === "RESTOCK_AFTER_REWORK") restocked += e.qty;
    else if (e.disposition === "WRITE_OFF") writtenOff += e.qty;
    else if (e.disposition === "RETURN_TO_SUPPLIER") returnedToSupplier += e.qty;
    else state = e.disposition;
  }
  const remaining = Math.max(0, subjectQty - restocked - writtenOff - returnedToSupplier);
  return { subjectQty, restocked, writtenOff, returnedToSupplier, remaining, state: remaining > 0 ? state : null };
}

export type DispositionRequest = { disposition: ReturnDisposition; qty: number | null; note: string };

/**
 * Kiểm một yêu cầu trên tình trạng đã gập. Trả SỐ MÓN sẽ ghi (trạng thái luôn áp cho TOÀN BỘ phần
 * còn mở), hoặc lý do từ chối bằng tiếng người.
 */
export function checkDispositionRequest(folded: FoldedDisposition, req: DispositionRequest): { ok: true; qty: number } | { error: string } {
  if (!isReturnDisposition(req.disposition)) return { error: `Kết cục không hợp lệ: ${String(req.disposition)}` };
  if (folded.remaining <= 0 || folded.state === null) return { error: "Món này đã có kết cục cuối cho toàn bộ số lượng — không còn gì để quyết." };
  const from = DISPOSITION_ALLOWED_FROM[req.disposition];
  if (!from.includes(folded.state)) {
    if (req.disposition === folded.state) return { error: `Phần còn lại đã ở trạng thái “${DISPOSITION_LABEL[folded.state]}”.` };
    if (req.disposition === "RESTOCK_AFTER_REWORK") return { error: "Chỉ nhập lại được sau khi đã đưa đi sửa / giặt — kết luận kiểm đã nói món này không bán ngay được." };
    return { error: `Không đi được từ “${DISPOSITION_LABEL[folded.state]}” sang “${DISPOSITION_LABEL[req.disposition]}”.` };
  }
  const note = req.note.trim();
  if (DISPOSITION_NEEDS_NOTE[req.disposition] && note.length < DISPOSITION_NOTE_MIN) {
    return { error: `${DISPOSITION_LABEL[req.disposition]} thì phải ghi rõ vì sao (ít nhất ${DISPOSITION_NOTE_MIN} ký tự).` };
  }
  if (!isTerminalDisposition(req.disposition)) return { ok: true, qty: folded.remaining };
  const qty = req.qty === null ? NaN : Math.trunc(req.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Nhập số món ĐẾM ĐƯỢC (ít nhất 1)." };
  if (qty > folded.remaining) return { error: `Chỉ còn ${folded.remaining} món chưa có kết cục — không ghi ${qty}.` };
  return { ok: true, qty };
}

// ───────────────────────── GIÁ TRỊ ƯỚC TÍNH ─────────────────────────

/**
 * Cùng BẬC THANG với `lib/queries/cogs.ts::LINE_UNIT_COST` (phiếu nhập gần nhất → giá vốn trên đơn
 * → giá nhập mẫu mã) nhưng bậc cuối là CHƯA BIẾT, không phải 0 — đúng như
 * `lib/constants/inspection-truth.ts::COST_BASES`. Nhãn dùng lại `COST_BASIS_LABEL` ở đó.
 */
export const DISPOSITION_VALUE_BASIS = "ESTIMATED" as const;
