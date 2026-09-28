"use client";

import { Loader2, Pencil, Wand2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { rerenderVideoAction } from "@/lib/actions/video-scale";
import { MUSIC_VOLUMES, SCRIPT_LIMITS, TTS_VOICES, type EffectiveRender, type VideoScript } from "@/lib/constants/video-scale";

function Count({ n, max }: { n: number; max: number }) {
  return <span className={n > max ? "text-destructive" : "text-muted-foreground"}>{n}/{max}</span>;
}

/**
 * SỬA VIDEO — dựng lại từ các clip ĐÃ CÓ (không tạo clip AI mới): chữ trên hình, lời đọc + giọng, phụ đề, nhạc + âm lượng, âm
 * gốc. Máy chủ kiểm lại chữ bằng CÙNG bộ kiểm của kịch bản (giá, size, màu, chất liệu, khuyến mãi) rồi xếp việc dựng; video
 * quay lại "Chờ duyệt". Tiền: dựng lại miễn phí; giọng đọc mới cho cảnh ĐỔI lời ≈ 0,015 USD / phút; kiểm chất lượng ≈ 0,01 USD.
 */
export function VideoEditor({ variantId, script, render, music, approved }: { variantId: string; script: VideoScript; render: EffectiveRender; music: { id: string; title: string }[]; approved: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [hook, setHook] = useState(script.hook);
  const [cta, setCta] = useState(script.cta);
  const [scenes, setScenes] = useState(script.scenes.map((s) => ({ overlay: s.overlay, voiceover: s.voiceover })));
  const [showText, setShowText] = useState(render.showText);
  const [voiceover, setVoiceover] = useState(render.voiceover);
  const [voice, setVoice] = useState(render.voice);
  const [subs, setSubs] = useState(render.burnSubtitles);
  const [native, setNative] = useState(render.keepNativeAudio);
  const [musicId, setMusicId] = useState<string>(render.musicId ?? "");
  const [volume, setVolume] = useState(render.musicVolume);
  const setScene = (i: number, k: "overlay" | "voiceover", val: string) => setScenes((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  const L = SCRIPT_LIMITS;

  const submit = () => {
    if (approved && !confirm("Video đã duyệt sẽ quay lại CHỜ DUYỆT sau khi dựng lại. Tiếp tục?")) return;
    start(async () => {
      const r = await rerenderVideoAction({
        variantId,
        hook,
        cta,
        scenes,
        options: { showText, voiceover, voice, burnSubtitles: subs, keepNativeAudio: native, musicId: musicId || null, musicVolume: volume },
      });
      if ("error" in r) return void toast.error(r.error);
      toast.success(r.tts ? `Đang tạo ${r.tts} đoạn giọng đọc mới rồi dựng lại — theo dõi ở tab Hàng đợi render.` : "Đang dựng lại video — theo dõi ở tab Hàng đợi render (khoảng 1 phút).");
      setOpen(false);
    });
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="size-4" /> Sửa video (chữ · giọng đọc · phụ đề · nhạc)
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-[12.5px]">
      <p className="text-muted-foreground">Dựng lại từ các clip ĐÃ CÓ — không tạo clip AI mới. Chữ mới được kiểm như kịch bản (giá, size, màu, chất liệu, khuyến mãi).</p>

      <fieldset className="space-y-2">
        <legend className="font-semibold">Chữ trên hình</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /> Hiện chữ trên hình (móc câu · chữ từng cảnh · CTA)
        </label>
        {showText ? (
          <>
            <label className="grid gap-1">
              <span className="flex justify-between">
                Móc câu (0–3 giây đầu) <Count n={hook.length} max={L.hookMaxChars} />
              </span>
              <Input value={hook} onChange={(e) => setHook(e.target.value)} />
            </label>
            {scenes.map((s, i) => (
              <label key={i} className="grid gap-1">
                <span className="flex justify-between">
                  Chữ cảnh {i + 1} <Count n={s.overlay.length} max={L.overlayMaxChars} />
                </span>
                <Input value={s.overlay} onChange={(e) => setScene(i, "overlay", e.target.value)} placeholder="Để trống = không chữ ở cảnh này" />
              </label>
            ))}
            <label className="grid gap-1">
              <span className="flex justify-between">
                CTA (cuối video) <Count n={cta.length} max={L.ctaMaxChars} />
              </span>
              <Input value={cta} onChange={(e) => setCta(e.target.value)} />
            </label>
          </>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-semibold">Giọng đọc &amp; phụ đề</legend>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={voiceover} onChange={(e) => setVoiceover(e.target.checked)} /> Chèn giọng đọc (AI)
          </label>
          <select className="h-8 rounded border px-2" value={voice} disabled={!voiceover} onChange={(e) => setVoice(e.target.value)} aria-label="Giọng">
            {TTS_VOICES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} /> Phụ đề (chữ của lời đọc)
          </label>
        </div>
        {voiceover || subs ? (
          scenes.map((s, i) => (
            <label key={i} className="grid gap-1">
              <span className="flex justify-between">
                Lời đọc cảnh {i + 1} <Count n={s.voiceover.length} max={L.voiceoverMaxCharsPerScene} />
              </span>
              <Textarea rows={2} value={s.voiceover} onChange={(e) => setScene(i, "voiceover", e.target.value)} placeholder="Câu đọc ngắn, vừa độ dài cảnh" />
            </label>
          ))
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-semibold">Âm thanh</legend>
        <div className="flex flex-wrap items-center gap-3">
          <select className="h-8 rounded border px-2" value={musicId} onChange={(e) => setMusicId(e.target.value)} aria-label="Nhạc nền">
            <option value="">Không nhạc nền</option>
            {music.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          <select className="h-8 rounded border px-2" value={volume} disabled={!musicId} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Âm lượng nhạc">
            {MUSIC_VOLUMES.map((x) => (
              <option key={x} value={x}>
                Nhạc {Math.round(x * 100)}%
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={native} onChange={(e) => setNative(e.target.checked)} /> Giữ âm thanh gốc của clip
          </label>
        </div>
        {music.length === 0 ? <p className="text-muted-foreground">Thư viện nhạc trống — tải nhạc CÓ QUYỀN ở tab Cấu hình → Thư viện nhạc.</p> : null}
      </fieldset>

      <p className="text-muted-foreground">Chi phí: dựng lại miễn phí · giọng đọc mới chỉ cho cảnh đổi lời (≈ 0,015 USD / phút) · kiểm chất lượng ≈ 0,01 USD.</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={submit}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Dựng lại video
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Đóng
        </Button>
      </div>
    </div>
  );
}
