"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addProductionTopicMessage, setProductionTopicStatus } from "@/lib/actions/production-topics";
import { TOPIC_MESSAGE_KIND_LABEL, TOPIC_MESSAGE_KINDS, TOPIC_STATUS_LABEL, TOPIC_TRANSITIONS, type TopicMessageKind, type TopicStatus } from "@/lib/constants/production-os";

/** Thêm một lượt trao đổi (append-only — không sửa, không xoá). */
export function TopicMessageForm({ topicId }: { topicId: string }) {
  const [kind, setKind] = useState<TopicMessageKind>("NOTE");
  const [body, setBody] = useState("");
  const [price, setPrice] = useState("");
  const [links, setLinks] = useState("");
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const gui = () =>
    start(async () => {
      const r = await addProductionTopicMessage({
        topicId,
        kind,
        body,
        attachments: links.split(/\s+/).map((x) => x.trim()).filter(Boolean),
        quotedUnitPrice: kind === "QUOTE" && price.trim() ? Math.round(Number(price)) : null,
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setBody("");
      setPrice("");
      setLinks("");
      router.refresh();
    });
  return (
    <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
      <div className="flex flex-wrap gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as TopicMessageKind)} className="h-9 rounded-md border bg-background px-2 text-sm">
          {TOPIC_MESSAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {TOPIC_MESSAGE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        {kind === "QUOTE" ? <Input className="h-9 w-44" inputMode="numeric" placeholder="Giá xưởng báo (đ/sp)" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ""))} /> : null}
      </div>
      <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Nội dung trao đổi với xưởng / nội bộ…" />
      <Input value={links} onChange={(e) => setLinks(e.target.value)} placeholder="Link ảnh / tài liệu (cách nhau bằng dấu cách)" />
      <div className="flex justify-end">
        <Button size="sm" onClick={gui} disabled={pending || !body.trim() || (kind === "QUOTE" && !price.trim())}>
          Ghi lượt trao đổi
        </Button>
      </div>
    </div>
  );
}

/** Đổi trạng thái topic — chỉ hiện nước đi hợp lệ (`TOPIC_TRANSITIONS`). */
export function TopicStatusControl({ topicId, status }: { topicId: string; status: TopicStatus }) {
  const [to, setTo] = useState<TopicStatus | null>(null);
  const [note, setNote] = useState("");
  const [option, setOption] = useState("");
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const doi = () =>
    start(async () => {
      if (!to) return;
      const r = await setProductionTopicStatus({ topicId, to, note: note.trim() || null, selectedOption: to === "SELECTED" ? option : null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setTo(null);
      setNote("");
      setOption("");
      router.refresh();
    });
  const nuocDi = TOPIC_TRANSITIONS[status];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {nuocDi.map((s) => (
          <Button key={s} size="sm" variant={to === s ? "default" : "outline"} disabled={pending} onClick={() => setTo(to === s ? null : s)}>
            {TOPIC_STATUS_LABEL[s]}
          </Button>
        ))}
      </div>
      {to ? (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          {to === "SELECTED" ? <Input value={option} onChange={(e) => setOption(e.target.value)} placeholder="Phương án được chọn (bắt buộc)" /> : null}
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={status === "CLOSED" ? "Vì sao mở lại (bắt buộc)" : "Ghi chú (tuỳ chọn)"} />
          <div className="flex justify-end">
            <Button size="sm" onClick={doi} disabled={pending}>
              Chuyển sang “{TOPIC_STATUS_LABEL[to]}”
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
