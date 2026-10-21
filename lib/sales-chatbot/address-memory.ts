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
import { canAutoFill, customerStatedAddresses, hasStreetDetail, legacyAddressUnmapped, looksLikeDeliveryAddress, looksLikeStreetFragment, namesOtherWard, parseCustomerAddress, sameDeliveryPlace, wantsAddressChange, wardFromCustomerWords, type AddressPart } from "@/lib/address/customer-address";

export { wantsAddressChange };
import { findProvince, foldVnText, isAdminName } from "@/lib/address/vn-address";
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import { sentencesOf } from "@/lib/sales-chatbot/text";
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
// «địa chỉ:» có dấu hai chấm, HOẶC «địa chỉ» theo ngay sau là số nhà / ngõ / thôn / tổ / khu (ca Ngô Thùy Nga #870: «Cho tôi 2kg, địa chỉ
// số 15 ngõ 7 … quận … Hà Nội SĐT …» — tin đặt hàng Messenger không có dấu hai chấm). «địa chỉ cũ», «địa chỉ như cũ» không khớp.
// Tiền tố nơi chốn PHẢI đi kèm con số (không còn «\d» trần — review #870): «địa chỉ 2 nơi nữa ở Hà Nội», «địa chỉ 1 người bạn» là lượng từ,
// không phải số nhà, và đọc nhầm thì máy chủ ghi đè địa chỉ đang giữ. «toàn / ngoài / khuya» không khớp vì sau tiền tố phải là số.
const LEAD_IN = /(?:(?:giao|gửi|gui|ship|chuyển|chuyen)(?: hàng| hang)? (?:về|ve|tới|toi|đến|den|qua|sang)|(?:địa chỉ|dia chi)(?: mới| moi)?(?:\s*:|\s+(?=(?:số nhà|so nha|số|so|sn|ngõ|ngo|ngách|ngach|hẻm|hem|kiệt|kiet|thôn|thon|xóm|xom|tổ|to|khu)\s*\d|\d+(?:\/\d+)*\s+(?:ngõ|ngo|ngách|ngach|hẻm|hem|kiệt|kiet|đường|duong|phố|pho)\s)))\s*/iu;
const TAIL_FILLER = /[\s,.;!]*(?:nhé|nhe|nha|nhá|ạ|a|em|shop|nhé em|nha em)?[\s,.;!]*$/iu;

/** Các cách đọc một dòng thành địa chỉ: nguyên dòng, rồi phần sau lời dẫn (bỏ tiểu từ cuối). HÀM THUẦN. */
/** Dấu hiệu câu kể chuyện đã qua / phàn nàn về giao hàng (có dấu, hoặc cụm không mơ hồ khi bỏ dấu). */
const NARRATIVE_ACCENTED = /(?:^|[\s,.!])(?:(?:lần|hôm|đơn|bữa|đợt|tuần|tháng) trước|hôm qua|chậm quá|lâu quá|giao chậm|giao lâu|mất \d+ ngày|mà \d+ ngày|\d+ ngày mới)(?=$|[\s,.!?])/u;
const NARRATIVE_FOLDED = /(?:^| )(?:lan truoc|hom truoc|bua truoc|dot truoc|tuan truoc|thang truoc|hom qua|cham qua|lau qua|giao cham|giao lau|mat \d+ ngay|ma \d+ ngay)(?: |$)/;
const isNarrative = (seg: string) => NARRATIVE_ACCENTED.test(seg.normalize("NFC").toLowerCase()) || NARRATIVE_FOLDED.test(foldVnText(seg));

