"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { recordConsentAction, revokeConsentAction } from "@/lib/actions/wholesale";
import { formatDateTime } from "@/lib/format";
import { CONSENT_BASES, CONSENT_BASIS_HINT, CONSENT_BASIS_LABEL, CONSENT_CHANNELS, CONSENT_CHANNEL_LABEL, type ConsentBasis, type ConsentChannel } from "@/lib/wholesale/contactability";
import { cn } from "@/lib/utils";

export type ConsentPanelRow = {
  id: string;
  channel: string;
  contactValue: string;
  basis: string;
  evidenceText: string;
  evidenceUrl: string | null;
  recordedByName: string;
  recordedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  revokedByName: string | null;
};

export type ChannelVerdict = { channel: ConsentChannel; allowed: boolean; detail: string };

const sel = "h-8 rounded-md border bg-background px-2 text-sm";

/**
 * Khối «Đồng ý liên hệ» của trang lead (0261): máy có được TỰ liên hệ từng kênh không (kết luận của `contactability`, chế
 * độ AUTOMATED), nhật ký bằng chứng (cả dòng đã thu hồi), form ghi / thu hồi. Không có nút xoá — nhật ký chỉ thêm.
 */
export function ConsentPanel({ leadId, verdicts, rows, canWork, schemaReady = true }: { leadId: string; verdicts: ChannelVerdict[]; rows: ConsentPanelRow[]; canWork: boolean; schemaReady?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<ConsentChannel>("EMAIL");
  const [basis, setBasis] = useState<ConsentBasis>("REPLIED_INBOUND");
  const [value, setValue] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-1">
        {verdicts.map((v) => (
          <li key={v.channel} className="flex gap-2">
            <span className={cn("w-20 shrink-0 font-medium", v.allowed ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>{CONSENT_CHANNEL_LABEL[v.channel]}</span>
            <span>
              <b>{v.allowed ? "Máy được tự liên hệ" : "Máy KHÔNG được tự liên hệ"}</b> — {v.detail}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">Nhân viên tự gọi / tự bấm gửi từng tin vẫn làm như cũ (chỉ danh sách không liên hệ chặn). Email công khai trên website không phải là đồng ý.</p>

      {rows.length ? (
        <ol className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className={cn("rounded-md border p-2", r.revokedAt && "opacity-70")}>
              <div className="text-[11px] text-muted-foreground">
                {CONSENT_CHANNEL_LABEL[r.channel as ConsentChannel] ?? r.channel} · {r.contactValue} · {CONSENT_BASIS_LABEL[r.basis as ConsentBasis] ?? r.basis} · {r.recordedByName || "—"} · {formatDateTime(r.recordedAt)}
              </div>
              <div className="whitespace-pre-wrap">{r.evidenceText}</div>
              {r.evidenceUrl ? (
                <a className="text-[11px] text-primary hover:underline" href={r.evidenceUrl} target="_blank" rel="noopener noreferrer nofollow">
                  bằng chứng
                </a>
              ) : null}
              {r.revokedAt ? (
                <div className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">
                  Đã thu hồi {formatDateTime(r.revokedAt)} · {r.revokedByName || "—"}: {r.revokeReason}
                </div>
              ) : canWork ? (
                revoking === r.id ? (
                  <div className="mt-1 flex gap-1">
                    <Input className="h-8" placeholder="Lý do thu hồi" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const res = await revokeConsentAction(r.id, { reason: revokeReason });
                          if ("error" in res) toast.error(res.error);
                          else {
                            toast.success("Đã thu hồi đồng ý");
                            setRevoking(null);
                            setRevokeReason("");
                            router.refresh();
                          }
                        })
                      }
                    >
                      Thu hồi
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => setRevoking(r.id)}>
                    Thu hồi…
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground">Chưa có bằng chứng đồng ý nào.</p>
      )}

      {!schemaReady ? (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">CSDL của tổ chức chưa áp migration 0261 — chưa ghi được bằng chứng đồng ý. Máy vẫn KHÔNG tự liên hệ kênh nào.</p>
      ) : canWork ? (
        open ? (
          <form
            className="space-y-2 rounded-md border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const res = await recordConsentAction(leadId, { channel, basis, contactValue: value, evidenceText, evidenceUrl });
                if ("error" in res) toast.error(res.error);
                else {
                  toast.success("Đã ghi đồng ý");
                  setOpen(false);
                  setValue("");
                  setEvidenceText("");
                  setEvidenceUrl("");
                  router.refresh();
                }
              });
            }}
          >
            <div className="flex flex-wrap gap-2">
              <select className={sel} value={channel} onChange={(e) => setChannel(e.target.value as ConsentChannel)}>
                {CONSENT_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CONSENT_CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
              <select className={sel} value={basis} onChange={(e) => setBasis(e.target.value as ConsentBasis)}>
                {CONSENT_BASES.map((b) => (
                  <option key={b} value={b}>
                    {CONSENT_BASIS_LABEL[b]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-muted-foreground">{CONSENT_BASIS_HINT[basis]}</p>
            <Input className="h-8" placeholder={channel === "EMAIL" ? "Email khách đồng ý (trống = email của lead)" : "SĐT khách đồng ý (trống = SĐT của lead)"} value={value} onChange={(e) => setValue(e.target.value)} />
            <Input className="h-8" placeholder="Bằng chứng: lúc nào, ai, nội dung gì" value={evidenceText} onChange={(e) => setEvidenceText(e.target.value)} />
            <Input className="h-8" placeholder="Link bằng chứng (nếu có)" value={evidenceUrl} onChange={(e) => setEvidenceUrl(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={pending}>
                Ghi đồng ý
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
                Huỷ
              </Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Ghi bằng chứng đồng ý…
          </Button>
        )
      ) : null}
    </div>
  );
}
