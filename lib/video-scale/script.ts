import { z } from "zod";
import type { Db } from "@/db";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { SCRIPT_LIMITS, VIDEO_ANGLE_BRIEF, VIDEO_ANGLE_LABEL, isVideoAngle, scriptTokens, type VideoAngle, type VideoScript } from "@/lib/constants/video-scale";
import { stripPrices, wrongPrices } from "@/lib/creative/writer";
import { claimProblems, type ClaimFacts } from "@/lib/video-scale/claims";
import { formatVND } from "@/lib/format";
import type { ProductFacts } from "@/lib/video-scale/facts";
import { callOpenAiJson, extractJson, type JsonCallDeps } from "@/lib/video-scale/openai-json";
import { nearDuplicate } from "@/lib/video-scale/plan";

/**
 * ═══════════ VIẾT KỊCH BẢN VIDEO — LLM VIẾT, HÀM THUẦN KIỂM ═══════════
 *
 * Mô hình chỉ VIẾT cho các góc đã được `planAngles` chọn. Sau đó mọi câu tiếng Việt (móc câu, chữ trên hình, lời đọc,
 * CTA) đi qua `scriptProblems`:
 *  · con số GIÁ phải bằng đúng giá ERP (không có giá ⇒ không con số giá nào) — cùng `wrongPrices` của vòng mẫu ảnh;
 *  · SIZE nhắc tới phải là size đang bán;
 *  · MÀU nhắc tới phải có trong danh sách màu đang bán;
 *  · CHẤT LIỆU: không được nêu, trừ khi tên sản phẩm ghi rõ;
 *  · KHUYẾN MÃI / miễn ship / quà: chỉ khi câu chính sách người đã khai có đúng chữ ấy;
 *  · không gần giống kịch bản đã có của cùng mã (chống lặp).
 * Sai ⇒ viết lại MỘT lần kèm lỗi. Vẫn sai ⇒ giá sai bị GỠ; lỗi khác ⇒ kịch bản ấy bị BỎ (có lý do), không đi sinh video.
 *
 * Câu lệnh cảnh gửi Veo (tiếng Anh) do mô hình viết phần hành động / máy quay; phần GIỮ SẢN PHẨM và CẤM CHỮ do MÃ NGUỒN
 * gắn tất định (`veoPrompt`) — cùng lý do chỉ thị gen của `writer.ts`: nhờ LLM nhớ thì có ngày nó quên.
 */

export const SCRIPT_ROUTE = "video-scale.script";

/** Đuôi tiếng Anh gắn TẤT ĐỊNH vào mọi câu lệnh cảnh. */
export const VEO_KEEP_PRODUCT =
  "Keep the exact garment from the reference image: identical color, pattern, neckline, sleeves, waist and length; do not redesign it. Realistic human anatomy and natural hands. Vertical 9:16 fashion video, soft natural light, smooth camera. Absolutely no on-screen text, captions, logos, watermarks or brand names.";

export const VEO_NEGATIVE_PROMPT = "text, captions, subtitles, logo, watermark, brand name, distorted body, extra limbs, extra fingers, deformed hands, changed garment color, different dress, blurry, low quality";

export function veoPrompt(scenePrompt: string): string {
  return `${scenePrompt.trim().replace(/\s+/g, " ").slice(0, SCRIPT_LIMITS.scenePromptMaxChars)} ${VEO_KEEP_PRODUCT}`;
}

// ───────────────────────────── ĐỌC CÂU TRẢ LỜI ─────────────────────────────

export function scriptJsonSchema(): Record<string, unknown> {
  const scene = {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "overlay", "voiceover"],
    properties: { prompt: { type: "string" }, overlay: { type: "string" }, voiceover: { type: "string" } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["scripts"],
    properties: {
      scripts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["angle", "hook", "scenes", "cta"],
          properties: { angle: { type: "string" }, hook: { type: "string" }, scenes: { type: "array", items: scene }, cta: { type: "string" } },
        },
      },
    },
  };
}

