"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { SALES_BOT_FAILURE_LABEL, SALES_THINKING, SALES_THINKING_LABEL, type SalesBotConnector } from "@/lib/sales-chatbot/config";
import type { ChatbotEngineConfig, EngineConnectionView, ProviderHealthView } from "@/lib/saas/visibility";

const CONNECTOR_LABEL: Record<SalesBotConnector, string> = { platform: "AI dùng chung của nền tảng — tính vào gói, không cần khoá riêng", "anthropic-byok": "Anthropic (Claude) — khoá của tổ chức", "openai-byok": "OpenAI — khoá của tổ chức", "gemini-byok": "Google Gemini — khoá của tổ chức (rẻ nhất)" };

function connectorState(x: EngineConnectionView): string {
  return x.ready ? (x.key === "platform" ? "dùng được" : "đã bật") : x.key === "platform" ? "chưa dùng được" : x.configured ? "chưa bật" : "chưa khai";
}

/**
 * ĐỘNG CƠ AI của chatbot bán hàng — nguồn AI, model, khoá dự phòng, mạch ngắt, mức suy nghĩ, sức khoẻ khoá. Chỉ workspace
 * NHÀ (trang chatbot của nhà) và NGƯỜI VẬN HÀNH (khối «AI của workspace» ở `/platform/org/<mã>`) dựng khối này; workspace
 * khách không nhận các ô này trong props (lib/saas/visibility.ts).
 */
export function AiEngineFields({
  value,
  onChange,
  connections,
  health = [],
  notReadyHint,
  idPrefix = "cb",
}: {
  value: ChatbotEngineConfig;
  onChange: (patch: Partial<ChatbotEngineConfig>) => void;
  connections: EngineConnectionView[];
  health?: ProviderHealthView[];
  /** Câu dưới ô nguồn AI khi khoá đã chọn chưa sẵn sàng (khác nhau giữa trang nhà và khối vận hành). */
  notReadyHint: React.ReactNode;
  idPrefix?: string;
}) {
  const c = value;
  const num = (raw: string, fallback: number) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback);
  const conn = connections.find((x) => x.key === c.connectorKey);
  const fallbackConn = c.fallbackConnectorKey ? connections.find((x) => x.key === c.fallbackConnectorKey) : undefined;
  // Sự cố 06/10/2026: khoá của shop và khoá nền tảng cùng là Gemini, cùng tài khoản Google ⇒ hết tiền CÙNG LÚC.
  const sameVendor = Boolean(fallbackConn?.vendor && conn?.vendor && fallbackConn.vendor === conn.vendor);
  // Mốc «bây giờ» của lần dựng trang (useState: một lần, không đổi giữa các lần vẽ lại) — đủ để nói khoá nào đang tạm ngắt.
  const [renderedAt] = useState(() => Date.now());
  const healthRows = health.filter((h) => h.key === c.connectorKey || h.key === c.fallbackConnectorKey).map((h) => ({ ...h, open: h.openUntil !== null && Date.parse(h.openUntil) > renderedAt }));
  const id = (k: string) => `${idPrefix}-${k}`;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={id("conn")}>Khoá AI (nhà cung cấp)</Label>
        <select id={id("conn")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.connectorKey} onChange={(e) => onChange({ connectorKey: e.target.value as SalesBotConnector })}>
          {connections.map((x) => (
            <option key={x.key} value={x.key}>
              {CONNECTOR_LABEL[x.key]} — {connectorState(x)}
            </option>
          ))}
        </select>
        {!conn?.ready ? <p className="text-xs text-destructive">{c.connectorKey === "platform" ? (conn?.reason ?? "AI dùng chung chưa dùng được.") : notReadyHint}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id("model")}>Model (để trống = mặc định)</Label>
        <Input id={id("model")} value={c.model} maxLength={60} placeholder="vd claude-sonnet-5" onChange={(e) => onChange({ model: e.target.value.trim() })} />
      </div>
      <fieldset className="space-y-2 rounded-md border p-3 sm:col-span-2" data-testid="chatbot-failover">
        <legend className="px-1 text-sm font-medium">Khoá AI dự phòng</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={id("fb-conn")} className="text-xs">
              Khi khoá chính hỏng, chuyển sang
            </Label>
            <select id={id("fb-conn")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.fallbackConnectorKey ?? ""} onChange={(e) => onChange({ fallbackConnectorKey: e.target.value ? (e.target.value as SalesBotConnector) : null })}>
              <option value="">Không có dự phòng — chuyển thẳng cho nhân viên</option>
              {connections
                .filter((x) => x.key !== c.connectorKey)
                .map((x) => (
                  <option key={x.key} value={x.key}>
                    {CONNECTOR_LABEL[x.key]} — {connectorState(x)}
                  </option>
                ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={id("fb-model")} className="text-xs">
              Model dự phòng (để trống = mặc định)
            </Label>
            <Input id={id("fb-model")} value={c.fallbackModel} maxLength={60} disabled={!c.fallbackConnectorKey} onChange={(e) => onChange({ fallbackModel: e.target.value.trim() })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id("fb-open")} className="text-xs">
              Hết tiền / khoá bị từ chối ⇒ ngắt khoá đó (phút)
            </Label>
            <Input id={id("fb-open")} inputMode="numeric" value={String(c.failoverOpenMinutes)} disabled={!c.fallbackConnectorKey} onChange={(e) => onChange({ failoverOpenMinutes: Math.min(1440, Math.max(1, num(e.target.value, c.failoverOpenMinutes))) })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.failoverEnabled} disabled={!c.fallbackConnectorKey} onChange={(e) => onChange({ failoverEnabled: e.target.checked })} /> Tự chuyển sang khoá dự phòng
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
        <Label htmlFor={id("thinking")}>Mức suy nghĩ</Label>
        <select id={id("thinking")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={c.thinking} onChange={(e) => onChange({ thinking: e.target.value as ChatbotEngineConfig["thinking"] })}>
          {SALES_THINKING.map((t) => (
            <option key={t} value={t}>
              {SALES_THINKING_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
