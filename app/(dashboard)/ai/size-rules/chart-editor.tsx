"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { saveSizeChartRows } from "@/lib/actions/size-rules";
import { recommendSize, type SizeRow } from "@/lib/constants/size-engine";
import type { EditableRow } from "@/lib/queries/size-rules";

/**
 * SỬA BẢNG SỐ ĐO — TRÌNH BÀY THEO ĐÚNG HÌNH DẠNG BẢNG GỐC.
 *
 * Bản đầu in 24 dòng phẳng, mỗi dòng lặp lại cùng một dải chiều cao. Chủ shop phản hồi 22/09/2026:
 * "khó theo dõi quá" — và đúng: bảng gốc là một MA TRẬN (sáu dải chiều cao × các cột cân nặng),
 * còn màn hình bắt đọc nó như một danh sách không có cấu trúc.
 *
 * Bản này GOM THEO DẢI CHIỀU CAO. Mỗi dải là một khối, chiều cao khai MỘT LẦN ở đầu khối, bên
 * trong chỉ còn cân nặng → size. Hai mươi bốn dòng thành sáu khối ba tới năm dòng, đúng cách bảng
 * được vẽ ra. Sửa ô chiều cao ở đầu khối đổi cho CẢ khối — đó là điểm của việc gom nhóm.
 *
 * Bảng không dùng chiều cao (bảng nữ) không gom: nó vốn đã là bốn dòng phẳng, thêm một tầng vỏ
 * chỉ làm rối thêm.
 *
 * Ô TRA THỬ chạy CHÍNH `recommendSize()` ngay trên trình duyệt, trên các dòng ĐANG SỬA chứ không
 * phải bản đã lưu. Nó là hàm thuần không chạm CSDL nên client gọi được — nhờ vậy người sửa thấy
 * ngay hậu quả của một con số vừa gõ, trước khi nó tới khách.
 */

type Nhom = { key: string; heightMin: number | null; heightMax: number | null; rows: EditableRow[] };

