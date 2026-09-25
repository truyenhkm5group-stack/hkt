"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProductionTopic } from "@/lib/actions/production-topics";

const list = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const soHoacNull = (s: string) => (s.trim() ? Math.round(Number(s.replace(/[^\d]/g, ""))) : null);

/**
 * Mở topic hỏi giá xưởng. Ô nào bỏ trống là CHƯA ĐẶT (in "—"), không phải 0. Số đơn / chi quảng cáo lúc
 * mở topic do MÁY CHỦ chụp lại — form không gửi con số nào như vậy.
 */
export type TopicModelOption = {
  id: string;
  code: string;
  name: string;
  /** Trạng thái khai + tín hiệu mẫu (nhãn, không số) — để người chọn thấy mẫu nào đang Triển vọng. */
  hint?: string;
  /** Câu nhắc "mở SỚM / vòng đời đi theo" (`topicOpenNotice`, Agent T). */
  notice?: string | null;
};

export function TopicForm({ models, fixedModelId, fixedNotice = null, suppliers }: { models: TopicModelOption[]; fixedModelId: string | null; fixedNotice?: string | null; suppliers: { id: string; name: string }[] }) {
  const [modelId, setModelId] = useState(fixedModelId ?? "");
  const [title, setTitle] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [material, setMaterial] = useState("");
  const [colors, setColors] = useState("");
  const [sizes, setSizes] = useState("");
  const [trims, setTrims] = useState("");
  const [designNotes, setDesignNotes] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [expectedQty, setExpectedQty] = useState("");
  const [deadline, setDeadline] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const notice = fixedModelId ? fixedNotice : (models.find((m) => m.id === modelId)?.notice ?? null);

  const luu = () =>
    start(async () => {
      const r = await createProductionTopic({
        modelId,
        title,
        supplierId: supplierId || null,
        firstMessage: firstMessage.trim() || null,
        requirements: {
          material,
          colors: list(colors),
          sizes: list(sizes).map((s) => s.toUpperCase()),
          trims,
          designNotes,
          targetPrice: soHoacNull(targetPrice),
          expectedQty: soHoacNull(expectedQty),
          deadline: deadline || null,
        },
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã mở topic${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      router.push(`/production/topics/${r.topicId}`);
    });

  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2">
      {fixedModelId ? null : (
        <div className="space-y-1 sm:col-span-2">
          <Label>Mẫu</Label>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="">— Chọn mẫu trong sổ —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
                {m.name ? ` · ${m.name}` : ""}
                {m.hint ? ` — ${m.hint}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {notice ? <p className="rounded-md border border-sky-300/60 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 sm:col-span-2">{notice}</p> : null}
      <div className="space-y-1 sm:col-span-2">
        <Label>Tiêu đề</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hỏi giá may 500 áo Q001 vải đũi" />
      </div>
      <div className="space-y-1">
        <Label>Xưởng hỏi giá</Label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
          <option value="">— Chưa chọn —</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label>Chất liệu</Label>
        <Input value={material} onChange={(e) => setMaterial(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>Màu (ngăn bằng dấu phẩy)</Label>
        <Input value={colors} onChange={(e) => setColors(e.target.value)} placeholder="Đen, Trắng kem" />
      </div>
      <div className="space-y-1">
        <Label>Size (ngăn bằng dấu phẩy)</Label>
        <Input value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="S, M, L, XL" />
      </div>
      <div className="space-y-1">
        <Label>Phụ liệu</Label>
        <Input value={trims} onChange={(e) => setTrims(e.target.value)} placeholder="Cúc, khoá, mác…" />
      </div>
      <div className="space-y-1">
        <Label>Giá mục tiêu (đ/sp)</Label>
        <Input inputMode="numeric" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} placeholder="bỏ trống = chưa đặt" />
      </div>
      <div className="space-y-1">
        <Label>Số lượng dự kiến</Label>
        <Input inputMode="numeric" value={expectedQty} onChange={(e) => setExpectedQty(e.target.value)} placeholder="bỏ trống = chưa đặt" />
      </div>
      <div className="space-y-1">
        <Label>Hạn cần hàng</Label>
        <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label>Ghi chú thiết kế</Label>
        <Textarea rows={3} value={designNotes} onChange={(e) => setDesignNotes(e.target.value)} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label>Lời mở đầu gửi xưởng (tuỳ chọn — thành lượt trao đổi đầu tiên)</Label>
        <Textarea rows={2} value={firstMessage} onChange={(e) => setFirstMessage(e.target.value)} />
      </div>
      <div className="flex justify-end sm:col-span-2">
        <Button onClick={luu} disabled={pending || !modelId || title.trim().length < 3}>
          Mở topic
        </Button>
      </div>
    </div>
  );
}
