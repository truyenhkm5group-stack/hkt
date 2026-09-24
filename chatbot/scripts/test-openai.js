// Kiem tra ket noi OpenAI (ChatGPT): in danh sach model dung duoc va tra loi thu 1 cau.
// Chay: node scripts/test-openai.js   (can OPENAI_API_KEY trong .env; khong can AI_PROVIDER=openai)
process.env.AI_PROVIDER = "openai";
const { config } = await import("../src/config.js");
const { listModels, generateReply } = await import("../src/openai.js");

if (!config.openai.apiKey) {
  console.error("Chua co OPENAI_API_KEY trong .env");
  process.exit(1);
}
console.log("Model cau hinh (OPENAI_MODEL):", config.openai.model);
try {
  const models = await listModels();
  console.log("Model dung duoc:", models.map((m) => m.name).join(", "));
  if (!models.some((m) => m.name === config.openai.model)) console.warn(`CANH BAO: OPENAI_MODEL=${config.openai.model} KHONG co trong danh sach`);
} catch (e) {
  console.error("Khong liet ke duoc model:", e.message);
}
const t0 = Date.now();
const r = await generateReply("Bạn là nhân viên tư vấn thời trang, trả lời ngắn bằng tiếng Việt.", [{ role: "user", text: "Chào shop, đầm này có size XL không?" }], { maxOutputTokens: 200 });
console.log(`\nTra loi (${Date.now() - t0}ms, ${r.usage.totalTokenCount ?? "?"} token):\n${r.text}`);
