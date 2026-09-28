import { and, eq, gte, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import { LYRIA_CLIP_PRICE_USD, MUSIC_MOODS, type MusicMood } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { httpErrorKind, ProviderError } from "@/lib/video-scale/providers/types";
import { GEMINI_API_BASE } from "@/lib/video-scale/providers/veo";
import { storeAsset } from "@/lib/video-scale/storage";

/**
 * ═══════════ NHẠC NỀN GỐC BẰNG GOOGLE LYRIA ═══════════
 *
 * Vì sao không nạp "nhạc thịnh hành": các bài trend trên TikTok / Reels gần như luôn là bài hát thương mại có bản quyền — ghép
 * vào video bán hàng / quảng cáo là vi phạm, và Facebook (Rights Manager) tắt tiếng video / từ chối quảng cáo. Nên thư viện chỉ
 * nhận nhạc có quyền; phần "sẵn có" là nhạc GỐC do Lyria tạo theo PHONG CÁCH đang phổ biến, không bắt chước bài / ca sĩ nào.
 *
 * API (ai.google.dev/gemini-api/docs/music-generation + /pricing, đọc 28/09/2026): `POST /v1beta/interactions`
 * `{ model: "lyria-3-clip-preview", input, response_format: { type: "audio" } }` → đoạn 30 giây MP3 44,1 kHz, 0,04 USD / bản,
 * dùng thương mại được theo điều khoản nội dung tạo sinh, có dấu SynthID; lời nhắc tên ca sĩ / lời bài có bản quyền bị chặn.
 * Âm thanh ở `steps[type=model_output].content[type=audio].data` (base64) — đọc thêm dạng `audio_content.data`.
 */

export const LYRIA_CLIP_MODEL = "lyria-3-clip-preview";
export { LYRIA_CLIP_PRICE_USD, MUSIC_MOOD_KEYS, MUSIC_MOODS, type MusicMood } from "@/lib/constants/video-scale";
/** Trần số bản nhạc AI tạo mỗi ngày (≈ 0,80 USD) — nút bấm nhiều lần không thành một khoản chi bất ngờ. */
export const MUSIC_GEN_MAX_PER_DAY = 20;
const LICENSE_PREFIX = "Nhạc gốc tạo bằng Google Lyria";

/** Lời nhắc gửi Lyria — luôn KHÔNG LỜI, không bắt chước ai, vừa vòng lặp nền 30 giây. Hàm THUẦN. */
export function lyriaPrompt(mood: MusicMood): string {
  return `${MUSIC_MOODS[mood].prompt}. Instrumental only, no vocals. Original composition, do not imitate any existing song or artist. Background music for a 30-second vertical fashion product video, loopable ending.`;
}

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** Lấy base64 âm thanh từ phản hồi interaction — hai dạng tài liệu nêu. `null` = không có. Hàm THUẦN. */
export function lyriaAudioBase64(body: unknown): string | null {
  const b = rec(body) ?? {};
  const steps = Array.isArray(b.steps) ? b.steps : [];
  for (const raw of steps) {
    const s = rec(raw);
    if (!s || (s.type !== "model_output" && !rec(s.model_output_step))) continue;
    const content = Array.isArray(s.content) ? s.content : Array.isArray(rec(s.model_output_step)?.content) ? (rec(s.model_output_step)?.content as unknown[]) : [];
    for (const c of content) {
      const item = rec(c);
      if (!item) continue;
      if (item.type === "audio" && typeof item.data === "string" && item.data) return item.data;
      const ac = rec(item.audio_content);
      if (ac && typeof ac.data === "string" && ac.data) return ac.data;
    }
  }
  const outputs = Array.isArray(b.outputs) ? b.outputs : [];
  for (const c of outputs) {
    const item = rec(c);
    if (item?.type === "audio" && typeof item.data === "string" && item.data) return item.data;
  }
  return null;
}

export type LyriaDeps = { fetchImpl?: typeof fetch; apiKey?: string };

/** Một đoạn 30 giây MP3. Lỗi ⇒ `ProviderError` mang loại (BLOCKED thiếu khoá · PERMANENT bị từ chối · TRANSIENT mạng / 5xx). */
export async function generateLyriaClip(mood: MusicMood, deps: LyriaDeps = {}): Promise<Uint8Array> {
  await assertHomeCredentials("gemini");
  const key = deps.apiKey ?? env.gemini.apiKey;
  if (!key) throw new ProviderError("Chưa có GEMINI_API_KEY trên máy chủ ERP.", "BLOCKED");
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${GEMINI_API_BASE}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: LYRIA_CLIP_MODEL, input: lyriaPrompt(mood), response_format: { type: "audio" } }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new ProviderError(`Không nhận được phản hồi từ Lyria: ${e instanceof Error ? e.message : String(e)}`, "TRANSIENT");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = rec(rec(body)?.error)?.message;
    throw new ProviderError(`Lyria từ chối (HTTP ${res.status})${typeof msg === "string" ? `: ${msg.slice(0, 300)}` : ""}.`, httpErrorKind(res.status));
  }
  const b64 = lyriaAudioBase64(body);
  if (!b64) throw new ProviderError("Lyria trả lời nhưng không có âm thanh (có thể bị bộ lọc an toàn chặn).", "PERMANENT");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength < 1000) throw new ProviderError("Lyria trả tệp âm thanh rỗng.", "TRANSIENT");
  return bytes;
}

