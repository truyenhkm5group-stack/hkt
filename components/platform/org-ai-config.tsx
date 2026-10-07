"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AiEngineFields } from "@/components/ai-usage/ai-engine-fields";
import { operateOrgAiConnectionAction, saveOrgChatbotEngineAction } from "@/lib/actions/platform-org-ai";
import { formatDateTime } from "@/lib/format";
import type { OperatorAiConnectionRow } from "@/lib/connectors/service";
import type { ChatbotEngineConfig, EngineConnectionView, ProviderHealthView } from "@/lib/saas/visibility";

const STATUS_LABEL: Record<string, string> = { DRAFT: "Nháp", ACTIVE: "Đang bật", DISABLED: "Đã tắt" };

/**
 * Khối «AI của workspace» (người vận hành nền tảng): động cơ AI của chatbot + khoá AI của workspace khách. Khách không còn ô
 * nào trong số này (lib/saas/visibility.ts). Mỗi lượt ghi cần LÝ DO — vào nhật ký của tổ chức và nhật ký nền tảng.
 * Khoá CHỈ NHẬP: ô bí mật luôn trống, để trống = giữ khoá đã lưu; màn hình chỉ nói «đã có khoá» hay chưa.
 */
export function OrgAiConfigPanel({ orgCode, botEnabled, engine, connections, health, keys }: { orgCode: string; botEnabled: boolean; engine: ChatbotEngineConfig; connections: EngineConnectionView[]; health: ProviderHealthView[]; keys: OperatorAiConnectionRow[] }) {
  const [value, setValue] = useState<ChatbotEngineConfig>(engine);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true; message: string } | { error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        after?.();
      }
    });

  return (
    <div className="space-y-5 px-5 pb-4" data-testid="org-ai-config">
      <div className="space-y-1.5">
        <Label htmlFor="org-ai-reason">Lý do (bắt buộc cho mọi lượt ghi — vào nhật ký của tổ chức và của nền tảng)</Label>
        <Input id="org-ai-reason" value={reason} maxLength={500} placeholder="vd «Khoá Gemini của shop hết credit, chuyển sang AI dùng chung theo yêu cầu chủ shop»" onChange={(e) => setReason(e.target.value)} />
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold">
          Động cơ AI của chatbot bán hàng <span className="font-normal text-muted-foreground">— bot đang {botEnabled ? "BẬT" : "tắt"}; mọi ô khác của chủ shop giữ nguyên</span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <AiEngineFields idPrefix="op" value={value} onChange={(patch) => setValue((s) => ({ ...s, ...patch }))} connections={connections} health={health} notReadyHint="Khoá này của workspace chưa sẵn sàng — Lưu, Kiểm tra, Bật ở phần Khoá AI bên dưới." />
        </div>
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => saveOrgChatbotEngineAction({ orgCode, reason, engine: value }))}>
          Lưu cấu hình AI
        </Button>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold">Khoá AI của workspace</p>
        {keys.map((k) => (
          <KeyRow key={k.connectorKey} row={k} orgCode={orgCode} reason={reason} pending={pending} run={run} />
        ))}
      </div>
    </div>
  );
}

function KeyRow({ row, orgCode, reason, pending, run }: { row: OperatorAiConnectionRow; orgCode: string; reason: string; pending: boolean; run: (fn: () => Promise<{ ok: true; message: string } | { error: string }>, after?: () => void) => void }) {
  const [settings, setSettings] = useState<Record<string, string>>(row.plainSettings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const op = (o: "save" | "test" | "activate" | "disable") => run(() => operateOrgAiConnectionAction({ orgCode, reason, connectorKey: row.connectorKey, op: o, ...(o === "save" ? { settings, secrets } : {}) }), o === "save" ? () => setSecrets({}) : undefined);
  return (
    <div className="space-y-2 rounded-lg border p-3" data-connector={row.connectorKey}>
      <p className="text-sm">
        <span className="font-medium">{row.label}</span> · {row.status ? (STATUS_LABEL[row.status] ?? row.status) : "chưa khai"} · {row.hasSecret ? "đã có khoá" : "chưa có khoá"}
        {row.lastTestAt ? ` · kiểm tra ${row.lastTestOk ? "đạt" : "hỏng"} lúc ${formatDateTime(row.lastTestAt)}` : ""}
      </p>
      {row.lastTestOk === false && row.lastTestMessage ? <p className="text-xs text-destructive">{row.lastTestMessage}</p> : null}
      <div className="grid gap-2 sm:grid-cols-3">
        {row.fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label htmlFor={`op-${row.connectorKey}-${f.key}`} className="text-xs">
              {f.label}
            </Label>
            {f.secret ? (
              <Input id={`op-${row.connectorKey}-${f.key}`} type="password" autoComplete="off" value={secrets[f.key] ?? ""} placeholder={row.hasSecret ? "Để trống = giữ khoá đã lưu" : "Dán khoá"} onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))} />
            ) : (
              <Input id={`op-${row.connectorKey}-${f.key}`} value={settings[f.key] ?? ""} onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))} />
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => op("save")}>
          Lưu
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || !row.status} onClick={() => op("test")}>
          Kiểm tra
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || row.status === "ACTIVE" || row.lastTestOk !== true} onClick={() => op("activate")}>
          Bật
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending || row.status !== "ACTIVE"} onClick={() => op("disable")}>
          Tắt
        </Button>
      </div>
    </div>
  );
}
