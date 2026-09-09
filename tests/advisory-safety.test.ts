import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * LỚP TƯ VẤN TUYỆT ĐỐI KHÔNG ĐƯỢC GHI DỮ LIỆU.
 *
 * Ranh giới cứng của toàn bộ lớp trợ lý và lớp khuyến nghị: ERP ĐỌC dữ liệu quảng cáo, tồn kho,
 * tiền — và chỉ ĐỀ XUẤT. Không tự đổi ngân sách quảng cáo, không tự tạo đơn sản xuất, không tự sửa
 * tồn kho, không tự đối soát COD, không tự đổi trạng thái đơn hay vận đơn.
 *
 * Vì sao kiểm ở mức MÃ NGUỒN chứ không chỉ bằng hành vi: một lời hứa trong tài liệu không chặn được
 * ai. Một câu `db.update` lọt vào lớp này sẽ chạy im lặng và đúng lúc không ai nhìn. Bài kiểm thử
 * này đỏ ngay khi có người thêm phép ghi vào đúng những file không được phép ghi.
 */

/**
 * TOÀN BỘ `lib/queries` là chỉ-đọc, không phải một danh sách gõ tay.
 *
 * Bản trước liệt kê 15 tệp. Danh sách như thế bảo vệ đúng những gì có người nhớ ghi vào nó — module
 * tư vấn viết ngày mai thì không ai canh. Cùng lỗi thiết kế đã gặp ba lần khác trong kho mã này
 * (job không có lịch · phép nối vận đơn không canh grain · lá chắn chi phí canh sáu tệp).
 *
 * Ở đây luật kiến trúc còn mạnh hơn nên lật được triệt để: `AGENTS.md` mục 2 nói truy vấn chỉ-server
 * nằm ở `lib/queries/*`, mọi phép GHI nằm ở `lib/actions/*` — có `requireUser` / `can`, có zod, có
 * `audit()`. Đo ngày 10/09/2026: **0/61 tệp** trong `lib/queries` chứa phép ghi, nên ranh giới này
 * đang đúng và chỉ cần được canh.
 *
 * Không có danh sách miễn trừ, và cố ý: một tệp trong `lib/queries` cần ghi dữ liệu thì nó đang nằm
 * sai thư mục.
 */
function moduleChiDoc(): string[] {
  const tep = readdirSync("lib/queries")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `lib/queries/${f}`);
  if (tep.length < 40) throw new Error(`đọc hụt lib/queries (chỉ thấy ${tep.length} tệp)`);
  return [...tep, ...SCRIPT_CHI_DOC];
}

/** Script vận hành chỉ được ĐỌC — chúng chạy trên production, không qua giao diện, không ai nhìn. */
const SCRIPT_CHI_DOC = [
  "scripts/kpi-snapshot.ts",
  "scripts/profit-verify.ts",
];

/** Dấu hiệu ghi dữ liệu ở tầng drizzle. */
const WRITE_PATTERNS = [/\.update\s*\(/, /\.insert\s*\(/, /\.delete\s*\(/, /\bdrop\s+table\b/i, /\btruncate\b/i];

export function testAdvisorySafety() {
  const READ_ONLY_MODULES = moduleChiDoc();
  for (const file of READ_ONLY_MODULES) {
    const src = readFileSync(file, "utf8");
    for (const pattern of WRITE_PATTERNS) {
      assert.ok(
        !pattern.test(src),
        `${file} CHỈ ĐƯỢC ĐỌC nhưng chứa phép ghi khớp ${pattern}. Lớp tư vấn không được tự thay đổi dữ liệu — nếu thật sự cần ghi thì phải qua một Server Action có quyền, có nhật ký, và có người bấm.`,
      );
    }
  }

  // ───────── Không gọi API bên thứ ba để THAY ĐỔI ─────────
  // Đọc chi tiêu quảng cáo là hợp lệ; đổi ngân sách thì không.
  const ads = readFileSync("lib/queries/ads-anomaly.ts", "utf8");
  for (const forbidden of ["daily_budget", "lifetime_budget", "POST", "adsets/"]) {
    assert.ok(!ads.includes(forbidden), `bộ phát hiện quảng cáo không được đụng tới "${forbidden}" — nó chỉ đọc và đề xuất`);
  }

  // ───────── Bản tóm tắt không được tự tính lại KPI bằng văn bản ─────────
  // Mọi con số phải tính bằng truy vấn; nếu sau này nối AI thì nó chỉ diễn đạt lại.
  const brief = readFileSync("lib/queries/business-brief.ts", "utf8");
  assert.ok(brief.includes("KHÔNG BẰNG MÔ HÌNH NGÔN NGỮ"), "bản tóm tắt phải ghi rõ ranh giới deterministic ngay trong mã");

  console.log(`✓ An toàn lớp tư vấn: TOÀN BỘ ${READ_ONLY_MODULES.length} module (cả lib/queries) không chứa phép ghi nào · không đụng ngân sách quảng cáo · tóm tắt tính bằng truy vấn`);
}