const SceneZ = z.object({ prompt: z.string().trim(), overlay: z.string().trim(), voiceover: z.string().trim() });
const ScriptZ = z.object({ angle: z.string(), hook: z.string().trim(), scenes: z.array(SceneZ), cta: z.string().trim() });
const AnswerZ = z.object({ scripts: z.array(ScriptZ) });

/** Đọc câu trả lời thành kịch bản; góc lạ ⇒ bỏ kịch bản ấy. Hàm THUẦN. */
export function parseScripts(text: string): VideoScript[] | null {
  const parsed = AnswerZ.safeParse(extractJson(text));
  if (!parsed.success) return null;
  return parsed.data.scripts.filter((s) => isVideoAngle(s.angle)).map((s) => ({ ...s, angle: s.angle as VideoAngle }));
}

// ───────────────────────────── KIỂM ─────────────────────────────

export function vietnameseFields(s: VideoScript): { field: string; text: string }[] {
  return [
    { field: "móc câu", text: s.hook },
    ...s.scenes.flatMap((c, i) => [
      { field: `chữ trên hình cảnh ${i + 1}`, text: c.overlay },
      { field: `lời đọc cảnh ${i + 1}`, text: c.voiceover },
    ]),
    { field: "CTA", text: s.cta },
  ];
}

/** Lỗi của MỘT kịch bản so với sự thật về mã. Rỗng là đạt. Hàm THUẦN. */
export function scriptProblems(s: VideoScript, expect: { angle: VideoAngle; scenes: number }, facts: ClaimFacts): string[] {
  const out: string[] = [];
  if (s.angle !== expect.angle) out.push(`góc phải là ${expect.angle}, không phải ${s.angle}`);
  if (s.scenes.length !== expect.scenes) out.push(`phải có đúng ${expect.scenes} cảnh (đang có ${s.scenes.length})`);
  if (!s.hook) out.push("thiếu móc câu");
  if (s.hook.length > SCRIPT_LIMITS.hookMaxChars) out.push(`móc câu dài ${s.hook.length} ký tự, tối đa ${SCRIPT_LIMITS.hookMaxChars}`);
  if (!s.cta) out.push("thiếu CTA");
  if (s.cta.length > SCRIPT_LIMITS.ctaMaxChars) out.push(`CTA dài ${s.cta.length} ký tự, tối đa ${SCRIPT_LIMITS.ctaMaxChars}`);
  s.scenes.forEach((c, i) => {
    if (!c.prompt) out.push(`cảnh ${i + 1} thiếu câu lệnh video`);
    if (c.overlay.length > SCRIPT_LIMITS.overlayMaxChars) out.push(`chữ trên hình cảnh ${i + 1} dài ${c.overlay.length} ký tự, tối đa ${SCRIPT_LIMITS.overlayMaxChars}`);
    if (c.voiceover.length > SCRIPT_LIMITS.voiceoverMaxCharsPerScene) out.push(`lời đọc cảnh ${i + 1} dài ${c.voiceover.length} ký tự, tối đa ${SCRIPT_LIMITS.voiceoverMaxCharsPerScene}`);
  });
  for (const { field, text } of vietnameseFields(s)) out.push(...claimProblems(field, text, facts));
  return out;
}

/** Gỡ con số giá sai khỏi mọi trường tiếng Việt. Hàm THUẦN. */
export function stripWrongPrices(s: VideoScript, priceVnd: number | null): VideoScript {
  const fix = (t: string) => {
    const bad = wrongPrices(t, priceVnd);
    return bad.length ? stripPrices(t, bad) : t;
  };
  return { ...s, hook: fix(s.hook), cta: fix(s.cta), scenes: s.scenes.map((c) => ({ ...c, overlay: fix(c.overlay), voiceover: fix(c.voiceover) })) };
}

// ───────────────────────────── GỌI MÔ HÌNH ─────────────────────────────

