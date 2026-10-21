/**
 * ═══════════ SĐT ĐÃ BIẾT CỦA KHÁCH — MỘT NGUỒN CHO MỌI LUẬT (P0 21/10/2026) — HÀM THUẦN ═══════════
 *
 * Chủ shop 21/10/2026: «nhận diện chắc chắn khách cũ ⇒ tự nạp SĐT đã lưu, không xin lại». Ca HSLC (hội thoại e68f2cfe…): 04/10 khách
 * gõ địa chỉ + SĐT đúng lúc nhân viên đang trả lời trên page (tin vào sổ, không qua `create_customer`), nhân viên lên đơn «nối khoá bot».
 * 21/10 khách nhắn «chị 1kg chả cá thu nữa nhé»; tin cũ đã được chép vào lịch sử, và:
 *
 *   · hàng rào hỏi lại (`address-memory.ts::addressKnowledge`) coi SĐT là ĐÃ BIẾT (khách đã gõ trong hội thoại) ⇒ BỎ câu xin SĐT của model;
 *   · mức sẵn sàng của giỏ (`cart-commitment.ts::orderReadiness`) chỉ biết `state.customer.phone` + tin cuối ⇒ NEED_PHONE ⇒ khối «ĐƠN HIỆN
 *     TẠI» dặn model xin SĐT, và câu khi lượt im (`silenceFallbackText`) gửi lại «Dạ mình cho em xin số điện thoại nhận hàng nhé.».
 *
 * Hai luật nói hai điều khác nhau về cùng một sự việc. Tệp này là câu trả lời DUY NHẤT; mọi nơi hỏi «đã có SĐT chưa» đọc nó.
 *
 * NHẬN DIỆN CHẮC = cùng tổ chức (CSDL riêng) + cùng page + cùng luồng (PSID):
 *   · `THREAD_CUSTOMER` — khách đã lưu trong lượt mua này (`state.customer.phone`) — luôn thắng;
 *   · `THREAD_TYPED`    — SĐT khách TỰ GÕ trong chính luồng (tin khách của hội thoại, kể cả tin cũ chép từ Pancake);
 *   · `THREAD_ORDER`    — SĐT của đơn đã chốt của CHÍNH hội thoại (bot lên, nhân viên lên «nối khoá bot», đơn Pancake mang mã luồng);
 *   · `FB_ID`           — hồ sơ ERP khớp mã Facebook của người đang nhắn (của CHÍNH tổ chức).
 * KHÔNG BAO GIỜ: khớp qua SĐT người khác gõ (mức PHONE của Customer 360), tên Facebook, hay số page gõ trong tin của shop (số hotline).
 * Nhiều số KHÁC nhau ⇒ `MANY` — hỏi MỘT câu chọn số, không đoán. Chỉ ĐUÔI số được đọc ra lời nhắc / câu khách.
 */

/** SĐT Việt Nam về dạng 0xxxxxxxxx (Pancake có thể trả «+84…» / «84…»); không phải SĐT ⇒ `null`. HÀM THUẦN. */
export function normalizeVnPhone(raw: string): string | null {
  let v = raw.replace(/[^\d+]/g, "");
  if (v.startsWith("+84")) v = `0${v.slice(3)}`;
  else if (/^84\d{9}$/.test(v)) v = `0${v.slice(2)}`;
  return /^0\d{9,10}$/.test(v) ? v : null;
}

/**
 * SĐT trong một câu — tách theo CỤM (chữ số nối bằng một khoảng trắng / dấu chấm / gạch), mọi dãy cụm LIỀN NHAU. Không gộp các chữ số rời
 * rạc: «2 hộp 500g, 0912345678» chỉ cho ra 0912345678. HÀM THUẦN.
 */
export function phonesInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(/\+?\d+(?:[ .-]\d+)*/g) ?? []) {
    const groups = m.split(/[ .-]/).slice(0, 12);
    for (let i = 0; i < groups.length; i++)
      for (let j = i; j < groups.length; j++) {
        const p = normalizeVnPhone(groups.slice(i, j + 1).join(""));
        if (p) out.add(p);
      }
  }
  return [...out];
}

