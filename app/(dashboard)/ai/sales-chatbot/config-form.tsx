"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { AiEngineFields } from "@/components/ai-usage/ai-engine-fields";
import { saveSalesChatbotConfigAction } from "@/lib/actions/sales-chatbot";
import { SALES_TONE_LABEL, SALES_TONES, SALES_TOOL_LABEL, SALES_TOOLS, type SalesChatbotConfig, type SalesTool } from "@/lib/sales-chatbot/config";
import { CUSTOMER_AI_STATE_HINT, CUSTOMER_AI_STATE_LABEL, type ChatbotEngineConfig, type CustomerAiState, type CustomerChatbotConfig, type EngineConnectionView, type ProviderHealthView } from "@/lib/saas/visibility";


const DAY_LABEL = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

/**
 * Form cấu hình chatbot — máy chủ kiểm lại bằng CÙNG lược đồ (`salesChatbotConfigZ`).
 *
 * Hai đối tượng xem (lib/saas/visibility.ts): workspace NHÀ nhận `engine` (nguồn AI, model, dự phòng, sức khoẻ khoá) và sửa
 * được; workspace KHÁCH không nhận các ô đó trong props — chỉ thấy `aiState` (một trong bốn câu), và lượt lưu của khách được
 * máy chủ giữ nguyên động cơ AI đang lưu.
 */
