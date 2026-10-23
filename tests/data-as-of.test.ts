/**
 * ═══════════ «TÍNH LÚC · NGUỒN · TRỄ ĐỐI TÁC» (OD-UX-03, 23/10/2026) ═══════════
 *
 * Khoá ba thứ:
 *  · `collectAsOf` trả mốc dữ liệu CŨ NHẤT của mọi mục đệm đã đọc — kể cả khi đệm trả số cũ rồi làm mới phía sau (mốc là của
 *    số CŨ), kể cả mục đệm dựng trên một mục đệm cũ hơn; và hai request song song KHÔNG thấy mốc của nhau.
 *  · `asOfCells` (hàm thuần dùng chung): chưa biết ⇒ «—»; mẫu trễ thiếu ⇒ «chưa đủ mẫu — CHƯA BIẾT», không bao giờ một câu
 *    trông như «khoẻ»; chỉ LAGGING / STALLED đổi màu.
 *  · Hai mốc nguồn mới đọc đúng hàng: bảng kê COD = tệp STATEMENT_DETAIL (không phải DS vận đơn); Pancake = lượt SUCCESS cuối
 *    của job ĐƠN (không lượt lỗi / dở dang / job khác).
 */
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo, collectAsOf, memo } from "@/lib/cache";
import { asOfCells, latencyFromHealth, PANCAKE_ORDER_SYNC_JOBS, VTP_ORDER_LIST_IMPORT_HREF, webhookGapCell, webhookMatchCell, webhookMatchFromHealth } from "@/lib/constants/data-as-of";
import { VTP_ORDER_LIST_MAX_AGE_HOURS } from "@/lib/constants/feed-freshness";
import { WEBHOOK_MATCH_MIN_SAMPLE } from "@/lib/constants/webhook-gap";
import { WEBHOOK_LATENCY_MIN_SAMPLE } from "@/lib/constants/webhook-latency";
import { getVtpSyncCoverage } from "@/lib/queries/vtp-sync-coverage";

const PHUT = 60_000;
const nhuong = () => new Promise<void>((r) => setImmediate(r));

