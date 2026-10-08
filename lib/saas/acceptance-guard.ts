/**
 * ═══════════ LÁ CHẮN DÙNG CHUNG CỦA ĐƯỜNG MÁY NGHIỆM THU (ops `saas-acceptance` — docs/saas/ACCEPTANCE.md) ═══════════
 *
 * Sổ khai (`lib/constants/saas-acceptance-registry.ts`) chỉ nói «mã này là của nghiệm thu» — nó KHÔNG nói workspace đang mang mã
 * ấy trên production do ai tạo. Kho mã PUBLIC nên mã đã lộ: trước bản giữ chỗ, đăng ký nhanh với tên cửa hàng «CDT Nghiem Thu»
 * ra đúng mã `cdt-nghiem-thu`, và nếu quản trị của workspace ấy dùng đúng email của sổ thì một phép so (mã, email) với sổ là
 * KHÔNG đủ — đường máy sẽ phát liên kết đặt lại mật khẩu (thu hồi liên kết cũ, ghi nhật ký) cho tài khoản của một người khác.
 *
 * Hai lá chắn ở đây, MỘT bản cho cả lõi ops (`lib/saas/acceptance.ts`) lẫn chính hàm phát liên kết
 * (`createAcceptanceResetLink` — lib/users/password-reset.ts):
 *  1. `acceptanceRuntimeRefusal` — đường máy chỉ sống trong tiến trình ops (`tsx`: `NEXT_RUNTIME` rỗng). Trong máy chủ ứng dụng
 *     (Next đặt `NEXT_RUNTIME` = nodejs / edge) nó TỪ CHỐI, nên không server action / route nào mở được đường này kể cả khi ai
 *     đó nối nhầm. Đọc ĐÚNG chữ `process.env.NEXT_RUNTIME` — Next thay chính biểu thức ấy lúc dựng; đọc qua biến trung gian là mù.
 *  2. `acceptanceWorkspaceOwned` — workspace mang mã sổ khai có ĐÚNG do ops tạo không: job «Tạo khách» khoá cố định
 *     `saas-acceptance:<mã>` cho đúng mã, VÀ tài khoản khách của workspace đúng mã tài khoản trong sổ.
 */
import { eq } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { acceptanceIdempotencyKey, type AcceptanceWorkspace } from "@/lib/constants/saas-acceptance";
import { accountOfWorkspace } from "@/lib/saas/accounts";

export const ACCEPTANCE_RUNTIME_REFUSAL = "Đường máy nghiệm thu chỉ chạy trong tiến trình ops (scripts/saas-acceptance.ts) — máy chủ ứng dụng không mở được nó.";

export const ACCEPTANCE_NOT_OWNED_REFUSAL = "Workspace mang mã nghiệm thu nhưng KHÔNG do ops nghiệm thu tạo (không có job khoá nghiệm thu / tài khoản khác sổ khai) — đường máy không chạm.";

/** `null` = được chạy (tiến trình ops); chuỗi = vì sao từ chối. THUẦN theo tham số — mặc định đọc ĐÚNG biểu thức Next thay lúc dựng. */
export function acceptanceRuntimeRefusal(nextRuntime: string | undefined = process.env.NEXT_RUNTIME): string | null {
  return nextRuntime ? ACCEPTANCE_RUNTIME_REFUSAL : null;
}

/**
 * Workspace mang mã này có phải của CHÍNH ops nghiệm thu không: job «Tạo khách» khoá cố định của ops cho đúng mã + tài khoản của
 * workspace đúng mã trong sổ khai. Một khách tự đăng ký trùng mã (dù trùng cả email) ⇒ `false` ⇒ không đường máy nào chạm vào nó.
 */
export async function acceptanceWorkspaceOwned(entry: AcceptanceWorkspace): Promise<boolean> {
  const pdb = await getPlatformDb();
  const job = await pdb.query.platformProvisioningJobs.findFirst({ where: eq(schema.platformProvisioningJobs.idempotencyKey, acceptanceIdempotencyKey(entry.code)) });
  if (!job || job.kind !== "CREATE_CUSTOMER" || job.orgCode !== entry.code) return false;
  const account = await accountOfWorkspace(entry.code);
  return Boolean(account && account.code === entry.accountCode);
}
