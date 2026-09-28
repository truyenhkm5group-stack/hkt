/**
 * ═══════════ CHỮ CỦA TRANG LÕI THEO TỔ CHỨC — GỠ DẤU VNX (Phase 11 · H4) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Trang lõi (Khách hàng, Đơn hàng, Sản phẩm, Kho, Đổi/trả, Mô hình dữ liệu, Kết nối) viết cho tổ chức NHÀ: chữ mô tả
 * nhắc thẳng "Pancake", "Viettel Post", "VNXcommerce". Tổ chức khác không dùng những tích hợp ấy (connector HOME_ONLY)
 * nên câu đó vừa sai vừa lộ tên nhà. MỘT chỗ quyết định chữ nào hiện cho ai — trang không tự `if` từng câu:
 *
 *  · `integrationName(vai, ctx)` — tên của nguồn đơn / POS / đơn vị vận chuyển. Tổ chức nhà nhận ĐÚNG chuỗi cũ (từng ký
 *    tự, để văn bản của nhà không đổi); tổ chức khác nhận nhãn connector đã khai và đang BẬT của chính họ, không có thì
 *    danh từ trung tính.
 *  · `coreText(khoá, ctx)` — câu trọn vẹn khi thay mỗi cái tên là chưa đủ (câu nói VỀ tích hợp của nhà).
 *  · `orgTabMetadata()` — tiêu đề tab + favicon của tổ chức không-nhà (tên thương hiệu, logo qua route đã kiểm tổ chức).
 *
 * Phiên không mang tổ chức ⇒ coi là NHÀ: đúng như `currentOrganization()` (phiên cũ trước nền tảng) và `getOrgBrand`.
 * Bộ nạp ngữ cảnh (đọc kết nối đang bật) ở `lib/branding/service.ts::getBrandCopy` — tệp này không chạm CSDL.
 */

export const INTEGRATION_ROLES = ["ORDER_SOURCE", "POS", "SHIPPING"] as const;
export type IntegrationRole = (typeof INTEGRATION_ROLES)[number];

/** Chữ HIỆN TẠI của tổ chức nhà — giữ nguyên từng ký tự (bài kiểm so chuỗi). */
export const HOME_INTEGRATION_NAME: Readonly<Record<IntegrationRole, string>> = { ORDER_SOURCE: "Pancake", POS: "Pancake POS", SHIPPING: "Viettel Post" };

/** Danh từ trung tính khi tổ chức chưa khai / chưa bật connector nào cho vai đó. */
export const NEUTRAL_INTEGRATION_NAME: Readonly<Record<IntegrationRole, string>> = { ORDER_SOURCE: "hệ thống bán hàng", POS: "hệ thống bán hàng", SHIPPING: "đơn vị vận chuyển" };

/** Dấu của tổ chức nhà không được lọt vào chữ của tổ chức khác. */
export const HOME_BRAND_PATTERN = /Pancake|Viettel|VNX/i;

export type CopyContext = {
  isHome: boolean;
  /** Nhãn connector đang BẬT của chính tổ chức, theo vai (chỉ tổ chức không-nhà). */
  declared: Partial<Record<IntegrationRole, string>>;
};

export const HOME_COPY_CONTEXT: CopyContext = { isHome: true, declared: {} };

type OrgLike = { organization?: { isHome: boolean } | null } | null | undefined;

/** Phiên thuộc tổ chức nhà? Không mang tổ chức ⇒ nhà (phiên cũ trước nền tảng). */
export function isHomeOrg(user: OrgLike): boolean {
  return !user?.organization || user.organization.isHome;
}

export function integrationName(role: IntegrationRole, ctx: CopyContext): string {
  if (ctx.isHome) return HOME_INTEGRATION_NAME[role];
  const declared = ctx.declared[role]?.trim();
  // Nhãn khai của chính tổ chức mà vẫn mang dấu nhà (không nên xảy ra — connector nhà là HOME_ONLY) ⇒ rơi về trung tính.
  return declared && !HOME_BRAND_PATTERN.test(declared) ? declared : NEUTRAL_INTEGRATION_NAME[role];
}