export function ChatbotConfigForm({
  config,
  fields,
  engine = null,
  aiState = null,
  appointmentsOn = false,
}: {
  config: CustomerChatbotConfig;
  fields: { key: string; label: string }[];
  /** Chỉ workspace nhà. */
  engine?: { config: ChatbotEngineConfig; connections: EngineConnectionView[]; health: ProviderHealthView[] } | null;
  /** Chỉ workspace khách. */
  aiState?: CustomerAiState | null;
  /** Module Lịch hẹn đang bật — chỉ khi đó mới có khung «Đặt lịch qua chat». */
  appointmentsOn?: boolean;
}) {
  const router = useRouter();
  const [c, setC] = useState<CustomerChatbotConfig>(config);
  const [engineCfg, setEngineCfg] = useState<ChatbotEngineConfig | null>(engine?.config ?? null);
  const [shipping, setShipping] = useState(config.shippingFee === null ? "" : String(config.shippingFee));
  // Miễn ship: nhập dạng chữ (để trống = không xét ngưỡng đó), đổi sang số lúc lưu.
  const [freeMin, setFreeMin] = useState(config.freeShipping.minSubtotal === null ? "" : String(config.freeShipping.minSubtotal));
  const [freeKg, setFreeKg] = useState(config.freeShipping.minWeightGrams === null ? "" : String(config.freeShipping.minWeightGrams / 1000).replace(".", ","));
  const [freeAreas, setFreeAreas] = useState(config.freeShipping.areas.join("\n"));
  const [pending, start] = useTransition();
  const set = <K extends keyof CustomerChatbotConfig>(k: K, v: CustomerChatbotConfig[K]) => setC((s) => ({ ...s, [k]: v }));
  const setBooking = (patch: Partial<SalesChatbotConfig["booking"]>) => set("booking", { ...c.booking, ...patch });
  const num = (raw: string, fallback: number) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);

  const save = (enabled?: boolean) =>
    start(async () => {
      const ship = shipping.trim() === "" ? null : Number(shipping.replace(/[.,\s]/g, ""));
      if (ship !== null && !(Number.isSafeInteger(ship) && ship >= 0)) {
        toast.error("Phí ship là số tiền nguyên (đồng), không âm — hoặc để trống.");
        return;
      }
      const minSubtotal = freeMin.trim() === "" ? null : Number(freeMin.replace(/[.,\s]/g, ""));
      const kg = freeKg.trim() === "" ? null : Number(freeKg.trim().replace(",", "."));
      if ((minSubtotal !== null && !(Number.isSafeInteger(minSubtotal) && minSubtotal >= 0)) || (kg !== null && !(Number.isFinite(kg) && kg > 0))) {
        toast.error("Miễn ship: tiền hàng là số đồng nguyên, khối lượng là số kg lớn hơn 0 — hoặc để trống.");
        return;
      }
      const areas = [...new Set(freeAreas.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean))];
      const freeShipping = { ...c.freeShipping, minSubtotal, minWeightGrams: kg === null ? null : Math.round(kg * 1000), areas };
      // Khách: không gửi ô động cơ AI nào — máy chủ giữ nguyên giá trị đang lưu.
      const r = await saveSalesChatbotConfigAction({ ...c, ...(engineCfg ?? {}), shippingFee: ship, freeShipping, enabled: enabled ?? c.enabled });
      if ("error" in r) toast.error(r.error);
      else {
        if (enabled !== undefined) set("enabled", enabled);
        toast.success(r.message);
        router.refresh();
      }
    });

  return (
    <SectionCard
      title="Cấu hình bot"
      description={`${c.enabled ? "Bot ĐANG BẬT." : "Bot đang TẮT — khung thử vẫn dùng được."} Bật / tắt bot không ảnh hưởng «Đồng bộ đơn từ fanpage» (khung riêng ở trên).`}
      actions={
        <span className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => save()}>
            Lưu
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={() => save(!c.enabled)} data-testid="chatbot-toggle">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {c.enabled ? "Tắt bot" : "Lưu và bật bot"}
          </Button>
        </span>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cb-name">Tên bot</Label>
          <Input id="cb-name" value={c.botName} maxLength={60} onChange={(e) => set("botName", e.target.value)} />
        </div>
        {engine && engineCfg ? (
          <AiEngineFields
            value={engineCfg}
            onChange={(patch) => setEngineCfg((s) => (s ? { ...s, ...patch } : s))}
            connections={engine.connections}
            health={engine.health}
            notReadyHint={
              <>
                Khoá này chưa sẵn sàng — khai, Kiểm tra, Bật ở <Link href="/settings/connections" className="underline">Cài đặt → Kết nối</Link>.
              </>
            }
          />
        ) : aiState ? (
          <div className="space-y-1.5" data-testid="chatbot-ai-state" data-state={aiState}>
            <Label>Trạng thái AI</Label>
            <p className={`text-sm font-semibold ${aiState === "ACTIVE" ? "text-emerald-700 dark:text-emerald-400" : aiState === "PAUSED" ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}>{CUSTOMER_AI_STATE_LABEL[aiState]}</p>
            <p className="text-xs text-muted-foreground">{CUSTOMER_AI_STATE_HINT[aiState]}</p>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="cb-tone">Giọng điệu</Label>
          <select id="cb-tone" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.tone} onChange={(e) => set("tone", e.target.value as SalesChatbotConfig["tone"])}>
            {SALES_TONES.map((t) => (
              <option key={t} value={t}>
                {SALES_TONE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="cb-greeting">Lời chào</Label>
          <Input id="cb-greeting" value={c.greeting} maxLength={300} onChange={(e) => set("greeting", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cb-ship">Phí ship cố định (đồng)</Label>
          <Input id="cb-ship" inputMode="numeric" value={shipping} placeholder="Để trống = nhân viên báo sau" onChange={(e) => setShipping(e.target.value)} />
          <p className="text-xs text-muted-foreground">Bot KHÔNG tự đặt phí ship. Để trống ⇒ bot nói «phí ship nhân viên báo sau», đơn ghi chú chưa báo ship.</p>
        </div>
        <fieldset className="space-y-2 rounded-md border p-3 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={c.freeShipping.enabled} onChange={(e) => set("freeShipping", { ...c.freeShipping, enabled: e.target.checked })} />
            Miễn phí ship
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="cb-free-min" className="text-xs">Tiền hàng từ (đồng)</Label>
              <Input id="cb-free-min" inputMode="numeric" value={freeMin} placeholder="vd 300000" onChange={(e) => setFreeMin(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cb-free-kg" className="text-xs">HOẶC khối lượng từ (kg)</Label>
              <Input id="cb-free-kg" inputMode="decimal" value={freeKg} placeholder="vd 1" onChange={(e) => setFreeKg(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cb-free-areas" className="text-xs">Giao trong khu vực (mỗi dòng một tên)</Label>
              <Textarea id="cb-free-areas" rows={2} value={freeAreas} placeholder={"Hà Nội\nHồ Chí Minh\nHCM"} onChange={(e) => setFreeAreas(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Đạt MỘT trong hai ngưỡng VÀ địa chỉ có một tên trong danh sách ⇒ tóm tắt và đơn ghi «Miễn phí ship» (0 ₫). Chưa có / chưa khớp địa chỉ ⇒ bot nói «miễn ship nếu giao trong …». Khối lượng lấy từ khối lượng mẫu mã, chưa nhập thì đọc quy cách trong tên («Size 1kg», «500g»). Để trống khu vực = mọi nơi.</p>
        </fieldset>
        <div className="space-y-1.5">
          <Label>Chốt đơn</Label>
          <p className="rounded-md border bg-muted/40 p-2 text-xs leading-5">Luôn đọc lại tóm tắt (hàng, SL, đơn giá, thành tiền, ship, COD, người nhận, địa chỉ) và CHỈ chốt khi khách trả lời đồng ý — máy chủ đối chiếu lời đồng ý với câu cuối của khách.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Giờ làm việc (kênh web)</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.businessHours.enabled} onChange={(e) => set("businessHours", { ...c.businessHours, enabled: e.target.checked })} /> Chỉ trả lời trong giờ
          </label>
          <div className="flex items-center gap-2 text-sm">
            <Input className="h-8 w-24" value={c.businessHours.start} onChange={(e) => set("businessHours", { ...c.businessHours, start: e.target.value })} aria-label="Từ giờ" />
            –
            <Input className="h-8 w-24" value={c.businessHours.end} onChange={(e) => set("businessHours", { ...c.businessHours, end: e.target.value })} aria-label="Đến giờ" />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {DAY_LABEL.map((d, i) => (
              <label key={i} className="flex items-center gap-1">
                <input type="checkbox" checked={c.businessHours.days.includes(i)} onChange={(e) => set("businessHours", { ...c.businessHours, days: e.target.checked ? [...c.businessHours.days, i].sort() : c.businessHours.days.filter((x) => x !== i) })} />
                {d}
              </label>
            ))}
          </div>
          <Textarea rows={2} value={c.businessHours.outsideMessage} maxLength={300} aria-label="Tin ngoài giờ" onChange={(e) => set("businessHours", { ...c.businessHours, outsideMessage: e.target.value })} />
        </fieldset>
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Chuyển nhân viên</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.handoff.onCustomerRequest} onChange={(e) => set("handoff", { ...c.handoff, onCustomerRequest: e.target.checked })} /> Khi khách muốn gặp người
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.handoff.onComplaint} onChange={(e) => set("handoff", { ...c.handoff, onComplaint: e.target.checked })} /> Khi khách khiếu nại
          </label>
          <Textarea rows={2} value={c.handoff.message} maxLength={300} aria-label="Câu khi chuyển nhân viên" onChange={(e) => set("handoff", { ...c.handoff, message: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.handoff.notifyGroup} onChange={(e) => set("handoff", { ...c.handoff, notifyGroup: e.target.checked })} /> Báo vào nhóm chat (nhóm báo đơn) mỗi lần bot chuyển khách cho nhân viên
          </label>
        </fieldset>
        <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={c.sellWithoutStockCheck} onChange={(e) => set("sellWithoutStockCheck", e.target.checked)} />
          <span>
            Chốt đơn không cần kiểm tồn kho <span className="font-medium">(hàng nhập liên tục)</span>
            <span className="block text-xs text-muted-foreground">Bật: bot không nói còn / hết hàng, khách muốn mua là chốt; đơn chốt khi sổ kho đang thiếu có ghi chú để kho chuẩn bị hàng. Tắt: bot báo không đủ hàng theo sổ kho.</span>
          </span>
        </label>
        <fieldset className="space-y-2 rounded-lg border p-3" data-wholesale-pricing>
          <legend className="px-1 text-sm font-medium">Khách sỉ</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={c.wholesalePricing} onChange={(e) => set("wholesalePricing", e.target.checked)} />
            <span>
              Báo giá theo <span className="font-medium">Bảng giá sỉ</span> (Sản phẩm → Bảng giá sỉ)
              <span className="block text-xs text-muted-foreground">Tắt: bot chỉ có giá lẻ và chuyển nhân viên với mọi câu hỏi sỉ. Bật: bot báo đúng giá theo bậc số lượng của bảng gán cho khách (hoặc bảng mặc định), không tự giảm thêm; khách đòi giá thấp hơn bảng thì chuyển nhân viên.</span>
            </span>
          </label>
        </fieldset>
        {appointmentsOn ? (
          <fieldset className="space-y-2 rounded-lg border p-3" data-booking>
            <legend className="px-1 text-sm font-medium">Đặt lịch qua chat</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={c.booking.enabled} onChange={(e) => setBooking({ enabled: e.target.checked })} />
              <span>
                Nhận đặt lịch qua chat
                <span className="block text-xs text-muted-foreground">Bot hỏi dịch vụ + giờ, chỉ mời giờ còn chỗ, xin tên + SĐT, đọc lại và chờ khách xác nhận rồi mới giữ chỗ. Bot KHÔNG chọn kỹ thuật viên — lịch vào trang Lịch hẹn, lễ tân xếp người.</span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Mở cửa</span>
              <Input className="h-8 w-20" value={c.booking.open} onChange={(e) => setBooking({ open: e.target.value })} aria-label="Giờ mở cửa" />
              <span>–</span>
              <Input className="h-8 w-20" value={c.booking.close} onChange={(e) => setBooking({ close: e.target.value })} aria-label="Giờ đóng cửa" />
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {DAY_LABEL.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input type="checkbox" checked={c.booking.days.includes(i)} onChange={(e) => setBooking({ days: e.target.checked ? [...c.booking.days, i].sort() : c.booking.days.filter((x) => x !== i) })} />
                  {d}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label className="space-y-1">
                <span className="block text-muted-foreground">Mỗi lịch (phút)</span>
                <Input className="h-8" inputMode="numeric" value={String(c.booking.slotMinutes)} onChange={(e) => setBooking({ slotMinutes: num(e.target.value, c.booking.slotMinutes) })} />
              </label>
              <label className="space-y-1">
                <span className="block text-muted-foreground">Số khách phục vụ cùng lúc</span>
                <Input className="h-8" inputMode="numeric" value={String(c.booking.capacity)} onChange={(e) => setBooking({ capacity: num(e.target.value, c.booking.capacity) })} />
              </label>
              <label className="space-y-1">
                <span className="block text-muted-foreground">Đặt trước tối thiểu (phút)</span>
                <Input className="h-8" inputMode="numeric" value={String(c.booking.leadMinutes)} onChange={(e) => setBooking({ leadMinutes: num(e.target.value, c.booking.leadMinutes) })} />
              </label>
              <label className="space-y-1">
                <span className="block text-muted-foreground">Nhận lịch xa nhất (ngày)</span>
                <Input className="h-8" inputMode="numeric" value={String(c.booking.horizonDays)} onChange={(e) => setBooking({ horizonDays: num(e.target.value, c.booking.horizonDays) })} />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">«Số khách phục vụ cùng lúc» = số giường / ghế. Mọi lịch đang hiệu lực đều chiếm chỗ, kể cả lịch lễ tân đặt tay.</p>
          </fieldset>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-1.5 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Công cụ bot được dùng</legend>
          {SALES_TOOLS.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={c.allowedTools.includes(t)} onChange={(e) => set("allowedTools", e.target.checked ? [...c.allowedTools, t] : c.allowedTools.filter((x: SalesTool) => x !== t))} />
              {SALES_TOOL_LABEL[t].label}
              {SALES_TOOL_LABEL[t].write ? <span className="text-xs text-muted-foreground">(ghi)</span> : null}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1.5 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Thông tin sản phẩm bot được đọc</legend>
          {fields.length === 0 ? <p className="text-xs text-muted-foreground">Sản phẩm chưa có field tuỳ biến nào (mẫu «Thực phẩm đóng gói» có sẵn quy cách, bảo quản…).</p> : null}
          {fields.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={c.productFields.includes(f.key)} onChange={(e) => set("productFields", e.target.checked ? [...c.productFields, f.key] : c.productFields.filter((x) => x !== f.key))} />
              {f.label}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Field không tick bot không biết tới (vd giá nhập, ghi chú nội bộ).</p>
        </fieldset>
      </div>
      <div className="mt-5 space-y-1.5">
        <Label htmlFor="cb-extra">Hướng dẫn thêm · chính sách shop (tuỳ chọn)</Label>
        <Textarea id="cb-extra" rows={3} maxLength={1500} value={c.extraInstructions} placeholder="vd «Xưng em, gọi khách là anh/chị. Khách được kiểm tra thoải mái, ưng ý mới nhận hàng và thanh toán.» — bot trả lời câu hỏi chính sách theo đúng nội dung ở đây thay vì chuyển nhân viên." onChange={(e) => set("extraInstructions", e.target.value)} />
        <p className="text-xs text-muted-foreground">Không ghi giá hay tồn ở đây — bot luôn đọc giá / tồn từ ERP.</p>
      </div>
    </SectionCard>
  );
}
