import { INSPECT_AGE_DAYS } from "@/lib/constants/return-lifecycle";
import { foldAttr, foldCode } from "@/lib/returns/product-text";
import type { ItemsBasis, OrderLinkBasis } from "@/lib/returns/product-context";

/**
 * ═══════════ LỌC VÀ SẮP XẾP HÀNG ĐỢI ĐẾM — THUẦN, VÀ DÙNG CHUNG MỘT BỘ LUẬT ═══════════
 *
 * Người kho đứng trước 300 kiện. Việc của họ không phải "xử lý kiện thứ 147" mà là *"gom hết kiện
 * có mã Q002 lại rồi đếm một lượt"* — vì hàng nằm chung một sọt theo mẫu mã, không theo mã vận đơn.
 * Không có bộ lọc thì họ cuộn 300 dòng cho mỗi sọt, và cuộn lại từ đầu cho sọt tiếp theo.
 *
 * ─── VÌ SAO LÀ HÀM THUẦN, KHÔNG PHẢI SQL ───
 *
 * Danh sách món trong một kiện KHÔNG nằm trong một cột nào. Nó do `returnProductContext` dựng ra
 * sau truy vấn: kiện chiều về (mã gốc + 1P1) mang `order_id` NULL nên phải lần ngược mã gốc, và
 * món thực sự bị trả lấy từ `return_quantity` chứ không phải cả đơn. Viết lại điều kiện đó thành
 * SQL là dựng nguồn sự thật thứ hai cho câu hỏi "trong kiện có gì" — đúng kiểu hỏng mà hai màn
 * hình cùng mở lại nói hai số khác nhau.
 *
 * Nên lọc chạy TRÊN KẾT QUẢ đã ghép, và tệp này là hàm thuần: không đọc CSDL, không đọc `window`,
 * chạy được ở cả máy chủ lẫn trình duyệt, và kiểm thử được không cần dựng cơ sở dữ liệu.
 *
 * ─── HỆ QUẢ: BỘ LỌC CHỈ THẬT KHI CẢ TẬP ĐÃ Ở TRONG TAY ───
 *
 * Lọc trong trình duyệt trên một danh sách bị cắt là cái bẫy đã sập một lần ở bàn nhận hàng: người
 * kho gõ mã, kiện nằm ngoài phần đã tải, màn hình nói "0 kiện", và người đứng ở kho đọc câu đó là
 * "kiện này không có trong hệ thống". Nên trang phải tải TRỌN hàng đợi (tới `PENDING_STATION_CAP`)
 * và, nếu chạm trần, NÓI RA — chứ không im lặng lọc trong một phần.
 */

/**
 * Trần số kiện tải xuống trạm đếm trong một lượt.
 *
 * Không phải một con số làm đẹp: nó là ranh giới giữa "bộ lọc nói đúng" và "bộ lọc nói dối". Dưới
 * trần thì mọi con số trên màn hình là con số thật của cả hàng đợi. Chạm trần thì màn hình BẮT
 * BUỘC phải nói rõ đang lọc trong bao nhiêu trên tổng bao nhiêu.
 */
export const PENDING_STATION_CAP = 800;

/**
 * Số kiện một TRANG. Lọc thấy hết, nhưng vẽ 800 thẻ thì trình duyệt đứng hình — và quan trọng hơn,
 * một danh sách cuộn vô tận không cho người đếm biết mình đang ở đâu trong công việc.
 */
export const PENDING_PAGE_SIZES = [30, 60, 120, 240] as const;
export type PendingPageSize = (typeof PENDING_PAGE_SIZES)[number];
export const PENDING_PAGE_SIZE_DEFAULT: PendingPageSize = 60;

/**
 * ═══════ SỐ KIỆN TỐI ĐA MỘT LƯỢT GỬI LÊN MÁY CHỦ — GIỚI HẠN VẬN CHUYỂN, KHÔNG PHẢI GIỚI HẠN VIỆC ═══════
 *
 * Người kho chọn 800 kiện thì phải xử lý được 800 kiện. Nhưng gửi cả 800 trong MỘT lời gọi là hỏng
 * theo kiểu tệ nhất: mỗi kiện là một giao dịch riêng (phải vậy — một kiện lỗi không được kéo cả lô
 * xuống), 800 giao dịch nối tiếp vượt hạn chờ của server action, và người bấm nhận về một lỗi mạng
 * sau khi 300 kiện ĐÃ ghi xong. Không ai biết 300 kiện nào.
 *
 * Nên trình duyệt tự CHIA MẺ theo hằng số này và gửi lần lượt, cộng dồn kết quả, hiện tiến độ. Từ
 * phía người dùng là một lần bấm cho toàn bộ phần đang chọn — không còn con số giới hạn nào trên
 * màn hình. Máy chủ nhận đúng hằng số này làm trần đầu vào, nên hai bên không thể lệch nhau.
 */
