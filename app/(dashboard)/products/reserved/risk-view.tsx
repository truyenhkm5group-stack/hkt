"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import * as React from "react";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { useReputationBook } from "@/app/(dashboard)/products/reserved/reputation";
import { PHONE_RISK_LEVELS, PHONE_RISK_LEVEL_LABEL, compareRisk, phoneRiskLevel, type PhoneRiskLevel } from "@/lib/constants/phone-reputation";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ LỌC & SẮP XẾP ĐƠN CHỜ XUẤT THEO CỘT CHỈ SỐ ═══════════
 *
 * Hai cột rủi ro được điền SAU khi trang đã in (hỏi Pancake theo lô), nên lọc / xếp làm ở trình duyệt:
 * máy chủ vẫn dựng từng dòng, thành phần này chỉ đổi thứ tự và ẩn / hiện. Trạng thái nằm trên URL
 * (`?loc=` · `?xep=`) để gửi link cho người khác thấy đúng danh sách đang xem.
 *
 * Bộ lọc cũng quyết định nút "Mở … đơn trên POS" (`pos-push.tsx`): đơn đang BỊ ẨN không bao giờ lọt
 * vào link, kể cả khi trước đó đã được tích — lọc "Ít rủi ro" rồi chọn tất cả là đúng những gì hiện ra.
 */

const FILTERS = ["tat-ca", "it-rui-ro", "chua-lich-su", "rui-ro-cao", "chua-biet"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LEVEL: Record<Exclude<Filter, "tat-ca">, PhoneRiskLevel> = { "it-rui-ro": "LOW", "chua-lich-su": "NO_HISTORY", "rui-ro-cao": "HIGH", "chua-biet": "UNKNOWN" };
const LEVEL_FILTER: Record<PhoneRiskLevel, Filter> = { LOW: "it-rui-ro", NO_HISTORY: "chua-lich-su", HIGH: "rui-ro-cao", UNKNOWN: "chua-biet" };

const SORTS = ["cho-lau", "moi-nhat", "hoan-tang", "hoan-giam", "bao-tang", "bao-giam", "sl-giam", "sl-tang", "gia-tri-giam", "gia-tri-tang"] as const;
type Sort = (typeof SORTS)[number];

/** Cột bấm được để xếp: bấm lần đầu theo chiều quen thuộc, bấm lại đảo chiều. */
const COLUMN_SORTS = {
  tao: ["cho-lau", "moi-nhat"],
  hoan: ["hoan-tang", "hoan-giam"],
  bao: ["bao-tang", "bao-giam"],
  sl: ["sl-giam", "sl-tang"],
  giaTri: ["gia-tri-giam", "gia-tri-tang"],
} as const satisfies Record<string, readonly [Sort, Sort]>;
export type SortColumn = keyof typeof COLUMN_SORTS;

const SORT_LABEL: Record<Sort, string> = {
  "cho-lau": "Chờ lâu nhất trước",
  "moi-nhat": "Mới lên trước",
  "hoan-tang": "Rủi ro thấp → cao",
  "hoan-giam": "Rủi ro cao → thấp",
  "bao-tang": "Cảnh báo SĐT ít → nhiều",
  "bao-giam": "Cảnh báo SĐT nhiều → ít",
  "sl-giam": "SL nhiều → ít",
  "sl-tang": "SL ít → nhiều",
  "gia-tri-giam": "Giá trị đơn cao → thấp",
  "gia-tri-tang": "Giá trị đơn thấp → cao",
};

function useView() {
  const [v, set] = useQueryStates(
    {
      loc: parseAsStringLiteral(FILTERS).withDefault("tat-ca"),
      xep: parseAsStringLiteral(SORTS).withDefault("cho-lau"),
    },
    { history: "replace", clearOnDefault: true, scroll: false },
  );
  return { filter: v.loc, sort: v.xep, set };
}

/** Đơn nào đang HIỆN theo bộ lọc — dùng chung cho bảng và nút mở POS. */
export function useRiskVisible(): (orderId: string) => boolean {
  const { filter } = useView();
  const book = useReputationBook();
  return React.useCallback(
    (orderId: string) => {
      if (filter === "tat-ca") return true;
      // Đang hỏi Pancake ⇒ chưa biết; không cho lọt vào "ít rủi ro" chỉ vì số chưa về kịp.
      const rep = book.pending.has(orderId) ? null : book.data[orderId];
      return phoneRiskLevel(rep, book.thresholds) === FILTER_LEVEL[filter];
    },
    [filter, book],
  );
}

export function RiskToolbar({ orderIds }: { orderIds: string[] }) {
  const { filter, sort, set } = useView();
  const book = useReputationBook();
  const counts = React.useMemo(() => {
    const c: Record<PhoneRiskLevel, number> = { LOW: 0, NO_HISTORY: 0, HIGH: 0, UNKNOWN: 0 };
    for (const id of new Set(orderIds)) c[phoneRiskLevel(book.pending.has(id) ? null : book.data[id], book.thresholds)] += 1;
    return c;
  }, [orderIds, book]);
  const asking = orderIds.filter((id) => book.pending.has(id)).length;
  const chip = (active: boolean) => cn("rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap", active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2">
      <span className="text-xs font-semibold text-muted-foreground">Lọc theo rủi ro SĐT</span>
      <div className="inline-flex flex-wrap rounded-lg border p-0.5" role="group" aria-label="Lọc theo rủi ro">
        <button type="button" className={chip(filter === "tat-ca")} onClick={() => void set({ loc: "tat-ca" })}>
          Tất cả · {formatNumber(new Set(orderIds).size)}
        </button>
        {PHONE_RISK_LEVELS.map((lv) => (
          <button key={lv} type="button" className={chip(filter === LEVEL_FILTER[lv])} onClick={() => void set({ loc: LEVEL_FILTER[lv] })}>
            {PHONE_RISK_LEVEL_LABEL[lv]} · {formatNumber(counts[lv])}
          </button>
        ))}
      </div>
      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        Sắp xếp
        <select value={sort} onChange={(e) => void set({ xep: e.target.value as Sort })} className="h-8 rounded-md border bg-transparent px-2 text-xs text-foreground" aria-label="Sắp xếp đơn">
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {asking ? <span className="w-full text-[11px] text-muted-foreground">Đang hỏi Pancake {formatNumber(asking)} đơn — các đơn này tạm ở nhóm &ldquo;Chưa biết&rdquo; và cuối danh sách khi xếp theo rủi ro.</span> : null}
      <span className="w-full text-[11px] text-muted-foreground">
        &ldquo;Ít rủi ro&rdquo; = SĐT có từ {formatNumber(book.thresholds?.phoneRiskMinOrders ?? 1)} đơn kết thúc trên Pancake và không vượt ngưỡng nào. Khách chưa đủ lịch sử và đơn chưa hỏi được Pancake KHÔNG tính là ít rủi ro.
      </span>
    </div>
  );
}

/** Tiêu đề cột bấm được để xếp. */
export function SortHead({ column, children, className, title }: { column: SortColumn; children: React.ReactNode; className?: string; title?: string }) {
  const { sort, set } = useView();
  const [first, second] = COLUMN_SORTS[column];
  const active = sort === first || sort === second;
  const Icon = !active ? ArrowUpDown : (sort === "cho-lau" || sort.endsWith("-tang")) ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} title={title} aria-sort={active ? (Icon === ArrowUp ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => void set({ xep: sort === first ? second : first })} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
        {children}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
      </button>
    </TableHead>
  );
}

