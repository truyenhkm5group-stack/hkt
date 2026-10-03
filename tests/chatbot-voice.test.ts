/**
 * ═══════════ BOT NGHE TIN NHẮN THOẠI ═══════════
 *
 * Trước đây khách gửi ghi âm thì bot chỉ thấy "[Khách gửi 1 ghi âm]": không biết khách hỏi gì, và SĐT / địa chỉ /
 * số đo khách NÓI không bao giờ vào được đơn. `chatbot/src/voice.js` chép mỗi ghi âm của khách thành chữ MỘT lần,
 * lưu theo id tin, rồi mọi đường đọc nội dung (trả lời, hồ sơ đơn, ghi POS) dùng chung bản chép.
 *
 * Khoá ở đây:
 *   1. Nhận đúng ghi âm (kể cả tệp "audioclip-…" Pancake ghi loại video), không nhận video thật của khách.
 *   2. Chọn kiểu dữ liệu gửi Gemini theo đầu phản hồi hoặc chữ ký tệp; không nhận ra thì KHÔNG gửi.
 *   3. Chỉ chép tin của KHÁCH, mới nhất trước, tối đa N mỗi lượt; đã chép thì không chép lại; hai lượt chạy song
 *      song không chép trùng; lỗi không ném ra ngoài và không thử mãi một tệp hỏng.
 *   4. Trong luồng trả lời, chép ghi âm đứng TRƯỚC bước đọc nội dung tin cuối.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/chatbot-voice.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Msg = { id: string; from: string; attachments?: { type?: string; url?: string }[] };
type Deps = {
  enabled: boolean;
  maxClips: number;
  getText: (id: string) => string | null;
  setText: (id: string, t: string) => void;
  bumpStat: (pageId: string, k: string) => void;
  fetchAudio: (url: string) => Promise<{ mimeType: string; data: string } | null>;
  transcribe: (clip: { mimeType: string; data: string }) => Promise<string>;
};
type VoiceModule = {
  isAudioAttachment: (a: unknown) => boolean;
  audioMime: (ct: string | null, buf?: Buffer) => string;
  cleanTranscript: (t: string) => string;
  voiceLabel: (t: string | null) => string;
  hasCustomerVoice: (messages: Msg[], isCustomer: (m: Msg) => boolean) => boolean;
  transcribeVoiceMessages: (messages: Msg[], o: { pageId: string; isCustomer: (m: Msg) => boolean; deps: Deps }) => Promise<{ done: number; failed: number }>;
};

const audio = (id: string, from = "khach"): Msg => ({ id, from, attachments: [{ type: "audio", url: `https://cdn.fbsbx.com/v/audioclip-${id}.mp4` }] });

function fakeDeps(over: Partial<Deps> = {}) {
  const saved = new Map<string, string>();
  const stats: string[] = [];
  const fetched: string[] = [];
  const d: Deps = {
    enabled: true,
    maxClips: 3,
    getText: (id) => (saved.has(id) ? saved.get(id)! : null),
    setText: (id, t) => void saved.set(id, t),
    bumpStat: (_p, k) => void stats.push(k),
    fetchAudio: async (url) => {
      fetched.push(url);
      return { mimeType: "audio/mp4", data: url };
    },
    transcribe: async (clip) => `nói ${clip.data.match(/audioclip-(\w+)/)?.[1]}`,
    ...over,
  };
  return { d, saved, stats, fetched };
}

export async function testChatbotVoice() {
  const v = (await import(pathToFileURL(path.resolve("chatbot/src/voice.js")).href)) as VoiceModule;

  // 1. Nhận diện ghi âm
  assert.equal(v.isAudioAttachment({ type: "audio", url: "https://x/a.mp4" }), true);
  assert.equal(v.isAudioAttachment({ type: "video", url: "https://cdn.fbsbx.com/v/audioclip-1700000.mp4" }), true, "Facebook đặt tên tệp ghi âm audioclip-… kể cả khi loại ghi là video");
  assert.equal(v.isAudioAttachment({ type: "video", url: "https://cdn.fbsbx.com/v/clip.mp4" }), false, "video thật của khách KHÔNG đem đi chép");
  assert.equal(v.isAudioAttachment({ type: "audio" }), false, "không có URL thì không có gì để nghe");
  assert.equal(v.isAudioAttachment({ type: "audio", url: "file:///etc/passwd" }), false, "chỉ tải qua http(s)");

  // 2. Kiểu dữ liệu gửi Gemini
  assert.equal(v.audioMime("audio/mpeg"), "audio/mp3");
  assert.equal(v.audioMime("video/mp4; codecs=mp4a"), "audio/mp4", "ghi âm Messenger là AAC đóng gói MP4");
  const ftyp = Buffer.from([0, 0, 0, 0x20, ...Buffer.from("ftypM4A "), 0, 0, 0, 0]);
  assert.equal(v.audioMime("application/octet-stream", ftyp), "audio/mp4", "đầu phản hồi chung chung thì đọc chữ ký tệp");
  assert.equal(v.audioMime("", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0])), "audio/aac");
  assert.equal(v.audioMime("", Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0])), "audio/mp3");
  assert.equal(v.audioMime("text/html", Buffer.from("<!doctype html>")), "", "trang lỗi HTML không phải âm thanh ⇒ không gửi");

  // Bản chép và nhãn
  assert.equal(v.cleanTranscript('  "Chị lấy   size M\n nhé"  '), "Chị lấy size M nhé");
  assert.equal(v.voiceLabel(null), "", "chưa chép ⇒ không nhãn, messageText giữ dòng [Khách gửi 1 ghi âm] như cũ");
  assert.equal(v.voiceLabel(""), "[Khách gửi ghi âm không có lời nói]");
  assert.match(v.voiceLabel("sđt 0912345678"), /bot nghe được: "sđt 0912345678"/);
  const isCustomer = (m: Msg) => m.from === "khach";
  assert.equal(v.hasCustomerVoice([audio("p1", "page")], isCustomer), false, "ghi âm của page không gắn lời dặn");
  assert.equal(v.hasCustomerVoice([audio("k1")], isCustomer), true);

  // 3. Chọn tin: chỉ của khách, mới nhất trước, tối đa maxClips
  const msgs: Msg[] = [audio("a1"), audio("pg", "page"), { id: "t1", from: "khach" }, audio("a2"), audio("a3"), audio("a4")];
  const f = fakeDeps();
  const r1 = await v.transcribeVoiceMessages(msgs, { pageId: "P", isCustomer, deps: f.d });
  assert.deepEqual(r1, { done: 3, failed: 0 });
  assert.deepEqual([...f.saved.keys()], ["a4", "a3", "a2"], "ba ghi âm MỚI NHẤT trước; ghi âm của page không chép");
  assert.equal(f.saved.get("a4"), "nói a4");
  const r2 = await v.transcribeVoiceMessages(msgs, { pageId: "P", isCustomer, deps: f.d });
  assert.deepEqual(r2, { done: 1, failed: 0 }, "đã chép thì đọc lại từ sổ, lượt sau chỉ chép phần còn thiếu");
  assert.equal(f.fetched.length, 4, "mỗi ghi âm chỉ tải đúng một lần");
  assert.deepEqual(f.stats, ["voice", "voice", "voice", "voice"]);

  // Không chép được: không ném lỗi, đếm riêng, không thử mãi
  const hong = fakeDeps({ fetchAudio: async () => null });
  const msgsHong = [audio("h1")];
  assert.deepEqual(await v.transcribeVoiceMessages(msgsHong, { pageId: "P", isCustomer, deps: hong.d }), { done: 0, failed: 1 });
  await v.transcribeVoiceMessages(msgsHong, { pageId: "P", isCustomer, deps: hong.d });
  assert.deepEqual(await v.transcribeVoiceMessages(msgsHong, { pageId: "P", isCustomer, deps: hong.d }), { done: 0, failed: 0 }, "hai lần hỏng thì thôi, không đốt tiền mỗi lượt");
  assert.equal(hong.saved.size, 0, "hỏng ⇒ KHÔNG ghi bản chép rỗng (rỗng nghĩa là 'không có lời nói', một kết luận khác)");
  assert.deepEqual(hong.stats, ["voiceFailed", "voiceFailed"]);
  const modelLoi = fakeDeps({ transcribe: async () => { throw new Error("Gemini loi 503"); } });
  assert.deepEqual(await v.transcribeVoiceMessages([audio("g1")], { pageId: "P", isCustomer, deps: modelLoi.d }), { done: 0, failed: 1 });

  // Tắt / không khoá Gemini ⇒ không làm gì
  const tat = fakeDeps({ enabled: false });
  assert.deepEqual(await v.transcribeVoiceMessages([audio("x1")], { pageId: "P", isCustomer, deps: tat.d }), { done: 0, failed: 0 });
  assert.equal(tat.fetched.length, 0);

  // Hai lượt song song cùng một tin ⇒ chép MỘT lần
  let calls = 0;
  const song = fakeDeps({ transcribe: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return "a"; } });
  await Promise.all([
    v.transcribeVoiceMessages([audio("s1")], { pageId: "P", isCustomer, deps: song.d }),
    v.transcribeVoiceMessages([audio("s1")], { pageId: "P", isCustomer, deps: song.d }),
  ]);
  assert.equal(calls, 1, "webhook + lượt quét cùng lúc không chép (và không tính tiền) hai lần");
  assert.deepEqual(song.stats, ["voice"]);

  // 4. Thứ tự trong luồng trả lời: chép TRƯỚC khi đọc nội dung tin cuối, và lời dặn gắn vào prompt
  const bot = readFileSync("chatbot/src/bot.js", "utf8");
  const chep = bot.indexOf("await transcribeVoiceMessages(messages,");
  const doc = bot.indexOf("const lastText = this.messageText(last);");
  assert.ok(chep > 0 && doc > 0 && chep < doc, "chép ghi âm phải đứng trước bước đọc tin cuối của khách");
  assert.ok(bot.includes("systemPrompt += VOICE_PROMPT_HINT"), "có ghi âm thì dặn bot đọc lại SĐT/địa chỉ cho khách xác nhận");
  assert.match(bot, /messageText\(msg\) \{[\s\S]{0,400}store\.getVoiceText\(msg\.id\)/, "messageText đọc bản chép — mọi đường đọc nội dung dùng chung");
  const ai = readFileSync("chatbot/src/ai.js", "utf8");
  assert.match(ai, /export function generateReplyGemini[\s\S]{0,200}tally\(opts, r, "gemini"\)/, "tiền chép ghi âm vào sổ chi phí AI");

  console.log("✓ Bot nghe ghi âm: nhận đúng tệp, chọn đúng kiểu, chép tin khách mới nhất một lần, lỗi không chặn trả lời");
}

if (process.argv[1] && process.argv[1].endsWith("chatbot-voice.test.ts")) void testChatbotVoice();
