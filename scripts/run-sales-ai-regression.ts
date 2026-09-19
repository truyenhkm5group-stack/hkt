/**
 * TRÌNH CHẠY HỒI QUY NHÂN SỰ BÁN HÀNG.
 *
 *   npm run ai:regression                  # ca dựng sẵn + ca trong CSDL (nếu nối được)
 *   npm run ai:regression -- --seed-only    # chỉ ca dựng sẵn, KHÔNG chạm CSDL
 *   npm run ai:regression -- --case=<khoá>  # một ca, in đủ từng lượt
 *   npm run ai:regression -- --json         # in JSON để máy đọc
 *
 * KHÔNG GHI GÌ, KHÔNG GỌI MẠNG, KHÔNG GỌI MÔ HÌNH. Chạy được với CSDL rỗng và chạy được khi không
 * có CSDL nào — vì bộ ca này phải chạy được TRƯỚC khi đẩy mã, trên máy của người viết, không phải
 * chỉ trên bản chạy thử.
 *
 * MÃ THOÁT: 0 khi mọi ca đạt, 1 khi có ca trượt. Đó là thứ cho phép cắm nó vào cổng kiểm thử sau này.
 */
// Đọc `.env` như mọi script khác của kho mã. Thiếu dòng này thì trình chạy KHÔNG BAO GIỜ đọc được
// ca trong CSDL — nó vẫn in ra cảnh báo (nên không nói dối), nhưng người dùng sẽ tưởng là chưa ai
// thêm ca nào trong khi ca vẫn nằm đó.
import "dotenv/config";
import { SEED_REGRESSION_CASES } from "@/lib/constants/sales-regression-seed";
import {
  REGRESSION_FAILURES,
  REGRESSION_FAILURE_LABEL,
  REGRESSION_FAILURE_OWNER,
  summarizeRegression,
  type RegressionCase,
  type RegressionCaseResult,
} from "@/lib/constants/sales-regression";
import { replayCase, runRegressionCase } from "@/lib/ai-workforce/agents/sales/regression";

/**
 * MỐC BẮT ĐẦU CỐ ĐỊNH CHO MỌI LƯỢT CHẠY.
 *
 * Mốc trong ca là số PHÚT tương đối, nên mốc gốc chỉ cần ổn định. Dùng `Date.now()` thì hai lượt
 * chạy cách nhau một giây vẫn cho cùng kết quả — nhưng một ca có hạn 24 giờ sẽ đo đúng thứ nó phải
 * đo chỉ khi mọi mốc cùng trôi với nhau, và đó là điều số phút tương đối bảo đảm. Chọn một mốc
 * KHÔNG đổi để hai lượt chạy in ra hai báo cáo so sánh được từng dòng.
 */
const MOC_GOC = new Date("2026-01-01T02:00:00.000Z");

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

/**
 * Ca người soát đã bấm thêm từ `/ai/review`. CHỈ ĐỌC.
 *
 * Nối CSDL bằng `import()` động và nuốt lỗi có chủ ý: không có CSDL vẫn phải chạy được bộ ca dựng
 * sẵn. In ra rõ là "không đọc được ca trong CSDL" chứ KHÔNG im lặng coi như có 0 ca — hai điều ấy
 * khác nhau, và gộp lại thì một lượt chạy thiếu mất nửa bộ ca vẫn báo "tất cả đạt".
 */
