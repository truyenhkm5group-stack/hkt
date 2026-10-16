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
import { canAutoFill, customerStatedAddresses, hasStreetDetail, legacyAddressUnmapped, looksLikeDeliveryAddress, namesOtherWard, parseCustomerAddress, sameDeliveryPlace, wantsAddressChange, wardFromCustomerWords, type AddressPart } from "@/lib/address/customer-address";

export { wantsAddressChange };
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

/**
 * Trí nhớ hỏi địa chỉ CÒN áp cho `address` không: câu hỏi gần nhất hỏi về CÙNG nơi giao (cùng đường, cùng số nhà) ⇒ giữ; khách đổi
 * hẳn địa chỉ ⇒ bỏ (review PR #848 lần 2: phường đã hỏi ở lượt 3 không được chặn câu hỏi phường của một địa chỉ khác ở lượt 10).
 * Model chép lại cùng địa chỉ khác chữ («… gần chợ») vẫn giữ. HÀM THUẦN.
 */
export function askMemoryFor(m: AddressAskMemory | undefined, address: string): AddressAskMemory | undefined {
  if (!m) return undefined;
  const [prevAddress = ""] = m.key.split("|");
  return sameDeliveryPlace(prevAddress, address) ? m : undefined;
}

/** Mọi phần câu hỏi này nhắm tới đều đã được hỏi ở một lượt TRƯỚC (cùng lượt thì chưa — khách chưa thấy câu hỏi). */
export function askedBefore(m: AddressAskMemory | undefined, parts: readonly AddressPart[], turn: number | undefined): boolean {
  if (turn === undefined || !parts.length) return false;
  const mem = askMemoryParts(m);
  return parts.every((p) => mem[p] !== undefined && mem[p]! < turn);
}

// ─────────────────────────── ĐỊA CHỈ ĐÃ BIẾT + HÀNG RÀO CÂU HỎI LẠI ───────────────────────────

// ─────────────────────────── Ý ĐỊNH «DÙNG LẠI ĐỊA CHỈ CŨ» / «ĐỊA CHỈ MỚI» ───────────────────────────

/**
 * Mỗi chiều (địa chỉ · SĐT) độc lập: khách có thể «vẫn địa chỉ cũ nhưng số mới». `null` = khách không nói gì về chiều đó. `NEW` (chỉ chiều
 * địa chỉ, #855 ca «ThuyNgo») = tin MỚI HƠN lời «như cũ» là MỘT ĐỊA CHỈ GIAO khách tự gõ — địa chỉ đó thắng, không dùng địa chỉ cũ.
 */
export type ReuseSignal = "REUSE" | "DECLINE" | "NEW" | null;
export type ReuseIntent = { address: ReuseSignal; phone: ReuseSignal };
export const NO_REUSE_INTENT: ReuseIntent = { address: null, phone: null };

// Đọc trên chữ đã bỏ dấu (`foldVnText`): khách nhắn không dấu / viết tắt như có dấu.
const OLD_ADDRESS_RE = /\b(dia chi|diachi|dc|d c|cho|nha) cu\b|\bnhu (lan|don|hom|dot) truoc\b|\b(y |van |giao )?nhu cu\b|\bvan (dia chi|dc|cho|nha) (do|day|nay|ay|o tren|nhu cu)\b|\bvan (dia chi|dc)$|\bvan (dia chi|dc) (nhe|nha|a|em|nhe shop|nha shop)\b|\bdia chi (o )?tren\b|\bdia chi (lan|don) truoc\b/;
const OLD_PHONE_RE = /\b(so|sdt|so dien thoai|so dt) cu\b|\bvan (so|sdt) (do|nay|ay|cu)\b|\bvan (so|sdt)$|\bvan (so|sdt) (nhe|nha|a|em)\b/;
const DECLINE_ADDRESS_RE = /\b(dia chi|dc) (khac|moi)\b|\bdoi (dia chi|dc)\b|\bkhong (phai|dung|giao|gui) (ve )?(dia chi|dc|cho) (cu|do|nay)\b|\b(gui|giao|ship) (ve )?cho khac\b/;
const DECLINE_PHONE_RE = /\b(so|sdt|so dien thoai) (khac|moi)\b|\bdoi (so|sdt)\b|\bkhong (dung|dung nua|con dung) (so|sdt) (cu|do)\b/;

/** Lời dẫn trước địa chỉ («giao về …», «gửi tới …», «ship qua …», «địa chỉ: …») — phần SAU nó mới là dòng địa chỉ. */
const LEAD_IN = /(?:(?:giao|gửi|gui|ship|chuyển|chuyen)(?: hàng| hang)? (?:về|ve|tới|toi|đến|den|qua|sang)|địa chỉ(?: mới| moi)?\s*:|dia chi(?: moi)?\s*:)\s*/iu;
const TAIL_FILLER = /[\s,.;!]*(?:nhé|nhe|nha|nhá|ạ|a|em|shop|nhé em|nha em)?[\s,.;!]*$/iu;