async function testCollectAsOf() {
  const BAY_GIO = Date.now();
  let dongHo = BAY_GIO;
  const goc = Date.now;
  Date.now = () => dongHo;
  try {
    clearMemo();
    const doc = (k: string, v: string, ttl = 60 * PHUT) => memo(`test-asof:${k}`, ttl, async () => v);
    // Ngoài collectAsOf: memo chạy y hệt.
    assert.equal(await doc("A", "a1", PHUT), "a1");
    dongHo = BAY_GIO + 7 * PHUT;
    await doc("B", "b1");

    // ── Mốc CŨ NHẤT của mọi mục đã đọc.
    dongHo = BAY_GIO + 8 * PHUT;
    const ab = await collectAsOf(async () => [await doc("B", "x"), await doc("A", "x", PHUT)]);
    assert.deepEqual(ab.value, ["b1", "a1"], "trúng đệm (B) và đệm cũ trả ngay (A)");
    assert.deepEqual([ab.asOf.getTime(), ab.cached], [BAY_GIO, true], "mốc = mục cũ nhất (A lúc BAY_GIO), không phải lúc đọc");

    // ── Đệm cũ trả số cũ ⇒ mốc là của số CŨ; lượt làm mới xong thì mốc là của lượt làm mới.
    const sau = await collectAsOf(async () => {
      for (let i = 0; i < 5; i++) await nhuong();
      return doc("A", "x", PHUT);
    });
    assert.equal(sau.value, "x", "lượt làm mới phía sau đã ghi số mới");
    assert.equal(sau.asOf.getTime(), BAY_GIO + 8 * PHUT, "mốc của số mới = lúc lượt làm mới bắt đầu");

    // ── Mục đệm dựng trên một mục đệm cũ hơn mang mốc của mục cũ đó, kể cả khi đọc lại sau này.
    dongHo = BAY_GIO + 9 * PHUT;
    await memo("test-asof:C", 60 * PHUT, async () => `C(${await doc("B", "x")})`);
    dongHo = BAY_GIO + 10 * PHUT;
    const c = await collectAsOf(() => memo("test-asof:C", 60 * PHUT, async () => "khong-tinh-lai"));
    assert.deepEqual([c.value, c.asOf.getTime()], ["C(b1)", BAY_GIO + 7 * PHUT], "C tính lúc +9′ nhưng đứng trên B lúc +7′");

    // ── Không đọc đệm nào ⇒ mốc = lúc bắt đầu, «truy vấn trực tiếp».
    const tt = await collectAsOf(async () => 1);
    assert.deepEqual([tt.asOf.getTime(), tt.cached], [BAY_GIO + 10 * PHUT, false]);

    // ── HAI REQUEST SONG SONG không rò mốc sang nhau (Tech Lead 23/10/2026), xen kẽ có chủ ý.
    const [r1, r2] = await Promise.all([
      collectAsOf(async () => {
        await nhuong();
        const v = await doc("B", "x");
        await nhuong();
        return v;
      }),
      collectAsOf(async () => {
        await nhuong();
        await nhuong();
        return doc("C2", "c2");
      }),
    ]);
    assert.equal(r1.asOf.getTime(), BAY_GIO + 7 * PHUT, "request 1 chỉ đọc B");
    assert.equal(r2.asOf.getTime(), BAY_GIO + 10 * PHUT, "request 2 chỉ tính C2 lúc này — không nhận mốc B của request 1");

    // ── Lồng nhau: mốc của trong đi lên ngoài; ngoài không đi xuống trong.
    const ngoai = await collectAsOf(async () => {
      const trong = await collectAsOf(() => doc("C2", "x"));
      await doc("B", "x");
      return trong;
    });
    assert.equal(ngoai.value.asOf.getTime(), BAY_GIO + 10 * PHUT, "bộ gom trong chỉ thấy C2");
    assert.equal(ngoai.asOf.getTime(), BAY_GIO + 7 * PHUT, "bộ gom ngoài thấy cả B");

    // ── Hai request dùng chung MỘT lượt tính đang chạy: cùng một mốc (lúc lượt ấy bắt đầu).
    dongHo = BAY_GIO + 11 * PHUT;
    let mo: () => void = () => {};
    const cham = new Promise<void>((r) => (mo = r));
    const tinhCham = () =>
      memo("test-asof:D", 60 * PHUT, async () => {
        await cham;
        return "d";
      });
    const p1 = collectAsOf(tinhCham);
    await nhuong();
    // Nhích 1 GIÂY, không phải 1 phút: lượt đang chạy quá TRAN_CHO_CHUNG (20 giây) bị coi là đã bỏ rơi và tính lại — đúng luật.
    dongHo = BAY_GIO + 11 * PHUT + 1_000;
    const p2 = collectAsOf(tinhCham);
    await nhuong();
    mo();
    const [d1, d2] = await Promise.all([p1, p2]);
    assert.deepEqual([d1.value, d2.value], ["d", "d"]);
    assert.equal(d1.asOf.getTime(), BAY_GIO + 11 * PHUT);
    assert.equal(d2.asOf.getTime(), BAY_GIO + 11 * PHUT, "người dùng chung lượt tính nhận mốc của lượt ấy, không phải lúc mình hỏi");
  } finally {
    Date.now = goc;
    clearMemo();
  }
}

