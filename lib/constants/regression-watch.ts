/**
 * ═══════════ SỔ THEO DÕI TÁI DIỄN — LỖI 2B ĐÃ SỬA MÀ QUAY LẠI THÌ TỰ MỞ LẠI (chủ shop 22/10/2026, P0 mục E/F) ═══════════
 *
 * «Lỗi đã đóng mà tái diễn phải tự MỞ LẠI, không báo DONE.» Mỗi dòng nối MỘT bản sửa đã lên production với các mã chất lượng 2B
 * (`SALES_QUALITY_CODES`) mà bản sửa ấy phải làm hết:
 *  · `leakCodes`    — mã LỌT TỚI KHÁCH (`delivery = REACHED_CUSTOMER`). Đếm > 0 SAU `liveAt` ⇒ REGRESSION_REOPENED: MỘT việc /work
 *                     cho cặp (mã, sứ mệnh) — tạo mới, hoặc MỞ LẠI đúng việc ấy nếu đã đóng mà lại lọt sau lúc đóng.
 *  · `blockedCodes` — mã ĐÃ CHẶN TRƯỚC KHI GỬI (`delivery = BLOCKED_PRE_SEND`). Đếm > 0 là BẰNG CHỨNG bản sửa đang chạy, KHÔNG BAO GIỜ
 *                     là tái diễn. Hai số đứng riêng, không cộng.
 *  · `leakUnavailable` — chưa có bộ dò lọt tới khách cho bản sửa này: dòng không bao giờ REOPEN, bảng in «chưa đo được lọt», KHÔNG in 0.
 *
 * `liveAt` = lúc lượt Deploy ERP to VPS THÀNH CÔNG đầu tiên chứa commit gộp xong (verify + health của lượt ấy đạt) — KHÔNG phải mốc
 * gộp vào main: giữa hai mốc đó bản sửa chưa chạy, đếm lọt trong khoảng ấy là đổ oan cho bản sửa. Đo bằng API Actions 22/10/2026.
 *
 * KHAI TAY, có bài kiểm (tests/regression-watch.test.ts): mã có thật, đúng chiều `delivery`, `liveAt` là ISO, sứ mệnh không trùng.
 * `scripts/ai-tech.ts close --status=DONE` đọc tệp này TRÊN main để biết sứ mệnh nào phải kèm `--regression-run` — nên tên sứ mệnh
 * viết ở dạng `mission: "<mã>"` trên một dòng.
 * HÀM THUẦN, client import được; chỉ `import type` (ai-tech đọc chữ của tệp, không chạy nó).
 */
import type { SalesQualityCode } from "@/lib/constants/sales-quality";

export type RegressionWatchRow = {
  /** Mã sứ mệnh trong sổ /tech (docs/tech/MASTER_MISSION_REGISTRY.md). */
  mission: string;
  pr: number;
  /** Commit gộp vào main. */
  sha: string;
  /** Mốc lên production THẬT (ISO, UTC). */
  liveAt: string;
  /** Lượt Deploy ERP to VPS đưa bản sửa lên — truy nguyên được `liveAt`. */
  deployRun: number;
  leakCodes: readonly SalesQualityCode[];
  blockedCodes: readonly SalesQualityCode[];
  /** Có khi `leakCodes` rỗng: thiếu ĐÚNG cái gì để đo được lọt tới khách. */
  leakUnavailable?: string;
  /** Tổ chức áp dụng — mã bot chạy cho mọi tổ chức nên mặc định "ALL"; bằng chứng tách theo tổ chức ở phần mã hoá. */
  orgScope: "ALL" | readonly string[];
};

/*
  TODO ADDRESS_REASK (hỏi lại địa chỉ / SĐT đã biết): nối với sứ mệnh `address-resolver-ladder` (PR-A, code-erp-56) KHI nó lên
  production — Tech Lead 22/10/2026. Chưa nối: #966 sửa ADDRESS_RECEIVED_BUT_NOT_APPLIED, không sửa hiện tượng hỏi lại.
  TODO sales-qty-unit-guard: đổi `leakCodes` thành ["PACK_MULTIPLIER_LEAKED"] khi bộ dò lọt của code-erp-42 lên production; `liveAt` GIỮ
  mốc của #968 (bộ dò đọc lịch sử tin nên lọt sau mốc ấy vẫn đếm được).
*/
export const REGRESSION_WATCH: readonly RegressionWatchRow[] = [
  {
    mission: "sales-short-qty-round",
    pr: 945,
    sha: "66c334a15b9fdbf1dc29ee559fc1a611aa2f631e",
    liveAt: "2026-10-21T08:42:12Z",
    deployRun: 39569549867,
    leakCodes: ["QTY_REASKED", "SECONDARY_INTENT_UNANSWERED"],
    blockedCodes: [],
    orgScope: "ALL",
  },
  {
    mission: "upsell-short-accept",
    pr: 959,
    sha: "f574c19753ed2f58726e30c4bedce05aa2404f74",
    liveAt: "2026-10-21T20:58:25Z",
    deployRun: 39672940614,
    leakCodes: ["UPSELL_ACCEPTED_BUT_REASKED", "UPSELL_ACCEPTED_NOT_ATTACHED"],
    blockedCodes: [],
    orgScope: "ALL",
  },
  {
    mission: "sales-address-applied",
    pr: 966,
    sha: "705f954cfeb93b16efdaef6d0ad0ed3324c3e48f",
    liveAt: "2026-10-22T07:23:47Z",
    deployRun: 39738661026,
    leakCodes: ["ADDRESS_RECEIVED_BUT_NOT_APPLIED"],
    blockedCodes: [],
    orgScope: "ALL",
  },
  {
    mission: "sales-qty-unit-guard",
    pr: 968,
    sha: "eb615ec19fa68fe5b824813d4eb40ed672e64abc",
    liveAt: "2026-10-22T11:19:35Z",
    deployRun: 39767972088,
    leakCodes: [],
    blockedCodes: ["QUANTITY_UNIT_AMBIGUOUS", "PACK_MULTIPLIER_MISMATCH", "CART_TOTAL_CONFLICT", "ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT"],
    leakUnavailable:
      "Chưa có bộ dò LỌT TỚI KHÁCH: cần phát hiện đơn ĐÃ GHI mà dòng mẫu mã «Hộp N cái» mang đúng số khách nói (bội của N, N > 1) — bộ dò PACK_MULTIPLIER_LEAKED (code-erp-42). Bốn mã hiện có đều là lần CHẶN trước khi ghi.",
    orgScope: "ALL",
  },
];

