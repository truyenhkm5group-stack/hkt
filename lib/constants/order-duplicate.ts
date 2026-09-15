/**
 * ═══════════ ĐƠN TRÙNG: MÁY CHỈ ĐƯỢC NGHI, NGƯỜI MỚI ĐƯỢC QUYẾT ═══════════
 *
 * ─── ĐÃ RÀ TRƯỚC KHI VIẾT ───
 *
 * ERP đã có dò trùng ở ba chỗ, và không chỗ nào nói về ĐƠN HÀNG:
 *   · `cs-duplicate-actionable-customer` — một khách chiếm nhiều dòng trong hàng đợi CSKH;
 *   · `return-duplicate-receipt` — một kiện hoàn được lập phiếu hai lần;
 *   · khoá chống trùng của cảnh báo (`dedupeKey`) — một sự việc không sinh hai thông báo.
 * Đây là luật thứ tư, cho một câu hỏi chưa ai hỏi: **hai đơn này có phải cùng một lần mua không.**
 *
 * ─── VÌ SAO MÁY KHÔNG ĐƯỢC TỰ GỘP HAY TỰ HUỶ ───
 *
 * Hai lý do, và cả hai đều dứt khoát:
 *
 *  1. **Huỷ nhầm là mất một đơn THẬT của một khách THẬT.** Cùng một người, cùng một mẫu, đặt hai
 *     lần trong một ngày là chuyện có thật — mua cho mình và mua cho em gái. Máy không phân biệt
 *     được, và cái giá của việc đoán sai đổ lên đầu khách.
 *  2. **ERP không ghi ngược vào Pancake.** API Pancake không có `update-order` (AGENTS.md mục
 *     3.11), nên một nút "gộp đơn" ở đây sẽ là nút giả: người bấm tin đã xong, còn POS vẫn giữ
 *     nguyên hai đơn và kho vẫn đóng hai gói.
 *
 * Nên đầu ra của tệp này là một VIỆC PHẢI LÀM ("mở hai đơn, gọi khách hỏi có đặt hai lần không"),
 * không phải một thao tác. Cùng tinh thần với điểm rủi ro trước khi giao: điểm cao không tự huỷ đơn.
 *
 * ─── SO SÁNH THEO MẶT HÀNG, KHÔNG THEO TỔNG TIỀN ───
 *
 * Chủ shop chốt: cùng người nhận + cùng SĐT + **sản phẩm hoặc SKU khác** thì đó là HAI ĐƠN HỢP LỆ.
 * Vì vậy điều kiện quyết định là TẬP MẶT HÀNG, không phải số tiền: hai đơn cùng 499.000đ có thể là
 * hai mẫu khác nhau cùng giá, và gộp chúng là xoá mất một đơn có thật.
 */

/** Tín hiệu quan sát được giữa hai đơn. Mỗi tín hiệu là một SỰ KIỆN, không phải một kết luận. */
export type DuplicateSignalKey =
  /** Chín số cuối của SĐT trùng nhau. Điều kiện CẦN — không có nó thì hai đơn không được so. */
  | "SAME_PHONE"
  /** Tập mặt hàng (mẫu mã × số lượng) giống hệt nhau. */
  | "SAME_ITEMS"
  /** Có mẫu mã chung nhưng không giống hệt — có thể là đặt thêm, có thể là sửa đơn rồi đặt lại. */
  | "ITEMS_OVERLAP"
  /** Tên người nhận giống nhau sau khi bỏ dấu và khoảng trắng thừa. */
  | "SAME_RECEIVER"
  /** Địa chỉ giao giống nhau. */
  | "SAME_ADDRESS"
  /** Tổng tiền sau giảm giá bằng nhau. */
  | "SAME_TOTAL";

export const DUPLICATE_SIGNAL_LABEL: Record<DuplicateSignalKey, string> = {
  SAME_PHONE: "Cùng số điện thoại",
  SAME_ITEMS: "Cùng mẫu mã và số lượng",
  ITEMS_OVERLAP: "Có mẫu mã chung",
  SAME_RECEIVER: "Cùng tên người nhận",
  SAME_ADDRESS: "Cùng địa chỉ giao",
  SAME_TOTAL: "Cùng tổng tiền",
};

/**
 * BA KẾT LUẬN, VÀ RANH GIỚI GIỮA CHÚNG LÀ TẬP MẶT HÀNG.
 *
 *  · `DUPLICATE_SUSPECTED` — tập mặt hàng GIỐNG HỆT. Đây là nhóm đáng gọi khách ngay.
 *  · `POSSIBLE_DUPLICATE`  — mặt hàng chồng lấn một phần. Người phải đọc rồi quyết; máy cố ý không
 *                            đoán, vì "đặt thêm một cái nữa" và "đặt lại vì gõ sai" trông y hệt nhau.
 *  · `DISTINCT`            — không mẫu mã nào chung. Theo luật của chủ shop, đây là HAI ĐƠN HỢP LỆ
 *                            và KHÔNG được báo trùng. Kết luận này được trả về (chứ không lặng lẽ
 *                            bỏ qua) để màn hình nói được "đã xét và đây không phải trùng".
 */
