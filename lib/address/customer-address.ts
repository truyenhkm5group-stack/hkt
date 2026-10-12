/**
 * ═══════════ ĐỊA CHỈ KHÁCH GÕ TỰ DO ⇒ KẾT QUẢ CÓ MỨC TIN CẬY + CÂU HỎI LẠI KHÁCH (P0 address-normalize, 11/10/2026) ═══════════
 *
 * Ca thật (hội thoại «Đỗ Minh Nguyệt», đơn #463DEBAE): «SN 242 đường cổ Nhuế, phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội». Bộ đọc
 * (`normalizeVnAddress`) trả ĐÚNG «AMBIGUOUS — Phường Thượng Cát / Phường Đông Ngạc» (phường Cổ Nhuế 2 cũ bị CHIA khi sáp nhập
 * 01/07/2025), nhưng kết quả ấy rơi mất ở `resolveRecipientPlace` (chỉ trả hai chuỗi tỉnh / xã) ⇒ bot không biết gì, không hỏi
 * khách, máy chốt đơn với ô xã trống ⇒ «Phường / Xã: Chưa ghép được».
 *
 * Tệp này KHÔNG có luật địa giới thứ hai — mọi tên tỉnh / xã đều đọc từ `vn-address.ts` (một nguồn: `vn-admin-2025.json`). Nó
 * chỉ (1) đặt tên mức tin cậy, (2) tách phần số nhà / đường, (3) nói phần nào còn thiếu, (4) soạn câu hỏi khách CHỈ từ ứng viên có
 * thật trong danh mục, (5) nhận xã khách vừa xác nhận. HÀM THUẦN — không CSDL, không mạng.
 *
 * Mức tin cậy:
 *  · `EXACT` — xã đọc bằng TÊN MỚI (sau 01/07/2025), một đáp án.
 *  · `UNIQUE_FROM_OLD` — quy từ tên CŨ (xã cũ + huyện cũ, hoặc huyện cũ chỉ còn một xã mới), một đáp án.
 *  · `AMBIGUOUS` — nhiều xã mới có thể đúng (xã cũ bị chia, chỉ có quận cũ, tên trùng) — `candidates` là danh sách THẬT.
 *  · `NOT_FOUND` — không đọc được xã (có thể có tỉnh), hoặc không đọc được cả tỉnh. Tỉnh chỉ suy được nhờ bung viết tắt tên quận
 *    («P13 GV») cũng ở đây: `province = null`, `missing` có `province`, cách đọc đi riêng ở `provinceHint` cho câu hỏi khách.
 * Chỉ `EXACT` / `UNIQUE_FROM_OLD` được tự điền (`canAutoFill`). Hai mức còn lại ⇒ hỏi khách, ô xã để trống, cờ cần kiểm giữ nguyên.
 */
import { expandAbbreviations, findProvince, findWardIn, foldVnText, isAdminName, normalizeVnAddress, type AddressMatch } from "@/lib/address/vn-address";

export const ADDRESS_CONFIDENCES = ["EXACT", "UNIQUE_FROM_OLD", "AMBIGUOUS", "NOT_FOUND"] as const;
export type AddressConfidence = (typeof ADDRESS_CONFIDENCES)[number];
export type AddressPart = "province" | "ward" | "street";

export type CustomerAddress = {
  /** Tên tỉnh / thành MỚI (34); `null` = chưa nhận ra. */
  province: string | null;
  provinceCode: number | null;
  /** Tên xã / phường / đặc khu MỚI — CHỈ khi `EXACT` / `UNIQUE_FROM_OLD`; mơ hồ ⇒ `null`, không chọn hộ. */
  ward: string | null;
  /** Phần trước đơn vị hành chính: số nhà, ngõ, đường, thôn / xóm — đúng chữ khách gõ. */
  street: string;
  /** Số nhà khi dòng mở đầu bằng nó («SN 242», «875/4B»); không thấy ⇒ `null` (không suy). */
  houseNumber: string | null;
  confidence: AddressConfidence;
  /** Xã / phường MỚI có thể đúng (chỉ `AMBIGUOUS`) — tên trong danh mục, không bao giờ bịa. */
  candidates: string[];
  /** Xã + huyện CŨ khách ghi (khi các ứng viên sinh ra từ đúng một xã cũ bị chia). */
  legacy: { ward: string; district: string } | null;
  /**
   * Cách đọc CHƯA XÁC NHẬN khi tỉnh chỉ suy được nhờ bung viết tắt tên quận («P13 GV» ⇒ quận Gò Vấp ⇒ TP HCM). `province` ở trên
   * vẫn `null` và `missing` vẫn có `province` — gợi ý chỉ để câu hỏi khách hỏi ĐÚNG tỉnh; `wardCandidates` = xã mới NẾU khách xác nhận.
   */
  provinceHint: { province: string; district: string; abbreviation: string; wardCandidates: string[] } | null;
  missing: AddressPart[];
  reason: string;
};

