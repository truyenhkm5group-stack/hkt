"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { CASE_STATUS_LABEL, CASE_TYPE_LABEL, PRIORITY_LABEL, QUEUE_SORT_LABEL, type CaseStatus, type CaseType } from "@/lib/constants/action-queue";
import { Button } from "@/components/ui/button";

/**
 * BỘ LỌC HÀNG ĐỢI VIỆC.
 *
 * Trạng thái nằm trên URL để chia sẻ được: "đây, những việc trễ hạn trên 1 triệu chưa ai nhận" là
 * một đường dẫn gửi cho nhau được, không phải một chuỗi thao tác phải mô tả bằng lời.
 */
export function QueueFilters({
  types,
  staff,
}: {
  types: { type: CaseType; label: string; count: number }[];
  staff: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    start(() => router.push(`/alerts?${next.toString()}`));
  };

  const value = (key: string) => params.get(key) ?? "";
  const box = "h-8 rounded-md border bg-background px-2 text-xs";
  const active = ["type", "priority", "status", "owner", "minAmount", "breached", "sort"].some((k) => params.get(k));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={box} value={value("type")} onChange={(e) => set("type", e.target.value)} aria-label="Lọc theo loại việc">
        <option value="">Mọi loại việc</option>
        {types.map((t) => (
          <option key={t.type} value={t.type}>
            {CASE_TYPE_LABEL[t.type]} ({t.count})
          </option>
        ))}
      </select>

      <select className={box} value={value("priority")} onChange={(e) => set("priority", e.target.value)} aria-label="Lọc theo mức ưu tiên">
        <option value="">Mọi mức ưu tiên</option>
        {(Object.keys(PRIORITY_LABEL) as (keyof typeof PRIORITY_LABEL)[]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>

      <select className={box} value={value("status")} onChange={(e) => set("status", e.target.value)} aria-label="Lọc theo trạng thái">
        <option value="">Mọi trạng thái</option>
        {(Object.keys(CASE_STATUS_LABEL) as CaseStatus[])
          .filter((s) => s !== "RESOLVED")
          .map((s) => (
            <option key={s} value={s}>
              {CASE_STATUS_LABEL[s]}
            </option>
          ))}
      </select>

      <select className={box} value={value("owner")} onChange={(e) => set("owner", e.target.value)} aria-label="Lọc theo người nhận">
        <option value="">Mọi người nhận</option>
        <option value="none">Chưa ai nhận</option>
        {staff.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>

      <select className={box} value={value("minAmount")} onChange={(e) => set("minAmount", e.target.value)} aria-label="Lọc theo tiền đang treo">
        <option value="">Mọi giá trị</option>
        <option value="500000">Từ 500K</option>
        <option value="1000000">Từ 1 triệu</option>
        <option value="5000000">Từ 5 triệu</option>
      </select>

      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={value("breached") === "1"} onChange={(e) => set("breached", e.target.checked ? "1" : "")} />
        Chỉ việc trễ hạn
      </label>

      <select className={box} value={value("sort")} onChange={(e) => set("sort", e.target.value)} aria-label="Cách xếp">
        {(Object.keys(QUEUE_SORT_LABEL) as (keyof typeof QUEUE_SORT_LABEL)[]).map((k) => (
          <option key={k} value={k}>
            {QUEUE_SORT_LABEL[k]}
          </option>
        ))}
      </select>

      {active ? (
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => start(() => router.push("/alerts"))}>
          Bỏ lọc
        </Button>
      ) : null}
      {pending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </div>
  );
}
