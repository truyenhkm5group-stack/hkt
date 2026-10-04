/**
 * BOT ĐỌC ẢNH KHÁCH GỬI (0195 · lib/sales-chatbot/vision.ts) — phần THUẦN và phần gửi ảnh cho từng nhà cung cấp.
 * Không gọi mạng (luật 65): mọi `fetch` là giả.
 *
 *  1. Tin Pancake ⇒ đúng ảnh: nhận `photo` / `image`, KHÔNG nhận nhãn dán / ghi âm / video; trùng ⇒ một; tối đa 3.
 *  2. Chỉ tải từ CDN ảnh Facebook / Pancake (chặn SSRF): http, tên miền lạ, tên miền giả đuôi, cổng lạ, userinfo ⇒ không.
 *  3. Kiểu ảnh theo CHỮ KÝ tệp, không theo đầu phản hồi; quá trần dung lượng ⇒ bỏ; chuyển hướng sang tên miền lạ ⇒ bỏ.
 *  4. Ảnh tới ĐÚNG tin user cuối ở cả ba nhà cung cấp (Anthropic · OpenAI · Gemini); không ảnh ⇒ yêu cầu y như trước.
 *  5. Dòng chữ đưa vào lượt: có mô tả ⇒ «[Khách gửi ảnh: …]»; không ⇒ nói thẳng «bot chưa xem được ảnh», không bịa.
 */
import assert from "node:assert/strict";
import { anthropicImageBlocks, geminiImageParts, lastUserIndex, openAiImageParts } from "@/lib/ai/images";
import { ByokGeminiProvider, toGeminiContents } from "@/lib/ai-builder/providers";
import type { AiMessage } from "@/lib/ai/provider";
import { allowedImageUrl, fetchCustomerImage, imageLine, pancakeImageUrls, sniffImageMime, VISION_LIMITS } from "@/lib/sales-chatbot/vision";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function testPancakeImages() {
  const att = (list: unknown[]) => pancakeImageUrls({ attachments: list });
  assert.deepEqual(att([{ type: "photo", url: "https://scontent.xx.fbcdn.net/a.jpg" }]), ["https://scontent.xx.fbcdn.net/a.jpg"]);
  assert.deepEqual(att([{ type: "image", payload: { url: "https://cdn.fbsbx.com/b.png" } }]), ["https://cdn.fbsbx.com/b.png"], "địa chỉ trong payload");
  assert.deepEqual(att([{ image_data: { width: 1 }, url: "https://content.pancake.vn/c" }]), ["https://content.pancake.vn/c"], "không khai loại mà có image_data");
  assert.deepEqual(att([{ type: "sticker", url: "https://scontent.xx.fbcdn.net/s.png" }, { url: "https://scontent.xx.fbcdn.net/s2.png", sticker_id: 369239263222822 }]), [], "nhãn dán (👍) không phải ảnh để đọc");
  assert.deepEqual(att([{ type: "audio", url: "https://cdn.fbsbx.com/audioclip-1.mp4" }, { type: "video", url: "https://video.xx.fbcdn.net/v.mp4" }, { type: "file", url: "https://cdn.fbsbx.com/x.pdf" }]), [], "ghi âm / video / tệp ⇒ không");
  const many = Array.from({ length: 6 }, (_, i) => ({ type: "photo", url: `https://scontent.xx.fbcdn.net/${i}.jpg` }));
  assert.equal(att([...many, many[0]]).length, VISION_LIMITS.imagesPerTurn, "tối đa 3 ảnh mỗi tin");
  assert.deepEqual(att([many[0], many[0]]), [many[0].url], "trùng ⇒ một");
  assert.deepEqual(pancakeImageUrls(null), []);
  assert.deepEqual(pancakeImageUrls({ attachments: "x" }), []);
}

function testAllowedHosts() {
  assert.ok(allowedImageUrl("https://scontent.fhan2-3.fna.fbcdn.net/v/t1.15752-9/a.jpg?_nc=1"));
  assert.ok(allowedImageUrl("https://content.pancake.vn/2/s960x960/a.jpg"));
  assert.ok(allowedImageUrl("https://pages.fm/x.png"));
  assert.ok(!allowedImageUrl("http://scontent.xx.fbcdn.net/a.jpg"), "http ⇒ không");
  assert.ok(!allowedImageUrl("https://fbcdn.net.attacker.com/a.jpg"), "tên miền giả đuôi ⇒ không");
  assert.ok(!allowedImageUrl("https://evilfbcdn.net/a.jpg"), "không phải tên miền con ⇒ không");
  assert.ok(!allowedImageUrl("https://scontent.xx.fbcdn.net:8443/a.jpg"), "cổng lạ ⇒ không");
  assert.ok(!allowedImageUrl("https://user:pw@scontent.xx.fbcdn.net/a.jpg"), "userinfo ⇒ không");
  assert.ok(!allowedImageUrl("https://169.254.169.254/latest/meta-data"), "địa chỉ nội bộ ⇒ không");
  assert.ok(!allowedImageUrl("không phải url"));
}

