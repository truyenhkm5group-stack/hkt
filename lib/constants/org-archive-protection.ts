/**
 * ═══════════ TỔ CHỨC KHÔNG BAO GIỜ ĐƯỢC LƯU TRỮ ═══════════
 *
 * Quyết định của chủ shop 17/10/2026 (docs/tenant-lifecycle.md): chỉ workspace THỬ không dùng được lưu trữ. Các tổ chức dưới đây là
 * nhà hoặc khách THẬT đang chạy — ops `org-lifecycle` TỪ CHỐI theo MÃ, kể cả khi sao lưu / diễn tập sạch và không còn đồng nào nợ.
 * Không suy ra từ cờ `is_home`, tên hay brand: một dòng sổ bị sửa nhầm không được biến khách thật thành "lưu trữ được".
 *
 * Bỏ một mã khỏi danh sách là một QUYẾT ĐỊNH của chủ shop, kèm lý do trong commit — không phải cách để một lượt lưu trữ đi qua.
 * Workspace nghiệm thu SaaS được giữ bằng sổ riêng (`lib/constants/saas-acceptance-registry.ts`), không chép sang đây.
 */
export type ArchiveProtectedOrg = { code: string; reason: string };

export const ARCHIVE_PROTECTED_ORGS: readonly ArchiveProtectedOrg[] = [
  { code: "vnx", reason: "Tổ chức NHÀ (VNX) — mặt phẳng điều khiển của nền tảng, không bao giờ lưu trữ." },
  { code: "hslc-hmt", reason: "Khách THẬT HSLC đang bán hàng — chủ shop chốt giữ ACTIVE 17/10/2026." },
  { code: "hslc-hmt-shop", reason: "Khách THẬT HSLC đang bán hàng — chủ shop chốt giữ ACTIVE 17/10/2026." },
  { code: "hslc-vgcnj", reason: "Khách THẬT HSLC đang bán hàng — chủ shop chốt giữ ACTIVE 17/10/2026." },
];

/**
 * Tiền tố bảo vệ thêm — sai về phía AN TOÀN: chủ shop chốt giữ MỌI tổ chức HSLC, nên một mã HSLC mới mà chưa ai kịp ghi vào danh sách
 * trên vẫn bị từ chối. Muốn lưu trữ một mã khớp tiền tố thì chủ shop phải quyết và sửa sổ này.
 */
export const ARCHIVE_PROTECTED_PREFIXES: readonly { prefix: string; reason: string }[] = [
  { prefix: "hslc-", reason: "Tổ chức HSLC — chủ shop chốt giữ MỌI tổ chức HSLC ACTIVE 17/10/2026." },
];

/** Mục bảo vệ của mã này (khớp CHÍNH XÁC trước, rồi tiền tố; chữ thường, bỏ khoảng trắng), hoặc `null`. */
export function archiveProtectionOf(code: string | null | undefined): ArchiveProtectedOrg | null {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  const exact = ARCHIVE_PROTECTED_ORGS.find((o) => o.code === c);
  if (exact) return exact;
  const pre = ARCHIVE_PROTECTED_PREFIXES.find((x) => c.startsWith(x.prefix));
  return pre ? { code: c, reason: pre.reason } : null;
}
