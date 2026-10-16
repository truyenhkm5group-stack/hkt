/**
 * ═══════════ HẬU MÃI: KHÔNG BÁN TIẾP, KHÔNG CHỐT LẠI, KHÔNG MỞ ĐƠN MỚI VÌ «LẦN SAU» — HÀM THUẦN (#871, ca «Nguyễn Hà» HSLC 16/10/2026) ═══════════
 *
 * Sự cố: khách đã cho đủ thông tin, đơn 280.000 ₫ đã chốt. Sau đó bot vẫn xin khách xác nhận đơn, hỏi lại địa chỉ, nhắc mua; khách hỏi
 * đơn tới đâu thì bot mời mua thêm. Lời nhắc hậu mãi (`postSalePrompt`) đã dặn đủ cả ba điều — nhưng lời dặn không phải hàng rào: máy chủ
 * không có chốt nào đứng giữa chữ model và khách ở giai đoạn này.
 *
 * Tệp này là chốt đó, từng câu:
 *  · `postSaleReplyGuard` — đơn đã chốt / khách ở giai đoạn sau bán ⇒ bỏ câu MỜI MUA THÊM (khách đang hỏi trạng thái, phàn nàn, huỷ hay
 *    chờ hàng thì mời mua là sai lúc) và câu XIN XÁC NHẬN / CHỐT LẠI đơn. Phần còn lại của tin vẫn gửi. Câu KỂ («đơn của mình đã chốt»)
 *    không phải câu xin chốt — chỉ câu HỎI / NHỜ mới bị bỏ.
 *  · `futurePurchaseOnly` — «mua tiếp lần sau», «hôm khác chị đặt» là ý định TƯƠNG LAI, không phải đơn: công cụ lên đơn từ chối.
 *
 * GHI CHÚ TÍCH HỢP (#868): nhánh `claude/p0-868-smart-upsell` thêm `next-best-action.ts` với cửa sổ lời mời (`offerWindow` — CONFIRMED,
 * COMPLAINT…) cho MỌI giai đoạn. Lúc tệp này viết, #868 CHƯA vào main ⇒ đây là hàng rào TỐI THIỂU cho riêng giai đoạn sau chốt. Khi #868
 * vào main, hai lớp cùng chiều (đều CHẶN lời mời sau chốt) — không xung đột; gộp về một đường ở lượt dọn sau, không bỏ lớp này trước khi
 * `offerWindow` chạy trên đúng đường gửi chữ của engine.
 */
import { foldVi } from "@/lib/sales-chatbot/text";

export type PostSaleDrop = "UPSELL" | "RECONFIRM";

const fold = (s: string) => ` ${foldVi(s.normalize("NFC").toLowerCase()).replace(/[^a-z0-9?]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Câu MỜI MUA THÊM / chào món khác (đã gập dấu, có khoảng trắng hai đầu). */
const UPSELL_RE = [
  / (?:lay|mua|chon|dat|order|an|dung|xem|thu) them /,
  / them (?:mon|vai|it|1|mot|hai|2|hop|goi|kg|ky|phan|set|combo|hu|lo|tui) /,
  / moi (?:anh |chi |minh |ban |a |c |e |em )?(?:thu|them|tham khao|xem|mua|dat|dung) /,
  / (?:combo|set qua|mon (?:khac|kem|moi|ban chay)|san pham (?:khac|kem|moi|ban chay)|an kem|dung kem|ban chay nhat|menu) /,
  / (?:uu dai|khuyen mai|giam gia|freeship|mien ship) (?:cho |neu |khi |them |hom nay |dot nay )/,
];
/** Câu XIN XÁC NHẬN / CHỐT (LẠI) đơn hay thông tin nhận hàng. */
const RECONFIRM_RE = [
  / (?:xac nhan|chot)(?: lai)?(?: giup em| giup| cho em| voi em)? (?:don|dia chi|thong tin|sdt|so dien thoai|giup em|lai) /,
  / (?:em|shop|minh) (?:len|gui|chot|xac nhan) don(?: cho (?:anh|chi|minh|ban))?(?: luon)? (?:nhe|nha|nha|a|duoc khong|khong) /,
  / (?:co )?(?:muon )?(?:tiep tuc )?(?:chot|dat|lay) (?:don )?(?:khong|ko|chua) /,
  / lay them gi (?:nua )?(?:khong|ko) /,
];
/**
 * Dấu hiệu câu HỎI / NHỜ (không phải câu kể): dấu «?», tiểu từ hỏi / nhờ ở CUỐI câu, hay «giúp em / cho em». «không» GIỮA câu không tính
 * («Đã chốt đơn (thử — không tạo đơn thật), tổng thu …» là câu kể).
 */
const ASKING_RE = /\?| (?:nhe|nha|khong|ko|chua|duoc khong|a nhe|a nha|voi a)\s*$| (?:giup em|cho em|giup minh) /;

function sentencesOf(text: string): string[] {
  return text
    .replace(/([.!?…])\s+/g, "$1\n")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Loại câu cần bỏ ở giai đoạn sau chốt (`null` = giữ). HÀM THUẦN. */
export function postSaleSentenceDrop(sentence: string): PostSaleDrop | null {
  const f = fold(sentence);
  if (UPSELL_RE.some((re) => re.test(f))) return "UPSELL";
  if (RECONFIRM_RE.some((re) => re.test(f)) && ASKING_RE.test(f)) return "RECONFIRM";
  return null;
}

/**
 * Chữ model gửi khách khi đơn ĐÃ CHỐT (hoặc khách ở giai đoạn sau bán): bỏ câu mời mua thêm + câu xin xác nhận / chốt lại. `text` = phần
 * còn lại (có thể rỗng — nơi gọi không gửi gì, khối «không để khách im» lo câu thay). HÀM THUẦN.
 */
export function postSaleReplyGuard(text: string): { text: string; dropped: PostSaleDrop[] } {
  const kept: string[] = [];
  const dropped: PostSaleDrop[] = [];
  for (const s of sentencesOf(text)) {
    const d = postSaleSentenceDrop(s);
    if (d) dropped.push(d);
    else kept.push(s);
  }
  return dropped.length ? { text: kept.join(" "), dropped } : { text, dropped };
}

/** Mốc TƯƠNG LAI không xác định («lần sau», «hôm khác», «dịp khác», «tháng sau»…). */
const FUTURE_RE = / (?:lan sau|lan toi|hom khac|bua khac|dip khac|dot sau|dot toi|khi khac|sau nay|thang sau|tuan sau|nam sau|khi nao can|luc nao can|lan khac) /;
/** Lời mua NGAY gắn món / số lượng («lấy luôn», «đặt ngay», «thêm 1 hộp») — khi có, tin không chỉ là ý định tương lai. */
const BUY_NOW_RE = / (?:luon|ngay|bay gio|hom nay|bh) | (?:lay|them|dat|mua|cho) (?:\d|mot|hai|ba) /;

/**
 * Tin khách chỉ là Ý ĐỊNH MUA TƯƠNG LAI («mua tiếp lần sau nhé», «hôm khác chị đặt tiếp») — không có lời mua ngay. HÀM THUẦN.
 */
export function futurePurchaseOnly(text: string): boolean {
  const f = fold(text);
  return FUTURE_RE.test(f) && !BUY_NOW_RE.test(f);
}
