import { addDays, todayVN, vnEndOfDay, vnStartOfDay } from "@/lib/format";

export type SearchParams = Record<string, string | string[] | undefined>;

export type ListParams = {
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  q: string;
  filters: Record<string, string[]>;
  period: Period;
};

export type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "month" | "last_month" | "90d" | "year" | "all" | "custom";

export type Period = { key: PeriodKey; from: Date | null; to: Date | null; label: string; fromKey: string | null; toKey: string | null };

export function param(params: SearchParams, key: string, fallback = "") {
  const value = params[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export function paramList(params: SearchParams, key: string): string[] {
  const value = params[key];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "today", label: "Hôm nay" },
  { value: "yesterday", label: "Hôm qua" },
  { value: "7d", label: "7 ngày qua" },
  { value: "30d", label: "30 ngày qua" },
  { value: "month", label: "Tháng này" },
  { value: "last_month", label: "Tháng trước" },
  { value: "90d", label: "90 ngày qua" },
  { value: "year", label: "Năm nay" },
  { value: "all", label: "Toàn bộ" },
  { value: "custom", label: "Tuỳ chọn" },
];

export function resolvePeriod(params: SearchParams, defaultKey: PeriodKey = "30d"): Period {
  const key = (param(params, "period", defaultKey) as PeriodKey) || defaultKey;
  const today = todayVN();
  const fromParam = param(params, "from");
  const toParam = param(params, "to");
  const make = (fromKey: string | null, toKey: string | null, label: string, k: PeriodKey = key): Period => ({
    key: k,
    fromKey,
    toKey,
    from: fromKey ? vnStartOfDay(fromKey) : null,
    to: toKey ? vnEndOfDay(toKey) : null,
    label,
  });
  switch (key) {
    case "today":
      return make(today, today, "Hôm nay");
    case "yesterday": {
      const y = addDays(today, -1);
      return make(y, y, "Hôm qua");
    }
    case "7d":
      return make(addDays(today, -6), today, "7 ngày qua");
    case "30d":
      return make(addDays(today, -29), today, "30 ngày qua");
    case "90d":
      return make(addDays(today, -89), today, "90 ngày qua");
    case "month":
      return make(`${today.slice(0, 7)}-01`, today, "Tháng này");
    case "last_month": {
      const [y, m] = today.split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 2, 1));
      const start = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-01`;
      const end = addDays(`${today.slice(0, 7)}-01`, -1);
      return make(start, end, "Tháng trước");
    }
    case "year":
      return make(`${today.slice(0, 4)}-01-01`, today, "Năm nay");
    case "all":
      return make(null, null, "Toàn bộ");
    case "custom": {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : addDays(today, -29);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(toParam) ? toParam : today;
      return make(from, to, `${from.split("-").reverse().join("/")} – ${to.split("-").reverse().join("/")}`);
    }
    default:
      return resolvePeriod({ ...params, period: defaultKey }, defaultKey);
  }
}

/** Kỳ liền trước có cùng độ dài (để so sánh) */
export function previousPeriod(period: Period): { from: Date | null; to: Date | null } {
  if (!period.from || !period.to) return { from: null, to: null };
  const length = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - length - 1), to: new Date(period.from.getTime() - 1) };
}

export function parseListParams(
  params: SearchParams,
  options: { defaultSort?: string; defaultDir?: "asc" | "desc"; filterKeys?: string[]; defaultPageSize?: number; defaultPeriod?: PeriodKey; sortable?: string[] } = {},
): ListParams {
  const page = Math.max(1, Number(param(params, "page", "1")) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(param(params, "pageSize", String(options.defaultPageSize ?? 25))) || 25));
  let sort = param(params, "sort", options.defaultSort ?? "");
  if (options.sortable && sort && !options.sortable.includes(sort)) sort = options.defaultSort ?? "";
  const dir = param(params, "dir", options.defaultDir ?? "desc") === "asc" ? "asc" : "desc";
  const filters: Record<string, string[]> = {};
  for (const key of options.filterKeys ?? []) {
    const list = paramList(params, key);
    if (list.length) filters[key] = list;
  }
  return { page, pageSize, sort, dir, q: param(params, "q"), filters, period: resolvePeriod(params, options.defaultPeriod ?? "all") };
}
