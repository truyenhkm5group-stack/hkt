import { z } from "zod";
import type { Db } from "@/db";
import { MODEL_BY_TIER } from "@/lib/ai/router";
import { VIDEO_QC_CHECKS, VIDEO_QC_CHECK_LABEL, VIDEO_SCALE_HARD_LIMITS, type VideoQcCheck, type VideoQcVerdict } from "@/lib/constants/video-scale";
import type { MediaProbe } from "@/lib/video-scale/ffmpeg";
import { callOpenAiJson, extractJson, type JsonCallDeps } from "@/lib/video-scale/openai-json";

/**
 * ═══════════ KIỂM CHẤT LƯỢNG VIDEO ═══════════
 *
 * Hai lớp, kết luận là cái TỆ HƠN của hai:
 *
 *  · KỸ THUẬT (hàm thuần trên `ffprobe`): có hình, có tiếng AAC 48 kHz, H.264, đúng khung 9:16 đã đặt, dài 3–90 giây
 *    (khung Reels) và đúng độ dài kịch bản, 24–60 khung/giây, dưới trần dung lượng. Sai ⇒ `FAIL` — tệp hỏng không có
 *    "nghi ngờ".
 *  · HÌNH ẢNH (mô hình đọc ảnh): so 4 khung hình của video với ẢNH GỐC trên đúng bảy điểm chủ shop nêu (màu, cổ, tay, eo,
 *    dáng váy, người mẫu, chữ / logo lạ). Mỗi điểm `PASS` · `FAIL` · `UNSURE`. Có `FAIL` ⇒ `FAIL`; có `UNSURE` hoặc thiếu
 *    điểm ⇒ `FLAG`; đủ bảy `PASS` ⇒ `PASS`.
 *
 * QC hình ảnh KHÔNG chạy được (thiếu khoá, OpenAI lỗi, dữ liệu thử) ⇒ `FLAG` kèm lý do — không bao giờ `PASS` vì không
 * kiểm được. `FLAG` chỉ người duyệt được, kể cả khi mã bật tự duyệt.
 */

export const QC_ROUTE = "video-scale.qc";

export type TechnicalQc = { verdict: "PASS" | "FAIL"; problems: string[]; probe: MediaProbe };

export function technicalQc(probe: MediaProbe, expect: { width: number; height: number; durationSec: number; bytes: number }): TechnicalQc {
  const p: string[] = [];
  if (!probe.hasVideo) p.push("không có luồng hình");
  if (probe.videoCodec !== "h264") p.push(`mã hoá hình ${probe.videoCodec ?? "không rõ"}, cần H.264`);
  if (probe.width !== expect.width || probe.height !== expect.height) p.push(`khung ${probe.width ?? "?"}×${probe.height ?? "?"}, cần ${expect.width}×${expect.height} (9:16)`);
  const d = probe.durationSec;
  if (d === null) p.push("không đọc được độ dài");
  else {
    if (d < 3 || d > 90) p.push(`dài ${d.toFixed(1)} giây — Reels nhận 3–90 giây`);
    if (Math.abs(d - expect.durationSec) > 0.6) p.push(`dài ${d.toFixed(1)} giây, kịch bản ${expect.durationSec.toFixed(1)} giây`);
  }
  if (probe.fps === null || probe.fps < 24 || probe.fps > 60) p.push(`${probe.fps ?? "?"} khung/giây — Reels nhận 24–60`);
  if (!probe.hasAudio) p.push("không có tiếng");
  else {
    if (probe.audioCodec !== "aac") p.push(`mã hoá tiếng ${probe.audioCodec ?? "không rõ"}, Reels cần AAC`);
    if (probe.audioSampleRate !== 48000) p.push(`tần số lấy mẫu ${probe.audioSampleRate ?? "?"} Hz, Reels cần 48 kHz`);
  }
  if (expect.bytes > VIDEO_SCALE_HARD_LIMITS.maxAssetBytes) p.push("vượt trần dung lượng một tệp");
  return { verdict: p.length ? "FAIL" : "PASS", problems: p, probe };
}

export type VisualCheck = { check: VideoQcCheck; result: "PASS" | "FAIL" | "UNSURE"; note: string };
export type VisualQc = { ran: true; checks: VisualCheck[]; summary: string; model: string; costUsd: number | null } | { ran: false; reason: string };

