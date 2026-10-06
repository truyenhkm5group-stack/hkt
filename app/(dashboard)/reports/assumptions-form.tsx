"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearDeliveryRateOverride, setDeliveryRateOverride } from "@/lib/actions/delivery-rate-override";
import { saveProfitAssumptions } from "@/lib/actions/report-settings";
import { parseDeliveryRateOverride, OVERRIDE_MODE_LABEL } from "@/lib/constants/delivery-rate";
import { manualShipFee, type ProfitAssumptions } from "@/lib/constants/profit";

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
    // Ô trống = tự tính; số đặt tay (kể cả 0) hiện đúng con số đó.
    shipFeeDelivered: String(manualShipFee(assumptions, "shipFeeDelivered") ?? ""),
    shipFeeReturned: String(manualShipFee(assumptions, "shipFeeReturned") ?? ""),
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
  });
  const [pending, startTransition] = useTransition();
  /** Ô cước: trống ⇒ `null` (tự tính), còn lại là số đặt tay — 0 là 0 ₫. */
  const shipFee = (v: string) => (v.trim() === "" ? null : Math.round(Number(v)));
  /*
    Các ô còn lại KHÔNG có chế độ tự tính. Bản trước lặng lẽ thay ô trống bằng một số mặc định
    (đóng hàng 5.000 ₫, cố định 5.000.000 ₫…) — xoá ô để "không tính" lại ra một khoản chi. Nay ô
    trống bị chặn và nói ra tên ô; muốn không tính thì gõ 0.
  */
  const REQUIRED: Array<[keyof typeof form, string]> = [
    ["packingFeePerOrder", "Đóng hàng / đơn gửi"],
    ["opsStaffPerOrder", "NV vận đơn / đơn xử lý"],
    ["opsStaffPerRescued", "NV vận đơn / đơn cứu được GTC"],
    ["rescueRatePercent", "Tỷ lệ đơn cứu được"],
    ["fixedCostMonthly", "Chi phí cố định / tháng"],
    ["defaultDeliveryRate", "Tỷ lệ giao thành công MỤC TIÊU"],
    ["returnRateWindowDays", "Cửa sổ lịch sử"],
    ["minFinishedOrders", "Đơn kết thúc tối thiểu"],
    ["rateMatureMinFinished", "Đơn kết thúc để máy tự đo"],
    ["inventoryRiskPercent", "Rủi ro tồn kho"],
    ["taxPercent", "Dự trù thuế"],
    ["otherCostPercentOfAds", "Chi phí khác"],
  ];
  const num = (v: string) => Number(v);

  const submit = () => {
    const trong = REQUIRED.filter(([k]) => form[k].trim() === "" || !Number.isFinite(Number(form[k])));
    if (trong.length) {
      toast.error(`Ô ${trong.map(([, nhan]) => `«${nhan}»`).join(", ")} đang trống — điền số (gõ 0 nếu không tính).`);
      return;
    }
    startTransition(async () => {
      const result = await saveProfitAssumptions({
        shipFeeDelivered: shipFee(form.shipFeeDelivered),
        shipFeeReturned: shipFee(form.shipFeeReturned),
        packingFeePerOrder: Math.round(num(form.packingFeePerOrder)),
        opsStaffPerOrder: Math.round(num(form.opsStaffPerOrder)),
        opsStaffPerRescued: Math.round(num(form.opsStaffPerRescued)),
        rescueRatePercent: num(form.rescueRatePercent),
        fixedCostMonthly: Math.round(num(form.fixedCostMonthly)),
        defaultReturnRate: Math.min(100, Math.max(0, 100 - num(form.defaultDeliveryRate))),
        returnRateWindowDays: Math.round(num(form.returnRateWindowDays)),
        minFinishedOrders: Math.round(num(form.minFinishedOrders)),
        rateMatureMinFinished: Math.round(num(form.rateMatureMinFinished)),
        overrides: assumptions.overrides,
        inventoryRiskPercent: num(form.inventoryRiskPercent),
        taxPercent: num(form.taxPercent),
        otherCostPercentOfAds: num(form.otherCostPercentOfAds),
        // Không có phép tính nào đọc ô này (mô hình tự học — xem dòng tóm tắt): gửi lại nguyên giá trị đã lưu.
        failedToReturnPercent: assumptions.failedToReturnPercent ?? 0,
      });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success("Đã lưu giả định");
        setOpen(false);
      }
    });
  };

  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Giả định:</span>
        <span title="Cước ĐVVC cho mọi đơn gửi đi, kể cả đơn sau đó hoàn">
          Cước gửi/đơn{" "}
          <b className="numeric">
            {assumptions.shipFeeDeliveredUsed.toLocaleString("vi-VN")} ₫
          </b>
          <span className="text-muted-foreground">
            {manualShipFee(assumptions, "shipFeeDelivered") !== null ? " (đặt tay)" : " (tự tính)"}
          </span>
        </span>
        <span title={`Cước gửi + phí hoàn về. Pancake / webhook Viettel Post không đẩy phí hoàn (${assumptions.returnFeeSample ?? 0} đơn hoàn 90 ngày có ghi phí hoàn), nên khi để trống ERP lấy phí hoàn về = cước gửi.`}>
          Cước đơn hoàn (đi + về){" "}
          <b className="numeric">
            {assumptions.shipFeeReturnedUsed.toLocaleString("vi-VN")} ₫
          </b>
          <span className="text-muted-foreground">
            {" "}
            (
            {manualShipFee(assumptions, "shipFeeReturned") !== null
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
        <span title="Xác suất đơn chờ phát lại / chờ xử lý thành hoàn do mô hình học từ trạng thái Viettel Post của chính shop (lib/queries/projected-delivery.ts). Không có ô đặt tay cho con số này.">
          Đơn chờ phát lại thành hoàn <b>máy tự học</b>
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
              placeholder="Để trống = tự tính"
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
              placeholder="Để trống = tự tính"
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
          <div className="sm:col-span-6 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Cước gửi tính cho MỌI đơn gửi đi; đơn hoàn tốn thêm phí hoàn về. Hai ô cước để
              trống = tự tính (cước gửi bình quân 90 ngày; đơn hoàn = cước gửi + phí hoàn bình
              quân nếu có dữ liệu, không thì gấp đôi cước gửi) — gõ 0 là 0 ₫, không tính cước.
              Đóng hàng và nhân viên vận đơn tính theo số đơn đã xác nhận gửi đi; đơn
              &ldquo;cứu được&rdquo; (phát không thành rồi giao thành công) ước theo % số đơn gửi. Chi phí
              cố định quy đổi theo số ngày của kỳ — nếu đã nhập tiền văn phòng / điện nước
              vào bảng Chi phí thì đặt 0 để khỏi tính hai lần. Rủi ro tồn kho: % giá trị lô
              hàng, ghi dần theo hàng bán ra.
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
  onStart,
  onPendingChange,
}: {
  productId: string;
  assumptions: ProfitAssumptions;
  current: number;
  source: string;
  canWrite: boolean;
  /** Mã đã đủ chín chưa — quyết định ghi đè TẠM có còn hiệu lực không, và câu chữ in ra. */
  mature?: boolean;
  /**
   * Gọi NGAY khi bấm Lưu / Bỏ đặt tay (trước khi máy chủ trả lời) — popover dùng nó để đóng lại,
   * không bắt người dùng đứng nhìn nút quay trong lúc bảng tính lại. `pending` báo cho ô chứa biết
   * dòng này còn đang cập nhật.
   */
  onStart?: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const daDat = parseDeliveryRateOverride(assumptions.overrides?.[productId]);
  const [value, setValue] = useState(daDat ? String(Math.round((100 - daDat.returnRate) * 10) / 10) : "");
  const [reason, setReason] = useState(daDat?.reason ?? "");
  const [giuMai, setGiuMai] = useState(daDat?.mode === "PERMANENT");
  const [pending, startTransition] = useTransition();
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  if (!canWrite)
    return (
      <span className="text-xs text-muted-foreground">
        {source === "override" ? "đang ghi đè" : source === "blended" ? "co ngót về tỷ lệ khai" : source === "history" ? "theo lịch sử" : source === "projected" ? "số đo theo từng đơn" : "tỷ lệ khai"}
      </span>
    );

  /*
    ═══ MỘT LƯỢT DỰNG TRANG, KHÔNG PHẢI HAI (chủ shop báo "đặt số dự tính hơi lag", 25/09/2026) ═══

    Server action của các ô này gọi `clearMemo()` + `revalidatePath("/reports")`. Trên Next 15,
    `revalidatePath` trong server action đã trả GIAO DIỆN MỚI của trang hiện tại NGAY TRONG CÙNG
    lượt gọi — nên `await action()` chỉ xong khi trang Báo cáo lợi nhuận đã dựng lại (đệm vừa bị xoá
    ⇒ dựng nguội). Bản trước còn gọi thêm `router.refresh()`: một lượt dựng NGUỘI THỨ HAI y hệt, và
    nút "Lưu" quay suốt cả hai lượt. Bỏ `router.refresh()` là bỏ đúng lượt thừa.
  */
  const luu = () => {
    onStart?.();
    const id = toast.loading(`Đang lưu tỷ lệ ${value}% và tính lại bảng…`);
    startTransition(async () => {
      const result = await setDeliveryRateOverride({
        productId,
        deliveryRate: Math.min(100, Math.max(0, Number(value))),
        reason: reason.trim(),
        mode: giuMai ? "PERMANENT" : "UNTIL_MATURE",
      });
      if ("error" in result) toast.error(result.error, { id });
      else toast.success(`Đã đặt tỷ lệ giao thành công ${value}% — ${OVERRIDE_MODE_LABEL[giuMai ? "PERMANENT" : "UNTIL_MATURE"].toLowerCase()}`, { id });
    });
  };

  const go = () => {
    onStart?.();
    const id = toast.loading("Đang bỏ đặt tay và tính lại bảng…");
    startTransition(async () => {
      const result = await clearDeliveryRateOverride(productId);
      if ("error" in result) toast.error(result.error, { id });
      else {
        setValue("");
        setReason("");
        toast.success("Đã bỏ đặt tay — mã quay về thang bậc tự động", { id });
      }
    });
  };

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
