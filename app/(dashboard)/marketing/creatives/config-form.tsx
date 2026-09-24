"use client";

import { AlertTriangle, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ProductSearch, productLabel } from "@/app/(dashboard)/marketing/creatives/product-search";
import { saveCreativeConfig } from "@/lib/actions/creative-config";
import {
  IMAGE_MODES,
  IMAGE_MODE_LABEL,
  IMAGE_QUALITIES,
  IMAGE_QUALITY_LABEL,
  IMAGE_SIZES,
  IMAGE_SIZE_LABEL,
  RULE_METRICS,
  RULE_METRIC_LABEL,
  estimateImageUsd,
  imageModelBatchSupport,
  normalizeCreativeConfig,
  type CreativeLoopConfig,
  type CreativeRule,
  type RuleOp,
} from "@/lib/constants/creative-loop";
import { formatNumber, formatVND } from "@/lib/format";
import type { ProductOption } from "@/lib/queries/creative-sources";
import { CONFIG_FIELD_LABEL, CONFIG_NUMERIC_FIELDS, numericBounds, validateCreativeConfigInput, type ClampNote, type ConfigNumericField } from "@/lib/validation/creative";
import { cn } from "@/lib/utils";

const OPS: { value: RuleOp; label: string }[] = [
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
];

type RuleRow = { key: number; metric: string; op: string; value: string; minSpendVnd: string; label: string };
type RuleSet = "killRules" | "keepRules";

type Draft = {
  enabled: boolean;
  pageId: string;
  adAccountId: string;
  testCampaignId: string;
  templateAdId: string;
  currency: "VND" | "USD";
  imageModel: string;
  imageSize: CreativeLoopConfig["imageSize"];
  imageQuality: CreativeLoopConfig["imageQuality"];
  imageMode: CreativeLoopConfig["imageMode"];
  fallbackImageQuality: CreativeLoopConfig["fallbackImageQuality"];
  focusProductIds: string[];
  nums: Record<ConfigNumericField, string>;
  killRules: RuleRow[];
  keepRules: RuleRow[];
};

let seq = 0;
const nextKey = () => ++seq;

function ruleToRow(r: CreativeRule): RuleRow {
  return { key: nextKey(), metric: r.metric, op: r.op, value: String(r.value), minSpendVnd: String(r.minSpendVnd), label: r.label ?? "" };
}

/** Dòng MỚI để trống mọi ô — không có ngưỡng mặc định nào (AGENTS.md mục 38: đích là quyết định kinh doanh). */
const emptyRow = (): RuleRow => ({ key: nextKey(), metric: "", op: "", value: "", minSpendVnd: "", label: "" });

function toDraft(c: CreativeLoopConfig): Draft {
  const nums = Object.fromEntries(CONFIG_NUMERIC_FIELDS.map((f) => [f, String(c[f])])) as Record<ConfigNumericField, string>;
  return {
    enabled: c.enabled,
    pageId: c.pageId,
    adAccountId: c.adAccountId,
    testCampaignId: c.testCampaignId,
    templateAdId: c.templateAdId,
    currency: c.currency,
    imageModel: c.imageModel,
    imageSize: c.imageSize,
    imageQuality: c.imageQuality,
    imageMode: c.imageMode,
    fallbackImageQuality: c.fallbackImageQuality,
    focusProductIds: c.focusProductIds,
    nums,
    killRules: c.killRules.map(ruleToRow),
    keepRules: c.keepRules.map(ruleToRow),
  };
}

const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s.replace(",", ".")));

function rowPayload(r: RuleRow) {
  return { metric: r.metric, op: r.op, value: numOrNull(r.value), minSpendVnd: numOrNull(r.minSpendVnd), ...(r.label.trim() ? { label: r.label.trim() } : {}) };
}