function vnDayStart(now: Date): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  vn.setUTCHours(0, 0, 0, 0);
  return new Date(vn.getTime() - 7 * 3_600_000);
}

/** Số bản nhạc AI đã tạo hôm nay (giờ VN) — đếm theo ghi chú quyền do máy viết. */
export async function lyriaClipsToday(db: Db, now = new Date()): Promise<number> {
  const M = schema.videoScaleMusic;
  const [r] = await db
    .select({ n: sql<string>`count(*)` })
    .from(M)
    .where(and(like(M.licenseNote, `${LICENSE_PREFIX}%`), gte(M.createdAt, vnDayStart(now))));
  return Number(r?.n ?? 0);
}

export type MusicGenResult = { created: { mood: MusicMood; id: string }[]; skipped: { mood: MusicMood; reason: string }[]; costUsd: number };

/**
 * Tạo nhạc cho các phong cách đã chọn và lưu vào thư viện (có ghi chú nguồn + quyền). `onlyMissing` ⇒ bỏ phong cách đã có bản
 * AI đang bật (job tạo sẵn chạy lại không nhân đôi). Trần `MUSIC_GEN_MAX_PER_DAY`. Một phong cách hỏng không chặn các phong cách khác.
 */
export async function generateMusicLibrary(db: Db, input: { moods: MusicMood[]; onlyMissing: boolean }, actor: Actor | null, deps: LyriaDeps = {}, now = new Date()): Promise<MusicGenResult> {
  const M = schema.videoScaleMusic;
  const out: MusicGenResult = { created: [], skipped: [], costUsd: 0 };
  let used = await lyriaClipsToday(db, now);
  for (const mood of input.moods) {
    const title = `${MUSIC_MOODS[mood].label} · AI`;
    if (input.onlyMissing) {
      const [has] = await db.select({ id: M.id }).from(M).where(and(eq(M.title, title), eq(M.active, true))).limit(1);
      if (has) {
        out.skipped.push({ mood, reason: "đã có trong thư viện" });
        continue;
      }
    }
    if (used >= MUSIC_GEN_MAX_PER_DAY) {
      out.skipped.push({ mood, reason: `chạm trần ${MUSIC_GEN_MAX_PER_DAY} bản / ngày` });
      continue;
    }
    try {
      const bytes = await generateLyriaClip(mood, deps);
      used += 1;
      out.costUsd += LYRIA_CLIP_PRICE_USD;
      const asset = await storeAsset(db, { kind: "MUSIC", bytes, contentType: "audio/mpeg" });
      const day = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
      const licenseNote = `${LICENSE_PREFIX} (${LYRIA_CLIP_MODEL}) ngày ${day} — nhạc GỐC không lời, không bắt chước bài / ca sĩ nào; Google cho phép dùng thương mại (điều khoản Gemini API); có dấu SynthID. Ước tính ${LYRIA_CLIP_PRICE_USD} USD.`;
      const [row] = await db.insert(M).values({ title, licenseNote, assetId: asset.id, uploadedByUserId: actor?.id ?? null, uploadedBy: actor?.label ?? "Máy — Lyria" }).returning({ id: M.id });
      out.created.push({ mood, id: row.id });
    } catch (e) {
      out.skipped.push({ mood, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      if (e instanceof ProviderError && e.kind === "BLOCKED") break;
    }
  }
  return out;
}
