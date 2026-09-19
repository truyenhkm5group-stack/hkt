/**
 * MÔ PHỎNG BỘ ĐỊNH TUYẾN NHIỀU NHÀ CUNG CẤP TRÊN LƯỢT CHẠY ĐÃ CÓ THẬT — CHỈ ĐỌC.
 *
 *   npx tsx scripts/ai-staging-router-sim.ts [--days=30] [--limit=5000]
 *
 * ═══ NÓ TRẢ LỜI GÌ ═══
 *
 * Một câu hỏi phản thực, và đúng một câu: *nếu* mọi lượt đã chạy kia đi qua một bộ định tuyến bốn
 * tầng thì chúng rơi vào làn nào, và bao nhiêu phần trăm KHÔNG cần gọi mô hình. Nó KHÔNG đổi một
 * lượt nào, KHÔNG gọi một mô hình nào, KHÔNG ghi một dòng nào.
 *
 * Toàn bộ phép chọn làn nằm ở `lib/constants/router-sim.ts` — tệp này chỉ DỰNG ĐẦU VÀO rồi đếm.
 * Chép lại luật chọn làn vào đây (hay vào SQL) là dựng một bộ định tuyến thứ hai, và hai bộ sẽ nói
 * hai điều khác nhau ngay lần sửa đầu tiên.
 *
 * ═══ BA ĐIỀU NÓ KHÔNG NÓI ═══
 *
 * 1. KHÔNG nói mô hình nào trả lời TỐT HƠN. Chưa lượt nào được người chấm; mọi so sánh chất lượng
 *    lúc này là bịa. Bảng dưới chỉ có ĐƯỜNG ĐI và TIỀN.
 * 2. KHÔNG nói tiền của làn Gemini/Claude là bao nhiêu nếu bảng giá chưa khai — chưa khai thì in
 *    CHƯA BIẾT, không in 0, và cũng không đi tra giá trên Internet.
 * 3. KHÔNG khuyến nghị bật gì. Nó in số; người quyết.
 */
