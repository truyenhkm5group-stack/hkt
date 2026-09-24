export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pancake tra ve `message` co the chua HTML (vd <div></div> cho tin chi co anh)
export function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Facebook gioi han ~2000 ky tu / tin. Cat theo doan van, roi theo cau.
/**
 * Tach cau tra loi thanh nhieu TIN NHAN NGAN nhu nhan vien that hay chat,
 * de khach de doc thay vi mot doan dai. Giu nguyen khoi co gach dau dong (bang bao gia).
 */
export function splitIntoBubbles(text, { max = 4, soft = 170 } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const isList = (s) => /^\s*[•\-*✅👉🔥▪️✔️]/mu.test(s);
  const out = [];
  for (const para of raw.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    // Khoi co gach dau dong (vd khoi bao gia) -> giu nguyen 1 tin
    if (isList(p) || p.length <= soft) {
      out.push(p);
      continue;
    }
    // Doan dai, khong phai danh sach -> tach theo cau
    let cur = "";
    for (const cau of p.split(/(?<=[.!?…])\s+/)) {
      if (cur && (cur + " " + cau).length > soft) {
        out.push(cur.trim());
        cur = cau;
      } else cur = cur ? cur + " " + cau : cau;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // Tin qua ngan thi nhap vao tin truoc cho tu nhien
  const gop = [];
  for (const s of out) {
    if (gop.length && s.length < 18) gop[gop.length - 1] += "\n" + s;
    else gop.push(s);
  }
  // Khong gui qua nhieu tin lien tiep
  if (gop.length > max) return [...gop.slice(0, max - 1), gop.slice(max - 1).join("\n")];
  return gop;
}

export function splitMessage(text, max = 1900) {
  const out = [];
  let rest = (text || "").trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function attachmentKind(a) {
  const t = (a?.type || a?.mime_type || "").toString().toLowerCase();
  if (t.includes("image") || t.includes("photo")) return "image";
  if (t.includes("video")) return "video";
  if (t.includes("audio")) return "audio";
  if (t.includes("sticker")) return "sticker";
  if (t.includes("file") || t.includes("document")) return "file";
  if (t.includes("template")) return "template";
  if (t.includes("system")) return "system";
  return t || "other";
}

const KIND_VI = { image: "hình ảnh", video: "video", audio: "ghi âm", sticker: "sticker", file: "tệp tin", template: "tin nhắn mẫu", system: "thông báo hệ thống", other: "tệp đính kèm" };

export function describeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const shown = attachments.filter((a) => attachmentKind(a) !== "system");
  if (shown.length === 0) return "";
  const counts = {};
  for (const a of shown) {
    const k = attachmentKind(a);
    counts[k] = (counts[k] || 0) + 1;
  }
  const desc = Object.entries(counts).map(([k, n]) => `${n} ${KIND_VI[k] || k}`).join(", ");
  return `[Khách gửi ${desc}]`;
}

/** URL anh cua cac attachment dang photo/image trong 1 tin */
export function imageUrls(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => attachmentKind(a) === "image" && typeof a.url === "string" && /^https?:\/\//.test(a.url))
    .map((a) => a.url);
}

// Cache anh da tai (URL -> {mimeType, data}) de khong tai lai moi lan khach nhan tiep
const imageCache = new Map();
const IMAGE_CACHE_MAX = 200;

/** Tai anh ve dang base64 de gui Gemini. Tra ve null neu loi / qua lon / khong phai anh */
export async function fetchImageAsBase64(url, { maxBytes = 5 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  if (imageCache.has(url)) return imageCache.get(url);
  let result = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const len = Number(res.headers.get("content-length") || 0);
      if (!len || len <= maxBytes) {
        const buf = Buffer.from(await res.arrayBuffer());
        let mimeType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!mimeType.startsWith("image/")) mimeType = sniffImageMime(buf);
        if (buf.length <= maxBytes && mimeType) {
          result = { mimeType, data: buf.toString("base64") };
        }
      }
    }
  } catch {
    result = null;
  }
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(url, result);
  return result;
}

function sniffImageMime(buf) {
  if (buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

// Pancake tra inserted_at dang "2024-12-25T11:06:07.000000" (UTC, khong co Z)
export function parseTs(s) {
  if (!s) return 0;
  if (typeof s === "number") return s < 1e12 ? s * 1000 : s;
  const str = String(s);
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(str);
  const t = Date.parse(hasTz ? str : str + "Z");
  return Number.isFinite(t) ? t : 0;
}

// Gemini hay tra markdown du da dan; Messenger hien thi van ban thuan -> don sach
export function stripMarkdown(s) {
  if (!s) return "";
  return String(s)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ 	]*[*\-•][ 	]+/gm, "• ")
    .replace(/^[ 	]*(\d+)\.[ 	]+/gm, "$1. ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pancake tra messages theo cua so 30 tin moi nhat nhung THU TU KHONG on dinh (thuc te: cu -> moi, tai lieu noi nguoc lai).
// Luon sap xep lai theo thoi gian de tin cuoi mang chac chan la tin moi nhat.
export function sortChrono(messages) {
  return [...(messages || [])].sort((a, b) => parseTs(a.inserted_at) - parseTs(b.inserted_at));
}
