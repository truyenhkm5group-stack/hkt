import { z } from "zod";
import type { Db } from "@/db";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { CAPTION_LIMITS, VIDEO_ANGLE_LABEL, composeCaption, type CaptionOption, type VideoScript } from "@/lib/constants/video-scale";
import { formatVND } from "@/lib/format";
import { claimProblems, type ClaimFacts } from "@/lib/video-scale/claims";
import type { ProductFacts } from "@/lib/video-scale/facts";
import { callOpenAiJson, extractJson, type JsonCallDeps } from "@/lib/video-scale/openai-json";

/**
 * ═══════════ CONTENT CHO REEL — LLM VIẾT, CÙNG BỘ KIỂM VỚI KỊCH BẢN ═══════════
 *
 * Content đứng cạnh VIDEO ĐÃ DUYỆT, nên người viết nhận kịch bản của chính video (móc câu, chữ trên hình, lời đọc) và sự
 * thật về mã (giá, màu, size, chính sách đã khai). Mọi phần chữ đi qua `claimProblems` — cùng hàm của kịch bản, để video
 * và bài đăng không bao giờ nói hai giá. Hashtag chỉ gồm chữ / số / gạch dưới.
 */

export const CAPTION_ROUTE = "video-scale.caption";

export function captionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["options"],
    properties: {
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["hook", "body", "cta", "hashtags"],
          properties: { hook: { type: "string" }, body: { type: "string" }, cta: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
        },
      },
    },
  };
}

const OptionZ = z.object({ hook: z.string().trim(), body: z.string().trim(), cta: z.string().trim(), hashtags: z.array(z.string().trim()) });

