"use client";

import { useState } from "react";
import { Loader2, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkAddressAction } from "@/lib/actions/address";
import { saveShippingRoutingAction } from "@/lib/actions/shipping-routes";
import type { CarrierKey } from "@/lib/carriers/types";
import type { SelfArea } from "@/lib/constants/shipping-routing";

export type RoutingFormValue = { selfAreas: SelfArea[]; defaultCarrier: CarrierKey | null; autoCreate: boolean; serviceCode: string | null };
export type CarrierChoice = { key: CarrierKey; label: string; ready: boolean };

/** Một khu tự giao: cả tỉnh, hoặc các xã / phường chọn từ danh mục địa giới mới (máy chủ trả danh sách xã của MỘT tỉnh). */
function AreaEditor({ area, onChange, onRemove, disabled }: { area: SelfArea; onChange: (a: SelfArea) => void; onRemove: () => void; disabled: boolean }) {
  const [wards, setWards] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const whole = area.wards.length === 0;

  const loadWards = async () => {
    if (wards) return wards;
    setLoading(true);
    try {
      const r = await checkAddressAction("", area.province);
      setWards(r.wards);
      return r.wards;
    } finally {
      setLoading(false);
    }
  };
  const chosen = new Set(area.wards);
  const shown = (wards ?? []).filter((w) => !filter.trim() || w.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{area.province}</span>
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <input type="radio" checked={whole} disabled={disabled} onChange={() => onChange({ ...area, wards: [] })} /> Cả tỉnh
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <input type="radio" checked={!whole} disabled={disabled} onChange={async () => { const list = await loadWards(); if (!area.wards.length && list.length) onChange({ ...area, wards: [list[0]!] }); }} /> Chỉ một số xã / phường
        </label>
        <span className="text-[12px] text-muted-foreground">{whole ? "mọi xã / phường của tỉnh" : `${area.wards.length} xã / phường`}</span>
        {!disabled ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onRemove}>
            <X className="size-4" /> Bỏ khu này
          </Button>
        ) : null}
      </div>
      {!whole ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {area.wards.map((w) => (
              <span key={w} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[12px] text-primary">
                {w}
                {!disabled ? (
                  <button type="button" aria-label={`Bỏ ${w}`} onClick={() => onChange({ ...area, wards: area.wards.filter((x) => x !== w) })}>
                    <X className="size-3" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
          {!disabled ? (
            wards ? (
              <div className="space-y-1.5">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Tìm xã / phường…" aria-label="Tìm xã / phường" className="h-8" />
                <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-md border p-2 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map((w) => (
                    <label key={w} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={chosen.has(w)} onChange={(e) => onChange({ ...area, wards: e.target.checked ? [...area.wards, w] : area.wards.filter((x) => x !== w) })} /> {w}
                    </label>
                  ))}
                  {!shown.length ? <span className="text-muted-foreground">Không có xã / phường nào khớp.</span> : null}
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={loadWards} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : null} Chọn xã / phường
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function RoutingForm({ initial, provinces, carriers, canEdit }: { initial: RoutingFormValue; provinces: string[]; carriers: CarrierChoice[]; canEdit: boolean }) {
  const [v, setV] = useState<RoutingFormValue>(initial);
  const [addProvince, setAddProvince] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = new Set(v.selfAreas.map((a) => a.province));
  const carrier = carriers.find((c) => c.key === v.defaultCarrier) ?? null;

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await saveShippingRoutingAction({ ...v, serviceCode: v.serviceCode?.trim() ? v.serviceCode.trim().toUpperCase() : null });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold">1 · Khu shop tự giao</h3>
        <p className="text-[12.5px] text-muted-foreground">Đơn có tỉnh + xã thuộc khu này vào «Danh sách tự giao» cho người giao của shop. Khu tự giao thắng hãng mặc định.</p>
        {v.selfAreas.length ? (
          <div className="space-y-2">
            {v.selfAreas.map((a, i) => (
              <AreaEditor key={a.province} area={a} disabled={!canEdit} onChange={(next) => setV({ ...v, selfAreas: v.selfAreas.map((x, j) => (j === i ? next : x)) })} onRemove={() => setV({ ...v, selfAreas: v.selfAreas.filter((_, j) => j !== i) })} />
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Chưa có khu tự giao nào — mọi đơn đi hãng mặc định.</p>
        )}
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-[13px]" value={addProvince} onChange={(e) => setAddProvince(e.target.value)} aria-label="Tỉnh / thành tự giao">
              <option value="">— Chọn tỉnh / thành —</option>
              {provinces
                .filter((p) => !used.has(p))
                .map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
            </select>
            <Button type="button" variant="outline" size="sm" disabled={!addProvince} onClick={() => { setV({ ...v, selfAreas: [...v.selfAreas, { province: addProvince, wards: [] }] }); setAddProvince(""); }}>
              <Plus className="size-4" /> Thêm khu tự giao
            </Button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold">2 · Hãng cho đơn ngoài khu tự giao</h3>
        <select className="h-9 rounded-md border bg-background px-2 text-[13px]" value={v.defaultCarrier ?? ""} disabled={!canEdit} onChange={(e) => { const key = (e.target.value || null) as CarrierKey | null; setV({ ...v, defaultCarrier: key, autoCreate: key ? v.autoCreate : false }); }} aria-label="Hãng mặc định">
          <option value="">— Chưa chọn (đơn ngoài khu tự giao bị giữ lại) —</option>
          {carriers.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
              {c.ready ? "" : " — chưa bật kết nối"}
            </option>
          ))}
        </select>
        {carrier && !carrier.ready ? <p className="text-[12.5px] text-amber-700 dark:text-amber-400">{carrier.label} chưa bật — Cài đặt → Kết nối → nhóm «Vận chuyển»: khai tài khoản, Kiểm tra đạt rồi Bật. Trong lúc đó đơn đi hãng bị giữ lại.</p> : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-[14px] font-semibold">3 · Tự tạo vận đơn</h3>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={v.autoCreate} disabled={!canEdit || !carrier?.ready} onChange={(e) => setV({ ...v, autoCreate: e.target.checked })} />
          <span>
            Máy tự tạo vận đơn ở hãng mặc định cho đơn đã xác nhận ngoài khu tự giao (mỗi 5 phút). <b>Chỉ đơn xác nhận từ lúc bật</b> — đơn cũ không bị kéo sang hãng. Cân = cân mẫu mã × số lượng (thiếu thì giữ lại), thu hộ = số khách còn phải trả. Hãng sẽ cử bưu tá tới lấy hàng.
          </span>
        </label>
        <label className="block space-y-1 text-[12.5px]">
          <span className="font-medium">Mã dịch vụ (không bắt buộc)</span>
          <Input value={v.serviceCode ?? ""} disabled={!canEdit} onChange={(e) => setV({ ...v, serviceCode: e.target.value || null })} placeholder="Để trống = dịch vụ rẻ nhất hãng báo cho từng đơn" className="max-w-sm" aria-label="Mã dịch vụ" />
        </label>
      </section>

      {error ? <p className="text-[12.5px] font-medium text-destructive">{error}</p> : null}
      {canEdit ? (
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu tuyến giao
        </Button>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">Chỉ người có quyền cấu hình (settings:manage) đổi được tuyến giao.</p>
      )}
    </div>
  );
}