function toPayload(d: Draft) {
  const nums = Object.fromEntries(Object.entries(d.nums).map(([k, v]) => [k, numOrNull(v)]));
  return {
    enabled: d.enabled,
    pageId: d.pageId,
    adAccountId: d.adAccountId,
    testCampaignId: d.testCampaignId,
    templateAdId: d.templateAdId,
    currency: d.currency,
    ...nums,
    killRules: d.killRules.map(rowPayload),
    keepRules: d.keepRules.map(rowPayload),
    focusProductIds: d.focusProductIds,
    imageModel: d.imageModel,
    imageSize: d.imageSize,
    imageQuality: d.imageQuality,
    imageMode: d.imageMode,
    fallbackImageQuality: d.fallbackImageQuality,
  };
}

/** Dòng luật này có đọc được không — hỏi CHÍNH `normalizeCreativeConfig`, rồi nói thiếu ô nào. */
function rowIssue(r: RuleRow): string | null {
  if (normalizeCreativeConfig({ killRules: [rowPayload(r)] }).problems.every((p) => p.field !== "rules")) return null;
  const thieu: string[] = [];
  if (!r.metric) thieu.push("chỉ số");
  if (!r.op) thieu.push("phép so");
  const v = numOrNull(r.value);
  if (v === null || !Number.isFinite(v)) thieu.push("giá trị");
  const m = numOrNull(r.minSpendVnd);
  if (m === null || !Number.isFinite(m) || m < 0) thieu.push("sàn chi (≥ 0)");
  return thieu.length ? `Thiếu ${thieu.join(", ")}` : "Dòng này không đọc được";
}

const usd = (n: number) => `${n.toLocaleString("vi-VN", { maximumFractionDigits: 3 })} USD`;

/**
 * Giá ƯỚC TÍNH theo đúng bản nháp đang gõ — đọc từ `estimateImageUsd` của hợp đồng, không gõ lại con số
 * nào. Số ô một lô = số mẫu đăng + số sinh dư (đã kẹp như lúc lưu).
 */
function ImageCostEstimate({ draft, payload, mockupCount }: { draft: Draft; payload: Record<string, unknown>; mockupCount: number }) {
  const c = normalizeCreativeConfig(payload).config;
  // Số ô máy lập = thiết kế + sinh dư + mockup đã bật + thăm dò, không quá số mẫu đăng + sinh dư (như lúc lập lô).
  const slots = Math.min(c.batchSize + c.extraCandidates, c.designSlots + c.extraCandidates + mockupCount + c.exploreSlots);
  const one = estimateImageUsd(c.imageModel, c.imageQuality, c.imageSize, c.imageMode);
  const sync = estimateImageUsd(c.imageModel, c.imageQuality, c.imageSize, "SYNC");
  const rescue = estimateImageUsd(c.imageModel, c.fallbackImageQuality, c.imageSize, "SYNC");
  const lot = Math.round(one * slots * 1000) / 1000;
  const support = imageModelBatchSupport(draft.imageModel.trim());
  return (
    <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-[12.5px]">
      <p>
        Ước tính một ảnh <b className="numeric">{usd(one)}</b>
        {c.imageMode === "BATCH" ? <> qua Batch (gọi ngay {usd(sync)})</> : null} · một lô {slots} ảnh ≈ <b className={cn("numeric", lot > c.imageDailyCapUsd && "text-warning")}>{usd(lot)}</b> / trần ngày {usd(c.imageDailyCapUsd)}
        {c.imageMode === "BATCH" ? <> · vẽ nốt ở chất lượng {IMAGE_QUALITY_LABEL[c.fallbackImageQuality].toLowerCase()}: {usd(rescue)} / ảnh</> : null}
      </p>
      {lot > c.imageDailyCapUsd ? <p className="text-warning">Một lô vượt trần ngày — máy chỉ vẽ số ô vừa trần, các ô còn lại thành “Sinh ảnh lỗi” kèm lý do.</p> : null}
      {c.imageMode === "BATCH" && support === false ? (
        <p className="text-warning">
          Trang mô hình trên developers.openai.com (đọc 24/09/2026) ghi {draft.imageModel.trim()} KHÔNG hỗ trợ Batch. Máy vẫn gửi thử; OpenAI từ chối thì vẽ ngay bằng gọi ngay ở chất lượng{" "}
          {IMAGE_QUALITY_LABEL[c.fallbackImageQuality].toLowerCase()}.
        </p>
      ) : null}
      {support === null ? <p className="text-muted-foreground">Mô hình này chưa có trong bảng giá — ước tính theo mô hình đắt nhất của bảng (chặn sớm hơn, không muộn hơn).</p> : null}
    </div>
  );
}