async function loadDbCases(): Promise<{ cases: RegressionCase[]; error: string }> {
  try {
    const [{ getDb, schema }, { eq }] = await Promise.all([import("@/db"), import("drizzle-orm")]);
    const db = await getDb();
    const rows = await db.select().from(schema.salesRegressionCases).where(eq(schema.salesRegressionCases.active, true));
    return {
      cases: rows.map((r) => ({
        key: r.caseKey,
        title: r.title,
        origin: "REVIEW" as const,
        messages: (r.input as { messages?: RegressionCase["messages"] }).messages ?? [],
        priorState: (r.input as { priorState?: Record<string, unknown> }).priorState ?? {},
        priorStage: ((r.input as { priorStage?: string }).priorStage ?? "NEW_LEAD") as RegressionCase["priorStage"],
        toolResults: (r.input as { toolResults?: Record<string, unknown> }).toolResults ?? {},
        context: (r.input as { context?: RegressionCase["context"] }).context ?? { humanTakeover: false, orderCreated: false, stale: false, canPromiseStock: null },
        expected: r.expected as RegressionCase["expected"],
        sourceConversationId: r.sourceConversationId ?? "",
        sourceSuggestionId: r.sourceSuggestionId ?? "",
        pageId: r.pageId,
      })),
      error: "",
    };
  } catch (e) {
    return { cases: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function inMotCa(ket: RegressionCaseResult) {
  const dau = ket.passed ? "✓" : "✗";
  console.log(`${dau} ${ket.key} — ${ket.title} (${ket.turnsRun} lượt · ${ket.durationMs} ms)`);
  for (const f of ket.findings) {
    console.log(`    · ${REGRESSION_FAILURE_LABEL[f.failure]} [${REGRESSION_FAILURE_OWNER[f.failure]}] ${f.field}`);
    console.log(`      mong đợi: ${f.expected}`);
    console.log(`      thực tế : ${f.actual}`);
  }
}

async function main() {
  const seedOnly = arg("seed-only") !== null;
  const chiMotCa = arg("case");
  const raJson = arg("json") !== null;

  let cases: RegressionCase[] = [...SEED_REGRESSION_CASES];
  let dbError = "";
  if (!seedOnly) {
    const db = await loadDbCases();
    cases = [...cases, ...db.cases];
    dbError = db.error;
  }
  if (chiMotCa) cases = cases.filter((c) => c.key === chiMotCa);
  // Đếm theo CHÍNH tập sắp chạy, không lấy hiệu với bộ dựng sẵn: lọc một ca ra thì phép trừ ấy ra
  // số âm, và một con số âm trên đầu báo cáo làm người đọc nghi ngờ mọi con số còn lại.
  const soDungSan = cases.filter((c) => c.origin === "SEED").length;
  const soTuTrangSoat = cases.length - soDungSan;

  if (!cases.length) {
    console.error(chiMotCa ? `Không có ca nào mang khoá "${chiMotCa}".` : "Không có ca nào để chạy.");
    process.exit(1);
  }

  const t0 = Date.now();
  const ketQua: RegressionCaseResult[] = [];
  for (const c of cases) ketQua.push(await runRegressionCase(c, MOC_GOC));
  const report = summarizeRegression(ketQua, new Date(), Date.now() - t0);

  if (raJson) {
    console.log(JSON.stringify({ ...report, dbError }, null, 2));
    process.exit(report.failed ? 1 : 0);
  }

  console.log("═══ HỒI QUY NHÂN SỰ BÁN HÀNG ═══");
  console.log(`Ca dựng sẵn: ${soDungSan} · ca từ trang soát: ${soTuTrangSoat}`);
  if (dbError) console.log(`⚠ KHÔNG đọc được ca trong CSDL (${dbError}) — con số dưới đây CHƯA ĐỦ, không phải "không có ca nào".`);
  console.log("");
  for (const k of ketQua) inMotCa(k);

  // Một ca chạy riêng thì in đủ từng lượt: lúc đi sửa, thứ cần là thấy dây chuyền nghĩ gì ở lượt nào.
  if (chiMotCa && cases.length === 1) {
    const { turns } = await replayCase(cases[0], MOC_GOC);
    console.log("\n─── từng lượt ───");
    turns.forEach((t, i) => {
      console.log(`\nLượt ${i + 1} · khách: ${t.text}`);
      console.log(`  ý định   : ${t.understanding.intents.join(", ")} (tin cậy ${t.understanding.confidence})`);
      console.log(`  trạng thái: size=${t.state.size || "—"} màu=${t.state.color || "—"} SL=${t.state.quantity} SĐT=${t.state.phone || "—"} muốn mua=${t.state.purchaseIntent} mẫu mã=${t.state.variantId ?? "—"} tổng=${t.state.quotedTotal ?? "—"}`);
      console.log(`  quyết định: ${t.action} · giai đoạn ${t.stage}${t.handoffReason ? ` · lý do chuyển người ${t.handoffReason}` : ""}`);
      console.log(`  câu soạn : ${t.reply || "(không soạn)"}`);
    });
  }

  console.log("\n─── TỔNG ───");
  console.log(`tổng ${report.total} · ĐẠT ${report.passed} · TRƯỢT ${report.failed} · lỗi dây chuyền ${report.errored} · ${report.durationMs} ms`);
  const co = REGRESSION_FAILURES.filter((f) => report.byFailure[f] > 0);
  if (co.length) {
    console.log("\ngom theo loại:");
    for (const f of co) console.log(`  ${String(report.byFailure[f]).padStart(3)} × ${REGRESSION_FAILURE_LABEL[f]} [${REGRESSION_FAILURE_OWNER[f]}]`);
  }
  console.log(report.failed ? "\nCÓ CA TRƯỢT" : "\nTẤT CẢ CA HỒI QUY ĐẠT");
  process.exit(report.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