import "dotenv/config";
import { desc, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { estimateCostVnd } from "@/lib/ai-workforce/model-router";
import { getAiSettings } from "@/lib/ai-workforce/config";
import { getProvider } from "@/lib/ai-workforce/providers";
import { MODEL_REGISTRY, type ModelRole } from "@/lib/constants/model-registry";
import { ROUTE_LANES, ROUTE_LANE_LABEL, simulateRoute, type RouteLane, type RouterSimInput } from "@/lib/constants/router-sim";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

/** In một con số VND, hoặc `—` khi CHƯA BIẾT. Không bao giờ in 0 thay cho chưa biết (luật 42). */
function tien(v: number | null): string {
  return v === null ? "—" : `${v.toLocaleString("vi-VN")} ₫`;
}

function pct(phan: number, mau: number): string {
  return mau === 0 ? "—" : `${((phan / mau) * 100).toFixed(1)}%`;
}

/** Làn nào tiêu tiền ở vai trò nào. `RULE_ONLY` và `HUMAN` không gọi mô hình ⇒ không có vai trò. */
const VAI_TRO_CUA_LAN: Record<RouteLane, { provider: string; role: ModelRole } | null> = {
  RULE_ONLY: null,
  HUMAN: null,
  OPENAI_ROUTINE: { provider: "erp", role: "ROUTINE" },
  GEMINI_ROUTINE: { provider: "google", role: "ROUTINE" },
  GEMINI_COMPLEX: { provider: "google", role: "COMPLEX" },
  ANTHROPIC_COMPLEX: { provider: "anthropic", role: "COMPLEX" },
};

type Row = {
  runId: string;
  understanding: unknown;
  decision: unknown;
  stateAfter: unknown;
  facts: unknown;
  hasAttachment: boolean | null;
  attachmentTypes: string[] | null;
  customerTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costVnd: number | null;
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function chuoi(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function so(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Dựng đầu vào mô phỏng từ MỘT lượt đã lưu.
 *
 * Mọi ô thiếu đều rơi về phía THẬN TRỌNG, không về phía rẻ: thiếu độ tin ⇒ `null` (luật không kết
 * luận được ⇒ khó), thiếu mẫu mã ⇒ `false`. Rơi về phía rẻ ở đây là thổi phồng con số tiết kiệm.
 */
function dungDauVao(r: Row): RouterSimInput {
  const u = obj(r.understanding);
  const d = obj(r.decision);
  const s = obj(r.stateAfter);
  const f = obj(r.facts);
  const intents = Array.isArray(u.intents) ? u.intents.filter((i): i is string => typeof i === "string") : [];
  // Ảnh: một tệp đính kèm có kiểu ảnh, HOẶC có đính kèm mà không biết kiểu — chưa biết thì coi là
  // CÓ, vì đoán "không có ảnh" làm lượt ấy rơi vào làn rẻ mà nó có thể không đi được.
  const kieu = r.attachmentTypes ?? [];
  const hasImage = Boolean(r.hasAttachment) && (kieu.length === 0 || kieu.some((t) => /image|photo|sticker/i.test(t)));
  return {
    intents,
    ruleConfidence: so(u.confidence),
    hasProduct: Boolean(chuoi(f.productName) || chuoi(s.productName)),
    hasVariant: Boolean(chuoi(f.variantLabel) || chuoi(s.variantLabel)),
    quotedTotal: so(f.quotedTotal) ?? so(s.quotedTotal),
    humanTakeover: s.humanTakeover === true,
    handoffReason: chuoi(d.handoffReason) || chuoi(obj(d.evaluation).handoffReason),
    hasImage,
    customerTurns: r.customerTurns,
  };
}

async function main() {
  const days = Number(arg("days")) || 30;
  const limit = Number(arg("limit")) || 5000;
  const since = new Date(Date.now() - days * 86_400_000);
  const db = await getDb();
  const settings = await getAiSettings();

  const rows = (await db
    .select({
      runId: schema.aiRuns.id,
      understanding: schema.aiRuns.understanding,
      decision: schema.aiRuns.decision,
      stateAfter: schema.aiRuns.stateAfter,
      facts: schema.salesSuggestions.factsJson,
      hasAttachment: schema.salesMessages.hasAttachment,
      attachmentTypes: schema.salesMessages.attachmentTypes,
      customerTurns: sql<number>`(
        select count(*)::int from sales_messages m2
        where m2.conversation_id = ${schema.salesSuggestions.conversationId}
          and m2.direction = 'IN'
          and m2.sent_at <= coalesce(${schema.salesMessages.sentAt}, now())
      )`,
      inputTokens: schema.aiRuns.inputTokens,
      outputTokens: schema.aiRuns.outputTokens,
      cachedInputTokens: schema.aiRuns.cachedInputTokens,
      costVnd: schema.aiRuns.costVnd,
    })
    .from(schema.aiRuns)
    .leftJoin(schema.salesSuggestions, sql`${schema.salesSuggestions.runId} = ${schema.aiRuns.id}`)
    .leftJoin(schema.salesMessages, sql`${schema.salesMessages.id} = ${schema.salesSuggestions.triggerMessageId}`)
    .where(gte(schema.aiRuns.createdAt, since))
    .orderBy(desc(schema.aiRuns.createdAt))
    .limit(limit)) as Row[];

  console.log("═══ MÔ PHỎNG ĐỊNH TUYẾN — CHỈ ĐỌC, KHÔNG GỌI MÔ HÌNH NÀO ═══");
  console.log(`  cửa sổ       : từ ${since.toISOString()} (${days} ngày)`);
  console.log(`  số lượt chạy : ${rows.length}`);
  console.log(`  bảng giá     : ${settings.pricingVersion || "(CHƯA KHAI)"}`);
  if (rows.length === 0) {
    console.log("\nKhông có lượt nào trong cửa sổ — nới --days.");
    return;
  }

  const demLan: Record<RouteLane, number> = Object.fromEntries(ROUTE_LANES.map((l) => [l, 0])) as Record<RouteLane, number>;
  const demLanDoiChung: Record<RouteLane, number> = Object.fromEntries(ROUTE_LANES.map((l) => [l, 0])) as Record<RouteLane, number>;
  const viDu: Partial<Record<RouteLane, string>> = {};
  let ruleOnly = 0;
  let thieuDoTin = 0;

  // TIỀN HIỆN TẠI: cộng từ `ai_runs.cost_vnd`. Một lượt chưa khai giá là đủ làm CẢ TỔNG chưa biết —
  // đúng hành vi đã có ở `ai_runs`, và là chiều sai an toàn: một cột "hiện tại" báo rẻ hơn thực tế
  // sẽ làm mọi phương án thay thế trông tệ hơn thực tế.
  let tienHienTai: number | null = 0;
  // TIỀN THEO MÔ PHỎNG: dùng CHÍNH số token của lượt ấy, chỉ đổi đơn giá sang mô hình của làn.
  // Đoán token theo làn sẽ là một con số bịa chồng lên một con số bịa.
  let tienMoPhong: number | null = 0;
  let luotChuaKhaiGiaLan = 0;

  for (const r of rows) {
    const input = dungDauVao(r);
    if (input.ruleConfidence === null) thieuDoTin += 1;
    const kq = simulateRoute(input);
    const kqDoiChung = simulateRoute(input, { challenger: true });
    demLan[kq.lane] += 1;
    demLanDoiChung[kqDoiChung.lane] += 1;
    if (kq.ruleOnlyEligible) ruleOnly += 1;
    if (!viDu[kq.lane]) viDu[kq.lane] = kq.why;

    if (tienHienTai !== null) {
      if (r.costVnd === null) tienHienTai = null;
      else tienHienTai += r.costVnd;
    }

    const vai = VAI_TRO_CUA_LAN[kq.lane];
    if (!vai) continue; // luật / người: 0 THẬT, không phải chưa biết
    /*
      TÊN MÔ HÌNH: sổ mẫu cố ý để trống khi tên đến từ biến môi trường (ghi cứng một tên vào sổ là
      đè lên lựa chọn của người vận hành). Nên hỏi CHÍNH nhà cung cấp — cùng một hàm mà đường chạy
      thật dùng — rồi mới lùi về tên khai trong sổ. Không có tên ⇒ không tra được giá ⇒ CHƯA BIẾT.
    */
    const mau = MODEL_REGISTRY.find((m) => m.provider === vai.provider && m.role === vai.role);
    const tenMau = getProvider(vai.provider)?.defaultModel(vai.role === "ROUTINE" ? "ECONOMY" : "STRONG") || mau?.model || "";
    const usage = {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadInputTokens: r.cachedInputTokens,
      cacheWriteInputTokens: 0,
    };
    const gia = tenMau ? estimateCostVnd(vai.provider, tenMau, usage, settings.pricing) : null;
    if (gia === null) {
      luotChuaKhaiGiaLan += 1;
      tienMoPhong = null;
    } else if (tienMoPhong !== null) {
      tienMoPhong += gia;
    }
  }

  console.log("\n── LUẬT CÓ TỰ TRẢ LỜI ĐƯỢC KHÔNG (RULE_ONLY_ELIGIBLE) ──");
  console.log(`  đủ điều kiện : ${ruleOnly}/${rows.length} = ${pct(ruleOnly, rows.length)}`);
  console.log(`  luật KHÔNG kết luận được độ tin: ${thieuDoTin} lượt (${pct(thieuDoTin, rows.length)})`);
  console.log("  Đây là con số đáng giá nhất: mỗi lượt luật xử được là một lượt không tốn token VÀ không có cơ hội bịa.");

  console.log("\n── PHÂN BỔ LÀN (kịch bản đang chạy · kịch bản đối chứng Gemini) ──");
  for (const lan of ROUTE_LANES) {
    console.log(
      `  ${lan.padEnd(18)} ${String(demLan[lan]).padStart(5)} (${pct(demLan[lan], rows.length).padStart(6)})` +
        `  │ đối chứng ${String(demLanDoiChung[lan]).padStart(5)} (${pct(demLanDoiChung[lan], rows.length).padStart(6)})` +
        `  — ${ROUTE_LANE_LABEL[lan]}`,
    );
    if (viDu[lan]) console.log(`  ${" ".repeat(18)} ví dụ lý do: ${viDu[lan]}`);
  }

  console.log("\n── TIỀN: HIỆN TẠI vs ROUTER V1 ──");
  console.log(`  HIỆN TẠI  (tiền thật đã ghi)        : ${tien(tienHienTai)}`);
  console.log(`  ROUTER V1 (cùng token, đơn giá làn) : ${tien(tienMoPhong)}`);
  if (tienMoPhong === null) {
    console.log(`  → CHƯA BIẾT vì ${luotChuaKhaiGiaLan} lượt rơi vào làn có mô hình CHƯA KHAI ĐƠN GIÁ.`);
    console.log("    Khai giá ở settings (khoá cấu hình AI, mục `pricing`) rồi chạy lại. KHÔNG đi tra giá trên Internet.");
  } else if (tienHienTai !== null) {
    const chenh = tienHienTai - tienMoPhong;
    console.log(`  chênh lệch                          : ${tien(Math.abs(chenh))} ${chenh >= 0 ? "RẺ HƠN" : "ĐẮT HƠN"}`);
  }
  console.log("\n  CẢNH BÁO ĐỌC SỐ: bảng này so TIỀN, không so CHẤT LƯỢNG. Chưa lượt nào được người chấm,");
  console.log("  nên không con số nào ở đây cho phép kết luận một mô hình trả lời tốt hơn mô hình khác.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
