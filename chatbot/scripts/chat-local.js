// Chat thu voi bot ngay trong terminal (chi can GEMINI_API_KEY) de chinh prompts/system.md
// Gui anh: go  /img <duong-dan-file-hoac-URL> [cau hoi]
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { assertConfig, config } from "../src/config.js";
import { buildStandalonePrompt } from "../src/prompt.js";
import { generateReply } from "../src/ai.js";
import { HANDOFF } from "../src/bot.js";
import { fetchImageAsBase64 } from "../src/util.js";
import { catalog } from "../src/catalog.js";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
async function loadImage(src) {
  if (/^https?:\/\//.test(src)) return fetchImageAsBase64(src);
  const file = path.resolve(src);
  if (!fs.existsSync(file)) return null;
  return { mimeType: MIME[path.extname(file).toLowerCase()] || "image/jpeg", data: fs.readFileSync(file).toString("base64") };
}

assertConfig({ needPancake: false });
const systemPrompt = await buildStandalonePrompt();
if (catalog.enabled) console.log(`(POS: ${catalog.products.length} san pham)`);
const history = [];

console.log(`Chat thu voi bot (model ${config.gemini.model}). Go "exit" de thoat, "reset" de xoa lich su, "/img <file|url> [cau hoi]" de gui anh.\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = () =>
  rl.question("Khach: ", async (line) => {
    const q = line.trim();
    if (!q) return ask();
    if (q === "exit") return rl.close();
    if (q === "reset") {
      history.length = 0;
      console.log("(da xoa lich su)\n");
      return ask();
    }
    if (q.startsWith("/img ")) {
      const [src, ...rest] = q.slice(5).trim().split(/\s+/);
      const img = await loadImage(src);
      if (!img) {
        console.log("Khong doc duoc anh:", src, "\n");
        return ask();
      }
      history.push({ role: "user", text: rest.join(" ") || "[Khách gửi 1 hình ảnh]", images: [img] });
    } else {
      history.push({ role: "user", text: q });
    }
    try {
      const r = await generateReply(systemPrompt, history);
      let text = r.text;
      const handoff = text.includes(HANDOFF);
      text = text.replaceAll(HANDOFF, "").trim();
      const imgs = [];
      text = text
        .replace(/\[\[IMG:([^\]]+)\]\]/gi, (_, ref) => {
          imgs.push(`${ref.trim()} -> ${catalog.findImages(ref.trim()).join(", ") || "(khong tim thay)"}`);
          return "";
        })
        .trim();
      history.push({ role: "model", text });
      console.log(
        `Bot:   ${text}${imgs.length ? "\n       >>> gui anh: " + imgs.join(" | ") : ""}${handoff ? "\n       >>> [HANDOFF] chuyen nhan vien + gan tag" : ""}\n`
      );
    } catch (e) {
      console.error("Loi:", e.message);
    }
    ask();
  });
ask();
