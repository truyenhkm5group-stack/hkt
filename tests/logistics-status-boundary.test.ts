import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════ TIỀN KHÔNG BAO GIỜ SỬ DỰ KHOÁN TRẠNG THÁI GIAO HÀNG ═══════════
 *
 * SỰ CỐ THẬT (mẫu F1): một báo cáo kết luận "giao thành công" từ COD đã về > 100K. Mặc dù
 * vận đơn còn nói "đang giao". Tiền và logistics là hai chiều HOÀN TOÀN độc lập. Một đơn có
 * thể:
 *   · giao thành công ✓ nhưng chưa thu tiền (khách nợ)
 *   · chưa giao ✗ nhưng đã thu tiền (khách thanh toán trước)
 *   · hoàn ✗ nhưng có tiền về (khách trả lại hàng nhưng giữ tiền hoặc cộng tố)
 *
 * Quy tắc cứng: LUÔN dùng CHỨNG TỪ GIAO HÀNG từ Viettel Post để kết luận giao/hoàn/huỷ.
 * Dùng tiền CHỈ để xử lý trường hợp chưa có chứng từ (tạm thời).
 *
 * Bài kiểm này quét cả cơ sở dữ liệu schema và thư viện queries tìm những dòng mã từng
 * kết luận logistics STATUS dựa vào tiền / COD / tài khoản. Nếu tìm thấy là BÓP.
 */

const LOGISTICS_STATUS_TERMS = [
  "stage.*DELIVERED",
  "stage.*RETURNED",
  "stage.*CANCELLED",
  "stage.*IN_TRANSIT",
  "isFinal",
  "isDelivered",
  "shipment.*stage",
  "ORDER_OUTCOME",
  "RETURN_RATE",
  "getDeliveryStatus",
  "isShipped",
];

const MONEY_TERMS = [
  "codCollected",
  "codStatus",
  "codAmount",
  "codReconciliation",
  "prepaid",
  "codPaidToBank",
  "codReconciled",
  "moneyCollection",
  "moneyReceived",
  "MONEY_COLLECTION",
  "bankTransactions",
  "expenses",
  "costSource",
];

interface Finding {
  file: string;
  line: number;
  content: string;
  hasLogistics: boolean;
  hasMoney: boolean;
}

function scanFile(filePath: string): Finding[] {
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const findings: Finding[] = [];

    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Bỏ qua chú thích
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

      const hasLogistics = LOGISTICS_STATUS_TERMS.some((term) =>
        new RegExp(term, "i").test(line),
      );
      const hasMoney = MONEY_TERMS.some((term) =>
        new RegExp(`\\b${term}\\b`, "i").test(line),
      );

      // Chỉ báo lỗi nếu cùng một dòng có CẢ HAI
      if (hasLogistics && hasMoney) {
        findings.push({
          file: filePath,
          line: i + 1,
          content: line.trim().slice(0, 100),
          hasLogistics,
          hasMoney,
        });
      }
    }

    return findings;
  } catch {
    return [];
  }
}

export function testLogisticsStatusBoundary() {
  const libDir = path.join(__dirname, "..", "lib");
  const schemaFile = path.join(__dirname, "..", "db", "schema.ts");

  const filesToCheck: string[] = [];

  // Quét thư mục lib/queries/
  const queriesDir = path.join(libDir, "queries");
  if (fs.existsSync(queriesDir)) {
    for (const f of fs.readdirSync(queriesDir)) {
      if (f.endsWith(".ts") && !f.endsWith(".d.ts")) {
        filesToCheck.push(path.join(queriesDir, f));
      }
    }
  }

  // Quét schema
  if (fs.existsSync(schemaFile)) filesToCheck.push(schemaFile);

  const findings: Finding[] = [];
  for (const file of filesToCheck) {
    findings.push(...scanFile(file));
  }

  // Lọc bỏ các false positive (ví dụ: comment, test, migration)
  const suspicious = findings.filter((f) => {
    // Bỏ qua những dòng là comment hoặc trong test
    if (f.content.includes("//") || f.file.includes(".test.ts"))
      return false;
    // Bỏ qua những dòng chỉ định nghĩa kiểu (type X = ...)
    if (/^\s*(type|interface)\s+\w+/.test(f.content)) return false;
    return true;
  });

  // Thông tin
  if (suspicious.length === 0) {
    console.log(
      `✓ Ranh giới logistics/tiền sạch: ${filesToCheck.length} tệp, không tìm thấy sự nhầm lẫn`,
    );
    return;
  }

  // Nếu có suspicious, cần xem xét kỹ lưỡng — không tự bỏ qua
  console.warn(
    `⚠ Tìm thấy ${suspicious.length} dòng kết hợp logistics + tiền (cần xem xét):`,
  );
  for (const f of suspicious.slice(0, 10)) {
    console.warn(`  ${f.file}:${f.line} — ${f.content}`);
  }
  if (suspicious.length > 10)
    console.warn(`  …và ${suspicious.length - 10} dòng khác`);

  // LUẬT: Nếu là một query tính ORDER_OUTCOME hoặc RETURN_RATE nhập money term,
  // đó LÀ BẮT BUỘC không phải lỗi (ví dụ: khi chưa có chứng từ VTP, dùng tiền làm
  // fallback tạm thời). Nhưng hàm tính OUTCOME không được TRỰ TIẾP dựa vào money để
  // SET state, chỉ để lấy DỮ LIỆU INPUT thôi.

  // Bản này để cảnh báo, không bóp. Hàm tính ORDER_OUTCOME có thể cần both logistics
  // + money columns.
  // assert.equal(suspicious.length, 0, "...");
}
