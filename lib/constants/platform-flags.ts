/**
 * ═══════════ SỔ CỜ NỀN TẢNG (P11) ═══════════
 *
 * Cờ nền tảng là CÔNG TẮC TRIỂN KHAI KỸ THUẬT do đội nền tảng bật cho từng tổ chức (vd tung một
 * runtime mới cho một tổ chức trước). Nó KHÁC cấu hình module — thứ là lựa chọn kinh doanh của tổ
 * chức (`lib/constants/platform-modules.ts`). Hai sổ, hai hàm, không trộn: một cờ không bao giờ
 * bật/tắt một module, và một module không bao giờ được khai ở đây.
 *
 * Thuần, client-safe. Ghi đè theo tổ chức nằm ở `platform_flag_overrides`; bộ đọc máy chủ
 * (`lib/platform/flags.ts`) đọc dòng rồi gọi `resolveFlag`.
 */

export type PlatformFlagDef = { key: string; label: string; defaultEnabled: boolean; why: string };

export const PLATFORM_FLAGS = [
  {
    key: "dynamic_page_runtime",
    label: "Runtime trang động (metadata)",
    defaultEnabled: false,
    why: "Phase 2+: trang dựng từ metadata thay vì mã nguồn. Mặc định TẮT — chỉ bật cho từng tổ chức thử nghiệm, để một runtime chưa chín không chạm tổ chức đang chạy thật.",
  },
] as const satisfies readonly PlatformFlagDef[];

export type PlatformFlagKey = (typeof PLATFORM_FLAGS)[number]["key"];

const FLAG_BY_KEY: ReadonlyMap<string, PlatformFlagDef> = new Map(PLATFORM_FLAGS.map((f) => [f.key, f]));

export function isPlatformFlagKey(key: string): key is PlatformFlagKey {
  return FLAG_BY_KEY.has(key);
}

/** Cờ bật ⇔ ghi đè của tổ chức (nếu là boolean) ?? mặc định trong sổ. Ghi đè không phải boolean bị bỏ qua. */
export function resolveFlag(key: PlatformFlagKey, overrides: Readonly<Record<string, boolean>>): boolean {
  const override: unknown = overrides[key];
  if (typeof override === "boolean") return override;
  return FLAG_BY_KEY.get(key)?.defaultEnabled ?? false;
}