/** Các cách đọc một dòng thành địa chỉ: nguyên dòng, rồi phần sau lời dẫn (bỏ tiểu từ cuối). HÀM THUẦN. */
function addressReadings(line: string): string[] {
  const l = line.trim();
  const m = LEAD_IN.exec(l);
  const tail = m ? l.slice(m.index + m[0].length).replace(TAIL_FILLER, "").trim() : "";
  return tail && tail !== l ? [l, tail] : [l];
}

/** Dòng (hoặc phần sau lời dẫn của nó) là một địa chỉ giao ⇒ chuỗi địa chỉ; không ⇒ `null`. HÀM THUẦN. */
function deliveryAddressIn(line: string): string | null {
  return addressReadings(line).find((x) => looksLikeDeliveryAddress(x)) ?? null;
}

/** Tín hiệu chiều địa chỉ của MỘT dòng khách gõ: từ chối > dùng lại > một địa chỉ giao tự gõ (`NEW`). HÀM THUẦN. */
function addressSignalOf(line: string): ReuseSignal {
  const t = foldVnText(line).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (DECLINE_ADDRESS_RE.test(t)) return "DECLINE";
  if (OLD_ADDRESS_RE.test(t)) return "REUSE";
  return deliveryAddressIn(line) ? "NEW" : null;
}

/**
 * Khách có đang nói «dùng lại địa chỉ / SĐT cũ» (hoặc KHÔNG dùng lại) không — đọc các tin khách theo thứ tự cũ → mới, mỗi chiều
 * riêng; tin mới hơn mang tín hiệu của chiều đó thì thắng («vẫn địa chỉ cũ» rồi «à thôi gửi chỗ khác» ⇒ từ chối địa chỉ). Từ chối
 * trong CÙNG một dòng thắng dùng lại. Một ĐỊA CHỈ GIAO khách tự gõ SAU lời «như cũ» ⇒ `NEW` (#855: lời «địa chỉ cũ» còn trong 3 tin
 * gần nhất từng làm lời nhắc tiếp tục bảo bot dùng địa chỉ cũ dù khách vừa gửi địa chỉ ở Thủ Đức). Địa chỉ gõ khi khách CHƯA nói gì
 * về địa chỉ cũ không đổi gì (`null` — lời nhắc của mọi hội thoại khác giữ nguyên từng chữ). HÀM THUẦN.
 */
export function reuseIntentOf(customerTexts: readonly string[]): ReuseIntent {
  let address: ReuseSignal = null;
  let phone: ReuseSignal = null;
  for (const raw of customerTexts) {
    for (const line of raw.split(/\n+/)) {
      const t = foldVnText(line).replace(/\s+/g, " ").trim();
      if (!t) continue;
      const sig = addressSignalOf(line);
      if (sig === "NEW") {
        if (address !== null) address = "NEW";
      } else if (sig) address = sig;
      if (DECLINE_PHONE_RE.test(t)) phone = "DECLINE";
      else if (OLD_PHONE_RE.test(t)) phone = "REUSE";
    }
  }
  return { address, phone };
}

// ─────────────────────────── ĐỊA CHỈ CÓ NGUỒN GỐC (PROVENANCE) ───────────────────────────

/** Nguồn của một dữ kiện địa chỉ — chữ khách gõ trong hội thoại · đơn cũ ĐÃ XÁC MINH của đúng khách · đơn nháp · hồ sơ khách của lượt. */
export type AddressSource = "CUSTOMER_MESSAGE" | "VERIFIED_HISTORY" | "DRAFT" | "SAVED_CUSTOMER";
export type AddressFact = { source: AddressSource; raw: string; province: string; messageIndex: number | null };
/**
 * Quyết định địa chỉ giao của lượt (#855):
 *  · `NEW_EXPLICIT` — địa chỉ khách vừa tự gõ là địa chỉ mới nhất ⇒ dùng; trùng nơi giao với đơn nháp (hoặc chưa có nháp).
 *  · `CHANGE_PENDING_VERIFICATION` — địa chỉ khách vừa gõ KHÁC đơn nháp / hồ sơ ⇒ địa chỉ mới THẮNG mọi câu hỏi (không hỏi lại nó), đơn
 *    nháp đang giữ dữ liệu cũ phải sửa theo nó và đơn cần người xác minh; không lặng lẽ để bản cũ thắng.
 *  · `REUSE_VERIFIED` — khách nói «địa chỉ cũ / như cũ» và có địa chỉ ĐẦY ĐỦ đã xác minh của đúng khách (đơn cũ đã xác minh, hoặc máy chủ
 *    đã điền qua `use_saved_address`), không có địa chỉ mới hơn ⇒ dùng.
 *  · `NEEDS_HUMAN` — khách nói «địa chỉ cũ» mà không có địa chỉ đầy đủ đã xác minh ⇒ chuyển người, KHÔNG hỏi lặp, KHÔNG suy ra địa chỉ
 *    từ một tên vùng («Khương Đình»).
 *  · `DRAFT` — chỉ có đơn nháp / hồ sơ (luồng cũ). · `NONE` — chưa có gì.
 * HÀM THUẦN — không CSDL; `verifiedHistory` do nơi gọi đưa từ Customer 360 (đã nối danh tính).
 */
