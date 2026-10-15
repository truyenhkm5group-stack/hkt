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
import { expandAbbreviations, findProvince, findWardIn, foldVnText, isAdminName, normalizeVnAddress, oldDistrictsIn, wardOldDistricts, type AddressMatch } from "@/lib/address/vn-address";

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
   * Cách đọc CHƯA XÁC NHẬN khi tỉnh chỉ suy được nhờ bung viết tắt («P13 GV» ⇒ quận Gò Vấp ⇒ TP HCM; «q1»; «tp Vinh»; «f1q5»).
   * `province` ở trên vẫn `null` và `missing` vẫn có `province` — gợi ý chỉ để câu hỏi khách hỏi ĐÚNG tỉnh; `abbreviation` = chữ
   * viết tắt khi biết (`null` khi chỉ là viết tắt loại «q», «tp»); `wardCandidates` = xã mới NẾU khách xác nhận.
   */
  provinceHint: { province: string; district: string; abbreviation: string | null; wardCandidates: string[] } | null;
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
 * Trần số tên xã được NÊU trong MỘT câu hỏi khách (P0 15/10/2026, ca «Tuyet Nguyen Thi»: bot bắt khách chọn giữa 6 phường của quận Gò
 * Vấp cũ). Một xã cũ bị chia làm hai / ba là một câu chọn ngắn; nhiều hơn thì không còn là câu hỏi mà là bắt khách tra bản đồ ⇒ hỏi
 * ĐÚNG phần thiếu (tên phường / xã mới), không liệt kê. Danh sách đầy đủ vẫn nằm ở `candidates` cho người kiểm.
 */
export const MAX_WARDS_NAMED_IN_QUESTION = 3;

/**
 * Câu hỏi khách cho phần còn thiếu — `null` khi không thiếu gì. Câu nêu tên xã chỉ khi có danh sách ứng viên THẬT và ngắn
 * (≤ `MAX_WARDS_NAMED_IN_QUESTION`); không có / quá dài thì hỏi chung đúng phần thiếu, không gợi ý một tên nào.
 */