const INSTRUCTIONS = [
  "Bạn viết kịch bản video Reels dọc 9:16 bán hàng thời trang cho một shop Việt Nam. Mỗi cảnh là MỘT clip do máy sinh video tạo từ ảnh sản phẩm thật (ảnh là khung hình đầu).",
  "Trả về JSON đúng lược đồ. Mỗi kịch bản gồm: angle (giữ nguyên mã góc được giao), hook (câu mở đầu hiện trên hình ở 3 giây đầu), scenes, cta (câu kêu gọi cuối video, ví dụ mời nhắn tin).",
  "Mỗi cảnh: prompt = câu lệnh TIẾNG ANH cho máy sinh video: tả chuyển động của người mẫu, máy quay, bối cảnh, ánh sáng — KHÔNG tả lại thiết kế váy/áo theo trí nhớ (máy sẽ tự giữ đúng sản phẩm theo ảnh), KHÔNG xin chữ trên hình. overlay = chữ bán hàng tiếng Việt ngắn hiện trên cảnh. voiceover = lời đọc tiếng Việt tự nhiên của cảnh (1–2 câu).",
  "Luật bắt buộc:",
  "- Chỉ nói điều có trong SỰ THẬT được cung cấp và điều nhìn thấy trong ảnh. Không bịa số khách đã mua, số lượng còn lại, đánh giá.",
  "- Không nêu chất liệu vải (lụa, cotton, linen, voan…) trừ khi tên sản phẩm ghi rõ. Được tả độ rủ, chuyển động nhìn thấy.",
  "- Nếu nhắc giá thì CHỈ đúng giá ERP. Không có giá thì KHÔNG viết con số giá nào.",
  "- Size, màu chỉ nhắc những cái đang bán. Khuyến mãi, miễn phí vận chuyển, quà tặng chỉ khi có trong CHÍNH SÁCH đã khai.",
  "- Không nhắc thương hiệu khác. Không hứa hẹn chữa khuyết điểm cơ thể một cách tuyệt đối.",
  "- Các kịch bản phải khác nhau thật (móc câu, cách kể, bối cảnh), và khác các kịch bản cũ được liệt kê.",
].join("\n");

export type ScriptWriteInput = {
  facts: ProductFacts;
  angles: VideoAngle[];
  scenes: number;
  clipSeconds: number;
  brief: string;
  /** Móc câu + dấu vân tay của các kịch bản đã có của CÙNG mã — để viết khác và để chặn trùng. */
  existing: { hook: string; tokens: ReadonlySet<string> }[];
  /** Bài học rút từ các biến thể đã chấm (PR đo lường điền) — chữ, đã đếm sẵn. */
  lessons: string[];
  sourceImage: { bytes: Uint8Array; contentType: string };
  entityId: string;
};

export type ScriptWriteResult =
  | { ok: true; scripts: VideoScript[]; dropped: { angle: VideoAngle; reasons: string[] }[]; model: string; costUsd: number | null }
  | { ok: false; error: string; model: string; costUsd: number | null };