export function parseCaptions(text: string): CaptionOption[] | null {
  const r = z.object({ options: z.array(OptionZ).min(1) }).safeParse(extractJson(text));
  return r.success ? r.data.options.map((o) => ({ ...o, hashtags: o.hashtags.map((h) => h.replace(/^#+/, "")) })) : null;
}

/** Lỗi của MỘT phương án content. Rỗng là đạt. Hàm THUẦN. */
export function captionProblems(o: CaptionOption, facts: ClaimFacts, label = "Phương án"): string[] {
  const L = CAPTION_LIMITS;
  const out: string[] = [];
  if (!o.hook) out.push(`${label}: thiếu móc câu`);
  if (o.hook.length > L.hookMaxChars) out.push(`${label}: móc câu dài ${o.hook.length} ký tự, tối đa ${L.hookMaxChars}`);
  if (!o.body) out.push(`${label}: thiếu thân bài`);
  if (o.body.length > L.bodyMaxChars) out.push(`${label}: thân bài dài ${o.body.length} ký tự, tối đa ${L.bodyMaxChars}`);
  if (!o.cta) out.push(`${label}: thiếu CTA`);
  if (o.cta.length > L.ctaMaxChars) out.push(`${label}: CTA dài ${o.cta.length} ký tự, tối đa ${L.ctaMaxChars}`);
  if (o.hashtags.length < L.hashtagMin || o.hashtags.length > L.hashtagMax) out.push(`${label}: cần ${L.hashtagMin}–${L.hashtagMax} hashtag (đang có ${o.hashtags.length})`);
  for (const h of o.hashtags) if (!/^[\p{L}\p{N}_]{1,30}$/u.test(h)) out.push(`${label}: hashtag "${h}" chỉ được gồm chữ, số, gạch dưới (≤ ${L.hashtagMaxChars} ký tự)`);
  for (const [field, text] of [["móc câu", o.hook], ["thân bài", o.body], ["CTA", o.cta], ["hashtag", o.hashtags.join(" ")]] as const) out.push(...claimProblems(`${label} — ${field}`, text, facts));
  if (composeCaption(o).length > L.totalMaxChars) out.push(`${label}: tổng content dài hơn ${L.totalMaxChars} ký tự`);
  return out;
}

/**
 * Kiểm content NGƯỜI sửa tay trước khi đăng — cùng luật khẳng định (giá, size, màu, chất liệu, khuyến mãi). Người được
 * viết khác máy, không được khẳng định điều ERP không có. Hàm THUẦN.
 */
export function finalCaptionProblems(text: string, facts: ClaimFacts): string[] {
  const t = text.trim();
  if (!t) return ["Content rỗng."];
  if (t.length > CAPTION_LIMITS.totalMaxChars) return [`Content dài ${t.length} ký tự, tối đa ${CAPTION_LIMITS.totalMaxChars}.`];
  return claimProblems("Content", t, facts);
}

const INSTRUCTIONS = [
  "Bạn viết content đăng kèm một video Reels bán hàng thời trang của shop Việt Nam. Video đã được duyệt; kịch bản của nó được cung cấp.",
  `Trả JSON đúng lược đồ: ${CAPTION_LIMITS.options} phương án, mỗi phương án có hook (câu đầu hút mắt), body (2–4 câu), cta (mời nhắn tin / bình luận để được tư vấn size), hashtags (${CAPTION_LIMITS.hashtagMin}–${CAPTION_LIMITS.hashtagMax} từ, KHÔNG có dấu #, chỉ chữ số gạch dưới).`,
  "Luật bắt buộc:",
  "- Chỉ nói điều có trong SỰ THẬT và trong video. Không bịa số khách đã mua, số lượng còn lại, đánh giá.",
  "- Không nêu chất liệu vải trừ khi tên sản phẩm ghi rõ. Giá chỉ đúng giá ERP; không có giá thì không con số giá nào.",
  "- Size, màu chỉ những cái đang bán. Khuyến mãi / miễn ship / quà chỉ khi có trong CHÍNH SÁCH đã khai.",
  "- Không nhắc thương hiệu khác. Ba phương án phải khác nhau thật (cách mở đầu, điểm nhấn).",
].join("\n");

export type CaptionWriteResult = { ok: true; options: CaptionOption[]; dropped: string[]; model: string; costUsd: number | null } | { ok: false; error: string; model: string; costUsd: number | null };

export function captionBrief(facts: ProductFacts, script: VideoScript): string {
  return [
    `Viết ${CAPTION_LIMITS.options} phương án content cho video góc "${VIDEO_ANGLE_LABEL[script.angle]}".`,
    `Kịch bản video — móc câu: ${script.hook}`,
    ...script.scenes.map((c, i) => `Cảnh ${i + 1}: chữ "${c.overlay}"${c.voiceover ? `; lời đọc "${c.voiceover}"` : ""}`),
    `CTA trên video: ${script.cta}`,
    "SỰ THẬT:",
    `- Sản phẩm: ${facts.name} (mã ${facts.code || "không rõ"})`,
    `- Giá bán ERP: ${facts.priceVnd !== null ? formatVND(facts.priceVnd) : "KHÔNG RÕ — không viết con số giá nào"}`,
    `- Màu đang bán: ${facts.colors.join(", ") || "không có dữ liệu — không nhắc tên màu"}`,
    `- Size đang bán: ${facts.sizes.join(", ") || "không có dữ liệu — không nhắc size"}`,
    facts.styleSummary ? `- Kiểu dáng: ${facts.styleSummary}` : "",
    `- Chính sách đã khai: ${facts.policyLines.length ? facts.policyLines.join(" | ") : "KHÔNG CÓ — không viết khuyến mãi / miễn ship / quà"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function writeCaptions(db: Db, input: { facts: ProductFacts; script: VideoScript; entityId: string }, deps: JsonCallDeps & { model?: string } = {}): Promise<CaptionWriteResult> {
  const r = await callOpenAiJson(
    db,
    {
      route: CAPTION_ROUTE,
      entityType: "video_scale_variant",
      entityId: input.entityId,
      model: deps.model ?? MODEL_BY_TIER.openai.routine,
      instructions: INSTRUCTIONS,
      text: captionBrief(input.facts, input.script),
      schemaName: "reel_captions",
      jsonSchema: captionJsonSchema(),
      parse: parseCaptions,
      problems: (opts) => opts.flatMap((o, i) => captionProblems(o, input.facts, `Phương án ${i + 1}`)),
      maxOutputTokens: 3000,
    },
    deps,
  );
  if (!r.ok) return r;
  const options: CaptionOption[] = [];
  const dropped: string[] = [];
  r.value.forEach((o, i) => {
    const p = captionProblems(o, input.facts, `Phương án ${i + 1}`);
    if (p.length) dropped.push(...p);
    else options.push(o);
  });
  if (!options.length) return { ok: false, error: `Không phương án content nào qua kiểm: ${dropped.slice(0, 4).join("; ")}`, model: r.model, costUsd: r.costUsd };
  return { ok: true, options, dropped, model: r.model, costUsd: r.costUsd };
}
