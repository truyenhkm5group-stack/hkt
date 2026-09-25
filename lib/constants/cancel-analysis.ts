import { assessDuplicate, phoneKey, type DuplicateCandidate } from "@/lib/constants/order-duplicate";

/**
 * ═══════════ ĐƠN HUỶ: MẤT THẬT HAY CHỈ LÀ ĐƠN ĐƯỢC LÊN LẠI ═══════════
 *
 * Chủ shop hỏi (25/09/2026): *"số đơn huỷ trước khi xác nhận đã lọc trùng với những đơn đã xác nhận
 * trong thời gian gần chưa?"* — chưa. Con số 633 đơn huỷ khi chưa xác nhận (90 ngày) đếm cả trường hợp
 * nhân viên LÊN LẠI đơn (tạo đơn mới rồi huỷ đơn cũ) và khách đặt hai lần. Những đơn đó không phải
 * khách bị mất: khách vẫn mua, qua một đơn khác.
 *
 * ─── KHÔNG ĐẶT LUẬT TRÙNG MỚI ───
 *
 * Dùng lại ĐÚNG luật đơn trùng chủ shop đã chốt (`lib/constants/order-duplicate.ts`): cùng 9 số cuối
 * SĐT, cửa sổ `DuplicateRule.windowHours` (48 giờ, đã kiểm định trên dữ liệu thật), và so TẬP MẶT HÀNG
 * bằng `assessDuplicate`. Một đơn huỷ được xếp theo ĐƠN ANH EM tốt nhất của nó — một đơn KHÁC cùng
 * SĐT, trong cửa sổ, và ĐÃ TỪNG ĐƯỢC XÁC NHẬN (`ORDER_EVER_CONFIRMED`):
 *
 *   `REPLACED_SAME_ITEMS`   — anh em cùng mẫu mã, cùng số lượng ⇒ gần như chắc là lên lại / đặt trùng.
 *   `REPLACED_OVERLAP`      — anh em có mẫu mã chung (hoặc chỉ khớp bằng tên) ⇒ có thể là sửa đơn
 *                             bằng cách tạo đơn mới. Người đọc quyết, máy không gộp vào nhóm trên.
 *   `SAME_CUSTOMER_OTHER`   — khách có đơn xác nhận gần đó nhưng KHÁC mẫu mã ⇒ theo luật của shop đó
 *                             là hai đơn hợp lệ: món trong đơn huỷ vẫn là món bị mất.
 *   `LOST`                  — không có anh em nào đã xác nhận ⇒ mất thật.
 *   `NO_PHONE`              — SĐT không đủ 9 số để so ⇒ CHƯA BIẾT, không gộp vào "mất thật".
 *
 * "Mất thật" = `SAME_CUSTOMER_OTHER` + `LOST`. `NO_PHONE` đứng riêng (mục 42: chưa biết không phải 0,
 * cũng không phải "mất").
 */

export const CANCEL_MATCHES = ["REPLACED_SAME_ITEMS", "REPLACED_OVERLAP", "SAME_CUSTOMER_OTHER", "LOST", "NO_PHONE"] as const;
export type CancelMatch = (typeof CANCEL_MATCHES)[number];

export const CANCEL_MATCH_LABEL: Record<CancelMatch, string> = {
  REPLACED_SAME_ITEMS: "Đơn được lên lại · cùng mẫu mã",
  REPLACED_OVERLAP: "Có thể lên lại · mẫu mã chồng lấn",
  SAME_CUSTOMER_OTHER: "Khách có đơn khác · khác mẫu mã",
  LOST: "Mất thật · không đơn nào thay",
  NO_PHONE: "Không đủ SĐT để so",
};

/** Nhóm được coi là KHÁCH KHÔNG MẤT — đơn huỷ đã có đơn khác đã xác nhận thay. */
export const CANCEL_MATCH_REPLACED: readonly CancelMatch[] = ["REPLACED_SAME_ITEMS", "REPLACED_OVERLAP"];

export type CancelledOrder = DuplicateCandidate;
export type SiblingOrder = DuplicateCandidate;

/**
 * Xếp MỘT đơn huỷ theo đơn anh em tốt nhất trong cửa sổ. Hàm THUẦN — không đọc CSDL.
 * `siblings` là các đơn KHÁC đơn huỷ, ĐÃ TỪNG xác nhận; hàm tự lọc cùng SĐT và cửa sổ.
 */
export function classifyCancelled(order: CancelledOrder, siblings: readonly SiblingOrder[], windowHours: number): CancelMatch {
  const key = phoneKey(order.phone);
  if (!key) return "NO_PHONE";
  const windowMs = windowHours * 3_600_000;
  let best: CancelMatch = "LOST";
  for (const s of siblings) {
    if (s.orderId === order.orderId) continue;
    if (phoneKey(s.phone) !== key) continue;
    if (Math.abs(s.insertedAt.getTime() - order.insertedAt.getTime()) > windowMs) continue;
    const v = assessDuplicate(order, s).verdict;
    if (v === "DUPLICATE_SUSPECTED") return "REPLACED_SAME_ITEMS";
    if (v === "POSSIBLE_DUPLICATE") best = "REPLACED_OVERLAP";
    else if (best === "LOST") best = "SAME_CUSTOMER_OTHER";
  }
  return best;
}

export function emptyMatchCounts(): Record<CancelMatch, number> {
  return Object.fromEntries(CANCEL_MATCHES.map((k) => [k, 0])) as Record<CancelMatch, number>;
}

/* ═══════════════════ HUỶ SAU XÁC NHẬN: HUỶ Ở KHÂU NÀO ═══════════════════ */

/**
 * Đơn đã xác nhận rồi bị huỷ — huỷ ở khâu nào quyết định ai phải làm gì:
 *
 *   `BEFORE_SHIPMENT`  — chưa tạo vận đơn: khách đổi ý / chờ hàng quá lâu / sale sai. Hàng chưa đụng.
 *   `BEFORE_HANDOFF`   — đã có vận đơn nhưng ĐVVC CHƯA cầm hàng (mốc bàn giao, AGENTS.md mục 41):
 *                        kho đã đóng gói có khi phải mở ra, vận đơn phải huỷ bên Viettel Post.
 *   `AFTER_HANDOFF`    — ĐVVC đã cầm hàng rồi huỷ: hàng đang trên đường phải quay về kho, tốn cước.
 */
export const POST_CONFIRM_STAGES = ["BEFORE_SHIPMENT", "BEFORE_HANDOFF", "AFTER_HANDOFF"] as const;
export type PostConfirmStage = (typeof POST_CONFIRM_STAGES)[number];

export const POST_CONFIRM_STAGE_LABEL: Record<PostConfirmStage, string> = {
  BEFORE_SHIPMENT: "Huỷ trước khi tạo vận đơn",
  BEFORE_HANDOFF: "Có vận đơn · ĐVVC chưa lấy hàng",
  AFTER_HANDOFF: "ĐVVC đã cầm hàng rồi huỷ",
};
