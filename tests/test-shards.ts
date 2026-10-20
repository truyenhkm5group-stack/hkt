/**
 * ═══════════ CHIA BỘ KIỂM THỬ THÀNH SHARD — SỔ KHỐI + BẢNG PHÂN + CỔNG CHẠY ═══════════
 *
 * VÌ SAO (Lead 20/10/2026): `npm test` là MỘT tệp chạy tuần tự (`tests/sync-fixtures.test.ts`), đo
 * 2.552 giây trên máy dev / 43–45′ trên CI. Hai lượt cổng hôm nay bị HUỶ ở trần 45′ khi đang chạy (#919
 * cả hai lượt, #923 lượt ẩn danh 45′ và lượt token 43′). Nâng trần là đẩy cái chết sang tuần sau; bỏ bài
 * là mất bảo vệ. Còn lại: chạy song song.
 *
 * CÁCH CHIA:
 *  · phần đầu `main()` (dựng fixture chung + các khối kiểm viết thẳng — 8 nhóm đầu, `rr-var`…) là
 *    CHUNG: shard nào cũng chạy, vì phần sau đọc dữ liệu nó gieo;
 *  · phần sau (chuỗi lời gọi `testX(db)`) chia thành các KHỐI có tên ở đây, đúng thứ tự trong mã nguồn;
 *  · `TEST_SHARD=i/N` chỉ chạy khối có `shard === i` theo bảng của N (thứ tự trong shard giữ nguyên thứ
 *    tự mã nguồn). Không đặt biến ⇒ chạy ĐỦ mọi khối — `npm test` cục bộ không đổi.
 *
 * BẤT BIẾN (khoá ở `tests/test-shards-plan.test.ts` + job gom của `gates.yml`):
 *  · mỗi khối thuộc ĐÚNG một shard; mọi shard 1..N đều có khối;
 *  · thứ tự gặp khối lúc chạy = thứ tự khai ở đây; khối không khai ⇒ ném lỗi; khối khai mà không gặp ⇒
 *    ném lỗi lúc kết thúc (một khối rơi khỏi mã nguồn không được im lặng);
 *  · mỗi shard ghi tệp kê khai (`TEST_SHARD_MANIFEST`) — job gom đòi hợp các shard = mọi khối, không trùng.
 *
 * CÂN THEO THỜI GIAN ĐO: cột `giay` là số đo (giây, máy dev) của từng khối, in ở bảng "THỜI GIAN THEO
 * KHỐI" cuối mỗi lượt. Đổi bảng phân = đọc bảng ấy rồi sửa `shard`, KHÔNG đoán.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SHARD_COUNT = 4;

export type TestBlock = { name: string; shard: number; /** Số đo gần nhất (giây, máy dev) — để cân, không để kiểm. */ giay: number };

/*
  Bảng khối — thứ tự PHẢI trùng thứ tự mã nguồn. `giay` đo 20/10/2026 trên máy dev (lượt đủ 2.817,5s; phần CHUNG
  ~14s). Phân bằng xếp khối lớn nhất vào shard nhẹ nhất ⇒ bốn shard 700 · 700 · 701 · 704 giây (nhóm chung shard tính như một khối).
*/
export const TEST_BLOCKS: readonly TestBlock[] = [
  { name: "K01", shard: 1, giay: 28.4 }, // từ testOrderOutcomeContract
  { name: "K02", shard: 1, giay: 16.1 }, // từ testCreativeLoop
  { name: "K03", shard: 1, giay: 47.4 }, // từ testVideoScaleProgressDb
  { name: "K04", shard: 1, giay: 90.5 }, // từ testHandoffSqlMatchesTypescript
  { name: "K05", shard: 3, giay: 69.8 }, // từ testDrilldownContract
  { name: "K06", shard: 3, giay: 10.1 }, // từ testEvidenceOnDb
  { name: "K07", shard: 1, giay: 15.5 }, // từ testWorkshopLedgerPure
  { name: "K08", shard: 1, giay: 75.5 }, // từ testCompanyOsProductionDb
  { name: "K09", shard: 2, giay: 109.9 }, // từ testOrgVolumeDiscount
  { name: "K10", shard: 4, giay: 29.1 }, // từ testDuplicateEvidencePure
  { name: "K11", shard: 1, giay: 9.1 }, // từ testCompensationBasisArithmetic
  { name: "K12", shard: 1, giay: 14.6 }, // từ testHmtReturnReconcile
  { name: "K13", shard: 2, giay: 11.2 }, // từ testStockShortagePure
  { name: "K14", shard: 4, giay: 8.5 }, // từ cleanupTaskAdvanceFixtures
  { name: "K15", shard: 2, giay: 3.6 }, // từ testMetricTrust
  { name: "K16", shard: 1, giay: 2.0 }, // từ testHangRaoBaiKiem
  { name: "K17", shard: 2, giay: 203.7 }, // từ testGanLaiSourceGuards
  { name: "K18", shard: 4, giay: 327.5 }, // từ testChatbotOrderBotAlerts
  { name: "K19", shard: 1, giay: 400.7 }, // từ testPageBuilder
  { name: "K20", shard: 4, giay: 306.9 }, // từ testInboxComposer
  { name: "K21", shard: 3, giay: 371.0 }, // từ testErpNative
  { name: "K22", shard: 3, giay: 249.7 }, // từ testSalesVision
  { name: "K23", shard: 2, giay: 371.4 }, // từ testPublicSiteData
  { name: "K24", shard: 4, giay: 31.7 }, // từ testErpA11y
];