/** «Phường Cổ Nhuế 2» ⇒ «phường Cổ Nhuế 2» — trong câu nói với khách. */
const lowerType = (name: string) => name.replace(/^(Phường|Xã|Thị trấn|Đặc khu|Quận|Huyện|Thị xã|Thành phố)(?= )/u, (m) => m.toLowerCase());

const TYPE_START = /^(phuong|xa|thi tran|dac khu|quan|huyen|thi xa|thanh pho|tinh)( |$)/;

/**
 * Phần số nhà / ngõ / đường: đoạn chữ GỐC trước từ đầu tiên mở ra một đơn vị hành chính (tiền tố loại sau khi bung viết tắt —
 * «phường», «P.», «f1q5», «Q.1» — hoặc phần còn lại chỉ là tên tỉnh), hoặc trước đoạn (giữa hai dấu phẩy) chỉ là một tên hành
 * chính («…, Bắc Từ Liêm, …»).
 */
export function streetPart(address: string): string {
  const segments = address.split(",");
  const kept: string[] = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const folded = foldVnText(seg);
    if (s > 0 && folded && (TYPE_START.test(expandAbbreviations(folded)) || isAdminName(folded))) break;
    const words = seg.trim().split(/\s+/).filter(Boolean);
    let cut = words.length;
    for (let i = 0; i < words.length; i++) {
      const rest = expandAbbreviations(foldVnText(words.slice(i).join(" ")));
      if (!rest) continue;
      if (TYPE_START.test(rest) || (i > 0 && findProvince(rest) !== null)) {
        cut = i;
        break;
      }
    }
    const part = words.slice(0, cut).join(" ");
    if (part) kept.push(part);
    if (cut < words.length) break;
  }
  return kept.join(", ").replace(/[\s,.;:-]+$/u, "").trim();
}

function houseNumberOf(street: string): string | null {
  const m = street.match(/^\s*(?:(?:sn|số nhà|so nha|số|so|nhà|nha)\.?\s*)?(\d+[0-9A-Za-z/-]*)/iu);
  return m ? m[1] : null;
}

function confidenceOf(m: AddressMatch): AddressConfidence {
  if (m.status === "MATCHED") return m.via === "NEW_NAME" ? "EXACT" : "UNIQUE_FROM_OLD";
  if (m.status === "AMBIGUOUS") return "AMBIGUOUS";
  return "NOT_FOUND";
}

/**
 * Đọc MỘT địa chỉ khách gõ (+ chữ tỉnh nếu có ô riêng). Tỉnh khách gõ riêng mà nhận ra được thì thắng tỉnh đọc từ dòng (cùng thứ tự
 * với `resolveRecipientPlace`); xã đọc từ dòng thuộc tỉnh khác ⇒ không dùng.
 */
export function parseCustomerAddress(address: string, province = ""): CustomerAddress {
  const line = [address, province].filter((x) => x.trim()).join(", ");
  const m = normalizeVnAddress(line);
  const typed = province.trim() ? findProvince(province) : null;
  const prov = typed ?? ("province" in m ? m.province : null);
  const sameProvince = !typed || !("province" in m) || m.province.code === typed.code;
  const match: AddressMatch = sameProvince ? m : { status: "PROVINCE_ONLY", province: typed!, reason: "Xã / phường đọc được không thuộc tỉnh khách ghi." };
  const street = streetPart(address);
  const confidence = confidenceOf(match);
  const ward = match.status === "MATCHED" ? match.ward.name : null;
  const missing: AddressPart[] = [];
  if (!prov) missing.push("province");
  if (!ward) missing.push("ward");
  if (foldVnText(street).length < 3) missing.push("street");
  return {
    province: prov?.name ?? null,
    provinceCode: prov?.code ?? null,
    ward,
    street,
    houseNumber: houseNumberOf(street),
    confidence,
    candidates: match.status === "AMBIGUOUS" ? match.candidates.map((c) => c.name) : [],
    legacy: match.status === "AMBIGUOUS" ? (match.legacy ?? null) : null,
    provinceHint: !prov && match.status === "UNKNOWN" && match.hint ? { province: match.hint.province.name, district: match.hint.district, abbreviation: match.hint.abbreviation, wardCandidates: match.hint.candidates.map((c) => c.name) } : null,
    missing,
    reason: "reason" in match ? match.reason : "",
  };
}

/** Chỉ hai mức này được tự điền tỉnh + xã vào đơn. */
export function canAutoFill(a: Pick<CustomerAddress, "confidence">): boolean {
  return a.confidence === "EXACT" || a.confidence === "UNIQUE_FROM_OLD";
}