export function scriptBrief(input: Omit<ScriptWriteInput, "sourceImage" | "entityId">): string {
  const f = input.facts;
  return [
    `Viết ${input.angles.length} kịch bản, mỗi kịch bản ${input.scenes} cảnh × ${input.clipSeconds} giây.`,
    `Góc giao cho từng kịch bản (theo thứ tự):\n${input.angles.map((a, i) => `${i + 1}. ${a} — ${VIDEO_ANGLE_LABEL[a]}: ${VIDEO_ANGLE_BRIEF[a]}`).join("\n")}`,
    "SỰ THẬT:",
    `- Sản phẩm: ${f.name} (mã ${f.code || "không rõ"})`,
    `- Giá bán ERP: ${f.priceVnd !== null ? formatVND(f.priceVnd) : "KHÔNG RÕ — không viết con số giá nào"}`,
    `- Màu đang bán: ${f.colors.join(", ") || "không có dữ liệu — không nhắc tên màu"}`,
    `- Size đang bán: ${f.sizes.join(", ") || "không có dữ liệu — không nhắc size"}`,
    f.styleSummary ? `- Kiểu dáng (đọc từ ảnh): ${f.styleSummary}` : "",
    f.sourceSummary ? `- Ảnh gốc đính kèm: ${f.sourceSummary}` : "",
    `- Chính sách bán hàng đã khai: ${f.policyLines.length ? f.policyLines.join(" | ") : "KHÔNG CÓ — không viết khuyến mãi / miễn ship / quà tặng"}`,
    input.brief.trim() ? `Ý của người bấm (ưu tiên nếu không trái luật): ${input.brief.trim().slice(0, 600)}` : "",
    input.lessons.length ? `Bài học từ các video đã chạy của shop:\n- ${input.lessons.slice(0, 8).join("\n- ")}` : "",
    input.existing.length ? `Móc câu đã dùng cho mã này (KHÔNG lặp lại, không viết gần giống):\n- ${input.existing.slice(0, 20).map((e) => e.hook).join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Tất cả lỗi của một câu trả lời (theo thứ tự góc) — kể cả trùng lặp với kịch bản cũ / với nhau. Hàm THUẦN. */
export function batchProblems(scripts: VideoScript[], input: Pick<ScriptWriteInput, "angles" | "scenes" | "facts" | "existing">): string[] {
  const out: string[] = [];
  if (scripts.length !== input.angles.length) out.push(`phải có đúng ${input.angles.length} kịch bản (đang có ${scripts.length})`);
  const seen: ReadonlySet<string>[] = input.existing.map((e) => e.tokens);
  scripts.forEach((s, i) => {
    const angle = input.angles[i];
    if (!angle) return;
    for (const p of scriptProblems(s, { angle, scenes: input.scenes }, input.facts)) out.push(`Kịch bản ${i + 1}: ${p}`);
    const tokens = scriptTokens(s);
    const dup = nearDuplicate(tokens, seen);
    if (dup) out.push(`Kịch bản ${i + 1}: gần giống một kịch bản đã có (${Math.round(dup.score * 100)}% trùng từ) — viết khác đi`);
    seen.push(tokens);
  });
  return out;
}

export async function writeScripts(db: Db, input: ScriptWriteInput, deps: JsonCallDeps & { model?: string } = {}): Promise<ScriptWriteResult> {
  const text = scriptBrief(input);
  const r = await callOpenAiJson(
    db,
    {
      route: SCRIPT_ROUTE,
      entityType: "video_scale_run",
      entityId: input.entityId,
      model: deps.model ?? MODEL_BY_TIER.openai.copilot,
      instructions: INSTRUCTIONS,
      text,
      images: [{ ...input.sourceImage, detail: "low" }],
      schemaName: "video_scripts",
      jsonSchema: scriptJsonSchema(),
      parse: parseScripts,
      problems: (scripts) => batchProblems(scripts, input),
      maxOutputTokens: 6000,
      effort: "medium",
    },
    deps,
  );
  if (!r.ok) return r;
  // Chốt: gỡ giá sai; kịch bản còn lỗi khác (hoặc trùng) bị BỎ kèm lý do.
  const kept: VideoScript[] = [];
  const dropped: { angle: VideoAngle; reasons: string[] }[] = [];
  const seen: ReadonlySet<string>[] = input.existing.map((e) => e.tokens);
  input.angles.forEach((angle, i) => {
    const raw = r.value[i];
    if (!raw) {
      dropped.push({ angle, reasons: ["mô hình không viết kịch bản cho góc này"] });
      return;
    }
    const s = stripWrongPrices(raw, input.facts.priceVnd);
    const reasons = scriptProblems(s, { angle, scenes: input.scenes }, input.facts);
    const tokens = scriptTokens(s);
    const dup = nearDuplicate(tokens, seen);
    if (dup) reasons.push(`gần giống một kịch bản đã có (${Math.round(dup.score * 100)}% trùng từ)`);
    if (reasons.length) {
      dropped.push({ angle, reasons });
      return;
    }
    seen.push(tokens);
    kept.push(s);
  });
  return { ok: true, scripts: kept, dropped, model: r.model, costUsd: r.costUsd };
}