async function testFetchImage() {
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(WEBP), "image/webp");
  assert.equal(sniffImageMime(GIF), "image/gif");
  assert.equal(sniffImageMime(new TextEncoder().encode("<html>")), null, "HTML không phải ảnh");
  const hits: string[] = [];
  const f = (routes: Record<string, () => Response>) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      hits.push(url);
      return routes[url]?.() ?? new Response("không có", { status: 404 });
    }) as typeof fetch;
  const ok = await fetchCustomerImage("https://scontent.xx.fbcdn.net/a.jpg", f({ "https://scontent.xx.fbcdn.net/a.jpg": () => new Response(JPEG, { headers: { "content-type": "text/html" } }) }));
  assert.ok(ok?.mimeType === "image/jpeg" && ok.data === Buffer.from(JPEG).toString("base64"), "kiểu theo chữ ký tệp, không theo đầu phản hồi");
  assert.equal(await fetchCustomerImage("https://scontent.xx.fbcdn.net/h", f({ "https://scontent.xx.fbcdn.net/h": () => new Response("<html>", { headers: { "content-type": "image/jpeg" } }) })), null, "đầu phản hồi nói ảnh mà nội dung là HTML ⇒ bỏ");
  const big = new Uint8Array(VISION_LIMITS.maxBytes + 10);
  big.set(JPEG);
  assert.equal(await fetchCustomerImage("https://scontent.xx.fbcdn.net/big", f({ "https://scontent.xx.fbcdn.net/big": () => new Response(big) })), null, "quá trần dung lượng ⇒ bỏ");
  hits.length = 0;
  const redirected = await fetchCustomerImage("https://scontent.xx.fbcdn.net/r", f({ "https://scontent.xx.fbcdn.net/r": () => new Response(null, { status: 302, headers: { location: "https://evil.example/a.jpg" } }) }));
  assert.ok(redirected === null && !hits.some((h) => h.includes("evil.example")), "chuyển hướng ra tên miền lạ ⇒ KHÔNG đi theo");
  const hop = await fetchCustomerImage(
    "https://scontent.xx.fbcdn.net/r2",
    f({ "https://scontent.xx.fbcdn.net/r2": () => new Response(null, { status: 302, headers: { location: "https://cdn.fbsbx.com/p.png" } }), "https://cdn.fbsbx.com/p.png": () => new Response(PNG) }),
  );
  assert.equal(hop?.mimeType, "image/png", "chuyển hướng trong danh sách ⇒ đi theo");
  hits.length = 0;
  assert.equal(await fetchCustomerImage("https://evil.example/a.jpg", f({})), null);
  assert.equal(hits.length, 0, "tên miền lạ ⇒ không gửi một request nào");
  assert.equal(await fetchCustomerImage("https://scontent.xx.fbcdn.net/x", (async () => { throw new Error("mạng"); }) as typeof fetch), null, "lỗi mạng ⇒ null, không ném");
}

async function testProviderSerialization() {
  const img = { mimeType: "image/jpeg" as const, data: "QUJD" };
  const msgs: AiMessage[] = [
    { role: "user", content: [{ type: "text", text: "câu 1" }] },
    { role: "assistant", content: [{ type: "text", text: "đáp" }] },
    { role: "user", content: [{ type: "text", text: "câu 2" }] },
  ];
  assert.equal(lastUserIndex(msgs), 2);
  assert.equal(lastUserIndex([{ role: "assistant", content: [] }]), -1);
  assert.deepEqual(anthropicImageBlocks([img]), [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }]);
  assert.deepEqual(openAiImageParts([img]), [{ type: "input_image", image_url: "data:image/jpeg;base64,QUJD", detail: "low" }]);
  assert.deepEqual(geminiImageParts([img]), [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }]);
  const g = toGeminiContents(msgs, [img]);
  assert.deepEqual(g[2].parts, [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }, { text: "câu 2" }], "ảnh vào ĐÚNG tin user cuối, trước chữ");
  assert.ok(!JSON.stringify(g.slice(0, 2)).includes("inlineData"), "tin cũ không mang ảnh");
  assert.deepEqual(toGeminiContents(msgs), toGeminiContents(msgs, []), "không ảnh ⇒ y như trước");
  // Gemini thật (fetch giả): thân yêu cầu mang inlineData.
  let body = "";
  const gem = new ByokGeminiProvider({
    apiKey: "khoa-gia",
    model: "gemini-3.5-flash-lite",
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Áo sơ mi trắng" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 8 } }), { status: 200 });
    }) as typeof fetch,
  });
  const res = await gem.complete({ system: "mô tả", messages: [{ role: "user", content: [{ type: "text", text: "Khách vừa gửi ảnh này." }] }], tools: [], images: [img] });
  assert.ok(body.includes('"inlineData":{"mimeType":"image/jpeg","data":"QUJD"}') && res.content[0]?.type === "text", body.slice(0, 200));
}

function testImageLine() {
  assert.equal(imageLine(1, "Áo sơ mi trắng cổ tàu"), "[Khách gửi ảnh: Áo sơ mi trắng cổ tàu]");
  assert.equal(imageLine(2, "Hai mẫu váy"), "[Khách gửi 2 ảnh: Hai mẫu váy]");
  assert.equal(imageLine(1, null), "[Khách gửi ảnh — bot chưa xem được ảnh]");
  assert.equal(imageLine(3, "   "), "[Khách gửi 3 ảnh — bot chưa xem được ảnh]", "mô tả rỗng ⇒ không bịa");
  assert.equal(imageLine(1, "a [b] c"), "[Khách gửi ảnh: a b c]", "ngoặc vuông trong mô tả không làm vỡ dòng");
}

export async function testSalesVision() {
  testPancakeImages();
  testAllowedHosts();
  await testFetchImage();
  await testProviderSerialization();
  testImageLine();
  console.log("✓ Bot đọc ảnh: đúng ảnh trong tin Pancake (không nhãn dán / ghi âm / video), chỉ tải từ CDN Facebook / Pancake (chặn SSRF, kể cả qua chuyển hướng), kiểu theo chữ ký tệp, trần dung lượng; ảnh tới đúng tin user cuối ở Anthropic / OpenAI / Gemini; không đọc được ⇒ nói thẳng, không bịa");
}
