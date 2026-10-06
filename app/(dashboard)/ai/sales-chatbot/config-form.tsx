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
import { SALES_BOT_FAILURE_LABEL, SALES_TONE_LABEL, SALES_TONES, SALES_TOOL_LABEL, SALES_TOOLS, type SalesBotConnector, type SalesChatbotConfig, type SalesTool, SALES_THINKING, SALES_THINKING_LABEL } from "@/lib/sales-chatbot/config";
import type { AiFailureClass } from "@/lib/constants/ai-incidents";
import { formatDateTime } from "@/lib/format";

/** Sức khoẻ MỘT khoá AI (lib/sales-chatbot/provider-failover.ts) — hình dạng thuần để truyền từ trang máy chủ. */
export type ProviderHealthView = { key: string; lastSuccessAt: string | null; lastFailureAt: string | null; lastErrorClass: AiFailureClass | null; openUntil: string | null };

const DAY_LABEL = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const CONNECTOR_LABEL: Record<SalesBotConnector, string> = { platform: "AI dùng chung của nền tảng — tính vào gói, không cần khoá riêng", "anthropic-byok": "Anthropic (Claude) — khoá của tổ chức", "openai-byok": "OpenAI — khoá của tổ chức", "gemini-byok": "Google Gemini — khoá của tổ chức (rẻ nhất)" };

