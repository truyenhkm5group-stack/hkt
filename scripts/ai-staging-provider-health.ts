/**
 * DÒ SỨC KHOẺ NHÀ CUNG CẤP — MỘT LƯỢT GỌI THẬT CHO MỖI NHÀ, IN ĐỦ PHONG BÌ.
 *
 *   npx tsx scripts/ai-staging-provider-health.ts [--provider=erp] [--tier=ECONOMY]
 *
 * ═══ NÓ CHỨNG MINH ĐIỀU GÌ ═══
 *
 * Đúng một điều, và đó là điều duy nhất đáng hỏi sau một sự cố hạ tầng: *lúc này, với ĐÚNG khoá
 * và ĐÚNG cấu hình mà bản chạy thử đang dùng, một lượt gọi có đi được không* — và nếu không thì
 * hỏng ở NHÓM LỖI nào.
 *
 * "ĐÚNG khoá đang dùng" là phần không được phép lơi: một phép dò cầm khoá riêng sẽ xanh trong khi
 * dây chuyền thật vẫn đỏ, và đó là kiểu báo cáo tệ nhất — nó làm người ta ngừng tìm. Nên script
 * này chạy TRONG container của bản chạy thử, đọc cùng `.env.staging`, đi qua CHÍNH `runModelStep`
 * mà mỗi tin nhắn khách đi qua, với CHÍNH lược đồ `UNDERSTANDING_SCHEMA` của dây chuyền.
 *
 * ═══ NÓ KHÔNG LÀM GÌ ═══
 *
 * Không gửi tin cho ai. Không tạo đơn. Không đổi cấu hình. Không đụng hội thoại nào — câu hỏi dò
 * là một câu cố định, không lấy từ khách. Lượt chạy được ghi lại dưới `subjectType = HEALTH_PROBE`
 * để phân biệt hẳn với lượt phục vụ khách trong mọi báo cáo về sau.
 */
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import * as cauHinh from "@/lib/ai-workforce/config";
import { aiEnv, getAiSettings } from "@/lib/ai-workforce/config";
import { runModelStep, type ModelAttempt } from "@/lib/ai-workforce/model-router";
import * as soNha from "@/lib/ai-workforce/providers";
import { getProvider, defaultProviderName, providerNames } from "@/lib/ai-workforce/providers";
import { UNDERSTANDING_SCHEMA } from "@/lib/ai-workforce/agents/sales/understand";
import { ensureAgents, getAgent } from "@/lib/ai-workforce/registry";
import { startRun } from "@/lib/ai-workforce/runs";
import { ensureMigrated } from "@/db/migrate";
import {
  ERROR_POLICY,
  PROVIDER_ERROR_LABEL,
  PROVIDER_HEALTH_LABEL,
  healthForError,
  normalizeProviderError,
  probeAfterFor,
  type ProviderErrorKind,
} from "@/lib/constants/provider-health";
import type { RouteTier } from "@/lib/constants/ai";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? "";

/*
  ẢNH ĐANG CHẠY CÓ THỂ CŨ HƠN NHÁNH NÀY — VÀ PHÉP DÒ PHẢI NÓI RA, KHÔNG ĐƯỢC CHẾT.

  Bản chạy thử được dựng từ một commit trước, nên `SHADOW_ONLY_PROVIDERS` và `getLiveProvider()`
  có thể CHƯA tồn tại trong ảnh. Hai thứ ấy chỉ phục vụ phần soát khoá Gemini; phần P0 — "OpenAI
  gọi được chưa" — không cần chúng.

  Nên: đọc mềm, và khi thiếu thì IN RA rằng chưa soát được, chứ không im lặng bỏ qua (thành một
  báo cáo nói dối) và cũng không chết cả lượt dò (thành một sự cố giả). Chép đè `config.ts` hay
  `providers/index.ts` vào container là cách còn tệ hơn cả hai: đó là những tệp bản chạy thử ĐANG
  DÙNG để phục vụ phiên soát của người khác.
*/
const CHI_O_BONG: readonly string[] = Array.isArray((cauHinh as Record<string, unknown>).SHADOW_ONLY_PROVIDERS)
  ? ((cauHinh as unknown as { SHADOW_ONLY_PROVIDERS: readonly string[] }).SHADOW_ONLY_PROVIDERS)
  : [];
