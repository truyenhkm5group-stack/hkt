/**
 * ═══════════ TỰ PHỤC VỤ (Phase 10) — PHẦN THUẦN, CLIENT-SAFE ═══════════
 *
 * Hợp đồng: `docs/platform/phase-10-contracts.md` §2. Tệp này KHÔNG đọc CSDL, không đọc biến môi trường: trình hướng
 * dẫn `/start` (client) và lõi máy chủ (`lib/onboarding/service.ts`) dùng CÙNG lược đồ và CÙNG phép chọn module, để
 * "trình duyệt nói hợp lệ" và "máy chủ nói hợp lệ" không bao giờ là hai luật. Máy chủ vẫn kiểm LẠI mọi thứ lúc tạo —
 * trạng thái của trình hướng dẫn là dữ liệu của client.
 */
import { z } from "zod";
import { moduleDef, PLATFORM_MODULES, type ModuleKey } from "@/lib/constants/platform-modules";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";

// ═══ CHẾ ĐỘ ĐĂNG KÝ ═══

/** `off` (mặc định, production) · `invite` (cần mã mời) · `open` (không mã, có trần theo IP / ngày). */
export const SIGNUP_MODES = ["off", "invite", "open"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** Chuỗi biến môi trường ⇒ chế độ. Lạ / trống ⇒ `off`: hỏng về phía ĐÓNG. */
export function parseSignupMode(raw: string | null | undefined): SignupMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return (SIGNUP_MODES as readonly string[]).includes(v) ? (v as SignupMode) : "off";
}

// ═══ LOẠI HÌNH → MẪU GỢI Ý ═══