export type AddressDecisionStatus = "NEW_EXPLICIT" | "CHANGE_PENDING_VERIFICATION" | "REUSE_VERIFIED" | "NEEDS_HUMAN" | "DRAFT" | "NONE";
export type AddressDecision = { status: AddressDecisionStatus; use: AddressFact | null; previous: AddressFact | null; reason: string };

/** Địa chỉ giao MỚI NHẤT khách tự gõ: dòng / cả tin / ghép với tin trước — kèm chỉ số tin (cũ ⇒ mới). HÀM THUẦN. */
export function latestCustomerAddress(customerTexts: readonly string[]): AddressFact | null {
  const msgs = customerTexts.map((t) => t.trim());
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i]) continue;
    const lines = msgs[i].split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const options = [...lines.slice().reverse(), ...(lines.length > 1 ? [lines.join(", ")] : [])];
    for (const l of options) {
      const hit = deliveryAddressIn(l);
      if (hit) return { source: "CUSTOMER_MESSAGE", raw: hit, province: "", messageIndex: i };
    }
  }
  return null;
}

/** Chỉ số tin khách CUỐI CÙNG nói «dùng lại địa chỉ cũ» (sau mọi lời từ chối); không có ⇒ -1. HÀM THUẦN. */
function lastReuseIndex(customerTexts: readonly string[]): number {
  let at = -1;
  customerTexts.forEach((m, i) => {
    for (const line of m.split(/\n+/)) {
      const sig = addressSignalOf(line);
      if (sig === "REUSE") at = i;
      else if (sig === "DECLINE") at = -1;
    }
  });
  return at;
}

export function deliveryAddressDecision(state: Pick<ChatState, "draft" | "customer">, customerTexts: readonly string[], verifiedHistory?: { address: string; province: string; ward?: string } | null): AddressDecision {
  const draftR = state.draft?.recipient;
  const held: AddressFact | null = draftR?.address.trim()
    ? { source: "DRAFT", raw: draftR.address, province: draftR.province, messageIndex: null }
    : state.customer?.address.trim()
      ? { source: state.customer.savedAddress ? "VERIFIED_HISTORY" : "SAVED_CUSTOMER", raw: state.customer.address, province: state.customer.province, messageIndex: null }
      : null;
  const typed = latestCustomerAddress(customerTexts);
  const reuseAt = lastReuseIndex(customerTexts);
  // Địa chỉ khách tự gõ MỚI HƠN lời «như cũ» (hoặc khách không nói «như cũ») ⇒ chữ khách thắng.
  if (typed && typed.messageIndex! > reuseAt) {
    if (held && !sameDeliveryPlace(held.raw, typed.raw)) return { status: "CHANGE_PENDING_VERIFICATION", use: typed, previous: held, reason: "Khách vừa gửi địa chỉ giao KHÁC địa chỉ đơn nháp / hồ sơ đang giữ — địa chỉ mới thắng, đơn cần sửa theo nó và cần người xác minh" };
    return { status: "NEW_EXPLICIT", use: typed, previous: held, reason: "Địa chỉ khách vừa tự gõ" };
  }
  if (reuseAt >= 0) {
    // «Như cũ»: chỉ địa chỉ ĐẦY ĐỦ đã xác minh của đúng khách — đơn cũ (Customer 360) hoặc hồ sơ máy chủ đã điền từ đơn cũ.
    if (held?.source === "VERIFIED_HISTORY" && hasStreetDetail(held.raw)) return { status: "REUSE_VERIFIED", use: held, previous: null, reason: "Địa chỉ đơn cũ đã xác minh, máy chủ đã điền" };
    if (verifiedHistory && hasStreetDetail(verifiedHistory.address)) return { status: "REUSE_VERIFIED", use: { source: "VERIFIED_HISTORY", raw: verifiedHistory.address, province: verifiedHistory.province, messageIndex: null }, previous: held, reason: "Địa chỉ đơn cũ đã xác minh của đúng khách" };
    if (held && held.source !== "VERIFIED_HISTORY" && hasStreetDetail(held.raw) && held.source === "DRAFT") return { status: "DRAFT", use: held, previous: null, reason: "Đơn nháp đã có địa chỉ đầy đủ" };
    return { status: "NEEDS_HUMAN", use: null, previous: held, reason: "Khách muốn dùng địa chỉ cũ nhưng không có địa chỉ đầy đủ đã xác minh của đúng khách — cần nhân viên kiểm, không hỏi lặp" };
  }
  if (held) return { status: "DRAFT", use: held, previous: null, reason: "Đơn nháp / hồ sơ của lượt" };
  return { status: "NONE", use: null, previous: null, reason: "" };
}

// ─────────────────────────── ĐỊA CHỈ ĐÃ BIẾT + HÀNG RÀO CÂU HỎI LẠI ───────────────────────────

