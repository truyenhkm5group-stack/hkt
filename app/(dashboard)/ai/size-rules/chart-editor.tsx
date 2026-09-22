"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { saveSizeChartRows } from "@/lib/actions/size-rules";
import type { EditableRow } from "@/lib/queries/size-rules";

/**
 * SỬA CÁC DÒNG CỦA MỘT BẢNG SỐ ĐO.
 *
 * Khác hẳn ô chọn bảng ở cột bên: ô chọn gửi ngay khi đổi vì nó là MỘT quyết định trọn vẹn. Ở đây
 * một lần sửa gồm nhiều ô, và nửa chừng thì bảng đang ở trạng thái không có nghĩa — nên phải có
 * nút Lưu, và phải có nút Huỷ để quay về đúng thứ máy chủ đang giữ.
 *
 * CẢNH BÁO HIỆN RA RỒI MỚI GHI. Lượt lưu đầu, nếu bảng có chỗ chồng khoảng, máy chủ trả cảnh báo
 * và KHÔNG ghi gì; người sửa đọc xong bấm lại thì mới ghi. Chặn hẳn thì không sửa được bảng cố ý
 * chồng ranh giới (chính bảng đang chạy); ghi thẳng thì cảnh báo thành dòng chữ không ai đọc.
 */
function toNum(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function ChartEditor({
  chartVersion,
  chartLabel,
  initialRows,
  usesHeight,
}: {
  chartVersion: string;
  chartLabel: string;
  initialRows: EditableRow[];
  usesHeight: boolean;
}) {
  const [rows, setRows] = useState<EditableRow[]>(initialRows);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();

  const doi = (i: number, patch: Partial<EditableRow>) => {
    setRows((cu) => cu.map((r, k) => (k === i ? { ...r, ...patch } : r)));
    setDirty(true);
    // Cảnh báo cũ nói về bảng cũ. Giữ lại trong khi người dùng đang sửa là nói sai về thứ đang
    // hiện trên màn hình.
    setWarnings([]);
  };

  const luu = (acceptWarnings: boolean) => {
    startTransition(async () => {
      const res = await saveSizeChartRows({ chartVersion, rows, acceptWarnings });
      if ("ok" in res) {
        setDirty(false);
        setWarnings(res.warnings);
        toast.success(`Đã lưu ${chartLabel} — ${res.rows} dòng`);
        return;
      }
      if (res.warnings?.length) {
        setWarnings(res.warnings);
        toast.warning("Đọc cảnh báo bên dưới rồi bấm Lưu lần nữa");
        return;
      }
      toast.error(res.error || "Không lưu được");
    });
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">Size</th>
              {usesHeight && <th className="py-1 pr-2">Cao từ (cm)</th>}
              {usesHeight && <th className="py-1 pr-2">đến</th>}
              <th className="py-1 pr-2">Nặng từ (kg)</th>
              <th className="py-1 pr-2">đến</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-2">
                  <input
                    className="w-20 rounded border border-border bg-background px-1.5 py-1"
                    value={r.size}
                    onChange={(e) => doi(i, { size: e.target.value })}
                    aria-label={`Tên size dòng ${i + 1}`}
                  />
                </td>
                {usesHeight && (
                  <>
                    <td className="py-0.5 pr-2">
                      <input
                        type="number"
                        className="w-20 rounded border border-border bg-background px-1.5 py-1 tabular-nums"
                        value={r.heightMin ?? ""}
                        onChange={(e) => doi(i, { heightMin: toNum(e.target.value) })}
                        aria-label={`Chiều cao từ, dòng ${i + 1}`}
                      />
                    </td>
                    <td className="py-0.5 pr-2">
                      <input
                        type="number"
                        className="w-20 rounded border border-border bg-background px-1.5 py-1 tabular-nums"
                        value={r.heightMax ?? ""}
                        onChange={(e) => doi(i, { heightMax: toNum(e.target.value) })}
                        aria-label={`Chiều cao đến, dòng ${i + 1}`}
                      />
                    </td>
                  </>
                )}
                <td className="py-0.5 pr-2">
                  <input
                    type="number"
                    className="w-20 rounded border border-border bg-background px-1.5 py-1 tabular-nums"
                    value={r.weightMin ?? ""}
                    onChange={(e) => doi(i, { weightMin: toNum(e.target.value) })}
                    aria-label={`Cân nặng từ, dòng ${i + 1}`}
                  />
                </td>
                <td className="py-0.5 pr-2">
                  <input
                    type="number"
                    className="w-20 rounded border border-border bg-background px-1.5 py-1 tabular-nums"
                    value={r.weightMax ?? ""}
                    onChange={(e) => doi(i, { weightMax: toNum(e.target.value) })}
                    aria-label={`Cân nặng đến, dòng ${i + 1}`}
                  />
                </td>
                <td className="py-0.5">
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    aria-label={`Xoá dòng ${i + 1}`}
                    onClick={() => {
                      setRows((cu) => cu.filter((_, k) => k !== i));
                      setDirty(true);
                      setWarnings([]);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => {
            setRows((cu) => [...cu, { size: "", heightMin: null, heightMax: null, weightMin: null, weightMax: null }]);
            setDirty(true);
          }}
        >
          <Plus className="size-3.5" /> Thêm dòng
        </button>
        <button
          type="button"
          disabled={!dirty || pending}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          onClick={() => luu(warnings.length > 0)}
        >
          {pending ? "Đang lưu…" : warnings.length > 0 ? "Lưu dù có cảnh báo" : "Lưu"}
        </button>
        {dirty && (
          <button
            type="button"
            disabled={pending}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={() => {
              setRows(initialRows);
              setWarnings([]);
              setDirty(false);
            }}
          >
            Huỷ
          </button>
        )}
        {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">CHƯA LƯU</span>}
      </div>

      {warnings.length > 0 && (
        <ul className="rounded border border-amber-500/50 bg-amber-500/5 p-2 text-xs">
          {warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
