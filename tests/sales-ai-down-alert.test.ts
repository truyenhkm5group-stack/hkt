import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { salesBotError } from "@/lib/sales-chatbot/config";

/**
 * ═══════════ SỰ CỐ P0 06/10/2026 — AI HẾT TIỀN, BOT IM, MÁY NGỪNG GHI ĐƠN ~2 GIỜ ═══════════
 *
 * Tài khoản trả trước Google AI Studio cạn lúc 11:38 (giờ VN); mọi lượt gọi Gemini nhận «Your prepayment credits are depleted».
 * Hai điều phải đúng để lần sau người trực biết trong vài phút, không phải hai giờ:
 *   1. câu lỗi THẬT của Google được xếp lớp CREDIT (lớp không tự khỏi ⇒ có báo người), không phải OTHER / RATE_LIMIT;
 *   2. cảnh báo «Chatbot ngừng trả lời khách» đi cả vào NHÓM VẬN HÀNH (nơi nhân viên đang nhìn), không chỉ chuông ERP.
 */

export function testSalesAiDownAlert() {
  const that = "Gemini trả lỗi HTTP 429: Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.";
  for (const msg of [that, that.replace("429", "403"), that.replace("429", "400")]) {
    const e = salesBotError(msg);
    assert.equal(e?.kind, "CREDIT", `câu lỗi thật của Google hôm nay phải là CREDIT (có báo người): ${msg.slice(0, 40)}`);
    assert.equal(e?.notify, true);
  }
  assert.equal(salesBotError("Gemini trả lỗi HTTP 503: The model is overloaded")?.notify, false, "quá tải tự khỏi ⇒ không báo (chỉ đổ nhiễu)");

  const src = readFileSync(path.join(__dirname, "..", "lib", "sales-chatbot", "alerts.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function notifySalesChatAiDown("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(body.includes("operationsGroupChannel()") && body.includes("deliverMessage(") && body.includes('event: "sales_chat.ai_down"'), "AI ngừng ⇒ một tin vào nhóm vận hành");
  assert.ok(/dedupeKey: `\$\{dedupe\}:group`/.test(body), "nhóm nhận MỘT tin mỗi lý do mỗi ngày (cùng khoá với chuông) — không một tin mỗi khách");
  assert.ok(!body.includes("handoffNotifiesGroup"), "không bị công tắc «báo nhóm khi chuyển người» (chủ shop tắt) chặn — đây là sự cố cả shop");
  console.log("✓ AI bán hàng ngừng: câu «prepayment credits are depleted» là CREDIT · báo nhóm vận hành một tin mỗi lý do mỗi ngày");
}

if (/sales-ai-down-alert\.test\.ts$/.test(process.argv[1] ?? "")) testSalesAiDownAlert();
