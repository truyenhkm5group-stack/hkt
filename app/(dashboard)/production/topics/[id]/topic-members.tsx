"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { PeoplePicker, type PickablePerson } from "@/app/(dashboard)/production/_components/people-picker";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { restrictProductionTopic, tagTopicMembers, untagTopicMember } from "@/lib/actions/production-topics";

export type TopicMemberView = { userId: string; name: string; email: string; active: boolean };

/**
 * Khung "Người trong topic": người mở + người được tag. Tag thêm được NHIỀU người một lượt (mỗi người mới
 * nhận tin ở quả chuông); bỏ tag chỉ người mở topic / ADMIN — máy chủ kiểm lại cả hai (`loadTopicAccess`).
 */
export function TopicMembersPanel({
  topicId,
  creatorName,
  members,
  people,
  canTag,
  canUntag,
  restricted,
}: {
  topicId: string;
  creatorName: string;
  members: TopicMemberView[];
  people: PickablePerson[];
  canTag: boolean;
  canUntag: boolean;
  restricted: boolean;
}) {
  const [chon, setChon] = useState<string[]>([]);
  const [pending, start] = useNavTransition();
  const daCo = new Set(members.map((m) => m.userId));
  const conLai = people.filter((p) => !daCo.has(p.id));

  const tag = () =>
    start(async () => {
      const r = await tagTopicMembers({ topicId, userIds: chon });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.added ? `Đã tag ${r.added} người — họ nhận thông báo ở quả chuông` : "Những người này đã ở trong topic");
      setChon([]);
    });

  const boTag = (m: TopicMemberView) => {
    if (!window.confirm(`Bỏ tag ${m.name || m.email}?${restricted ? " Người này sẽ không xem được topic nữa." : ""}`)) return;
    start(async () => {
      const r = await untagTopicMember({ topicId, userId: m.userId });
      if ("error" in r) toast.error(r.error);
      else toast.success("Đã bỏ tag");
    });
  };

  const chuyenRieng = () => {
    if (!window.confirm("Chuyển thành topic riêng? Từ lúc này chỉ người mở, những người đang được tag và chủ shop xem được topic — không đổi lại được.")) return;
    start(async () => {
      const r = await restrictProductionTopic({ topicId });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.changed ? "Topic đã là topic riêng" : "Topic đã là topic riêng từ trước");
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        {restricted ? "Topic riêng — chỉ những người dưới đây và chủ shop xem được." : "Topic mở trước khi có tag — ai có quyền xem sản xuất cũng xem được."}
      </p>
      {!restricted && canUntag ? (
        <Button size="sm" variant="outline" onClick={chuyenRieng} disabled={pending}>
          Chuyển thành topic riêng
        </Button>
      ) : null}
      <ul className="space-y-1">
        <li className="flex items-center justify-between gap-2">
          <span>
            <span className="font-medium">{creatorName || "—"}</span> <span className="text-xs text-muted-foreground">· người mở</span>
          </span>
        </li>
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              <span className="font-medium">{m.name || m.email}</span>
              {m.active ? null : <span className="text-xs text-muted-foreground"> · tài khoản đã khoá</span>}
            </span>
            {canUntag ? (
              <button type="button" aria-label={`Bỏ tag ${m.name || m.email}`} disabled={pending} onClick={() => boTag(m)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-rose-600">
                <X className="size-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canTag ? (
        <div className="space-y-2 border-t pt-3">
          <PeoplePicker people={conLai} value={chon} onChange={setChon} disabled={pending} />
          {chon.length ? (
            <div className="flex justify-end">
              <Button size="sm" onClick={tag} disabled={pending}>
                Tag {chon.length} người
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
