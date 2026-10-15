/**
 * ═══════════ ĐỊA CHỈ ĐÃ BIẾT KHÔNG ĐƯỢC HỎI LẠI — HÀNG RÀO MÁY CHỦ TRÊN CHỮ GỬI KHÁCH (P0 15/10/2026) ═══════════
 *
 * Hai ca thật HSLC:
 *  · «Tuyet Nguyen Thi» (15/10 10:46): khách gõ «230/20 Phan Huy Ích, P An Hội Tây, TP.HCM» + SĐT đầy đủ — phường MỚI, có thật
 *    trong danh mục sau sáp nhập — mà bot bắt chọn giữa 6 phường của quận Gò Vấp cũ.
 *  · «Lê Văn Dụ»: «khu đô thị Xa La, Phúc La cũ, Hà Đông, Hà Nội» — bot hỏi phường mới qua nhiều lượt.
 *
 * Công cụ đã không còn đưa câu hỏi cho phần đã biết / đã hỏi (`addressCheckOf` · `askedBefore` ở tools.ts), nhưng model vẫn có thể
 * TỰ hỏi bằng hiểu biết của nó (model không biết tên phường mới thì nghĩ địa chỉ «sai»). Tệp này là lớp cuối: câu bot sắp gửi mà HỎI
 * phường / xã khi máy chủ đã biết phường (đơn nháp có ô xã · dòng địa chỉ tự điền được · tin khách ghi rõ một phường có thật), hoặc
 * khi phường đã được hỏi ở một lượt trước ⇒ bỏ câu hỏi đó, giữ phần còn lại. Câu hỏi lại CẢ địa chỉ khi đã biết đủ tỉnh + xã + số nhà
 * cũng bỏ. HÀM THUẦN — không CSDL, không mạng; chỉ đọc trạng thái hội thoại và tin khách.
 *
 * KHÔNG ĐOÁN: hàng rào chỉ BỎ câu hỏi, không bao giờ tự điền một phường. Phường chưa biết và chưa hỏi lần nào ⇒ câu hỏi đầu tiên đi qua.
 */
import { canAutoFill, customerStatedAddresses, parseCustomerAddress, wardFromCustomerWords, type AddressPart } from "@/lib/address/customer-address";
import { foldVnText } from "@/lib/address/vn-address";
import type { ChatState } from "@/lib/sales-chatbot/tools";

// ─────────────────────────── TRÍ NHỚ ĐÃ HỎI ───────────────────────────

/**
 * TRÍ NHỚ HỎI ĐỊA CHỈ của hội thoại. `key` / `turn` = địa chỉ + lượt của câu hỏi gần nhất (giữ nguyên nghĩa cũ). `parts` = PHẦN nào của
 * địa chỉ (tỉnh · xã · số nhà) đã được hỏi, ở lượt NÀO (lần đầu) — P0 15/10/2026, ca «Lê Văn Dụ»: trí nhớ cũ khoá theo ĐÚNG chuỗi địa chỉ,
 * nên mỗi lần khách trả lời và model chép lại địa chỉ (chuỗi khác) thì cổng chốt coi như chưa hỏi và hỏi lại phường — nhiều lượt liền.
 * Nay một phần đã hỏi ở lượt trước thì KHÔNG hỏi lại, dù chuỗi địa chỉ đổi: đơn đi tiếp với cờ cần kiểm địa chỉ, nhân viên xác nhận.
 * Dòng cũ không có `parts` ⇒ suy từ `key` (`askMemoryParts`).
 */
export type AddressAskMemory = { key: string; turn: number; parts?: Partial<Record<AddressPart, number>> };

/** Phần địa chỉ một câu hỏi khách nhắm tới: thiếu tỉnh ⇒ câu hỏi TỈNH (xã hỏi sau, khi đã biết tỉnh); còn lại ⇒ đúng các phần thiếu. */
export function askParts(missing: readonly AddressPart[]): AddressPart[] {
  return missing.includes("province") ? missing.filter((p) => p !== "ward") : [...missing];
}

/** Phần đã hỏi + lượt hỏi lần đầu. Dòng trí nhớ cũ (chưa có `parts`) ⇒ suy từ chính địa chỉ của câu hỏi (`key` = địa chỉ|tỉnh|xã). */
export function askMemoryParts(m: AddressAskMemory | undefined): Partial<Record<AddressPart, number>> {
  if (!m) return {};
  if (m.parts) return m.parts;
  const [address = "", province = ""] = m.key.split("|");
  return Object.fromEntries(askParts(parseCustomerAddress(address, province).missing).map((p) => [p, m.turn]));
}

/** Mọi phần câu hỏi này nhắm tới đều đã được hỏi ở một lượt TRƯỚC (cùng lượt thì chưa — khách chưa thấy câu hỏi). */
export function askedBefore(m: AddressAskMemory | undefined, parts: readonly AddressPart[], turn: number | undefined): boolean {
  if (turn === undefined || !parts.length) return false;
  const mem = askMemoryParts(m);
  return parts.every((p) => mem[p] !== undefined && mem[p]! < turn);
}

// ─────────────────────────── ĐỊA CHỈ ĐÃ BIẾT + HÀNG RÀO CÂU HỎI LẠI ───────────────────────────

