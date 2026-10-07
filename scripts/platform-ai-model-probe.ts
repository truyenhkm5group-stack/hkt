/*
  ops `platform-ai-model-probe` — KHOÁ AI DÙNG CHUNG (`PLATFORM_AI_API_KEY`) CÓ GỌI ĐƯỢC MODEL NÀY KHÔNG.
  MẶC ĐỊNH CHỈ ĐỌC; `--apply=<%>` / `--rollback` mới ghi chính sách model (Platform AI Policy).

  Vì sao có (06/10/2026): muốn hạ chi phí AI Sales Agent của SaaS bằng cách chuyển AI dùng chung từ `gemini-3.5-flash-lite`
  (0,30 / 2,50 USD mỗi 1M token) sang `gemini-2.5-flash-lite` (0,10 / 0,40). Nhưng 02/10/2026 khoá Gemini MỚI của HSLC nhận
  404 «no longer available to new users» với 2.5 — nên trước khi đổi production phải hỏi ĐÚNG khoá nền tảng, ở ĐÚNG máy chủ
  (khoá chỉ nằm trong `.env` của VPS). Mỗi model MỘT lời gọi `generateContent` một chữ, `maxOutputTokens` 8 — cùng hàm với
  nút «Kiểm tra khả dụng» ở /platform/saas (`lib/ai-usage/platform-model-probe.ts`), không có luật thứ hai.

  Không in khoá: chỉ in phán quyết, mã HTTP, độ trễ và câu lỗi của Google ĐÃ che khoá + che dãy số dài (số project).

  arg (mặc định CHỈ ĐỌC — không đổi model, không lưu, không nhật ký):
    `[model …]`                      — trống ⇒ `gemini-2.5-flash-lite gemini-3.5-flash-lite`
  arg GHI (cùng lõi với nút trên màn hình, nhật ký nguồn SCRIPT; model chính được kiểm lại NGAY trước khi ghi):
    `--apply=<1-100> <model>`        — chạy thử (< 100) / áp dụng (100) `<model>`; dự phòng = model đang chạy
    `--rollback`                     — hoàn tác về bản trước (không có ⇒ tắt chính sách ⇒ model của biến môi trường)
*/
import "dotenv/config";
import { applyPlatformAiPolicyAsScript, probeWithPlatformKey, rollbackPlatformAiPolicyAsScript, SCRIPT_WRITER_LABEL } from "@/lib/ai-usage/platform-ai-admin";
import { readPlatformAiPolicy } from "@/lib/ai-usage/platform-ai-policy";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const DEFAULT_MODELS = ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite"];
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,60}$/;

async function printPolicy() {
  const p = await readPlatformAiPolicy({ fresh: true });
  tomTat(p ? `chính sách: ${p.enabled ? "BẬT" : "TẮT"} · ${p.primaryModel} ở ${p.canaryPct}% · dự phòng ${p.fallbackModel ?? "(biến môi trường)"} · từ ${p.effectiveFrom} · bởi ${p.changedBy === SCRIPT_WRITER_LABEL ? "ops" : "người vận hành (xem nhật ký nền tảng)"}` : "chính sách: (chưa có) ⇒ model của biến môi trường");
}

async function main() {
  const argv = process.argv.slice(2).join(" ").split(/\s+/).filter(Boolean);
  const flags = argv.filter((a) => a.startsWith("--"));
  const models = argv.filter((a) => !a.startsWith("--"));
  for (const m of models) {
    if (!MODEL_RE.test(m)) {
      tomTat("model không hợp lệ (chỉ chữ thường, số, . -) — dừng");
      process.exit(64);
    }
  }
  const apply = flags.find((f) => f.startsWith("--apply="));
  if (flags.includes("--rollback")) {
    const r = await rollbackPlatformAiPolicyAsScript({ reason: "Hoàn tác qua ops platform-ai-model-probe" });
    tomTat("error" in r ? `HOÀN TÁC KHÔNG CHẠY: ${r.error}` : r.message);
    await printPolicy();
    process.exit("error" in r ? 1 : 0);
  }
  if (apply) {
    const pct = Number(apply.slice("--apply=".length));
    if (!Number.isInteger(pct) || pct < 1 || pct > 100 || models.length !== 1) {
      tomTat("--apply=<1-100> cần ĐÚNG MỘT model — dừng, không ghi gì");
      process.exit(64);
    }
    const r = await applyPlatformAiPolicyAsScript({ primaryModel: models[0], canaryPct: pct, reason: `Ops: ${pct >= 100 ? "áp dụng" : `chạy thử ${pct}%`} ${models[0]} — giảm chi phí AI dùng chung` });
    tomTat("error" in r ? `KHÔNG ĐỔI PRODUCTION: ${r.error}` : `${r.message} (kiểm khả dụng ngay trước khi ghi: ${r.verdict})`);
    await printPolicy();
    process.exit("error" in r ? 1 : 0);
  }
  const list = models.length ? models : DEFAULT_MODELS;
  const r = await probeWithPlatformKey(list);
  if (!r.ready) {
    tomTat(`KHOÁ NỀN TẢNG CHƯA SẴN SÀNG: ${r.reason}`);
    process.exit(2);
  }
  tomTat(`provider=${r.provider} · model của biến môi trường (PLATFORM_AI_MODEL / mặc định)=${r.baseModel} · số model kiểm=${list.length}`);
  for (const x of r.results) {
    const msg = (x.message ?? "").replace(/\d{6,}/g, "#");
    tomTat(`${x.model} ⇒ ${x.verdict} · HTTP ${x.httpStatus ?? "—"} · ${x.latencyMs} ms${x.modelVersion ? ` · modelVersion=${x.modelVersion}` : ""}${msg ? ` · «${msg}»` : ""}`);
  }
  const ok = r.results.filter((x) => x.verdict === "AVAILABLE").map((x) => x.model);
  tomTat(`KẾT LUẬN: dùng được = ${ok.length ? ok.join(", ") : "(không model nào)"}`);
  await printPolicy();
}

main().catch((error) => {
  tomTat(`LỖI: ${(error instanceof Error ? error.message : String(error)).replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza…")}`);
  process.exit(1);
});
