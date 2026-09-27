"use client";

import { useState } from "react";
import { Shirt } from "lucide-react";
import { toast } from "sonner";
import { DataWarnings } from "@/components/data-warnings";
import { InfoHint } from "@/components/info-hint";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { declareModelsFromSuggestion } from "@/lib/actions/models";
import {
  BULK_DECLARE_DEFAULT_REASON,
  BULK_DECLARE_NO_SUGGESTION_LABEL,
  DECLARE_ROW_OUTCOME_LABEL,
  type DeclarePreviewRow,
  type DeclareRowResult,
} from "@/lib/constants/model-bulk-declare";
import { MODEL_REASON_MIN_LENGTH, MODEL_STATE_LABELS, MODEL_STATES, reasonIsEnough, type ModelState } from "@/lib/constants/model-lifecycle";
import { STALE_UPDATE_DEFAULT_REASON } from "@/lib/constants/model-stale-state";
import { cn } from "@/lib/utils";

/*
  `useNavTransition`: action `declareModelsFromSuggestion` gọi `revalidatePath("/models", "layout")`, nên
  lượt gọi mang luôn giao diện mới (mẫu vừa khai rời bảng, số "Chưa khai" giảm) — KHÔNG `router.refresh()`
  (tests/action-refresh-once.test.ts).
*/

/**
 * KHAI THEO GỢI Ý — bảng xem trước cho mẫu CHƯA KHAI. Máy gợi ý giai đoạn (ƯỚC TÍNH), người tick / đổi /
 * bỏ tick rồi bấm "Khai N mẫu". Mẫu không có gợi ý không tick được. Không có cú bấm thì không có gì được ghi.
 *
 * `mode="stale"` (Agent ST) — CÙNG bảng, CÙNG action, cho mẫu ĐÃ KHAI mà chứng từ đã đi trước lời khai: thêm cột
 * "Đang khai", mỗi dòng gửi `expectedState` = lời khai đang hiện (hàng rào màn hình cũ ở máy chủ), nút "Cập nhật N
 * mẫu", lý do điền sẵn riêng.
 */