/** Form cấu hình chatbot — máy chủ kiểm lại bằng CÙNG lược đồ (`salesChatbotConfigZ`). */
export function ChatbotConfigForm({
  config,
  fields,
  connections,
  appointmentsOn = false,
  health = [],
}: {
  config: SalesChatbotConfig;
  fields: { key: string; label: string }[];
  connections: { key: SalesBotConnector; ready: boolean; configured: boolean; reason?: string | null; vendor?: string | null }[];
  /** Module Lịch hẹn đang bật — chỉ khi đó mới có khung «Đặt lịch qua chat». */
  appointmentsOn?: boolean;
  /** Sức khoẻ khoá AI chính / dự phòng (mạch ngắt, lần trả lời được / lỗi gần nhất). */
  health?: ProviderHealthView[];
}) {
  const router = useRouter();
  const [c, setC] = useState<SalesChatbotConfig>(config);
  const [shipping, setShipping] = useState(config.shippingFee === null ? "" : String(config.shippingFee));
  // Miễn ship: nhập dạng chữ (để trống = không xét ngưỡng đó), đổi sang số lúc lưu.
  const [freeMin, setFreeMin] = useState(config.freeShipping.minSubtotal === null ? "" : String(config.freeShipping.minSubtotal));
  const [freeKg, setFreeKg] = useState(config.freeShipping.minWeightGrams === null ? "" : String(config.freeShipping.minWeightGrams / 1000).replace(".", ","));
  const [freeAreas, setFreeAreas] = useState(config.freeShipping.areas.join("\n"));
  const [pending, start] = useTransition();
  const set = <K extends keyof SalesChatbotConfig>(k: K, v: SalesChatbotConfig[K]) => setC((s) => ({ ...s, [k]: v }));
  const setBooking = (patch: Partial<SalesChatbotConfig["booking"]>) => set("booking", { ...c.booking, ...patch });
  const num = (raw: string, fallback: number) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);
  const conn = connections.find((x) => x.key === c.connectorKey);
  const fallbackConn = c.fallbackConnectorKey ? connections.find((x) => x.key === c.fallbackConnectorKey) : undefined;
  // Sự cố 06/10/2026: khoá của shop và khoá nền tảng cùng là Gemini, cùng tài khoản Google ⇒ hết tiền CÙNG LÚC.
  const sameVendor = Boolean(fallbackConn?.vendor && conn?.vendor && fallbackConn.vendor === conn.vendor);
  // Mốc «bây giờ» của lần dựng trang (useState: một lần, không đổi giữa các lần vẽ lại) — đủ để nói khoá nào đang tạm ngắt.
  const [renderedAt] = useState(() => Date.now());
  const healthRows = health.filter((h) => h.key === c.connectorKey || h.key === c.fallbackConnectorKey).map((h) => ({ ...h, open: h.openUntil !== null && Date.parse(h.openUntil) > renderedAt }));

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
      const r = await saveSalesChatbotConfigAction({ ...c, shippingFee: ship, freeShipping, enabled: enabled ?? c.enabled });
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
        <div className="space-y-1.5">
          <Label htmlFor="cb-conn">Khoá AI (nhà cung cấp)</Label>
          <select id="cb-conn" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.connectorKey} onChange={(e) => set("connectorKey", e.target.value as SalesBotConnector)}>
            {connections.map((x) => (
              <option key={x.key} value={x.key}>
                {CONNECTOR_LABEL[x.key]} — {x.ready ? (x.key === "platform" ? "dùng được" : "đã bật") : x.key === "platform" ? "chưa dùng được" : x.configured ? "chưa bật" : "chưa khai"}
              </option>
            ))}
          </select>
          {!conn?.ready ? (
            <p className="text-xs text-destructive">
              {c.connectorKey === "platform" ? (
                conn?.reason ?? "AI dùng chung chưa dùng được."
              ) : (
                <>
                  Khoá này chưa sẵn sàng — khai, Kiểm tra, Bật ở <Link href="/settings/connections" className="underline">Cài đặt → Kết nối</Link>.
                </>
              )}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cb-model">Model (để trống = mặc định)</Label>
          <Input id="cb-model" value={c.model} maxLength={60} placeholder="vd claude-sonnet-5" onChange={(e) => set("model", e.target.value.trim())} />
        </div>
        <fieldset className="space-y-2 rounded-md border p-3 sm:col-span-2" data-testid="chatbot-failover">
          <legend className="px-1 text-sm font-medium">Khoá AI dự phòng</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="cb-fb-conn" className="text-xs">Khi khoá chính hỏng, chuyển sang</Label>
              <select id="cb-fb-conn" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.fallbackConnectorKey ?? ""} onChange={(e) => set("fallbackConnectorKey", e.target.value ? (e.target.value as SalesBotConnector) : null)}>
                <option value="">Không có dự phòng — chuyển thẳng cho nhân viên</option>
                {connections
                  .filter((x) => x.key !== c.connectorKey)
                  .map((x) => (
                    <option key={x.key} value={x.key}>
                      {CONNECTOR_LABEL[x.key]} — {x.ready ? (x.key === "platform" ? "dùng được" : "đã bật") : x.key === "platform" ? "chưa dùng được" : x.configured ? "chưa bật" : "chưa khai"}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cb-fb-model" className="text-xs">Model dự phòng (để trống = mặc định)</Label>
              <Input id="cb-fb-model" value={c.fallbackModel} maxLength={60} disabled={!c.fallbackConnectorKey} onChange={(e) => set("fallbackModel", e.target.value.trim())} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cb-fb-open" className="text-xs">Hết tiền / khoá bị từ chối ⇒ ngắt khoá đó (phút)</Label>
              <Input id="cb-fb-open" inputMode="numeric" value={String(c.failoverOpenMinutes)} disabled={!c.fallbackConnectorKey} onChange={(e) => set("failoverOpenMinutes", Math.min(1440, Math.max(1, num(e.target.value, c.failoverOpenMinutes))))} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.failoverEnabled} disabled={!c.fallbackConnectorKey} onChange={(e) => set("failoverEnabled", e.target.checked)} /> Tự chuyển sang khoá dự phòng
          </label>
          {sameVendor ? (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="chatbot-failover-same-vendor">
              Khoá dự phòng cùng nhà cung cấp «{conn?.vendor}» với khoá chính — nếu hai khoá chung một tài khoản thì hết tiền / bị khoá CÙNG LÚC và dự phòng không cứu được (sự cố 06/10/2026). Nên chọn nhà cung cấp khác.
            </p>
          ) : null}
          {fallbackConn && !fallbackConn.ready ? <p className="text-xs text-destructive">Khoá dự phòng chưa sẵn sàng — lúc cần chuyển mà nó chưa dùng được thì khách vẫn được chuyển cho nhân viên như khi không có dự phòng.</p> : null}
          <p className="text-xs text-muted-foreground">
            Chỉ chuyển khi lỗi nằm ở NHÀ CUNG CẤP (hết tiền, khoá bị từ chối, quá tải, lỗi máy chủ, quá giờ chờ) và TRƯỚC khi có chữ nào gửi khách — khách không bao giờ nhận hai câu trả lời. Khoá dự phòng trả tiền ở chính nó{c.fallbackConnectorKey === "platform" ? " (AI dùng chung vẫn trừ credit gói và dừng khi hết credit)" : ""}. Khoá chính khoẻ lại ⇒ bot tự quay về. Cả hai cùng hỏng ⇒ chuyển nhân viên như cũ.
          </p>
          {healthRows.length ? (
            <ul className="space-y-0.5 text-xs" data-testid="chatbot-provider-health">
              {healthRows.map((h) => (
                <li key={h.key}>
                  <span className="font-medium">{h.key === c.connectorKey ? "Khoá chính" : h.key === c.fallbackConnectorKey ? "Khoá dự phòng" : "Khoá"}</span> «{h.key}»: {h.open ? <span className="text-destructive">đang tạm ngắt tới {formatDateTime(h.openUntil)}</span> : "đang dùng được"}
                  {h.lastSuccessAt ? ` · trả lời được lần gần nhất ${formatDateTime(h.lastSuccessAt)}` : ""}
                  {h.lastFailureAt ? ` · lỗi gần nhất ${formatDateTime(h.lastFailureAt)}${h.lastErrorClass ? ` (${SALES_BOT_FAILURE_LABEL[h.lastErrorClass]})` : ""}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
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