/**
 * Những gì máy chủ BIẾT về địa chỉ giao của lượt. `ward` = tên chuẩn khi đã biết; `wardAskedAt` = lượt đầu tiên đã hỏi phường;
 * `corrected` = tin khách MỚI NHẤT nêu một phường KHÁC phường máy đang biết (khách đang sửa) — khi đó bot được hỏi / xác nhận lại.
 * #855: `legacyUnmapped` = khách đã cho địa chỉ ĐỦ theo địa giới CŨ mà danh mục không quy được về một xã mới ⇒ không hỏi khách phường
 * mới, nhân viên kiểm · `reuseUnresolved` = khách nói «địa chỉ cũ» mà không có địa chỉ đầy đủ đã xác minh ⇒ chuyển người, không hỏi lặp ·
 * `draftMismatch` = địa chỉ khách vừa gõ khác đơn nháp (đơn phải sửa + người xác minh) · `phoneKnown` / `nameKnown` = đã có SĐT / tên.
 */
export type AddressKnowledge = {
  ward: string | null;
  wardAskedAt: number | null;
  province: boolean;
  street: boolean;
  corrected?: boolean;
  changeRequested?: boolean;
  lastSettlesAddress?: boolean;
  legacyUnmapped?: boolean;
  reuseUnresolved?: boolean;
  /** Khách đã nói «địa chỉ cũ» mà chưa có địa chỉ xác minh (kể cả lần đầu) — để bảng vận hành đếm; chỉ `reuseUnresolved` mới chặn câu. */
  reuseRequested?: boolean;
  draftMismatch?: boolean;
  phoneKnown?: boolean;
  nameKnown?: boolean;
  /** Tin khách mới nhất phàn nàn bị hỏi lại / bảo «ở trên», «robot hả», «khách cũ mà hỏi gì». */
  complained?: boolean;
};

/** Lời đồng ý ngắn («ok em», «vâng», «đúng rồi», «chốt nhé»). */
const ACK = /^(?:ok|oke|okie|okay|uh|u|um|vang|da|dung|dung roi|duoc|chot|chot don|roi|co|yes)(?: (?:em|a|nhe|nha|shop|ban|roi|luon|di|vay|the))*$/;
/**
 * Tin khách MỚI NHẤT chính là tin mang địa chỉ, hoặc chỉ là lời đồng ý — chỉ khi đó câu bot «xin lại cả địa chỉ» mới chắc chắn là hỏi lại
 * điều vừa biết. Tin khác («gửi cho mẹ chị dưới quê nhé», «chị không ở đó nữa rồi») có thể là đổi người / nơi nhận mà không danh sách
 * mẫu nào bắt hết ⇒ hàng rào để câu xin địa chỉ đi qua (review PR #848 lần 4). HÀM THUẦN.
 */
function settlesAddress(last: string, ward: string | null): boolean {
  const f = foldVnText(last);
  const wardCore = ward ? foldVnText(ward).replace(/^(phuong|xa|thi tran|dac khu) /, "") : "";
  return ACK.test(f) || customerStatedAddresses([last]).length > 0 || deliveryAddressIn(last) !== null || last.split(/\n+/).some((l) => deliveryAddressIn(l) !== null) || (wardCore.length > 0 && ` ${f} `.includes(` ${wardCore} `));
}

/** Lời khách phàn nàn bị hỏi lại («ở trên», «nói rồi», «gửi rồi», «robot hả», «khách cũ mà hỏi gì», «hỏi hoài») — đã gập. */
const COMPLAINT_RE = /(?:^| )(?:robot|ro bot|bot a|may a|o tren|coi o tren|xem o tren|doc lai|noi roi|gui roi|nhan roi|cho roi|khach cu ma|hoi gi|hoi hoai|hoi mai|hoi lai hoai|hoi nhieu)(?: |$)/;
/** SĐT di động VN trong một câu (bỏ khoảng trắng / chấm / gạch giữa các cụm số). */
const PHONE_IN_TEXT = /(?:\+?84|0)[35789]\d{8}(?!\d)/;
const hasPhone = (t: string) => PHONE_IN_TEXT.test(t.replace(/(\d)[ .-](?=\d)/g, "$1"));
/** Khách đổi SĐT / người nhận ⇒ câu xin SĐT / tên mới không bị bỏ. */
const PHONE_CHANGE = /(?:^| )(?:so|sdt|so dien thoai|so dt) (?:khac|moi)(?: |$)|(?:^| )doi (?:so|sdt)(?: |$)|(?:^| )nguoi nhan(?: |$)|(?:^| )(?:gui|giao|ship) (?:cho|ho) (?:me|bo|ba|ban|chong|vo|con|em|anh|chi|co|chu|di|ong)(?: |$)/;

/**
 * Đọc địa chỉ đã biết: đơn nháp (ô xã người / khách đã chọn, hoặc dòng địa chỉ tự điền được) → khách đã lưu → tin khách tự gõ (kể cả
 * khi model CHƯA gọi công cụ lưu khách — model hay hỏi lại ngay ở lượt khách vừa gửi địa chỉ). #855: địa chỉ khách vừa gõ KHÁC đơn nháp
 * thì ĐỊA CHỈ MỚI là điều đã biết (`deliveryAddressDecision`), không phải đơn nháp cũ. HÀM THUẦN.
 */
