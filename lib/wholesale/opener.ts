import type { LeadHunterConfig } from "@/lib/wholesale/config";
import type { OutreachChannel } from "@/lib/wholesale/constants";
import { LEAD_SEGMENT_LABEL, type LeadSegment } from "@/lib/wholesale/segments";

/**
 * ═══════════ LỜI CHÀO & KÊNH LIÊN HỆ — HÀM THUẦN ═══════════
 *
 * Lời chào ghép từ DỮ KIỆN CÓ THẬT: tên doanh nghiệp, nhóm khách, khu vực (của lead) + tên shop, sản phẩm, MOQ, vùng
 * giao, khuyến mãi (cấu hình của shop). Thiếu dữ kiện nào thì bỏ cụm đó, không điền chỗ trống bằng lời đoán.
 *
 * AI (outreach.ts) chỉ được DIỄN ĐẠT LẠI cùng bộ dữ kiện này; `openerLooksInvented` chặn câu AI chứa số điện thoại /
 * con số / đường link không có trong dữ kiện — chặn thì dùng mẫu.
 */

export type OpenerFacts = {
  businessName: string;
  segment: LeadSegment;
  areaName: string | null;
  provinceLabel: string | null;
};

export function openerVariables(cfg: LeadHunterConfig, f: OpenerFacts): Record<string, string> {
  const area = [f.areaName, f.provinceLabel].filter(Boolean).join(", ");
  const seg = LEAD_SEGMENT_LABEL[f.segment];
  return {
    ten_doanh_nghiep: f.businessName,
    ten_shop: cfg.outreach.shopName || "bên em",
    san_pham: cfg.outreach.productLine || "hải sản",
    nhom_khach: cfg.outreach.targetAudience || "nhà hàng, quán ăn",
    loai_hinh: f.segment === "UNCLASSIFIED" ? "ăn uống" : seg.toLowerCase(),
    khu_vuc: area ? ` ở ${area}` : "",
    moq: cfg.outreach.moqNote,
    giao_hang: cfg.outreach.deliveryNote,
    khuyen_mai: cfg.outreach.promotionNote,
    catalog: cfg.outreach.catalogNote,
    bang_gia: cfg.outreach.pricingNote,
  };
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/** Lời chào theo mẫu + (nếu shop đã khai) một câu MOQ / giao hàng / khuyến mãi. */
export function templateOpener(cfg: LeadHunterConfig, f: OpenerFacts): string {
  const vars = openerVariables(cfg, f);
  const extras = [cfg.outreach.promotionNote, cfg.outreach.moqNote, cfg.outreach.deliveryNote].map((s) => s.trim()).filter(Boolean);
  const base = renderTemplate(cfg.outreach.openerTemplate, vars);
  return extras.length ? `${base} ${extras.join(". ")}${/[.!?]$/.test(extras[extras.length - 1]!) ? "" : "."}` : base;
}

/**
 * Câu AI có «bịa» không: số điện thoại, đường link, email, hay con số (giá, %, năm…) KHÔNG xuất hiện trong dữ kiện đã
 * đưa ⇒ coi là bịa. Thô nhưng an toàn về phía hẹp: chặn nhầm thì chỉ là dùng mẫu thay cho câu AI.
 */
export function openerLooksInvented(text: string, factsText: string): string | null {
  if (/https?:\/\/|www\./i.test(text) && !/https?:\/\/|www\./i.test(factsText)) return "có đường link";
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return "có email";
  const numbers = text.match(/\d[\d.,]*/g) ?? [];
  for (const n of numbers) {
    const digits = n.replace(/[.,]/g, "");
    if (digits.length && !factsText.replace(/[.,]/g, "").includes(digits)) return `có con số «${n}» không có trong dữ kiện`;
  }
  if (text.length > 900) return "quá dài";
  return null;
}

/**
 * Một câu «lợi ích» theo NHÓM KHÁCH — cách diễn đạt, không phải dữ kiện về doanh nghiệp (không khen, không đoán quy mô).
 * Quán ăn / nhậu dùng hàng làm món; cửa hàng bán lại; mẹ & bé nấu cho bé.
 */
const SEGMENT_PITCH: Partial<Record<LeadSegment, string>> = {
  SPECIALTY_STORE: "bổ sung thêm mặt hàng đóng gói sẵn lên kệ, khách mua làm quà tiện",
  GROCERY: "nhập thêm về bán lẻ cho khách quanh khu",
  FROZEN_FOOD_STORE: "nhập thêm về bán lẻ cho khách",
  SUPERMARKET: "nhập thêm về bán lẻ cho khách",
  MOM_BABY: "nhập thêm cho các mẹ mua về nấu cho bé",
  SEAFOOD_RESTAURANT: "thêm món nhắm, món ăn kèm chế biến nhanh cho quán",
  PUB_BEER: "thêm món nhắm chế biến nhanh cho quán",
  EATERY: "thêm món ăn kèm chế biến nhanh cho quán",
  HOTPOT: "thêm đồ nhúng lẩu chế biến sẵn cho quán",
  BBQ: "thêm món nướng, món nhắm chế biến nhanh cho quán",
  RESTAURANT: "thêm món chế biến nhanh cho thực đơn",
};

/** Biến của kịch bản Zalo = biến lời chào + tên nhân viên (tên gọi = chữ cuối) + câu lợi ích theo nhóm khách. */
export function zaloVariables(cfg: LeadHunterConfig, f: OpenerFacts, staffName: string): Record<string, string> {
  const base = openerVariables(cfg, f);
  const given = staffName.trim().split(/\s+/).filter(Boolean).at(-1) ?? "";
  return {
    ...base,
    ten_nv: given || "em",
    ho_ten_nv: staffName.trim(),
    loi_ich: SEGMENT_PITCH[f.segment] ?? "tham khảo thêm nguồn hàng",
    // Chỉ nói «em gửi hình» khi shop ĐÃ chọn ảnh kèm — không hứa thứ nhân viên không có trong tay.
    gui_anh: cfg.outreach.zaloImages.length ? "Em gửi anh/chị vài hình sản phẩm tham khảo ạ. " : "",
  };
}

/** Tin Zalo đã cá nhân hoá. Dòng rỗng sau khi điền biến bị bỏ — kịch bản không lòi ra dòng trống / «{{khuyen_mai}}». */
export function zaloMessage(cfg: LeadHunterConfig, f: OpenerFacts, staffName: string): string {
  const vars = zaloVariables(cfg, f, staffName);
  return cfg.outreach.zaloTemplate
    .split(/\r?\n/)
    .map((line) => renderTemplate(line, vars))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Link mở Zalo theo SĐT (dạng nội địa 0xxxxxxxxx). Chỉ số DI ĐỘNG mới có thể có Zalo; số cố định / tổng đài ⇒ `null`. */
export function zaloPhoneLink(phoneE164: string | null, kind: string | null): string | null {
  if (!phoneE164 || kind !== "MOBILE" || !/^\+84\d{9}$/.test(phoneE164)) return null;
  return `https://zalo.me/0${phoneE164.slice(3)}`;
}

/** Bộ chuyển kênh: V1 mọi kênh là THỦ CÔNG — ERP dựng link mở app / sao chép nội dung, người bấm gửi. */
export type ChannelAction = { href: string | null; copy: string; hint: string; automatic: false };

export function channelAction(channel: OutreachChannel, contact: { phone: string | null; email: string | null; facebookUrl: string | null; zaloUrl: string | null }, message: string): ChannelAction | null {
  const national = contact.phone?.startsWith("+84") ? `0${contact.phone.slice(3)}` : contact.phone;
  switch (channel) {
    case "PHONE_CALL":
      return national ? { href: `tel:${national}`, copy: message, hint: "Bấm gọi, đọc kịch bản, rồi ghi kết quả.", automatic: false } : null;
    case "ZALO":
      if (contact.zaloUrl) return { href: contact.zaloUrl, copy: message, hint: "Mở Zalo, dán lời chào, gửi rồi bấm «Đã gửi».", automatic: false };
      return national ? { href: `https://zalo.me/${national}`, copy: message, hint: "Mở Zalo theo SĐT (chỉ được nếu số có Zalo), dán lời chào.", automatic: false } : null;
    case "SMS":
      return national ? { href: `sms:${national}?body=${encodeURIComponent(message)}`, copy: message, hint: "Mở ứng dụng nhắn tin trên điện thoại.", automatic: false } : null;
    case "EMAIL":
      return contact.email ? { href: `mailto:${contact.email}?subject=${encodeURIComponent("Bảng giá sỉ hải sản")}&body=${encodeURIComponent(message)}`, copy: message, hint: "Mở ứng dụng email.", automatic: false } : null;
    case "FACEBOOK":
      return contact.facebookUrl ? { href: contact.facebookUrl, copy: message, hint: "Mở trang Facebook của doanh nghiệp, nhắn tin, dán lời chào.", automatic: false } : null;
    case "WHATSAPP":
      return contact.phone ? { href: `https://wa.me/${contact.phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`, copy: message, hint: "Mở WhatsApp.", automatic: false } : null;
  }
}