function addressReadings(line: string): string[] {
  const out: string[] = [];
  const add = (x: string) => {
    const v = x.trim().replace(TAIL_FILLER, "").replace(/^(?:ở|tại|o|tai|về|ve)\s+/iu, "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  // Từng CÂU (tách ở «. » / «! » / «? »): một tin có thể mang hai địa chỉ của hai người («Chị ở <A>. Người nhận: …, <B>»).
  const whole = line.trim();
  for (const rawSeg of [whole, ...whole.split(/[.!?]\s+/).map((x) => x.trim()).filter((x) => x && x !== whole)]) {
    // VẾ kể chuyện đã qua / phàn nàn («Lần trước giao chậm quá», «12 Lê Lợi Huế mà 5 ngày») bị bỏ TỪNG VẾ (giữa dấu phẩy), không bỏ cả
    // câu: «giao về 5 Trần Phú, Đà Nẵng nhé, đơn trước chậm quá» vẫn còn lời giao. Vế mang lời dẫn giao («giao / gửi / ship về …») không
    // bao giờ bị bỏ (review #855).
    const seg = rawSeg.split(",").filter((c) => !isNarrative(c) || LEAD_IN.test(c.trim())).join(",").trim();
    if (!seg) continue;
    add(seg);
    const m = LEAD_IN.exec(seg);
    if (m) add(seg.slice(m.index + m[0].length));
    // Phần đuôi sau mỗi dấu phẩy / hai chấm, dài ⇒ ngắn: «…, Thu, 0915000404, Lô 3 khu Thử, Phường Cầu Giấy, Hà Nội», «… cơ quan chị: 10
    // đường Mẫu, Phường Đống Đa, Hà Nội nhé» — địa chỉ thường đứng CUỐI câu, sau tên / SĐT / lời dẫn.
    for (let i = 0; i < seg.length; i++) if (seg[i] === "," || seg[i] === ":" || seg[i] === ";") add(seg.slice(i + 1));
  }
  return out;
}

/** Dòng (hoặc phần sau lời dẫn của nó) là một địa chỉ giao ⇒ chuỗi địa chỉ; không ⇒ `null`. HÀM THUẦN. */
function deliveryAddressIn(line: string): string | null {
  return addressReadings(line).find((x) => looksLikeDeliveryAddress(x)) ?? null;
}

/** Lời đổi nơi giao TƯỜNG MINH đọc trên chữ CÓ DẤU (bỏ dấu thì «đợi chờ» = «đổi chỗ», «chờ khác» = «chỗ khác»). */
const CHANGE_CUE_ACCENTED = /(?:^|[\s,.!])(?:(?:đổi|thay|sửa)(?: lại)?(?: sang| qua)? (?:địa chỉ|chỗ|nơi|nhà)|địa chỉ (?:mới|khác)|chỗ khác|nơi khác|nhà khác|chuyển nhà|dọn nhà|không ở (?:đó|đấy|đây|chỗ cũ) nữa)(?=$|[\s,.!?])/u;
/** Bản không dấu — chỉ những cụm không mơ hồ khi bỏ dấu. */
const CHANGE_CUE_FOLDED = /(?:^| )(?:doi dia chi|doi dc|thay doi dia chi|sua dia chi|dia chi (?:moi|khac)|chuyen nha|don nha)(?: |$)/;
/** «chuyển / dọn ra · về · vào · sang · qua · đến · tới <nơi>» — chỉ là đổi địa chỉ khi phần sau là NƠI CHỐN (nhà / chỗ / địa chỉ / tỉnh / một địa chỉ). */
const MOVE_RE = /(?:^|[\s,.!])(?:chuyển|chuyen|dọn|don) (?:ra|về|ve|vào|vao|sang|qua|đến|den|tới|toi) (.+)$/iu;

function placeAhead(rest: string): boolean {
  const r = rest.normalize("NFC").toLowerCase().trim();
  if (/^(?:nhà|chỗ|địa chỉ|nơi|nha moi|cho moi|dia chi)(?=$|[\s,.!])/u.test(r)) return true;
  const words = r.replace(/[,.!?]/g, " ").split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) if (findProvince(words.slice(0, n).join(" "))) return true;
  return deliveryAddressIn(rest) !== null;
}

/**
 * Tin khách có tín hiệu đổi địa chỉ TƯỜNG MINH («đổi địa chỉ», «giao về <địa chỉ>», «chị chuyển nhà / chuyển ra HN rồi»). «chị chuyển qua
 * rồi nhé», «chuyển cho em rồi», «đợi chờ» KHÔNG phải (review độc lập #855). HÀM THUẦN.
 */
export function hasChangeCue(text: string): boolean {
  const t = text.normalize("NFC").toLowerCase();
  if (CHANGE_CUE_ACCENTED.test(t) || CHANGE_CUE_FOLDED.test(foldVnText(text))) return true;
  const move = MOVE_RE.exec(t);
  if (move && placeAhead(move[1] ?? "")) return true;
  const lead = LEAD_IN.exec(text.trim());
  return Boolean(lead && placeAhead(text.trim().slice(lead.index + lead[0].length)));
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
 *  · `CHANGE_INCOMPLETE` — SAU địa chỉ gõ gần nhất, khách nói đổi nơi giao / gửi mảnh địa chỉ mới mà chưa thành một địa chỉ đọc được
 *    («12 Lê Lợi, Huế» → «à chị chuyển ra HN rồi» → «Số 5 ngõ 10» → «Láng Hạ Đống Đa HN») ⇒ KHÔNG lấy bản cũ, không tự ghi gì: cần người.
 *  · `DRAFT` — chỉ có đơn nháp / hồ sơ (luồng cũ). · `NONE` — chưa có gì.
 * HÀM THUẦN — không CSDL. `verifiedHistory` (tuỳ chọn) = địa chỉ đơn cũ ĐÃ XÁC MINH của đúng khách mà nơi gọi lấy từ Customer 360
 * (`Customer360.addresses`, danh tính đã nối); không đưa ⇒ chỉ tin hồ sơ máy chủ đã điền qua `use_saved_address` (`savedAddress`).
 */
export type AddressDecisionStatus = "NEW_EXPLICIT" | "CHANGE_PENDING_VERIFICATION" | "CHANGE_INCOMPLETE" | "REUSE_VERIFIED" | "NEEDS_HUMAN" | "DRAFT" | "NONE";
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

/** Địa chỉ `raw` là bản ghép từ CHÍNH các tin khách kể từ mảnh địa chỉ cuối cùng (xem `deliveryAddressDecision`). HÀM THUẦN. */
function heldComposedFromCustomer(raw: string, customerTexts: readonly string[]): boolean {
  let fragAt = -1;
  let fragLine = "";
  customerTexts.forEach((m, i) => {
    for (const l of m.split(/\n+/)) {
      if (looksLikeStreetFragment(l)) {
        fragAt = i;
        fragLine = l;
      }
    }
  });
  if (fragAt < 0) return false;
  const p = parseCustomerAddress(raw);
  if (!p.ward || !p.province || !canAutoFill(p)) return false;
  const core = (s: string) => foldVnText(s).replace(/^(?:thanh pho|tinh|phuong|xa|thi tran|dac khu)\s+/, "").trim();
  const since = foldVnText(customerTexts.slice(fragAt).join(" "));
  return foldVnText(raw).includes(foldVnText(fragLine)) && since.includes(core(p.ward)) && since.includes(core(p.province));
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
  // Khách đang đổi nơi giao mà chưa gõ xong: tin MỚI NHẤT có tín hiệu đổi / mảnh địa chỉ nằm SAU địa chỉ đọc được gần nhất (và sau lời
  // «như cũ») ⇒ không lấy bản cũ, không tự ghi.
  let lastChange = -1;
  customerTexts.forEach((m, i) => {
    if (m.split(/\n+/).some((l) => hasChangeCue(l) || looksLikeStreetFragment(l))) lastChange = i;
  });
  if ((typed || held) && lastChange > Math.max(typed?.messageIndex ?? -1, reuseAt)) {
    // NƠI GIAO MỚI GÕ LÀM NHIỀU TIN (P0 21/10/2026, ca «Ngọc Bích»: «KCN Bắc Thăng Long, cổng công ty SANTOMAS» rồi «Phường …, Hà Nội»):
    // địa chỉ đang giữ là bản GHÉP từ đúng các tin đó — chứa NGUYÊN mảnh khách gõ, đọc ra đủ xã + tỉnh từ danh mục, và tên xã + tỉnh nằm
    // trong chính các tin khách từ mảnh đó trở đi ⇒ đó là địa chỉ khách vừa gõ, không phải «đang đổi mà chưa xong». Bản cũ không chứa mảnh
    // mới ⇒ vẫn CHANGE_INCOMPLETE như trước.
    if (held && heldComposedFromCustomer(held.raw, customerTexts)) return { status: "NEW_EXPLICIT", use: { ...held, messageIndex: customerTexts.length - 1 }, previous: typed, reason: "Địa chỉ ghép từ đúng các tin khách vừa gõ (nơi giao mới)" };
    return { status: "CHANGE_INCOMPLETE", use: null, previous: typed ?? held, reason: "Khách đang đổi nơi giao nhưng chưa gửi đủ một địa chỉ đọc được — không dùng địa chỉ cũ, không tự ghi; cần người" };
  }
  // Địa chỉ khách tự gõ MỚI HƠN lời «như cũ» (hoặc khách không nói «như cũ») ⇒ chữ khách thắng.
  if (typed && typed.messageIndex! > reuseAt) {
    // Địa chỉ đang giữ cũng nằm trong CHÍNH tin đó hoặc tin sau (đặt hộ: «Chị ở <A>. Người nhận: <B>») ⇒ hai địa chỉ của hai người,
    // không phải đổi nơi giao (đơn vàng «dat-ho-nguoi-than»).
    const heldStatedAlongside = held !== null && hasStreetDetail(held.raw) && customerTexts.slice(typed.messageIndex!).some((m) => m.split(/\n+/).some((l) => addressReadings(l).some((x) => looksLikeDeliveryAddress(x) && sameDeliveryPlace(held.raw, x))));
    if (held && !heldStatedAlongside && !sameDeliveryPlace(held.raw, typed.raw)) return { status: "CHANGE_PENDING_VERIFICATION", use: typed, previous: held, reason: "Khách vừa gửi địa chỉ giao KHÁC địa chỉ đơn nháp / hồ sơ đang giữ — địa chỉ mới thắng, đơn cần sửa theo nó và cần người xác minh" };
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
  /** Tin khách mới nhất HẸN gửi thông tin sau — câu bot nhắc lại không phải hỏi lặp. */
  deferred?: boolean;
  /** Tin khách mới nhất có lời phàn nàn bị hỏi lại («ở trên», «robot hả», «khách cũ mà hỏi gì») — CHỈ có hiệu lực khi trường đó đã được
   *  hỏi trong một câu bot gửi trước (hàng rào kiểm `botTexts`). */
  complained?: boolean;
  /** Tin khách mới nhất mang phần địa chỉ MỚI (địa chỉ / mảnh địa chỉ) ⇒ «revision» mới: câu hỏi địa chỉ trước đó không tính là đã hỏi. */
  lastAddsAddress?: boolean;
  /** Tin khách mới nhất mang SĐT ⇒ câu xin SĐT trước đó không tính là đã hỏi. */
  lastHasPhone?: boolean;
};

/** Lời đồng ý ngắn («ok em», «vâng», «đúng rồi», «chốt nhé»). */
const ACK = /^(?:ok|oke|okie|okay|uh|u|um|vang|da|dung|dung roi|duoc|chot|chot don|roi|co|yes)(?: (?:em|a|nhe|nha|shop|ban|roi|luon|di|vay|the))*$/;
/**
 * Tin khách MỚI NHẤT chính là tin mang địa chỉ, hoặc chỉ là lời đồng ý — chỉ khi đó câu bot «xin lại cả địa chỉ» mới chắc chắn là hỏi lại
 * điều vừa biết. Tin khác («gửi cho mẹ chị dưới quê nhé», «chị không ở đó nữa rồi») có thể là đổi người / nơi nhận mà không danh sách
 * mẫu nào bắt hết ⇒ hàng rào để câu xin địa chỉ đi qua (review PR #848 lần 4). HÀM THUẦN.
 */
/**
 * Tin CHỈ nói lịch giao («Giao sáng mai khoảng 9h», «chiều nay 5h nhé») — #871: khách đã gửi SĐT + địa chỉ rồi hẹn giờ, bot xin lại cả
 * hai. Mọi từ phải thuộc từ vựng LỊCH GIAO / tiểu từ và có ít nhất một mốc thời gian: chỉ cần MỘT từ lạ («mẹ», «quê», tên đường, tên
 * phường) là KHÔNG phải tin lịch giao, để «gửi cho mẹ chị dưới quê» vẫn được hỏi nơi nhận mới (review PR #848 lần 4). HÀM THUẦN.
 */
const SCHEDULE_WORDS = new Set("giao ship gui nhan hang don cho vao luc khoang truoc sau tu den hom nay mai ngay sang trua chieu kia mot cuoi tuan gio phut ruoi kem duoc khong ko nhe nha a ah voi giup dum nhanh som gap la thi tot oke ok vang da de the nhu nao roi hoac hay trong buoi shop sop".split(" "));
const SCHEDULE_TIME = new Set("nay mai kia sang trua chieu tuan gio".split(" "));
/** «thứ <ngày>» / «chủ nhật» — «thu», «hai», «ba», «nam»… đứng một mình là tên người («chị Thu», «anh Nam»), không phải ngày. */
const WEEKDAY = new Set("hai ba tu nam sau bay".split(" "));
/** Người nhận là CHÍNH khách («giao cho chị sáng mai») — chỉ hợp lệ khi theo sau là mốc / tiểu từ / động từ, không phải một cái tên. */
const SELF = new Set("em minh chi anh".split(" "));
const AFTER_SELF = new Set("sang trua chieu toi mai nay ngay hom nhe nha a ah nhan giao gui voi oi can muon lay khoang luc vao truoc sau".split(" "));
const CLOCK = /^\d{1,2}(?:h|g|gio)(?:\d{1,2})?$/;
export function isScheduleOnly(text: string): boolean {
  // «9:30» / «9.30» ⇒ «9h30» TRƯỚC khi gấp dấu (foldVnText bỏ dấu câu).
  const raw = text.normalize("NFC").replace(/(\d{1,2})[:.](\d{2})\b/g, "$1h$2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = raw.map((w) => foldVnText(w).trim());
  if (!words.length || words.length > 14) return false;
  let time = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    // «thứ 7» / «chủ nhật» / «tối nay · tối mai» là mốc (nuốt luôn từ sau); «tôi» / «tối» đứng khác chỗ («chị tôi») thì không.
    const pair = (w === "thu" && next !== undefined && (WEEKDAY.has(next) || /^\d$/.test(next))) || (w === "chu" && next === "nhat") || (w === "toi" && (next === "nay" || next === "mai"));
    if (CLOCK.test(w)) time = true;
    else if (pair) {
      time = true;
      i++;
    } else if (SELF.has(w)) {
      // «chị Mai» / «anh Nam» / «chị Hằng» — tên riêng viết hoa giữa câu, hoặc một từ không thuộc bảng ⇒ đổi NGƯỜI nhận, không phải lịch.
      if (next !== undefined && (!AFTER_SELF.has(next) || /^\p{Lu}/u.test(raw[i + 1]))) return false;
    } else if (SCHEDULE_TIME.has(w)) time = true;
    else if (/^\d{1,2}$/.test(w)) continue; // «7 giờ»
    else if (!SCHEDULE_WORDS.has(w)) return false;
  }
  return time;
}

function settlesAddress(last: string, ward: string | null): boolean {
  const f = foldVnText(last);
  const wardCore = ward ? foldVnText(ward).replace(/^(phuong|xa|thi tran|dac khu) /, "") : "";
  return ACK.test(f) || isScheduleOnly(last) || continuesSameOrder(last) || customerStatedAddresses([last]).length > 0 || deliveryAddressIn(last) !== null || last.split(/\n+/).some((l) => deliveryAddressIn(l) !== null) || (wardCore.length > 0 && ` ${f} `.includes(` ${wardCore} `));
}

/** Người nhận / nơi giao KHÁC («gửi cho mẹ chị», «ship về quê», «giao lên công ty», «người nhận khác», «không ở đó nữa»). Bản gập dấu. */
const OTHER_PLACE_OR_PERSON = new RegExp(
  [
    String.raw`(?:^| )(?:gui|giao|ship|chuyen|mang|dua)(?: hang| don| do)? (?:cho|ho|ve|toi|den|ra|sang|qua|o|len|xuong) (?:me|bo|ba|ma|chong|vo|con|ban|co|chu|di|ong|sep|dong nghiep|nguoi|nha|que|cong ty|co quan|cho lam|truong|van phong|kho|xuong|cua hang|shop|tiem|benh vien)(?: |$)`,
    String.raw`(?:^| )(?:nguoi nhan|nguoi khac|que|nha khac|cho khac|noi khac|dia chi khac|dia chi moi|khong o)(?: |$)`,
  ].join("|"),
);
/** Tin về CHÍNH ĐƠN đang chốt: hẹn giờ / ngày giao, thêm / đổi món (số + đơn vị, «lấy», «thêm»), hỏi giá một món. Bản gập dấu. */
const SAME_ORDER_TOPIC = new RegExp(
  [
    String.raw`(?:^| )(?:lay|them|mua|dat|order|bot|doi sang)(?: |$)`,
    String.raw`(?:^| )\d+(?:[.,]\d+)? ?(?:kg|ky|ki|kilo|g|gam|gram|hop|goi|tui|cai|chiec|phan|set|combo|lo|hu|khay|bich|con|mieng|vien|thung|chai|suat|lang)(?: |$)`,
    String.raw`(?:^| )(?:mot|hai|ba|bon|nam|muoi|nua) (?:kg|ky|ki|hop|goi|tui|cai|chiec|phan|set|combo|lo|hu|khay|bich|con)(?: |$)`,
    String.raw`(?:^| )(?:bao nhieu|gia|may tien|bn)(?: |$)`,
  ].join("|"),
);
/**
 * Tin khách mới nhất KHÔNG ĐỤNG tới thông tin nhận hàng mà nói tiếp về CHÍNH ĐƠN này (#871 ca «Ngọc Nguyễn», HSLC 16/10/2026: «Giao sáng
 * mai khoảng 9h», «Lấy 10 cái nem hải sản» sau khi đã gửi SĐT + địa chỉ đầy đủ). Trước bản này hàng rào chỉ coi tin MỚI NHẤT là «chốt địa
 * chỉ» khi chính nó mang địa chỉ hoặc là lời đồng ý — đổi chủ đề là địa chỉ đã biết bị coi như chưa biết, và câu xin lại SĐT + địa chỉ / xác
 * nhận lại phường lọt ra tới khách. Ba trạng thái, ĐÚNG MỘT đường cho mỗi cái:
 *  · `UNCHANGED_ADDRESS` (hàm này `true`): hẹn lịch giao · thêm / đổi món · hỏi giá — KHÔNG có lời đổi nơi giao / người nhận / SĐT;
 *  · `EXPLICIT_CHANGE_ADDRESS`: lời đổi tường minh (`wantsAddressChange`, `hasChangeCue`, người nhận / nơi giao khác) ⇒ `false`, bot được
 *    hỏi phần của nơi mới (review PR #848 lần 4 vẫn giữ: «gửi cho mẹ chị dưới quê nhé» không bị coi là cùng đơn);
 *  · `UNKNOWN_ADDRESS`: tin không thuộc hai loại trên («chị không ở đó nữa rồi em») ⇒ `false` — không chắc thì để câu hỏi đi qua.
 * HÀM THUẦN.
 */
export function continuesSameOrder(last: string): boolean {
  const f = foldVnText(last);
  if (!f.trim()) return false;
  if (wantsAddressChange(last) || hasChangeCue(last) || PHONE_CHANGE.test(f) || OTHER_PLACE_OR_PERSON.test(f)) return false;
  // Tin mang SĐT / địa chỉ / mảnh địa chỉ là chuyện của thông tin nhận hàng — đi đường riêng (`settlesAddress`, `lastAddsAddress`).
  if (hasPhone(last) || last.split(/\n+/).some((l) => deliveryAddressIn(l) !== null || looksLikeStreetFragment(l))) return false;
  // AN TOÀN MẶC ĐỊNH (review PR #878): MỘT dấu hiệu nơi giao / người nhận bất kỳ ⇒ không phải «cùng đơn» — câu hỏi được đi qua.
  if (placeOrRecipientSignal(last)) return false;
  return classifyDeliveryQuestion(last) !== null || SAME_ORDER_TOPIC.test(f) || SELF_DELIVERY.test(f.trim());
}

/** «giao cho chị nhé» — giao cho CHÍNH khách, không kèm gì khác. Bản gập dấu. */
const SELF_DELIVERY = /^(?:giao|gui|ship)(?: hang| don)? (?:cho|giup|gium|dum|ho) (?:chi|em|anh|minh)(?: (?:nhe|nha|a|voi|nhen|luon|di|nhanh|som|gap))*$/;

// ─────────────── DẤU HIỆU NƠI GIAO / NGƯỜI NHẬN (review PR #878 — an toàn mặc định) ───────────────
//
// `continuesSameOrder` = true thì địa chỉ cũ được GIỮ, câu hỏi lại bị bỏ và lời nhắc bảo model lên đơn NGAY. Sai một lần là giao nhầm
// nơi / nhầm người — nên ở đây KHÔNG liệt kê «các kiểu đổi địa chỉ» (không danh sách nào bắt hết), mà ngược lại: tin chỉ được coi là cùng
// đơn khi KHÔNG có một dấu hiệu nơi / người nào. Ca bản trước bỏ lọt: «giao 2kg tới chỗ làm chị nha», «lấy 2kg gửi ra Hà Nội giúp chị»,
// «chiều mai giao Thủ Đức giúp chị», «lấy 2 hộp cho em gái chị», «giao cho chị Mai sáng mai».

/** Giới từ hướng / nơi chốn — dạng CÓ DẤU (không lẫn «tối», «sáng», «quá», «tôi») và dạng không dấu (mơ hồ ⇒ vẫn tính, an toàn). */
const DIRECTION_TOKENS = new Set("tới đến về ra qua ở tận sang lên xuống tại toi den ve o tan len xuong tai".split(" "));
/** Từ người nhận: «cho / giúp / giùm / hộ / dùm» (không dấu cũng tính — «chợ», «hồ» có dấu thì không). */
const RECIPIENT_TOKENS = new Set("cho giúp giùm hộ dùm giup gium ho dum".split(" "));
const SEND_TOKENS = new Set("giao gửi gui ship chuyển chuyen mang đưa dua".split(" "));
/** Tiểu từ + từ chỉ THỜI GIAN + từ hỏi trạng thái (đã gập dấu) — phần đuôi chỉ gồm những từ này là «giờ giao», không phải nơi giao. */
const TIME_TAIL = new Set(
  (
    "nhe nha a ah ak voi vs nhen nghen ne nhi hen di luon nhanh gap som kip duoc dc khong ko k hong hok oi ha nhaa nua giup gium dum cung la thi roi tot ok oke dung hon " +
    // hỏi TRẠNG THÁI («đơn tới đâu rồi», «tới nơi chưa», «đến khi nào») — không nêu nơi giao nào
    "dau noi khi nao bao chua vay shop sop ad " +
    "mai mot nay hom ngay sang chieu toi trua dem khuya luc khoang tam gio h g phut ruoi kem truoc sau tuan thang cuoi dau chu nhat cn kia muon tre"
  ).split(" "),
);
/** Đại từ TỰ XƯNG — «giao cho chị nhé», «tới em nhé» là chính khách. */
const SELF_REF = new Set("chi em anh minh toi tui to c e a".split(" "));
/** Động từ sau «cho»: «cho chị hỏi», «cho em xin», «lấy giúp chị 2kg» — không phải người nhận. */
const VERB_AFTER = new Set("xin hoi lay them mua dat coi xem biet gui giao ship dung an thu nhan bot doi chot len".split(" "));
const NUMBER_WORD = new Set("mot hai ba bon nam sau bay tam chin muoi nua".split(" "));
const UNIT_WORD = new Set("kg ky ki kilo g gam gram hop goi tui cai chiec phan set combo lo hu khay bich con mieng vien thung chai suat lang".split(" "));
/** Nơi làm / học / nhà người thân (đã gập dấu, nguyên cụm). */
const PLACE_WORDS =
  /(?:^| )(?:cong ty|co quan|cho lam|noi lam|van phong|truong|ky tuc xa|ktx|benh vien|chung cu|toa nha|sieu thi|cua hang|xuong|tiem|que|nha (?:me|bo|ba|ma|ngoai|noi|chong|vo|ban|con|chau|em|anh|chi|co|chu|di|ong|moi|khac|rieng))(?: |$)/;
/** Đơn vị hành chính có loại («quận 3», «phường 5», «Q.1», «p5», «TP Thủ Đức»). Chữ thường, có dấu. */
const ADMIN_PREFIX_RE = /(?:^|[\s,.(])(?:quận|huyện|phường|xã|thị trấn|thị xã|thành phố|tp|quan|huyen|phuong|thi tran|thi xa|thanh pho)\.?\s*[\p{L}\d]|(?:^|[\s,.(])[qp]\.?\s?\d/u;
const SHORT_PROVINCE = /^(?:hcm|tphcm|sg|hn|hue)$/;

const tokenWord = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const capitalized = (w: string | undefined) => w !== undefined && /^\p{Lu}/u.test(w);

/** Phần đuôi CHỈ là giờ giao / tiểu từ / từ hỏi trạng thái (kể cả «thứ <ngày>», số giờ, một đại từ tự xưng / gọi). */
function pureTimeTail(raw: readonly string[]): boolean {
  const words = raw.map((w) => foldVnText(w).trim());
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || /^\d/.test(w)) continue;
    if (w === "thu" && words[i + 1] !== undefined && (WEEKDAY.has(words[i + 1]) || /^\d$/.test(words[i + 1]))) {
      i++;
      continue;
    }
    if (TIME_TAIL.has(w) && !capitalized(raw[i])) continue;
    // Đại từ tự xưng / gọi («tới chị nhé», «tới đâu rồi em») mà sau đó chỉ còn giờ / tiểu từ — không phải người nhận khác.
    if (SELF_REF.has(w) && !capitalized(raw[i + 1]) && pureTimeTail(raw.slice(i + 1))) return true;
    return false;
  }
  return true;
}

/** Sau «cho / giúp …»: chính khách / số lượng / động từ ⇒ không phải người nhận; còn lại (tên, «em gái», «bạn», «bé») ⇒ người nhận. */
function recipientAfter(raw: readonly string[]): boolean {
  const words = raw.map((w) => foldVnText(w).trim());
  const neutral = (i: number): boolean => {
    const w = words[i];
    if (w === undefined || w === "") return true;
    if (capitalized(raw[i])) return false; // tên riêng viết hoa («chị Mai», «em Hoa»)
    if (/^\d/.test(w) || TIME_TAIL.has(w) || VERB_AFTER.has(w) || UNIT_WORD.has(w) || w === "thu") return true;
    return NUMBER_WORD.has(w) && UNIT_WORD.has(words[i + 1] ?? "");
  };
  const w0 = words[0];
  if (w0 === undefined || w0 === "") return false;
  if (SELF_REF.has(w0)) return !neutral(1);
  if (capitalized(raw[0])) return true;
  if (NUMBER_WORD.has(w0)) return !UNIT_WORD.has(words[1] ?? "");
  return !neutral(0);
}

/** Có tên hành chính (tỉnh · xã mới · huyện / xã cũ) trong tin — loại có tiền tố, cụm 2–3 từ khớp danh mục, hay tên tỉnh viết tắt. */
function namesAdminUnit(text: string): boolean {
  if (ADMIN_PREFIX_RE.test(` ${text.normalize("NFC").toLowerCase()}`)) return true;
  const words = foldVnText(text).split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (SHORT_PROVINCE.test(words[i])) return true;
    for (const n of [3, 2]) {
      if (i + n > words.length) continue;
      const span = words.slice(i, i + n).join(" ");
      if (isAdminName(span) || findProvince(span)) return true;
    }
  }
  return false;
}

/**
 * Tin có dấu hiệu NƠI GIAO hay NGƯỜI NHẬN bất kỳ (review PR #878): giới từ hướng + thứ gì đó không phải giờ thuần · tên hành chính · nơi
 * làm / học / nhà người thân · «cho / giúp / giùm» + một người (trừ «cho chị / em / anh» tự xưng) · tên riêng viết hoa sau «cho / giao».
 * Không chắc ⇒ `true` (câu hỏi được đi qua). HÀM THUẦN.
 */
export function placeOrRecipientSignal(last: string): boolean {
  if (PLACE_WORDS.test(foldVnText(last)) || namesAdminUnit(last)) return true;
  for (const clause of last.normalize("NFC").split(/[,.;!?\n…]+/)) {
    const raw = clause.split(/\s+/).map(tokenWord).filter(Boolean);
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i].toLowerCase();
      const rest = raw.slice(i + 1);
      if (DIRECTION_TOKENS.has(t) && rest.length > 0) {
        // «toi» không dấu theo sau là động từ = «tôi lấy …», không phải «tới».
        if (!(t === "toi" && VERB_AFTER.has(foldVnText(rest[0]))) && !pureTimeTail(rest)) return true;
      }
      if (RECIPIENT_TOKENS.has(t) && recipientAfter(rest)) return true;
      // Tên riêng viết hoa ngay sau «cho / giao / gửi …» («giao Thủ Đức», «ship cho chị Lan») — trừ đại từ tự xưng viết hoa.
      if ((RECIPIENT_TOKENS.has(t) || SEND_TOKENS.has(t)) && rest.slice(0, 3).some((w) => capitalized(w) && !SELF_REF.has(foldVnText(w)))) return true;
    }
  }
  return false;
}

