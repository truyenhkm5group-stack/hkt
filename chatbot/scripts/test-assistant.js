// Chat voi tro ly AI quan tri ngay trong terminal (khong can mo app).
// Dung: node scripts/test-assistant.js "câu lệnh 1" "câu lệnh 2" ...   (khong co tham so -> che do go tay)
import readline from "node:readline";
import { assertConfig } from "../src/config.js";
import { Bot } from "../src/bot.js";
import { createAssistant } from "../src/assistant.js";
import { catalog } from "../src/catalog.js";

assertConfig();
const bot = new Bot();
await bot.init();
if (catalog.enabled) await catalog.refresh().catch((e) => console.log("(POS loi:", e.message, ")"));
const assistant = createAssistant(bot);
let contents = [];

async function ask(q) {
  console.log("\nBan:", q);
  contents.push({ role: "user", parts: [{ text: q }] });
  const r = await assistant.chat(contents);
  contents = r.contents;
  for (const a of r.actions) console.log(`  [${a.ok ? "OK" : "LOI"}] ${a.name}(${JSON.stringify(a.args || {})})${a.ok ? "" : " -> " + a.error}`);
  console.log("Tro ly:", r.text);
}

const args = process.argv.slice(2);
if (args.length) {
  for (const q of args) await ask(q);
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const loop = () => rl.question("\nBan: ", async (q) => { if (q.trim() === "exit") return rl.close(); if (q.trim()) await ask(q).catch((e) => console.log("Loi:", e.message)); loop(); });
console.log('Tro ly AI quan tri. Go "exit" de thoat.');
loop();
