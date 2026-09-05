"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveProfitAssumptions } from "@/lib/actions/report-settings";
import type { ProfitAssumptions } from "@/lib/constants/profit";

type Props = {
  assumptions: ProfitAssumptions & {
    shipFeeDeliveredUsed: number;
    shipFeeReturnedUsed: number;
    shipFeeSource: string;
  };
  canWrite: boolean;
};

/** Form giả định cho báo cáo lợi nhuận danh nghĩa (cước ship, tỷ lệ hoàn mặc định, cửa sổ lịch sử) */
export function AssumptionsForm({ assumptions, canWrite }: Props) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    shipFeeDelivered: String(assumptions.shipFeeDelivered || ""),
    shipFeeReturned: String(assumptions.shipFeeReturned || ""),
    defaultReturnRate: String(assumptions.defaultReturnRate),
    returnRateWindowDays: String(assumptions.returnRateWindowDays),
    minFinishedOrders: String(assumptions.minFinishedOrders),
    inventoryRiskPercent: String(assumptions.inventoryRiskPercent ?? 5),
    taxPercent: String(assumptions.taxPercent ?? 1.5),
    otherCostPercentOfAds: String(assumptions.otherCostPercentOfAds ?? 1.1),
    failedToReturnPercent: String(assumptions.failedToReturnPercent ?? 0),
  });
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const num = (v: string, fallback = 0) =>
    v.trim() === "" ? fallback : Number(v);

  const submit = () =>
    startTransition(async () => {
      const result = await saveProfitAssumptions({
        shipFeeDelivered: Math.round(num(form.shipFeeDelivered)),
        shipFeeReturned: Math.round(num(form.shipFeeReturned)),
        defaultReturnRate: num(form.defaultReturnRate, 30),
        returnRateWindowDays: Math.round(num(form.returnRateWindowDays, 90)),
        minFinishedOrders: Math.round(num(form.minFinishedOrders, 10)),
        overrides: assumptions.overrides,
        inventoryRiskPercent: num(form.inventoryRiskPercent, 5),
        taxPercent: num(form.taxPercent, 1.5),
        otherCostPercentOfAds: num(form.otherCostPercentOfAds, 1.1),
        failedToReturnPercent: num(form.failedToReturnPercent, 0),
      });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success("Đã lưu giả định");
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Giả định:</span>
        <span>
          Cước đơn giao thật{" "}
          <b className="numeric">
            {assumptions.shipFeeDeliveredUsed.toLocaleString("vi-VN")} ₫
          </b>
        </span>
        <span>
          Chi phí đơn hoàn{" "}
          <b className="numeric">
            {assumptions.shipFeeReturnedUsed.toLocaleString("vi-VN")} ₫
          </b>
          <span className="text-muted-foreground">
            {" "}
            (
            {assumptions.shipFeeSource === "setting"
              ? "đặt tay"
              : assumptions.shipFeeSource === "data"
                ? "bình quân 90 ngày"
                : "mặc định"}
            )
          </span>
        </span>
        <span>
          Tỷ lệ hoàn mặc định{" "}
          <b className="numeric">{assumptions.defaultReturnRate}%</b>
          <span className="text-muted-foreground">
            {" "}
            khi mã có dưới {assumptions.minFinishedOrders} đơn kết thúc trong{" "}
            {assumptions.returnRateWindowDays} ngày
          </span>
        </span>
        <span>
          Rủi ro tồn kho{" "}
          <b className="numeric">{assumptions.inventoryRiskPercent ?? 5}%</b>
          <span className="text-muted-foreground"> giá vốn hàng bán</span>
        </span>
        <span>
          Thuế <b className="numeric">{assumptions.taxPercent ?? 1.5}%</b>
          <span className="text-muted-foreground"> doanh thu</span>
        </span>
        <span>
          Chi phí khác <b className="numeric">{assumptions.otherCostPercentOfAds ?? 1.1}%</b>
          <span className="text-muted-foreground"> CPQC (phí thẻ ngoại tệ)</span>
        </span>
        <span>
          Đơn chờ phát lại thành hoàn{" "}
          <b className="numeric">{assumptions.failedToReturnPercent ? `${assumptions.failedToReturnPercent}%` : "tự học"}</b>
        </span>
        {canWrite ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setOpen((v) => !v)}
          >
            <Settings2 className="size-4" /> {open ? "Đóng" : "Sửa giả định"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-6">
          <div className="space-y-1">
            <Label>Cước đơn giao thật (₫)</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              placeholder={`Tự tính: ${assumptions.shipFeeDeliveredUsed.toLocaleString("vi-VN")}`}
              value={form.shipFeeDelivered}
              onChange={(e) =>
                setForm({ ...form, shipFeeDelivered: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Chi phí đơn hoàn (₫)</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              placeholder={`Tự tính: ${assumptions.shipFeeReturnedUsed.toLocaleString("vi-VN")}`}
              value={form.shipFeeReturned}
              onChange={(e) =>
                setForm({ ...form, shipFeeReturned: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Tỷ lệ hoàn mặc định (%)</Label>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={1}
              value={form.defaultReturnRate}
              onChange={(e) =>
                setForm({ ...form, defaultReturnRate: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Cửa sổ lịch sử (ngày)</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={7}
              max={730}
              value={form.returnRateWindowDays}
              onChange={(e) =>
                setForm({ ...form, returnRateWindowDays: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Đơn kết thúc tối thiểu</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={form.minFinishedOrders}
              onChange={(e) =>
                setForm({ ...form, minFinishedOrders: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Rủi ro tồn kho (% giá vốn)</Label>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.5}
              value={form.inventoryRiskPercent}
              onChange={(e) =>
                setForm({ ...form, inventoryRiskPercent: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label>Dự trù thuế (% DT GTC ước tính)</Label>
            <Input type="number" min={0} max={50} step={0.1} value={form.taxPercent} onChange={(e) => setForm({ ...form, taxPercent: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Chi phí khác (% CPQC, phí thẻ ngoại tệ)</Label>
            <Input type="number" min={0} max={50} step={0.1} value={form.otherCostPercentOfAds} onChange={(e) => setForm({ ...form, otherCostPercentOfAds: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Đơn chờ xử lý / phát lại thành hoàn (%) · 0 = tự học</Label>
            <Input type="number" min={0} max={100} step={1} value={form.failedToReturnPercent} onChange={(e) => setForm({ ...form, failedToReturnPercent: e.target.value })} />
          </div>
          <div className="sm:col-span-6 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Để trống cước để ERP tự lấy bình quân 90 ngày từ dữ liệu vận đơn.
              Tỷ lệ hoàn từng mã lấy theo lịch sử; có thể ghi đè ở phần chi tiết
              mã hàng. Rủi ro tồn kho: dự phòng hàng lỗi / tồn lâu phải xả /
              thất thoát, tính theo % giá vốn hàng bán ước tính.
            </p>
            <Button type="button" size="sm" onClick={submit} disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}{" "}
              Lưu
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Ghi đè tỷ lệ hoàn ước tính cho một mã hàng */
export function ReturnRateOverride({
  productId,
  assumptions,
  current,
  source,
  canWrite,
}: {
  productId: string;
  assumptions: ProfitAssumptions;
  current: number;
  source: string;
  canWrite: boolean;
}) {
  const [value, setValue] = useState(
    assumptions.overrides[productId] !== undefined
      ? String(assumptions.overrides[productId])
      : "",
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (!canWrite)
    return (
      <span className="text-xs text-muted-foreground">
        {source === "override"
          ? "đang ghi đè"
          : source === "history"
            ? "theo lịch sử"
            : "mặc định"}
      </span>
    );
  const save = (override: string) =>
    startTransition(async () => {
      const overrides = { ...assumptions.overrides };
      if (override.trim() === "") delete overrides[productId];
      else overrides[productId] = Number(override);
      const {
        shipFeeDelivered,
        shipFeeReturned,
        defaultReturnRate,
        returnRateWindowDays,
        minFinishedOrders,
      } = assumptions;
      const result = await saveProfitAssumptions({
        shipFeeDelivered,
        shipFeeReturned,
        defaultReturnRate,
        returnRateWindowDays,
        minFinishedOrders,
        overrides,
      });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(
          override.trim() === ""
            ? "Đã bỏ ghi đè, dùng tỷ lệ lịch sử"
            : `Đã đặt tỷ lệ hoàn ${override}%`,
        );
        router.refresh();
      }
    });
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Ghi đè tỷ lệ hoàn (%)</span>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={1}
        className="numeric h-8 w-24"
        placeholder={current.toFixed(1)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => save(value)}
        disabled={pending}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
      </Button>
      {assumptions.overrides[productId] !== undefined ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setValue("");
            save("");
          }}
          disabled={pending}
        >
          Bỏ ghi đè
        </Button>
      ) : null}
    </div>
  );
}