export const DUPLICATE_VERDICTS = ["DUPLICATE_SUSPECTED", "POSSIBLE_DUPLICATE", "DISTINCT"] as const;
export type DuplicateVerdict = (typeof DUPLICATE_VERDICTS)[number];

export const DUPLICATE_VERDICT_LABEL: Record<DuplicateVerdict, string> = {
  DUPLICATE_SUSPECTED: "Nghi trùng",
  POSSIBLE_DUPLICATE: "Có thể trùng · người xem",
  DISTINCT: "Hai đơn khác nhau",
};

export const DUPLICATE_VERDICT_TONE: Record<DuplicateVerdict, string> = {
  DUPLICATE_SUSPECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  POSSIBLE_DUPLICATE: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  DISTINCT: "bg-muted text-muted-foreground",
};

export const DUPLICATE_VERDICT_ACTION: Record<DuplicateVerdict, string> = {
  DUPLICATE_SUSPECTED:
    "Mở CẢ HAI đơn, gọi khách hỏi có cố ý đặt hai lần không. Khách xác nhận chỉ đặt một lần thì huỷ đơn ĐẶT SAU trên Pancake và ghi lý do — ERP không tự huỷ, và không ghi ngược vào POS được.",
  POSSIBLE_DUPLICATE:
    "Đọc hai đơn cạnh nhau. Mẫu mã chồng lấn một phần thường là khách đặt thêm, hoặc nhân viên sửa đơn bằng cách tạo đơn mới. Xác nhận với khách trước khi đóng gói — đừng đoán.",
  DISTINCT: "Không cần làm gì. Cùng khách nhưng khác mẫu mã là hai đơn hợp lệ.",
};

/**
 * ĐƠN NÀO LÀ "BẢN GỐC".
 *
 * Chủ shop chốt: **ưu tiên đơn đặt trước**. Nên đơn có `inserted_at` sớm hơn là `keeper` (bản giữ),
 * đơn còn lại là `suspect` (bản nghi). Bằng giờ thì lấy `id` nhỏ hơn làm bản giữ — không phải vì nó
 * đúng hơn, mà vì kết quả phải ỔN ĐỊNH: chạy hai lần ra hai đáp án khác nhau thì không ai tin được
 * cái nào, và một luật phá hoà tuỳ tiện còn hơn không có luật nào.
 *
 * `keeper` KHÔNG có nghĩa là đơn kia sai. Nó chỉ nói "nếu hoá ra là trùng thật thì giữ cái này".
 */
export type DuplicatePair<T extends { orderId: string; insertedAt: Date }> = { keeper: T; suspect: T };

export function orderPair<T extends { orderId: string; insertedAt: Date }>(a: T, b: T): DuplicatePair<T> {
  const ta = a.insertedAt.getTime();
  const tb = b.insertedAt.getTime();
  if (ta !== tb) return ta < tb ? { keeper: a, suspect: b } : { keeper: b, suspect: a };
  return a.orderId <= b.orderId ? { keeper: a, suspect: b } : { keeper: b, suspect: a };
}

/**
 * ═══ CỬA SỔ THỜI GIAN ═══
 *
 * Trùng do thao tác (khách bấm hai lần, nhân viên lên đơn hai lần, chat và landing cùng tạo đơn)
 * xảy ra trong vài giờ tới vài ngày. Cùng một khách mua lại cùng một mẫu sau ba tuần là KHÁCH QUAY
 * LẠI — thứ shop muốn có thêm, không phải thứ cần cảnh báo.
 *
 * 48 giờ là GIẢ THIẾT, chưa kiểm định trên phân bố thật của shop. Sửa được qua `settings`.
 */
export const DUPLICATE_WINDOW_HOURS = 48;
export const DUPLICATE_SETTING_KEY = "orders.duplicate-rule";

export type DuplicateRule = {
  windowHours: number;
  /** Bật/tắt toàn bộ luật. Tắt thì hàng đợi rỗng và màn hình nói rõ là đã tắt, không nói là sạch. */
  enabled: boolean;
};

export const DEFAULT_DUPLICATE_RULE: DuplicateRule = { windowHours: DUPLICATE_WINDOW_HOURS, enabled: true };

/* ═══════════════════ CHUẨN HOÁ ĐỂ SO SÁNH ═══════════════════ */

/**
 * CHÍN SỐ CUỐI của số điện thoại — đúng quy ước đang dùng ở chấm rủi ro trước khi giao
 * (`RISK_SIGNALS.CUSTOMER_RETURN_HISTORY.source`). Chín số vì đầu số Việt Nam có cả dạng `0…` lẫn
 * `84…`, và hai dạng đó là CÙNG một thuê bao.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Bỏ dấu, gộp khoảng trắng, hạ chữ thường. Dùng cho tên người nhận và địa chỉ. */
