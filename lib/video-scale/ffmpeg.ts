import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { env } from "@/lib/env";

/**
 * ═══════════ HẬU KỲ BẰNG FFMPEG ═══════════
 *
 * Hai lớp tách hẳn:
 *  · HÀM THUẦN dựng tham số (`buildRenderArgs`, `parseProbe`, `wrapText`…) — kiểm thử được không cần ffmpeg.
 *  · `runTool` gọi tiến trình con với MẢNG tham số (`shell: false`) — không chuỗi lệnh nào qua shell, chữ của người /
 *    của mô hình không bao giờ thành lệnh. Chữ trên hình đi qua TỆP (`textfile=`), không nhúng vào bộ lọc: khỏi phải
 *    thoát dấu `:` `'` `%` trong câu tiếng Việt, và không câu nào bẻ được bộ lọc.
 *
 * Máy chủ thiếu ffmpeg ⇒ `FfmpegMissingError` ⇒ việc hậu kỳ đứng `BLOCKED` với câu nói rõ (ranh giới 2), không giả lập.
 */

export class FfmpegMissingError extends Error {}

export type ToolResult = { code: number; stdout: Buffer; stderr: string };

/** Chạy một công cụ (ffmpeg/ffprobe). `cwd` dùng để các tệp chữ đi bằng tên TƯƠNG ĐỐI. */
export function runTool(bin: string, args: readonly string[], opts: { cwd?: string; timeoutMs: number }): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, [...args], { cwd: opts.cwd, shell: false, windowsHide: true });
    } catch (e) {
      reject(new FfmpegMissingError(`Không chạy được ${bin}: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
      if (err.length > 20_000) err = err.slice(-10_000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new FfmpegMissingError(`Máy chủ không có ${bin} (${e.code}). Image Docker phải cài \`apk add ffmpeg\`.`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

let availability: Promise<string | null> | null = null;

/** Phiên bản ffmpeg, hoặc `null` khi máy không có. Đệm theo tiến trình. */
export function ffmpegVersion(): Promise<string | null> {
  availability ??= runTool(env.videoScale.ffmpegPath, ["-hide_banner", "-version"], { timeoutMs: 15_000 })
    .then((r) => (r.code === 0 ? (r.stdout.toString("utf8").split("\n")[0] ?? "ffmpeg").trim() : null))
    .catch(() => null);
  return availability;
}

/**
 * Tệp phông cho chữ trên hình, hoặc `null` khi tệp không có. Thiếu phông thì ffmpeg KHÔNG báo lỗi — nó lặng lẽ dùng một phông
 * khác, và phông ấy thường thiếu dấu tiếng Việt ("thử" thành "th□"): video vẫn "thành công" với chữ vỡ. Nên thiếu phông là CHẶN.
 */
export async function resolveFontFile(file: string = env.videoScale.fontFile): Promise<string | null> {
  if (!file) return null;
  try {
    await access(file);
    return file;
  } catch {
    return null;
  }
}

// ───────────────────────────── ĐỌC THÔNG SỐ ─────────────────────────────

export type MediaProbe = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  fps: number | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `r_frame_rate` dạng "30/1" ⇒ 30. Hàm THUẦN. */
export function parseRate(v: unknown): number | null {
  if (typeof v !== "string") return num(v);
  const [a, b] = v.split("/").map(Number);
  if (!Number.isFinite(a)) return null;
  if (b === undefined) return a;
  return Number.isFinite(b) && b > 0 ? Math.round((a / b) * 100) / 100 : null;
}

/** Đọc JSON của `ffprobe -print_format json -show_streams -show_format`. Hàm THUẦN. */
export function parseProbe(json: string): MediaProbe {
  let o: Record<string, unknown> = {};
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    o = {};
  }
  const streams = Array.isArray(o.streams) ? (o.streams as Record<string, unknown>[]) : [];
  const v = streams.find((s) => s.codec_type === "video");
  const au = streams.find((s) => s.codec_type === "audio");
  const format = (o.format ?? {}) as Record<string, unknown>;
  return {
    durationSec: num(format.duration) ?? num(v?.duration),
    width: num(v?.width),
    height: num(v?.height),
    videoCodec: typeof v?.codec_name === "string" ? v.codec_name : null,
    fps: parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate),
    audioCodec: typeof au?.codec_name === "string" ? au.codec_name : null,
    audioSampleRate: num(au?.sample_rate),
    hasAudio: Boolean(au),
    hasVideo: Boolean(v),
  };
}

export async function probeFile(path: string): Promise<MediaProbe> {
  const r = await runTool(env.videoScale.ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`ffprobe không đọc được tệp: ${r.stderr.slice(-400)}`);
  return parseProbe(r.stdout.toString("utf8"));
}

// ───────────────────────────── CHỮ TRÊN HÌNH ─────────────────────────────

/** Ngắt dòng theo từ, mỗi dòng ≤ `maxChars` ký tự, tối đa `maxLines` dòng (dư thì cắt, thêm "…"). Hàm THUẦN. */
export function wrapText(text: string, maxChars: number, maxLines = 3): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines.join("\n");
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.,;:!?…]*$/, "")}…`;
  return kept.join("\n");
}

/**
 * Đường dẫn phông trong bộ lọc: `\` ⇒ `/`, thoát `:` (ổ đĩa Windows), bọc nháy đơn. Tên tệp có nháy đơn bị TỪ CHỐI
 * thay vì cố thoát — đó là cấu hình máy, không phải dữ liệu người dùng. Hàm THUẦN.
 */
export function filterPath(p: string): string {
  if (p.includes("'")) throw new Error(`Đường dẫn phông có dấu nháy đơn: ${p}`);
  return `'${p.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}

