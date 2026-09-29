"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import { saveNotificationPresetAction, sendTestNotificationAction } from "@/lib/actions/notifications";
import type { ConnectionOption, EventPreset } from "@/lib/messaging/presets";
import { MESSAGING_CONNECTOR_LABEL, MESSAGING_DESTINATION_HINT, ORDER_MESSAGE_VAR_KEYS, unknownTemplateKeys, type MessagingConnectorKey, type OrderMessageEvent } from "@/lib/messaging/types";

/**
 * Form «Báo nhóm vận hành»: MỘT kênh + nơi nhận cho cả ba sự kiện, mẫu tin riêng từng sự kiện. Bấm «Gửi thử» đi ĐÚNG
 * đường của luật (sổ gửi tin → nhà cung cấp), điền bằng đơn gần nhất. Máy chủ kiểm lại mọi thứ.
 */
export function NotificationPresetForm({ connections, events, vars }: { connections: ConnectionOption[]; events: EventPreset[]; vars: { key: string; label: string }[] }) {
  const router = useRouter();
  const usable = connections.filter((c) => c.status === "CONNECTED" || c.status === "TEST_MODE");
  const initialKey = (events.find((e) => e.connectorKey)?.connectorKey as MessagingConnectorKey | undefined) ?? usable[0]?.key ?? connections[0]?.key ?? "sandbox-messaging";
  const [connectorKey, setConnectorKey] = useState<MessagingConnectorKey>(initialKey);
  const [destination, setDestination] = useState(events.find((e) => e.destination)?.destination ?? "");
  // Chưa từng cấu hình gửi tin (kể cả luật dựng sẵn của mẫu, chỉ báo trong ERP) ⇒ mặc định CHỌN; đã cấu hình ⇒ theo trạng thái luật.
  const [enabled, setEnabled] = useState<Record<OrderMessageEvent, boolean>>(() => Object.fromEntries(events.map((e) => [e.event, e.configured ? e.enabled : true])) as Record<OrderMessageEvent, boolean>);
  const [templates, setTemplates] = useState<Record<OrderMessageEvent, string>>(() => Object.fromEntries(events.map((e) => [e.event, e.template])) as Record<OrderMessageEvent, string>);
  const [pending, start] = useTransition();
  const conn = connections.find((c) => c.key === connectorKey);
  const problems = useMemo(() => Object.fromEntries(events.map((e) => [e.event, unknownTemplateKeys(templates[e.event] ?? "", ORDER_MESSAGE_VAR_KEYS)])), [events, templates]);

  const save = () =>
    start(async () => {
      const r = await saveNotificationPresetAction({ connectorKey, destination, events: events.filter((e) => enabled[e.event]).map((e) => e.event), templates });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        router.refresh();
      }
    });

  const test = (event: OrderMessageEvent) =>
    start(async () => {
      const r = await sendTestNotificationAction({ connectorKey, destination, event, template: templates[event] });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        router.refresh();
      }
    });

  return (
    <SectionCard title="Khi đơn đổi ⇒ gửi nhóm vận hành" description="Automation preset: When Order Confirmed → Send Order to Operations Group.">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="np-connector">Kênh nhắn tin</Label>
            <select id="np-connector" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={connectorKey} onChange={(e) => setConnectorKey(e.target.value as MessagingConnectorKey)}>
              {connections.map((c) => (
                <option key={c.key} value={c.key}>
                  {MESSAGING_CONNECTOR_LABEL[c.key]} — {c.status === "CONNECTED" ? "đã kết nối" : c.status === "TEST_MODE" ? "chế độ thử" : c.status === "FAILED" ? "lỗi" : c.status === "DRAFT" ? "chưa bật" : "chưa khai"}
                </option>
              ))}
            </select>
            {conn && conn.status !== "CONNECTED" && conn.status !== "TEST_MODE" ? <p className="text-xs text-destructive">Kênh này chưa sẵn sàng — khai, «Kiểm tra» rồi «Bật» ở Cài đặt → Kết nối.</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-destination">Nơi nhận (nhóm / kênh)</Label>
            <Input id="np-destination" value={connectorKey === "lark-webhook" ? "" : destination} disabled={connectorKey === "lark-webhook"} placeholder={conn?.destination ?? ""} maxLength={120} onChange={(e) => setDestination(e.target.value)} />
            <p className="text-xs text-muted-foreground">{MESSAGING_DESTINATION_HINT[connectorKey]}</p>
          </div>
        </div>

        {events.map((e) => (
          <div key={e.event} className="space-y-2 rounded-lg border p-3" data-event={e.event}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={enabled[e.event]} onChange={(ev) => setEnabled((s) => ({ ...s, [e.event]: ev.target.checked }))} />
                {e.label}
              </label>
              <span className="text-xs text-muted-foreground" data-rule-state={e.enabled && e.live ? "live" : e.ruleId ? "off" : "none"}>
                {!e.ruleId ? "Chưa có luật" : !e.configured ? "Luật của mẫu — chưa gửi nhóm" : e.enabled ? (e.live ? "Luật đang CHẠY THẬT" : "Luật đang bật (chạy thử)") : "Luật đang tắt"}
              </span>
            </div>
            <Textarea rows={7} value={templates[e.event]} maxLength={2000} aria-label={`Mẫu tin — ${e.label}`} onChange={(ev) => setTemplates((s) => ({ ...s, [e.event]: ev.target.value }))} />
            {problems[e.event]?.length ? <p className="text-xs text-destructive">Ô không điền được: {problems[e.event].map((k) => `{{${k}}}`).join(", ")}</p> : null}
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => test(e.event)}>
              <Send /> Gửi thử
            </Button>
          </div>
        ))}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Các ô điền được trong mẫu tin</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {vars.map((v) => (
              <li key={v.key}>
                <code className="rounded bg-muted px-1">{`{{${v.key}}}`}</code> — {v.label}
              </li>
            ))}
          </ul>
        </details>

        <Button type="button" onClick={save} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Lưu và bật
        </Button>
      </div>
    </SectionCard>
  );
}