export type KnownPhoneSource = "THREAD_CUSTOMER" | "THREAD_TYPED" | "THREAD_ORDER" | "FB_ID";
export type KnownPhone = { kind: "ONE"; phone: string; sources: KnownPhoneSource[] } | { kind: "MANY"; phones: string[] } | { kind: "NONE" };
export const NO_KNOWN_PHONE: KnownPhone = { kind: "NONE" };

export type KnownPhoneInput = {
  /** `state.customer.phone` — khách đã lưu trong lượt mua này. */
  customerPhone?: string | null;
  /** Tin KHÁCH của chính hội thoại (không gồm tin page / bot). */
  customerTexts: readonly string[];
  /** SĐT của đơn nối CHẮC với hội thoại (Customer 360 mức THREAD / FB_ID). Mức PHONE KHÔNG được đưa vào đây. */
  orders?: readonly { phone: string; link: "THREAD" | "FB_ID" }[];
};

/** HÀM THUẦN. */
export function knownPhoneOf(input: KnownPhoneInput): KnownPhone {
  const own = normalizeVnPhone(input.customerPhone ?? "");
  if (own) return { kind: "ONE", phone: own, sources: ["THREAD_CUSTOMER"] };
  const found = new Map<string, Set<KnownPhoneSource>>();
  const add = (p: string | null, s: KnownPhoneSource) => {
    if (!p) return;
    const set = found.get(p) ?? new Set<KnownPhoneSource>();
    set.add(s);
    found.set(p, set);
  };
  for (const t of input.customerTexts) for (const p of phonesInText(t)) add(p, "THREAD_TYPED");
  for (const o of input.orders ?? []) add(normalizeVnPhone(o.phone), o.link === "FB_ID" ? "FB_ID" : "THREAD_ORDER");
  if (!found.size) return NO_KNOWN_PHONE;
  if (found.size > 1) return { kind: "MANY", phones: [...found.keys()] };
  const [[phone, sources]] = [...found.entries()];
  return { kind: "ONE", phone, sources: [...sources] };
}

/** Số dùng được để lên đơn khi khách chưa gõ số ở lượt này: ĐÚNG MỘT số đã biết. HÀM THUẦN. */
export function usableKnownPhone(k: KnownPhone | null | undefined): string | null {
  return k?.kind === "ONE" ? k.phone : null;
}

/** Bản lưu trong `state.knownPhone` (máy chủ ghi mỗi lượt AI): đúng MỘT số đã biết. Không có / nhiều số ⇒ `null`. HÀM THUẦN. */
export type KnownPhoneState = { phone: string; sources: KnownPhoneSource[]; at: string };
export function knownPhoneStateOf(k: KnownPhone, now: Date): KnownPhoneState | null {
  return k.kind === "ONE" ? { phone: k.phone, sources: k.sources, at: now.toISOString() } : null;
}

/**
 * SĐT HỘP THƯ HIỆN cho một hội thoại — MỘT thứ tự cho danh sách lẫn khung khách (P0 21/10/2026: danh sách lùi hồ sơ → state → ô của
 * hội thoại, khung khách chỉ đọc hồ sơ / `state.customer` ⇒ cùng hội thoại, danh sách có số mà khung in «Chưa có SĐT»). Màn của NHÂN
 * VIÊN: hồ sơ khách → khách đã lưu trong hội thoại → SĐT đã biết máy chủ ghi (`state.knownPhone`) → ô SĐT của hội thoại. HÀM THUẦN.
 */
export function inboxPhoneOf(p: { customerPhone?: string | null; statePhone?: string | null; knownPhone?: string | null; convPhone?: string | null }): string | null {
  for (const v of [p.customerPhone, p.statePhone, p.knownPhone, p.convPhone]) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return null;
}