function toNum(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Gom theo dải chiều cao, GIỮ NGUYÊN thứ tự xuất hiện — bảng gốc đã xếp từ thấp lên cao. */
function gom(rows: EditableRow[]): Nhom[] {
  const out: Nhom[] = [];
  for (const r of rows) {
    const key = `${r.heightMin ?? ""}-${r.heightMax ?? ""}`;
    const cuoi = out[out.length - 1];
    if (cuoi && cuoi.key === key) cuoi.rows.push(r);
    else out.push({ key, heightMin: r.heightMin, heightMax: r.heightMax, rows: [r] });
  }
  return out;
}

function toSizeRows(rows: EditableRow[]): SizeRow[] {
  return rows.map((r) => {
    const o: SizeRow = { size: r.size };
    if (r.heightMin !== null && r.heightMax !== null) o.heightCm = [r.heightMin, r.heightMax];
    if (r.weightMin !== null && r.weightMax !== null) o.weightKg = [r.weightMin, r.weightMax];
    return o;
  });
}

const O = "w-16 rounded border border-border bg-background px-1.5 py-1 tabular-nums";

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
  const [thuCao, setThuCao] = useState("");
  const [thuNang, setThuNang] = useState("");

  const nhom = useMemo(() => gom(rows), [rows]);

  /** Tra thử trên các dòng ĐANG SỬA — thấy hậu quả trước khi lưu. */
  const thu = useMemo(() => {
    const cao = toNum(thuCao);
    const nang = toNum(thuNang);
    if (nang === null && cao === null) return null;
    const rule = { version: chartVersion, scope: "PRODUCT" as const, rows: toSizeRows(rows) };
    return recommendSize(rule, { heightCm: cao, weightKg: nang });
  }, [thuCao, thuNang, rows, chartVersion]);

  const sua = (row: EditableRow, patch: Partial<EditableRow>) => {
    setRows((cu) => cu.map((r) => (r === row ? { ...r, ...patch } : r)));
    setDirty(true);
    setWarnings([]); // cảnh báo cũ nói về bảng cũ
  };

  /** Đổi chiều cao của CẢ khối — đó là điểm của việc gom nhóm. */
  const suaCao = (n: Nhom, patch: { heightMin?: number | null; heightMax?: number | null }) => {
    setRows((cu) => cu.map((r) => (n.rows.includes(r) ? { ...r, ...patch } : r)));
    setDirty(true);
    setWarnings([]);
  };

  const xoa = (row: EditableRow) => {
    setRows((cu) => cu.filter((r) => r !== row));
    setDirty(true);
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

  const dongCanNang = (r: EditableRow, i: number) => (
    <div key={i} className="flex items-center gap-1.5 py-0.5 text-sm">
      <span className="text-muted-foreground">nặng</span>
      <input className={O} type="number" value={r.weightMin ?? ""} onChange={(e) => sua(r, { weightMin: toNum(e.target.value) })} aria-label="Cân nặng từ" />
      <span className="text-muted-foreground">–</span>
      <input className={O} type="number" value={r.weightMax ?? ""} onChange={(e) => sua(r, { weightMax: toNum(e.target.value) })} aria-label="Cân nặng đến" />
      <span className="text-muted-foreground">kg →</span>
      <input
        className="w-20 rounded border border-border bg-background px-1.5 py-1 font-medium"
        value={r.size}
        onChange={(e) => sua(r, { size: e.target.value })}
        aria-label="Size"
      />
      <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Xoá dòng" onClick={() => xoa(r)}>
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      {usesHeight ? (
        <div className="space-y-2">
          {nhom.map((n) => (
            <div key={n.key} className="rounded-md border border-border p-2">
              <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <span className="text-muted-foreground">Cao</span>
                <input className={O} type="number" value={n.heightMin ?? ""} onChange={(e) => suaCao(n, { heightMin: toNum(e.target.value) })} aria-label="Chiều cao từ" />
                <span className="text-muted-foreground">–</span>
                <input className={O} type="number" value={n.heightMax ?? ""} onChange={(e) => suaCao(n, { heightMax: toNum(e.target.value) })} aria-label="Chiều cao đến" />
                <span className="text-muted-foreground">cm</span>
                <span className="ml-auto text-xs font-normal text-muted-foreground">{n.rows.length} dải cân nặng</span>
              </div>
              <div className="pl-2">{n.rows.map((r, i) => dongCanNang(r, i))}</div>
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                onClick={() => {
                  const cuoi = n.rows[n.rows.length - 1];
                  const moi: EditableRow = {
                    size: "",
                    heightMin: n.heightMin,
                    heightMax: n.heightMax,
                    weightMin: cuoi?.weightMax === null || cuoi?.weightMax === undefined ? null : cuoi.weightMax + 1,
                    weightMax: null,
                  };
                  setRows((cu) => {
                    const i = cu.indexOf(cuoi);
                    return i < 0 ? [...cu, moi] : [...cu.slice(0, i + 1), moi, ...cu.slice(i + 1)];
                  });
                  setDirty(true);
                  setWarnings([]);
                }}
              >
                <Plus className="size-3" /> thêm dải cân nặng
              </button>
            </div>
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={() => {
              setRows((cu) => [...cu, { size: "", heightMin: null, heightMax: null, weightMin: null, weightMax: null }]);
              setDirty(true);
            }}
          >
            <Plus className="size-3.5" /> Thêm dải chiều cao
          </button>
        </div>
      ) : (
        <div>
          {rows.map((r, i) => dongCanNang(r, i))}
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={() => {
              setRows((cu) => [...cu, { size: "", heightMin: null, heightMax: null, weightMin: null, weightMax: null }]);
              setDirty(true);
            }}
          >
            <Plus className="size-3.5" /> Thêm dòng
          </button>
        </div>
      )}

      {/* ───── TRA THỬ — thấy hậu quả trước khi lưu ───── */}
      <div className="rounded-md bg-muted/40 p-2">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium">Tra thử:</span>
          {usesHeight && (
            <>
              <input className={O} type="number" placeholder="cao" value={thuCao} onChange={(e) => setThuCao(e.target.value)} aria-label="Tra thử chiều cao" />
              <span className="text-muted-foreground">cm</span>
            </>
          )}
          <input className={O} type="number" placeholder="nặng" value={thuNang} onChange={(e) => setThuNang(e.target.value)} aria-label="Tra thử cân nặng" />
          <span className="text-muted-foreground">kg →</span>
          {thu ? (
            thu.code === "OK" ? (
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                size {thu.size}
                {thu.roundedUpFrom ? (
                  <span className="font-normal text-muted-foreground"> (nằm giữa {thu.roundedUpFrom} và {thu.size} — lấy size lớn hơn)</span>
                ) : null}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">{thu.reason}</span>
            )
          ) : (
            <span className="text-muted-foreground">nhập số đo để xem máy trả lời gì</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
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
