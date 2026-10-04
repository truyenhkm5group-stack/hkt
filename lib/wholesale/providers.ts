import { nearbySearch, placeDetails, textSearch, type PlaceRecord, type PlacesCallMeta, type PlacesClientDeps, type PlacesErrorKind } from "@/lib/integrations/google-places/client";
import { parseCsv } from "@/lib/constants/landing";
import type { DiscoveryTier } from "@/lib/wholesale/config";
import type { LeadSourceKey } from "@/lib/wholesale/constants";
import { enrichFromWebsite, type EnrichResult, type WebsiteDeps } from "@/lib/wholesale/website";
import { foldVietnamese } from "@/lib/wholesale/segments";

/**
 * ═══════════ NGUỒN LEAD — MỘT GIAO DIỆN, NHIỀU NHÀ CUNG CẤP ═══════════
 *
 * Lõi (engine.ts) chỉ biết ba VAI: TÌM (discovery — trả một trang địa điểm), BỔ SUNG (enrichment — đọc thêm liên hệ
 * cho một lead), NHẬP (import — dòng do người đưa vào). Thêm Facebook, TikTok, danh bạ doanh nghiệp… là thêm một
 * nhà cung cấp khai đúng vai, KHÔNG sửa lõi.
 *
 * `googleSourced` quyết định dữ liệu đi vào bảng nào: `true` ⇒ trường nội dung chỉ được nằm ở
 * `wholesale_place_snapshots` (có hạn lưu); `false` ⇒ là dữ liệu của tổ chức, ghi thẳng vào `wholesale_leads`.
 */

export type ProviderRole = "DISCOVERY" | "ENRICHMENT" | "IMPORT";

export type LeadSourceProvider = {
  key: LeadSourceKey;
  label: string;
  role: ProviderRole;
  googleSourced: boolean;
  /** Có tốn tiền theo lượt gọi không — lõi chỉ kiểm trần ngân sách với nhà cung cấp `billable`. */
  billable: boolean;
};

export type DiscoveryRequest =
  | { mode: "TEXT"; textQuery: string; tier: DiscoveryTier; pageToken: string | null }
  | { mode: "NEARBY"; tier: DiscoveryTier; includedTypes: string[]; center: { lat: number; lng: number }; radiusM: number };

export type DiscoveryPage =
  | { ok: true; places: PlaceRecord[]; nextPageToken: string | null; meta: PlacesCallMeta }
  | { ok: false; kind: PlacesErrorKind; message: string; meta: PlacesCallMeta };

export type DetailsResult = { ok: true; place: PlaceRecord; meta: PlacesCallMeta } | { ok: false; kind: PlacesErrorKind; message: string; meta: PlacesCallMeta };

export type DiscoveryProvider = LeadSourceProvider & {
  role: "DISCOVERY";
  search(req: DiscoveryRequest): Promise<DiscoveryPage>;
  details(placeId: string, full: boolean): Promise<DetailsResult>;
};

export type EnrichmentProvider = LeadSourceProvider & {
  role: "ENRICHMENT";
  enrich(website: string, opts: { maxPages: number }): Promise<EnrichResult>;
};

export type ImportRow = {
  name: string;
  phone: string | null;
  address: string | null;
  province: string | null;
  area: string | null;
  website: string | null;
  email: string | null;
  category: string | null;
  note: string | null;
  /** Số dòng trong tệp (bắt đầu từ 2 — dòng 1 là tiêu đề) để báo lỗi đúng chỗ. */
  line: number;
};

export type ImportProvider = LeadSourceProvider & {
  role: "IMPORT";
  parse(text: string): { rows: ImportRow[]; errors: string[] };
};

/** Google Places API (New) — khoá của tổ chức truyền vào lúc dựng, không đọc ở đây. */
export function googlePlacesProvider(opts: { apiKey: string; timeoutMs: number; maxRetries: number }, deps: PlacesClientDeps = {}): DiscoveryProvider {
  return {
    key: "GOOGLE_PLACES",
    label: "Google Places",
    role: "DISCOVERY",
    googleSourced: true,
    billable: true,
    async search(req) {
      if (req.mode === "TEXT") return textSearch(opts, { textQuery: req.textQuery, tier: req.tier, pageToken: req.pageToken }, deps);
      const r = await nearbySearch(opts, { tier: req.tier, includedTypes: req.includedTypes, center: req.center, radiusM: req.radiusM }, deps);
      return r.ok ? { ok: true, places: r.places, nextPageToken: null, meta: r.meta } : r;
    },
    details(placeId, full) {
      return placeDetails(opts, { placeId, full }, deps);
    },
  };
}