const PHUC_VU_KHACH: readonly string[] = Array.isArray((cauHinh as Record<string, unknown>).WORKFORCE_PROVIDERS)
  ? ((cauHinh as unknown as { WORKFORCE_PROVIDERS: readonly string[] }).WORKFORCE_PROVIDERS)
  : [];
const layNhaPhucVuKhach: ((name: string) => unknown) | null =
  typeof (soNha as Record<string, unknown>).getLiveProvider === "function"
    ? ((soNha as unknown as { getLiveProvider: (n: string) => unknown }).getLiveProvider)
    : null;
/** Ảnh này đã có cơ chế khoá nhà cung cấp chỉ-ở-bóng chưa. */
const ANH_CO_KHOA_BONG = layNhaPhucVuKhach !== null && CHI_O_BONG.length > 0;

/**
 * Câu dò CỐ ĐỊNH, không lấy từ hội thoại nào.
 *
 * Nó là một câu hỏi giá bình thường của khách, nên nó ép mô hình trả về ĐÚNG lược đồ thật chứ
 * không phải một chuỗi "ok" vô nghĩa — một phép dò chỉ kiểm "có trả lời không" sẽ xanh cả khi mô
 * hình đang trả về rác không dùng được.
 */
const CAU_DO = "Áo này bao nhiêu tiền vậy shop?";
const LOI_DAN =
  "Bạn là trợ lý bán hàng. Đọc tin của khách và trả về DUY NHẤT một JSON theo lược đồ: " +
  '{"intents":["PRICE_QUESTION"],"entities":{"productText":"","productCode":"","size":"","color":"","quantity":null,"phone":"","address":"","province":"","heightCm":null,"weightKg":null,"bustCm":null,"waistCm":null,"hipCm":null},"confidence":0.9,"evidence":"..."}';

function inSo(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("vi-VN");
}