export const BULK_INSPECT_PER_REQUEST = 100;

/** Chia một danh sách thành các mẻ `size` phần tử. Thuần, để bài kiểm khoá được ranh giới mẻ. */
export function chiaMe<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.trunc(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export type StationItem = {
  variantId: string | null;
  sku: string;
  name: string;
  color: string;
  size: string;
  quantity: number;
};

/**
 * Một dòng của trạm đếm.
 *
 * Khai ở đây — không phải trong tệp giao diện — vì cả máy chủ (dựng dữ liệu) lẫn trình duyệt (lọc,
 * sắp xếp, vẽ) đều nói về đúng hình này. Thời gian đi qua ranh giới máy chủ/trình duyệt dưới dạng
 * chuỗi ISO: `Date` qua được nhưng rồi hai nhánh mã lại so sánh hai kiểu khác nhau.
 */
export type StationRow = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  customerName: string;
  customerPhone: string;
  receivedBy: string;
  /** Lúc KHO ghi nhận kiện đã về (ISO). */
  receivedAt: string;
  /**
   * Lúc ĐVVC trả kiện về shop (ISO), `null` = chưa có chứng từ.
   *
   * Hai mốc này KHÁC NHAU và không suy ra nhau. Lượt đối soát sổ giấy ghi nhận cả trăm kiện trong
   * một giây, nên `receivedAt` của chúng gần như bằng nhau và sắp theo nó không nói lên điều gì —
   * mốc ĐVVC mới là dòng thời gian thật của kiện. Gộp hai mốc thành một cột "thời gian" là in ra
   * một dòng thời gian không có thật.
   */
  returnedAt: string | null;
  /** `null` = chưa ghép được đơn ⇒ CHƯA BIẾT số kỳ vọng, không phải 0. */
  expectedQty: number | null;
  itemsBasis: ItemsBasis;
  linkBasis: OrderLinkBasis;
  ageDays: number;
  items: StationItem[];
};

/* ─────────────────────────── KHOÁ GOM NHÓM ─────────────────────────── */

/**
 * Khoá gom một dòng hàng về MỘT mã hàng.
 *
 * Dùng lại đúng hai hàm chuẩn hoá của bộ đối soát sổ giấy (`foldCode` cho mã, `foldAttr` cho chữ)
 * chứ không viết bản thứ ba: `Q 002`, `q-002` và `Q002` phải rơi vào cùng một rổ ở MỌI nơi trong
 * kho mã, nếu không bộ lọc gom một kiểu còn bộ đối soát khớp một kiểu.
 *
 * Thiếu mã thì lùi về TÊN — một dòng hàng không mã vẫn phải lọc được, chỉ là gom thô hơn.
 */
export function itemKey(it: Pick<StationItem, "sku" | "name">): string {
  return foldCode(it.sku) || foldAttr(it.name);
}

/** Nhãn hiện ra cho người đọc: giữ NGUYÊN VĂN của danh mục, không phải chuỗi đã chuẩn hoá. */
function itemLabel(it: Pick<StationItem, "sku" | "name">): string {
  return (it.sku || "").trim() || (it.name || "").trim() || "—";
}

/** Số MẪU MÃ khác nhau trong một kiện — đây là thứ quyết định đếm nhanh được hay phải mở từng món. */
export function variantCount(row: Pick<StationRow, "items">): number {
  const set = new Set<string>();
  for (const it of row.items) {
    if (it.quantity <= 0) continue;
    set.add(it.variantId ?? itemKey(it));
  }
  return set.size;
}

/* ─────────────────────────── BỘ LỌC ─────────────────────────── */

export const PENDING_VARIETY = ["ALL", "ONE", "MANY"] as const;
export type PendingVariety = (typeof PENDING_VARIETY)[number];

export const PENDING_VARIETY_LABEL: Record<PendingVariety, string> = {
  ALL: "Mọi kiện",
  ONE: "Một mẫu mã",
  MANY: "Nhiều mẫu mã",
};

export const PENDING_LINK = ["ALL", "LINKED", "UNLINKED"] as const;
export type PendingLink = (typeof PENDING_LINK)[number];

