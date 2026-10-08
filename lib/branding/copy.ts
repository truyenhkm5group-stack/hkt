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
  // Trang "không tìm thấy" của khung dashboard (`app/(dashboard)/not-found.tsx`): "đồng bộ về ERP" là câu của nhà (dữ liệu
  // kéo từ Pancake) — tổ chức không có kết nối nào đọc nó như thể có một bước đồng bộ đang hỏng.
  "notFound.body": {
    home: "Bản ghi không tồn tại hoặc chưa được đồng bộ về ERP.",
    other: () => "Bản ghi không tồn tại, đã bị xoá hoặc bạn không có quyền xem.",
  },
  "connections.homeIntegrations": {
    home: "Tích hợp đang chạy của tổ chức nhà (Pancake, Viettel Post, Meta, SePay…) giữ nguyên đường cũ và credential ở máy chủ — màn hình này chỉ NÓI RA chúng, không đổi được và không hiện bí mật nào.",
    other: () => "Dòng «Chỉ tổ chức nhà» là tích hợp dùng chung của nền tảng, chưa mở cho tổ chức này — màn hình chỉ nói ra chúng, không đổi được và không hiện bí mật nào.",
  },
  // ─── Pilot bán buôn (P1 #12): trang lõi trong luồng bán buôn. Chữ nhà giữ NGUYÊN từng ký tự (bài kiểm so chuỗi). ───
  "products.notByCod": {
    home: "không theo tiền COD",
    other: () => "không theo tiền thu hộ",
  },
  "products.emptyList": {
    home: "Thử đổi bộ lọc hoặc từ khoá. Nếu chưa đồng bộ, bấm “Đồng bộ sản phẩm & tồn kho”.",
    other: () => "Thử đổi bộ lọc hoặc từ khoá. Chưa có mã hàng nào thì bấm «Tạo sản phẩm».",
  },
  "receipts.emptyVariants": {
    home: "Không có mẫu mã phù hợp. Nếu danh sách trống, hãy đồng bộ sản phẩm từ Pancake trước.",
    other: () => "Không có mẫu mã phù hợp. Nếu danh sách trống, hãy tạo sản phẩm trước (Sản phẩm → Tạo sản phẩm).",
  },
  "expenses.description": {
    home: "Kê khai chi phí vận hành kinh doanh ngoài Pancake",
    other: () => "Kê khai chi phí vận hành kinh doanh",
  },
  "expenses.hint": {
    home: "Kê khai chi phí vận hành kinh doanh ngoài Pancake: lương, mặt bằng, điện nước, phần mềm, đóng gói… Số liệu đưa vào Báo cáo lợi nhuận (dòng tiền & danh nghĩa). Sao kê ngân hàng KHÔNG tạo chi phí: nhập sao kê ở Sổ ngân hàng (tab Nhập sao kê), phân loại, rồi nối dòng tiền với khoản chi để đối chiếu.",
    other: () => "Kê khai chi phí vận hành kinh doanh: lương, mặt bằng, điện nước, phần mềm, đóng gói… Số liệu đưa vào Báo cáo lợi nhuận (dòng tiền & danh nghĩa). Sao kê ngân hàng KHÔNG tạo chi phí: nhập sao kê ở Sổ ngân hàng (tab Nhập sao kê), phân loại, rồi nối dòng tiền với khoản chi để đối chiếu.",
  },
  "expenses.dialog": {
    home: "Chi phí vận hành ngoài Pancake (lương, mặt bằng, phần mềm, đóng gói…). Số tiền tính bằng VND.",
    other: () => "Chi phí vận hành (lương, mặt bằng, phần mềm, đóng gói…). Số tiền tính bằng VND.",
  },
  "customer.addressBook": {
    home: "Sổ địa chỉ giao hàng từ Pancake",
    other: () => "Sổ địa chỉ giao hàng",
  },
  "customer.profileHint": {
    home: "Trường do tổ chức tự khai. Thông tin hệ thống của khách chỉ đọc ở đây: khách đồng bộ từ Pancake, sửa ở ERP sẽ bị lượt đồng bộ kế tiếp ghi đè.",
    other: () => "Trường do tổ chức tự khai. Khách tạo trên ERP sửa được tên, số điện thoại, địa chỉ ngay ở form này.",
  },
  "dataQuality.legacyNote": {
    home: "Các số đối chiếu vẫn có COD khai báo/fallback và prepaid chưa kiểm chứng chứng từ. Chúng chưa phải tiền thực thu đã xác minh và chưa đủ để chốt doanh thu, lương hoặc đối soát ngân hàng. Cần đối chiếu bảng kê COD, chứng từ thanh toán và chiều giao/hoàn.",
    other: () => "Các số đối chiếu vẫn có tiền khai báo trên đơn và tiền trả trước chưa kiểm chứng chứng từ. Chúng chưa phải tiền thực thu đã xác minh và chưa đủ để chốt doanh thu, lương hoặc đối soát ngân hàng. Cần đối chiếu chứng từ thanh toán và chiều giao/hoàn.",
  },
  "finance.carrierHoldingTitle": {
    home: "Tiền Viettel Post còn giữ",
    other: (n: NameOf) => `Tiền ${n("SHIPPING")} còn giữ`,
  },
  "finance.carrierHoldingHint": {
    home: "Đây là khoản làm một shop bán COD 'lãi trên giấy mà hết tiền mặt': hàng đã tới tay khách nên doanh thu được ghi, còn tiền thì Viettel Post giữ cả tuần, trong khi tiền quảng cáo và tiền hàng phải trả ngay.",
    other: (n: NameOf) => `Tiền thu hộ ${n("SHIPPING")} đang giữ: hàng đã tới tay khách nên doanh thu được ghi, còn tiền chưa về tài khoản.`,
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

/**
 * Tiêu đề tab theo HOST (0180 · tên miền con): trang ngoài dashboard trên `<slug>.<miền gốc>` chưa có phiên nào để thay
 * tiêu đề. Không có host ⇒ `null` (bố cục gốc giữ chữ của nhà); host của tổ chức đã xuất bản ⇒ tên tổ chức đó; host lạ
 * ⇒ chữ trung tính «ERP» — không bao giờ tên của nhà.
 */
export function hostTabMetadata(host: { slug: string | null; org: { name: string } | null }): OrgTabMetadata | null {
  if (!host.slug) return null;
  return orgTabMetadata({ name: host.org?.name ?? "ERP", logoUrl: null });
}

/**
 * Tên in trong CÂU CHỮ của một trang ngoài dashboard (trang 404 gốc) — cùng thứ tự với tiêu đề tab của bố cục gốc
 * (`app/layout.tsx::generateMetadata`): tên miền con của tổ chức đã xuất bản ⇒ tên tổ chức đó; tên miền con lạ ⇒ `null` (câu
 * bỏ hẳn vế tên — không bao giờ tên của nhà, và không in chữ «ERP» cho khách); không có tên miền con ⇒ tên sản phẩm theo
 * thương hiệu của host.
 */
export function hostProductName(host: { slug: string | null; org: { name: string } | null }, brand: "vnx" | "chotdon"): string | null {
  if (host.slug) return host.org?.name ?? null;
  return brand === "chotdon" ? "Chốt Đơn Tự Động" : "VNXcommerce";
}
