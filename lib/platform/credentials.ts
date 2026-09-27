import { currentOrganization, peekOrganization } from "@/lib/platform/context";

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
 * Credential riêng từng tổ chức (bảng `settings` / `integration_tokens` của CSDL tổ chức đó) là
 * bước sau — tới lúc ấy hàm này đổi thành "credential của tổ chức này", không phải "cấm". Đệm client
 * đã chia ngăn theo tổ chức (`perOrganizationClients` bên dưới) để bước ấy không phải sửa nơi gọi.
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
  "gemini",
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
  const org = await currentOrganization();
  if (!org.isHome) throw new ConnectorUnavailableError(provider, org.code);
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

/**
 * ═══════════ ĐỆM CLIENT TÍCH HỢP THEO TỔ CHỨC (risk-register R-04) ═══════════
 *
 * Trước Phase 1.x mỗi client (Pancake POS, Pancake Pages, Viettel Post, Facebook) là MỘT biến
 * `cached` cho cả tiến trình: dựng lần đầu bằng credential môi trường của tổ chức nhà rồi phát cho
 * MỌI người gọi — kể cả job của tổ chức khác. Lời chặn ở lối gọi mạng giữ cho nó an toàn, nhưng
 * trạng thái bên trong instance (token Viettel Post đã đăng nhập, token trang Pancake Pages) vẫn là
 * của nhà và nằm trong tay người gọi sai.
 *
 * Nay mỗi getter giữ một `Map<ngăn, client>`:
 *
 *  · NGĂN NHÀ (`HOME_CLIENT_SLOT`) — ngữ cảnh tường minh của nhà HOẶC không có ngữ cảnh tường minh
 *    (request thường, script cũ). Đúng MỘT instance như trước nền tảng: tổ chức nhà không đăng nhập
 *    Viettel Post thêm một lần nào, không mất token trang nào.
 *  · NGĂN CỦA TỔ CHỨC KHÁC — khoá bằng MÃ tổ chức của ngữ cảnh tường minh. Hàm dựng của ngăn này
 *    KHÔNG BAO GIỜ đọc credential môi trường: hoặc ném `ConnectorUnavailableError` (client bắt buộc
 *    có khoá lúc dựng), hoặc dựng một instance RỖNG credential. Bước sau thay hàm dựng bằng
 *    "credential của tổ chức này" mà không đổi một nơi gọi nào.
 *
 * Getter là ĐỒNG BỘ (hàng chục nơi gọi), nên chỉ nhìn được ngữ cảnh TƯỜNG MINH. Request mang phiên
 * tổ chức khác rơi vào ngăn nhà — đó là phần dư đã biết, và lối gọi mạng vẫn chặn nó bằng
 * `assertHomeCredentials()`. Hai lớp: ngăn đúng khi biết, lời chặn đúng mọi lúc.
 */

/** Không phải mã tổ chức hợp lệ (`^[a-z]…`) nên không bao giờ trùng ngăn của tổ chức nào. */
export const HOME_CLIENT_SLOT = "@home";

export type ClientSlot = { key: string; isHome: boolean; organization: string | null };

export function currentClientSlot(): ClientSlot {
  const explicit = peekOrganization();
  if (explicit && !explicit.isHome) return { key: explicit.code, isHome: false, organization: explicit.code };
  return { key: HOME_CLIENT_SLOT, isHome: true, organization: explicit?.code ?? null };
}

export type PerOrganizationClients<T> = {
  /** Client của ngăn hiện hành — dựng lần đầu, dùng lại về sau. Hàm dựng ném ⇒ không lưu gì. */
  get(): T;
  /** CHỈ KIỂM THỬ: đặt client của NGĂN NHÀ; `null` ⇒ vứt MỌI ngăn (lượt sau dựng lại client thật). */
  setHomeForTests(client: T | null): void;
  /** Các ngăn đang giữ client — để bài kiểm chứng minh tổ chức khác không dùng chung ngăn nhà. */
  slotKeys(): string[];
};

export function perOrganizationClients<T>(build: { home: () => T; other: (organization: string) => T }): PerOrganizationClients<T> {
  const slots = new Map<string, T>();
  return {
    get() {
      const slot = currentClientSlot();
      const hit = slots.get(slot.key);
      if (hit !== undefined) return hit;
      const client = slot.isHome ? build.home() : build.other(slot.key);
      slots.set(slot.key, client);
      return client;
    },
    setHomeForTests(client) {
      if (client === null) slots.clear();
      else slots.set(HOME_CLIENT_SLOT, client);
    },
    slotKeys() {
      return [...slots.keys()];
    },
  };
}
