import { attachmentKind } from "./util.js";

/**
 * NGHE TIN NHAN THOAI CUA KHACH.
 *
 * Truoc day bot chi thay dong "[Khách gửi 1 ghi âm]": khong biet khach hoi gi, va SDT / dia chi / so do khach NOI
 * trong ghi am khong bao gio vao duoc don. Nay moi ghi am cua khach duoc chep thanh chu bang Gemini MOT LAN, luu
 * theo id tin (store.voiceText), roi messageText() tra ve ban chep — nen tra loi, trich SDT, ghi don POS, bam khach
 * deu doc cung mot noi dung.
 *
 * Ba luat:
 *  1. Chep KHONG duoc thi hanh vi y nhu truoc (dong "[Khách gửi 1 ghi âm]") — khong doan noi dung, khong chan tra loi.
 *  2. Ban chep la LOI KHACH DA NOI, khong phai ket luan cua may: prompt dan bot doc lai SDT/dia chi/so do lay tu ghi
 *     am cho khach xac nhan, vi may nghe nham ten dia danh va con so.
 *  3. Chi chep tin cua KHACH. Moi luot chep toi da VOICE_MAX_CLIPS ghi am moi nhat chua chep — ghi am cu da chep thi
 *     doc lai tu so, khong ton them tien.
 */

/** Tin nay co ghi am khong. Facebook dat ten tep ghi am "audioclip-…" ke ca khi Pancake ghi loai la file/video. */
export function isAudioAttachment(a) {
  if (!a || typeof a.url !== "string" || !/^https?:\/\//.test(a.url)) return false;
  return attachmentKind(a) === "audio" || /audioclip/i.test(a.url);
}

export function audioUrls(attachments) {
  return Array.isArray(attachments) ? attachments.filter(isAudioAttachment).map((a) => a.url) : [];
}

// Dinh dang Gemini doc duoc. Ghi am Messenger la AAC dong goi MP4 (tep .mp4 / .m4a).
const MIME_ALIAS = {
  "audio/mpeg": "audio/mp3",
  "audio/mp3": "audio/mp3",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/aac": "audio/aac",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/flac": "audio/flac",
  "audio/aiff": "audio/aiff",
  "audio/webm": "audio/webm",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
};

/**
 * Chon kieu du lieu gui Gemini: tin dau phan hoi neu no noi ro, khong thi doc chu ky dau tep.
 * Tra ve "" neu khong nhan ra la am thanh — khi do KHONG gui (gui bua mot tep la la ton tien de nhan mot loi).
 */
export function audioMime(contentType, buf) {
  const ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (MIME_ALIAS[ct]) return MIME_ALIAS[ct];
  if (!buf || buf.length < 12) return "";
  const ascii = (s, e) => buf.subarray(s, e).toString("latin1");
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 3) === "ID3") return "audio/mp3";
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return "audio/aac"; // ADTS (AAC tran)
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mp3"; // khung MPEG audio
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "audio/webm";
  return "";
}

/** Lam gon ban chep cua model: bo ngoac kep / khoi code bao ngoai, gop khoang trang, cat qua dai. */
export function cleanTranscript(text, max = 1500) {
  let t = String(text || "").trim();
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  t = t.replace(/^["“”']+|["“”']+$/g, "").trim();
  t = t.replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Dong chu thay cho ghi am trong lich su hoi thoai. "" (ghi am khong co loi) cung la mot ket qua that. */
export function voiceLabel(text) {
  if (text === null || text === undefined) return "";
  const t = String(text).trim();
  return t ? `[Khách gửi ghi âm, bot nghe được: "${t}"]` : "[Khách gửi ghi âm không có lời nói]";
}

export const VOICE_PROMPT_HINT = `

## TIN GHI ÂM CỦA KHÁCH
- Dòng "[Khách gửi ghi âm, bot nghe được: …]" là máy tự chép từ giọng nói của khách. Trả lời theo nội dung đó như khách đã gõ chữ, KHÔNG nhắc tới việc "nghe ghi âm".
- Máy có thể nghe nhầm tên, địa danh và con số: số điện thoại, địa chỉ, chiều cao/cân nặng lấy từ ghi âm thì phải nhắc lại cho khách xác nhận (trong bản tóm tắt đơn là đủ).
- Dòng "[Khách gửi … ghi âm]" KHÔNG có nội dung là bot chưa nghe được: xin lỗi ngắn và nhờ khách nhắn chữ giúp, TUYỆT ĐỐI không đoán khách nói gì.`;

/** Hoi thoai nay co ghi am cua khach khong (de gan VOICE_PROMPT_HINT). */
export function hasCustomerVoice(messages, isCustomer) {
  return (messages || []).some((m) => isCustomer(m) && audioUrls(m.attachments).length > 0);
}

const attempts = new Map(); // id tin -> so lan chep loi trong phien chay nay (khong thu mai mot tep hong)
const inflight = new Map(); // id tin -> Promise (hai luot cung hoi thoai khong chep trung)
const MAX_ATTEMPTS = 2;

/**
 * Chep cac ghi am CHUA chep cua khach trong `messages` (moi nhat truoc, toi da maxClips). Khong bao gio nem loi:
 * mot ghi am hong khong duoc lam khach mat cau tra loi. `deps` = voiceDeps() (voice-runtime.js) — tach ra de bai
 * kiem chay khong can mang, khong can so luu cua bot.
 * @returns {Promise<{done:number, failed:number}>}
 */
export async function transcribeVoiceMessages(messages, { pageId, isCustomer, deps: d }) {
  const out = { done: 0, failed: 0 };
  if (!d.enabled || d.maxClips <= 0) return out;
  const todo = (messages || [])
    .filter((m) => m?.id && isCustomer(m) && audioUrls(m.attachments).length && d.getText(m.id) === null)
    .filter((m) => (attempts.get(m.id) || 0) < MAX_ATTEMPTS)
    .reverse()
    .slice(0, d.maxClips);
  for (const m of todo) {
    // Hai luot cung hoi thoai chay gan nhau thi luot sau DOI ket qua luot truoc, khong chep (va khong dem) lan hai
    if (!inflight.has(m.id)) inflight.set(m.id, transcribeOne(m, pageId, d).finally(() => inflight.delete(m.id)));
    if (await inflight.get(m.id)) out.done++;
    else out.failed++;
  }
  return out;
}

async function transcribeOne(m, pageId, d) {
  try {
    const parts = [];
    for (const url of audioUrls(m.attachments)) {
      const clip = await d.fetchAudio(url);
      if (!clip) throw new Error("khong tai duoc ghi am hoac khong phai tep am thanh");
      parts.push(await d.transcribe(clip));
    }
    const text = parts.filter(Boolean).join(" / ");
    d.setText(m.id, text);
    d.bumpStat(pageId, "voice");
    d.log?.info(`[${pageId}] Ghi am ${m.id}: ${text ? `"${text.slice(0, 80)}"` : "(khong co loi noi)"}`);
    return true;
  } catch (e) {
    attempts.set(m.id, (attempts.get(m.id) || 0) + 1);
    if (attempts.size > 2000) attempts.delete(attempts.keys().next().value);
    d.bumpStat(pageId, "voiceFailed");
    d.log?.warn(`[${pageId}] Khong chep duoc ghi am ${m.id}: ${e.message}`);
    return false;
  }
}