/**
 * NHÓM PHẢI CHUNG MỘT SHARD — phụ thuộc ẩn đã ĐO (chạy riêng từng khối bằng `TEST_KHOI`, 20/10/2026): khối
 * sau đọc dữ liệu do khối trước gieo, nên tách ra là đỏ. Khối đứng sau trong mã nguồn vẫn chạy sau trong
 * shard. Gỡ một phụ thuộc = cho bài tự gieo dữ liệu của nó, rồi mới gỡ khỏi đây — không gỡ để cân cho đẹp.
 */
export const SHARD_GROUPS: readonly { blocks: readonly string[]; why: string }[] = [
  {
    blocks: ["K01", "K03", "K04", "K07", "K11"],
    why:
      "K01 gieo dữ liệu bốn khối sau đọc: testBackfill + testConsistency ghi nhật ký «backfill.canonical-state» / «reconcile.repair» mà testAuditTrail (K03) đòi; testCsWorkqueue tạo tài khoản csq-user mà testCsSemantic (K04) gán ca; testDataQuality tạo mẫu mã dq-var mà testInventory (K07) tìm; và kiện chờ đếm mà testReturnInspection (K11) cần. Đo: TEST_KHOI=K03/K04/K07/K11 từng khối riêng ĐỎ, cùng K01 thì ĐẠT.",
  },
];

/** Đọc `TEST_SHARD`. Rỗng ⇒ chạy đủ (`null`). Sai dạng / sai số shard ⇒ NÉM — chạy nhầm một phần còn tệ hơn đỏ. */
export function parseTestShard(v: string | undefined): { index: number; count: number } | null {
  if (v === undefined || v.trim() === "") return null;
  const m = /^(\d+)\/(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`TEST_SHARD phải dạng i/N (vd 2/${SHARD_COUNT}), nhận ${JSON.stringify(v)}`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count !== SHARD_COUNT) throw new Error(`TEST_SHARD=${v}: bảng phân hiện khai cho ${SHARD_COUNT} shard — đổi số shard thì đổi bảng ở tests/test-shards.ts`);
  if (index < 1 || index > count) throw new Error(`TEST_SHARD=${v}: chỉ số shard phải từ 1 tới ${count}`);
  return { index, count };
}

export type ShardManifest = { shard: string | null; ran: string[]; skipped: string[]; all: string[] };

/**
 * Cổng chạy khối của MỘT lượt. `chay(tên)` trả `true` khi khối thuộc shard đang chạy (hoặc không chia),
 * đồng thời kiểm thứ tự và ghi mốc giờ. `ketThuc()` kiểm đã gặp đủ khối và ghi tệp kê khai.
 */