// ───────────────────────────── KẾ HOẠCH DỰNG ─────────────────────────────

export type RenderClip = { file: string; durationSec: number; hasAudio: boolean };
export type RenderVoice = { file: string; durationSec: number } | null;

export type RenderInput = {
  clips: RenderClip[];
  /** Cùng độ dài với `clips`: chữ trên hình + lời đọc (phụ đề) + tệp giọng đọc (nếu có) của từng cảnh. */
  scenes: { overlay: string; subtitle: string; voice: RenderVoice }[];
  hook: string;
  cta: string;
  music: { file: string; volume: number } | null;
  keepNativeAudio: boolean;
  burnSubtitles: boolean;
  /** Chữ trên hình (móc câu · chữ cảnh · CTA). Vắng = có. */
  showText?: boolean;
  /** Kiểu chữ trên hình / phụ đề đã quy đổi (tệp font thật, hệ số cỡ, mã màu, nền, vị trí). Vắng = mặc định cũ. */
  textStyle?: RenderTextStyle;
  subStyle?: RenderTextStyle;
  /** Tên hiệu ứng `xfade` (vd "fade") + độ dài; `null` = cắt thẳng. */
  transition?: { xfade: string; seconds: number } | null;
  /** Chuỗi bộ lọc màu đã chọn từ bảng hằng (KHÔNG BAO GIỜ là chữ của người). Rỗng = không lọc. */
  colorFilter?: string;
  /** Tệp giọng đọc tự thu cho CẢ video — có thì thay giọng đọc từng cảnh. */
  voiceTrack?: { file: string; durationSec: number } | null;
  /** `ultrafast` cho bản xem trước (nhanh, nặng hơn); mặc định `veryfast`. */
  preset?: "veryfast" | "ultrafast";
  width: number;
  height: number;
  fontFile: string;
  output: string;
};

export type RenderPlan = { args: string[]; textFiles: { name: string; content: string }[]; totalSec: number; sceneStarts: number[] };

/** Kiểu chữ đã quy đổi sẵn cho bộ dựng — hàm thuần không đọc bảng hằng nào của cấu hình. */
export type RenderTextStyle = { fontFile: string; sizeK: number; colorHex: string; boxColor: string | null; y: number };

