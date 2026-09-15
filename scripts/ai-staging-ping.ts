/**
 * THỬ KẾT NỐI AI TRONG BẢN CHẠY THỬ — CHỈ IN META.
 *
 * Log của GitHub Actions là CÔNG KHAI. Không in: khoá API, câu trả lời của mô hình (có thể chứa
 * tên / SĐT khách), nội dung tin nhắn. Chỉ in: nhà cung cấp, tên mô hình, độ trễ, token, và trạng
 * thái các chặn cứng.
 *
 * Kiểm CẢ HAI đường, vì nhân sự bán hàng đi đường thứ hai:
 *   ① lớp AI của ERP  (`lib/ai/provider.ts`)        — đường AI Copilot đang dùng
 *   ② cầu nối nhân sự (`providers/erp-shared.ts`)   — đường Sales Agent dùng, phải ra cùng khoá
 */
import "dotenv/config";
import { getAiProvider } from "@/lib/ai/provider";
import { aiDisabledReason, modelFor, resolveProviderName } from "@/lib/ai/router";
import { aiEnv } from "@/lib/ai-workforce/config";
import { defaultProviderName, getProvider } from "@/lib/ai-workforce/providers";

async function main() {
  console.log("\n① LỚP AI CỦA ERP");
  const nha = resolveProviderName();
  if (!nha) {
    console.log(`   ✗ chưa cấu hình: ${aiDisabledReason()}`);
  } else {
    console.log(`   nhà cung cấp ${nha} · routine ${modelFor(nha, "routine")} · copilot ${modelFor(nha, "copilot")}`);
    const p = getAiProvider("routine");
    if (!p) {
      console.log("   ✗ không dựng được provider");
    } else {
      const t0 = Date.now();
      const res = await p.complete({ system: "Trả lời đúng một từ: OK", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
      const chu = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      console.log(`   ✓ ping ${res.model} sau ${Date.now() - t0} ms · token in ${res.usage.inputTokens} (đệm ${res.usage.cacheReadTokens}) out ${res.usage.outputTokens} · trả lời ${chu.length} ký tự`);
    }
  }

  console.log("\n② CẦU NỐI CỦA NHÂN SỰ BÁN HÀNG");
  const ten = defaultProviderName();
  console.log(`   nhà cung cấp mặc định: ${ten}`);
  const wf = getProvider(ten);
  if (!wf) {
    console.log("   ✗ không có nhà cung cấp nào tên đó");
  } else if (!wf.available()) {
    console.log(`   ✗ "${ten}" chưa đủ cấu hình để gọi thật`);
  } else {
    console.log(`   ECONOMY → ${wf.defaultModel("ECONOMY") || "(không phục vụ nấc này)"}`);
    console.log(`   STRONG  → ${wf.defaultModel("STRONG") || "(không phục vụ nấc này)"}`);
    if (ten === "stub") {
      console.log("   (stub = KHÔNG gọi mạng — đúng khi chưa muốn bật mô hình thật)");
    } else {
      const t0 = Date.now();
      const r = await wf.complete({
        model: wf.defaultModel("ECONOMY"),
        system: 'Trả về đúng JSON {"ok":true}',
        messages: [{ role: "user", content: "ping" }],
        maxOutputTokens: 32,
        timeoutMs: 20_000,
        json: true,
      });
      console.log(`   ✓ ping qua cầu nối · ${r.provider} · ${r.model} · ${Date.now() - t0} ms · token in ${r.inputTokens} (đệm ${r.cacheReadInputTokens}) out ${r.outputTokens} · trả lời ${r.text.length} ký tự`);
    }
  }

  console.log("\n③ CHẶN CỨNG (phải giữ nguyên kể cả khi mô hình thật đã bật)");
  console.log(`   nấc mặc định        : ${aiEnv.defaultMode}`);
  console.log(`   MÁY tự gửi tin      : ${aiEnv.hardLimits.allowAutoSend ? "⛔ ĐANG MỞ" : "✓ CẤM"}`);
  console.log(`   NGƯỜI bấm gửi tin   : ${aiEnv.hardLimits.allowHumanApprovedSend ? "ĐANG MỞ (nấc COPILOT)" : "✓ CẤM"}`);
  // DANH SÁCH TRẮNG HỘI THOẠI KIỂM THỬ — không phải bí mật, và là thứ quyết định "có hội thoại nội
  // bộ nào để thử gửi một tin không". Rỗng nghĩa là KHÔNG CÓ, và khi đó không được thử gửi gì cả.
  const dsThu = aiEnv.testConversationIds;
  console.log(`   hội thoại kiểm thử  : ${dsThu.length ? dsThu.join(", ") : "(RỖNG — chưa khai hội thoại nội bộ nào)"}`);
  console.log(`   tạo đơn             : ${aiEnv.hardLimits.allowOrderCreate ? "⛔ ĐANG MỞ" : "✓ CẤM"}`);
  console.log(`   cho gọi mô hình thật: ${aiEnv.modelCallsEnabled ? "CÓ" : "KHÔNG"}`);
  process.exit(0);
}

main().catch((e) => {
  // In LOẠI lỗi và câu mô tả, không in thân phản hồi — nó có thể mang lại khoá trong header echo.
  console.error(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  process.exit(1);
});