export function taoCongShard(env: Readonly<Record<string, string | undefined>>, blocks: readonly TestBlock[] = TEST_BLOCKS, now: () => number = Date.now) {
  const shard = parseTestShard(env.TEST_SHARD);
  const ten = blocks.map((b) => b.name);
  /*
    CHẨN ĐOÁN, KHÔNG PHẢI CỔNG: `TEST_KHOI=K05[,K07]` chỉ chạy phần CHUNG + các khối ấy — để tìm khối nào
    đang đọc dữ liệu do khối KHÁC gieo (phụ thuộc ẩn ⇒ shard đỏ). CI không bao giờ đặt biến này; đặt
    cùng `TEST_SHARD` là ném (hai cách chọn khối cùng lúc là không biết đang chạy gì).
  */
  const chiKhoi = env.TEST_KHOI?.trim() ? new Set(env.TEST_KHOI.split(",").map((x) => x.trim())) : null;
  if (chiKhoi && shard) throw new Error("TEST_KHOI và TEST_SHARD không đặt cùng lúc");
  for (const k of chiKhoi ?? []) if (!ten.includes(k)) throw new Error(`TEST_KHOI: khối ${k} không có trong sổ`);
  let ke = 0;
  const ran: string[] = [];
  const skipped: string[] = [];
  const thoiGian: { name: string; ms: number }[] = [];
  let dangChay: { name: string; t0: number } | null = null;
  const dongKhoi = () => {
    if (dangChay) thoiGian.push({ name: dangChay.name, ms: now() - dangChay.t0 });
    dangChay = null;
  };
  return {
    shard,
    chay(name: string): boolean {
      dongKhoi();
      if (ten[ke] !== name) throw new Error(`Khối kiểm thử "${name}" gặp ở vị trí ${ke + 1}, sổ khai ${JSON.stringify(ten[ke] ?? "(hết sổ)")} — sổ tests/test-shards.ts lệch mã nguồn`);
      const b = blocks[ke];
      ke += 1;
      const vao = chiKhoi ? chiKhoi.has(name) : shard === null || b.shard === shard.index;
      (vao ? ran : skipped).push(name);
      if (vao) dangChay = { name, t0: now() };
      return vao;
    },
    ketThuc(): ShardManifest {
      dongKhoi();
      if (ke !== ten.length) throw new Error(`Bộ kiểm thử kết thúc sau ${ke}/${ten.length} khối — khối ${ten.slice(ke).join(", ")} khai trong sổ mà KHÔNG có trong mã nguồn`);
      const manifest: ShardManifest = { shard: shard ? `${shard.index}/${shard.count}` : chiKhoi ? `chỉ ${[...chiKhoi].join(",")}` : null, ran, skipped, all: ten };
      if (env.TEST_SHARD_MANIFEST) {
        mkdirSync(path.dirname(env.TEST_SHARD_MANIFEST), { recursive: true });
        writeFileSync(env.TEST_SHARD_MANIFEST, JSON.stringify(manifest, null, 2));
      }
      return manifest;
    },
    /** Bảng "THỜI GIAN THEO KHỐI" — đọc nó để cân lại cột `shard`. */
    bangThoiGian(): string[] {
      const tong = thoiGian.reduce((t, x) => t + x.ms, 0);
      const theoShard = new Map<number, number>();
      for (const x of thoiGian) {
        const s = blocks.find((b) => b.name === x.name)?.shard ?? 0;
        theoShard.set(s, (theoShard.get(s) ?? 0) + x.ms);
      }
      return [
        `THỜI GIAN THEO KHỐI (${thoiGian.length} khối đã chạy · ${(tong / 1000).toFixed(1)}s, chưa gồm phần CHUNG):`,
        ...thoiGian.map((x) => `  ${x.name.padEnd(6)} shard ${blocks.find((b) => b.name === x.name)?.shard ?? "?"}  ${(x.ms / 1000).toFixed(1).padStart(7)}s`),
        `  theo shard: ${[...theoShard.entries()].sort((a, b) => a[0] - b[0]).map(([s, ms]) => `${s}: ${(ms / 1000).toFixed(0)}s`).join(" · ")}`,
      ];
    },
  };
}

/** Kiểm bảng phân (hàm thuần): mỗi khối đúng một shard trong 1..N, mọi shard có khối, tên không trùng. */
export function shardPlanProblems(blocks: readonly TestBlock[], count = SHARD_COUNT, groups: readonly { blocks: readonly string[] }[] = SHARD_GROUPS): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.has(b.name)) p.push(`khối ${b.name} khai hai lần`);
    seen.add(b.name);
    if (!Number.isInteger(b.shard) || b.shard < 1 || b.shard > count) p.push(`khối ${b.name}: shard ${b.shard} ngoài 1..${count}`);
  }
  for (let s = 1; s <= count; s++) if (!blocks.some((b) => b.shard === s)) p.push(`shard ${s} không có khối nào`);
  for (const g of groups) {
    const shards = new Set(g.blocks.map((n) => blocks.find((b) => b.name === n)?.shard));
    if (g.blocks.some((n) => !seen.has(n))) p.push(`nhóm ${g.blocks.join("+")} nhắc khối không có trong sổ`);
    else if (shards.size !== 1) p.push(`nhóm ${g.blocks.join("+")} phải chung một shard (phụ thuộc ẩn đã đo), đang rải ở ${[...shards].join(", ")}`);
  }
  return p;
}
