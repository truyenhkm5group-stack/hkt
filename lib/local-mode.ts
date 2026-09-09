/**
 * ═══════════ BẢN TEST TRÊN MÁY (localhost) — THỬ TRƯỚC, ĐƯA LÊN ERP SAU ═══════════
 *
 * Quy trình: mọi thay đổi được dựng và xem tận mắt trên máy cá nhân với dữ liệu giả, xong mới đẩy
 * lên ERP thật. Lý do và các bước nằm ở `docs/ideas/0001-ban-localhost-truoc-khi-len-erp.md`.
 *
 * Tệp này giữ HAI câu trả lời dùng chung cho cả lệnh dựng bản test lẫn giao diện — mỗi câu chỉ có
 * một chỗ định nghĩa, không chép sang từng trang:
 *
 *   1. `isLocalDatabaseUrl` — địa chỉ CSDL này có nằm trên chính máy đang chạy không?
 *      Lệnh dựng bản test XOÁ rồi GIEO lại dữ liệu, nên nó chỉ được phép chạm vào CSDL của máy
 *      mình. Không đọc được địa chỉ ⇒ trả về `false`: chưa biết thì phải coi như dữ liệu thật.
 *
 *   2. `isLocalTestMode` — bản đang chạy có phải bản test không? CHỈ dựa vào cờ `ERP_LOCAL_TEST=1`
 *      mà `npm run local:setup` ghi vào `.env.local`. Cố ý KHÔNG suy ra từ địa chỉ CSDL: máy chủ
 *      thật chạy Docker Compose cũng nối tới CSDL trong mạng nội bộ của nó, suy kiểu đó thì ERP
 *      thật sẽ đeo nhãn "bản test". Nhãn đó sai một lần là không ai tin nó nữa.
 */

/** Cờ môi trường bật chế độ bản test. Máy chủ thật không bao giờ đặt cờ này. */
export const LOCAL_TEST_FLAG = "ERP_LOCAL_TEST";

/** CSDL nhúng dành riêng cho bản test — tách khỏi `data/pglite` của lần chạy thử thông thường. */
export const LOCAL_TEST_DATABASE_URL = "pglite://./data/pglite-local";

/** Địa chỉ mở bản test trên trình duyệt. */
export const LOCAL_TEST_URL = "http://localhost:3000";

/** Câu cảnh báo hiện trên mọi trang của bản test. */
export const LOCAL_TEST_NOTICE = "BẢN TEST TRÊN MÁY — dữ liệu ở đây là dữ liệu thử, không phải số thật của shop.";

/**
 * Tên máy được coi là "máy mình". Cố ý KHÔNG có `db` / `erp-db` (tên dịch vụ trong Docker Compose
 * của máy chủ thật): chạy nhầm lệnh dựng bản test trong container trên VPS thì phải bị chặn.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** Thư mục dữ liệu của địa chỉ PGlite (`pglite://./data/x`); `null` nếu không phải PGlite hoặc chạy trong bộ nhớ. */
export function pgliteDirectory(url: string | undefined | null): string | null {
  const raw = (url ?? "").trim();
  if (!raw.startsWith("pglite:")) return null;
  const dir = raw.replace(/^pglite:\/\//, "").replace(/^pglite:/, "");
  return dir === "memory" || dir === "" ? null : dir;
}

/** CSDL có nằm trên chính máy đang chạy không? Không đọc được ⇒ `false` (coi như dữ liệu thật). */
export function isLocalDatabaseUrl(url: string | undefined | null): boolean {
  const raw = (url ?? "").trim();
  if (!raw) return false;
  // PGlite là CSDL nhúng, dữ liệu nằm trong thư mục của dự án — luôn là máy mình.
  if (raw.startsWith("pglite:")) return true;
  if (!/^postgres(ql)?:\/\//i.test(raw)) return false;
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    // Mật khẩu có ký tự lạ làm hỏng phép phân tích ⇒ không dám khẳng định là máy mình.
    return false;
  }
}

/** Bản đang chạy có phải bản test trên máy không? */
export function isLocalTestMode(env: Record<string, string | undefined> = process.env): boolean {
  return (env[LOCAL_TEST_FLAG] ?? "").trim() === "1";
}

export type LocalDatabaseGuard = { ok: true; url: string } | { ok: false; error: string };

/**
 * Cổng chặn của lệnh dựng bản test: chỉ cho đi tiếp khi CSDL nằm trên máy mình.
 * Trả `{ error }` thay vì throw để nơi gọi in ra câu tiếng Việt rồi thoát gọn.
 */
export function guardLocalDatabase(url: string | undefined | null): LocalDatabaseGuard {
  const raw = (url ?? "").trim();
  if (!raw) return { ok: false, error: "Chưa có DATABASE_URL cho bản test." };
  if (!isLocalDatabaseUrl(raw)) {
    return {
      ok: false,
      error:
        `DATABASE_URL của bản test trỏ ra ngoài máy này (${raw.replace(/:\/\/[^@]*@/, "://***@")}). ` +
        "Lệnh dựng bản test xoá và gieo lại dữ liệu nên chỉ được chạy trên CSDL của máy mình " +
        `(mặc định ${LOCAL_TEST_DATABASE_URL}). Sửa DATABASE_URL trong .env.local rồi chạy lại.`,
    };
  }
  return { ok: true, url: raw };
}