/** Đuôi 4 số — cùng cách khối KHÁCH CŨ / Customer 360 đọc SĐT ra lời nhắc. */
export const phoneTail = (phone: string) => phone.replace(/\D/g, "").slice(-4);

/**
 * ĐỊA CHỈ LẦN TRƯỚC cho LƯỢT MUA MỚI (chủ shop 21/10/2026: «địa chỉ đã xác minh dùng lại theo chính sách shop, cần xác nhận thì chỉ hỏi
 * "giao địa chỉ lần trước không ạ?", không bắt gõ lại»). Shop chưa có cấu hình riêng ⇒ luôn HỎI MỘT CÂU, không tự điền vào đơn (lượt mua
 * mới không tự mang địa chỉ cũ). `summary` = phường / quận / tỉnh — KHÔNG số nhà (nơi gọi che). HÀM THUẦN.
 */
/**
 * Tóm tắt địa chỉ lần trước để đọc cho khách: ô phường / tỉnh của đơn nếu có; không thì các vế SAU vế đầu của dòng địa chỉ (vế đầu là số nhà /
 * ngõ / đường), bỏ vế có chữ số, tối đa hai vế cuối. Không có gì ⇒ `""` (câu hỏi dùng «địa chỉ lần trước»). KHÔNG BAO GIỜ đọc số nhà. HÀM THUẦN.
 */
export function addressSummaryOf(line: string, ward = "", province = ""): string {
  const admin = [ward.trim(), province.trim()].filter(Boolean);
  if (admin.length) return admin.join(", ");
  return line
    .split(",")
    .slice(1)
    .map((p) => p.trim())
    .filter((p) => p && !/\d/.test(p))
    .slice(-2)
    .join(", ");
}

export function previousAddressQuestion(summary: string): string {
  const s = summary.replace(/^…,?\s*/, "").trim();
  return s ? `Dạ em giao về ${s} như lần trước được không ạ?` : "Dạ em giao về địa chỉ lần trước của mình được không ạ?";
}

export function previousAddressPrompt(summary: string | null): string {
  if (summary === null) return "";
  const q = previousAddressQuestion(summary);
  return `ĐỊA CHỈ LẦN TRƯỚC (máy chủ — cùng hội thoại): lượt mua này CHƯA có địa chỉ. KHÔNG tự dùng địa chỉ cũ, KHÔNG bắt khách gõ lại, KHÔNG đọc số nhà: hỏi ĐÚNG MỘT câu «${q}». Khách đồng ý ⇒ create_customer với use_saved_address = true + customer_confirmation = nguyên văn lời đồng ý (máy chủ điền đủ địa chỉ + SĐT). Khách gửi địa chỉ khác ⇒ dùng địa chỉ khách vừa gửi.`;
}

/**
 * Khối lời nhắc «SĐT ĐÃ CÓ» — `""` khi không có gì để nói (lời nhắc các hội thoại khác không đổi). Chỉ ĐUÔI số. HÀM THUẦN.
 */
export function knownPhonePrompt(k: KnownPhone): string {
  if (k.kind === "ONE" && !k.sources.includes("THREAD_CUSTOMER")) {
    return `SĐT KHÁCH ĐÃ CÓ (máy chủ — cùng hội thoại${k.sources.includes("FB_ID") ? " / cùng mã Facebook" : ""}): đuôi ${phoneTail(k.phone)}. KHÔNG xin lại SĐT. Lưu khách / lên đơn ⇒ create_customer BỎ TRỐNG phone (máy chủ điền đúng số này). Khách tự nói đổi số ⇒ dùng số khách vừa gửi.`;
  }
  if (k.kind === "MANY") {
    return `SĐT KHÁCH: hội thoại có ${k.phones.length} số khác nhau (đuôi ${k.phones.map(phoneTail).join(" · ")}). KHÔNG xin số mới: hỏi ĐÚNG MỘT câu «Mình nhận hàng số đuôi ${k.phones.map(phoneTail).join(" hay ")} ạ?», khách chọn ⇒ create_customer với đúng số đó.`;
  }
  return "";
}