async function doMot(ten: string, tier: RouteTier) {
  const nha = getProvider(ten);
  console.log(`\n${"─".repeat(78)}`);
  console.log(`NHÀ CUNG CẤP: ${ten}   ·   nấc: ${tier}`);
  const chiOBong = CHI_O_BONG.includes(ten);
  if (chiOBong) {
    // Nói ra ngay, vì đây là một khẳng định về AN TOÀN và nó phải kiểm được ở mỗi lượt dò.
    console.log(`   ⓘ CHỈ-Ở-BÓNG: dò được, nhưng KHÔNG ra được tới khách.`);
    console.log(`     · getLiveProvider("${ten}") = ${layNhaPhucVuKhach?.(ten) === null ? "null  ✓" : "⛔ KHÔNG PHẢI null — LỖ HỔNG"}`);
    console.log(`     · khai được bằng biến môi trường? ${aiEnv.provider === ten ? "⛔ CÓ — LỖ HỔNG" : "không  ✓"}`);
    console.log(`     · là nhà cung cấp mặc định?       ${defaultProviderName() === ten ? "⛔ CÓ — LỖ HỔNG" : "không  ✓"}`);
  }
  if (!nha) {
    console.log(`   ⛔ không có adapter tên này`);
    return null;
  }
  if (!nha.available()) {
    // CHƯA CẤU HÌNH khác hẳn HỎNG. Gộp hai thứ là báo một sự cố không có thật.
    console.log(`   ⚠ CHƯA CẤU HÌNH (thiếu khoá hoặc thiếu tên mô hình) — KHÔNG gọi, và đây KHÔNG phải một lỗi.`);
    return null;
  }
  const mau = nha.defaultModel(tier);
  console.log(`   mẫu mô hình : ${mau || "(chưa khai)"}`);
  if (!mau) {
    console.log(`   ⚠ CHƯA CẤU HÌNH tên mô hình cho nấc này — KHÔNG gọi.`);
    return null;
  }

  const settings = await getAiSettings();
  const bat = Date.now();
  const kq = await runModelStep({
    step: "health-probe",
    system: LOI_DAN,
    messages: [{ role: "user", content: CAU_DO }],
    schema: UNDERSTANDING_SCHEMA,
    routing: { provider: ten, tiers: [tier] },
    settings,
  });
  const tong = Date.now() - bat;

  const lan = kq.attempts[0] ?? null;
  const loi = lan?.error ?? null;
  // Phân loại bằng CHÍNH bộ chuẩn hoá mà cầu dao dùng — không đọc bằng mắt, không đoán.
  const nhom: ProviderErrorKind | null = loi ? normalizeProviderError({ message: loi }) : null;
  const suc = healthForError(nhom);

  console.log(`   ─ KẾT QUẢ ─`);
  console.log(`   gọi được     : ${lan ? "CÓ" : "KHÔNG (chưa tới được lượt gọi)"}`);
  console.log(`   hợp lược đồ  : ${kq.tier === "HUMAN" ? "KHÔNG" : "CÓ"}${kq.tier === "HUMAN" ? `  (leo hết nấc ⇒ chuyển người · ${kq.escalation})` : ""}`);
  console.log(`   token vào    : ${inSo(lan?.inputTokens)}   (đệm: ${inSo(lan?.cachedInputTokens)})`);
  console.log(`   token ra     : ${inSo(lan?.outputTokens)}`);
  console.log(`   độ trễ       : ${inSo(lan?.latencyMs)} ms   (cả bước: ${inSo(tong)} ms)`);
  console.log(`   nhà/mẫu thật : ${lan?.provider ?? "—"} / ${lan?.model ?? "—"}`);
  console.log(`   chi phí      : ${lan?.costVnd === null || lan?.costVnd === undefined ? "CHƯA BIẾT (chưa khai đơn giá)" : `${inSo(lan.costVnd)} ₫`}   · bảng giá: ${lan?.pricingVersion || "(chưa khai)"}`);
  console.log(`   lời lỗi      : ${loi ? loi.replace(/\s+/g, " ").slice(0, 160) : "null  ✓"}`);
  if (nhom) {
    const cs = ERROR_POLICY[nhom];
    console.log(`   ─ PHÂN LOẠI (không gộp mọi thứ thành RATE_LIMIT) ─`);
    console.log(`   nhóm lỗi     : ${nhom} — ${PROVIDER_ERROR_LABEL[nhom]}`);
    console.log(`   sức khoẻ     : ${suc} — ${PROVIDER_HEALTH_LABEL[suc]}`);
    console.log(`   chính sách   : thử lại ${cs.retries} lần · ${cs.openCircuit ? "MỞ CẦU DAO" : "không mở cầu dao"} · dò lại ${cs.cooldownMs > 0 ? `sau ${Math.round(cs.cooldownMs / 60000)} phút` : "KHÔNG tự dò — người phải sửa"}`);
    console.log(`   vì sao       : ${cs.why}`);
    const moc = probeAfterFor(nhom, new Date());
    console.log(`   dò lại lúc   : ${moc ? moc.toISOString() : "—"}`);
  } else {
    console.log(`   sức khoẻ     : HEALTHY ✓`);
  }

  return { ten, tier, lan, nhom, suc, hopLuocDo: kq.tier !== "HUMAN" };
}

