"use client";

import { ArrowDown, ArrowUp, Copy, ImageIcon, Loader2, Mic, Pencil, Square, Trash2, Upload, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cloneVideoAction, loadVideoPhotosAction, rerenderVideoAction, uploadVideoVoiceAction } from "@/lib/actions/video-scale";
import {
  MUSIC_VOLUMES,
  SCRIPT_LIMITS,
  TEXT_BOXES,
  TEXT_COLORS,
  TEXT_SIZES,
  TEXT_Y_MAX,
  TEXT_Y_MIN,
  TTS_VOICES,
  VIDEO_COLOR_FILTERS,
  VIDEO_FONTS,
  VIDEO_TRANSITIONS,
  type EffectiveRender,
  type TextStyle,
  type VideoColorFilter,
  type VideoFont,
  type VideoScript,
  type VideoTransition,
} from "@/lib/constants/video-scale";
import type { SourcePhoto } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";

const SELECT = "h-8 rounded-md border border-input bg-background px-2 text-foreground";
const asset = (id: string) => `/api/video-scale/assets/${id}`;
const photoUrl = (imageId: string) => `/api/creative/images/${imageId}`;
const VOICE_MAX_BYTES = 4 * 1024 * 1024;

/** Font trình duyệt GẦN giống font dựng (DejaVu) — chỉ để xem trước. */
const FONT_CSS: Record<VideoFont, CSSProperties> = {
  SANS_BOLD: { fontFamily: '"DejaVu Sans", Verdana, sans-serif', fontWeight: 700 },
  SANS: { fontFamily: '"DejaVu Sans", Verdana, sans-serif', fontWeight: 400 },
  SERIF_BOLD: { fontFamily: '"DejaVu Serif", Georgia, serif', fontWeight: 700 },
  CONDENSED_BOLD: { fontFamily: '"DejaVu Sans Condensed", "Arial Narrow", sans-serif', fontWeight: 700, fontStretch: "condensed" },
};

function boxCss(box: TextStyle["box"]): CSSProperties {
  const c = TEXT_BOXES[box].color;
  if (!c) return {};
  const [name, alpha] = c.split("@");
  const rgb = name === "black" ? "0,0,0" : name === "white" ? "255,255,255" : [2, 4, 6].map((i) => parseInt(name.slice(i, i + 2), 16)).join(",");
  return { background: `rgba(${rgb},${Number(alpha ?? 1)})`, padding: "0.15em 0.35em", borderRadius: 2 };
}

function textCss(style: TextStyle, basePx: number, scale: number): CSSProperties {
  const hex = TEXT_COLORS[style.color].hex;
  const dark = parseInt(hex.slice(0, 2), 16) + parseInt(hex.slice(2, 4), 16) + parseInt(hex.slice(4, 6), 16) < 200;
  const edge = dark ? "rgba(255,255,255,.85)" : "rgba(0,0,0,.85)";
  return {
    ...FONT_CSS[style.font],
    ...boxCss(style.box),
    color: `#${hex}`,
    fontSize: Math.max(8, basePx * scale * TEXT_SIZES[style.size].k),
    lineHeight: 1.25,
    textShadow: `0 0 2px ${edge}, 0 0 2px ${edge}, 1px 1px 0 ${edge}, -1px -1px 0 ${edge}`,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  };
}

function Count({ n, max }: { n: number; max: number }) {
  return <span className={n > max ? "text-destructive" : "text-muted-foreground"}>{n}/{max}</span>;
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn("rounded-full border px-2.5 py-1 text-[12px] transition-colors", active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-muted")}
    >
      {children}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-md border bg-background p-2.5">
      <p className="font-semibold">{title}</p>
      {children}
    </div>
  );
}