/**
 * Lời khách phàn nàn bị hỏi lại — cụm CÓ DẤU hoặc cụm dài không mơ hồ khi bỏ dấu (review #855: «may a» = «mấy ạ», «bot a» = «bột ạ»,
 * «hoi gi», «cho roi» trần bắt nhầm câu thường). Chỉ có hiệu lực khi cùng trường đã được hỏi trước đó (hàng rào kiểm).
 */
const COMPLAINT_ACCENTED = /(?:^|[\s,.!?])(?:robot|rô bốt|ở trên|coi ở trên|xem ở trên|đọc lại đi|nói rồi mà|gửi rồi mà|đã gửi rồi|nhắn rồi mà|khách cũ mà|hỏi gì nữa|hỏi hoài|hỏi mãi|hỏi lại hoài|hỏi nhiều thế)(?=$|[\s,.!?])/u;
const COMPLAINT_FOLDED = /(?:^| )(?:robot|coi o tren|xem o tren|noi roi ma|gui roi ma|da gui roi|nhan roi ma|khach cu ma hoi|hoi hoai|hoi mai the|hoi lai hoai)(?: |$)/;
const isComplaint = (text: string) => COMPLAINT_ACCENTED.test(text.normalize("NFC").toLowerCase()) || COMPLAINT_FOLDED.test(foldVnText(text));
/** Khách hẹn gửi thông tin sau («tối chị gửi», «để sau», «lát gửi», «gửi sau nhé»). */
const DEFER_RE = /(?:^| )(?:gui sau|de sau|lat (?:chi |anh |em )?gui|toi (?:chi |anh )?gui|chut (?:chi |anh )?gui|mai (?:chi |anh )?gui|sau (?:chi |anh )?gui)(?: |$)/;
/** SĐT di động VN trong một câu (bỏ khoảng trắng / chấm / gạch giữa các cụm số). */
const PHONE_IN_TEXT = /(?:\+?84|0)[35789]\d{8}(?!\d)/;
const hasPhone = (t: string) => PHONE_IN_TEXT.test(t.replace(/(\d)[ .-](?=\d)/g, "$1"));
/** Khách đổi SĐT / người nhận ⇒ câu xin SĐT / tên mới không bị bỏ. */
// «giao cho chị nhé», «giao cho em sáng mai» = chính khách (đại từ tự xưng theo sau là tiểu từ / mốc giờ / hết câu) — KHÔNG phải người nhận
// khác (#871: «giao cho chị 9h sáng mai» từng mở lại câu xin SĐT). «giao cho anh Huy», «gửi cho em gái chị» vẫn là người khác.
const PHONE_CHANGE = /(?:^| )(?:so|sdt|so dien thoai|so dt) (?:khac|moi)(?: |$)|(?:^| )doi (?:so|sdt)(?: |$)|(?:^| )nguoi nhan(?: |$)|(?:^| )(?:gui|giao|ship) (?:cho|ho) (?:me|bo|ba|ban|chong|vo|con|co|chu|di|ong)(?: |$)|(?:^| )(?:gui|giao|ship) (?:cho|ho) (?:em|anh|chi) (?!(?:nhe|nha|nhe|a|voi|vs|sang|chieu|toi|trua|mai|hom|ngay|luc|khoang|truoc|sau|som|di|luon|nhanh|gap|duoc|khong|ko|thu|chu nhat|\d)(?: |$|\d))[a-z]/;

