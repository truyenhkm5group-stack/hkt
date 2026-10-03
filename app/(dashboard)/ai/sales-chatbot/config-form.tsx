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
import { saveSalesChatbotConfigAction } from "@/lib/actions/sales-chatbot";
import { SALES_TONE_LABEL, SALES_TONES, SALES_TOOL_LABEL, SALES_TOOLS, type SalesBotConnector, type SalesChatbotConfig, type SalesTool, SALES_THINKING, SALES_THINKING_LABEL } from "@/lib/sales-chatbot/config";

const DAY_LABEL = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const CONNECTOR_LABEL: Record<SalesBotConnector, string> = { "anthropic-byok": "Anthropic (Claude) — khoá của tổ chức", "openai-byok": "OpenAI — khoá của tổ chức", "gemini-byok": "Google Gemini — khoá của tổ chức (rẻ nhất)" };

/** Form cấu hình chatbot — máy chủ kiểm lại bằng CÙNG lược đồ (`salesChatbotConfigZ`). */
export function ChatbotConfigForm({
  config,
  fields,
  connections,
  appointmentsOn = false,
}: {
  config: SalesChatbotConfig;
  fields: { key: string; label: string }[];
  connections: { key: SalesBotConnector; ready: boolean; configured: boolean }[];
  /** Module Lịch hẹn đang bật — chỉ khi đó mới có khung «Đặt lịch qua chat». */
  appointmentsOn?: boolean;
}) {
  const router = useRouter();
  const [c, setC] = useState<SalesChatbotConfig>(config);
  const [shipping, setShipping] = useState(config.shippingFee === null ? "" : String(config.shippingFee));
  const [pending, start] = useTransition();
  const set = <K extends keyof SalesChatbotConfig>(k: K, v: SalesChatbotConfig[K]) => setC((s) => ({ ...s, [k]: v }));
  const setBooking = (patch: Partial<SalesChatbotConfig["booking"]>) => set("booking", { ...c.booking, ...patch });
  const num = (raw: string, fallback: number) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);
  const conn = connections.find((x) => x.key === c.connectorKey);

  const save = (enabled?: boolean) =>
    start(async () => {
      const ship = shipping.trim() === "" ? null : Number(shipping.replace(/[.,\s]/g, ""));
      if (ship !== null && !(Number.isSafeInteger(ship) && ship >= 0)) {
        toast.error("Phí ship là số tiền nguyên (đồng), không âm — hoặc để trống.");
        return;
      }
      const r = await saveSalesChatbotConfigAction({ ...c, shippingFee: ship, enabled: enabled ?? c.enabled });
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
      description={c.enabled ? "Bot ĐANG BẬT." : "Bot đang TẮT — khung thử vẫn dùng được."}
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
        <div className="space-y-1.5">
          <Label htmlFor="cb-conn">Khoá AI (nhà cung cấp)</Label>
          <select id="cb-conn" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.connectorKey} onChange={(e) => set("connectorKey", e.target.value as SalesBotConnector)}>
            {connections.map((x) => (
              <option key={x.key} value={x.key}>
                {CONNECTOR_LABEL[x.key]} — {x.ready ? "đã bật" : x.configured ? "chưa bật" : "chưa khai"}
              </option>
            ))}
          </select>
          {!conn?.ready ? (
            <p className="text-xs text-destructive">
              Khoá này chưa sẵn sàng — khai, Kiểm tra, Bật ở <Link href="/settings/connections" className="underline">Cài đặt → Kết nối</Link>.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cb-model">Model (để trống = mặc định)</Label>
          <Input id="cb-model" value={c.model} maxLength={60} placeholder="vd claude-sonnet-5" onChange={(e) => set("model", e.target.value.trim())} />
        </div>
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
        <div className="space-y-1.5">
          <Label htmlFor="cb-thinking">Mức suy nghĩ</Label>
          <select id="cb-thinking" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.thinking} onChange={(e) => set("thinking", e.target.value as SalesChatbotConfig["thinking"])}>
            {SALES_THINKING.map((t) => (
              <option key={t} value={t}>
                {SALES_THINKING_LABEL[t]}
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
        </fieldset>
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
