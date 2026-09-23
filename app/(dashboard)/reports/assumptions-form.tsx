"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearDeliveryRateOverride, setDeliveryRateOverride } from "@/lib/actions/delivery-rate-override";
import { saveProfitAssumptions } from "@/lib/actions/report-settings";
import { parseDeliveryRateOverride, OVERRIDE_MODE_LABEL } from "@/lib/constants/delivery-rate";
import type { ProfitAssumptions } from "@/lib/constants/profit";

type Props = {
  assumptions: ProfitAssumptions & {
    shipFeeDeliveredUsed: number;
    shipFeeReturnedUsed: number;
    shipFeeSource: string;
    returnFeeFromData?: number;
    returnFeeSample?: number;
  };
  canWrite: boolean;
};

/** Form giả định cho báo cáo lợi nhuận danh nghĩa (cước ship, tỷ lệ giao thành công mặc định, cửa sổ lịch sử). Người dùng nhập TỶ LỆ GIAO THÀNH CÔNG; settings vẫn lưu returnRate = 100 − GTC để không đổi khoá dữ liệu. */
export function AssumptionsForm({ assumptions, canWrite }: Props) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    shipFeeDelivered: String(assumptions.shipFeeDelivered || ""),
    shipFeeReturned: String(assumptions.shipFeeReturned || ""),
    packingFeePerOrder: String(assumptions.packingFeePerOrder ?? 5000),
    opsStaffPerOrder: String(assumptions.opsStaffPerOrder ?? 2000),
    opsStaffPerRescued: String(assumptions.opsStaffPerRescued ?? 10000),
    rescueRatePercent: String(assumptions.rescueRatePercent ?? 10),
    fixedCostMonthly: String(assumptions.fixedCostMonthly ?? 5000000),
    defaultDeliveryRate: String(Math.round((100 - assumptions.defaultReturnRate) * 10) / 10),
    returnRateWindowDays: String(assumptions.returnRateWindowDays),
    minFinishedOrders: String(assumptions.minFinishedOrders),
    rateMatureMinFinished: String(assumptions.rateMatureMinFinished ?? 10),
    inventoryRiskPercent: String(assumptions.inventoryRiskPercent ?? 10),
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
        packingFeePerOrder: Math.round(num(form.packingFeePerOrder, 5000)),
        opsStaffPerOrder: Math.round(num(form.opsStaffPerOrder, 2000)),
        opsStaffPerRescued: Math.round(num(form.opsStaffPerRescued, 10000)),
        rescueRatePercent: num(form.rescueRatePercent, 10),
        fixedCostMonthly: Math.round(num(form.fixedCostMonthly, 5000000)),
        defaultReturnRate: Math.min(100, Math.max(0, 100 - num(form.defaultDeliveryRate, 70))),
        returnRateWindowDays: Math.round(num(form.returnRateWindowDays, 90)),
        minFinishedOrders: Math.round(num(form.minFinishedOrders, 10)),
        rateMatureMinFinished: Math.round(num(form.rateMatureMinFinished, 10)),
        overrides: assumptions.overrides,
        inventoryRiskPercent: num(form.inventoryRiskPercent, 10),
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
        <span title="Cước ĐVVC cho mọi đơn gửi đi, kể cả đơn sau đó hoàn">
          Cước gửi/đơn{" "}
          <b className="numeric">
            {assumptions.shipFeeDeliveredUsed.toLocaleString("vi-VN")} ₫
          </b>
        </span>
        <span title={`Cước gửi + phí hoàn về. Pancake / webhook Viettel Post không đẩy phí hoàn (${assumptions.returnFeeSample ?? 0} đơn hoàn 90 ngày có ghi phí hoàn), nên khi để trống ERP lấy phí hoàn về = cước gửi.`}>
          Cước đơn hoàn (đi + về){" "}
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
                : "mặc định: phí hoàn về = cước gửi"}
            )
          </span>
        </span>
        <span>
          Đóng hàng <b className="numeric">{(assumptions.packingFeePerOrder ?? 5000).toLocaleString("vi-VN")} ₫</b>
          <span className="text-muted-foreground">/đơn gửi</span>
        </span>
        <span title="Chi phí nhân viên vận đơn = số đơn xử lý × đơn giá + số đơn giao thất bại cứu được thành giao thành công × thưởng">
          NV vận đơn <b className="numeric">{(assumptions.opsStaffPerOrder ?? 2000).toLocaleString("vi-VN")} ₫</b>
          <span className="text-muted-foreground">/đơn + </span>
          <b className="numeric">{(assumptions.opsStaffPerRescued ?? 10000).toLocaleString("vi-VN")} ₫</b>
          <span className="text-muted-foreground">/đơn cứu GTC (ước {assumptions.rescueRatePercent ?? 10}% số đơn)</span>
        </span>
        <span title="Văn phòng, điện nước, internet… quy đổi theo số ngày của kỳ và phân bổ theo tỷ trọng doanh số">
          Cố định <b className="numeric">{(assumptions.fixedCostMonthly ?? 5000000).toLocaleString("vi-VN")} ₫</b>
          <span className="text-muted-foreground">/tháng</span>
        </span>
        <span>
          Tỷ lệ giao thành công MỤC TIÊU{" "}
          <b className="numeric">{Math.round((100 - assumptions.defaultReturnRate) * 10) / 10}%</b>
          <span className="text-muted-foreground">
            {" "}
            khi mã có dưới {assumptions.minFinishedOrders} đơn kết thúc trong{" "}
            {assumptions.returnRateWindowDays} ngày — đủ số đơn ấy thì theo SỐ ĐO của chính mã
          </span>
        </span>
        <span>
          Rủi ro tồn kho{" "}
          <b className="numeric">{assumptions.inventoryRiskPercent ?? 10}%</b>
          <span className="text-muted-foreground"> giá trị lô hàng · ghi dần theo hàng bán ra</span>
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
            <Label>Cước gửi mỗi đơn (₫)</Label>
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
            <Label>Cước 1 đơn hoàn: đi + về (₫)</Label>
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
            <Label>Đóng hàng / đơn gửi (₫)</Label>
            <Input type="number" inputMode="numeric" min={0} step={500} value={form.packingFeePerOrder} onChange={(e) => setForm({ ...form, packingFeePerOrder: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>NV vận đơn / đơn xử lý (₫)</Label>
            <Input type="number" inputMode="numeric" min={0} step={500} value={form.opsStaffPerOrder} onChange={(e) => setForm({ ...form, opsStaffPerOrder: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>NV vận đơn / đơn cứu được GTC (₫)</Label>
            <Input type="number" inputMode="numeric" min={0} step={1000} value={form.opsStaffPerRescued} onChange={(e) => setForm({ ...form, opsStaffPerRescued: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Tỷ lệ đơn cứu được (% số đơn gửi)</Label>
            <Input type="number" inputMode="decimal" min={0} max={100} step={1} value={form.rescueRatePercent} onChange={(e) => setForm({ ...form, rescueRatePercent: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Chi phí cố định / tháng: văn phòng, điện nước (₫)</Label>
            <Input type="number" inputMode="numeric" min={0} step={100000} value={form.fixedCostMonthly} onChange={(e) => setForm({ ...form, fixedCostMonthly: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label title="MỤC TIÊU hàng mới phải đạt, không phải dự báo. Áp cho mã chưa đủ số đơn kết thúc ở ô bên cạnh. Mã nào đã có số thật thì thang bậc tự chuyển sang số thật — nên đây là quy ước để vận hành trong lúc chưa có số, và mọi lợi nhuận ước tính dựa trên nó phải đọc là 'theo kế hoạch'.">
              Tỷ lệ giao thành công MỤC TIÊU (%)
            </Label>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={1}
              value={form.defaultDeliveryRate}
              onChange={(e) =>
                setForm({ ...form, defaultDeliveryRate: e.target.value })
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
            <Label title="Mốc để một mã THÔI dùng tỷ lệ chung và tuân theo SỐ ĐO CỦA CHÍNH NÓ. Mã đủ ngần này đơn đã có kết cục (giao thành công + hoàn) trong cửa sổ lịch sử thì mọi báo cáo lấy tỷ lệ thật của mã ấy. NÂNG SỐ NÀY LÀ ĐÒI BẰNG CHỨNG CHẮC HƠN, nhưng cũng đẩy thêm mã về dùng tỷ lệ chung ở trên — nên chỉ nâng khi tỷ lệ chung đang gần đúng với thực tế.">
              Đơn kết thúc tối thiểu
            </Label>
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
            <Label title="Mốc ĐỦ CHÍN: mã có đủ ngần này đơn đã có kết cục của chính nó thì máy được TỰ ĐO nó — mỗi đơn đang giao cân theo xác suất của trạng thái Viettel Post nó đang ở. Chưa đủ thì mã nằm ở bảng “Mã mới · chưa đủ căn cứ” và tỷ lệ của nó là số đo của chính mã CO NGÓT về tỷ lệ khai ở trên (không bao giờ mượn tỷ lệ nền của toàn shop). Con số này cũng là TRỌNG SỐ của mốc neo khi co ngót: để 10 nghĩa là mốc neo nặng bằng 10 đơn. KHÁC với “Đơn kết thúc tối thiểu” ở trên — ô kia gác một tỷ lệ thô, ô này gác một mô hình có điều kiện hoá nên cần ít bằng chứng thô hơn.">
              Đơn kết thúc để máy tự đo (mốc đủ chín)
            </Label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={form.rateMatureMinFinished}
              onChange={(e) =>
                setForm({ ...form, rateMatureMinFinished: e.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <Label title="Tỷ lệ giá trị lô hàng cuối cùng sẽ mất vì lỗi, tồn lâu phải xả, thất thoát. Ghi vào lãi lỗ THEO HÀNG BÁN RA từng kỳ (không ném trọn vào kỳ nhập hàng); bán hết lô thì tổng đúng bằng % × giá trị lô.">Rủi ro tồn kho (% giá trị lô hàng, ghi dần theo hàng bán ra)</Label>
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
              Cước gửi tính cho MỌI đơn gửi đi; đơn hoàn tốn thêm phí hoàn về (để trống
              = cước gửi + phí hoàn bình quân nếu có dữ liệu, không thì gấp đôi cước gửi).
              Đóng hàng và nhân viên vận đơn tính theo số đơn đã xác nhận gửi đi; đơn
              &ldquo;cứu được&rdquo; (phát không thành rồi giao thành công) ước theo % số đơn gửi. Chi phí
              cố định quy đổi theo số ngày của kỳ — nếu đã nhập tiền văn phòng / điện nước
              vào bảng Chi phí thì đặt 0 để khỏi tính hai lần. Rủi ro tồn kho: % tổng giá
              trị hàng nhập trong kỳ.
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

/**
 * Ghi đè tỷ lệ GIAO THÀNH CÔNG ước tính cho một mã hàng.
 *
 * ─── HAI THỨ ĐÃ SỬA Ở ĐÂY, 23/09/2026 ───
 *
 * 1. **Không gửi cả bản giả định nữa.** Bản trước gọi `saveProfitAssumptions` với đúng 6 trường,
 *    mà lược đồ của nó có `.default()` ở 9 trường còn lại — nên mỗi lần đặt tỷ lệ cho MỘT mã là
 *    một lần `fixedCostMonthly` về 5.000.000 ₫, `taxPercent` về 1,5, `inventoryRiskPercent` về 10…
 *    im lặng. Nay đi qua `setDeliveryRateOverride`, đường ghi đọc bản giả định ở MÁY CHỦ và chỉ
 *    thay đúng một khoá.
 * 2. **Bắt buộc ghi LÝ DO.** Một con số đặt tay không có lý do thì sáu tuần sau không ai dám gỡ nó.
 */
export function ReturnRateOverride({
  productId,
  assumptions,
  current,
  source,
  canWrite,
  mature,
}: {
  productId: string;
  assumptions: ProfitAssumptions;
  current: number;
  source: string;
  canWrite: boolean;
  /** Mã đã đủ chín chưa — quyết định ghi đè TẠM có còn hiệu lực không, và câu chữ in ra. */
  mature?: boolean;
}) {
  const daDat = parseDeliveryRateOverride(assumptions.overrides?.[productId]);
  const [value, setValue] = useState(daDat ? String(Math.round((100 - daDat.returnRate) * 10) / 10) : "");
  const [reason, setReason] = useState(daDat?.reason ?? "");
  const [giuMai, setGiuMai] = useState(daDat?.mode === "PERMANENT");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (!canWrite)
    return (
      <span className="text-xs text-muted-foreground">
        {source === "override" ? "đang ghi đè" : source === "blended" ? "co ngót về tỷ lệ khai" : source === "history" ? "theo lịch sử" : source === "projected" ? "số đo theo từng đơn" : "tỷ lệ khai"}
      </span>
    );

  const luu = () =>
    startTransition(async () => {
      const result = await setDeliveryRateOverride({
        productId,
        deliveryRate: Math.min(100, Math.max(0, Number(value))),
        reason: reason.trim(),
        mode: giuMai ? "PERMANENT" : "UNTIL_MATURE",
      });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã đặt tỷ lệ giao thành công ${value}% — ${OVERRIDE_MODE_LABEL[giuMai ? "PERMANENT" : "UNTIL_MATURE"].toLowerCase()}`);
        router.refresh();
      }
    });

  const go = () =>
    startTransition(async () => {
      const result = await clearDeliveryRateOverride(productId);
      if ("error" in result) toast.error(result.error);
      else {
        setValue("");
        setReason("");
        toast.success("Đã bỏ đặt tay — mã quay về thang bậc tự động");
        router.refresh();
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Đặt tỷ lệ giao thành công (%)</span>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={1}
        className="numeric h-8 w-20"
        placeholder={current.toFixed(1)}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Input
        type="text"
        className="h-8 w-56"
        placeholder="Vì sao đặt con số này?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <label className="flex items-center gap-1 text-muted-foreground" title="Bỏ trống: con số này TỰ NHƯỜNG CHỖ cho số đo khi mã đủ đơn kết thúc. Tick: giữ mãi, đè lên cả số đo thật — cần người thứ hai duyệt.">
        <input type="checkbox" checked={giuMai} onChange={(e) => setGiuMai(e.target.checked)} />
        giữ cả khi đã chín
      </label>
      <Button type="button" size="sm" variant="outline" onClick={luu} disabled={pending || value.trim() === "" || reason.trim().length < 3}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
      </Button>
      {daDat ? (
        <Button type="button" size="sm" variant="ghost" onClick={go} disabled={pending}>
          Bỏ đặt tay
        </Button>
      ) : null}
      {daDat ? (
        <span className="text-muted-foreground">
          {OVERRIDE_MODE_LABEL[daDat.mode]}
          {daDat.mode === "UNTIL_MATURE" && mature ? " — mã ĐÃ CHÍN nên con số này đang nhường chỗ cho số đo" : ""}
          {daDat.setBy ? ` · ${daDat.setBy}` : ""}
        </span>
      ) : null}
    </div>
  );
}