/** Bộ chỉnh MỘT kiểu chữ: font · cỡ · màu · nền · vị trí dọc. */
function StyleControls({ label, value, onChange }: { label: string; value: TextStyle; onChange: (v: TextStyle) => void }) {
  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => onChange({ ...value, [k]: v });
  return (
    <Panel title={label}>
      <div className="flex flex-wrap items-center gap-2">
        <select className={SELECT} value={value.font} onChange={(e) => set("font", e.target.value as VideoFont)} aria-label={`Font — ${label}`}>
          {(Object.keys(VIDEO_FONTS) as VideoFont[]).map((k) => (
            <option key={k} value={k}>
              {VIDEO_FONTS[k].label}
            </option>
          ))}
        </select>
        {(Object.keys(TEXT_SIZES) as TextStyle["size"][]).map((k) => (
          <Chip key={k} active={value.size === k} onClick={() => set("size", k)}>
            {TEXT_SIZES[k].label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Màu:</span>
        {(Object.keys(TEXT_COLORS) as TextStyle["color"][]).map((k) => (
          <button
            key={k}
            type="button"
            title={TEXT_COLORS[k].label}
            aria-label={`Màu ${TEXT_COLORS[k].label}`}
            onClick={() => set("color", k)}
            className={cn("size-6 rounded-full border-2", value.color === k ? "border-primary ring-2 ring-primary/40" : "border-border")}
            style={{ background: `#${TEXT_COLORS[k].hex}` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">Nền chữ:</span>
        {(Object.keys(TEXT_BOXES) as TextStyle["box"][]).map((k) => (
          <Chip key={k} active={value.box === k} onClick={() => set("box", k)}>
            {TEXT_BOXES[k].label}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Vị trí:</span>
        {[
          { l: "Trên", y: 0.12 },
          { l: "Giữa", y: 0.45 },
          { l: "Dưới", y: 0.78 },
        ].map((p) => (
          <Chip key={p.l} active={Math.abs(value.y - p.y) < 0.02} onClick={() => set("y", p.y)}>
            {p.l}
          </Chip>
        ))}
        <input type="range" className="w-36 accent-primary" min={TEXT_Y_MIN} max={TEXT_Y_MAX} step={0.01} value={value.y} onChange={(e) => set("y", Number(e.target.value))} aria-label={`Vị trí dọc — ${label}`} />
        <span className="tabular-nums text-muted-foreground">{Math.round(value.y * 100)}%</span>
      </div>
    </Panel>
  );
}

type Scene = { overlay: string; voiceover: string };

/** Xem trước 9:16: clip của cảnh đang chọn + chữ / phụ đề / màu GẦN ĐÚNG (bản dựng thật do ffmpeg làm). Bấm vào khung = đặt vị trí. */
function Preview(props: {
  clip: string | null;
  poster: string | null;
  filter: VideoColorFilter;
  showText: boolean;
  text: string;
  textStyle: TextStyle;
  subs: boolean;
  sub: string;
  subStyle: TextStyle;
  target: "text" | "sub";
  onPlace: (y: number) => void;
}) {
  const scale = 216 / 720;
  const css = { filter: VIDEO_COLOR_FILTERS[props.filter].css };
  return (
    <div className="space-y-1">
      <div
        className="relative aspect-[9/16] w-[216px] cursor-crosshair overflow-hidden rounded-md bg-black"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          props.onPlace(Math.min(TEXT_Y_MAX, Math.max(TEXT_Y_MIN, Math.round(((e.clientY - r.top) / r.height) * 100) / 100)));
        }}
        title="Bấm vào khung để đặt vị trí chữ đang chọn"
      >
        {props.clip ? (
          <video key={props.clip} src={asset(props.clip)} poster={props.poster ?? undefined} className="size-full object-cover" style={css} muted autoPlay loop playsInline />
        ) : props.poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền
          <img src={props.poster} alt="" className="size-full object-cover" style={css} />
        ) : null}
        {props.showText && props.text ? (
          <div className="pointer-events-none absolute inset-x-2 text-center" style={{ top: `${props.textStyle.y * 100}%` }}>
            <span style={textCss(props.textStyle, 46, scale)}>{props.text}</span>
          </div>
        ) : null}
        {props.subs && props.sub ? (
          <div className="pointer-events-none absolute inset-x-2 text-center" style={{ top: `${props.subStyle.y * 100}%` }}>
            <span style={textCss(props.subStyle, 36, scale)}>{props.sub}</span>
          </div>
        ) : null}
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[10px] text-white">Bấm để đặt: {props.target === "text" ? "chữ trên hình" : "phụ đề"}</span>
      </div>
      <p className="max-w-[216px] text-[11px] text-muted-foreground">Xem trước gần đúng — font, màu, vị trí khớp bản dựng; chuyển cảnh chỉ thấy ở video dựng xong.</p>
    </div>
  );
}

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

const VOICE_TYPES = ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/x-m4a", "audio/webm", "audio/ogg"] as const;
type VoiceType = (typeof VOICE_TYPES)[number];
function voiceTypeOf(t: string): VoiceType | null {
  const base = t.split(";")[0].trim().toLowerCase();
  const alias: Record<string, VoiceType> = { "audio/mp3": "audio/mpeg", "audio/x-mp3": "audio/mpeg", "audio/m4a": "audio/x-m4a", "video/webm": "audio/webm" };
  return (VOICE_TYPES as readonly string[]).includes(base) ? (base as VoiceType) : (alias[base] ?? null);
}

/** Tải tệp / thu âm giọng đọc tự thu → lưu tệp, trả mã tệp. Chưa dựng: người bấm "Dựng lại" như mọi chỉnh sửa khác. */
function VoiceTrack({ variantId, value, onChange }: { variantId: string; value: string | null; onChange: (id: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const upload = async (blob: Blob) => {
    const type = voiceTypeOf(blob.type);
    if (!type) return void toast.error(`Định dạng ${blob.type || "lạ"} chưa nhận — dùng mp3, m4a, wav hoặc thu âm tại đây.`);
    if (blob.size > VOICE_MAX_BYTES) return void toast.error("Tệp giọng tối đa 4 MB (≈ 2 phút mp3).");
    setBusy(true);
    try {
      const r = await uploadVideoVoiceAction({ variantId, contentType: type, base64: await readBase64(blob) });
      if ("error" in r) return void toast.error(r.error);
      onChange(r.assetId);
      toast.success('Đã lưu giọng tự thu — bấm "Dựng lại video" để ghép vào.');
    } finally {
      setBusy(false);
    }
  };
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const m = new MediaRecorder(stream);
      chunks.current = [];
      m.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      m.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void upload(new Blob(chunks.current, { type: m.mimeType || "audio/webm" }));
      };
      m.start();
      rec.current = m;
      setRecording(true);
    } catch {
      toast.error("Trình duyệt không cho dùng micro — cho phép micro hoặc tải tệp lên.");
    }
  };
  const stopRec = () => {
    rec.current?.stop();
    setRecording(false);
  };
  useEffect(() => () => rec.current?.stream.getTracks().forEach((t) => t.stop()), []);
  return (
    <Panel title="Giọng tự thu (thay giọng AI)">
      <p className="text-muted-foreground">Đọc lời của bạn cho cả video — đặt từ giây 0, dài hơn video thì cắt. Có giọng tự thu thì KHÔNG trộn giọng AI.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 hover:bg-muted", busy && "pointer-events-none opacity-50")}>
          <Upload className="size-4" /> Tải tệp
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </label>
        {recording ? (
          <Button size="sm" variant="destructive" onClick={stopRec}>
            <Square className="size-4" /> Dừng thu
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void startRec()}>
            <Mic className="size-4" /> Thu âm
          </Button>
        )}
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {value ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            <Trash2 className="size-4" /> Bỏ giọng tự thu
          </Button>
        ) : null}
      </div>
      {value ? <audio controls src={asset(value)} className="h-8 w-full" /> : null}
    </Panel>
  );
}

/**
 * SỬA VIDEO — dựng lại từ các clip ĐÃ CÓ (không tạo clip AI mới): chữ + kiểu chữ + vị trí, phụ đề, thứ tự / bỏ / đổi cảnh (ảnh
 * sản phẩm thật), chuyển cảnh, bộ lọc màu, nhạc, giọng AI hoặc giọng tự thu. Máy chủ kiểm lại chữ bằng CÙNG bộ kiểm của kịch bản
 * rồi xếp việc dựng; video quay lại "Chờ duyệt". Tiền: dựng lại + đổi cảnh bằng ảnh miễn phí; giọng AI mới cho cảnh ĐỔI lời
 * ≈ 0,015 USD / phút; kiểm chất lượng ≈ 0,01 USD.
 */
export function VideoEditor({
  variantId,
  productId,
  script,
  render,
  music,
  approved,
  sceneClips,
  posterUrl,
}: {
  variantId: string;
  productId: string;
  script: VideoScript;
  render: EffectiveRender;
  music: { id: string; title: string; assetId: string }[];
  approved: boolean;
  sceneClips: (string | null)[];
  posterUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [hook, setHook] = useState(script.hook);
  const [cta, setCta] = useState(script.cta);
  const [scenes, setScenes] = useState<Scene[]>(script.scenes.map((s) => ({ overlay: s.overlay, voiceover: s.voiceover })));
  const [showText, setShowText] = useState(render.showText);
  const [voiceover, setVoiceover] = useState(render.voiceover);
  const [voice, setVoice] = useState(render.voice);
  const [subs, setSubs] = useState(render.burnSubtitles);
  const [native, setNative] = useState(render.keepNativeAudio);
  const [musicId, setMusicId] = useState<string>(render.musicId ?? "");
  const [volume, setVolume] = useState(render.musicVolume);
  const [textStyle, setTextStyle] = useState<TextStyle>(render.text);
  const [subStyle, setSubStyle] = useState<TextStyle>(render.sub);
  const [transition, setTransition] = useState<VideoTransition>(render.transition);
  const [filter, setFilter] = useState<VideoColorFilter>(render.filter);
  const [order, setOrder] = useState<number[]>(render.sceneOrder ?? script.scenes.map((_, i) => i));
  const [voiceAssetId, setVoiceAssetId] = useState<string | null>(render.voiceAssetId);
  const [replace, setReplace] = useState<Record<number, SourcePhoto>>({});
  const [photos, setPhotos] = useState<SourcePhoto[] | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [target, setTarget] = useState<"text" | "sub">("text");
  const setScene = (i: number, k: keyof Scene, val: string) => setScenes((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  const L = SCRIPT_LIMITS;
  const n = script.scenes.length;

  const move = (pos: number, d: -1 | 1) =>
    setOrder((o) => {
      const j = pos + d;
      if (j < 0 || j >= o.length) return o;
      const x = [...o];
      [x[pos], x[j]] = [x[j], x[pos]];
      return x;
    });
  const toggleScene = (i: number) =>
    setOrder((o) => {
      if (o.includes(i)) return o.length > 1 ? o.filter((x) => x !== i) : o;
      return [...o, i];
    });
  const openPicker = (i: number) => {
    setPicking(i);
    if (photos) return;
    void loadVideoPhotosAction({ id: productId }).then((r) => {
      if ("error" in r) return void toast.error(r.error);
      setPhotos(r.photos);
    });
  };
  const unreplace = (i: number) =>
    setReplace((r) => {
      const next = { ...r };
      delete next[i];
      return next;
    });

  const payload = () => ({
    variantId,
    hook,
    cta,
    scenes,
    options: {
      showText,
      voiceover,
      voice,
      burnSubtitles: subs,
      keepNativeAudio: native,
      musicId: musicId || null,
      musicVolume: volume,
      text: textStyle,
      sub: subStyle,
      transition,
      filter,
      sceneOrder: order.length === n && order.every((x, i) => x === i) ? undefined : order,
      voiceAssetId,
    },
    replacePhotos: Object.entries(replace).map(([scene, p]) => ({ scene: Number(scene), sourceId: p.id })),
  });
  const clone = () =>
    start(async () => {
      const r = await cloneVideoAction(payload());
      if ("error" in r) return void toast.error(r.error);
      toast.success("Đã tạo video MỚI từ clip sẵn có (không tạo clip AI mới) — xem ở tab Hàng đợi render, khoảng 1 phút.");
      setOpen(false);
    });
  const submit = () => {
    if (approved && !confirm("Video đã duyệt sẽ quay lại CHỜ DUYỆT sau khi dựng lại. Tiếp tục?")) return;
    start(async () => {
      const r = await rerenderVideoAction(payload());
      if ("error" in r) return void toast.error(r.error);
      const photoScenes = Object.keys(replace).length;
      const extra = [r.tts ? `${r.tts} đoạn giọng AI mới` : "", photoScenes ? `${photoScenes} cảnh ảnh động` : ""].filter(Boolean).join(" + ");
      toast.success(extra ? `Đang tạo ${extra} rồi dựng lại — theo dõi ở tab Hàng đợi render.` : "Đang dựng lại video — theo dõi ở tab Hàng đợi render (khoảng 1 phút).");
      setOpen(false);
    });
  };

  const activeScene = order.includes(active) ? active : (order[0] ?? 0);
  const previewText = activeScene === order[0] && hook ? hook : (scenes[activeScene]?.overlay ?? "");
  const place = (y: number) => (target === "text" ? setTextStyle((s) => ({ ...s, y })) : setSubStyle((s) => ({ ...s, y })));
  const musicAsset = music.find((m) => m.id === musicId)?.assetId ?? null;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="size-4" /> Sửa video (chữ · cảnh · giọng · nhạc · màu)
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Sửa video</DialogTitle>
            <DialogDescription>Dựng lại từ các clip ĐÃ CÓ — không tạo clip AI mới. Chữ mới được kiểm như kịch bản (giá, size, màu, chất liệu, khuyến mãi).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 text-[12.5px] md:grid-cols-[232px_minmax(0,1fr)]">
            <div className="md:sticky md:top-0 md:self-start">
              <Preview
                clip={replace[activeScene] ? null : (sceneClips[activeScene] ?? null)}
                poster={replace[activeScene] ? photoUrl(replace[activeScene].imageId) : posterUrl}
                filter={filter}
                showText={showText}
                text={previewText}
                textStyle={textStyle}
                subs={subs}
                sub={scenes[activeScene]?.voiceover ?? ""}
                subStyle={subStyle}
                target={target}
                onPlace={place}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="text-muted-foreground">Cảnh:</span>
                {order.map((i, pos) => (
                  <Chip key={i} active={i === activeScene} onClick={() => setActive(i)} title={`Xem cảnh gốc ${i + 1}`}>
                    {pos + 1}
                  </Chip>
                ))}
              </div>
            </div>

            <Tabs defaultValue="text" className="min-w-0">
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="text">Chữ &amp; phụ đề</TabsTrigger>
                <TabsTrigger value="scenes">Cảnh &amp; chuyển cảnh</TabsTrigger>
                <TabsTrigger value="audio">Âm thanh &amp; giọng</TabsTrigger>
                <TabsTrigger value="look">Màu &amp; hiệu ứng</TabsTrigger>
              </TabsList>

              <TabsContent value="text" className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /> Chữ trên hình
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} /> Phụ đề (chữ của lời đọc)
                  </label>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">Bấm khung xem trước để đặt:</span>
                    <Chip active={target === "text"} onClick={() => setTarget("text")}>
                      Chữ trên hình
                    </Chip>
                    <Chip active={target === "sub"} onClick={() => setTarget("sub")}>
                      Phụ đề
                    </Chip>
                  </span>
                </div>
                <div className="grid gap-2 xl:grid-cols-2">
                  {showText ? <StyleControls label="Kiểu chữ trên hình" value={textStyle} onChange={setTextStyle} /> : null}
                  {subs ? <StyleControls label="Kiểu phụ đề" value={subStyle} onChange={setSubStyle} /> : null}
                </div>
                {showText ? (
                  <label className="grid gap-1">
                    <span className="flex justify-between">
                      Móc câu (0–3 giây đầu) <Count n={hook.length} max={L.hookMaxChars} />
                    </span>
                    <Input value={hook} onChange={(e) => setHook(e.target.value)} />
                  </label>
                ) : null}
                {scenes.map((s, i) => (
                  <div key={i} className={cn("grid gap-1.5 rounded-md border p-2", i === activeScene && "border-primary", !order.includes(i) && "opacity-50")} onFocus={() => setActive(i)}>
                    <p className="font-medium">
                      Cảnh {i + 1}
                      {order.includes(i) ? "" : " (đã bỏ khỏi video)"}
                    </p>
                    {showText ? (
                      <label className="grid gap-1">
                        <span className="flex justify-between">
                          Chữ trên hình <Count n={s.overlay.length} max={L.overlayMaxChars} />
                        </span>
                        <Input value={s.overlay} onChange={(e) => setScene(i, "overlay", e.target.value)} placeholder="Để trống = không chữ ở cảnh này" />
                      </label>
                    ) : null}
                    {voiceover || subs ? (
                      <label className="grid gap-1">
                        <span className="flex justify-between">
                          Lời đọc / phụ đề <Count n={s.voiceover.length} max={L.voiceoverMaxCharsPerScene} />
                        </span>
                        <Textarea rows={2} value={s.voiceover} onChange={(e) => setScene(i, "voiceover", e.target.value)} placeholder="Câu đọc ngắn, vừa độ dài cảnh" />
                      </label>
                    ) : null}
                  </div>
                ))}
                {showText ? (
                  <label className="grid gap-1">
                    <span className="flex justify-between">
                      CTA (cuối video, giữa khung) <Count n={cta.length} max={L.ctaMaxChars} />
                    </span>
                    <Input value={cta} onChange={(e) => setCta(e.target.value)} />
                  </label>
                ) : null}
              </TabsContent>

              <TabsContent value="scenes" className="space-y-3 pt-2">
                <p className="text-muted-foreground">Sắp lại thứ tự bằng ↑ ↓, bỏ cảnh xấu (còn ít nhất 1 cảnh), hoặc đổi cảnh bằng ẢNH SẢN PHẨM thật (ảnh động, miễn phí).</p>
                <ol className="space-y-2">
                  {order.map((i, pos) => (
                    <li key={i} className={cn("flex flex-wrap items-center gap-2 rounded-md border p-2", i === activeScene && "border-primary")}>
                      <button type="button" className="shrink-0" onClick={() => setActive(i)} title="Xem cảnh này">
                        {replace[i] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền
                          <img src={photoUrl(replace[i].imageId)} alt="" className="h-16 w-9 rounded object-cover" />
                        ) : sceneClips[i] ? (
                          <video src={`${asset(sceneClips[i] as string)}#t=0.5`} preload="metadata" muted playsInline className="h-16 w-9 rounded bg-black object-cover" />
                        ) : (
                          <span className="flex h-16 w-9 items-center justify-center rounded bg-muted text-[10px]">—</span>
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {pos + 1}. Cảnh gốc {i + 1}
                          {replace[i] ? <span className="ml-1 text-primary">→ ảnh động</span> : null}
                        </p>
                        <p className="truncate text-muted-foreground">{scenes[i].overlay || scenes[i].voiceover || "—"}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="size-7" disabled={pos === 0} onClick={() => move(pos, -1)} aria-label="Đưa cảnh lên">
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="size-7" disabled={pos === order.length - 1} onClick={() => move(pos, 1)} aria-label="Đưa cảnh xuống">
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openPicker(i)}>
                          <ImageIcon className="size-4" /> Đổi cảnh
                        </Button>
                        <Button size="icon" variant="ghost" className="size-7" disabled={order.length <= 1} onClick={() => toggleScene(i)} aria-label="Bỏ cảnh khỏi video" title="Bỏ cảnh khỏi video">
                          <X className="size-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
                {order.length < n ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Cảnh đã bỏ:</span>
                    {script.scenes.map((_, i) =>
                      order.includes(i) ? null : (
                        <Chip key={i} active={false} onClick={() => toggleScene(i)}>
                          + Cảnh {i + 1}
                        </Chip>
                      ),
                    )}
                  </div>
                ) : null}
                {picking !== null ? (
                  <Panel title={`Chọn ảnh sản phẩm cho cảnh ${picking + 1}`}>
                    {!photos ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : photos.length === 0 ? (
                      <p className="text-muted-foreground">Mã này chưa có ảnh sản phẩm trong Nguồn ảnh.</p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                        {photos.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            title={p.title}
                            className={cn("overflow-hidden rounded border-2", replace[picking]?.id === p.id ? "border-primary" : "border-transparent hover:border-muted-foreground")}
                            onClick={() => {
                              setReplace((r) => ({ ...r, [picking]: p }));
                              setActive(picking);
                              setPicking(null);
                            }}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền */}
                            <img src={photoUrl(p.imageId)} alt={p.title} className="aspect-[9/16] w-full object-cover" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-1">
                      {replace[picking] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            unreplace(picking);
                            setPicking(null);
                          }}
                        >
                          Giữ clip cũ
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>
                        Đóng
                      </Button>
                    </div>
                  </Panel>
                ) : null}
                <Panel title="Hiệu ứng chuyển cảnh">
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(VIDEO_TRANSITIONS) as VideoTransition[]).map((k) => (
                      <Chip key={k} active={transition === k} onClick={() => setTransition(k)}>
                        {VIDEO_TRANSITIONS[k].label}
                      </Chip>
                    ))}
                  </div>
                  <p className="text-muted-foreground">Chuyển cảnh dài 0,4 giây; hai cảnh chồng lên nhau nên video ngắn đi 0,4 giây ở mỗi chỗ nối.</p>
                </Panel>
              </TabsContent>

              <TabsContent value="audio" className="space-y-3 pt-2">
                <Panel title="Nhạc nền">
                  <div className="flex flex-wrap items-center gap-2">
                    <select className={cn(SELECT, "max-w-full")} value={musicId} onChange={(e) => setMusicId(e.target.value)} aria-label="Nhạc nền">
                      <option value="">Không nhạc nền</option>
                      {music.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.title}
                        </option>
                      ))}
                    </select>
                    <select className={SELECT} value={volume} disabled={!musicId} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Âm lượng nhạc">
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
                  {musicAsset ? <audio key={musicAsset} controls src={asset(musicAsset)} className="h-8 w-full" /> : null}
                  {music.length === 0 ? <p className="text-muted-foreground">Thư viện nhạc trống — tải nhạc CÓ QUYỀN ở tab Cấu hình → Thư viện nhạc.</p> : null}
                </Panel>
                <Panel title="Giọng đọc AI">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={voiceover && !voiceAssetId} disabled={Boolean(voiceAssetId)} onChange={(e) => setVoiceover(e.target.checked)} /> Chèn giọng đọc AI theo lời từng cảnh
                    </label>
                    <select className={SELECT} value={voice} disabled={!voiceover || Boolean(voiceAssetId)} onChange={(e) => setVoice(e.target.value)} aria-label="Giọng AI">
                      {TTS_VOICES.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </div>
                  {voiceAssetId ? <p className="text-muted-foreground">Đang dùng giọng tự thu — giọng AI không trộn vào.</p> : null}
                </Panel>
                <VoiceTrack variantId={variantId} value={voiceAssetId} onChange={setVoiceAssetId} />
              </TabsContent>

              <TabsContent value="look" className="space-y-3 pt-2">
                <Panel title="Bộ lọc màu (cả video)">
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(VIDEO_COLOR_FILTERS) as VideoColorFilter[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setFilter(k)}
                        className={cn("w-16 space-y-1 rounded border-2 p-0.5 text-center text-[11px]", filter === k ? "border-primary" : "border-transparent hover:border-muted-foreground")}
                      >
                        {posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền
                          <img src={posterUrl} alt="" className="aspect-[9/16] w-full rounded object-cover" style={{ filter: VIDEO_COLOR_FILTERS[k].css }} />
                        ) : (
                          <span className="block aspect-[9/16] w-full rounded bg-gradient-to-b from-rose-300 to-sky-400" style={{ filter: VIDEO_COLOR_FILTERS[k].css }} />
                        )}
                        {VIDEO_COLOR_FILTERS[k].label}
                      </button>
                    ))}
                  </div>
                </Panel>
              </TabsContent>
            </Tabs>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-[12.5px]">
            <Button size="sm" disabled={pending} onClick={submit}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Dựng lại video
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={clone} title="Giữ video này, tạo thêm một video mới với các chỉnh sửa ở trên">
              <Copy className="size-4" /> Nhân bản thành video mới
            </Button>
            <span className="text-muted-foreground">Dựng lại + đổi cảnh bằng ảnh: miễn phí · giọng AI mới chỉ cho cảnh đổi lời (≈ 0,015 USD / phút) · kiểm chất lượng ≈ 0,01 USD.</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