function testAsOfCells() {
  const BAY_GIO = new Date();
  const truoc = (phut: number) => new Date(BAY_GIO.getTime() - phut * PHUT);
  // Chưa biết ⇒ «—», không phải 0 / «vừa xong».
  const trong = asOfCells({ asOf: null, now: BAY_GIO, lastCodStatementAt: null, lastPancakeSyncAt: null, latency: null });
  assert.deepEqual(
    trong.map((c) => c.text),
    ["Số liệu tính lúc: —", "Bảng kê COD cuối: —", "Đồng bộ đơn Pancake thành công cuối: —", "Trễ ĐVVC: chưa đủ mẫu (0 gói giờ qua) — CHƯA BIẾT"],
  );
  // Ô vắng (`undefined`) ⇒ không in; đầu trang /shipments không in «tính lúc».
  assert.deepEqual(asOfCells({ now: BAY_GIO }).map((c) => c.key), []);
  // Đệm ⇒ nói là đệm và cách đây bao lâu; truy vấn thẳng ⇒ nói là truy vấn thẳng.
  assert.match(asOfCells({ asOf: { asOf: truoc(6), cached: true }, now: BAY_GIO })[0].text, /^Số liệu tính lúc .+ \(đệm, 6 phút trước\)$/);
  assert.match(asOfCells({ asOf: { asOf: BAY_GIO, cached: false }, now: BAY_GIO })[0].text, /^Số liệu truy vấn trực tiếp lúc /);

  const tre = (o: Partial<Parameters<typeof latencyFromHealth>[0]>) =>
    asOfCells({ now: BAY_GIO, latency: latencyFromHealth({ latencyMedianSeconds: 38, latencyBaselineSeconds: 35, latencySample: 212, latency: "FRESH", latencyNote: "n", ...o }) })[0];
  assert.deepEqual([tre({}).text, tre({}).tone], ["Trễ ĐVVC: trung vị 38 giây · giờ qua · 212 gói (nền 35 giây)", "muted"], "FRESH: in số, KHÔNG tô xanh");
  assert.equal(tre({ latencySample: WEBHOOK_LATENCY_MIN_SAMPLE - 1 }).text, `Trễ ĐVVC: chưa đủ mẫu (${WEBHOOK_LATENCY_MIN_SAMPLE - 1} gói giờ qua) — CHƯA BIẾT`);
  assert.match(tre({ latency: "UNKNOWN", latencyBaselineSeconds: null }).text, /\(nền —\) — chưa đủ nền để nói nhanh hay chậm$/);
  assert.deepEqual([tre({ latency: "LAGGING", latencyMedianSeconds: 400 }).tone, tre({ latency: "STALLED", latencyMedianSeconds: 1800 }).tone], ["warn", "warn"]);
  assert.match(tre({ latency: "STALLED", latencyMedianSeconds: 1800 }).text, /trung vị 30 phút .* — ĐANG DỒN$/);
  for (const c of [...trong, tre({})]) assert.doesNotMatch(c.text, /khoẻ|ổn định|OK\b/i, "không câu nào kết luận «khoẻ»");
}

/**
 * OD-UX-03b (23/10/2026): đo production cùng ngày — tệp «Danh sách vận đơn» APPLY cuối 02/10, tức 3 tuần không có phép đo chỗ
 * hụt webhook, mà thẻ chỉ in một cái mốc. Nay thẻ NÓI RA điều đó và chỉ chỗ bấm. Ngưỡng hổ phách = nhịp nhập đã khai
 * (`VTP_ORDER_LIST_MAX_AGE_HOURS`), không phải một con số mới; tỷ lệ khớp không có đích khai nên không bao giờ đổi màu.
 */
function testWebhookGapCells() {
  const BAY_GIO = new Date();
  const truocGio = (h: number) => new Date(BAY_GIO.getTime() - h * 3_600_000);
  // Chưa từng nhập = đến hạn (cùng luật với máy nhắc `vtpOrderListDue`), không phải «không biết».
  const chua = webhookGapCell(null, BAY_GIO);
  assert.deepEqual([chua.text, chua.tone, chua.href], ["Chỗ hụt webhook: CHƯA TỪNG đo — nhập tệp Danh sách vận đơn để đo", "warn", VTP_ORDER_LIST_IMPORT_HREF]);
  // Cũ: ca thật 02/10 → 23/10 = 21 ngày.
  const cu = webhookGapCell(truocGio(21 * 24 + 6), BAY_GIO);
  assert.match(cu.text, /^Chỗ hụt webhook: chưa đo từ .+ \(21 ngày\) — nhập tệp Danh sách vận đơn để đo$/);
  assert.deepEqual([cu.tone, cu.href], ["warn", VTP_ORDER_LIST_IMPORT_HREF]);
  // Biên: ĐÚNG bằng nhịp đã khai là đến hạn; dưới một giờ thì chưa.
  assert.equal(webhookGapCell(truocGio(VTP_ORDER_LIST_MAX_AGE_HOURS), BAY_GIO).tone, "warn", "đúng bằng nhịp nhập đã khai ⇒ đến hạn");
  const moi = webhookGapCell(truocGio(VTP_ORDER_LIST_MAX_AGE_HOURS - 1), BAY_GIO);
  assert.deepEqual([moi.tone, moi.href], ["muted", undefined]);
  assert.match(moi.text, /^Chỗ hụt webhook: đo lần cuối /);

  // Tỷ lệ khớp: không lần nhập nào · mẫu thiếu · đủ mẫu — và KHÔNG ô nào đổi màu.
  const khongDo = webhookMatchCell(webhookMatchFromHealth({ matchRate: null, matchSample: 0 }));
  const thieu = webhookMatchCell(webhookMatchFromHealth({ matchRate: null, matchSample: 12 }));
  const du = webhookMatchCell(webhookMatchFromHealth({ matchRate: 0.9721, matchSample: 412 }));
  assert.deepEqual(
    [khongDo.text, thieu.text, du.text],
    [
      "Webhook khớp tệp (30 ngày): chưa đo — không lần nhập tệp nào trong 30 ngày",
      `Webhook khớp tệp (30 ngày): chưa đủ mẫu (12 dòng, cần ${WEBHOOK_MATCH_MIN_SAMPLE})`,
      "Webhook khớp tệp (30 ngày): 97.2% · 412 dòng",
    ],
  );
  assert.ok([khongDo, thieu, du, webhookMatchCell(null)].every((c) => c.tone === "muted"), "tỷ lệ khớp không có đích khai ⇒ không tô màu (AGENTS 38)");
  // Trong asOfCells: chỉ in khi trang truyền vào; đứng sau nguồn, trước trễ.
  const keys = asOfCells({ now: BAY_GIO, lastCodStatementAt: null, orderListImportAt: null, webhookMatch: null, latency: null }).map((c) => c.key);
  assert.deepEqual(keys, ["codStatement", "webhookGap", "webhookMatch", "latency"]);
}