/** `value` = giá trị đơn khai báo; `null` = chưa biết ⇒ luôn đứng CUỐI khi xếp theo giá trị, không coi là 0 ₫. */
export type SortableRow = { key: string; orderId: string; insertedAt: number; qty: number; value: number | null; node: React.ReactNode };

function byValue(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return dir * (a - b);
}

/** Thân bảng: lọc + xếp các dòng máy chủ đã dựng. Hoà thì đơn chờ lâu nhất trước — ổn định. */
export function SortedRows({ rows, colSpan }: { rows: SortableRow[]; colSpan: number }) {
  const { sort } = useView();
  const visible = useRiskVisible();
  const book = useReputationBook();
  const shown = React.useMemo(() => {
    const rep = (id: string) => (book.pending.has(id) ? null : book.data[id]);
    // Cùng ngưỡng mẫu nhỏ với cảnh báo: 1/1 hoàn không được đứng đầu "rủi ro cao nhất".
    const min = book.thresholds?.phoneRiskMinOrders ?? 1;
    const cmp = (a: SortableRow, b: SortableRow): number => {
      switch (sort) {
        case "moi-nhat":
          return b.insertedAt - a.insertedAt;
        case "hoan-tang":
          return compareRisk(rep(a.orderId), rep(b.orderId), 1, "RATE", min);
        case "hoan-giam":
          return compareRisk(rep(a.orderId), rep(b.orderId), -1, "RATE", min);
        case "bao-tang":
          return compareRisk(rep(a.orderId), rep(b.orderId), 1, "WARNINGS", min);
        case "bao-giam":
          return compareRisk(rep(a.orderId), rep(b.orderId), -1, "WARNINGS", min);
        case "sl-giam":
          return b.qty - a.qty;
        case "sl-tang":
          return a.qty - b.qty;
        case "gia-tri-giam":
          return byValue(a.value, b.value, -1);
        case "gia-tri-tang":
          return byValue(a.value, b.value, 1);
        default:
          return 0;
      }
    };
    return rows.filter((r) => visible(r.orderId)).sort((a, b) => cmp(a, b) || a.insertedAt - b.insertedAt || (a.key < b.key ? -1 : 1));
  }, [rows, sort, visible, book]);
  const hidden = rows.length - shown.length;
  return (
    <>
      {shown.map((r) => (
        <React.Fragment key={r.key}>{r.node}</React.Fragment>
      ))}
      {hidden ? (
        <TableRow>
          <TableCell colSpan={colSpan} className="py-2 text-center text-xs text-muted-foreground">
            {shown.length ? `Đang ẩn ${formatNumber(hidden)} dòng theo bộ lọc rủi ro.` : `Không dòng nào khớp bộ lọc — đang ẩn ${formatNumber(hidden)} dòng.`}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