export function addressKnowledge(state: Pick<ChatState, "draft" | "customer" | "addressAsk">, customerTexts: readonly string[]): AddressKnowledge {
  const last = customerTexts[customerTexts.length - 1] ?? "";
  const lastF = foldVnText(last);
  const contact = {
    phoneKnown: Boolean(state.customer?.phone?.trim() || state.draft?.recipient.phone?.trim() || customerTexts.some(hasPhone)) && !PHONE_CHANGE.test(lastF),
    nameKnown: Boolean(state.customer?.name?.trim() || state.draft?.recipient.name?.trim()) && !PHONE_CHANGE.test(lastF),
    complained: COMPLAINT_RE.test(lastF),
  };
  // Khách xin đổi địa chỉ ⇒ địa chỉ máy đang giữ KHÔNG còn là điều đã biết; câu hỏi phường / địa chỉ của bot đi qua.
  if (wantsAddressChange(last)) return { ward: null, wardAskedAt: null, province: false, street: false, changeRequested: true, ...contact, phoneKnown: false, nameKnown: false };
  const decision = deliveryAddressDecision(state, customerTexts);
  if (decision.status === "NEEDS_HUMAN") {
    // Lần LẶP mới chuyển người: khách nhắc «địa chỉ cũ» từ hai tin trở lên, hay đã có câu hỏi địa chỉ ở lượt trước. Câu hỏi đầu tiên
    // («em chưa tìm thấy địa chỉ cũ, mình gửi giúp em…») đi theo lời nhắc Customer 360 — một lần duy nhất.
    const reuseMsgs = customerTexts.filter((m) => m.split(/\n+/).some((l) => addressSignalOf(l) === "REUSE")).length;
    const askedParts = askMemoryParts(state.addressAsk);
    return { ward: null, wardAskedAt: askedParts.ward ?? null, province: false, street: false, reuseUnresolved: reuseMsgs >= 2 || Object.keys(askedParts).length > 0, reuseRequested: true, ...contact };
  }
  // Địa chỉ khách vừa gõ khác đơn nháp ⇒ đọc CHÍNH địa chỉ mới (không mượn phường / trí nhớ hỏi của nơi cũ).
  if (decision.status === "CHANGE_PENDING_VERIFICATION" && decision.use) {
    const k = knowledgeOfLine(decision.use.raw, "", customerTexts, askMemoryParts(askMemoryFor(state.addressAsk, decision.use.raw)).ward ?? null, last);
    return { ...k, draftMismatch: true, ...contact };
  }
  const r = state.draft?.recipient ?? (state.customer?.address.trim() ? { address: state.customer.address, province: state.customer.province, ward: undefined } : null);
  const mem = askMemoryParts(r ? askMemoryFor(state.addressAsk, r.address) : state.addressAsk);
  const wardAskedAt = mem.ward ?? null;
  if (r && r.address.trim()) {
    const a = parseCustomerAddress(r.address, r.province);
    const chosen = (r.ward ?? "").trim();
    const stated = chosen || canAutoFill(a) ? null : wardFromCustomerWords(a, r.address, customerTexts);
    const ward = chosen || (canAutoFill(a) ? a.ward : null) || stated?.ward || null;
    const provinceName = a.province ?? stated?.province ?? null;
    // Khách vừa nêu một phường khác (sửa không kèm đường) ⇒ phường máy đang giữ KHÔNG còn là điều đã biết.
    if (ward && provinceName && last.split(/\n+/).some((x) => namesOtherWard(x, provinceName, ward))) return { ward: null, wardAskedAt, province: true, street: !a.missing.includes("street"), corrected: true, ...contact };
    // Địa chỉ cũ ĐỦ mà chưa ghép được xã mới — từ dòng đơn nháp, hoặc từ chính tin khách cùng nơi giao.
    const legacy = !ward && (legacyAddressUnmapped(r.address, r.province) !== null || (decision.status === "NEW_EXPLICIT" && decision.use !== null && legacyAddressUnmapped(decision.use.raw) !== null));
    // «Như cũ» với địa chỉ đầy đủ đã xác minh (máy chủ đã điền) ⇒ tin «như cũ» CHÍNH LÀ lời chốt địa chỉ: xin lại là hỏi lặp.
    const settles = settlesAddress(last, ward) || (decision.status === "REUSE_VERIFIED" && addressSignalOf(last) === "REUSE");
    return { ward, wardAskedAt, province: a.province !== null || Boolean(stated) || legacy, street: !a.missing.includes("street") || legacy, lastSettlesAddress: settles, ...(legacy ? { legacyUnmapped: true } : {}), ...contact };
  }
  const [said] = customerStatedAddresses(customerTexts);
  if (said) return { ward: said.ward, wardAskedAt, province: said.province !== null, street: !said.missing.includes("street"), lastSettlesAddress: settlesAddress(last, said.ward), ...contact };
  if (decision.use) return { ...knowledgeOfLine(decision.use.raw, "", customerTexts, wardAskedAt, last), ...contact };
  return { ward: null, wardAskedAt, province: false, street: false, ...contact };
}