export const PENDING_LINK_LABEL: Record<PendingLink, string> = {
  ALL: "Mọi kiện",
  LINKED: "Đã ghép đơn",
  UNLINKED: "Chưa ghép được đơn",
};

export const PENDING_AGE = ["ALL", "STALE", "OVERDUE"] as const;
export type PendingAge = (typeof PENDING_AGE)[number];

export const PENDING_AGE_LABEL: Record<PendingAge, string> = {
  ALL: "Mọi tuổi",
  STALE: `Chờ ≥ ${INSPECT_AGE_DAYS.TON_DONG} ngày`,
  OVERDUE: `Chờ ≥ ${INSPECT_AGE_DAYS.QUA_HAN} ngày`,
};

const AGE_MIN: Record<PendingAge, number> = {
  ALL: 0,
  STALE: INSPECT_AGE_DAYS.TON_DONG,
  OVERDUE: INSPECT_AGE_DAYS.QUA_HAN,
};

export type PendingFilter = {
  /** Ô gõ tự do: mã vận đơn · mã đơn · tên khách · SĐT · mã hàng · tên hàng · màu · size. */
  q: string;
  /** Khoá mã hàng đã chuẩn hoá (`itemKey`), rỗng = không lọc. */
  sku: string;
  color: string;
  size: string;
  variety: PendingVariety;
  age: PendingAge;
  link: PendingLink;
  /** Ai/cái gì đã ghi nhận kiện về kho — tách lượt đối soát sổ giấy khỏi kiện người kho tự bấm. */
  receivedBy: string;
};

export const PENDING_FILTER_EMPTY: PendingFilter = {
  q: "",
  sku: "",
  color: "",
  size: "",
  variety: "ALL",
  age: "ALL",
  link: "ALL",
  receivedBy: "",
};

export function activeFilterCount(f: PendingFilter): number {
  let n = 0;
  if (f.q.trim()) n += 1;
  if (f.sku) n += 1;
  if (f.color) n += 1;
  if (f.size) n += 1;
  if (f.variety !== "ALL") n += 1;
  if (f.age !== "ALL") n += 1;
  if (f.link !== "ALL") n += 1;
  if (f.receivedBy) n += 1;
  return n;
}

/**
 * Đống chữ để dò ô gõ tự do.
 *
 * HAI đống, không phải một: mã vận đơn và mã hàng chuẩn hoá theo kiểu MÃ (viết hoa, bỏ hết ký tự
 * phân cách), còn tên khách và tên hàng chuẩn hoá theo kiểu CHỮ (thường hoá, bỏ dấu). Trộn một
 * đống thì gõ `dam do` không ra "Đầm Đỏ", còn gõ `V15 0123` không ra `V150123`.
 */
function haystacks(row: StationRow): { ma: string; chu: string } {
  const maParts = [row.code ?? "", row.orderCode ?? "", row.customerPhone];
  const chuParts = [row.customerName, row.receivedBy];
  for (const it of row.items) {
    maParts.push(it.sku);
    chuParts.push(it.name, it.color, it.size, it.sku);
  }
  return { ma: maParts.map((x) => foldCode(x)).join(" "), chu: chuParts.map((x) => foldAttr(x)).join(" ") };
}

/**
 * Mọi từ phải khớp một chỗ nào đó (VÀ, không phải HOẶC).
 *
 * Gõ thêm một từ mà danh sách DÀI RA là hành vi không ai đoán được; người dùng gõ thêm để thu hẹp.
 */
function khopChu(row: StationRow, q: string): boolean {
  const tuKhoa = q.trim().split(/\s+/).filter(Boolean);
  if (!tuKhoa.length) return true;
  const { ma, chu } = haystacks(row);
  return tuKhoa.every((t) => {
    const tMa = foldCode(t);
    const tChu = foldAttr(t);
    return (tMa.length > 0 && ma.includes(tMa)) || (tChu.length > 0 && chu.includes(tChu));
  });
}

/** Kiện có ít nhất một dòng hàng thoả cả ba điều kiện mã/màu/size cùng lúc — không phải ba lượt lọc rời. */
function khopMon(row: StationRow, f: PendingFilter): boolean {
  if (!f.sku && !f.color && !f.size) return true;
  return row.items.some((it) => {
    if (it.quantity <= 0) return false;
    if (f.sku && itemKey(it) !== f.sku) return false;
    if (f.color && foldAttr(it.color) !== f.color) return false;
    if (f.size && foldAttr(it.size) !== f.size) return false;
    return true;
  });
}

