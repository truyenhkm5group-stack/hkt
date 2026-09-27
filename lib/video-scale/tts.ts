import { schema, type Db } from "@/db";
import { TTS_MODEL } from "@/lib/constants/video-scale";
import { env } from "@/lib/env";
import { assertHomeCredentials } from "@/lib/platform/credentials";
import { httpErrorKind, ProviderError } from "@/lib/video-scale/providers/types";

/**
 * ═══════════ GIỌNG ĐỌC — OPENAI TTS ═══════════
 *
 * `POST /v1/audio/speech` (developers.openai.com/api/docs/guides/text-to-speech, đọc 27/09/2026): `model`, `voice`,
 * `input`, `instructions`, `response_format`. Tiếng Việt được hỗ trợ. Tài liệu không in giá một lượt ⇒ tiền ghi CHƯA
 * BIẾT (chuỗi rỗng trong sổ `ai_interactions`), không phải 0.
 */

export const TTS_URL = "https://api.openai.com/v1/audio/speech";
export const TTS_ROUTE = "video-scale.tts";
const TTS_INSTRUCTIONS = "Giọng nữ trẻ, tự nhiên, thân thiện, như đang giới thiệu váy cho bạn thân; tốc độ vừa, rõ chữ; tiếng Việt chuẩn.";

export async function synthesizeSpeech(db: Db, input: { text: string; voice: string; entityId: string }, deps: { fetchImpl?: typeof fetch; apiKey?: string } = {}): Promise<Uint8Array> {
  const text = input.text.trim();
  if (!text) throw new ProviderError("Lời đọc rỗng.", "PERMANENT");
  await assertHomeCredentials("openai");
  const apiKey = deps.apiKey ?? env.openaiRest.apiKey;
  if (!apiKey) throw new ProviderError("Chưa có OPENAI_API_KEY trên máy chủ — không tạo được giọng đọc (tắt giọng đọc ở Cấu hình nếu không dùng).", "BLOCKED");
  const started = Date.now();
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice: input.voice, input: text, instructions: TTS_INSTRUCTIONS, response_format: "mp3" }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    // Giọng đọc rẻ và không có tác dụng phụ ngoài tiền nhỏ — lỗi mạng coi là tạm thời.
    throw new ProviderError(`Không gọi được OpenAI TTS: ${e instanceof Error ? e.message : String(e)}`, "TRANSIENT");
  }
  const ok = res.ok;
  const bytes = ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
  let error: string | null = null;
  if (!ok) {
    let msg = "";
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") msg = body.error.message;
    } catch {
      // không phải JSON
    }
    error = `OpenAI TTS từ chối (HTTP ${res.status})${msg ? `: ${msg.slice(0, 300)}` : ""}.`;
  }
  try {
    await db.insert(schema.aiInteractions).values({
      userId: null,
      userEmail: "",
      provider: "openai",
      model: TTS_MODEL,
      route: TTS_ROUTE,
      entityType: "video_scale_variant",
      entityId: input.entityId,
      prompt: text.slice(0, 4000),
      answer: ok ? `(âm thanh mp3, ${bytes.byteLength} byte)` : "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: "",
      latencyMs: Date.now() - started,
      rounds: 1,
      status: error ? "ERROR" : "OK",
      error,
    });
  } catch {
    // sổ hỏng không làm hỏng giọng đọc
  }
  if (error) throw new ProviderError(error, httpErrorKind(res.status));
  if (!bytes.byteLength) throw new ProviderError("OpenAI TTS trả tệp rỗng.", "TRANSIENT");
  return bytes;
}