const MONEY_FIELDS = new Set<ConfigNumericField>(["budgetPerVariantVnd"]);

function fmtBound(f: ConfigNumericField, n: number): string {
  if (MONEY_FIELDS.has(f)) return formatVND(n);
  if (f === "imageDailyCapUsd") return `${formatNumber(n)} USD`;
  return formatNumber(n);
}

function NumberField({ field, draft, bounds, onChange, disabled, suffix }: { field: ConfigNumericField; draft: Draft; bounds: { min: number; max: number }; onChange: (v: string) => void; disabled: boolean; suffix?: string }) {
  const id = `cfg-${field}`;
  const n = numOrNull(draft.nums[field]);
  const vuot = n !== null && Number.isFinite(n) && (n > bounds.max || n < bounds.min);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[12.5px]">
        {CONFIG_FIELD_LABEL[field]}
      </Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="decimal" step="any" value={draft.nums[field]} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={cn("h-8 w-36 numeric", vuot && "border-warning")} />
        {suffix ? <span className="text-[11.5px] text-muted-foreground">{suffix}</span> : null}
      </div>
      <p className={cn("text-[11px]", vuot ? "font-medium text-warning" : "text-muted-foreground")}>
        {bounds.min > 1 ? `từ ${fmtBound(field, bounds.min)}, ` : ""}tối đa {fmtBound(field, bounds.max)}
        {vuot ? " — sẽ bị kẹp" : ""}
      </p>
    </div>
  );
}

function TextField({ id, label, value, onChange, disabled, placeholder, missing }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean; placeholder?: string; missing?: boolean }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[12.5px]">
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} className={cn("h-8", missing && "border-warning")} autoComplete="off" />
      {missing ? <p className="text-[11px] text-warning">Còn thiếu — thiếu ô này thì máy không đăng được.</p> : null}
    </div>
  );
}

const box = "h-8 rounded-md border bg-background px-2 text-[12.5px] disabled:opacity-60";