/** Giây CTA chiếm ở cuối video. */
export const CTA_SECONDS = 2.5;
/** Giây móc câu chiếm ở đầu video. */
export const HOOK_SECONDS = 2.8;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Số ký tự tối đa mỗi dòng cho cỡ chữ `sizePx` trên khung rộng `W` — hàm THUẦN. DejaVu Sans Bold rộng ~0,62 cỡ chữ mỗi ký tự
 * (chữ có dấu tiếng Việt cũng vậy); chừa 14% bề ngang cho viền nền và lề. Đo 28/09/2026 trên video thật: bản cũ cố định 24 ký tự
 * ở cỡ 50 ⇒ đúng 720 px, cộng viền nền là TRÀN hai mép ("lột chiếc đầm tạo điểm / hấn vòng eo…").
 */
export function lineChars(W: number, sizePx: number): number {
  return Math.max(8, Math.floor((W * 0.86) / (sizePx * 0.62)));
}

/**
 * Dựng tham số ffmpeg cho một bản hoàn chỉnh 9:16. Hàm THUẦN — mọi tệp đầu vào là đường dẫn đã có; tệp chữ trả về trong
 * `textFiles` để nơi gọi ghi vào `cwd` trước khi chạy.
 *
 * Âm thanh: âm gốc của clip (Veo luôn có) làm trục thời gian; giọng đọc từng cảnh đặt đúng mốc bắt đầu cảnh (tăng tốc
 * tối đa 1,35× nếu dài hơn cảnh, dư thì cắt); nhạc lặp tới hết video. Có giọng đọc / nhạc ⇒ âm gốc hạ còn 25%.
 */
