"use client";

import { Loader2, Save, Upload } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveVideoScaleConfigAction, toggleVideoMusicAction, uploadVideoMusicAction } from "@/lib/actions/video-scale";
import {
  OMNI_MODELS,
  SELECTABLE_VIDEO_PROVIDERS,
  TTS_VOICES,
  VEO_MODELS,
  VEO_PRICE_USD_PER_SECOND,
  VIDEO_ADS_HARD_LIMITS,
  VIDEO_PROVIDER_LABEL,
  VIDEO_SCALE_HARD_LIMITS,
  reserveSecondsFor,
  variantReserveUsd,
  type VideoScaleConfig,
} from "@/lib/constants/video-scale";
import type { MusicRow } from "@/lib/queries/video-scale";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:items-center">
      <span className="font-medium">
        {label}
        {hint ? <span className="block text-[11.5px] font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      <span>{children}</span>
    </label>
  );
}

/** Tab "Cấu hình": thông số sinh video, TRẦN TIỀN, giọng đọc, câu chính sách bán hàng, thư viện nhạc có quyền. */
export function ConfigPanel({ config, ffmpeg, music, canConfig, canEdit }: { config: VideoScaleConfig; ffmpeg: string | null; music: MusicRow[]; canConfig: boolean; canEdit: boolean }) {
  const [c, setC] = useState(config);
  const [cap, setCap] = useState(config.dailyUsdCap === null ? "" : String(config.dailyUsdCap));
  const [policy, setPolicy] = useState(config.policyLines.join("\n"));
  const [adsCap, setAdsCap] = useState(config.adsGlobalDailyCapVnd === null ? "" : String(config.adsGlobalDailyCapVnd));
  const [tpl, setTpl] = useState(config.adTemplateAdId);
  const [minOrders, setMinOrders] = useState(config.autoScaleMinOrders === null ? "" : String(config.autoScaleMinOrders));
  const [pending, start] = useTransition();
  const set = <K extends keyof VideoScaleConfig>(k: K, v: VideoScaleConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const isOmni = c.provider === "OMNI";
  const models: readonly string[] = isOmni ? OMNI_MODELS : VEO_MODELS;
  const priceOf = (m: string) => (VEO_PRICE_USD_PER_SECOND as Record<string, Partial<Record<string, number>>>)[m]?.[c.resolution];
  const perSec = priceOf(c.model) ?? null;
  const reserveSec = reserveSecondsFor(c.provider, c.clipSeconds);
  const perVariant = variantReserveUsd(c);
  const aiCount = c.aiScenes === null ? c.scenesPerVariant : Math.min(c.aiScenes, c.scenesPerVariant);
  const pickProvider = (p: (typeof SELECTABLE_VIDEO_PROVIDERS)[number]) =>
    setC((x) => ({ ...x, provider: p, model: p === "OMNI" ? OMNI_MODELS[0] : VEO_MODELS[0], resolution: p === "OMNI" ? "720p" : x.resolution }));

  const save = () =>
    start(async () => {
      const r = await saveVideoScaleConfigAction({ ...c, dailyUsdCap: cap.trim(), policyLines: policy.split("\n").map((x) => x.trim()).filter(Boolean), adsGlobalDailyCapVnd: adsCap.trim(), adTemplateAdId: tpl.trim(), autoScaleMinOrders: minOrders.trim() });
      if ("error" in r) return void toast.error(r.error);
      toast.success("Đã lưu cấu hình Video Scale.");
    });

  return (
    <div className="space-y-6 text-[13px]">
      <section className="space-y-3 rounded-lg border p-3">
        <h2 className="text-[14px] font-semibold">Sinh video</h2>
        <Row label="Bật Video Scale" hint="Tắt ⇒ không bắt đầu clip mới (clip đang chờ vẫn được lấy về).">
          <input type="checkbox" checked={c.enabled} disabled={!canConfig} onChange={(e) => set("enabled", e.target.checked)} />
        </Row>
        <Row label="Nhà cung cấp" hint="Veo và Omni dùng chung khoá GEMINI_API_KEY.">
          {c.provider === "FAKE" ? (
            <span>{VIDEO_PROVIDER_LABEL.FAKE}</span>
          ) : (
            <select className="h-8 rounded border px-2" value={c.provider} disabled={!canConfig} onChange={(e) => pickProvider(e.target.value as (typeof SELECTABLE_VIDEO_PROVIDERS)[number])}>
              {SELECTABLE_VIDEO_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {VIDEO_PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Model">
          <select className="h-8 rounded border px-2" value={c.model} disabled={!canConfig} onChange={(e) => set("model", e.target.value as VideoScaleConfig["model"])}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m} — {priceOf(m) === undefined ? "chưa có giá" : `${priceOf(m)} USD/giây`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Độ phân giải clip" hint={isOmni ? "Omni: bảng giá chính thức chỉ có 720p — 1080p chưa biết giá nên không mở." : undefined}>
          <select className="h-8 rounded border px-2" value={c.resolution} disabled={!canConfig || isOmni} onChange={(e) => set("resolution", e.target.value as VideoScaleConfig["resolution"])}>
            <option value="720p">720p</option>
            {isOmni ? null : <option value="1080p">1080p (bắt buộc 8 giây)</option>}
          </select>
        </Row>
        <Row label="Giây mỗi cảnh · số cảnh">
          <span className="flex gap-2">
            <select className="h-8 rounded border px-2" value={c.clipSeconds} disabled={!canConfig || c.resolution === "1080p"} onChange={(e) => set("clipSeconds", Number(e.target.value) as VideoScaleConfig["clipSeconds"])}>
              {[4, 6, 8].map((s) => (
                <option key={s} value={s}>
                  {s} giây
                </option>
              ))}
            </select>
            <select className="h-8 rounded border px-2" value={c.scenesPerVariant} disabled={!canConfig} onChange={(e) => set("scenesPerVariant", Number(e.target.value))}>
              {Array.from({ length: VIDEO_SCALE_HARD_LIMITS.maxScenesPerVariant }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} cảnh
                </option>
              ))}
            </select>
          </span>
        </Row>
        <Row label="Cảnh dùng AI mỗi video" hint="Cảnh còn lại là ẢNH ĐỘNG dựng từ chính ảnh sản phẩm (ffmpeg) — miễn phí và luôn đúng sản phẩm.">
          <select
            className="h-8 rounded border px-2"
            value={c.aiScenes === null ? "all" : String(c.aiScenes)}
            disabled={!canConfig}
            onChange={(e) => set("aiScenes", e.target.value === "all" ? null : Number(e.target.value))}
          >
            <option value="all">Mọi cảnh dùng AI</option>
            {Array.from({ length: c.scenesPerVariant }, (_, i) => i).map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "0 — toàn ảnh động (MIỄN PHÍ)" : `${n} cảnh AI đầu, còn lại ảnh động`}
              </option>
            ))}
          </select>
        </Row>
        <p className="text-[12px] text-muted-foreground">
          {perVariant === null || perSec === null
            ? aiCount === 0
              ? "Toàn ảnh động: 0 USD tiền sinh video."
              : "Model / độ phân giải này chưa có trong bảng giá — không sinh được (không áp được trần tiền)."
            : perVariant === 0
              ? "Toàn ảnh động: 0 USD tiền sinh video."
              : `Giữ chỗ trong trần theo bảng giá: ${perVariant.toFixed(2)} USD / video (${aiCount} cảnh AI × ${reserveSec} giây × ${perSec} USD/giây)${isOmni ? " — Omni tự quyết độ dài 3–10 giây nên giữ chỗ theo 10 giây, ghi tiền theo độ dài thật của clip" : ""}.`}
        </p>
        <Row label="Trần chi sinh video / ngày (USD)" hint={`Bắt buộc — để trống = KHÔNG sinh. Trần cứng ${VIDEO_SCALE_HARD_LIMITS.maxVideoUsdPerDay} USD.`}>
          <Input className="h-8 w-32" inputMode="decimal" value={cap} disabled={!canConfig} onChange={(e) => setCap(e.target.value)} placeholder="vd 10" />
        </Row>
        <Row label="Trần clip / ngày · clip cùng lúc">
          <span className="flex gap-2">
            <Input className="h-8 w-24" type="number" min={1} max={VIDEO_SCALE_HARD_LIMITS.maxClipsPerDay} value={c.dailyClipCap} disabled={!canConfig} onChange={(e) => set("dailyClipCap", Number(e.target.value))} />
            <Input className="h-8 w-20" type="number" min={1} max={VIDEO_SCALE_HARD_LIMITS.maxProviderConcurrency} value={c.providerConcurrency} disabled={!canConfig} onChange={(e) => set("providerConcurrency", Number(e.target.value))} />
          </span>
        </Row>
      </section>

      <section className="space-y-3 rounded-lg border p-3">
        <h2 className="text-[14px] font-semibold">Hậu kỳ</h2>
        <Row label="Máy chủ có ffmpeg">
          <span className={ffmpeg ? "" : "text-destructive"}>{ffmpeg ?? "KHÔNG — hậu kỳ sẽ bị chặn"}</span>
        </Row>
        <Row label="Kích thước bản hoàn chỉnh" hint="Reels khuyên 1080×1920; 720×1280 nhẹ máy chủ hơn.">
          <select className="h-8 rounded border px-2" value={c.outputHeight} disabled={!canConfig} onChange={(e) => set("outputHeight", Number(e.target.value) === 1920 ? 1920 : 1280)}>
            <option value={1280}>720×1280</option>
            <option value={1920}>1080×1920</option>
          </select>
        </Row>
        <Row label="Giọng đọc (OpenAI TTS)">
          <span className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={c.voiceover} disabled={!canConfig} onChange={(e) => set("voiceover", e.target.checked)} />
            <select className="h-8 rounded border px-2" value={c.voice} disabled={!canConfig || !c.voiceover} onChange={(e) => set("voice", e.target.value)}>
              {TTS_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </span>
        </Row>
        <Row label="Phụ đề đốt vào hình">
          <input type="checkbox" checked={c.burnSubtitles} disabled={!canConfig} onChange={(e) => set("burnSubtitles", e.target.checked)} />
        </Row>
        <Row label="Giữ âm thanh gốc của clip" hint="Có giọng đọc / nhạc thì âm gốc hạ còn 25%.">
          <input type="checkbox" checked={c.keepNativeAudio} disabled={!canConfig} onChange={(e) => set("keepNativeAudio", e.target.checked)} />
        </Row>
      </section>

      <section className="space-y-2 rounded-lg border p-3">
        <h2 className="text-[14px] font-semibold">Chính sách bán hàng được phép nói</h2>
        <p className="text-[12px] text-muted-foreground">Mỗi dòng một câu (tối đa 5). Đây là nguồn DUY NHẤT cho khuyến mãi / miễn ship / quà tặng trên kịch bản và câu chữ — trống ⇒ máy không viết câu khuyến mãi nào.</p>
        <Textarea rows={3} value={policy} disabled={!canConfig} onChange={(e) => setPolicy(e.target.value)} placeholder="vd: Mua 2 sản phẩm miễn phí vận chuyển" />
      </section>

      <section className="space-y-3 rounded-lg border p-3">
        <h2 className="text-[14px] font-semibold">Quảng cáo</h2>
        <Row label="Trần ngân sách ngày TOÀN MODULE (VND)" hint={`Tổng mọi quảng cáo Video Scale đang chạy. Để trống = không bật quảng cáo nào. Trần cứng ${VIDEO_ADS_HARD_LIMITS.maxGlobalDailyVnd.toLocaleString("vi-VN")}đ.`}>
          <Input className="h-8 w-36" inputMode="numeric" value={adsCap} disabled={!canConfig} onChange={(e) => setAdsCap(e.target.value)} placeholder="vd 1000000" />
        </Row>
        <Row label="Mẩu quảng cáo MẪU (id)" hint="Máy chép đối tượng, mục tiêu tối ưu, đích tin nhắn, nút kêu gọi từ mẩu này. Để trống = dùng mẩu mẫu của Thư viện Media.">
          <Input className="h-8 w-56" inputMode="numeric" value={tpl} disabled={!canConfig} onChange={(e) => setTpl(e.target.value)} placeholder="vd 120212345678901234" />
        </Row>
      </section>

      <section className="space-y-3 rounded-lg border p-3">
        <h2 className="text-[14px] font-semibold">Vòng tối ưu</h2>
        <p className="text-[12px] text-muted-foreground">
          Chấm bằng luật TẮT / GIỮ của Thư viện Media (một bộ luật cho cả ảnh lẫn video). Quảng cáo thua ⇒ máy tắt. Quảng cáo tốt ⇒ máy chỉ ĐỀ NGHỊ tăng, trừ khi mã
          bật &ldquo;tự tăng&rdquo; VÀ đã khai số đơn tối thiểu dưới đây.
        </p>
        <Row label="Khung chấm (ngày từ lúc bật)" hint="Hết khung mới kết luận theo luật GIỮ; luật TẮT xét mọi lúc.">
          <Input className="h-8 w-20" type="number" min={1} max={14} value={c.optimizeWindowDays} disabled={!canConfig} onChange={(e) => set("optimizeWindowDays", Number(e.target.value))} />
        </Row>
        <Row label="Bước tăng ngân sách" hint={`5–${Math.round(VIDEO_ADS_HARD_LIMITS.maxStepPct * 100)}% mỗi lần, tối đa một lần / quảng cáo / ngày.`}>
          <select className="h-8 rounded border px-2" value={c.scaleStepPct} disabled={!canConfig} onChange={(e) => set("scaleStepPct", Number(e.target.value))}>
            {[0.1, 0.15, 0.2, 0.25, 0.3].map((x) => (
              <option key={x} value={x}>
                +{Math.round(x * 100)}%
              </option>
            ))}
          </select>
        </Row>
        <Row label="Số đơn chốt tối thiểu để máy TỰ tăng" hint="Để trống = máy không bao giờ tự tăng, chỉ đề nghị.">
          <Input className="h-8 w-24" inputMode="numeric" value={minOrders} disabled={!canConfig} onChange={(e) => setMinOrders(e.target.value)} placeholder="vd 3" />
        </Row>
      </section>

      {canConfig ? (
        <Button onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu cấu hình
        </Button>
      ) : (
        <p className="text-[12px] text-muted-foreground">Chỉ người có quyền &ldquo;Cấu hình hệ thống khác&rdquo; sửa được cấu hình (trần tiền).</p>
      )}

      <MusicLibrary music={music} canEdit={canEdit} />
    </div>
  );
}

function MusicLibrary({ music, canEdit }: { music: MusicRow[]; canEdit: boolean }) {
  const [title, setTitle] = useState("");
  const [license, setLicense] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, start] = useTransition();
  const upload = () =>
    start(async () => {
      if (!file) return;
      if (file.size > 7 * 1024 * 1024) return void toast.error("Tệp nhạc tối đa 7 MB.");
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await uploadVideoMusicAction({ title, licenseNote: license, contentType: file.type || "audio/mpeg", base64: btoa(bin) });
      if ("error" in r) return void toast.error(r.error);
      toast.success("Đã thêm bản nhạc.");
      setTitle("");
      setLicense("");
      setFile(null);
    });
  const toggle = (id: string) =>
    start(async () => {
      const r = await toggleVideoMusicAction({ id });
      if ("error" in r) toast.error(r.error);
    });
  return (
    <section className="space-y-3 rounded-lg border p-3">
      <h2 className="text-[14px] font-semibold">Thư viện nhạc CÓ QUYỀN sử dụng</h2>
      <p className="text-[12px] text-muted-foreground">Máy không bao giờ tự lấy nhạc ở nơi khác. Mỗi bản phải khai nguồn và quyền (gói nhạc đã mua, nhạc tự làm, thư viện miễn phí bản quyền cho quảng cáo…).</p>
      {music.length ? (
        <ul className="space-y-1.5">
          {music.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5">
              <span className="font-medium">{m.title}</span>
              <span className="text-[12px] text-muted-foreground">{m.licenseNote} · {m.uploadedBy}</span>
              <audio controls preload="none" src={`/api/video-scale/assets/${m.assetId}`} className="h-8 max-w-full" />
              {canEdit ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => toggle(m.id)}>
                  {m.active ? "Tắt" : "Bật"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">Chưa có bản nào — video dùng âm gốc của clip.</p>
      )}
      {canEdit ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tên bản nhạc" aria-label="Tên bản nhạc" />
          <Input value={license} onChange={(e) => setLicense(e.target.value)} placeholder="Nguồn + quyền sử dụng (bắt buộc)" aria-label="Nguồn và quyền" />
          <input type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-m4a" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button onClick={upload} disabled={pending || !file || !title.trim() || license.trim().length < 10}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Tải lên
          </Button>
        </div>
      ) : null}
    </section>
  );
}
