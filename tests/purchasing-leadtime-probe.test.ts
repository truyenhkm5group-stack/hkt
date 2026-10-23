/**
 * ops `purchasing-leadtime-probe` (OD-P2-03, 23/10/2026): cùng MỘT script đo lead time xưởng TRƯỚC và SAU khi báo cáo chuyển sang mốc
 * thật `received_at`. Khoá:
 *  · đọc được báo cáo hình dạng CŨ (chưa có độ phủ mốc thật / ước tính) ⇒ in «—», không 0, không ném;
 *  · đọc được hình dạng MỚI ⇒ in đủ mốc thật · ước tính · căn cứ;
 *  · gọi đúng hàm báo cáo của trang (không viết lại phép tính) và ép chỉ đọc trước lần mở kết nối đầu;
 *  · khai ở ops-vps.yml (lựa chọn · mã hoá · chỉ đọc · nhánh chạy).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProbeArgs, probeLines } from "../scripts/purchasing-leadtime-probe";

export function testPurchasingLeadtimeProbe() {
  // Hình dạng CŨ (main hôm nay): không có leadActual / leadEstimated / leadBasis.
  const cu = probeLines({
    windowDays: 90,
    coverage: { leadMatched: 4, leadAmbiguous: 1, leadUnmatched: 2, leadCoveragePercent: 57.1 },
    suppliers: [
      { supplier: "Xưởng A", leadDaysP50: 12, leadDaysP90: 18, leadMatched: 4, leadAmbiguous: 1, leadUnmatched: 0, onTimeRate: null, onTimeBasis: 2 },
      { supplier: "Xưởng rỗng", leadDaysP50: null, leadDaysP90: null, leadMatched: 0, leadAmbiguous: 0, leadUnmatched: 2, onTimeRate: null, onTimeBasis: 0 },
    ],
  });
  assert.match(cu[0], /ghép được 4 · nhập nhằng 1 · không ghép 2 · phủ 57\.1% · mốc thật — · ước tính —/, "bản cũ ⇒ trường mới in «—»");
  assert.equal(cu.length, 2, "xưởng không có lô đo nào (bản cũ) không in dòng");
  assert.match(cu[1], /xưởng «Xưởng A»: p50 12 · p90 18 ngày · lô đo 4 \(mốc thật — · ước tính —\).*căn cứ —.*đúng hạn —% \/ 2 lô/);
  // Hình dạng MỚI.
  const moi = probeLines({
    windowDays: 90,
    coverage: { leadMatched: 1, leadAmbiguous: 0, leadUnmatched: 1, leadCoveragePercent: 80, leadActual: 3, leadEstimated: 1 },
    suppliers: [{ supplier: "Xưởng A", leadDaysP50: 10, leadDaysP90: 14, leadMatched: 1, leadActual: 3, leadEstimated: 1, leadAmbiguous: 0, leadUnmatched: 0, leadBasis: "ACTUAL", onTimeRate: 75, onTimeBasis: 4 }],
  });
  assert.match(moi[0], /mốc thật 3 · ước tính 1/);
  assert.match(moi[1], /lô đo 1 \(mốc thật 3 · ước tính 1\).*căn cứ ACTUAL · đúng hạn 75% \/ 4 lô/);
  for (const l of [...cu, ...moi]) assert.ok(l.length <= 300, "dòng tóm tắt ≤ 300 ký tự");
  // Đối số.
  assert.deepEqual(parseProbeArgs(["vnx"]), { code: "vnx", days: undefined });
  assert.deepEqual(parseProbeArgs(["hslc-hmt-shop", "--days=60"]), { code: "hslc-hmt-shop", days: 60 });
  for (const bad of [[], ["HSLC;rm"], ["vnx", "--days=0"], ["vnx", "--days=abc"]]) assert.ok("error" in parseProbeArgs(bad), `đối số sai bị từ chối: ${bad.join(" ")}`);
  // Mã nguồn: chỉ đọc TRƯỚC import @/db; gọi đúng hàm báo cáo; không tự tính lead time.
  const src = readFileSync("scripts/purchasing-leadtime-probe.ts", "utf8");
  assert.ok(src.indexOf('process.env.ERP_READ_ONLY = "1"') < src.indexOf('from "@/db"'), "ép chỉ đọc trước lần nạp @/db");
  assert.match(src, /await getPurchasingReport\(args\.days\)/, "đo bằng CHÍNH hàm báo cáo của trang");
  assert.doesNotMatch(src, /matchProductionToReceipts|percentile\(|received_at\s*-\s*sent_at/, "không viết lại phép tính lead time");
  assert.match(src, /show default_transaction_read_only/);
  // ops-vps.yml khai đủ bốn chỗ.
  const wf = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(wf, /- purchasing-leadtime-probe #/, "có trong danh sách lựa chọn");
  assert.match(wf, /OPS_THAO_TAC_MA_HOA: "[^"]*\bpurchasing-leadtime-probe\b/, "kết quả mã hoá");
  assert.match(wf, /DOC_NANG="[^"]*\bpurchasing-leadtime-probe\b/, "khai là thao tác chỉ đọc");
  assert.match(wf, /purchasing-leadtime-probe\)\n[\s\S]{0,600}scripts\/purchasing-leadtime-probe\.ts ;;/, "có nhánh chạy");
  console.log("✓ ops purchasing-leadtime-probe: đọc báo cáo cũ (trường mới «—») lẫn mới · gọi đúng getPurchasingReport · chỉ đọc trước @/db · khai ops-vps");
}