/**
 * Đã ghép được đơn hay chưa — theo CĂN CỨ GHÉP, không theo việc có dòng hàng hay không.
 *
 * `AMBIGUOUS` (mã gốc lần ra nhiều đơn) đứng cùng phía "chưa ghép được": ERP có danh sách món, chỉ
 * là có nhiều danh sách và không chọn hộ. Xếp nó vào "đã ghép" là mời người kho bấm nhận đủ theo
 * một đơn chọn bừa.
 */
function daGhep(row: StationRow): boolean {
  return row.linkBasis === "DIRECT" || row.linkBasis === "RETURN_LEG";
}

export function filterPending<T extends StationRow>(rows: T[], f: PendingFilter): T[] {
  return rows.filter((r) => {
    if (f.variety !== "ALL") {
      const n = variantCount(r);
      if (f.variety === "ONE" && n !== 1) return false;
      if (f.variety === "MANY" && n < 2) return false;
    }
    if (f.link === "LINKED" && !daGhep(r)) return false;
    if (f.link === "UNLINKED" && daGhep(r)) return false;
    if (r.ageDays < AGE_MIN[f.age]) return false;
    if (f.receivedBy && foldAttr(r.receivedBy) !== f.receivedBy) return false;
    if (!khopMon(r, f)) return false;
    if (!khopChu(r, f.q)) return false;
    return true;
  });
}

/* ─────────────────────────── SẮP XẾP ─────────────────────────── */

export const PENDING_SORTS = ["receivedAt", "returnedAt", "expectedQty", "variants", "code"] as const;
export type PendingSortKey = (typeof PENDING_SORTS)[number];

export const PENDING_SORT_LABEL: Record<PendingSortKey, string> = {
  receivedAt: "Kho ghi nhận",
  returnedAt: "ĐVVC trả về",
  expectedQty: "Số món kỳ vọng",
  variants: "Số mẫu mã",
  code: "Mã vận đơn",
};

export const PENDING_SORT_HINT: Record<PendingSortKey, string> = {
  receivedAt: "Lúc kho bấm “đã nhận”. Kiện vào bằng một lượt đối soát sổ giấy có mốc gần như bằng nhau — sắp theo cột này chúng đứng thành một khối.",
  returnedAt: "Lúc ĐVVC trả kiện về shop — dòng thời gian THẬT của kiện. Kiện chưa có chứng từ ĐVVC xếp xuống cuối, không giả vờ là mới nhất.",
  expectedQty: "Số món lẽ ra nằm trong kiện. Kiện chưa ghép được đơn không có số này và xếp xuống cuối.",
  variants: "Kiện một mẫu mã đếm nhanh được; kiện nhiều mẫu mã phải mở từng món.",
  code: "Theo mã vận đơn — để dò tay theo tệp giấy đang cầm.",
};

export type SortDir = "asc" | "desc";

/**
 * `null` LUÔN XẾP CUỐI, ở cả hai chiều.
 *
 * Không phải một quy ước tuỳ tiện: `null` ở đây nghĩa là CHƯA BIẾT (chưa có chứng từ ĐVVC, chưa
 * ghép được đơn). Cho nó trôi lên đầu khi bấm "mới nhất" là in một kiện không có mốc thời gian ra
 * chỗ dành cho kiện mới nhất — người đọc kết luận sai mà màn hình trông vẫn bình thường.
 */
function soSanh(a: number | string | null, b: number | string | null, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const d = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
  return dir === "asc" ? d : -d;
}

function khoaSap(row: StationRow, key: PendingSortKey): number | string | null {
  switch (key) {
    case "receivedAt":
      return Date.parse(row.receivedAt) || null;
    case "returnedAt":
      return row.returnedAt ? Date.parse(row.returnedAt) || null : null;
    case "expectedQty":
      return row.expectedQty;
    case "variants":
      return variantCount(row);
    case "code":
      return row.code ?? null;
  }
}

/**
 * Sắp xếp ỔN ĐỊNH: hai kiện cùng khoá giữ nguyên thứ tự cũ, và phá hoà bằng `shipmentId` để hai
 * lần chạy ra đúng một kết quả. Danh sách nhảy loạn giữa hai lần vẽ là cách nhanh nhất để người
 * kho đếm trùng một kiện.
 */