export function addressQuestion(a: CustomerAddress): string | null {
  const needStreet = a.missing.includes("street");
  const streetTail = needStreet ? " kèm số nhà, tên đường (hoặc thôn / xóm)" : "";
  if (a.confidence === "AMBIGUOUS" && a.candidates.length > MAX_WARDS_NAMED_IN_QUESTION) {
    if (a.legacy) return `Dạ ${lowerType(a.legacy.ward)} cũ nay là phường / xã nào theo tên mới ạ? Mình cho em xin tên phường / xã mới${streetTail} để shop giao đúng nha.`;
    return `Dạ mình cho em xin tên phường / xã (theo địa giới mới) của địa chỉ nhận hàng${streetTail} với ạ?`;
  }
  if (a.confidence === "AMBIGUOUS" && a.candidates.length) {
    const options = orList(a.candidates.map(lowerType));
    if (a.legacy) return `Dạ ${lowerType(a.legacy.ward)} cũ nay thuộc ${options} theo địa giới mới ạ? Mình xác nhận giúp em${streetTail} để shop giao đúng nha.`;
    return `Dạ địa chỉ mình nay thuộc ${options} theo địa giới mới ạ? Mình xác nhận giúp em${streetTail} để shop giao đúng nha.`;
  }
  // Thiếu TỈNH là phần thiếu chính: hỏi tỉnh trước (xã mới phụ thuộc tỉnh). Có cách đọc từ viết tắt ⇒ hỏi xác nhận đúng cách đọc đó.
  if (a.missing.includes("province") && a.provinceHint) {
    const h = a.provinceHint;
    const lead = h.abbreviation ? `«${h.abbreviation}» trong địa chỉ mình là ${lowerType(h.district)} cũ ở ${h.province}` : `địa chỉ mình thuộc ${lowerType(h.district)} cũ ở ${h.province}`;
    return `Dạ ${lead} phải không ạ? Mình xác nhận giúp em tỉnh / thành phố${streetTail} để shop giao đúng nha.`;
  }
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

// ─────────────────────────── CHỮ CỦA CHÍNH KHÁCH ───────────────────────────

/** Một cách đọc địa chỉ khách tự gõ + VỊ TRÍ tin mang nó (chỉ số trong mảng tin, cũ ⇒ mới) — để biết tin nào MỚI HƠN nó. */
export type StatedAddress = CustomerAddress & { messageIndex: number };

/**
 * ĐỊA CHỈ KHÁCH TỰ GÕ, đọc thẳng từ tin của khách (P0 15/10/2026). Công cụ của bot chỉ thấy dòng địa chỉ MODEL chép lại — ca «Tuyet Nguyen
 * Thi»: khách gõ «230/20 Phan Huy Ích, P An Hội Tây, TP.HCM» (phường MỚI sau sáp nhập), model không biết tên mới nên chép thành
 * «…, Gò Vấp, TP.HCM» ⇒ bộ đọc chỉ còn quận cũ ⇒ 6 phường ⇒ bot bắt khách chọn. Hàm này trả các cách đọc TỰ ĐIỀN ĐƯỢC của
 * những tin khách trông như một địa chỉ giao: từng dòng, cả tin, rồi tin đó ghép với tin ngay trước (khách gõ địa chỉ làm hai
 * tin — cách đọc ghép mang vị trí của tin CŨ hơn). Bỏ dòng là câu hỏi («phường An Hội Tây có ship không?») và dòng không có số nhà /
 * đường / khu thật (`streetLooksReal`). Cách đọc mà từ tin của nó trở về sau có một dòng nêu phường KHÁC («à em nhầm, phường An Hội
 * Đông nhé» — sửa không kèm đường; hay một địa chỉ khác hẳn) bị bỏ: khách đã sửa, phường cũ không còn là lời khai (review PR #848).
 * Thứ tự: mới nhất trước; không có ⇒ mảng rỗng. HÀM THUẦN.
 */
export function customerStatedAddresses(texts: readonly string[]): StatedAddress[] {
  const msgs = texts.map((t) => t.trim()).filter(Boolean);
  const out: StatedAddress[] = [];
  const seen = new Set<string>();
  const tryLine = (line: string, messageIndex: number) => {
    const l = line.trim();
    if (!l || l.includes("?") || seen.has(l)) return;
    seen.add(l);
    const a = parseCustomerAddress(l);
    if (!canAutoFill(a) || !streetLooksReal(a) || !a.ward || !a.province) return;
    // Từ CHÍNH tin mang địa chỉ trở về sau, xét TỪNG DÒNG: một dòng nêu phường khác là lời sửa (dòng của chính địa chỉ ra cùng phường).
    if (msgs.slice(messageIndex).some((m) => m.split(/\n+/).some((x) => namesOtherWard(x, a.province!, a.ward!)))) return;
    out.push({ ...a, messageIndex });
  };
  for (let i = msgs.length - 1; i >= 0; i--) {
    const lines = msgs[i].split(/\n+/);
    for (let j = lines.length - 1; j >= 0; j--) tryLine(lines[j], i);
    if (lines.length > 1) tryLine(lines.join(", "), i);
    if (i > 0) tryLine(`${msgs[i - 1].split(/\n+/).pop() ?? ""}, ${lines[0]}`, i - 1);
  }
  return out;
}

/**
 * Tin khách nêu một phường / xã KHÁC `ward` trong tỉnh `province` (đọc ra một phường khác, hoặc vài ứng viên không gồm `ward`) — lời SỬA
 * của khách, kể cả không kèm số nhà / đường. Tin không nhắc đơn vị hành chính nào («ok em», SĐT) ⇒ `false`. HÀM THUẦN.
 */
export function namesOtherWard(text: string, province: string, ward: string): boolean {
  if (text.includes("?")) return false;
  const f = expandAbbreviations(foldVnText(text));
  // Có chữ chỉ phường / xã («P15», «F15», «phường 15 cũ», «xã …») hoặc tên đọc ra được + lời sửa («nhầm», «không phải», «sai»).
  const wardToken = /(?:^| )(?:phuong|xa|thi tran|dac khu) [a-z0-9]/.test(f);
  const cue = /(?:^| )(?:nham|khong phai|ko phai|k phai|sai(?! gon))(?: |$)/.test(f);
  const own = normalizeVnAddress(text);
  const m = normalizeVnAddress(`${text}, ${province}`);
  const named = (r: AddressMatch) => r.status === "MATCHED" || r.status === "AMBIGUOUS";
  const isCurrent = (r: AddressMatch) => r.status === "MATCHED" && r.ward.name === ward;
  // Lời SỬA nói tới phường ⇒ sửa, kể cả khi câu nhắc lại chính phường cũ («không phải An Hội Tây, phường 15 cũ»).
  if (cue && (wardToken || named(own) || named(m))) return true;
  // Tin tự đọc ra một phường KHÁC (kể cả ở tỉnh khác — khách đổi hẳn địa chỉ) ⇒ sửa.
  if (own.status === "MATCHED" && own.ward.name !== ward) return true;
  if (m.status === "MATCHED") return m.ward.name !== ward;
  if (m.status === "AMBIGUOUS") return !m.candidates.some((c) => c.name === ward);
  // Có chữ chỉ phường mà KHÔNG đọc chắc ra chính phường đang giữ (phường số cũ thiếu quận: «à em nhầm P15») ⇒ coi là sửa — hướng an
  // toàn: bỏ cách đọc cũ, để bot hỏi (review PR #848, a5).
  return wardToken && !isCurrent(own) && !isCurrent(m);
}

const houseKey = (h: string | null) => (h ? h.toLowerCase() : null);

/**
 * Phần trước đơn vị hành chính có thật là SỐ NHÀ / ĐƯỜNG / KHU không: có số nhà, hoặc mở đầu bằng một tiếng chỉ nơi chốn (khu, KĐT, thôn,
 * xóm, ấp, ngõ, hẻm, đường, phố, tổ, lô, chung cư…). «à em nhầm, phường An Hội Đông» có «phần đường» là «à em nhầm» — đó là câu nói,
 * không phải một địa chỉ để ghép (review PR #848).
 */
function streetLooksReal(a: Pick<CustomerAddress, "street" | "houseNumber">): boolean {
  if (a.houseNumber) return true;
  return /^(?:khu|kdt|thon|xom|ap|ban|ngo|ngach|hem|kiet|duong|pho|to|cum|lo|toa|chung cu|cc|so)(?: |$)/.test(foldVnText(a.street));
}

/** Phần TÊN ĐƯỜNG / khu đã gập, bỏ số nhà và chữ «số / SN / nhà» ở đầu («230/20 Phan Huy Ích» ⇒ «phan huy ich»). */
function streetCore(street: string): string {
  const words = foldVnText(street).split(" ").filter(Boolean);
  let i = 0;
  while (i < words.length && (/\d/.test(words[i]) || ["so", "sn", "nha"].includes(words[i]))) i++;
  return words.slice(i).join(" ");
}

/** Hai phần đường cùng nói một con đường / một khu: cả hai đủ dài và cái này nằm trọn (đủ từ) trong cái kia. */
function sameStreet(x: string, y: string): boolean {
  const a = streetCore(x);
  const b = streetCore(y);
  if (a.length < 3 || b.length < 3) return false;
  return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/**
 * Xã / phường MỚI lấy từ CHÍNH chữ khách khi dòng địa chỉ của công cụ (`a` — bản model chép) chưa tự điền được. Chỉ nhận khi KHỚP với
 * dòng của công cụ — không bao giờ ghép xã của một địa chỉ khác vào (review độc lập PR #848: «12 Lê Lợi, P Bến Thành» rồi khách đổi sang
 * «12 Nguyễn Văn Lượng, Gò Vấp» từng nhận Bến Thành vì chỉ so số nhà):
 *  · CÙNG ĐƯỜNG (tên đường / khu, đã gập, cái này nằm trọn trong cái kia) — bắt buộc;
 *  · cùng số nhà khi cả hai có số nhà;
 *  · cùng tỉnh khi dòng công cụ đọc được tỉnh; dòng công cụ KHÔNG có tỉnh ⇒ chỉ nhận địa chỉ trong tin khách MỚI NHẤT có địa chỉ
 *    (không mượn tỉnh + xã của một địa chỉ cũ hơn);
 *  · không tin khách nào mới hơn nêu một phường khác (`customerStatedAddresses`).
 * Trả tên chuẩn xã + tỉnh và mức tin cậy của tin khách; không có ⇒ `null`. HÀM THUẦN.
 */
export function wardFromCustomerWords(a: CustomerAddress, toolAddress: string, texts: readonly string[] | undefined): { ward: string; province: string; provinceCode: number; confidence: AddressConfidence } | null {
  if (canAutoFill(a) || !texts?.length) return null;
  const toolStreet = a.street || streetPart(toolAddress);
  const msgs = texts.map((t) => t.trim()).filter(Boolean);
  // Tin khách MỚI NHẤT có dáng một địa chỉ (số nhà + đọc được tỉnh / ứng viên xã / gợi ý tỉnh) — chỉ số trong cùng mảng đã lọc.
  let newestAddress = -1;
  for (let i = msgs.length - 1; i >= 0 && newestAddress < 0; i--) {
    if (msgs[i].split(/\n+/).some((l) => {
      const p = parseCustomerAddress(l);
      return (p.houseNumber !== null || /\d/.test(p.street)) && (p.province !== null || p.candidates.length > 0 || p.provinceHint !== null);
    })) newestAddress = i;
  }
  for (const s of customerStatedAddresses(msgs)) {
    if (!s.ward || !s.province || s.provinceCode === null) continue;
    if (a.provinceCode !== null ? a.provinceCode !== s.provinceCode : s.messageIndex < newestAddress) continue;
    if (!sameStreet(toolStreet, s.street)) continue;
    // Dòng công cụ nhắc một quận / huyện CŨ mà phường của tin khách không có đất ở đó (Bến Thành vs Gò Vấp) ⇒ hai địa chỉ khác nhau.
    const toolDistricts = oldDistrictsIn(toolAddress, s.provinceCode);
    if (toolDistricts.length && !wardOldDistricts(s.ward, s.provinceCode).some((d) => toolDistricts.includes(d))) continue;
    const hn = houseKey(a.houseNumber);
    const hs = houseKey(s.houseNumber);
    if (hn && hs && hn !== hs) continue;
    return { ward: s.ward, province: s.province, provinceCode: s.provinceCode, confidence: s.confidence };
  }
  return null;
}
