/**
 * ───────────── BẢN NÀO ĐANG CHẠY ─────────────
 *
 * `scripts/install-vps.sh` ghi `ERP_COMMIT` / `ERP_BRANCH_NAME` vào `.env` mỗi lần deploy. Đó là
 * lời khai DUY NHẤT về việc máy chủ đang chạy bản nào — "deploy xanh" trên GitHub Actions không
 * chứng minh được điều đó (container có thể chưa khởi động lại, hoặc khởi động lại bằng ảnh cũ).
 *
 * Hàm này tồn tại để `/api/health` và trang `/tech` đọc CÙNG MỘT chỗ. Chép hai dòng
 * `process.env.ERP_COMMIT || "unknown"` sang hai tệp là cách quen thuộc nhất để một ngày nào đó
 * hai màn hình nói hai commit khác nhau.
 *
 * `null` nghĩa là CHƯA BIẾT — chạy dev, hoặc `.env` chưa có. KHÔNG được in ra thành một chuỗi
 * trông như một commit (AGENTS.md mục 42).
 */
export type RunningVersion = {
  /** SHA đầy đủ do deploy ghi. `null` = CHƯA BIẾT. */
  commit: string | null;
  branch: string | null;
};

function sach(value: string | undefined) {
  const v = (value ?? "").trim();
  // `unknown` là giá trị `/api/health` đã dùng nhiều tháng cho "chưa biết"; đọc lại nó thành `null`
  // để chỉ có MỘT cách biểu diễn cái chưa biết ở tầng TypeScript.
  return !v || v === "unknown" ? null : v;
}

export function runningVersion(): RunningVersion {
  return { commit: sach(process.env.ERP_COMMIT), branch: sach(process.env.ERP_BRANCH_NAME) };
}

/** Bảy ký tự đầu, như `git log --oneline`. Chưa biết thì trả `null`, không trả chuỗi rỗng. */
export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/**
 * ───────────── CÂU LỖI ĐI RA NGOÀI PHẢI SẠCH ─────────────
 *
 * `/api/health` là tuyến CÔNG KHAI (`middleware.ts::PUBLIC_PREFIXES`) — không đăng nhập vẫn gọi
 * được, vì cả GitHub Actions lẫn script cài đặt đều hỏi nó trước khi có phiên nào. Nhánh lỗi của
 * nó trả về nguyên văn `error.message` của CSDL, và câu ấy có thể mang chuỗi kết nối: `pg` in ra
 * host, cổng, tên cơ sở dữ liệu, và với một URL sai định dạng thì in cả phần `user:mật_khẩu@`.
 *
 * Kho mã này PUBLIC và một lần lộ là lộ vĩnh viễn (AGENTS.md mục 5). Nên câu lỗi được CHE trước
 * khi đi ra: giữ đủ để chẩn đoán ("không kết nối được CSDL"), bỏ phần nói mình là ai.
 *
 * KHÔNG đổi hình dạng phong bì: `scripts/install-vps.sh`, `deploy-vps.yml` và `ops-vps.yml` chỉ
 * đọc `ok` và `commit`, không nơi nào đọc `error` — nên che nó không phá lá chắn nào.
 *
 * HÀM THUẦN, kiểm thử được mà không cần dựng một CSDL hỏng.
 */
export function redactedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      // `postgres://nguoi:matkhau@may:5432/db` → `postgres://***@***`
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*/gi, "***")
      // `password=...`, `PGPASSWORD=...`, `token: ...` ở dạng cặp khoá–giá trị
      // Tiền tố tuỳ ý trước từ khoá: `PGPASSWORD`, `DB_PASSWORD`, `x-api-key` đều phải khớp.
      // Dùng `\b` ở đầu thì `PGPASSWORD` KHÔNG khớp (không có ranh giới từ giữa `G` và `PASSWORD`)
      // — đúng cái bẫy mà bài kiểm bắt được.
      .replace(/([A-Za-z_-]*(?:pass(?:word)?|pwd|secret|token|api[_-]?key|authorization))\s*[=:]\s*\S+/gi, "$1=***")
      // Địa chỉ máy chủ nội bộ + cổng (`10.0.0.4:5432`, `db:5432`)
      .replace(/\b[a-z0-9_.-]+:\d{2,5}\b/gi, "***")
      .slice(0, 300)
  );
}