export function buildRenderArgs(input: RenderInput): RenderPlan {
  const n = input.clips.length;
  if (n === 0) throw new Error("Không có clip nào để dựng.");
  if (input.scenes.length !== n) throw new Error("Số cảnh khác số clip.");
  const W = input.width;
  const H = input.height;
  const k = H / 1280;
  const args: string[] = ["-hide_banner", "-y"];
  for (const c of input.clips) args.push("-i", c.file);
  const voiceInputs: { sceneIndex: number; input: number; durationSec: number }[] = [];
  let nextInput = n;
  input.scenes.forEach((s, i) => {
    if (s.voice) {
      args.push("-i", s.voice.file);
      voiceInputs.push({ sceneIndex: i, input: nextInput, durationSec: s.voice.durationSec });
      nextInput += 1;
    }
  });
  let trackInput: number | null = null;
  if (input.voiceTrack) {
    args.push("-i", input.voiceTrack.file);
    trackInput = nextInput;
    nextInput += 1;
  }
  let musicInput: number | null = null;
  if (input.music) {
    args.push("-stream_loop", "-1", "-i", input.music.file);
    musicInput = nextInput;
    nextInput += 1;
  }

  // Chuyển cảnh: mỗi chỗ nối ăn mất `D` giây (hai cảnh chồng lên nhau) ⇒ mốc bắt đầu cảnh i = Σ độ dài trước − i·D.
  const D = input.transition && n > 1 ? Math.max(0.1, Math.min(input.transition.seconds, ...input.clips.map((c) => c.durationSec / 3))) : 0;
  const starts: number[] = [];
  let t = 0;
  input.clips.forEach((c, i) => {
    starts.push(r3(t - i * D));
    t += c.durationSec;
  });
  const total = r3(t - (n - 1) * D);
  const f: string[] = [];
  input.clips.forEach((c, i) => {
    const d = r3(c.durationSec);
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1,format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`);
    f.push(
      c.hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });
  if (D > 0 && input.transition) {
    // xfade: offset = lúc cảnh sau bắt đầu hiện, tính trên trục của chuỗi đã nối; âm thanh đan chéo cùng độ dài.
    let vPrev = "v0";
    let aPrev = "a0";
    for (let i = 1; i < n; i += 1) {
      const vOut = i === n - 1 ? "vc" : `xv${i}`;
      const aOut = i === n - 1 ? "ac" : `xa${i}`;
      f.push(`[${vPrev}][v${i}]xfade=transition=${input.transition.xfade}:duration=${r3(D)}:offset=${r3(starts[i])}[${vOut}]`);
      f.push(`[${aPrev}][a${i}]acrossfade=d=${r3(D)}:c1=tri:c2=tri[${aOut}]`);
      vPrev = vOut;
      aPrev = aOut;
    }
  } else {
    f.push(`${input.clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vc][ac]`);
  }
  const graded = input.colorFilter ? "vg" : "vc";
  if (input.colorFilter) f.push(`[vc]${input.colorFilter}[vg]`);

  // Chữ trên hình — mỗi đoạn một tệp, đi bằng tên tương đối trong `cwd`.
  const textFiles: { name: string; content: string }[] = [];
  const draws: string[] = [];
  const baseText: RenderTextStyle = input.textStyle ?? { fontFile: input.fontFile, sizeK: 1, colorHex: "FFFFFF", boxColor: "black@0.55", y: 0.6 };
  const baseSub: RenderTextStyle = input.subStyle ?? { fontFile: input.fontFile, sizeK: 1, colorHex: "FFFFFF", boxColor: null, y: 0.82 };
  const draw = (name: string, raw: string, opts: { size: number; style: RenderTextStyle; y: string; from: number; to: number; lines: number }) => {
    const size = Math.round(opts.size * k * opts.style.sizeK);
    const content = wrapText(raw, lineChars(W, size), opts.lines);
    if (!content.trim()) return;
    textFiles.push({ name, content });
    // Viền chữ tương phản với MÀU CHỮ (chữ tối ⇒ viền sáng) — không nền vẫn đọc được trên mọi cảnh.
    const dark = parseInt(opts.style.colorHex.slice(0, 2), 16) + parseInt(opts.style.colorHex.slice(2, 4), 16) + parseInt(opts.style.colorHex.slice(4, 6), 16) < 200;
    const box = opts.style.boxColor ? `:box=1:boxcolor=${opts.style.boxColor}:boxborderw=${Math.round(18 * k)}` : "";
    draws.push(
      `drawtext=fontfile=${filterPath(opts.style.fontFile)}:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=0x${opts.style.colorHex}:borderw=${Math.max(2, Math.round(3 * k))}:bordercolor=${dark ? "white@0.85" : "black@0.85"}:line_spacing=${Math.round(10 * k)}:x=(w-text_w)/2:y=${opts.y}${box}:enable='between(t,${r3(opts.from)},${r3(opts.to)})'`,
    );
  };
  const hookEnd = Math.min(HOOK_SECONDS, total);
  const ctaStart = Math.max(0, total - CTA_SECONDS);
  const ends = starts.map((st, i) => Math.min(r3(st + input.clips[i].durationSec), total));
  // Mặc định chữ lớn ở ≈ 60% chiều cao: ảnh thời trang dọc có mặt người mẫu ở phần trên — chữ đè lên mặt là video hỏng.
  const text = input.showText !== false;
  const ty = `h*${r3(baseText.y)}`;
  if (text) draw("hook.txt", input.hook, { size: 52, style: baseText, y: ty, from: 0, to: hookEnd, lines: 3 });
  input.scenes.forEach((s, i) => {
    const from = i === 0 ? hookEnd : starts[i];
    const to = Math.min(i === n - 1 ? ctaStart : ends[i], total);
    if (text && to - from > 0.4) draw(`overlay${i}.txt`, s.overlay, { size: 46, style: baseText, y: ty, from, to, lines: 3 });
    if (input.burnSubtitles) draw(`sub${i}.txt`, s.subtitle, { size: 36, style: baseSub, y: `h*${r3(baseSub.y)}`, from: starts[i], to: ends[i], lines: 2 });
  });
  if (text) draw("cta.txt", input.cta, { size: 58, style: baseText, y: "(h-text_h)/2", from: ctaStart, to: total, lines: 2 });
  f.push(draws.length ? `[${graded}]${draws.join(",")}[vout]` : `[${graded}]null[vout]`);

  // Âm thanh.
  const hasExtra = voiceInputs.length > 0 || musicInput !== null || trackInput !== null;
  const nativeVol = input.keepNativeAudio ? (hasExtra ? 0.25 : 1) : 0;
  f.push(`[ac]volume=${nativeVol}[an]`);
  const mix = ["[an]"];
  for (const v of voiceInputs) {
    const sceneDur = input.clips[v.sceneIndex].durationSec;
    const tempo = v.durationSec > sceneDur * 0.95 ? Math.min(1.35, v.durationSec / (sceneDur * 0.95)) : 1;
    const delay = Math.round(starts[v.sceneIndex] * 1000);
    f.push(`[${v.input}:a]aresample=48000,aformat=channel_layouts=stereo,atempo=${r3(tempo)},atrim=duration=${r3(sceneDur)},adelay=${delay}|${delay}[vo${v.sceneIndex}]`);
    mix.push(`[vo${v.sceneIndex}]`);
  }
  if (trackInput !== null) {
    // Giọng tự thu đặt ở giây 0, dài quá video thì cắt; ngắn hơn thì phần sau im (không kéo giãn giọng người).
    f.push(`[${trackInput}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},asetpts=PTS-STARTPTS[vt]`);
    mix.push("[vt]");
  }
  if (musicInput !== null && input.music) {
    f.push(`[${musicInput}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},volume=${r3(input.music.volume)}[mu]`);
    mix.push("[mu]");
  }
  f.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]` : `[an]anull[aout]`);

  args.push(
    "-filter_complex",
    f.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    input.preset ?? "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-threads",
    "2",
    "-t",
    String(total),
    input.output,
  );
  return { args, textFiles, totalSec: total, sceneStarts: starts };
}

/** Tham số cắt MỘT khung hình JPEG ở giây `at` (ảnh bìa / khung cho QC). Hàm THUẦN. */
export function frameArgs(input: string, at: number, output: string, height = 0): string[] {
  const vf = height > 0 ? ["-vf", `scale=-2:${height}`] : [];
  return ["-hide_banner", "-y", "-ss", String(r3(Math.max(0, at))), "-i", input, "-frames:v", "1", ...vf, "-q:v", "3", output];
}

/** Mốc lấy khung cho QC: `count` điểm cách đều, tránh 0,3 giây đầu / cuối. Hàm THUẦN. */
export function qcFrameTimes(durationSec: number, count = 4): number[] {
  if (!(durationSec > 0)) return [];
  const pad = Math.min(0.3, durationSec / 10);
  const span = durationSec - 2 * pad;
  return Array.from({ length: count }, (_, i) => r3(pad + (span * (i + 0.5)) / count));
}

/**
 * Clip GIẢ cho bộ sinh `FAKE` (chỉ ngoài production): ảnh gốc + chuyển động phóng chậm + âm câm. Hàm THUẦN dựng tham số.
 */
export function fakeClipArgs(image: string, seconds: number, W: number, H: number, output: string): string[] {
  return [
    "-hide_banner",
    "-y",
    "-loop",
    "1",
    "-i",
    image,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    String(seconds),
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='min(zoom+0.0012,1.15)':d=1:s=${W}x${H}:fps=24,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-shortest",
    output,
  ];
}

/**
 * CẢNH ẢNH ĐỘNG từ ảnh sản phẩm thật — MIỄN PHÍ, không AI, không bao giờ sai màu / sai dáng. Ảnh (thường vuông hoặc 3:4) nằm
 * GIỮA khung 9:16 trên nền là CHÍNH ảnh ấy phóng to làm mờ; chuyển động chậm đổi kiểu theo cảnh để video không lặp:
 * 0 = phóng dần vào · 1 = lùi dần ra · 2 = lướt ngang. Âm thanh câm 48 kHz (hậu kỳ trộn giọng đọc / nhạc). Hàm THUẦN.
 */
export function photoMotionArgs(image: string, seconds: number, W: number, H: number, output: string, style: number): string[] {
  const frames = Math.max(1, Math.round(seconds * 24));
  const z = style % 3 === 0 ? `min(1+0.10*on/${frames},1.10)` : style % 3 === 1 ? `max(1.10-0.10*on/${frames},1.0)` : "1.08";
  const x = style % 3 === 2 ? `(iw-iw/zoom)*on/${frames}` : "iw/2-(iw/zoom/2)";
  const graph = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,setsar=1[bg]`,
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=24,format=yuv420p[v]`,
  ].join(";");
  return [
    "-hide_banner",
    "-y",
    "-loop",
    "1",
    "-framerate",
    "24",
    "-i",
    image,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    output,
  ];
}