/** Điều đã biết từ MỘT dòng địa chỉ (khách gõ): xã tự điền được · địa giới cũ chưa ghép · hay chỉ phần đã đọc được. HÀM THUẦN. */
function knowledgeOfLine(line: string, province: string, customerTexts: readonly string[], wardAskedAt: number | null, last: string): AddressKnowledge {
  const a = parseCustomerAddress(line, province);
  const ward = canAutoFill(a) ? a.ward : null;
  // Lời sửa phường mới hơn ⇒ như luồng cũ: bot được hỏi lại.
  if (ward && a.province && customerTexts.slice(-1).some((m) => m.split(/\n+/).some((x) => x.trim() !== line.trim() && namesOtherWard(x, a.province!, ward)))) return { ward: null, wardAskedAt, province: true, street: true, corrected: true };
  const legacy = !ward && legacyAddressUnmapped(line, province) !== null;
  return { ward, wardAskedAt, province: a.province !== null, street: !a.missing.includes("street"), lastSettlesAddress: settlesAddress(last, ward), ...(legacy ? { legacyUnmapped: true } : {}) };
}

/** Câu HỎI phường / xã (đã gập) tự thân là câu hỏi: «phường nào», «phường / xã gì». */
const WARD_ASK = [
  /(?:^| )(?:phuong|xa|thi tran)(?: (?:phuong|xa))? (?:nao|gi)(?: |$)/,
  // Lời XIN tên phường / xã là câu hỏi dù không có dấu «?» («Mình cho em xin tên phường / xã mới để shop giao đúng nha.» — #855 P0-A2,
  // ca «ThivanNguyen»: nửa sau câu hỏi «Đại Kim cũ nay là phường nào theo tên mới» từng lọt hàng rào vì thiếu dấu hỏi).
  /(?:^| )xin(?: lai)?(?: giup)?(?: em| shop)?(?: lai)? (?:ten )?(?:phuong|xa)(?: |$)/,
];
/**
 * Chỉ tính là câu HỎI khi có dấu hiệu hỏi (`isQuestion`): «cho em xin tên phường … ạ?», «… hay phường B?», «theo địa giới mới …?». Câu
 * KỂ «Em xác nhận phường An Hội Tây cho mình nhé.» / «giao tới …, phường An Hội Tây» không phải câu hỏi (review PR #848).
 */
const WARD_ASK_Q = [
  /(?:^| )(?:xin|xac nhan|cho em biet|cho biet|bao|kiem tra|chon)(?: lai)?(?: giup)?(?: em| shop| minh| chi| anh)?(?: lai)?(?: (?:ten|dung))? (?:phuong|xa)(?: |$)/,
  /(?:^| )hay (?:phuong|xa) /,
  /(?:^| )dia gioi moi(?: |$)/,
];
/** Dấu hiệu câu hỏi: dấu «?», hoặc kết bằng tiểu từ hỏi («… không», «… chưa», «… nào» + «ạ / nhé / nha»). */
const isQuestion = (sentence: string, folded: string) => sentence.includes("?") || /(?:^| )(?:khong|ko|chua|nao|gi)(?: (?:a|nhe|nha|a nhe|a nha))?$/.test(folded);
/** Câu xin lại CẢ địa chỉ. */
const FULL_ADDRESS_ASK = /(?:^| )(?:xin|gui|cho em|nhan)(?: lai)?(?: giup em)? (?:thong tin )?dia chi(?: |$)/;
/** Câu nhắc địa chỉ MỚI / KHÁC, hay câu KỂ đã nhận («em đã nhận địa chỉ…») — không phải câu xin lại địa chỉ đã biết. */
const NOT_A_REASK = /(?:^| )(?:moi|khac)(?: |$)|(?:^| )(?:da|vua) nhan(?: |$)|(?:^| )dia chi (?:nha|cong ty|co quan|cua hang|cho|truong|van phong|kho|xuong)(?: |$)/;

/** Một câu (một đoạn giữa dấu chấm / hỏi / xuống dòng) có HỎI phường / xã không. HÀM THUẦN. */
export function asksForWard(sentence: string): boolean {
  const f = foldVnText(sentence);
  if (WARD_ASK.some((re) => re.test(f))) return true;
  return isQuestion(sentence, f) && WARD_ASK_Q.some((re) => re.test(f));
}

/** Một câu có xin lại CẢ địa chỉ không. HÀM THUẦN. */
export function asksForFullAddress(sentence: string): boolean {
  const f = foldVnText(sentence);
  return FULL_ADDRESS_ASK.test(f) && !NOT_A_REASK.test(f);
}

/** Câu xin lại SỐ ĐIỆN THOẠI (không phải câu xác nhận đuôi số «vẫn số đuôi 1234 phải không ạ?», không phải xin số MỚI / KHÁC). */
const PHONE_ASK = /(?:^| )(?:xin|gui|cho em|cung cap|de lai|nhan|cho shop)(?: lai)?(?: giup(?: em)?)?(?: (?:so dien thoai|sdt|so dt|so lien he|so dien thoai lien he))(?: |$)|(?:^| )(?:so dien thoai|sdt|so dt) (?:cua )?(?:minh|chi|anh|ban|nguoi nhan)? ?(?:la gi|la bao nhieu|bao nhieu)(?: |$)/;
/** Câu xin lại TÊN người nhận (không phải «tên phường / xã / đường / sản phẩm»). */
const NAME_ASK = /(?:^| )(?:xin|gui|cho em|cung cap|de lai)(?: lai)?(?: giup(?: em)?)? (?:ho ten|ho va ten|ten)(?! (?:phuong|xa|duong|pho|san pham|mon|tinh|thanh pho|quan|huyen|thi tran|khu|thon|ap))(?: |$)|(?:^| )(?:minh|chi|anh|ban|nguoi nhan) ten (?:la )?gi(?: |$)/;