async function main() {
  await ensureMigrated();
  const db = await getDb();
  await ensureAgents(db);
  const settings = await getAiSettings();

  console.log("═══ DÒ SỨC KHOẺ NHÀ CUNG CẤP — CHÍNH KHOÁ VÀ CHÍNH ĐƯỜNG MÀ KHÁCH ĐI QUA ═══");
  console.log(`   thời điểm    : ${new Date().toISOString()}`);
  console.log(`   mặc định     : ${defaultProviderName()}`);
  console.log(`   đã đăng ký   : ${providerNames().join(" · ")}`);
  console.log(`   phục vụ khách: ${PHUC_VU_KHACH.length ? PHUC_VU_KHACH.join(" · ") : "(ảnh cũ — chưa khai danh sách)"}`);
  console.log(`   chỉ-ở-bóng   : ${CHI_O_BONG.length ? CHI_O_BONG.join(" · ") : "(ảnh cũ — chưa có cơ chế này)"}`);
  if (!ANH_CO_KHOA_BONG) {
    // Nói thẳng, vì im lặng ở đây biến "chưa soát được" thành "đã soát và không sao".
    console.log(`   ⚠ ẢNH ĐANG CHẠY CŨ HƠN NHÁNH NÀY: chưa có Gemini và chưa có khoá chỉ-ở-bóng.`);
    console.log(`     ⇒ P0 (OpenAI gọi được chưa) VẪN ĐO ĐƯỢC và không cần hai thứ đó.`);
    console.log(`     ⇒ Phần soát khoá Gemini (§7) CHƯA soát được ở đây — phải dựng lại ảnh trước.`);
  }
  console.log(`   gọi mô hình  : ${settings.modelCallsEnabled ? "BẬT" : "⛔ TẮT — sẽ không lượt nào đi được"}`);
  console.log(`   MÁY tự gửi   : ${aiEnv.hardLimits.allowAutoSend ? "⛔ MỞ" : "✓ CẤM"} · tạo đơn: ${aiEnv.hardLimits.allowOrderCreate ? "⛔ MỞ" : "✓ CẤM"}`);

  const chon = arg("provider");
  const tierArg = arg("tier");
  const nacs: RouteTier[] = tierArg === "STRONG" ? ["STRONG"] : tierArg === "ECONOMY" ? ["ECONOMY"] : ["ECONOMY", "STRONG"];
  const dsNha = chon ? [chon] : providerNames().filter((n) => n !== "stub");

  const agent = await getAgent("sales", settings, db);
  const ketQua: Array<{ ten: string; tier: RouteTier; lan: ModelAttempt | null; nhom: ProviderErrorKind | null; hopLuocDo: boolean }> = [];

  for (const ten of dsNha) {
    for (const nac of nacs) {
      const r = await doMot(ten, nac);
      if (r) ketQua.push(r);
    }
  }

  // ── GHI LẠI: một lượt chạy thật, để `ai_model_calls` có dòng đọc lại được ──
  // Không ghi thì lần sau không ai chứng minh được phép dò này đã chạy và thấy gì.
  const luotGhi = ketQua.filter((r) => r.lan !== null);
  if (agent && luotGhi.length) {
    const run = await startRun(
      { agentId: agent.id, agentKey: "sales", mode: "SHADOW", subjectType: "HEALTH_PROBE", subjectId: new Date().toISOString().slice(0, 19) },
      db,
    );
    await run.model(luotGhi.map((r) => r.lan as ModelAttempt));
    await run.finish({ status: luotGhi.some((r) => r.lan?.ok) ? "SUCCEEDED" : "FAILED", suggestedReply: "" });
    const dem = await db.query.aiModelCalls.findMany({ where: eq(schema.aiModelCalls.runId, run.id), orderBy: desc(schema.aiModelCalls.createdAt) });
    console.log(`\n${"─".repeat(78)}`);
    console.log(`ĐÃ GHI: lượt chạy ${run.id} · ${dem.length} dòng trong ai_model_calls ${dem.length === luotGhi.length ? "✓" : "⛔ THIẾU DÒNG"}`);
  }

  // ── KẾT LUẬN, viết theo đúng thứ đặc tả đòi ──
  const goi = ketQua.filter((r) => r.lan !== null);
  const dat = goi.filter((r) => r.lan?.ok && r.hopLuocDo);
  const hetTien = goi.filter((r) => r.nhom === "QUOTA_EXHAUSTED");
  const chanToc = goi.filter((r) => r.nhom === "RATE_LIMITED");
  console.log(`\n═══ KẾT LUẬN ═══`);
  console.log(`   đã gọi              : ${goi.length}`);
  console.log(`   đạt (gọi được + đúng lược đồ): ${dat.length}`);
  console.log(`   HẾT HẠN MỨC (429 no-credit) : ${hetTien.length} ${hetTien.length === 0 ? "✓" : "⛔"}`);
  console.log(`   bị chặn tốc độ      : ${chanToc.length}`);
  for (const r of goi) {
    console.log(`   · ${r.ten}/${r.tier}: ${r.lan?.ok && r.hopLuocDo ? "ĐẠT" : `HỎNG — ${r.nhom ?? "?"}`}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  process.exit(1);
});
