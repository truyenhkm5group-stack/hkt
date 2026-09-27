import { hasDatabaseConfigured } from "@/db";
import { currentOrganization, peekOrganization, type OrgContext } from "@/lib/platform/context";

/**
 * ═══════════ CREDENTIAL TRONG BIẾN MÔI TRƯỜNG LÀ CỦA TỔ CHỨC NHÀ ═══════════
 *
 * Hợp đồng: docs/platform/target-architecture.md P12 · shared-contracts.md mục 9 · audit ISO-03/04/05.
 *
 * Pancake, Viettel Post, Meta, SePay, AI, GitHub, bot chat, Lark, Telegram… đều đọc khoá từ
 * `process.env`. Một tiến trình phục vụ nhiều tổ chức nên khoá ấy KHÔNG có chủ riêng cho từng
 * người gọi — nó là khoá của VNX (tổ chức nhà). Tổ chức khác chạy tới lối gọi mạng mà dùng khoá
 * đó là: kéo đơn/khách/hội thoại của VNX vào CSDL của họ, nhắn tin cho khách của VNX, đổi ngân
 * sách quảng cáo của VNX, gửi cảnh báo vào nhóm Lark của VNX.
 *
 * ─── CHẶN Ở LỐI GỌI MẠNG, KHÔNG Ở NƠI GỌI ───
 *
 * Mỗi client gọi `assertHomeCredentials()` trong ĐÚNG phương thức gửi request của nó — một chỗ cho
 * một client, không rải ở hàng trăm nơi gọi (nơi gọi viết sau có thể quên, phương thức gửi thì
 * không vòng qua được). Máy quét `tests/platform-isolation-static.test.ts` đòi mọi client khai
 * trong danh sách phải có lời gọi này.
 *
 * ─── MỌI NHÁNH LỖI RƠI VỀ PHÍA HẸP ───
 *
 * `currentOrganization()` ném `OrgContextError` (claim lạ, tổ chức bị đình chỉ) ⇒ ném tiếp, KHÔNG
 * coi là nhà. Tổ chức không phải nhà ⇒ `ConnectorUnavailableError` TRƯỚC khi một byte rời máy.
 * Phase 1.x mới có credential riêng từng tổ chức (bảng `settings` / `integration_tokens` của CSDL
 * tổ chức đó) — tới lúc ấy hàm này đổi thành "credential của tổ chức này", không phải "cấm".
 */

/** Danh sách nhà cung cấp dùng credential môi trường — chỉ để câu lỗi và máy quét đọc được. */
export const HOME_CREDENTIAL_PROVIDERS = [
  "pancake",
  "pancake-pages",
  "viettelpost",
  "facebook",
  "sepay",
  "ai",
  "openai",
  "github",
  "chatbot",
  "lark",
  "telegram",
] as const;
export type HomeCredentialProvider = (typeof HOME_CREDENTIAL_PROVIDERS)[number];

export class ConnectorUnavailableError extends Error {
  readonly code = "CONNECTOR_NOT_CONFIGURED" as const;
  constructor(
    readonly provider: string,
    readonly organization: string,
  ) {
    super(`Kết nối "${provider}" chưa được cấu hình cho tổ chức "${organization}" — credential trong biến môi trường chỉ thuộc tổ chức nhà.`);
    this.name = "ConnectorUnavailableError";
  }
}

export function isConnectorUnavailable(error: unknown): error is ConnectorUnavailableError {
  return error instanceof ConnectorUnavailableError || (error as { code?: unknown } | null)?.code === "CONNECTOR_NOT_CONFIGURED";
}

/**
 * Ném `ConnectorUnavailableError` khi ngữ cảnh hiện hành KHÔNG phải tổ chức nhà. Gọi ở dòng ĐẦU của
 * phương thức gửi request — trước khi đọc khoá, trước điều tiết nhịp, trước `fetch`.
 */
export async function assertHomeCredentials(provider: HomeCredentialProvider): Promise<void> {
  if (!homeCheckNeeded(peekOrganization(), hasDatabaseConfigured())) return;
  const org = await currentOrganization();
  if (!org.isHome) throw new ConnectorUnavailableError(provider, org.code);
}

/**
 * Có cần hỏi "ngữ cảnh này có phải tổ chức nhà không" hay không — hàm thuần.
 *
 * Tiến trình KHÔNG có CSDL (vd workflow GitHub Actions `agent-open-pr.yml` mở PR bằng danh tính
 * agent) không phục vụ được tổ chức nào: không phiên, không `withOrganization`, không đọc được sổ tổ
 * chức — nên không có tổ chức KHÁC nào để chặn. Hỏi `currentOrganization()` ở đó chỉ để đọc tổ chức
 * nhà từ CSDL và ném "Chưa cấu hình DATABASE_URL" — đo 27/09/2026: MỌI lượt mở PR của kho đỏ từ khi
 * #314 thêm lớp chặn này, vì cầu nối gọi `assertHomeCredentials("github")`.
 *
 * Ngữ cảnh TƯỜNG MINH luôn được xét (kể cả khi không có CSDL) — `withOrganization` của tổ chức khác
 * vẫn bị chặn. Mọi request thật của ứng dụng đều có CSDL nên vẫn đi đủ đường kiểm.
 */
export function homeCheckNeeded(explicit: OrgContext | null, hasDatabase: boolean): boolean {
  return explicit !== null || hasDatabase;
}

/**
 * Bản ĐỒNG BỘ, chỉ nhìn ngữ cảnh TƯỜNG MINH (`withOrganization`). Dùng ở getter đồng bộ kiểu
 * `configured` để job của tổ chức khác tự bỏ qua sớm. `false` KHÔNG có nghĩa là "chắc chắn nhà" —
 * request mang phiên tổ chức khác không có ngữ cảnh tường minh; lối gọi mạng vẫn chặn bằng
 * `assertHomeCredentials()`.
 */
export function peekIsNonHome(): boolean {
  const explicit = peekOrganization();
  return explicit !== null && !explicit.isHome;
}
