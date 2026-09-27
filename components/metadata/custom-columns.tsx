"use client";

/**
 * CỘT CUSTOM + ÁP DANH SÁCH ĐÃ XUẤT BẢN cho bảng TanStack (M9).
 *
 * Chạy trong client wrapper `<X>Table` — trang máy chủ chỉ truyền DỮ LIỆU (schema, định nghĩa field,
 * giá trị theo id bản ghi); cột và hàm dựng ở đây, đúng AGENTS.md mục 2. Logic sắp đặt nằm ở
 * `runtime-core.ts` (thuần, có bài kiểm).
 */
import type { ColumnDef } from "@tanstack/react-table";
import { applyListView, customColumnId, formatCustomValue, isEmptyValue, visibleCustomKeys, type FormatContext } from "@/components/metadata/runtime-core";
import { cn } from "@/lib/utils";
import type { CustomFieldDef, CustomValues, ListViewSchema } from "@/lib/metadata/types";

/** Dữ liệu metadata một trang danh sách truyền xuống client wrapper — toàn bộ tuần tự hoá được. */
export type ListMetadataProps = {
  listView: ListViewSchema | null;
  customFields: CustomFieldDef[];
  /** Giá trị custom của đúng các dòng đang hiện, theo id bản ghi (một lượt `getCustomValues(ids)`). */
  customValues: Record<string, CustomValues>;
  userNames?: Record<string, string>;
};

const RIGHT_TYPES = new Set(["number", "currency"]);

/**
 * Cột cho field custom: id `custom:<khoá>`, in theo kiểu, chưa có giá trị ⇒ "—". Sắp xếp CHỈ khi
 * truy vấn hỗ trợ (`sortableKeys`) — hôm nay không truy vấn nào sắp theo `custom_values`, nên mặc
 * định tắt: một mũi tên sắp xếp không làm gì là nói dối người bấm.
 */
export function buildCustomColumns<T>(defs: readonly CustomFieldDef[], getValues: (row: T) => CustomValues | undefined, opts: FormatContext & { sortableKeys?: readonly string[] } = {}): Map<string, ColumnDef<T, unknown>> {
  const out = new Map<string, ColumnDef<T, unknown>>();
  for (const def of defs) {
    if (def.status !== "ACTIVE") continue;
    const right = RIGHT_TYPES.has(def.type);
    out.set(def.key, {
      id: customColumnId(def.key),
      header: def.label,
      enableSorting: Boolean(opts.sortableKeys?.includes(def.key)),
      meta: right ? { align: "right" } : undefined,
      cell: ({ row }) => {
        const v = getValues(row.original)?.[def.key];
        const text = formatCustomValue(def, v, opts);
        return <span className={cn("block max-w-[220px] truncate text-sm", right && "numeric text-right", isEmptyValue(v) && "text-muted-foreground")} title={text}>{text}</span>;
      },
    });
  }
  return out;
}

/**
 * Cột cuối cùng của bảng: cột mã nguồn đã áp danh sách + cột custom. Không schema ⇒ nguyên cột mã
 * nguồn (tổ chức chưa cấu hình thấy y hệt hôm nay).
 */
export function columnsWithListView<T>(base: ColumnDef<T, unknown>[], meta: ListMetadataProps | undefined, refColumns: Readonly<Record<string, readonly string[]>>, getId: (row: T) => string): ColumnDef<T, unknown>[] {
  if (!meta?.listView) return base;
  const wanted = new Set(visibleCustomKeys(meta.listView));
  const defs = meta.customFields.filter((d) => wanted.has(d.key));
  const custom = buildCustomColumns<T>(defs, (row) => meta.customValues[getId(row)], { userNames: meta.userNames });
  return applyListView(base, meta.listView, { refColumns, customColumns: custom });
}