/** Những gì máy chủ BIẾT về địa chỉ giao của lượt. `ward` = tên chuẩn khi đã biết; `wardAskedAt` = lượt đầu tiên đã hỏi phường. */
export type AddressKnowledge = { ward: string | null; wardAskedAt: number | null; province: boolean; street: boolean };

/**
 * Đọc địa chỉ đã biết: đơn nháp (ô xã người / khách đã chọn, hoặc dòng địa chỉ tự điền được) → khách đã lưu → tin khách tự gõ (kể cả
 * khi model CHƯA gọi công cụ lưu khách — model hay hỏi lại ngay ở lượt khách vừa gửi địa chỉ). HÀM THUẦN.
 */
export function addressKnowledge(state: Pick<ChatState, "draft" | "customer" | "addressAsk">, customerTexts: readonly string[]): AddressKnowledge {
  const mem = askMemoryParts(state.addressAsk);
  const wardAskedAt = mem.ward ?? null;
  const r = state.draft?.recipient ?? (state.customer?.address.trim() ? { address: state.customer.address, province: state.customer.province, ward: undefined } : null);
  if (r && r.address.trim()) {
    const a = parseCustomerAddress(r.address, r.province);
    const chosen = (r.ward ?? "").trim();
    const stated = chosen || canAutoFill(a) ? null : wardFromCustomerWords(a, r.address, customerTexts);
    const ward = chosen || (canAutoFill(a) ? a.ward : null) || stated?.ward || null;
    return { ward, wardAskedAt, province: a.province !== null || Boolean(stated), street: !a.missing.includes("street") };
  }
  const [said] = customerStatedAddresses(customerTexts);
  return said ? { ward: said.ward, wardAskedAt, province: said.province !== null, street: !said.missing.includes("street") } : { ward: null, wardAskedAt, province: false, street: false };
}

/** Câu HỎI phường / xã (đã gập): «phường nào», «phường / xã gì», «cho em xin tên phường», «… hay phường B», «theo địa giới mới …?». */
const WARD_ASK = [
  /(?:^| )(?:phuong|xa|thi tran)(?: (?:phuong|xa))? (?:nao|gi)(?: |$)/,
  /(?:^| )(?:xin|xac nhan|cho em biet|cho biet|bao|kiem tra|chon)(?: lai)?(?: giup)?(?: em| shop| minh| chi| anh)?(?: lai)?(?: (?:ten|dung))? (?:phuong|xa)(?: |$)/,
];
/** Chỉ tính là câu hỏi khi có dấu «?» — câu tóm tắt «giao tới …, phường An Hội Tây» không phải câu hỏi. */
const WARD_ASK_Q = [/(?:^| )hay (?:phuong|xa) /, /(?:^| )dia gioi moi(?: |$)/];
/** Câu xin lại CẢ địa chỉ. */
const FULL_ADDRESS_ASK = /(?:^| )(?:xin|gui|cho em|nhan)(?: lai)?(?: giup em)? (?:thong tin )?dia chi(?: |$)/;

/** Một câu (một đoạn giữa dấu chấm / hỏi / xuống dòng) có HỎI phường / xã không. HÀM THUẦN. */
export function asksForWard(sentence: string): boolean {
  const f = foldVnText(sentence);
  if (WARD_ASK.some((re) => re.test(f))) return true;
  return sentence.includes("?") && WARD_ASK_Q.some((re) => re.test(f));
}

/** Một câu có xin lại CẢ địa chỉ không. HÀM THUẦN. */
export function asksForFullAddress(sentence: string): boolean {
  return FULL_ADDRESS_ASK.test(foldVnText(sentence));
}

/** Câu thay khi cả tin chỉ là câu hỏi lại địa chỉ — ghi nhận, không hỏi gì thêm. */
export const ADDRESS_KNOWN_TEXT = "Dạ em ghi nhận địa chỉ của mình rồi ạ.";

/**
 * Câu bot sắp gửi có HỎI LẠI phần địa chỉ đã biết / đã hỏi không. Có ⇒ `rest` = các câu còn lại (có thể rỗng — nơi gọi quyết câu thay),
 * `note` = lý do cho người vận hành. Không ⇒ `null`. Phường chưa biết và chưa hỏi lần nào ⇒ câu hỏi đầu tiên đi qua. HÀM THUẦN.
 */
export function addressReaskVerdict(botText: string, k: AddressKnowledge, turn: number): { rest: string; note: string } | null {
  const wardSettled = k.ward !== null || (k.wardAskedAt !== null && k.wardAskedAt < turn);
  const fullKnown = k.ward !== null && k.province && k.street;
  if (!wardSettled && !fullKnown) return null;
  const sentences = (botText.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
  const drop = (s: string) => (wardSettled && asksForWard(s)) || (fullKnown && asksForFullAddress(s));
  if (!sentences.some(drop)) return null;
  const note = k.ward !== null ? "AI hỏi lại phường / xã khách đã cho (máy chủ đã ghép được theo địa giới mới) — đã bỏ câu hỏi" : "AI hỏi lại phường / xã đã hỏi khách ở lượt trước — đã bỏ câu hỏi, đơn đi tiếp với cờ cần kiểm địa chỉ";
  return { rest: sentences.filter((s) => !drop(s)).join(" "), note };
}