/** Website CỦA CHÍNH doanh nghiệp — chỉ trang công khai, có rào SSRF + robots.txt (website.ts). */
export function websiteEnrichmentProvider(deps: WebsiteDeps = {}): EnrichmentProvider {
  return {
    key: "WEBSITE",
    label: "Website doanh nghiệp",
    role: "ENRICHMENT",
    googleSourced: false,
    billable: false,
    enrich(website, opts) {
      return enrichFromWebsite(website, opts, deps);
    },
  };
}

/** Cột chấp nhận (không phân biệt hoa thường, có / không dấu). */
const HEADER_ALIASES: Record<keyof Omit<ImportRow, "line">, string[]> = {
  name: ["ten", "ten doanh nghiep", "ten quan", "name", "business", "business name", "doanh nghiep"],
  phone: ["sdt", "so dien thoai", "dien thoai", "phone", "hotline", "tel"],
  address: ["dia chi", "address"],
  province: ["tinh", "tinh thanh", "thanh pho", "province", "city"],
  area: ["khu vuc", "quan huyen", "quan", "huyen", "district", "area"],
  website: ["website", "web", "url"],
  email: ["email", "mail"],
  category: ["loai hinh", "loai", "nhom", "category", "nganh"],
  note: ["ghi chu", "note", "notes"],
};

export const IMPORT_MAX_ROWS = 2000;

/** Nhập tệp CSV (xuất từ Excel / Google Sheet). Dòng thiếu tên ⇒ lỗi dòng đó, không bịa tên. */
export function manualImportProvider(): ImportProvider {
  return {
    key: "MANUAL_IMPORT",
    label: "Nhập tệp CSV",
    role: "IMPORT",
    googleSourced: false,
    billable: false,
    parse(text) {
      const table = parseCsv(text);
      const errors: string[] = [];
      if (table.length < 2) return { rows: [], errors: ["Tệp cần dòng tiêu đề và ít nhất một dòng dữ liệu."] };
      const header = table[0]!.map((h) => foldVietnamese(h).trim());
      const col: Partial<Record<keyof Omit<ImportRow, "line">, number>> = {};
      for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [keyof Omit<ImportRow, "line">, string[]][]) {
        const idx = header.findIndex((h) => aliases.includes(h));
        if (idx >= 0) col[field] = idx;
      }
      if (col.name === undefined) return { rows: [], errors: ["Không thấy cột tên (Tên / Tên doanh nghiệp / Name)."] };
      const rows: ImportRow[] = [];
      for (let i = 1; i < table.length && rows.length < IMPORT_MAX_ROWS; i++) {
        const r = table[i]!;
        const get = (f: keyof Omit<ImportRow, "line">): string | null => {
          const idx = col[f];
          const v = idx === undefined ? "" : (r[idx] ?? "").trim();
          return v ? v.slice(0, 500) : null;
        };
        const name = get("name");
        if (!name || name.length < 2) {
          errors.push(`Dòng ${i + 1}: thiếu tên doanh nghiệp — bỏ qua.`);
          continue;
        }
        rows.push({ name, phone: get("phone"), address: get("address"), province: get("province"), area: get("area"), website: get("website"), email: get("email"), category: get("category"), note: get("note"), line: i + 1 });
      }
      if (table.length - 1 > IMPORT_MAX_ROWS) errors.push(`Tệp có hơn ${IMPORT_MAX_ROWS} dòng — chỉ nhập ${IMPORT_MAX_ROWS} dòng đầu.`);
      return { rows, errors };
    },
  };
}

/** Sổ nhà cung cấp — màn hình cấu hình in ra để chủ shop biết nguồn nào đang có. */
export const LEAD_PROVIDER_CATALOG: readonly Pick<LeadSourceProvider, "key" | "label" | "role" | "googleSourced" | "billable">[] = [
  { key: "GOOGLE_PLACES", label: "Google Places", role: "DISCOVERY", googleSourced: true, billable: true },
  { key: "WEBSITE", label: "Website doanh nghiệp", role: "ENRICHMENT", googleSourced: false, billable: false },
  { key: "MANUAL_IMPORT", label: "Nhập tệp CSV", role: "IMPORT", googleSourced: false, billable: false },
];
