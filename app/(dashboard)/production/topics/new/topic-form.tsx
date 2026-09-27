"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TopicFilePicker, uploadTopicFiles, UploadProgressBar, type UploadProgress } from "@/app/(dashboard)/production/_components/topic-files";
import { createProductionTopic } from "@/lib/actions/production-topics";
import { PROVISIONAL_CODE_PREFIX, PROVISIONAL_DEFAULT_STATE, PROVISIONAL_NAME_MIN } from "@/lib/constants/provisional-model";

/** Giá trị ô chọn mẫu cho "mẫu mới chưa có mã" — không trùng được một id (uuid). */
const NEW_MODEL = "__new__";

const soHoacNull = (s: string) => (s.trim() ? Math.round(Number(s.replace(/[^\d]/g, ""))) : null);

/**
 * Mở topic hỏi giá xưởng. Chủ shop 27/09/2026: biểu mẫu chỉ giữ ba ô — chất liệu, giá bán, giá sản xuất
 * mong muốn (+ ảnh/video). Tiêu đề tự đặt theo mẫu; màu/size/phụ liệu/xưởng… bàn tiếp trong luồng trao đổi.
 * Ô nào bỏ trống là CHƯA ĐẶT (in "—"), không phải 0. Số đơn / chi quảng cáo lúc mở topic do MÁY CHỦ chụp
 * lại — form không gửi con số nào như vậy.
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

export function TopicForm({
  models,
  fixedModelId,
  fixedModelLabel = null,
  fixedNotice = null,
  canRegisterModel = false,
}: {
  models: TopicModelOption[];
  fixedModelId: string | null;
  /** Mã · tên của mẫu cố định (lối vào từ trang mẫu) — để đặt tiêu đề topic. */
  fixedModelLabel?: string | null;
  fixedNotice?: string | null;
  /** Người có `models:write` mới đăng ký được mẫu mới (mã tạm) ngay từ đây. */
  canRegisterModel?: boolean;
}) {
  const [modelId, setModelId] = useState(fixedModelId ?? "");
  const [newName, setNewName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [material, setMaterial] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const isNew = !fixedModelId && modelId === NEW_MODEL;
  const picked = fixedModelId ? null : models.find((m) => m.id === modelId);
  const notice = fixedModelId ? fixedNotice : isNew ? null : (picked?.notice ?? null);
  const tenMoi = newName.trim();
  // Nút tắt thì PHẢI nói vì sao — trước đây "T1" (2 ký tự) làm nút tắt im lặng và người dùng tưởng hỏng.
  const chuaDu = isNew
    ? tenMoi.length < PROVISIONAL_NAME_MIN
      ? `Tên gọi tạm cần ít nhất ${PROVISIONAL_NAME_MIN} ký tự${tenMoi ? ` (đang ${tenMoi.length})` : ""}`
      : null
    : modelId
      ? null
      : "Chọn mẫu trước";
  const nhanMau = fixedModelId ? fixedModelLabel : isNew ? tenMoi : picked ? `${picked.code}${picked.name ? ` · ${picked.name}` : ""}` : "";
  const title = `Hỏi giá ${nhanMau || "mẫu"}`.slice(0, 200);

  const luu = () =>
    start(async () => {
      const r = await createProductionTopic({
        modelId: isNew ? "" : modelId,
        newModel: isNew ? { name: newName, state: PROVISIONAL_DEFAULT_STATE } : null,
        title,
        requirements: {
          material,
          salePrice: soHoacNull(salePrice),
          targetPrice: soHoacNull(targetPrice),
        },
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã mở topic${r.modelCode ? ` · mẫu mang mã tạm ${r.modelCode}` : ""}${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      // Topic đã có rồi mới tải tệp: tệp gắn vào một topic có thật. Tệp nào hỏng thì báo tên, topic vẫn mở —
      // trang topic có khung tải thêm.
      if (files.length) {
        const up = await uploadTopicFiles(r.topicId, files, setProgress);
        if (up.ok) toast.success(`Đã đính kèm ${up.ok}/${files.length} tệp`);
        up.errors.forEach((e) => toast.error(e));
      }
      router.push(`/production/topics/${r.topicId}`);
    });

  return (
    <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3">
      {fixedModelId ? null : (
        <div className="space-y-1 sm:col-span-3">
          <Label>Mẫu</Label>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="">— Chọn mẫu trong sổ —</option>
            {canRegisterModel ? <option value={NEW_MODEL}>＋ Mẫu mới chưa có mã (đang test — thắng mới lên mã)</option> : null}
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
      {!fixedModelId && !canRegisterModel ? (
        <p className="text-xs text-muted-foreground sm:col-span-3">Mẫu mới chưa có mã: cần quyền “Vòng đời mẫu: khai &amp; đồng bộ” để đăng ký ngay tại đây.</p>
      ) : null}
      {isNew ? (
        <div className="space-y-1 sm:col-span-3">
          <Label>Tên gọi tạm của mẫu</Label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Đầm babydoll hoa nhí cổ vuông" />
          <p className="text-xs text-muted-foreground">
            Máy cấp mã tạm <span className="font-mono">{PROVISIONAL_CODE_PREFIX}ngàythángnăm-số</span>; mẫu thắng thì chốt mã chính thức ở trang mẫu, topic đi theo.
          </p>
        </div>
      ) : null}
      {notice ? <p className="rounded-md border border-sky-300/60 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 sm:col-span-3">{notice}</p> : null}
      <div className="space-y-1">
        <Label>Chất liệu</Label>
        <Input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="Thun rayon" />
      </div>
      <div className="space-y-1">
        <Label>Giá bán (đ/sp)</Label>
        <Input inputMode="numeric" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} placeholder="bỏ trống = chưa đặt" />
      </div>
      <div className="space-y-1">
        <Label>Giá SX mong muốn (đ/sp)</Label>
        <Input inputMode="numeric" value={targetPrice} onChange={(e) => setTargetPrice(e.target.value)} placeholder="bỏ trống = chưa đặt" />
      </div>
      <div className="space-y-1 sm:col-span-3">
        <Label>Ảnh / video mẫu (tuỳ chọn)</Label>
        <TopicFilePicker files={files} onChange={setFiles} disabled={pending} />
        <UploadProgressBar p={progress} />
      </div>
      <div className="flex items-center justify-end gap-3 sm:col-span-3">
        {chuaDu ? <span className="text-xs text-amber-700 dark:text-amber-400">{chuaDu}</span> : null}
        <Button onClick={luu} disabled={pending || chuaDu !== null}>
          Mở topic
        </Button>
      </div>
    </div>
  );
}
