"use client";

/**
 * Bảng bản ghi của MỘT đối tượng tuỳ biến (Phase 6 · mục 5) — client wrapper bọc `DataTable` (AGENTS.md mục 2: trang
 * máy chủ chỉ truyền DỮ LIỆU; cột và hàm dựng ở đây). Cột lấy từ danh sách ĐÃ XUẤT BẢN (Phase 2): thứ tự, ẩn/hiện.
 * `id` của cột = ref field (`system:title`, `custom:gia_tri`) = khoá sắp xếp máy chủ nhận — sắp / lọc / phân trang chạy ở
 * máy chủ. Chưa có giá trị ⇒ "—" (luật 42); đích quan hệ người xem không xem được ⇒ "—".
 */
import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { formatCustomValue, isEmptyValue, parseFieldRef } from "@/components/metadata/runtime-core";
import { formatDateTime, MISSING_TEXT } from "@/lib/format";
import type { CustomFieldDef, ListViewSchema } from "@/lib/metadata/types";
import type { CustomRecordRow } from "@/lib/objects/types";
import { cn } from "@/lib/utils";

const RIGHT = new Set(["number", "currency"]);

export function RecordsTable({
  objectKey,
  titleLabel,
  schema,
  customFields,
  rows,
  total,
  pageCount,
  sortable,
  defaultSort,
  defaultDir,
  userNames,
  relationLabels,
}: {
  objectKey: string;
  titleLabel: string;
  schema: ListViewSchema;
  customFields: CustomFieldDef[];
  rows: CustomRecordRow[];
  total: number;
  pageCount: number;
  sortable: string[];
  defaultSort: string;
  defaultDir: "asc" | "desc";
  userNames: Record<string, string>;
  relationLabels: Record<string, Record<string, string>>;
}) {
  const columns = React.useMemo(() => {
    const byKey = new Map(customFields.map((f) => [f.key, f]));
    const out: ColumnDef<CustomRecordRow, unknown>[] = [];
    for (const c of schema.columns) {
      if (!c.visible) continue;
      const ref = parseFieldRef(c.ref);
      if (!ref) continue;
      if (ref.kind === "system") {
        const sys = SYSTEM_COLUMNS(titleLabel)[ref.key];
        if (sys) out.push({ ...sys, id: c.ref, enableSorting: false });
        continue;
      }
      const def = byKey.get(ref.key);
      if (!def) continue;
      const right = RIGHT.has(def.type);
      out.push({
        id: c.ref,
        header: def.label,
        enableSorting: false,
        meta: right ? { align: "right" } : undefined,
        cell: ({ row }) => {
          const v = row.original.values[def.key];
          const text = formatCustomValue(def, v, { userNames, relationLabels, fieldKey: def.key });
          return <span className={cn("block max-w-[240px] truncate text-sm", right && "numeric text-right", isEmptyValue(v) && "text-muted-foreground")} title={text}>{text}</span>;
        },
      });
    }
    // Danh sách xuất bản ẩn hết cột ⇒ vẫn có cột tên: một bảng không cột nào là cấu hình hỏng, không phải ý muốn.
    if (out.length === 0) out.push({ ...SYSTEM_COLUMNS(titleLabel).title, id: "system:title", enableSorting: false });
    return out;
  }, [schema, customFields, titleLabel, userNames, relationLabels]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      sortable={sortable}
      defaultSort={defaultSort}
      defaultDir={defaultDir}
      rowHref={(row) => `/o/${objectKey}/${encodeURIComponent(row.id)}`}
      getRowId={(row) => row.id}
      emptyTitle="Chưa có bản ghi nào"
      emptyDescription="Bấm «Tạo mới» để thêm bản ghi đầu tiên, hoặc đổi bộ lọc / từ khoá."
    />
  );
}

function SYSTEM_COLUMNS(titleLabel: string): Record<string, ColumnDef<CustomRecordRow, unknown>> {
  return {
    title: { header: titleLabel || "Tên", cell: ({ row }) => <span className="font-semibold">{row.original.title}</span> },
    owner: { header: "Người phụ trách", cell: ({ row }) => <span className={cn("text-sm", !row.original.ownerName && "text-muted-foreground")}>{row.original.ownerName ?? MISSING_TEXT}</span> },
    created_at: { header: "Tạo lúc", cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.original.createdAt)}</span> },
    updated_at: { header: "Sửa lúc", cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(row.original.updatedAt)}</span> },
  };
}
