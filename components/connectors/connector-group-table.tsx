"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { discoverChatsAction, saveConnectionAction, setConnectionStatusAction, testConnectionAction } from "@/lib/actions/connections";
import { CHAT_DISCOVERY_CONNECTORS, type DiscoveredChatView } from "@/lib/connectors/types";
import { CONNECTION_STATUS_LABEL, CONNECTOR_AUTH_LABEL } from "@/lib/connectors/registry";
import type { ConnectorView } from "@/lib/connectors/types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BẢNG CONNECTOR CỦA MỘT LOẠI — `/settings/connections` ═══════════
 *
 * Ô bí mật LUÔN trống: máy chủ không bao giờ gửi giá trị về, chỉ gợi ý `••••` + 4 ký tự cuối. Để trống
 * khi lưu = giữ giá trị đã lưu. Mỗi nút gọi một server action; `revalidatePath` dựng lại trang, không
 * `router.refresh()` thêm (dựng hai lần — tiền lệ PR #272).
 */

const TONE = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  muted: "bg-muted text-muted-foreground",
  dashed: "border border-dashed border-border text-muted-foreground",
} as const;

function Pill({ tone, children, title }: { tone: keyof typeof TONE; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

function StatusCell({ row }: { row: ConnectorView }) {
  if (row.mode === "HOME_ONLY_UNAVAILABLE") return <Pill tone="dashed" title="Credential ở biến môi trường của tổ chức nhà — tổ chức khác chưa dùng được">Chỉ tổ chức nhà — chưa mở</Pill>;
  if (row.mode === "HOME_READONLY") {
    const r = row.homeReadiness;
    if (!r) return <Pill tone="muted">Chưa rõ</Pill>;
    return (
      <div className="space-y-0.5">
        <Pill tone={r.state === "CONFIGURED" ? "ok" : r.state === "NOT_CONFIGURED" ? "warn" : "muted"}>{r.state === "CONFIGURED" ? "Đã cấu hình (máy chủ)" : r.state === "NOT_CONFIGURED" ? "Chưa cấu hình" : "Chưa rõ"}</Pill>
        <p className="text-[11px] leading-4 text-muted-foreground">{r.detail}</p>
      </div>
    );
  }
  if (row.mode === "ELSEWHERE") return <Pill tone="muted">Theo tổ chức · cấu hình ở chỗ khác</Pill>;
  const c = row.connection;
  if (!c) return <Pill tone="muted">Chưa khai</Pill>;
  return (
    <div className="space-y-0.5">
      <Pill tone={c.status === "ACTIVE" ? "ok" : c.status === "DRAFT" ? "warn" : "muted"}>{CONNECTION_STATUS_LABEL[c.status]}</Pill>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {c.lastTestAt ? `${c.lastTestOk ? "✓ Kiểm tra đạt" : "✗ Kiểm tra hỏng"} · ${formatDateTime(c.lastTestAt)}` : "Chưa kiểm tra"}
      </p>
      {c.lastTestMessage ? <p className="max-w-[260px] text-[11px] leading-4 text-muted-foreground">{c.lastTestMessage}</p> : null}
    </div>
  );
}

function ConfigForm({ row, secretsReady }: { row: ConnectorView; secretsReady: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(row.connection?.settings ?? {}) }));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [found, setFound] = useState<DiscoveredChatView[] | null>(null);
  const [pending, start] = useTransition();
  const canDiscover = (CHAT_DISCOVERY_CONNECTORS as readonly string[]).includes(row.key);
  const c = row.connection;
  const disabled = pending || !row.moduleEnabled;
  // «Kiểm tra» luôn kiểm cấu hình ĐÃ LƯU: còn thay đổi chưa lưu thì khoá nút và nói ra (01/10/2026: khách chọn nhóm mới bằng
  // «Tìm chat» rồi bấm Kiểm tra ba lần — lần nào cũng kiểm Chat ID cũ và báo «chat not found»).
  const saved = c?.settings ?? {};
  const dirty = Object.keys({ ...saved, ...values }).some((k) => (values[k] ?? "") !== (saved[k] ?? "")) || Object.values(secrets).some((v) => v.trim() !== "");

  const run = (fn: () => Promise<{ ok: true; message?: string } | { error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message ?? "Đã lưu");
        after?.();
      }
    });

  return (
    <div className="space-y-2">
      {row.fields.map((f) => (
        <label key={f.key} className="block space-y-0.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {f.label}
            {f.required ? " *" : ""}
            {f.secret ? " · bí mật" : ""}
          </span>
          <Input
            type={f.secret ? "password" : f.type === "url" ? "url" : "text"}
            autoComplete="off"
            className="h-8 text-xs"
            value={f.secret ? (secrets[f.key] ?? "") : (values[f.key] ?? "")}
            placeholder={f.secret ? (c?.secretHints[f.key] ? `Đã lưu ${c.secretHints[f.key]} — để trống để giữ` : f.hint ?? "Chưa lưu") : (f.hint ?? "")}
            onChange={(e) => (f.secret ? setSecrets((s) => ({ ...s, [f.key]: e.target.value })) : setValues((s) => ({ ...s, [f.key]: e.target.value })))}
            disabled={disabled || (f.secret && !secretsReady)}
          />
        </label>
      ))}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => run(() => saveConnectionAction({ connectorKey: row.key, settings: values, secrets }), () => setSecrets({}))}>
          Lưu
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || !c || dirty} onClick={() => run(() => testConnectionAction(row.key))} title={dirty ? "Có thay đổi chưa lưu — bấm «Lưu» trước" : row.hasHealthCheck ? "Gửi một yêu cầu thật tới nhà cung cấp" : undefined}>
          Kiểm tra
        </Button>
        {canDiscover ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !c}
            title="Nhắn cho bot (hoặc @nhắc bot trong nhóm) trước, rồi bấm để lấy mã chat"
            onClick={() =>
              start(async () => {
                const r = await discoverChatsAction(row.key);
                if ("error" in r) {
                  toast.error(r.error);
                  return;
                }
                setFound(r.chats);
                toast.message(r.message);
              })
            }
          >
            Tìm chat
          </Button>
        ) : null}
        {c?.status === "ACTIVE" ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => run(() => setConnectionStatusAction({ connectorKey: row.key, status: "DISABLED" }))}>
            Tắt
          </Button>
        ) : (
          <Button size="sm" disabled={disabled || c?.lastTestOk !== true} title={c?.lastTestOk === true ? undefined : "Chỉ bật được sau khi Kiểm tra đạt"} onClick={() => run(() => setConnectionStatusAction({ connectorKey: row.key, status: "ACTIVE" }))}>
            Bật
          </Button>
        )}
      </div>
      {dirty && c ? <p className="text-[11px] leading-4 text-amber-700 dark:text-amber-400" data-testid="connection-unsaved">Có thay đổi chưa lưu — «Kiểm tra» kiểm cấu hình đã lưu, bấm «Lưu» trước.</p> : null}
      {found && found.length ? (
        <ul className="space-y-1 rounded-md border p-2 text-[11px]" data-testid="discovered-chats">
          {found.map((chat) => (
            <li key={chat.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <b>{chat.type === "GROUP" ? "Nhóm" : "Cá nhân"}</b> · {chat.name || "—"} · <code className="text-[10px]">{chat.id}</code>
                {chat.sample ? ` · «${chat.sample}»` : ""}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[11px]"
                disabled={disabled}
                onClick={() => {
                  // «Dùng» = chọn VÀ lưu: bước Lưu tách rời là chỗ người dùng bỏ sót.
                  const next = { ...values, chatId: chat.id };
                  setValues(next);
                  run(() => saveConnectionAction({ connectorKey: row.key, settings: next, secrets }), () => {
                    setSecrets({});
                    toast.message("Đã lưu Chat ID — bấm «Kiểm tra».");
                  });
                }}
              >
                Dùng
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {row.consumers.length === 0 ? <p className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">Chưa luồng nào của ERP dùng kết nối này — bật lên chưa làm cảnh báo đi qua đây.</p> : null}
    </div>
  );
}

function ConfigCell({ row, secretsReady }: { row: ConnectorView; secretsReady: boolean }) {
  const [open, setOpen] = useState(false);
  if (row.mode === "CONFIGURABLE") {
    if (!row.moduleEnabled) return <span className="text-xs text-muted-foreground">Module «{row.moduleLabel}» đang tắt — bật ở Module của tổ chức.</span>;
    return open ? (
      <ConfigForm row={row} secretsReady={secretsReady} />
    ) : (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {row.connection ? "Sửa cấu hình" : "Khai kết nối"}
      </Button>
    );
  }
  const where = row.configWhere;
  const href = where.match(/\/(landing|bank|alerts|integrations)\b/)?.[0];
  return (
    <span className="text-xs leading-4 text-muted-foreground">
      {where}
      {href && row.mode !== "HOME_ONLY_UNAVAILABLE" ? (
        <>
          {" · "}
          <Link className="text-primary underline-offset-2 hover:underline" href={href}>
            Mở {href}
          </Link>
        </>
      ) : null}
    </span>
  );
}

export function ConnectorGroupTable({ rows, secretsReady }: { rows: ConnectorView[]; secretsReady: boolean }) {
  if (rows.length === 0) return <p className="p-3 text-xs text-muted-foreground">Chưa có connector nào thuộc loại này.</p>;
  return (
    <table className="w-full min-w-[860px] text-left text-[13px]">
      <thead>
        <tr className="border-b border-hairline text-[11px] uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-2 font-medium">Connector</th>
          <th className="px-3 py-2 font-medium">Thuê bao · xác thực</th>
          <th className="px-3 py-2 font-medium">Trạng thái</th>
          <th className="w-[380px] px-3 py-2 font-medium">Cấu hình</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-hairline align-top last:border-b-0">
            <td className="px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">{row.label}</span>
                <InfoHint label={`Vì sao «${row.label}» được khai như vậy`}>
                  <p className="text-xs leading-5">{row.why}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Năng lực: {row.capabilities.join(" · ")}</p>
                  {row.webhook ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Webhook <span className="font-mono">{row.webhook.path}</span> · phân giải tổ chức: {row.webhook.tenantResolution}
                    </p>
                  ) : null}
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">{row.key}</p>
                </InfoHint>
              </div>
              <p className="text-xs text-muted-foreground">
                {row.vendor} · module {row.moduleLabel}
              </p>
            </td>
            <td className="px-3 py-2.5">
              <div className="flex flex-wrap gap-1">
                <Pill tone={row.tenancy === "PER_ORG" ? "ok" : "dashed"}>{row.tenancy === "PER_ORG" ? "Theo tổ chức" : "Chỉ tổ chức nhà"}</Pill>
                <Pill tone="muted">{CONNECTOR_AUTH_LABEL[row.auth]}</Pill>
                {row.hasHealthCheck ? <Pill tone="muted">Có kiểm tra</Pill> : null}
              </div>
            </td>
            <td className="px-3 py-2.5">
              <StatusCell row={row} />
            </td>
            <td className="px-3 py-2.5">
              <ConfigCell row={row} secretsReady={secretsReady} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
