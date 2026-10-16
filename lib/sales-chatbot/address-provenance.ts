/**
 * ═══════════ ĐỊA CHỈ KHÁCH NÓI MỚI NHẤT THẮNG ĐỊA CHỈ CŨ — HÀNG RÀO MÁY CHỦ TRÊN DÒNG ĐỊA CHỈ GHI VÀO ĐƠN (P0 16/10/2026, #855) ═══════════
 *
 * Ca «ThuyNgo» (khách cũ HSLC): đơn nháp giữ «Khương Đình» — địa chỉ của khách CŨ (đơn trước / hồ sơ) — trong khi ở một tin MỚI HƠN khách
 * đã gõ một địa chỉ cụ thể ở Thủ Đức. Model chép lại địa chỉ cũ (khối KHÁCH CŨ của lời nhắc dặn «KHÔNG xin lại địa chỉ»), và
 * `update_draft_order` không gửi `address` thì đơn nháp cứ giữ người nhận cũ. Không lớp nào hỏi: địa chỉ sắp ghi có phải địa chỉ khách
 * nói MỚI NHẤT không?
 *
 * Nguồn của một địa chỉ (theo thứ tự tin cậy khi MỚI HƠN): tin KHÁCH (vị trí tin trong cửa sổ — `customerStatedAddresses`) · đơn trước ĐÃ
 * XÁC MINH của cùng khách (`use_saved_address` + lời xác nhận nguyên văn) · hồ sơ · nhân viên sửa. Luật:
 *  1. Địa chỉ khách gõ MỚI HƠN luôn thắng địa chỉ cũ / đã lưu.
 *  2. Địa chỉ cũ chỉ được dùng lại khi khách TỰ xin («địa chỉ cũ», «như lần trước») — và lời xin đó phải MỚI HƠN địa chỉ khách vừa gõ.
 *  3. Mới và cũ mâu thuẫn (khách gõ địa chỉ mới rồi lại nói «địa chỉ cũ») ⇒ NGƯỜI quyết, máy không chọn hộ.
 *
 * HÀM THUẦN — không CSDL, không mạng; chỉ đọc dòng địa chỉ sắp ghi và tin khách của lượt.
 */
import { customerStatedAddresses, parseCustomerAddress, sameStreet, streetCore, streetPart, type StatedAddress } from "@/lib/address/customer-address";
import { foldVnText } from "@/lib/address/vn-address";

export type AddressProvenanceVerdict =
  | { ok: true }
  /** Khách đã gõ một địa chỉ MỚI HƠN, khác nơi giao sắp ghi ⇒ ghi đúng địa chỉ khách gõ (model sửa lại lời gọi). */
  | { ok: false; kind: "NEWER_STATED"; stated: string; error: string }
  /** Khách gõ địa chỉ mới RỒI lại xin địa chỉ cũ (hay ngược lại không phân định được) ⇒ người quyết. */
  | { ok: false; kind: "CONFLICT"; stated: string; error: string; reason: string };

/** Dòng đọc lại một địa chỉ khách gõ (đường · xã · tỉnh) — để nói cho model / người kiểm. */
export function statedLine(a: Pick<StatedAddress, "street" | "ward" | "province">): string {
  // Khách hay gõ SĐT cùng dòng địa chỉ («0912345678 Khối 5, …») — bộ đọc lấy SĐT làm số nhà; bỏ đi để không so nhầm số nhà.
  const street = a.street.replace(/(?:\+?84|0)\d{8,10}/g, " ").replace(/\s+/g, " ").trim();
  return [street, a.ward, a.province].filter((x) => x && x.trim()).join(", ");
}

/** Lời dặn đứng ĐẦU dòng địa chỉ: «giao về», «gửi tới», «ship cho», «địa chỉ:», «đc:». */
const LEAD_IN_RE = /^\s*(?:(?:giao|gửi|gui|ship|chuyển|chuyen)(?:\s+(?:hàng|hang|chị|chi|em|anh|c|e|a))?\s+(?:về|ve|tới|toi|đến|den|qua|cho|ra|vào|vao)\s+|(?:địa chỉ|dia chi|đ\/c|đc|dc|add)\s*[:\-]?\s+)/iu;

/** Khoá so chữ địa chỉ (bỏ dấu, bỏ mọi ký tự không phải chữ / số). */
const keyOf = (s: string) => foldVnText(s).replace(/[^a-z0-9]/g, "");

