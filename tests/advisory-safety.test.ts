import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/** Các file CHỈ ĐƯỢC ĐỌC. Thêm phép ghi vào đây là phá ranh giới. */
const READ_ONLY_MODULES = [
  "lib/queries/business-brief.ts",
  "lib/queries/ads-anomaly.ts",
  "lib/queries/ads-attribution.ts",
  "lib/queries/ads-attribution-link.ts",
  "lib/queries/cashflow.ts",
  "lib/queries/slow-moving.ts",
  "lib/queries/sales-funnel.ts",
  "lib/queries/purchasing.ts",
  "lib/queries/crm.ts",
  "lib/queries/staff-performance.ts",
  "lib/queries/entity-timeline.ts",
  "lib/queries/search.ts",
  "scripts/kpi-snapshot.ts",
  "scripts/profit-verify.ts",
];

/** Dấu hiệu ghi dữ liệu ở tầng drizzle. */
const WRITE_PATTERNS = [/\.update\s*\(/, /\.insert\s*\(/, /\.delete\s*\(/, /\bdrop\s+table\b/i, /\btruncate\b/i];

export function testAdvisorySafety() {
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

  console.log(`✓ An toàn lớp tư vấn: ${READ_ONLY_MODULES.length} module chỉ-đọc không chứa phép ghi nào · không đụng ngân sách quảng cáo · tóm tắt tính bằng truy vấn`);
}