export function BulkDeclarePanel({ rows, mode = "declare" }: { rows: DeclarePreviewRow[]; mode?: "declare" | "stale" }) {
  const capNhat = mode === "stale";
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.modelId, r.defaultChecked])));
  const [chosen, setChosen] = useState<Record<string, ModelState>>(() => Object.fromEntries(rows.filter((r) => r.suggested).map((r) => [r.modelId, r.suggested as ModelState])));
  const [reason, setReason] = useState(capNhat ? STALE_UPDATE_DEFAULT_REASON : BULK_DECLARE_DEFAULT_REASON);
  const [ketQua, setKetQua] = useState<DeclareRowResult[] | null>(null);
  const [pending, start] = useNavTransition();

  const chonDuoc = rows.filter((r) => r.selectable);
  // `expectedState` = lời khai người đang thấy: `null` cho mẫu chưa khai, lời khai hiện tại cho bảng cập nhật.
  const items = chonDuoc.filter((r) => checked[r.modelId] ?? false).map((r) => ({ modelId: r.modelId, state: chosen[r.modelId] ?? (r.suggested as ModelState), expectedState: r.current }));
  const dongTu = capNhat ? "Cập nhật" : "Khai";
  const doiGoiY = items.filter((i) => i.state !== rows.find((r) => r.modelId === i.modelId)?.suggested).length;
  const tatCa = chonDuoc.length > 0 && chonDuoc.every((r) => checked[r.modelId]);

  const khai = () =>
    start(async () => {
      const r = await declareModelsFromSuggestion({ items, reason, from: "list", kind: mode });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const conLai = r.results.filter((x) => x.outcome !== "DECLARED");
      setKetQua(conLai.length ? conLai : null);
      const dt = dongTu.toLowerCase();
      if (r.declared) toast.success(`Đã ${dt} ${r.declared} mẫu${conLai.length ? ` · ${conLai.length} dòng không ${dt} được — xem bên dưới` : ""}`);
      else toast.error(`Không ${dt} được mẫu nào — ${conLai.length} dòng bị bỏ qua hoặc lỗi`);
    });

  if (!rows.length && !ketQua)
    return <p className="text-sm text-muted-foreground">{capNhat ? "Không mẫu nào có chứng từ đi trước lời khai trong bộ lọc hiện tại." : "Không còn mẫu nào chưa khai trong bộ lọc hiện tại."}</p>;

  return (
    <div className="space-y-3">
      {ketQua ? (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs dark:border-amber-800 dark:bg-amber-950/30" data-testid="bulk-declare-result">
          <p className="font-semibold">
            Dòng không {dongTu.toLowerCase()} được ({ketQua.length})
          </p>
          <ul className="mt-1 space-y-0.5">
            {ketQua.map((x) => (
              <li key={x.modelId}>
                <span className="font-mono">{x.code ?? x.modelId}</span> — {DECLARE_ROW_OUTCOME_LABEL[x.outcome]}
                {x.current ? ` (hiện: ${MODEL_STATE_LABELS[x.current]})` : ""}
                {x.error ? `: ${x.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-1.5 text-left">
                  <input
                    type="checkbox"
                    aria-label={capNhat ? "Chọn mọi mẫu có đề xuất" : "Chọn mọi mẫu có gợi ý"}
                    checked={tatCa}
                    disabled={!chonDuoc.length || pending}
                    onChange={(e) => setChecked(Object.fromEntries(rows.map((r) => [r.modelId, r.selectable && e.target.checked])))}
                  />
                </th>
                <th className="w-28 px-2 py-1.5 text-left font-medium">Mã</th>
                <th className="px-2 py-1.5 text-left font-medium">Mẫu</th>
                {capNhat ? <th className="w-32 px-2 py-1.5 text-left font-medium">Đang khai</th> : null}
                <th className="w-44 px-2 py-1.5 text-left font-medium">
                  <span className="inline-flex items-center gap-1">
                    {capNhat ? "Máy đề xuất" : "Máy gợi ý"}{" "}
                    <InfoHint>
                      {capNhat
                        ? "Trạng thái mà chứng từ trong ERP đã chứng minh (thiết kế đã lên camp / có phán quyết, topic · giá thành · mẫu thử · lệnh · phiếu nhập). Chỉ đi tới, không bao giờ lùi — chỉ thành lời khai khi bạn bấm."
                        : "Giai đoạn máy ĐOÁN từ chứng cứ (thiết kế, đơn lên, chi QC đã ghép, lệnh SX, sổ kho). Là ước tính — chỉ thành lời khai khi bạn bấm."}
                    </InfoHint>
                  </span>
                </th>
                <th className="w-[280px] px-2 py-1.5 text-left font-medium">Căn cứ</th>
                <th className="w-48 px-2 py-1.5 text-left font-medium">{capNhat ? "Cập nhật thành" : "Khai là"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = r.selectable && (checked[r.modelId] ?? false);
                const val = chosen[r.modelId] ?? r.suggested;
                return (
                  <tr key={r.modelId} className={cn("border-t", !r.selectable && "text-muted-foreground")} data-model-code={r.code}>
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`${dongTu} mẫu ${r.code}`}
                        checked={on}
                        disabled={!r.selectable || pending}
                        onChange={(e) => setChecked((c) => ({ ...c, [r.modelId]: e.target.checked }))}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{r.code}</td>
                    <td className="px-2 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        {r.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image} alt="" className="size-7 shrink-0 rounded border object-cover" />
                        ) : (
                          <span className="flex size-7 shrink-0 items-center justify-center rounded border bg-muted">
                            <Shirt className="size-3.5" />
                          </span>
                        )}
                        <span className="truncate" title={r.name}>
                          {r.name || "—"}
                        </span>
                      </span>
                    </td>
                    {capNhat ? <td className="px-2 py-1.5 text-xs">{r.current ? MODEL_STATE_LABELS[r.current] : "—"}</td> : null}
                    <td className="px-2 py-1.5">
                      {r.suggested ? (
                        <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{capNhat ? "Theo chứng từ" : "Ước tính"}</span>
                          <span className="font-medium">{MODEL_STATE_LABELS[r.suggested]}</span>
                        </span>
                      ) : (
                        <span className="text-xs">{BULK_DECLARE_NO_SUGGESTION_LABEL}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      <span className="flex items-center gap-1">
                        <span className="truncate" title={r.reasons.join(" · ")}>
                          {r.reasons[0] ?? "Máy chưa thấy chứng cứ nào"}
                        </span>
                        {r.reasons.length > 1 ? <InfoHint>{r.reasons.join(" · ")}</InfoHint> : null}
                        <DataWarnings items={r.unknowns} label={`${r.unknowns.length}`} />
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      {r.selectable ? (
                        <select
                          aria-label={`${dongTu} mẫu ${r.code} là`}
                          className={cn("h-7 w-full rounded-md border bg-background px-1.5 text-xs", val !== r.suggested && "border-primary font-semibold")}
                          value={val ?? ""}
                          disabled={pending}
                          onChange={(e) => setChosen((c) => ({ ...c, [r.modelId]: e.target.value as ModelState }))}
                        >
                          {MODEL_STATES.map((s) => (
                            <option key={s} value={s}>
                              {MODEL_STATE_LABELS[s]}
                              {s === r.suggested ? (capNhat ? " · đề xuất" : " · gợi ý") : ""}
                              {capNhat && s === r.current ? " · đang khai" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs">— khai tay ở trang mẫu</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.length ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[320px] flex-1 space-y-1">
            <Label htmlFor="bulk-declare-reason" className="text-xs">
              Lý do (bắt buộc, ít nhất {MODEL_REASON_MIN_LENGTH} ký tự) — ghi vào lịch sử của từng mẫu
            </Label>
            <Textarea id="bulk-declare-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">
              {items.length} / {chonDuoc.length} mẫu có {capNhat ? "đề xuất" : "gợi ý"} được chọn{doiGoiY ? ` · ${doiGoiY} chọn khác ${capNhat ? "đề xuất" : "gợi ý"}` : ""}
            </span>
            <Button size="sm" disabled={pending || !items.length || !reasonIsEnough(reason)} onClick={khai}>
              {pending ? `Đang ${dongTu.toLowerCase()}…` : `${dongTu} ${items.length} mẫu`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