/**
 * Hai nơi giao KHÁC nhau chắc chắn: khác tỉnh / khác xã khi cả hai bên đọc được, hoặc khác tên đường / khu (`sameStreet`). Không đủ
 * chữ để so ⇒ `false` (không kết luận khác — luật an toàn: không chặn khi không chắc). HÀM THUẦN.
 */
export function differentPlace(writing: string, province: string, stated: Pick<StatedAddress, "street" | "ward" | "province">): boolean {
  const w = parseCustomerAddress(writing, province);
  if (w.province && stated.province && w.province !== stated.province) return true;
  if (w.ward && stated.ward && w.ward !== stated.ward) return true;
  // Đường / khu: so phần TÊN (bỏ số nhà) — dòng khách gõ hay dính tên món / SĐT ở đầu («2kg chả cá…, Thu 09…, 9 Hai Bà Trưng») nên
  // số nhà bộ đọc rút ra từ tin khách không đáng tin để kết luận khác nhà.
  const ws = w.street || streetPart(writing);
  const ss = statedLine({ street: stated.street, ward: "", province: "" });
  if (streetCore(ws).length < 3 || streetCore(ss).length < 3) return false;
  return !sameStreet(ws, ss);
}

/**
 * Dòng địa chỉ sắp ghi vào khách / đơn (`writing` + `province`) có trái địa chỉ khách nói MỚI NHẤT không. `asksOld(text)` = câu khách xin
 * dùng lại địa chỉ cũ (bộ đọc của `customer-360.ts::reuseIntentOf` — nơi gọi truyền vào, tệp này không nạp CSDL). HÀM THUẦN.
 */
export function addressProvenanceVerdict(input: { writing: string; province?: string; customerTexts: readonly string[] | undefined; asksOld: (text: string) => boolean }): AddressProvenanceVerdict {
  const texts = (input.customerTexts ?? []).map((t) => t.trim()).filter(Boolean);
  if (!input.writing.trim() || !texts.length) return { ok: true };
  // Tin khách hay mở đầu dòng địa chỉ bằng lời dặn («Giao về 12 Lê Văn Việt…», «Địa chỉ: …») — bộ đọc coi «Giao về 12…» là tên đường
  // không có số nhà và bỏ qua dòng đó. Gỡ lời dặn ở ĐẦU DÒNG trước khi đọc (vị trí tin giữ nguyên).
  const [stated] = customerStatedAddresses(texts.map((t) => t.split(/\n+/).map((l) => l.replace(LEAD_IN_RE, "")).join("\n")));
  if (!stated) return { ok: true };
  const line = statedLine(stated);
  if (!differentPlace(input.writing, input.province ?? "", stated)) return { ok: true };
  // Chính dòng sắp ghi có trong một tin khách MỚI HƠN tin mang địa chỉ đã đọc ⇒ đó mới là địa chỉ khách nói sau cùng (bộ đọc chưa tự điền
  // được xã của nó nên không nằm trong `customerStatedAddresses`).
  const wk = keyOf(input.writing);
  if (wk.length >= 6 && texts.slice(stated.messageIndex + 1).some((t) => keyOf(t).includes(wk))) return { ok: true };
  // Khách xin địa chỉ cũ SAU khi đã gõ địa chỉ mới ⇒ hai lời khách mâu thuẫn: người quyết.
  if (texts.slice(stated.messageIndex + 1).some((t) => input.asksOld(t))) {
    return {
      ok: false,
      kind: "CONFLICT",
      stated: line,
      reason: `Khách gõ địa chỉ mới («${line.slice(0, 120)}») rồi lại xin dùng địa chỉ cũ — cần người xác nhận địa chỉ giao`,
      error: `Khách đã gõ địa chỉ MỚI «${line}» rồi lại nhắc địa chỉ cũ — KHÔNG tự chọn địa chỉ nào. Máy chủ đã chuyển nhân viên xác nhận địa chỉ giao với khách; KHÔNG nói đã cập nhật địa chỉ.`,
    };
  }
  return {
    ok: false,
    kind: "NEWER_STATED",
    stated: line,
    error: `Địa chỉ này KHÁC địa chỉ khách vừa gõ ở tin mới hơn: «${line}». Địa chỉ khách nói MỚI NHẤT luôn thắng địa chỉ cũ / đã lưu — gọi lại với address = đúng dòng địa chỉ khách đã gõ (giữ nguyên chữ khách). KHÔNG dùng địa chỉ đơn cũ, KHÔNG hỏi lại phần khách đã nói.`,
  };
}
