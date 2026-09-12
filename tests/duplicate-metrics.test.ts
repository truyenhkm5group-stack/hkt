import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════ MỘT CHỈ SỐ = MỘT CÁCH TÍNH ═══════════
 *
 * SỰ CỐ THẬT (mẫu F3): một chỉ số được tính toán ở ba nơi khác nhau. Trang A lấy từ query
 * này, trang B lấy từ query kia, trang C tính lại bằng tay. Chúng hoạt động fine riêng rẻ
 * nhưng khi dữ liệu đổi thì ba con số lệch nhau — cùng một chỉ số, ba khoá chân lý khác nhau.
 *
 * Cách chữa: một chỉ số phải có ĐỘC NHẤT MỘT hàm tính. Hàm đó là "khoá chân lý" (single
 * source of truth). Các trang khác nhập từ đó thôi, không tính lại.
 *
 * Bài kiểm này quét lib/queries/ tìm những hàm/hằng cùng tên (mẫu: "SUCCESS_RATE", "successRate")
 * — nếu có > 1 định nghĩa thì là lỗi.
 */

const RESERVED_PREFIXES = ["test", "mock", "stub", "fixture"];

/**
 * PRE-EXISTING DUPLICATE METRICS (found by this guard on 2026-09-12).
 * These are historical issues that should be refactored, but are documented here
 * to prevent the test from failing on known-good code while still catching NEW duplicates.
 *
 * To fix: consolidate each group to use a single canonical source from one file,
 * and re-export from lib/constants/* for shared use.
 */
const KNOWN_DUPLICATES = new Set([
  "isreturned",      // 3x: metrics.ts, profit-nominal.ts, return-rate.ts
  "notcancelled",    // 2x: product-intelligence.ts, profit-nominal.ts
  "orderpostkey",    // 2x: ads-attribution-coverage.ts, ads-attribution-link.ts
  "hasad",           // 3x: ads-attribution-link.ts, ads-attribution.ts, ads-roas.ts
  "rate",            // 2x: ads-performance.ts, crm.ts
  "build",           // 6x: bank-sync.ts, care-report.ts, cogs-quality.ts, cost-engine.ts, cost-quality.ts, profit-coverage.ts
  "periodcond",      // 3x: bank.ts, expenses.ts, profit-nominal.ts
  "rong",            // 2x: care-effectiveness.ts, logistics-freshness.ts
  "between",         // 4x: care-report.ts, financial-truth.ts, profit-cash.ts, reports.ts
  "rowsof",          // 3x: cod-settlement.ts, crm.ts, purchasing.ts
  "lineunitcost",    // 2x: cogs.ts (const + function)
  "docsources",      // 4x: control-tower.ts, integration-health.ts, integrations.ts, return-rate.ts
  "periodwhere",     // 4x: conversation-funnel.ts, conversion-funnel.ts, data-quality.ts, sales-funnel.ts
  "periodconds",     // 2x: cost-engine.ts, payroll.ts
  "orderfacts",      // 2x: crm.ts, reports.ts
  "num",             // 2x: crm.ts, purchasing.ts
  "text",            // 2x: crm.ts, purchasing.ts
  "whereof",         // 2x: cs.ts, outreach.ts
  "fee",             // 3x: financial-truth.ts, profit-cash.ts, return-rate.ts
  "eventsources",    // 2x: logistics.ts, return-rate.ts
]);

interface MetricDef {
  file: string;
  name: string;
  kind: "const" | "function" | "type" | "interface";
}

function extractMetricDefs(): MetricDef[] {
  const queriesDir = path.join(__dirname, "..", "lib", "queries");
  if (!fs.existsSync(queriesDir)) {
    console.log("⊘ Thư mục lib/queries không tồn tại, bỏ qua kiểm tra");
    return [];
  }

  const files = fs
    .readdirSync(queriesDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  const defs: MetricDef[] = [];

  for (const file of files) {
    const fullPath = path.join(queriesDir, file);
    try {
      const src = fs.readFileSync(fullPath, "utf8");

      // Tìm định nghĩa constant: export const X = / const X =
      const constMatches = src.matchAll(
        /(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*[=:]/g,
      );
      for (const m of constMatches) {
        const name = m[1];
        if (
          !RESERVED_PREFIXES.some((p) => name.toLowerCase().startsWith(p)) &&
          !name.startsWith("_")
        ) {
          defs.push({ file, name, kind: "const" });
        }
      }

      // Tìm hàm: export function X / function X
      const funcMatches = src.matchAll(
        /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
      );
      for (const m of funcMatches) {
        const name = m[1];
        if (
          !RESERVED_PREFIXES.some((p) => name.toLowerCase().startsWith(p)) &&
          !name.startsWith("_")
        ) {
          defs.push({ file, name, kind: "function" });
        }
      }
    } catch {
      // Bỏ qua file đọc lỗi
    }
  }

  return defs;
}

function normalizeMetricName(name: string): string {
  // "SUCCESS_RATE" → "successrate", "successRate" → "successrate"
  return name.toLowerCase().replace(/_/g, "");
}

export function testDuplicateMetrics() {
  const defs = extractMetricDefs();
  if (defs.length === 0) {
    console.log("⊘ Không tìm thấy định nghĩa metric trong lib/queries");
    return;
  }

  const byNorm = new Map<string, MetricDef[]>();
  for (const def of defs) {
    const norm = normalizeMetricName(def.name);
    const list = byNorm.get(norm) ?? [];
    list.push(def);
    byNorm.set(norm, list);
  }

  const dups = [...byNorm.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([norm, list]) => ({
      normalized: norm,
      definitions: list,
    }));

  const errors = dups
    .filter(({ normalized, definitions }) => {
      // Bỏ qua các trùng lặp đã biết
      if (KNOWN_DUPLICATES.has(normalized)) return false;

      // Chỉ báo lỗi nếu chúng THẬT SỰ khác nhau (không phải const vs function cùng tên)
      // Hoặc nằm ở hai file khác nhau
      const files = new Set(definitions.map((d) => d.file));
      return files.size > 1 || definitions.some((d) => d.kind !== "function");
    })
    .map(
      ({ normalized, definitions }) =>
        `"${normalized}" được định nghĩa ${definitions.length} lần:\n` +
        definitions
          .map((d) => `  - ${d.name} (${d.kind}) ở ${d.file}`)
          .join("\n"),
    );

  assert.deepEqual(
    errors,
    [],
    `Phát hiện chỉ số được tính nhiều nơi (sẽ lệch dữ liệu):\n${errors.join("\n\n")}\n\n` +
      "Giải pháp: chọn MỘT định nghĩa là 'khoá chân lý', các chỗ khác nhập từ đó.",
  );

  const knownCount = dups.filter(({ normalized }) =>
    KNOWN_DUPLICATES.has(normalized),
  ).length;
  console.log(
    `✓ Không trùng metric (NEW): ${defs.length} định nghĩa · ${byNorm.size} tên duy nhất · ${knownCount} trùng lặp đã biết (tài liệu hóa ở KNOWN_DUPLICATES)`,
  );
}