export function textKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * KHOÁ CỦA MỘT MẶT HÀNG. Ưu tiên `variant_id` (khoá thật), rồi `sku`, rồi tên + mô tả phân loại.
 *
 * Bậc cuối cùng là bậc YẾU và phải khai ra: đơn từ landing page thường chưa ghép được mẫu mã, nên
 * so bằng chữ là cách duy nhất còn lại. `weak` đi kèm để kết luận hạ xuống `POSSIBLE_DUPLICATE`
 * thay vì `DUPLICATE_SUSPECTED` — nghi ngờ dựa trên một ô chữ không đủ để gọi là nghi trùng chắc.
 */
export type ItemLike = { variantId: string | null; sku: string; productName: string; variationDetail: string; quantity: number };

export function itemKey(item: ItemLike): { key: string; weak: boolean } {
  if (item.variantId) return { key: `v:${item.variantId}`, weak: false };
  if (item.sku.trim()) return { key: `s:${item.sku.trim().toLowerCase()}`, weak: false };
  return { key: `t:${textKey(item.productName)}|${textKey(item.variationDetail)}`, weak: true };
}

/** Tập mặt hàng dạng so sánh được: mẫu mã → tổng số lượng. Cộng dồn dòng trùng mẫu trong cùng đơn. */
export function itemMultiset(items: readonly ItemLike[]): { set: Map<string, number>; weak: boolean } {
  const set = new Map<string, number>();
  let weak = false;
  for (const it of items) {
    const { key, weak: w } = itemKey(it);
    if (w) weak = true;
    set.set(key, (set.get(key) ?? 0) + Math.max(0, it.quantity));
  }
  return { set, weak };
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function overlaps(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const k of a.keys()) if (b.has(k)) return true;
  return false;
}

/* ═══════════════════ KẾT LUẬN ═══════════════════ */

export type DuplicateCandidate = {
  orderId: string;
  insertedAt: Date;
  phone: string;
  receiverName: string;
  address: string;
  total: number;
  items: ItemLike[];
};

export type DuplicateAssessment = {
  verdict: DuplicateVerdict;
  signals: DuplicateSignalKey[];
  /** Câu giải thích đọc được, dựng từ chính các tín hiệu — không phải một chuỗi viết tay song song. */
  why: string;
};

/**
 * SO HAI ĐƠN. Hàm THUẦN, đối xứng (đổi chỗ hai tham số ra cùng kết luận), không đọc CSDL.
 *
 * Điều kiện CẦN là cùng SĐT. Không có SĐT (hoặc SĐT quá ngắn để nhận dạng) ⇒ `DISTINCT`: ERP
 * KHÔNG dò trùng bằng tên, vì trùng tên ở Việt Nam là chuyện thường ngày và một luật dò theo tên
 * sẽ gán "nghi trùng" cho hai người xa lạ.
 */
export function assessDuplicate(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateAssessment {
  const keyA = phoneKey(a.phone);
  const keyB = phoneKey(b.phone);
  if (!keyA || keyA !== keyB) {
    return { verdict: "DISTINCT", signals: [], why: "Khác số điện thoại — hai đơn của hai người." };
  }

  const signals: DuplicateSignalKey[] = ["SAME_PHONE"];
  const ma = itemMultiset(a.items);
  const mb = itemMultiset(b.items);
  const giongHet = ma.set.size > 0 && sameMultiset(ma.set, mb.set);
  const chongLan = !giongHet && overlaps(ma.set, mb.set);

  if (giongHet) signals.push("SAME_ITEMS");
  else if (chongLan) signals.push("ITEMS_OVERLAP");

  if (textKey(a.receiverName) && textKey(a.receiverName) === textKey(b.receiverName)) signals.push("SAME_RECEIVER");
  if (textKey(a.address) && textKey(a.address) === textKey(b.address)) signals.push("SAME_ADDRESS");
  if (a.total > 0 && a.total === b.total) signals.push("SAME_TOTAL");

  const mo = (v: DuplicateVerdict, why: string): DuplicateAssessment => ({ verdict: v, signals, why });

  // LUẬT CỦA CHỦ SHOP, ĐẶT TRƯỚC MỌI TÍN HIỆU KHÁC: khác mẫu mã ⇒ hai đơn hợp lệ. Không có tổ hợp
  // tên + địa chỉ + tiền nào được phép lật ngược điều này.
  if (!giongHet && !chongLan) {
    return mo("DISTINCT", "Cùng khách nhưng KHÔNG chung mẫu mã nào — theo luật của shop, đây là hai đơn hợp lệ.");
  }

  if (giongHet) {
    // Mẫu mã chỉ khớp được bằng Ô CHỮ (đơn chưa ghép mẫu mã, thường là landing) ⇒ hạ một bậc.
    if (ma.weak || mb.weak) {
      return mo(
        "POSSIBLE_DUPLICATE",
        "Cùng SĐT và cùng mặt hàng, nhưng mặt hàng chỉ khớp được bằng TÊN chứ chưa ghép được mẫu mã — chưa đủ chắc để gọi là nghi trùng.",
      );
    }
    return mo("DUPLICATE_SUSPECTED", "Cùng SĐT, cùng mẫu mã và cùng số lượng, đặt sát nhau.");
  }

  return mo("POSSIBLE_DUPLICATE", "Cùng SĐT và có mẫu mã chung nhưng không giống hệt — có thể là đặt thêm, có thể là lên đơn lại.");
}