export type RegressionVerdict = "REGRESSION_REOPENED" | "HOLDING" | "QUIET" | "LEAK_UNAVAILABLE";

/** Một việc /work cho cặp (mã, sứ mệnh) — KHÔNG theo ngày, nên lọt nhiều ngày liền vẫn chỉ một việc. */
export const regressionDedupeKey = (code: SalesQualityCode, mission: string) => `sales-quality:regression:${code}:${mission}`;

export const watchAppliesTo = (row: RegressionWatchRow, orgCode: string | null) => row.orgScope === "ALL" || (orgCode !== null && row.orgScope.includes(orgCode));

export type WatchHit = { code: SalesQualityCode; at: Date; conv: string };

/** Đếm của MỘT dòng sổ trên một tập hit — chỉ hit SAU `liveAt`. HÀM THUẦN. */
export function countAfterLive(row: RegressionWatchRow, hits: readonly WatchHit[]): {
  leaked: Map<SalesQualityCode, { hits: number; convs: Set<string>; lastAt: Date }>;
  blocked: number;
} {
  const live = Date.parse(row.liveAt);
  const leaked = new Map<SalesQualityCode, { hits: number; convs: Set<string>; lastAt: Date }>();
  let blocked = 0;
  for (const h of hits) {
    if (!(h.at.getTime() > live)) continue;
    if (row.blockedCodes.includes(h.code)) blocked += 1;
    if (!row.leakCodes.includes(h.code)) continue;
    const e = leaked.get(h.code) ?? { hits: 0, convs: new Set<string>(), lastAt: h.at };
    e.hits += 1;
    e.convs.add(h.conv);
    if (h.at > e.lastAt) e.lastAt = h.at;
    leaked.set(h.code, e);
  }
  return { leaked, blocked };
}

/** Kết luận của một dòng sổ. `leaked` = số tin lọt tới khách sau `liveAt`. HÀM THUẦN. */
export function regressionVerdict(row: RegressionWatchRow, leaked: number, blocked: number): RegressionVerdict {
  if (leaked > 0) return "REGRESSION_REOPENED";
  if (!row.leakCodes.length) return "LEAK_UNAVAILABLE";
  return blocked > 0 ? "HOLDING" : "QUIET";
}

/**
 * Việc /work của cặp (mã, sứ mệnh) phải làm gì khi có lọt mới, mốc lọt muộn nhất `lastLeakAt`:
 *  · chưa có việc ⇒ CREATE;
 *  · việc đang mở ⇒ REFRESH (cập nhật số đếm, không đẻ việc thứ hai);
 *  · việc ĐÃ ĐÓNG mà lọt SAU lúc đóng ⇒ REOPEN — «đã đóng mà tái diễn phải tự mở lại»;
 *  · việc đã đóng và mọi lọt đều TRƯỚC lúc đóng ⇒ KEEP_CLOSED (người đóng đã thấy đúng các lần ấy).
 * HÀM THUẦN.
 */
export function reopenAction(existing: { resolvedAt: Date | null } | null, lastLeakAt: Date): "CREATE" | "REFRESH" | "REOPEN" | "KEEP_CLOSED" {
  if (!existing) return "CREATE";
  if (!existing.resolvedAt) return "REFRESH";
  return lastLeakAt > existing.resolvedAt ? "REOPEN" : "KEEP_CLOSED";
}

/** Mã sứ mệnh khai trong CHỮ của tệp này (ai-tech đọc bản trên main, không chạy mã). HÀM THUẦN. */
export function watchedMissionsFromSource(source: string): string[] {
  return [...new Set([...source.matchAll(/^\s*mission:\s*"([a-z0-9][a-z0-9-]*)",\s*$/gm)].map((m) => m[1]))];
}

/** Dòng tóm tắt công khai của ops `regression-watch-status` cho một sứ mệnh — ai-tech đọc đúng dạng này. */
export const REGRESSION_SUMMARY_PREFIX = "regression-watch";
export function regressionSummaryLine(mission: string, reopened: number, rows: number): string {
  return `${REGRESSION_SUMMARY_PREFIX} mission=${mission} reopened=${reopened} rows=${rows}`;
}
export function parseRegressionSummary(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/regression-watch mission=([a-z0-9][a-z0-9-]*) reopened=(\d+) rows=\d+/g)) out.set(m[1], (out.get(m[1]) ?? 0) + Number(m[2]));
  return out;
}
