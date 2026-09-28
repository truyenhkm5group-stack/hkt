/**
 * ═══════════ SỔ HẠN MỨC GÓI (Phase 10 · §5) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Mỗi loại hạn mức khai: nhãn, đơn vị, ĐẾM TỪ ĐÂU (bảng thật trong CSDL tổ chức — không có bộ đếm riêng dễ lệch), và
 * khi CHƯA đếm được thì vì sao. Loại chưa đo được (`counter: null`) KHÔNG chặn gì và hiện "—" (chưa biết ≠ 0, luật 42):
 * đối tượng / bản ghi tuỳ biến (Phase 6) và bản nháp AI (Phase 8) chưa có ở bản này — phiên tích hợp nối điểm tạo
 * của chúng vào `checkEntitlement(<loại>)` và khai bộ đếm ở `lib/entitlements/check.ts`.
 */

export const ENTITLEMENT_KINDS = ["users", "pages", "objects", "records", "workflows", "aiDraftsPerDay", "storageMb"] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export type EntitlementSpec = {
  label: string;
  unit: string;
  /** Nguồn đếm thật (bảng · điều kiện), hoặc `null` khi chưa có. */
  source: string | null;
  /** Chưa đếm được thì thiếu gì — cụ thể tới mức sửa được. */
  missingWhat: string | null;
};

export const ENTITLEMENT_SPEC: Record<EntitlementKind, EntitlementSpec> = {
  users: { label: "Người dùng", unit: "tài khoản", source: "users · đang hoạt động", missingWhat: null },
  pages: { label: "Trang tuỳ biến", unit: "trang", source: "meta_pages · chưa lưu trữ", missingWhat: null },
  objects: { label: "Đối tượng tuỳ biến", unit: "đối tượng", source: null, missingWhat: "Đối tượng tuỳ biến (Phase 6) chưa có ở bản này — điểm tạo sẽ gọi checkEntitlement(\"objects\") khi có." },
  records: { label: "Bản ghi tuỳ biến", unit: "bản ghi", source: null, missingWhat: "Bản ghi của đối tượng tuỳ biến (Phase 6) chưa có ở bản này." },
  workflows: { label: "Luật tự động", unit: "luật", source: "workflow_rules · chưa lưu trữ", missingWhat: null },
  aiDraftsPerDay: { label: "Bản nháp AI mỗi ngày", unit: "bản nháp", source: null, missingWhat: "Bản nháp AI (Phase 8) chưa có ở bản này — sổ bản nháp sẽ là nguồn đếm." },
  storageMb: { label: "Dung lượng tệp", unit: "MB", source: "custom_files · tổng kích thước (gồm logo)", missingWhat: null },
};

/** `null` = không giới hạn. */
export type PlanLimits = Record<EntitlementKind, number | null>;

/** Đọc `limits` jsonb: số ≥ 0 ⇒ trần; `null` ⇒ không giới hạn; thiếu / sai kiểu ⇒ `undefined` (CHƯA KHAI — màn hình nói ra). */
export function parseLimits(raw: unknown): { limits: PlanLimits; undeclared: EntitlementKind[] } {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const limits = {} as PlanLimits;
  const undeclared: EntitlementKind[] = [];
  for (const k of ENTITLEMENT_KINDS) {
    const v = obj[k];
    if (v === null) limits[k] = null;
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) limits[k] = v;
    else {
      // Chưa khai: không giới hạn, nhưng ĐƯỢC NÓI RA ở /settings/plan — không lặng lẽ.
      limits[k] = null;
      undeclared.push(k);
    }
  }
  return { limits, undeclared };
}

/** Câu lỗi nghiệp vụ khi vượt — một chỗ dựng, mọi điểm gọi in cùng câu. */
export function overLimitMessage(kind: EntitlementKind, planName: string, used: number, limit: number): string {
  const s = ENTITLEMENT_SPEC[kind];
  const fmt = (n: number) => (kind === "storageMb" ? n.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) : n.toLocaleString("vi-VN"));
  return `Đã tới hạn mức của gói «${planName}»: ${s.label.toLowerCase()} ${fmt(used)}/${fmt(limit)} ${s.unit}. Người vận hành nền tảng nâng gói thì tạo tiếp được.`;
}