export const BUSINESS_TYPES = ["fashion", "ecommerce", "wholesale", "manufacturing", "service", "blank"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Mỗi loại hình gợi ý MỘT mẫu (đổi được ở bước sau). Loại hình chưa có mẫu (sản xuất, dịch vụ — cần đối tượng tuỳ
 * biến của Phase 6) gợi ý "bắt đầu trắng" kèm bộ module khởi đầu, và NÓI RA là chưa có mẫu.
 */
export const BUSINESS_TYPE_SPEC: Record<BusinessType, { label: string; hint: string; templateKey: string | null; modules: ModuleKey[] }> = {
  fashion: { label: "Thời trang", hint: "Bán quần áo, phụ kiện online: mẫu mã theo size / màu, hàng hoàn, sản xuất đặt xưởng.", templateKey: "fashion-commerce", modules: [] },
  ecommerce: { label: "TMĐT chung", hint: "Bán lẻ online nhiều ngành hàng: đơn, khách, kho, vận chuyển.", templateKey: "general-ecommerce", modules: [] },
  wholesale: { label: "Bán sỉ / phân phối", hint: "Đại lý mua số lượng lớn, trả sau theo hạn mức công nợ.", templateKey: "wholesale", modules: [] },
  manufacturing: { label: "Sản xuất", hint: "Chưa có mẫu ngành sản xuất — bắt đầu trắng với bộ module gợi ý.", templateKey: null, modules: ["customers", "products", "orders", "inventory", "purchasing", "production", "finance"] },
  service: { label: "Dịch vụ", hint: "Chưa có mẫu ngành dịch vụ — bắt đầu trắng với bộ module gợi ý.", templateKey: null, modules: ["customers", "customer_care", "finance"] },
  blank: { label: "Bắt đầu trắng", hint: "Không mẫu nào: chỉ bật những module bạn tự chọn.", templateKey: null, modules: [] },
};

// ═══ MODULE: CHỌN / BỎ, PHỤ THUỘC HIỆN RÕ ═══

/** Module lõi — luôn bật, không hiện nút tắt. */
export const CORE_MODULES: ModuleKey[] = PLATFORM_MODULES.filter((m) => m.core).map((m) => m.key);

/**
 * Module một tổ chức tự đăng ký chọn được: không lõi (lõi luôn bật) và KHÔNG dùng credential của tổ chức nhà
 * (connector Pancake / Viettel Post / Meta, phòng Tech, trang Kết nối dữ liệu — `requiresHomeCredentials`).
 */
export const SELECTABLE_MODULES: ModuleKey[] = PLATFORM_MODULES.filter((m) => !m.core && !m.requiresHomeCredentials).map((m) => m.key);

function isSelectable(key: string): key is ModuleKey {
  return (SELECTABLE_MODULES as string[]).includes(key);
}

/** Thêm mọi phụ thuộc (bắc cầu) — trả tập đã ĐÓNG cùng danh sách module được bật THÊM vì phụ thuộc. */
export function closeUnderDependencies(keys: readonly string[]): { modules: ModuleKey[]; added: ModuleKey[] } {
  const want = new Set<ModuleKey>();
  const asked = new Set(keys.filter(isSelectable));
  const visit = (k: ModuleKey) => {
    if (want.has(k)) return;
    want.add(k);
    for (const d of moduleDef(k)?.dependsOn ?? []) if (isSelectable(d)) visit(d);
  };
  for (const k of asked) visit(k);
  const ordered = SELECTABLE_MODULES.filter((k) => want.has(k));
  return { modules: ordered, added: ordered.filter((k) => !asked.has(k)) };
}

/**
 * Bật / tắt MỘT module trên tập đang chọn. Bật ⇒ tự bật cái nó cần; tắt ⇒ tự tắt cái đang cần nó. Cả hai danh
 * sách "kéo theo" trả ra để màn hình NÓI RÕ (không lặng lẽ đổi thứ người dùng không bấm).
 */
export function toggleModule(selected: readonly string[], key: string, on: boolean): { modules: ModuleKey[]; alsoOn: ModuleKey[]; alsoOff: ModuleKey[] } {
  const current = closeUnderDependencies(selected).modules;
  if (!isSelectable(key)) return { modules: current, alsoOn: [], alsoOff: [] };
  if (on) {
    const next = closeUnderDependencies([...current, key]).modules;
    return { modules: next, alsoOn: next.filter((k) => k !== key && !current.includes(k)), alsoOff: [] };
  }
  const off = new Set<ModuleKey>([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of current) {
      if (off.has(k)) continue;
      if ((moduleDef(k)?.dependsOn ?? []).some((d) => off.has(d))) {
        off.add(k);
        changed = true;
      }
    }
  }
  return { modules: current.filter((k) => !off.has(k)), alsoOn: [], alsoOff: [...off].filter((k) => k !== key && current.includes(k)) };
}

// ═══ LƯỢC ĐỒ TỪNG BƯỚC ═══

/** Mã không cấp được cho khách: trùng tên tuyến / từ dành riêng của nền tảng, hoặc mã dựng sẵn của nhà. */
export const RESERVED_ORG_CODES = ["home", "vnx", "admin", "api", "app", "platform", "start", "login", "www", "system", "root", "support", "test"] as const;

export const ADMIN_PASSWORD_MIN = 10;

export const inviteCodeZ = z.string().trim().min(8, "Mã mời không hợp lệ").max(80, "Mã mời không hợp lệ");

export const orgStepZ = z.object({
  name: z.string().trim().min(2, "Tên tổ chức ít nhất 2 ký tự").max(120, "Tên tổ chức tối đa 120 ký tự"),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(ORGANIZATION_CODE_PATTERN, "Mã tổ chức: chữ thường không dấu, số, gạch ngang; 2–31 ký tự, bắt đầu bằng chữ")
    .refine((c) => !(RESERVED_ORG_CODES as readonly string[]).includes(c), "Mã này dành riêng cho nền tảng — chọn mã khác"),
});

export const adminStepZ = z.object({
  name: z.string().trim().min(2, "Tên ít nhất 2 ký tự").max(120),
  email: z.email("Email không hợp lệ").trim().toLowerCase().max(200),
  password: z.string().min(ADMIN_PASSWORD_MIN, `Mật khẩu ít nhất ${ADMIN_PASSWORD_MIN} ký tự`).max(200, "Mật khẩu quá dài"),
});

/** Phần không nhạy cảm của bản nháp (không mật khẩu) — đủ để xem trước. */
export const planStepZ = z.object({
  businessType: z.enum(BUSINESS_TYPES),
  /** `null` = bắt đầu trắng. */
  templateKey: z.string().trim().max(60).nullable(),
  modules: z.array(z.string().trim().max(64)).max(60),
});

export const signupDraftZ = z.object({
  invite: z.string().trim().max(80).optional().nullable(),
  org: orgStepZ,
  admin: adminStepZ,
  plan: planStepZ,
  /** Chỉ người vận hành chọn được gói; đăng ký công khai luôn `trial` (hoặc gói gắn trên mã mời). */
  planKey: z.string().trim().max(31).optional().nullable(),
});

export type OrgStep = z.infer<typeof orgStepZ>;
export type AdminStep = z.infer<typeof adminStepZ>;
export type PlanStep = z.infer<typeof planStepZ>;
export type SignupDraft = z.infer<typeof signupDraftZ>;

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dữ liệu không hợp lệ";
}

// ═══ KẾT QUẢ XEM TRƯỚC (máy chủ → client) ═══

export type PreviewStep = { kind: string; kindLabel: string; key: string; label: string; action: string; reason: string | null };
export type SignupPreview = {
  blueprint: { key: string; name: string; version: string; fromTemplate: string | null };
  modules: { key: string; label: string; autoAdded: boolean }[];
  steps: PreviewStep[];
  counts: Record<string, number>;
  /** Mục của mẫu bị BỎ vì module chứa nó không được chọn — nói ra, không lặng lẽ cắt. */
  dropped: { kind: string; key: string; label: string; reason: string }[];
  issues: string[];
  /** Gói sẽ cấp + chỗ mẫu vượt hạn mức gói (nếu có). */
  plan: { key: string; name: string; over: string[] };
  ok: boolean;
};

export type SignupStepResult = { ok: true } | { error: string };
