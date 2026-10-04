import { searchSku } from "@/lib/integrations/google-places/client";
import type { SearchProvince } from "@/lib/wholesale/areas";
import { type DiscoveryTier, type KeywordGroup, type LeadHunterConfig, skuCostMicros } from "@/lib/wholesale/config";
import { foldVietnamese } from "@/lib/wholesale/segments";

/**
 * ═══════════ KẾ HOẠCH QUÉT — TỪ KHOÁ × TỈNH × KHU VỰC ⇒ Ô QUÉT — HÀM THUẦN ═══════════
 *
 * Mỗi ô = một truy vấn Text Search. Khoá ô (`cellKey`) là TOÀN CỤC trong tổ chức: hai chiến dịch cùng hỏi «nhà hàng
 * hải sản Quận 1 Hồ Chí Minh» dùng chung một ô, nên ô đã quét trong `cellFreshDays` ngày không bị quét lại (đặc tả mục
 * 13 «không chạy lại vô ích một query nhiều lần»).
 */

export type PlannedCell = {
  cellKey: string;
  keyword: string;
  provinceKey: string;
  provinceLabel: string;
  areaCode: string;
  areaName: string;
  queryText: string;
  searchMode: "TEXT" | "NEARBY";
};

export function enabledKeywords(groups: readonly KeywordGroup[], extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of [...groups.filter((g) => g.enabled).flatMap((g) => g.keywords), ...extra]) {
    const t = k.trim().replace(/\s+/g, " ");
    const f = foldVietnamese(t).trim();
    if (!t || t.length > 80 || seen.has(f)) continue;
    seen.add(f);
    out.push(t);
  }
  return out;
}

export function cellKeyOf(mode: "TEXT" | "NEARBY", keyword: string, provinceKey: string, areaCode: string): string {
  return `${mode}|${foldVietnamese(keyword).trim().replace(/\s+/g, "-")}|${provinceKey.replace(/\s+/g, "-")}|${areaCode}`;
}

export function queryTextOf(keyword: string, areaName: string, provinceQueryName: string): string {
  const area = foldVietnamese(areaName);
  const prov = foldVietnamese(provinceQueryName);
  if (area === prov || area.includes(prov)) return `${keyword} ${areaName}`;
  return `${keyword} ${areaName} ${provinceQueryName}`;
}

/** Dựng toàn bộ ô cho chiến dịch TEXT. Trần `maxCells` để một form gõ nhầm không sinh 100.000 truy vấn. */
export function planTextCells(keywords: readonly string[], provinces: readonly SearchProvince[], maxCells = 20_000): { cells: PlannedCell[]; truncated: boolean } {
  const cells: PlannedCell[] = [];
  const seen = new Set<string>();
  for (const prov of provinces) {
    for (const area of prov.areas) {
      for (const keyword of keywords) {
        const cellKey = cellKeyOf("TEXT", keyword, prov.key, area.code);
        if (seen.has(cellKey)) continue;
        seen.add(cellKey);
        if (cells.length >= maxCells) return { cells, truncated: true };
        cells.push({ cellKey, keyword, provinceKey: prov.key, provinceLabel: prov.label, areaCode: area.code, areaName: area.name, queryText: queryTextOf(keyword, area.name, prov.queryName), searchMode: "TEXT" });
      }
    }
  }
  return { cells, truncated: false };
}

/** Nearby Search không nhận từ khoá: MỘT ô cho mỗi tâm + bán kính + bộ loại hình. */
export function planNearbyCell(input: { lat: number; lng: number; radiusM: number; includedTypes: readonly string[]; label: string }): PlannedCell {
  const typesKey = [...input.includedTypes].sort().join("+").slice(0, 200);
  const areaCode = `${input.lat.toFixed(4)},${input.lng.toFixed(4)},${input.radiusM}`;
  return {
    cellKey: `NEARBY|${typesKey}|${areaCode}`,
    keyword: typesKey || "nearby",
    provinceKey: "nearby",
    provinceLabel: input.label || "Quanh một điểm",
    areaCode,
    areaName: `${input.radiusM} m quanh ${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}`,
    queryText: `Nearby ${typesKey}`,
    searchMode: "NEARBY",
  };
}

export type CostEstimate = {
  cells: number;
  freshCells: number;
  cellsToScan: number;
  searchSku: string;
  /** micro-USD — ít nhất (mỗi ô 1 trang, không lấy chi tiết nào) / điển hình / nhiều nhất. */
  minMicros: number;
  typicalMicros: number;
  maxMicros: number;
  assumptions: string;
};

/**
 * Ước tính chi phí TRƯỚC khi quét. Đây là khoảng, không phải lời hứa: số trang mỗi ô và tỉ lệ địa điểm qua lọc chỉ
 * biết sau khi quét. Giả định «điển hình»: 1,5 trang / ô, 20 kết quả / trang, 35% địa điểm mới qua lọc sơ bộ, và số
 * lượt chi tiết không vượt `maxLeads`.
 */
export function estimateCost(input: { cellCount: number; freshCount: number; mode: "TEXT" | "NEARBY"; tier: DiscoveryTier; maxLeads: number }, cfg: Pick<LeadHunterConfig, "skuPriceUsdPer1000" | "maxPagesPerCell">): CostEstimate {
  const toScan = Math.max(0, input.cellCount - input.freshCount);
  const sku = searchSku(input.mode, input.tier);
  const search = skuCostMicros(sku, cfg);
  const details = input.tier === "ENTERPRISE" ? 0 : skuCostMicros("DETAILS_ENTERPRISE", cfg);
  const maxPages = input.mode === "NEARBY" ? 1 : cfg.maxPagesPerCell;
  const typicalPages = input.mode === "NEARBY" ? 1 : Math.min(maxPages, 1.5);
  const passRatio = input.tier === "IDS_ONLY" ? 1 : 0.35;
  const typicalDetails = Math.min(input.maxLeads, Math.round(toScan * typicalPages * 20 * passRatio));
  const maxDetails = Math.min(input.maxLeads, toScan * maxPages * 20);
  return {
    cells: input.cellCount,
    freshCells: input.freshCount,
    cellsToScan: toScan,
    searchSku: sku,
    minMicros: toScan * search,
    typicalMicros: Math.round(toScan * typicalPages * search + typicalDetails * details),
    maxMicros: toScan * maxPages * search + maxDetails * details,
    assumptions:
      input.tier === "ENTERPRISE"
        ? `Mỗi ô ${input.mode === "NEARBY" ? "1" : `1–${maxPages}`} trang; SĐT / website lấy ngay trong lượt tìm nên không có lượt chi tiết.`
        : `Mỗi ô ${input.mode === "NEARBY" ? "1" : `1–${maxPages}`} trang (điển hình 1,5); ${input.tier === "IDS_ONLY" ? "mọi" : "khoảng 35%"} địa điểm mới cần một lượt chi tiết, tối đa ${input.maxLeads} lượt (trần số lead).`,
  };
}
