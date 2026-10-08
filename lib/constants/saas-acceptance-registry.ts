/**
 * ═══════════ SỔ KHAI WORKSPACE NGHIỆM THU — TỆP LÁ (docs/saas/ACCEPTANCE.md) ═══════════
 *
 * Tệp này KHÔNG import gì: mọi nơi phải nhận ra workspace thử đọc được nó mà không kéo theo đồ thị phụ thuộc — lược đồ đăng ký
 * (`lib/onboarding/shared.ts`, chạy cả ở trình duyệt), chọn tên miền con (`lib/platform/publish.ts`), sổ kinh tế SaaS và buồng lái.
 * Luật thuần của ops (`lib/constants/saas-acceptance.ts`) xuất lại mọi thứ ở đây — MỘT sổ, MỘT vị ngữ (`acceptanceWorkspaceOf`).
 *
 * Ba việc dựa vào sổ này:
 *  1. Lá chắn của ops `saas-acceptance`: mã ngoài sổ ⇒ từ chối trước mọi lượt đọc; đường phát liên kết của máy hỏi lại sổ VÀ hỏi
 *     workspace có đúng do ops tạo không (`lib/saas/acceptance-guard.ts`).
 *  2. GIỮ CHỖ: mã + tên miền con trong sổ không ai tự đăng ký / tự đặt được (kho mã PUBLIC — mã đã lộ). Không nhét vào
 *     `RESERVED_ORG_CODES`: tên dành riêng là tên KHÔNG tổ chức nào được mang, còn mã nghiệm thu PHẢI mang được bởi đúng một
 *     workspace (do ops tạo qua job «Tạo khách»).
 *  3. LOẠI TRỪ khỏi chỉ số khách (buồng lái SaaS, phễu kích hoạt, mốc vòng đời, phân bổ chi phí, số khách): workspace thử không phải
 *     khách — đếm nó là «fake analytics».
 */

/** Nhãn của MÁY trong mọi nhật ký ops nghiệm thu ghi (`actor = null` — AGENTS 34: máy làm, khác hẳn «chưa biết ai»). */
export const ACCEPTANCE_ACTOR_LABEL = "Nghiệm thu tự động";

export type AcceptanceWorkspace = {
  /** Mã tổ chức — BẤT BIẾN (nằm trong JWT, tên CSDL). Đúng dạng mã tổ chức, không trùng tên dành riêng. */
  code: string;
  /** Tên hiển thị — nói thẳng đây KHÔNG phải khách thật (người vận hành đọc danh sách khách thấy ngay). */
  name: string;
  /** Mã tài khoản khách (`platform_accounts.code`) — cố định để lượt chạy lại gắn đúng tài khoản. */
  accountCode: string;
  /** Chủ shop yêu cầu đúng «external customer test account»: đi đúng luật của khách NGOÀI (gói niêm yết, dùng thử). */
  accountType: "EXTERNAL";
  /** Thương hiệu của workspace — vỏ app Chốt Đơn (lib/constants/saas-nav.ts). */
  brand: "chotdon";
  /** Email quản trị — thuộc tên miền CỦA CHÍNH nền tảng, không phải hộp thư của khách nào. Không có thư nào được gửi tới nó. */
  ownerEmail: string;
  ownerName: string;
  /** Tên miền con cố định khi xuất bản (`<slug>.<PLATFORM_BASE_DOMAIN>`). */
  domainSlug: string;
  /** Vì sao có workspace này. */
  reason: string;
};

export const ACCEPTANCE_WORKSPACES: readonly AcceptanceWorkspace[] = [
  {
    code: "cdt-nghiem-thu",
    name: "Kiểm thử nghiệm thu — không phải khách thật",
    accountCode: "cdt-nghiem-thu",
    accountType: "EXTERNAL",
    brand: "chotdon",
    ownerEmail: "nghiem-thu@chotdontudong.com",
    ownerName: ACCEPTANCE_ACTOR_LABEL,
    domainSlug: "cdt-nghiem-thu",
    reason:
      "Launch sprint 08/10/2026: chứng minh trên production một khách Chốt Đơn đi trọn vòng (cấp phát → kích hoạt → đăng nhập email → vỏ app → chat → AI → đơn) sau mỗi deploy chạm vỏ / danh tính / cấp phát / bot / đơn.",
  },
];

const norm = (v: string | null | undefined) => String(v ?? "").trim().toLowerCase();

/** VỊ NGỮ DUY NHẤT: mục của sổ khai đúng mã tổ chức này, hoặc `null`. So khớp CHÍNH XÁC (chữ thường, bỏ khoảng trắng) — không tiền tố, không đoán. */
export function acceptanceWorkspaceOf(code: string | null | undefined): AcceptanceWorkspace | null {
  const c = norm(code);
  if (!c) return null;
  return ACCEPTANCE_WORKSPACES.find((w) => w.code === c) ?? null;
}

/** Tên mà sổ khai GIỮ CHỖ — mã tổ chức HOẶC tên miền con của một mục ⇒ mục ấy, hoặc `null`. */
export function acceptanceReservedName(name: string | null | undefined): AcceptanceWorkspace | null {
  const c = norm(name);
  if (!c) return null;
  return ACCEPTANCE_WORKSPACES.find((w) => w.code === c || w.domainSlug === c) ?? null;
}

/** Câu từ chối khi một người tự đăng ký / tự đặt tên miền trùng tên giữ chỗ — không nói tên ấy dùng vào việc gì cụ thể. */
export const ACCEPTANCE_RESERVED_MESSAGE = "Tên này nền tảng đã giữ chỗ — chọn tên khác.";