/** Một câu có xin lại SĐT không. HÀM THUẦN. */
export function asksForPhone(sentence: string): boolean {
  const f = foldVnText(sentence);
  return PHONE_ASK.test(f) && !/(?:^| )(?:duoi|moi|khac)(?: |$)/.test(f);
}

/** Một câu có xin lại TÊN người nhận không. HÀM THUẦN. */
export function asksForName(sentence: string): boolean {
  const f = foldVnText(sentence);
  return NAME_ASK.test(f) && !/(?:^| )(?:moi|khac)(?: |$)/.test(f);
}

/** Câu thay khi cả tin chỉ là câu hỏi lại địa chỉ — ghi nhận, không hỏi gì thêm. */
export const ADDRESS_KNOWN_TEXT = "Dạ em ghi nhận địa chỉ của mình rồi ạ.";
/** Câu thay khi phải chuyển người kiểm thông tin nhận hàng (#855) — không hỏi khách thêm lần nào. */
export const ADDRESS_STAFF_TEXT = "Dạ em nhờ nhân viên kiểm tra lại thông tin nhận hàng của mình ngay ạ.";

/** Lý do chuyển người của hàng rào (#855) — một chỗ khai; nơi gọi (engine) ghi vào `notifySalesChatHandoff`. */
export const ADDRESS_HANDOFF_REASON = {
  REUSE_UNVERIFIED: "Khách muốn dùng địa chỉ cũ nhưng không có địa chỉ đầy đủ đã xác minh của đúng khách — AI định hỏi lại, đã chặn câu, nhân viên kiểm địa chỉ",
  REPEAT_ASK: "AI định hỏi lại thông tin nhận hàng đã hỏi / khách đã cho — đã chặn câu, nhân viên kiểm thông tin nhận hàng",
  COMPLAINT: "Khách phàn nàn bị hỏi lại thông tin đã cho — đã chặn câu hỏi của AI, nhân viên kiểm thông tin nhận hàng",
} as const;

/** Mã lý do của một lần chặn — đếm `address_reask` · `address_source_mismatch` · … trên bảng vận hành. */
export type AddressReaskCode = "WARD_KNOWN" | "WARD_ASKED" | "LEGACY_UNMAPPED" | "FULL_KNOWN" | "REUSE_UNVERIFIED" | "PHONE_KNOWN" | "NAME_KNOWN" | "REPEAT_ASK" | "COMPLAINT";
export type AddressReaskVerdict = { rest: string; note: string; handoff?: string };

/** Ghi chú cho người vận hành theo mã lý do — một chỗ khai (đếm `address_reask` theo đúng câu này). */
export const ADDRESS_REASK_NOTE: Record<AddressReaskCode, string> = {
  WARD_KNOWN: "AI hỏi lại phường / xã khách đã cho (máy chủ đã ghép được theo địa giới mới) — đã bỏ câu hỏi",
  WARD_ASKED: "AI hỏi lại phường / xã đã hỏi khách ở lượt trước — đã bỏ câu hỏi, đơn đi tiếp với cờ cần kiểm địa chỉ",
  LEGACY_UNMAPPED: "AI hỏi phường / xã theo địa giới mới khi khách đã cho địa chỉ đủ theo địa giới CŨ — đã bỏ câu hỏi; giữ nguyên văn, nhân viên kiểm (cờ cần kiểm địa chỉ)",
  FULL_KNOWN: "AI xin lại địa chỉ khách đã cho — đã bỏ câu hỏi",
  REUSE_UNVERIFIED: "Khách muốn dùng địa chỉ cũ, không có địa chỉ đầy đủ đã xác minh — đã bỏ câu hỏi lại, chuyển nhân viên kiểm",
  PHONE_KNOWN: "AI xin lại SĐT đã có — đã bỏ câu hỏi",
  NAME_KNOWN: "AI xin lại tên người nhận đã có — đã bỏ câu hỏi",
  REPEAT_ASK: "AI hỏi cùng một trường thông tin nhận hàng lần thứ hai — đã bỏ câu hỏi",
  COMPLAINT: "Khách phàn nàn bị hỏi lại — đã bỏ câu hỏi của AI, chuyển nhân viên",
  };