export function visualJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["checks", "summary"],
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "result", "note"],
          properties: { check: { type: "string", enum: [...VIDEO_QC_CHECKS] }, result: { type: "string", enum: ["PASS", "FAIL", "UNSURE"] }, note: { type: "string" } },
        },
      },
      summary: { type: "string" },
    },
  };
}

const VisualZ = z.object({
  checks: z.array(z.object({ check: z.enum(VIDEO_QC_CHECKS), result: z.enum(["PASS", "FAIL", "UNSURE"]), note: z.string() })),
  summary: z.string(),
});

export function parseVisual(text: string): { checks: VisualCheck[]; summary: string } | null {
  const r = VisualZ.safeParse(extractJson(text));
  return r.success ? r.data : null;
}

/** Kết luận của lớp hình ảnh. Điểm thiếu ⇒ coi như `UNSURE`. Hàm THUẦN. */
export function visualVerdict(checks: readonly VisualCheck[]): VideoQcVerdict {
  const byCheck = new Map(checks.map((c) => [c.check, c.result]));
  const results = VIDEO_QC_CHECKS.map((k) => byCheck.get(k) ?? "UNSURE");
  if (results.includes("FAIL")) return "FAIL";
  if (results.includes("UNSURE")) return "FLAG";
  return "PASS";
}

/** Kết luận chung = cái tệ hơn. Lớp hình ảnh không chạy được ⇒ tối đa `FLAG`. Hàm THUẦN. */
export function combineQc(tech: TechnicalQc, visual: VisualQc): VideoQcVerdict {
  if (tech.verdict === "FAIL") return "FAIL";
  if (!visual.ran) return "FLAG";
  return visualVerdict(visual.checks);
}

const INSTRUCTIONS = [
  "Bạn là người kiểm duyệt video quảng cáo thời trang. Ảnh ĐẦU TIÊN là ảnh sản phẩm thật (chuẩn). Các ảnh sau là khung hình cắt từ video máy sinh ra.",
  "So từng điểm và trả JSON đúng lược đồ, mỗi điểm một dòng:",
  ...VIDEO_QC_CHECKS.map((k) => `- ${k}: ${VIDEO_QC_CHECK_LABEL[k]}`),
  "Quy ước: PASS = khớp ảnh chuẩn / không có lỗi. FAIL = sai rõ ràng (vd váy đổi màu, cổ tròn thành cổ V, tay dài thành sát nách, tay/ngón/khuôn mặt méo, chân tay thừa, chữ hoặc logo lạ xuất hiện). UNSURE = khung hình không đủ rõ để kết luận.",
  "BỎ QUA chữ bán hàng / phụ đề trắng viền đen do hậu kỳ thêm vào (thường ở giữa hoặc dưới khung) — đó KHÔNG phải chữ lạ. Chỉ tính chữ / logo in trên váy, trên nền, trên người mẫu mà ảnh chuẩn không có.",
  "note: một câu tiếng Việt nêu cụ thể thấy gì. summary: một câu tiếng Việt kết luận chung.",
].join("\n");

export async function visualQc(db: Db, input: { source: { bytes: Uint8Array; contentType: string }; frames: Uint8Array[]; entityId: string }, deps: JsonCallDeps & { model?: string } = {}): Promise<VisualQc> {
  if (!input.frames.length) return { ran: false, reason: "không cắt được khung hình nào" };
  const r = await callOpenAiJson(
    db,
    {
      route: QC_ROUTE,
      entityType: "video_scale_variant",
      entityId: input.entityId,
      model: deps.model ?? MODEL_BY_TIER.openai.copilot,
      instructions: INSTRUCTIONS,
      text: `Ảnh 1 là sản phẩm chuẩn. Ảnh 2–${input.frames.length + 1} là khung hình của video. Kiểm đủ ${VIDEO_QC_CHECKS.length} điểm.`,
      images: [{ ...input.source, detail: "high" }, ...input.frames.map((b) => ({ bytes: b, contentType: "image/jpeg", detail: "high" as const }))],
      schemaName: "video_qc",
      jsonSchema: visualJsonSchema(),
      parse: parseVisual,
      problems: (v) => {
        const missing = VIDEO_QC_CHECKS.filter((k) => !v.checks.some((c) => c.check === k));
        return missing.length ? [`thiếu điểm: ${missing.join(", ")}`] : [];
      },
      maxOutputTokens: 2500,
      effort: "medium",
    },
    deps,
  );
  if (!r.ok) return { ran: false, reason: r.error };
  return { ran: true, checks: r.value.checks, summary: r.value.summary, model: r.model, costUsd: r.costUsd };
}