/** «A», «A hay B», «A, B hay C». */
function orList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} hay ${xs[xs.length - 1]}`;
}

/**
 * Câu hỏi khách cho phần còn thiếu — `null` khi không thiếu gì. Câu nêu tên xã chỉ khi có danh sách ứng viên THẬT; không có thì hỏi
 * chung, không gợi ý một tên nào.
 */
export function addressQuestion(a: CustomerAddress): string | null {
  const needStreet = a.missing.includes("street");
  const streetTail = needStreet ? " kèm số nhà, tên đường (hoặc thôn / xóm)" : "";
  if (a.confidence === "AMBIGUOUS" && a.candidates.length) {
    const options = orList(a.candidates.map(lowerType));
    if (a.legacy) return `Dạ ${lowerType(a.legacy.ward)} cũ nay thuộc ${options} theo địa giới mới ạ? Mình xác nhận giúp em${streetTail} để shop giao đúng nha.`;
    return `Dạ địa chỉ mình nay thuộc ${options} theo địa giới mới ạ? Mình xác nhận giúp em${streetTail} để shop giao đúng nha.`;
  }
  // Thiếu TỈNH là phần thiếu chính: hỏi tỉnh trước (xã mới phụ thuộc tỉnh). Có cách đọc từ viết tắt ⇒ hỏi xác nhận đúng cách đọc đó.
  if (a.missing.includes("province") && a.provinceHint) return `Dạ «${a.provinceHint.abbreviation}» trong địa chỉ mình là ${lowerType(a.provinceHint.district)} cũ ở ${a.provinceHint.province} phải không ạ? Mình xác nhận giúp em tỉnh / thành phố${streetTail} để shop giao đúng nha.`;
  if (a.missing.includes("province")) return `Dạ mình cho em xin phường / xã và tỉnh / thành phố của địa chỉ nhận hàng${streetTail} với ạ?`;
  if (a.missing.includes("ward")) return `Dạ mình cho em xin tên phường / xã (theo địa giới mới) của địa chỉ nhận hàng${streetTail} với ạ?`;
  if (needStreet) return "Dạ mình cho em xin số nhà, tên đường (hoặc thôn / xóm) để shop giao đúng ạ?";
  return null;
}

/**
 * Xã / phường MỚI khách vừa xác nhận ⇒ tên chuẩn. Hai điều kiện, thiếu một là từ chối (không đoán thay khách):
 *  1. Tên có trong danh mục xã của tỉnh đã nhận ra (chưa biết tỉnh ⇒ không nhận).
 *  2. Câu CUỐI của khách nhắc đúng tên đó — model không tự chọn một ứng viên rồi ghi vào đơn.
 */
export function acceptCustomerWard(a: Pick<CustomerAddress, "provinceCode" | "province">, ward: string, customerText: string): { ok: true; ward: string } | { ok: false; error: string } {
  if (!a.provinceCode) return { ok: false, error: "Chưa nhận ra tỉnh / thành của địa chỉ — hỏi khách tỉnh / thành trước, chưa ghi xã." };
  const hit = findWardIn(a.provinceCode, ward);
  if (!hit) return { ok: false, error: `«${ward}» không có trong danh mục xã / phường mới của ${a.province ?? "tỉnh này"} — hỏi lại khách, không tự chọn.` };
  const said = ` ${expandAbbreviations(foldVnText(customerText))} `;
  const core = foldVnText(hit.name).replace(/^(phuong|xa|thi tran|dac khu) /, "");
  const needle = /^\d+$/.test(core) ? foldVnText(hit.name) : core;
  if (!said.includes(` ${needle} `)) return { ok: false, error: `Khách chưa nói «${hit.name}» trong câu cuối — chỉ ghi xã / phường khi KHÁCH vừa xác nhận tên đó.` };
  return { ok: true, ward: hit.name };
}

/** Dòng ghi chú cho người kiểm (cờ ADDRESS_UNRESOLVED): ứng viên thật, hoặc lý do bộ đọc. */
export function addressReviewHint(a: CustomerAddress): string {
  if (a.provinceHint) return `${a.reason} Nếu đúng ${a.provinceHint.district} (${a.provinceHint.province}) thì xã mới có thể là: ${a.provinceHint.wardCandidates.join(" / ") || "chưa rõ"}`;
  if (a.confidence === "AMBIGUOUS" && a.candidates.length) return `${a.legacy ? `${a.legacy.ward} (${a.legacy.district}) cũ` : "Địa chỉ"} nay có thể thuộc: ${a.candidates.join(" / ")} — hỏi khách`;
  return a.reason;
}