const sentencesOf = (text: string) => (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

/**
 * Câu bot sắp gửi có HỎI LẠI phần địa chỉ / SĐT / tên đã biết / đã hỏi không. Có ⇒ `rest` = các câu còn lại (có thể rỗng — nơi gọi quyết
 * câu thay), `note` = lý do cho người vận hành, `handoff` = lý do chuyển người khi máy chủ không được hỏi khách thêm lần
 * nào (khi đó `rest` đã kèm `ADDRESS_STAFF_TEXT`). Không ⇒ `null`. Phường chưa biết và chưa hỏi lần nào ⇒ câu hỏi đầu tiên đi qua —
 * TRỪ địa chỉ đủ theo địa giới CŨ mà danh mục chưa ghép được (#855, ca «Lieu Dau»): khách không phải tra tên phường mới, đơn mang cờ cần
 * kiểm cho nhân viên. `botTexts` (tuỳ chọn) = câu shop đã gửi ở các lượt TRƯỚC: một trường đã hỏi ở đó thì không hỏi lần 2. HÀM THUẦN.
 */
export function addressReaskVerdict(botText: string, k: AddressKnowledge, turn: number, opts: { botTexts?: readonly string[] } = {}): AddressReaskVerdict | null {
  const sentences = sentencesOf(botText);
  if (!sentences.length) return null;
  const prior = (opts.botTexts ?? []).flatMap(sentencesOf);
  const askedWardBefore = prior.some(asksForWard);
  const askedAddressBefore = prior.some(asksForFullAddress);
  const askedPhoneBefore = prior.some(asksForPhone);
  const askedNameBefore = prior.some(asksForName);
  const free = !k.corrected && !k.changeRequested;
  // Khách đang sửa phường ⇒ bot được hỏi / xác nhận lại — hàng rào không bỏ câu hỏi phường ở lượt đó.
  // Phường ĐÃ BIẾT chỉ chặn câu hỏi phường khi tin khách mới nhất xác nhận / mang chính địa chỉ đó — tin khác có thể là đổi người / nơi
  // nhận («gửi cho mẹ chị dưới quê»), bot phải hỏi được phường của nơi mới (review PR #848 lần 4).
  const wardKnown = free && k.ward !== null && Boolean(k.lastSettlesAddress);
  const wardAsked = free && k.ward === null && ((k.wardAskedAt !== null && k.wardAskedAt < turn) || askedWardBefore);
  const legacy = free && Boolean(k.legacyUnmapped) && (Boolean(k.lastSettlesAddress) || k.draftMismatch === true);
  const fullKnown = free && ((k.ward !== null && k.province && k.street) || Boolean(k.legacyUnmapped)) && Boolean(k.lastSettlesAddress);
  const reuse = free && Boolean(k.reuseUnresolved);
  const complaint = free && Boolean(k.complained);
  const wardDrop = wardKnown || wardAsked || legacy || reuse || complaint;
  const fullDrop = fullKnown || reuse || complaint || (free && askedAddressBefore && !k.ward);
  const phoneDrop = Boolean(k.phoneKnown) && free;
  const nameDrop = Boolean(k.nameKnown) && free;
  const phoneTwice = !k.phoneKnown && free && askedPhoneBefore;
  const nameTwice = !k.nameKnown && free && askedNameBefore;
  const drop = (s: string) => (wardDrop && asksForWard(s)) || (fullDrop && asksForFullAddress(s)) || ((phoneDrop || phoneTwice) && asksForPhone(s)) || ((nameDrop || nameTwice) && asksForName(s));
  const dropped = sentences.filter(drop);
  if (!dropped.length) return null;
  const rest = sentences.filter((s) => !drop(s)).join(" ");
  const addressAsk = dropped.some((s) => asksForWard(s) || asksForFullAddress(s));
  // Phải chuyển người: «như cũ» mà không có địa chỉ xác minh · khách phàn nàn bị hỏi lại · cùng một trường (địa chỉ / SĐT) đã hỏi rồi
  // mà vẫn chưa có — hỏi lần nữa chỉ là lặp, không thêm thông tin.
  const twiceAddress = addressAsk && askedAddressBefore && !k.ward && !k.legacyUnmapped;
  const twicePhone = phoneTwice && dropped.some(asksForPhone);
  let code: AddressReaskCode;
  let handoff: string | undefined;
  if (reuse && addressAsk) [code, handoff] = ["REUSE_UNVERIFIED", ADDRESS_HANDOFF_REASON.REUSE_UNVERIFIED];
  else if (complaint && addressAsk) [code, handoff] = ["COMPLAINT", ADDRESS_HANDOFF_REASON.COMPLAINT];
  else if (twiceAddress || twicePhone) [code, handoff] = ["REPEAT_ASK", ADDRESS_HANDOFF_REASON.REPEAT_ASK];
  else if (legacy && addressAsk) code = "LEGACY_UNMAPPED";
  else if (wardKnown && dropped.some(asksForWard)) code = "WARD_KNOWN";
  else if (wardAsked && dropped.some(asksForWard)) code = "WARD_ASKED";
  else if (fullKnown && dropped.some(asksForFullAddress)) code = "FULL_KNOWN";
  else if (dropped.some(asksForPhone)) code = "PHONE_KNOWN";
  else if (dropped.some(asksForName)) code = nameTwice ? "REPEAT_ASK" : "NAME_KNOWN";
  else code = "WARD_ASKED";

  const note = k.draftMismatch ? `${ADDRESS_REASK_NOTE[code]} · địa chỉ khách vừa gửi KHÁC đơn nháp (cần sửa đơn + người xác minh)` : ADDRESS_REASK_NOTE[code];
  if (handoff) return { rest: [rest, ADDRESS_STAFF_TEXT].filter(Boolean).join(" "), note, handoff };
  return { rest, note };
}