export function sortPending<T extends StationRow>(rows: T[], key: PendingSortKey, dir: SortDir): T[] {
  return [...rows].sort((a, b) => soSanh(khoaSap(a, key), khoaSap(b, key), dir) || a.shipmentId.localeCompare(b.shipmentId));
}

/* ─────────────────────────── Ô CHỌN NHANH ─────────────────────────── */

export type Facet = { key: string; label: string; parcels: number; qty: number };

/**
 * Danh sách mã hàng / màu / size / nguồn nhận kèm SỐ KIỆN.
 *
 * Có số kiện thì ô chọn trả lời luôn câu hỏi tiếp theo — *"sọt Q002 có bao nhiêu kiện, đếm hết mất
 * bao lâu"* — thay vì bắt bấm vào rồi mới biết. `parcels` đếm KIỆN (một kiện có hai dòng cùng mã
 * vẫn là một kiện), `qty` cộng SỐ MÓN.
 *
 * Tính trên TẬP ĐẦY ĐỦ đang tải, không trên tập đã lọc: con số bên cạnh một lựa chọn phải nói
 * "bấm vào sẽ ra bao nhiêu", không phải "còn lại bao nhiêu sau các bộ lọc khác".
 */
export function pendingFacets(rows: StationRow[]): { skus: Facet[]; colors: Facet[]; sizes: Facet[]; receivers: Facet[] } {
  const gom = (
    lay: (row: StationRow) => { key: string; label: string; qty: number }[],
  ): Facet[] => {
    const map = new Map<string, Facet>();
    for (const row of rows) {
      const seen = new Set<string>();
      for (const { key, label, qty } of lay(row)) {
        if (!key) continue;
        const cur = map.get(key) ?? { key, label, parcels: 0, qty: 0 };
        if (!seen.has(key)) {
          cur.parcels += 1;
          seen.add(key);
        }
        cur.qty += qty;
        map.set(key, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.parcels - a.parcels || a.label.localeCompare(b.label));
  };

  const monCoHang = (row: StationRow) => row.items.filter((it) => it.quantity > 0);
  return {
    skus: gom((row) => monCoHang(row).map((it) => ({ key: itemKey(it), label: itemLabel(it), qty: it.quantity }))),
    colors: gom((row) => monCoHang(row).map((it) => ({ key: foldAttr(it.color), label: it.color.trim(), qty: it.quantity }))),
    sizes: gom((row) => monCoHang(row).map((it) => ({ key: foldAttr(it.size), label: it.size.trim(), qty: it.quantity }))),
    receivers: gom((row) => [{ key: foldAttr(row.receivedBy), label: row.receivedBy.trim(), qty: 1 }]),
  };
}

/* ─────────────────────────── TỔNG KẾT PHẦN ĐANG HIỆN ─────────────────────────── */

export type PendingTally = {
  parcels: number;
  /** Số món của phần ĐÃ ghép được đơn. Kiện chưa ghép không góp vào đây. */
  units: number;
  /** Kiện không có số kỳ vọng — nêu riêng, không cộng 0 vào `units`. */
  unknownParcels: number;
  /** Kiện nhiều mẫu mã: đếm nhanh cả kiện được, nhưng đếm THIẾU thì phải mở từng món. */
  multiVariant: number;
  /** Kiện chỉ suy danh sách món từ cả đơn — “nhận đủ” cần người xác nhận đã đối chiếu thực tế. */
  orderOnly: number;
  /** Kiện chưa ghép được đơn hoặc mã gốc ra nhiều đơn — không bấm “nhận đủ” hàng loạt được. */
  unlinked: number;
};

/**
 * Tổng kết của ĐÚNG phần đang hiện trên màn hình.
 *
 * Thanh hàng loạt phải nói được người bấm sắp làm gì với bao nhiêu kiện, và bao nhiêu trong số đó
 * sẽ bị từ chối — biết trước còn hơn bấm rồi đọc danh sách lỗi.
 */
export function tallyPending(rows: StationRow[]): PendingTally {
  const t: PendingTally = { parcels: rows.length, units: 0, unknownParcels: 0, multiVariant: 0, orderOnly: 0, unlinked: 0 };
  for (const r of rows) {
    if (r.expectedQty === null) t.unknownParcels += 1;
    else t.units += r.expectedQty;
    if (variantCount(r) >= 2) t.multiVariant += 1;
    if (r.itemsBasis === "ORDER_ONLY") t.orderOnly += 1;
    if (!daGhep(r)) t.unlinked += 1;
  }
  return t;
}
