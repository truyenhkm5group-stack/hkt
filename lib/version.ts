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