type NameOf = (role: IntegrationRole) => string;

/** Câu trọn vẹn: `home` là chữ cũ của nhà (từng ký tự); `other` dựng từ tên tích hợp của tổ chức. */
export const CORE_TEXT = {
  "returns.title": {
    home: "Phiếu đổi / trả (Pancake)",
    other: (n: NameOf, ctx: CopyContext) => (ctx.declared.ORDER_SOURCE ? `Phiếu đổi / trả (${n("ORDER_SOURCE")})` : "Phiếu đổi / trả"),
  },
  "returns.eyebrow": {
    home: "Bán hàng · nguồn Pancake",
    other: (n: NameOf, ctx: CopyContext) => (ctx.declared.ORDER_SOURCE ? `Bán hàng · nguồn ${n("ORDER_SOURCE")}` : "Bán hàng"),
  },
  "connections.homeIntegrations": {
    home: "Tích hợp đang chạy của tổ chức nhà (Pancake, Viettel Post, Meta, SePay…) giữ nguyên đường cũ và credential ở máy chủ — màn hình này chỉ NÓI RA chúng, không đổi được và không hiện bí mật nào.",
    other: () => "Dòng «Chỉ tổ chức nhà» là tích hợp dùng chung của nền tảng, chưa mở cho tổ chức này — màn hình chỉ nói ra chúng, không đổi được và không hiện bí mật nào.",
  },
} satisfies Record<string, { home: string; other: (n: NameOf, ctx: CopyContext) => string }>;

export type CoreTextKey = keyof typeof CORE_TEXT;

export function coreText(key: CoreTextKey, ctx: CopyContext): string {
  const entry = CORE_TEXT[key];
  return ctx.isHome ? entry.home : entry.other((r) => integrationName(r, ctx), ctx);
}

/** Gói gọn cho trang: `copy.name("SHIPPING")`, `copy.text("returns.title")`. */
export type BrandCopy = { isHome: boolean; name: (role: IntegrationRole) => string; text: (key: CoreTextKey) => string };

export function brandCopy(ctx: CopyContext): BrandCopy {
  return { isHome: ctx.isHome, name: (r) => integrationName(r, ctx), text: (k) => coreText(k, ctx) };
}

// ─────────────────────────── Tiêu đề tab + favicon ───────────────────────────

/** Chữ cái đầu làm biểu tượng khi tổ chức chưa có logo — chỉ chữ / số (không cần thoát XML), còn lại "•". */
export function brandInitial(name: string): string {
  const ch = Array.from(name.trim())[0] ?? "";
  return /^[\p{L}\p{N}]$/u.test(ch) ? ch.toLocaleUpperCase("vi-VN") : "•";
}

/** Favicon trung tính dựng từ chữ cái đầu — thay `/icon.svg` (mang nhãn VNXcommerce) cho tổ chức chưa có logo. */
export function initialIconDataUri(name: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#334155"/><text x="32" y="43" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${brandInitial(name)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export type OrgTabMetadata = { title: { absolute: string; template: string }; description: string; icons: { icon: { url: string }[]; apple: { url: string }[] } };

/**
 * Metadata của bố cục dashboard cho tổ chức KHÔNG-nhà: tên thương hiệu làm tiêu đề, logo (route `/api/branding/logo`
 * đọc CSDL của phiên) làm favicon, thiếu logo thì chữ cái đầu. `icons` THAY hẳn bộ biểu tượng của bố cục gốc (Next gộp
 * metadata theo khoá cấp một). Tổ chức nhà KHÔNG gọi hàm này — bố cục trả `{}` và giữ nguyên.
 */
export function orgTabMetadata(brand: { name: string; logoUrl: string | null }): OrgTabMetadata {
  const icon = brand.logoUrl ?? initialIconDataUri(brand.name);
  // `absolute` cho tiêu đề mặc định: nếu không, mẫu của bố cục GỐC gắn tên tổ chức nhà vào sau.
  return { title: { absolute: brand.name, template: `%s · ${brand.name}` }, description: `ERP của ${brand.name}`, icons: { icon: [{ url: icon }], apple: [] } };
}
