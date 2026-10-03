import { config } from "./config.js";
import { generateReplyGemini } from "./ai.js";
import { log } from "./logger.js";
import { store } from "./store.js";
import { audioMime, cleanTranscript } from "./voice.js";

/** Phan cham mang + so luu cua voice.js: tai ghi am, goi Gemini, doc/ghi ban chep. */

const TRANSCRIBE_SYSTEM = `Bạn chép lại lời nói trong đoạn ghi âm khách gửi cho một shop bán quần áo online ở Việt Nam.
- Chép NGUYÊN VĂN, đúng ý người nói. Không tóm tắt, không thêm lời, không trả lời khách, không giải thích.
- Số điện thoại, chiều cao, cân nặng, giá tiền, số nhà viết bằng CHỮ SỐ (vd: 0912345678, 1m58, 52kg, 499k).
- Chỗ không nghe rõ ghi [không rõ]. Không có lời nói thì trả về chuỗi rỗng.`;

/** Tai ghi am. Tra ve null neu loi / qua lon / khong phai am thanh. */
async function fetchAudio(url, { maxBytes, timeoutMs = 20000 }) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const mimeType = audioMime(res.headers.get("content-type"), buf);
    return mimeType ? { mimeType, data: buf.toString("base64") } : null;
  } catch {
    return null;
  }
}

async function transcribeWithGemini(clip) {
  const ask = (mimeType) =>
    generateReplyGemini(TRANSCRIBE_SYSTEM, [{ role: "user", text: "Chép lại đoạn ghi âm này.", images: [{ mimeType, data: clip.data }] }], {
      model: config.voice.model || undefined,
      temperature: 0,
      maxOutputTokens: 1024,
    });
  let r;
  try {
    r = await ask(clip.mimeType);
  } catch (e) {
    // Tep MP4 chi co tieng: neu API khong nhan "audio/mp4" thi thu dung tep do duoi dang video (Gemini doc ca tieng cua video)
    if (clip.mimeType !== "audio/mp4" || !/\b400\b|mime|unsupported/i.test(e.message || "")) throw e;
    r = await ask("video/mp4");
  }
  if (!r || (r.finishReason !== "STOP" && !r.text)) throw new Error(`Gemini khong chep duoc ghi am (${r?.finishReason || "?"})`);
  return cleanTranscript(r.text);
}

export function voiceDeps() {
  return {
    enabled: config.voice.enabled && Boolean(config.gemini.apiKey),
    maxClips: config.voice.maxClips,
    getText: (id) => store.getVoiceText(id),
    setText: (id, t) => store.setVoiceText(id, t),
    bumpStat: (pageId, k) => store.bumpStat(pageId, k),
    fetchAudio: (url) => fetchAudio(url, { maxBytes: config.voice.maxBytes }),
    transcribe: transcribeWithGemini,
    log,
  };
}