function RuleEditor({ set, rows, onChange, disabled }: { set: RuleSet; rows: RuleRow[]; onChange: (rows: RuleRow[]) => void; disabled: boolean }) {
  const patch = (key: number, p: Partial<RuleRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const kill = set === "killRules";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-[13px] font-semibold">{kill ? "Luật TẮT sớm" : "Luật GIỮ"}</h4>
          <span className="text-[12px] text-muted-foreground">
            {kill ? "— BẤT KỲ luật nào đúng ⇒ máy tắt mẫu (đã được duyệt cùng lô)." : "— đúng TẤT CẢ ⇒ đề nghị tiêu thêm (người bấm, máy không tự tiêu)."}
          </span>
          <InfoHint label={kill ? "Luật tắt hoạt động thế nào" : "Luật giữ hoạt động thế nào"}>
            {kill ? (
              <>
                Mỗi lượt đo, mẫu nào đã chi ít nhất <b>sàn chi</b> của một luật mà luật đó đúng thì máy tắt nhóm quảng cáo của mẫu. Phiếu duyệt lô khoá bộ luật tắt của
                lô, nên tắt theo luật là việc người duyệt đã cho phép trước. Không khai luật nào ⇒ máy <b>không tự tắt gì</b>: mẫu chạy hết ngân sách rồi tự dừng.
              </>
            ) : (
              <>
                Hết khung test (và hết thời gian đợi đơn về), mẫu qua TẤT CẢ luật giữ ⇒ <b>Hứa hẹn</b>: máy đề nghị cho tiêu thêm, người bấm. Hụt một luật ⇒ <b>Loại</b>.
                Không khai luật nào ⇒ máy <b>không kết luận</b> hứa hẹn hay loại — mẫu hiện “Chưa kết luận được”, không phải “Loại”.
              </>
            )}{" "}
            Luật trên một TỶ SỐ (CPM, CTR, CPC, chi / tin nhắn, chi / đơn) <b>không kích hoạt khi mẫu số = 0</b> — tỷ số đó là CHƯA BIẾT, không phải vô cùng. Muốn tắt vì
            0 tin nhắn thì dùng chỉ số <b>Tin nhắn &lt; 1</b> kèm sàn chi.
          </InfoHint>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={disabled || rows.length >= 20} onClick={() => onChange([...rows, emptyRow()])}>
          <Plus className="size-4" /> Thêm luật
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
          {kill ? "Chưa có luật tắt — máy sẽ KHÔNG tự tắt mẫu nào; mỗi mẫu tiêu hết ngân sách test." : "Chưa có luật giữ — máy sẽ KHÔNG kết luận mẫu nào hứa hẹn hay bị loại."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-[12.5px]">
            <thead className="bg-muted/50 text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">Chỉ số</th>
                <th className="px-2 py-1.5 font-medium">Phép so</th>
                <th className="px-2 py-1.5 font-medium">Giá trị</th>
                <th className="px-2 py-1.5 font-medium">Sàn chi (đ)</th>
                <th className="px-2 py-1.5 font-medium">Nhãn hiển thị</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const issue = rowIssue(r);
                return (
                  <tr key={r.key} className={cn("border-t align-top", issue && "bg-destructive/5")}>
                    <td className="px-2 py-1.5 pt-3 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <select className={cn(box, "w-48")} value={r.metric} disabled={disabled} onChange={(e) => patch(r.key, { metric: e.target.value })} aria-label="Chỉ số">
                        <option value="">— chọn chỉ số —</option>
                        {RULE_METRICS.map((m) => (
                          <option key={m} value={m}>
                            {RULE_METRIC_LABEL[m]}
                          </option>
                        ))}
                      </select>
                      {issue ? <p className="mt-0.5 text-[11px] text-destructive">{issue}</p> : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <select className={cn(box, "w-20")} value={r.op} disabled={disabled} onChange={(e) => patch(r.key, { op: e.target.value })} aria-label="Phép so">
                        <option value="">—</option>
                        {OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" step="any" className="h-8 w-28 numeric" value={r.value} disabled={disabled} onChange={(e) => patch(r.key, { value: e.target.value })} aria-label="Giá trị" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input type="number" min={0} step={1000} className="h-8 w-32 numeric" value={r.minSpendVnd} disabled={disabled} onChange={(e) => patch(r.key, { minSpendVnd: e.target.value })} aria-label="Sàn chi" />
                      {numOrNull(r.minSpendVnd) !== null && Number.isFinite(numOrNull(r.minSpendVnd)) ? <p className="mt-0.5 text-[11px] text-muted-foreground">{formatVND(numOrNull(r.minSpendVnd))}</p> : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <Input className="h-8 w-40" value={r.label} maxLength={60} disabled={disabled} placeholder={kill ? "VD: Đắt tin nhắn" : "VD: Ra đơn đều"} onChange={(e) => patch(r.key, { label: e.target.value })} aria-label="Nhãn" />
                    </td>
                    <td className="px-2 py-1.5">
                      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label="Xoá luật" onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="flex items-center gap-1 px-1 text-[13px] font-semibold">
        {title}
        {hint ? <InfoHint label={`Giải thích: ${title}`}>{hint}</InfoHint> : null}
      </legend>
      {children}
    </fieldset>
  );
}

export function ConfigForm({ config, products, canManage }: { config: CreativeLoopConfig; products: ProductOption[]; canManage: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(config));
  const [saved, setSaved] = useState<ClampNote[] | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const router = useRouter();
  const disabled = !canManage || pending;

  const payload = useMemo(() => toPayload(draft), [draft]);
  const bounds = useMemo(() => numericBounds(payload), [payload]);
  const check = useMemo(() => validateCreativeConfigInput(payload), [payload]);
  const missing = new Set(check.problems.filter((p) => p.field !== "rules").map((p) => p.field));

  const setNum = (f: ConfigNumericField) => (v: string) => setDraft((d) => ({ ...d, nums: { ...d.nums, [f]: v } }));
  const set = <K extends keyof Draft>(k: K) => (v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const luu = () =>
    start(async () => {
      const r = await saveCreativeConfig(payload);
      if ("error" in r) {
        setServerProblems(r.problems.map((p) => p.message));
        toast.error(r.error);
        return;
      }
      setServerProblems([]);
      setSaved(r.clamped);
      // Hiện đúng thứ ĐÃ LƯU (bản đã kẹp), không giữ số người gõ trên màn hình.
      setDraft(toDraft(r.config));
      toast.success(r.clamped.length ? `Đã lưu — ${r.clamped.length} ô bị kẹp về trần của mã nguồn` : "Đã lưu cấu hình vòng mẫu");
      router.refresh();
    });

  const nf = (f: ConfigNumericField, suffix?: string) => <NumberField field={f} draft={draft} bounds={bounds[f]} onChange={setNum(f)} disabled={disabled} suffix={suffix} />;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        luu();
      }}
    >
      {!canManage ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">Chỉ xem. Sửa cấu hình cần quyền “Cấu hình hệ thống khác”.</p>
      ) : null}

      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch id="cfg-enabled" checked={draft.enabled} disabled={disabled} onCheckedChange={set("enabled")} />
        <Label htmlFor="cfg-enabled" className="text-[13px] font-semibold">
          {draft.enabled ? "Vòng mẫu đang BẬT" : "Vòng mẫu đang TẮT"}
        </Label>
        <InfoHint label="Công tắc vòng mẫu">
          Công tắc mềm. Job vòng mẫu còn cần biến môi trường <code>CREATIVE_LOOP_EVERY_MINUTES</code> trên máy chủ mới có trong lịch, và đường ghi quảng cáo phải mở
          (<code>ADS_WRITE_ENABLED</code>, nấc <code>COPILOT</code>) mới đăng được. Tắt ở đây ⇒ không lập lô mới.
        </InfoHint>
      </div>

      <Group title="Kết nối Facebook" hint="Máy chỉ tạo nhóm + mẩu quảng cáo BÊN TRONG chiến dịch test do người dựng sẵn, và chép đối tượng, mục tiêu tối ưu, nút kêu gọi, đích tin nhắn từ mẩu QC mẫu. Máy không tạo chiến dịch và không đoán đối tượng.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField id="cfg-page" label={CONFIG_FIELD_LABEL.pageId} value={draft.pageId} onChange={set("pageId")} disabled={disabled} missing={missing.has("pageId")} />
          <TextField id="cfg-acc" label={CONFIG_FIELD_LABEL.adAccountId} value={draft.adAccountId} onChange={set("adAccountId")} disabled={disabled} missing={missing.has("adAccountId")} />
          <TextField id="cfg-camp" label={CONFIG_FIELD_LABEL.testCampaignId} value={draft.testCampaignId} onChange={set("testCampaignId")} disabled={disabled} missing={missing.has("testCampaignId")} />
          <TextField id="cfg-tpl" label={CONFIG_FIELD_LABEL.templateAdId} value={draft.templateAdId} onChange={set("templateAdId")} disabled={disabled} missing={missing.has("templateAdId")} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cfg-cur" className="text-[12.5px]">
            {CONFIG_FIELD_LABEL.currency}
          </Label>
          <select id="cfg-cur" className={box} value={draft.currency} disabled={disabled} onChange={(e) => set("currency")(e.target.value === "USD" ? "USD" : "VND")}>
            <option value="VND">VND</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </Group>

      <Group title="Tiền & khung test" hint="Trần cứng nằm trong mã nguồn (chủ shop chốt 24/09/2026). Cấu hình chỉ LÀM HẸP được; số vượt trần bị kẹp về trần và màn hình nói ra ô nào bị kẹp. Số mẫu mỗi lô còn bị kẹp theo tổng cam kết một ngày ÷ ngân sách một mẫu.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {nf("batchSize", "mẫu")}
          {nf("budgetPerVariantVnd", "đ")}
          {nf("testDays", "ngày")}
          {nf("winOrdersAbove", "đơn")}
        </div>
      </Group>

      <Group title="Lịch (giờ Việt Nam)" hint="Lô cho ngày mai được dựng lúc giờ dựng lô; phải được duyệt trước giờ chạy một khoảng hạn duyệt, quá hạn thì lô thành “Quá hạn duyệt” và không đồng nào được chi. Hết khung test, máy đợi thêm một khoảng để đơn từ tin nhắn kịp về rồi mới kết luận.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {nf("genHourVn", "giờ")}
          {nf("startHourVn", "giờ")}
          {nf("approvalLeadMinutes", "phút")}
          {nf("verdictSettleHours", "giờ")}
        </div>
      </Group>

      <Group
        title="Lập lô"
        hint="Chủ shop 24/09/2026: lô = các ô THIẾT KẾ MỚI (mẫu chưa từng có, lai DNA của mã bán tốt) + 1 ô MOCKUP cho mỗi mẫu thắng được bật “Chạy mockup hằng ngày” ở tab Nguồn ảnh. Thứ tự đăng: mẫu tự làm → thiết kế mới → mockup → thăm dò; trần số mẫu cắt ở cuối. Ô thăm dò mặc định 0 — thăm dò giờ là việc của ô thiết kế. Mã ưu tiên chỉ áp cho ô thăm dò / mockup; để trống ⇒ mọi mã có ảnh sản phẩm thật."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {nf("designSlots", "ô")}
          {nf("extraCandidates", "ô")}
          {nf("exploreSlots", "ô")}
        </div>
        <p className="text-[12px] text-muted-foreground">
          Mockup hằng ngày: <b className="numeric">{formatNumber(config.mockupSourceIds.length)}</b> quảng cáo cũ · <b className="numeric">{formatNumber(config.mockupProductIds.length)}</b> mã hàng — bật / tắt bằng
          công tắc “Chạy mockup hằng ngày” trên thẻ nguồn ở tab Nguồn ảnh.
        </p>
        <div className="space-y-1.5">
          <Label className="text-[12.5px]">{CONFIG_FIELD_LABEL.focusProductIds}</Label>
          <div className="flex flex-wrap gap-1.5">
            {draft.focusProductIds.length === 0 ? <span className="text-[12px] text-muted-foreground">Chưa chọn — mọi mã có ảnh sản phẩm thật.</span> : null}
            {draft.focusProductIds.map((id) => {
              const sp = products.find((p) => p.id === id);
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-[12px]">
                  {sp ? productLabel(sp) : `${id} (không còn trong danh mục)`}
                  <button type="button" disabled={disabled} aria-label="Bỏ mã" onClick={() => set("focusProductIds")(draft.focusProductIds.filter((x) => x !== id))}>
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
          {canManage ? (
            <div className="max-w-md">
              <ProductSearch products={products} value="" exclude={draft.focusProductIds} placeholder="Thêm mã ưu tiên…" onChange={(id) => id && set("focusProductIds")([...draft.focusProductIds, id])} />
            </div>
          ) : null}
        </div>
      </Group>

      <Group title="Sinh ảnh" hint="Giá mỗi ảnh là ƯỚC TÍNH theo bảng giá token công bố, dùng để chặn trước khi gọi; chi phí thật ghi theo số OpenAI trả về. Batch: cả lô gửi một lần lúc dựng lô, rẻ 50%; tới giờ vẽ nốt mà chưa xong thì máy huỷ phần còn lại và vẽ bằng gọi ngay ở chất lượng vẽ nốt, vẫn trong trần ngày. Ảnh của mẫu bị loại được giữ một thời gian cho người xem lại, rồi xoá điểm ảnh — gen và số đo vẫn giữ để máy học.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField id="cfg-model" label={CONFIG_FIELD_LABEL.imageModel} value={draft.imageModel} onChange={set("imageModel")} disabled={disabled} />
          <div className="space-y-1">
            <Label htmlFor="cfg-size" className="text-[12.5px]">
              {CONFIG_FIELD_LABEL.imageSize}
            </Label>
            <select id="cfg-size" className={cn(box, "w-full")} value={draft.imageSize} disabled={disabled} onChange={(e) => set("imageSize")(IMAGE_SIZES.find((x) => x === e.target.value) ?? draft.imageSize)}>
              {IMAGE_SIZES.map((x) => (
                <option key={x} value={x}>
                  {IMAGE_SIZE_LABEL[x]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cfg-q" className="text-[12.5px]">
              {CONFIG_FIELD_LABEL.imageQuality}
            </Label>
            <select id="cfg-q" className={cn(box, "w-full")} value={draft.imageQuality} disabled={disabled} onChange={(e) => set("imageQuality")(IMAGE_QUALITIES.find((x) => x === e.target.value) ?? draft.imageQuality)}>
              {IMAGE_QUALITIES.map((x) => (
                <option key={x} value={x}>
                  {IMAGE_QUALITY_LABEL[x]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cfg-mode" className="text-[12.5px]">
              {CONFIG_FIELD_LABEL.imageMode}
            </Label>
            <select id="cfg-mode" className={cn(box, "w-full")} value={draft.imageMode} disabled={disabled} onChange={(e) => set("imageMode")(IMAGE_MODES.find((x) => x === e.target.value) ?? draft.imageMode)}>
              {IMAGE_MODES.map((x) => (
                <option key={x} value={x}>
                  {IMAGE_MODE_LABEL[x]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {draft.imageMode === "BATCH" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {nf("batchFallbackHourVn", "giờ")}
            <div className="space-y-1">
              <Label htmlFor="cfg-fq" className="text-[12.5px]">
                {CONFIG_FIELD_LABEL.fallbackImageQuality}
              </Label>
              <select id="cfg-fq" className={cn(box, "w-full")} value={draft.fallbackImageQuality} disabled={disabled} onChange={(e) => set("fallbackImageQuality")(IMAGE_QUALITIES.find((x) => x === e.target.value) ?? draft.fallbackImageQuality)}>
                {IMAGE_QUALITIES.map((x) => (
                  <option key={x} value={x}>
                    {IMAGE_QUALITY_LABEL[x]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {nf("imageDailyCapUsd", "USD")}
          {nf("loserImageRetentionDays", "ngày")}
        </div>
        <ImageCostEstimate draft={draft} payload={payload} mockupCount={config.mockupSourceIds.length + config.mockupProductIds.length} />
      </Group>

      <Group title="Bộ luật chấm mẫu">
        <p className="text-[12px] text-muted-foreground">Không có luật nào điền sẵn: ngưỡng là quyết định kinh doanh của chủ shop. Mỗi dòng phải đủ chỉ số · phép so · giá trị · sàn chi.</p>
        <RuleEditor set="killRules" rows={draft.killRules} onChange={set("killRules")} disabled={disabled} />
        <RuleEditor set="keepRules" rows={draft.keepRules} onChange={set("keepRules")} disabled={disabled} />
      </Group>

      {/* Nói ra TRƯỚC khi bấm: ô nào sẽ bị kẹp, dòng luật nào hỏng. */}
      {check.ok && check.clamped.length ? <ClampList title="Máy sẽ kẹp các ô sau về trần khi lưu" items={check.clamped} tone="warning" /> : null}
      {saved && saved.length ? <ClampList title="Lần lưu vừa rồi đã kẹp" items={saved} tone="muted" /> : null}
      {!check.ok ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {check.error}
            {check.problems.length ? ` (${check.problems.map((p) => p.message).join(" ")})` : ""}
          </span>
        </p>
      ) : null}
      {serverProblems.length ? <p className="text-[12px] text-destructive">Máy chủ từ chối: {serverProblems.join(" ")}</p> : null}

      {canManage ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={pending || !check.ok}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu cấu hình
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function ClampList({ title, items, tone }: { title: string; items: ClampNote[]; tone: "warning" | "muted" }) {
  return (
    <div className={cn("rounded-md border px-3 py-2 text-[12.5px]", tone === "warning" ? "border-warning/40 bg-warning/10" : "bg-muted/40")}>
      <p className="font-medium">{title}:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {items.map((c) => (
          <li key={c.field}>
            {CONFIG_FIELD_LABEL[c.field]}: nhập <b className="numeric">{fmtBound(c.field, c.from)}</b> → lưu <b className="numeric">{fmtBound(c.field, c.to)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