/**
 * Đọc địa chỉ đã biết: đơn nháp (ô xã người / khách đã chọn, hoặc dòng địa chỉ tự điền được) → khách đã lưu → tin khách tự gõ (kể cả
 * khi model CHƯA gọi công cụ lưu khách — model hay hỏi lại ngay ở lượt khách vừa gửi địa chỉ). #855: địa chỉ khách vừa gõ KHÁC đơn nháp
 * thì ĐỊA CHỈ MỚI là điều đã biết (`deliveryAddressDecision`), không phải đơn nháp cũ. HÀM THUẦN.
 */
export function addressKnowledge(state: Pick<ChatState, "draft" | "customer" | "addressAsk">, customerTexts: readonly string[]): AddressKnowledge {
  const last = customerTexts[customerTexts.length - 1] ?? "";
  const lastF = foldVnText(last);
  // #871: «Giao cho chị sáng mai khoảng 9h» là lịch giao của CHÍNH khách, không phải đổi người nhận.
  const recipientChange = PHONE_CHANGE.test(lastF) && !isScheduleOnly(last);
  const contact = {
    phoneKnown: Boolean(state.customer?.phone?.trim() || state.draft?.recipient.phone?.trim() || customerTexts.some(hasPhone)) && !recipientChange,
    nameKnown: Boolean(state.customer?.name?.trim() || state.draft?.recipient.name?.trim()) && !recipientChange,
    complained: isComplaint(last),
    deferred: DEFER_RE.test(lastF),
    lastAddsAddress: last.split(/\n+/).some((l) => deliveryAddressIn(l) !== null || looksLikeStreetFragment(l) || legacyAddressUnmapped(l) !== null),
    lastHasPhone: hasPhone(last),
  };
  // Khách xin đổi địa chỉ ⇒ địa chỉ máy đang giữ KHÔNG còn là điều đã biết; câu hỏi phường / địa chỉ của bot đi qua.
  if (wantsAddressChange(last)) return { ward: null, wardAskedAt: null, province: false, street: false, changeRequested: true, ...contact, phoneKnown: false, nameKnown: false };
  const decision = deliveryAddressDecision(state, customerTexts);
  // Đang đổi nơi giao mà chưa đủ ⇒ chưa biết địa chỉ; bot được hỏi phần còn thiếu (một lần — hàng rào kiểm `botTexts`).
  if (decision.status === "CHANGE_INCOMPLETE") return { ward: null, wardAskedAt: null, province: false, street: false, changeRequested: true, ...contact };
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

/**
 * KHỐI «THÔNG TIN NHẬN HÀNG ĐÃ CÓ» cho lời nhắc (#871 — chủ shop: contact là nguồn sự thật của hội thoại). Ca «Ngọc Nguyễn»: khách đã gửi
 * SĐT + địa chỉ đầy đủ, model vẫn muốn «xác nhận lại địa chỉ / phường» TRƯỚC khi lên đơn; hàng rào bỏ câu hỏi đó và chỉ còn «em ghi nhận địa
 * chỉ» — đơn không bao giờ được lên vì không ai nói với model rằng thông tin đã đủ. Khối này là lời KHẲNG ĐỊNH của máy chủ (cùng bộ đọc với
 * hàng rào — `addressKnowledge`), có nguồn, KHÔNG chép SĐT / số nhà. Chỉ in khi chắc: có SĐT, có địa chỉ (phường đã ghép · địa giới cũ chờ
 * nhân viên · đủ tỉnh + phần đường), tin mới nhất không đổi nơi giao / người nhận, không có lời sửa đang chờ xác minh. HÀM THUẦN.
 */
export function knownContactPrompt(state: Pick<ChatState, "draft" | "customer" | "addressAsk">, customerTexts: readonly string[]): string {
  const k = addressKnowledge(state, customerTexts);
  const addressHeld = k.ward !== null || Boolean(k.legacyUnmapped) || (k.province && k.street);
  if (!k.phoneKnown || !addressHeld || !k.lastSettlesAddress || k.corrected || k.changeRequested || k.reuseUnresolved || k.draftMismatch) return "";
  const source = state.draft ? "đơn nháp của hội thoại" : state.customer ? "hồ sơ khách đã lưu trong hội thoại" : "tin khách đã gửi trong hội thoại";
  const addr = k.ward ? `địa chỉ ✓ (${k.ward})` : k.legacyUnmapped ? "địa chỉ ✓ (địa giới cũ — nhân viên đối chiếu phường mới, KHÔNG hỏi khách)" : "địa chỉ ✓ (nhân viên kiểm phần chưa chuẩn hoá, KHÔNG hỏi khách)";
  return `THÔNG TIN NHẬN HÀNG ĐÃ CÓ (máy chủ xác nhận — nguồn: ${source}): SĐT ✓ · ${addr}. KHÔNG xin lại SĐT / địa chỉ, KHÔNG xin xác nhận lại địa chỉ / phường — kể cả khi khách đang nói chuyện khác (giờ giao, thêm món, hỏi giá). Đã có món + số lượng ⇒ lên đơn NGAY trong lượt này (create_customer nếu chưa lưu, rồi create_draft_order / update_draft_order). Khách hẹn giờ giao ⇒ ghi delivery_note, nói đã nhận lời dặn giờ giao, KHÔNG hứa mốc, KHÔNG hứa sẽ báo lại.`;
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
/** Câu ghi nhận khi tin khách CHỈ là lịch giao (#871) — không hứa giờ (chưa có xác nhận của shop / ĐVVC) và không hứa một việc tiếp
 *  theo mà máy chủ không bảo đảm («shop báo lại»): chỉ nói đã nhận lời dặn. */
export const SCHEDULE_NOTED_TEXT = "Dạ em đã nhận lời dặn giờ giao của mình ạ.";
/** Câu thay khi câu bị bỏ là xin SĐT / tên đã có mà CHƯA có địa chỉ — không nói «đã ghi nhận địa chỉ». */
export const CONTACT_KNOWN_TEXT = "Dạ em ghi nhận thông tin của mình rồi ạ.";
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
  WARD_ASKED: "AI hỏi lại phường / xã đã hỏi khách ở lượt trước — đã bỏ câu hỏi, đơn đi với ô xã trống + cờ cần kiểm địa chỉ",
  LEGACY_UNMAPPED: "AI hỏi phường / xã theo địa giới mới khi khách đã cho địa chỉ đủ theo địa giới CŨ — đã bỏ câu hỏi; giữ nguyên văn, nhân viên kiểm (cờ cần kiểm địa chỉ)",
  FULL_KNOWN: "AI xin lại địa chỉ khách đã cho — đã bỏ câu hỏi",
  REUSE_UNVERIFIED: "Khách muốn dùng địa chỉ cũ, không có địa chỉ đầy đủ đã xác minh — đã bỏ câu hỏi lại, chuyển nhân viên kiểm",
  PHONE_KNOWN: "AI xin lại SĐT đã có — đã bỏ câu hỏi",
  NAME_KNOWN: "AI xin lại tên người nhận đã có — đã bỏ câu hỏi",
  REPEAT_ASK: "AI hỏi cùng một trường thông tin nhận hàng lần thứ hai — đã bỏ câu hỏi, chuyển nhân viên",
  COMPLAINT: "Khách phàn nàn bị hỏi lại — đã bỏ câu hỏi của AI, chuyển nhân viên",
};

/** Câu thật sự HỎI / XIN: dấu hiệu hỏi, hoặc lời xin («xin», «cho em», «gửi giúp em», «cung cấp»). */
const isAsking = (sentence: string) => {
  const f = foldVnText(sentence);
  return isQuestion(sentence, f) || /(?:^| )(?:xin|cho em|gui giup|gui lai giup|cung cap|de lai)(?: |$)/.test(f);
};
/** Tin page / nhân viên chép vào lịch sử — không phải câu của bot. */
const SHOP_SAID_RE = /^\s*\[Shop đã nhắn\]/;

type AskField = "ward" | "address" | "phone" | "name";
/** Các TRƯỜNG một câu đang xin. «địa chỉ» tính cả khi nằm trong câu xin nhiều thứ («xin số điện thoại và địa chỉ nhận hàng»). */
function askedFields(sentence: string): Set<AskField> {
  const out = new Set<AskField>();
  const f = foldVnText(sentence);
  if (asksForWard(sentence)) out.add("ward");
  if (asksForFullAddress(sentence) || (isAsking(sentence) && /(?:^| )dia chi(?: |$)/.test(f) && !NOT_A_REASK.test(f))) out.add("address");
  if (asksForPhone(sentence)) out.add("phone");
  if (asksForName(sentence)) out.add("name");
  return out;
}

/**
 * Câu bot sắp gửi có HỎI LẠI phần địa chỉ / SĐT / tên đã biết / đã hỏi không. Có ⇒ `rest` = các câu còn lại, `note` = lý do cho người
 * vận hành, `handoff` = lý do chuyển người. Không ⇒ `null`.
 *  · Một câu chỉ bị bỏ khi MỌI trường nó xin đều được bỏ (review #855: «xin số điện thoại và địa chỉ» khi đã có SĐT vẫn phải xin địa chỉ).
 *  · Bỏ một câu xin phần CHƯA CÓ (phường chưa biết đã hỏi rồi · «như cũ» không có địa chỉ xác minh · hỏi lần 2 · khách phàn nàn) ⇒ LUÔN
 *    chuyển người, `rest` kèm `ADDRESS_STAFF_TEXT` — không bao giờ để nơi gọi nói «đã ghi nhận địa chỉ» khi chưa có địa chỉ.
 *  · Phường chưa biết và chưa hỏi lần nào ⇒ câu hỏi đầu tiên đi qua — TRỪ địa chỉ đủ theo địa giới CŨ chưa ghép (#855 «Lieu Dau»): đó
 *    là đã có địa chỉ (nguyên văn), nhân viên kiểm.
 *  · `botTexts` (tuỳ chọn) = câu SHOP đã gửi ở các lượt trước (tin «[Shop đã nhắn]» bị bỏ — không phải câu bot): một trường đã hỏi ở đó
 *    thì không hỏi lần 2, TRỪ khi tin khách mới nhất mang phần mới của trường đó (revision mới). Phàn nàn chỉ có hiệu lực khi cùng
 *    trường đã được hỏi ở đó.
 * HÀM THUẦN.
 */
export function addressReaskVerdict(botText: string, k: AddressKnowledge, turn: number, opts: { botTexts?: readonly string[] } = {}): AddressReaskVerdict | null {
  const sentences = sentencesOf(botText);
  if (!sentences.length) return null;
  // «Hỏi lần 2» chỉ tính câu THẬT SỰ hỏi / xin («… ạ?», «cho em xin …») — câu kể có điều kiện («chị gửi địa chỉ là em lên đơn ngay»)
  // không phải câu hỏi lại; và khách đang HẸN gửi sau («tối chị gửi», «để sau») thì không phải hỏi lặp (order-golden «thieu-thong-tin»).
  const prior = (opts.botTexts ?? []).filter((t) => !SHOP_SAID_RE.test(t)).flatMap(sentencesOf).filter(isAsking);
  const priorAsked = (field: AskField) => prior.some((p) => askedFields(p).has(field));
  // Tin khách mới nhất đã trả lời một phần (thêm SĐT hoặc phần địa chỉ) ⇒ revision mới: xin tiếp phần CÒN THIẾU không phải hỏi lặp
  // (đơn vàng «nhieu-tin-roi»: «xin SĐT và địa chỉ» → khách gửi SĐT → «xin địa chỉ»).
  const progressed = Boolean(k.lastAddsAddress || k.lastHasPhone);
  const askedWardBefore = !progressed && (priorAsked("ward") || priorAsked("address"));
  const askedAddressBefore = !progressed && priorAsked("address");
  const askedPhoneBefore = !progressed && priorAsked("phone");
  const askedNameBefore = priorAsked("name");
  const repeatOk = sentences.some(isAsking) && !k.deferred;
  const free = !k.corrected && !k.changeRequested;
  // Phường ĐÃ BIẾT chỉ chặn câu hỏi phường khi tin khách mới nhất xác nhận / mang chính địa chỉ đó — tin khác có thể là đổi người / nơi
  // nhận («gửi cho mẹ chị dưới quê»), bot phải hỏi được phường của nơi mới (review PR #848 lần 4).
  const wardKnown = free && k.ward !== null && Boolean(k.lastSettlesAddress);
  const legacy = free && Boolean(k.legacyUnmapped) && (Boolean(k.lastSettlesAddress) || k.draftMismatch === true);
  const fullKnown = free && ((k.ward !== null && k.province && k.street) || Boolean(k.legacyUnmapped)) && Boolean(k.lastSettlesAddress);
  const addressHeld = k.ward !== null || Boolean(k.legacyUnmapped);
  // Mốc «đã hỏi phường»: khi nơi gọi đưa `botTexts` (engine) thì CHỈ tính câu thật sự đã gửi tới khách — mốc của công cụ
  // (`wardAskedAt`) ghi lúc công cụ trả câu hỏi, có thể chưa bao giờ tới khách. Không đưa (bài kiểm / nơi gọi cũ) ⇒ dùng mốc công cụ.
  const wardAskedSent = opts.botTexts !== undefined ? askedWardBefore : k.wardAskedAt !== null && k.wardAskedAt < turn;
  // Địa chỉ «chưa ghép danh mục» (#870) mà tin khách mới nhất không nhắc lại nó vẫn chịu luật hỏi-một-lần: đã hỏi phường rồi thì không hỏi
  // lại (trước đây `legacyUnmapped` bị loại khỏi vế này ⇒ câu hỏi lặp lọt qua).
  const wardAsked = free && k.ward === null && wardAskedSent && repeatOk;
  const reuse = free && Boolean(k.reuseUnresolved);
  const complaintOn = (field: AskField) => free && Boolean(k.complained) && (field === "phone" ? askedPhoneBefore : field === "name" ? askedNameBefore : askedAddressBefore || askedWardBefore || k.wardAskedAt !== null);
  const twice = (field: AskField) => free && repeatOk && (field === "phone" ? askedPhoneBefore && !k.phoneKnown : field === "name" ? askedNameBefore && !k.nameKnown : field === "address" ? askedAddressBefore && !addressHeld : false);
  // Vì sao bỏ được một trường (null = không bỏ). `missing` = trường đó CHƯA CÓ ⇒ bỏ là phải chuyển người.
  const why = (field: AskField): { code: AddressReaskCode; missing: boolean } | null => {
    if (reuse && (field === "ward" || field === "address")) return { code: "REUSE_UNVERIFIED", missing: true };
    if (complaintOn(field)) return { code: "COMPLAINT", missing: field === "phone" ? !k.phoneKnown : field === "name" ? !k.nameKnown : !addressHeld };
    if (field === "ward") {
      if (legacy) return { code: "LEGACY_UNMAPPED", missing: false };
      if (wardKnown) return { code: "WARD_KNOWN", missing: false };
      // Phường đã hỏi MỘT lần và khách đã trả lời (lượt này do chính tin khách mở ra) ⇒ bỏ câu hỏi, đơn đi với ô xã trống + cờ cần
      // kiểm; KHÔNG chuyển người — chỉ chuyển khi khách phàn nàn (nhánh COMPLAINT ở trên) hoặc đơn không lên được (cổng chốt).
      if (wardAsked) return { code: "WARD_ASKED", missing: !(k.province || k.street) };
      return null;
    }
    if (field === "address") {
      if (fullKnown) return { code: "FULL_KNOWN", missing: false };
      if (twice("address")) return { code: "REPEAT_ASK", missing: true };
      return null;
    }
    if (field === "phone") return free && k.phoneKnown ? { code: "PHONE_KNOWN", missing: false } : twice("phone") ? { code: "REPEAT_ASK", missing: true } : null;
    return free && k.nameKnown ? { code: "NAME_KNOWN", missing: false } : twice("name") ? { code: "REPEAT_ASK", missing: true } : null;
  };
  const reasons: { code: AddressReaskCode; missing: boolean }[] = [];
  const kept: string[] = [];
  for (const sentence of sentences) {
    const fields = [...askedFields(sentence)];
    const verdicts = fields.map(why);
    if (fields.length && verdicts.every((v) => v !== null)) reasons.push(...(verdicts as { code: AddressReaskCode; missing: boolean }[]));
    else kept.push(sentence);
  }
  if (!reasons.length) return null;
  const rest = kept.join(" ");
  const missing = reasons.find((r) => r.missing);
  const code = (missing ?? reasons[0]).code;
  const note = k.draftMismatch ? `${ADDRESS_REASK_NOTE[code]} · địa chỉ khách vừa gửi KHÁC đơn nháp (cần sửa đơn + người xác minh)` : ADDRESS_REASK_NOTE[code];
  // Không chuyển người mà không còn câu nào: chưa có địa chỉ thì KHÔNG để nơi gọi nói «đã ghi nhận địa chỉ».
  const addressRecorded = addressHeld || (k.province && k.street);
  if (!missing) return { rest: rest || (addressRecorded ? "" : CONTACT_KNOWN_TEXT), note };
  const handoff = code === "REUSE_UNVERIFIED" ? ADDRESS_HANDOFF_REASON.REUSE_UNVERIFIED : code === "COMPLAINT" ? ADDRESS_HANDOFF_REASON.COMPLAINT : ADDRESS_HANDOFF_REASON.REPEAT_ASK;
  return { rest: [rest, ADDRESS_STAFF_TEXT].filter(Boolean).join(" "), note, handoff };
}
