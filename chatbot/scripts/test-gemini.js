// Kiem tra API key Gemini: liet ke model + hoi thu 1 cau (co catalog POS neu da cau hinh)
import { config, assertConfig } from "../src/config.js";
import { listModels, generateReply } from "../src/gemini.js";
import { buildStandalonePrompt } from "../src/prompt.js";
import { catalog } from "../src/catalog.js";

assertConfig({ needPancake: false });

console.log("== Model kha dung voi API key nay ==");
const models = await listModels();
for (const m of models) console.log(" -", m.name.replace("models/", ""), m.displayName ? `(${m.displayName})` : "");
const has = models.some((m) => m.name === `models/${config.gemini.model}`);
console.log(`\nGEMINI_MODEL=${config.gemini.model} -> ${has ? "OK" : "KHONG co trong danh sach, hay doi GEMINI_MODEL trong .env"}`);

const systemPrompt = await buildStandalonePrompt();
console.log(`\n== Test tra loi (catalog: ${catalog.products.length} san pham) ==`);
const q = process.argv[2] || "Shop ơi cho mình hỏi phí ship bao nhiêu?";
console.log("Khach:", q);
const r = await generateReply(systemPrompt, [{ role: "user", text: q }]);
console.log("Bot:", r.text);
const refs = [...r.text.matchAll(/\[\[IMG:([^\]]+)\]\]/gi)].map((m) => m[1].trim());
for (const ref of refs) console.log(`  anh ${ref} ->`, catalog.findImages(ref).join(", ") || "(khong tim thay)");
console.log("(finishReason:", r.finishReason, "| tokens:", r.usage.totalTokenCount, ")");
