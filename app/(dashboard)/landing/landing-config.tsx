"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { previewLandingSheet, saveLandingConfig, type TabPreviewDto } from "@/lib/actions/landing";
import { LANDING_COLUMN_LABEL, type LandingColumnKey, type LandingConfig } from "@/lib/constants/landing";

const COLUMN_KEYS = Object.keys(LANDING_COLUMN_LABEL) as LandingColumnKey[];

export function LandingConfigForm({ config, canWrite }: { config: LandingConfig; canWrite: boolean }) {
  const [open, setOpen] = useState(!config.sheetUrl && canWrite);
  const [form, setForm] = useState({ ...config, columns: { ...config.columns } });
  const [preview, setPreview] = useState<TabPreviewDto[] | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const save = () =>
    start(async () => {
      const r = await saveLandingConfig({ ...form, dedupeDays: Number(form.dedupeDays) || 7, shippingFee: Number(form.shippingFee) || 0 });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.preview ? `Đã lưu · ${r.preview}` : "Đã lưu cấu hình");
        router.refresh();
      }
    });
  const doPreview = () =>
    start(async () => {
      const r = await previewLandingSheet();
      if ("error" in r) toast.error(r.error);
      else setPreview(r.tabs);
    });
  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Nguồn dữ liệu:</span>
        <span className="truncate">{config.sheetUrl ? <a href={config.sheetUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Google Sheet{config.tabs ? ` · tab ${config.tabs}` : config.gid ? ` · gid ${config.gid}` : ""}</a> : <span className="text-amber-700">chưa cấu hình</span>}</span>
        <span className="text-muted-foreground">Trùng SĐT trong {config.dedupeDays} ngày · phí ship đơn nháp {config.shippingFee.toLocaleString("vi-VN")} ₫{Object.keys(config.columns).length ? ` · ${Object.keys(config.columns).length} cột khai tay` : " · tự dò cột theo tiêu đề"}</span>
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Cấu hình sheet"}
          </Button>
        ) : null}
      </div>
      {open && canWrite ? (
        <div className="mt-4 space-y-4 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-6">
            <div className="space-y-1 sm:col-span-4">
              <Label>Link Google Sheet (chia sẻ “Bất kỳ ai có liên kết – Người xem”)</Label>
              <Input value={form.sheetUrl} onChange={(e) => setForm({ ...form, sheetUrl: e.target.value })} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" />
            </div>
            <div className="space-y-1">
              <Label>Tên các tab (cách nhau dấu phẩy)</Label>
              <Input value={form.tabs} onChange={(e) => setForm({ ...form, tabs: e.target.value })} placeholder="Q003, Q002 · để trống = tab theo gid trong link" />
            </div>
            <div className="space-y-1">
              <Label>gid tab (khi không khai tên tab)</Label>
              <Input value={form.gid} onChange={(e) => setForm({ ...form, gid: e.target.value })} placeholder="tự lấy từ link" />
            </div>
            <div className="space-y-1">
              <Label>Dòng tiêu đề</Label>
              <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.hasHeader} onChange={(e) => setForm({ ...form, hasHeader: e.target.value as "auto" | "yes" | "no" })}>
                <option value="auto">Tự nhận</option>
                <option value="yes">Có tiêu đề</option>
                <option value="no">Không (dò theo nội dung)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Trùng SĐT trong (ngày)</Label>
              <Input type="number" min={1} max={90} value={form.dedupeDays} onChange={(e) => setForm({ ...form, dedupeDays: Number(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>Phí ship đơn nháp (₫)</Label>
              <Input type="number" min={0} step={1000} value={form.shippingFee} onChange={(e) => setForm({ ...form, shippingFee: Number(e.target.value) })} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Ghi chú thêm vào đơn POS</Label>
              <Input value={form.posNote} onChange={(e) => setForm({ ...form, posNote: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Kho Pancake (warehouse_id)</Label>
              <Input value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} placeholder="để trống = Pancake tự chọn" />
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">Ghi đè cột (chỉ điền khi ERP dò sai): tiêu đề đúng như trên sheet, hoặc “#3” = cột thứ 3 khi sheet không có tiêu đề</div>
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {COLUMN_KEYS.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-xs" title={LANDING_COLUMN_LABEL[k]}>{LANDING_COLUMN_LABEL[k]}</span>
                  <Input className="h-8" value={form.columns[k] ?? ""} placeholder={preview?.[0]?.detected[k] ? `dò: ${preview[0].detected[k]}` : "tự dò"} onChange={(e) => setForm({ ...form, columns: { ...form.columns, [k]: e.target.value } })} />
                </div>
              ))}
            </div>
          </div>
          {preview
            ? preview.map((t) => (
                <div key={t.label} className="overflow-x-auto rounded-lg border">
                  <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1 text-xs font-semibold">
                    Tab {t.label} · {t.rows} dòng · {t.error ? <span className="text-rose-700">{t.error}</span> : t.hasHeader ? "có tiêu đề" : "không tiêu đề → dò cột theo nội dung"}
                  </div>
                  {!t.error ? (
                    <table className="min-w-full text-xs">
                      <thead className="bg-muted/30">
                        <tr>{t.headers.map((h, i) => { const key = Object.entries(t.detected).find(([, v]) => v === h || v === `#${i + 1}`)?.[0]; return <th key={i} className="whitespace-nowrap px-2 py-1 text-left font-semibold">{h || `(cột ${i + 1})`}{key ? <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">{LANDING_COLUMN_LABEL[key as LandingColumnKey] ?? key}</span> : null}</th>; })}</tr>
                      </thead>
                      <tbody>{t.sample.map((r, i) => <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="max-w-[220px] truncate px-2 py-1" title={c}>{c}</td>)}</tr>)}</tbody>
                    </table>
                  ) : null}
                </div>
              ))
            : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu cấu hình</Button>
            <Button type="button" size="sm" variant="outline" onClick={doPreview} disabled={pending || !config.sheetUrl} title="Đọc thử sheet đã lưu để xem cột dò được"><Eye className="size-4" /> Xem thử sheet đã lưu</Button>
            <span className="text-xs text-muted-foreground">Lưu xong bấm “Xem thử” để kiểm tra cột; rồi “Đọc sheet ngay” ở góc phải để nhập.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
