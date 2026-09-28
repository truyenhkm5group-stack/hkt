/**
 * ═══════════ THƯƠNG HIỆU TỐI THIỂU (Phase 10 · §4) — THUẦN, CLIENT-SAFE ═══════════
 *
 * `settings["org.branding"] = { displayName, accent, logoFileId }` trong CSDL CỦA tổ chức. Màu nhấn là TẬP ĐÓNG tám
 * màu: giá trị CSS đi ra trang là hằng số ở đây, không bao giờ là chuỗi người dùng gõ — một ô "mã màu tự do" là một
 * chỗ tiêm CSS vào giao diện của mọi người trong tổ chức. Mỗi màu khai hai bản (sáng / tối) đủ tương phản cho chữ trên
 * nút. Tổ chức nhà KHÔNG đọc khoá này — giữ nguyên giao diện hiện tại.
 */

export const BRANDING_SETTING_KEY = "org.branding";

export const ACCENT_KEYS = ["ember", "ruby", "amber", "emerald", "teal", "sky", "indigo", "violet"] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

type Tone = { primary: string; foreground: string };
export const ACCENTS: Record<AccentKey, { label: string; swatch: string; light: Tone; dark: Tone }> = {
  ember: { label: "Cam đất", swatch: "oklch(0.57 0.2 33)", light: { primary: "oklch(0.57 0.2 33)", foreground: "oklch(0.99 0.01 60)" }, dark: { primary: "oklch(0.7 0.19 34)", foreground: "oklch(0.16 0.03 34)" } },
  ruby: { label: "Đỏ hồng ngọc", swatch: "oklch(0.55 0.21 15)", light: { primary: "oklch(0.55 0.21 15)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.7 0.18 15)", foreground: "oklch(0.16 0.03 15)" } },
  amber: { label: "Hổ phách", swatch: "oklch(0.55 0.13 70)", light: { primary: "oklch(0.55 0.13 70)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.8 0.15 80)", foreground: "oklch(0.18 0.03 70)" } },
  emerald: { label: "Lục bảo", swatch: "oklch(0.52 0.13 160)", light: { primary: "oklch(0.52 0.13 160)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.72 0.15 160)", foreground: "oklch(0.16 0.03 160)" } },
  teal: { label: "Xanh két", swatch: "oklch(0.52 0.1 195)", light: { primary: "oklch(0.52 0.1 195)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.74 0.11 195)", foreground: "oklch(0.16 0.03 195)" } },
  sky: { label: "Xanh trời", swatch: "oklch(0.53 0.14 240)", light: { primary: "oklch(0.53 0.14 240)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.72 0.13 240)", foreground: "oklch(0.16 0.03 240)" } },
  indigo: { label: "Chàm", swatch: "oklch(0.5 0.18 275)", light: { primary: "oklch(0.5 0.18 275)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.7 0.15 275)", foreground: "oklch(0.16 0.03 275)" } },
  violet: { label: "Tím", swatch: "oklch(0.52 0.2 305)", light: { primary: "oklch(0.52 0.2 305)", foreground: "oklch(0.99 0 0)" }, dark: { primary: "oklch(0.72 0.16 305)", foreground: "oklch(0.16 0.03 305)" } },
};

export function isAccentKey(v: unknown): v is AccentKey {
  return typeof v === "string" && (ACCENT_KEYS as readonly string[]).includes(v);
}

export type OrgBranding = { displayName: string | null; accent: AccentKey | null; logoFileId: string | null };
export const EMPTY_BRANDING: OrgBranding = { displayName: null, accent: null, logoFileId: null };

export const BRANDING_NAME_MAX = 60;

/** Giá trị đã lưu (jsonb gõ tay được) ⇒ dạng sạch. Khoá lạ bị bỏ, màu ngoài tập ⇒ không màu. */
export function sanitizeBranding(raw: unknown): OrgBranding {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = typeof o.displayName === "string" ? o.displayName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, BRANDING_NAME_MAX) : "";
  return {
    displayName: name || null,
    accent: isAccentKey(o.accent) ? o.accent : null,
    logoFileId: typeof o.logoFileId === "string" && /^[0-9a-f-]{36}$/i.test(o.logoFileId) ? o.logoFileId : null,
  };
}

/**
 * Khối CSS đổi `--primary` theo màu nhấn — CHỈ từ hằng số của tập đóng. `null` khi không có màu (giữ màu gốc).
 * Bản tối đi theo lớp `.dark` như `globals.css`.
 */
export function accentCss(accent: AccentKey | null): string | null {
  if (!accent) return null;
  const a = ACCENTS[accent];
  return `:root{--primary:${a.light.primary};--primary-foreground:${a.light.foreground};--ring:${a.light.primary};}.dark{--primary:${a.dark.primary};--primary-foreground:${a.dark.foreground};--ring:${a.dark.primary};}`;
}

// ─── Logo ───

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoMime = (typeof LOGO_MIMES)[number];

/**
 * Kiểu ảnh theo CHỮ KÝ BYTE, không theo tên tệp hay `type` trình duyệt khai: một tệp HTML đổi đuôi `.png` không qua
 * được. `null` = không phải png / jpeg / webp.
 */
export function sniffImageMime(data: Uint8Array): LogoMime | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  return null;
}