async function testNguonMoi(db: Db) {
  const BAY_GIO = Date.now();
  const sau = (ngay: number) => new Date(BAY_GIO + ngay * 86_400_000);
  const tepIds = ["test-asof-bk", "test-asof-ds"];
  const runIds = ["test-asof-ok", "test-asof-loi", "test-asof-dang", "test-asof-khac"];
  try {
    await db.insert(schema.vtpStatementFiles).values([
      { id: tepIds[0], filename: "test-asof-bang-ke.xlsx", content: "", kind: "STATEMENT_DETAIL", receivedAt: sau(-3), lastImportedAt: sau(1) },
      { id: tepIds[1], filename: "test-asof-ds-van-don.xlsx", content: "", kind: "ORDER_LIST", receivedAt: sau(2) },
    ]);
    await db.insert(schema.syncRuns).values([
      { id: runIds[0], source: "PANCAKE", job: PANCAKE_ORDER_SYNC_JOBS[0], status: "SUCCESS", finishedAt: sau(1) },
      { id: runIds[1], source: "PANCAKE", job: PANCAKE_ORDER_SYNC_JOBS[0], status: "FAILED", finishedAt: sau(2) },
      { id: runIds[2], source: "PANCAKE", job: PANCAKE_ORDER_SYNC_JOBS[1], status: "RUNNING", finishedAt: null },
      { id: runIds[3], source: "PANCAKE", job: "products", status: "SUCCESS", finishedAt: sau(3) },
    ]);
    clearMemo();
    const c = await getVtpSyncCoverage({ from: sau(-1), to: sau(1) });
    assert.equal(c.lastCodStatementAt?.getTime(), sau(1).getTime(), "bảng kê = lần ERP ĐỌC tệp STATEMENT_DETAIL (last_imported_at), bỏ tệp DS vận đơn");
    assert.equal(c.lastPancakeSyncAt?.getTime(), sau(1).getTime(), "Pancake = lượt SUCCESS cuối của job ĐƠN — bỏ lượt lỗi, lượt dở dang, job sản phẩm");
  } finally {
    await db.delete(schema.syncRuns).where(inArray(schema.syncRuns.id, runIds));
    await db.delete(schema.vtpStatementFiles).where(inArray(schema.vtpStatementFiles.id, tepIds));
    clearMemo();
  }
}

export async function testDataAsOf(db: Db) {
  await testCollectAsOf();
  testAsOfCells();
  testWebhookGapCells();
  await testNguonMoi(db);
  console.log("✓ Tính lúc · nguồn · trễ ĐVVC (OD-UX-03): mốc CŨ NHẤT của mọi mục đệm (đệm cũ, mục lồng, lượt dùng chung) · request song song không rò mốc · chưa biết ⇒ «—» · trễ thiếu mẫu ⇒ CHƯA BIẾT, không tô xanh · bảng kê = STATEMENT_DETAIL · Pancake = SUCCESS cuối của job đơn · chỗ hụt webhook: chưa từng / cũ (≥ nhịp nhập đã khai) / mới, tỷ lệ khớp không tô màu");
}
