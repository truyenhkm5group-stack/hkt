/**
 * Ops `shipping-source-probe` (chủ shop 18/10/2026, luồng vận đơn HSLC — «kiểm tra read-only nguồn tạo vận đơn từ ERP, Pancake/PosCake
 * và ViettelPost … không tự chuyển sang receive-only khi chưa xác minh»):
 *  1. hàm THUẦN: đối số được soát · hãng của đơn POS · mã đơn POS trong `order_link` · ghép POS ↔ ERP ba bậc (LINK > HINT_STRONG >
 *     HINT_WEAK, ngoài ±3 ngày ⇒ NONE) · gom theo hãng / COD khai báo / rủi ro hai vận đơn · kết luận từng đường kèm MEASURED / HINT /
 *     UNKNOWN (vắng trong MẪU không bao giờ MEASURED; API cả kỳ thắng mẫu);
 *  2. CSDL thật (dòng dựng riêng, tự dọn) + Pancake GIẢ (không gọi mạng): đơn ERP có lượt tạo vận đơn ERP + đơn POS cùng khách, cùng
 *     ngày, cùng tiền, có mã vận đơn ⇒ HINT_STRONG + rủi ro hai vận đơn; đơn POS ngoài kỳ không đếm; kênh tóm tắt không lọt SĐT / mã
 *     vận đơn / mã đơn;
 *  3. chỉ đọc, xả stdout trước khi thoát, khai đủ bốn chỗ ở ops-vps + platform-isolation-static.
 * Không mốc tuyệt đối: mọi mốc dựng tương đối so với giờ chạy, cửa sổ đọc «1 ngày trước giờ chạy» đi cùng nhịp (mục 50/65).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { mapOrder } from "@/lib/integrations/pancake/mapper";
import {
  aggregatePos,
  concludeShippingSource,
  splitSummary,
  matchPosToErp,
  overallSentence,
  parseProbeArgs,
  posCarrierBucket,
  posLinkOrderId,
  probeShippingSource,
  toPosLite,
  type ErpOrderLite,
  type PosOrderLite,
  type ProbeFacts,
  type RecentOrdersFetcher,
} from "../scripts/shipping-source-probe";

const H = 3_600_000;
const T0 = new Date(Date.UTC(2026, 9, 10, 3, 0, 0)); // mốc NỘI BỘ của phép ghép thuần — không so với đồng hồ thật

const erp = (over: Partial<ErpOrderLite> = {}): ErpOrderLite => ({ id: "erp-aaaaaaaa-0000", insertedAt: T0, phones: ["0900000001"], thread: "t1", moneyToCollect: 300_000, totalAfterDiscount: 280_000, linkOrderId: null, hasErpShipment: false, ...over });
const pos = (over: Partial<PosOrderLite> = {}): PosOrderLite => ({ posId: "901", linkOrderId: null, insertedAt: new Date(T0.getTime() + 2 * H), stage: "SHIPPED", phone: "0900000001", conversationId: null, moneyToCollect: 300_000, totalAfterDiscount: 280_000, bucket: "VTP", trackingCode: "PKE1", codDeclared: 300_000, ...over });

const baseFacts = (over: Partial<ProbeFacts> = {}): ProbeFacts => ({
  posOrgPresent: false,
  posOrgActive: false,
  carrierCreateActive: [],
  fanpageActive: true,
  shipments: { withCode: 0, erpCreated: 0, pancakeSynced: 0, carrierOnlyNoOrder: 0 },
  erpOrdersWithPosLink: 0,
  landingPushedToPos: 0,
  vtp: { packetsWindow: 0, packetsAll: 0, carrierEventsWindow: 0, importBatches: 0, statementLines: 0 },
  posApi: { status: "NOT_CONNECTED", posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0, truncated: false },
  pos: { sampleAsked: 0, sampleRead: 0, posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0 },
  ...over,
});
const pathOf = (facts: ProbeFacts, path: string) => concludeShippingSource(facts).find((c) => c.path === path)!;

function testPure() {
  assert.deepEqual(parseProbeArgs(["hslc-hmt-shop"]), { codes: ["hslc-hmt-shop"], days: 14, sample: 40 });
  assert.deepEqual(parseProbeArgs(["hslc-hmt-shop", "hslc-hmt", "hslc-vgcnj", "--days=30", "--sample=0"]), { codes: ["hslc-hmt-shop", "hslc-hmt", "hslc-vgcnj"], days: 30, sample: 0 });
  for (const bad of [[], ["HSLC"], ["a", "b", "c", "d"], ["hslc", "--days=0"], ["hslc", "--days=31"], ["hslc", "--sample=101"], ["hslc", "--sample=-1"], ["hslc", "--apply"]]) assert.ok("error" in parseProbeArgs(bad), `phải từ chối: ${bad.join(" ")}`);

  assert.equal(posCarrierBucket(null), "NO_SHIPMENT");
  assert.equal(posCarrierBucket({ carrier: "Viettel Post", trackingCode: "" }), "NO_TRACKING", "có phần đối tác mà không mã ⇒ không đoán tự giao hay chưa đẩy");
  assert.equal(posCarrierBucket({ carrier: "Viettel Post", trackingCode: "PKE1" }), "VTP");
  assert.equal(posCarrierBucket({ carrier: "Giao Hàng Tiết Kiệm", trackingCode: "S1" }), "GHTK");
  assert.equal(posCarrierBucket({ carrier: "GHN", trackingCode: "G1" }), "GHN");
  assert.equal(posCarrierBucket({ carrier: "J&T", trackingCode: "J1" }), "OTHER");
  assert.equal(posLinkOrderId("https://pos.pages.fm/shop/408063069/order?order_id=10920003274"), "10920003274");
  assert.equal(posLinkOrderId("https://evil.example/shop/1/order?order_id=5"), null);
  assert.equal(posLinkOrderId(""), null);
  const long = Array.from({ length: 120 }, (_, i) => `mục${i}`).join(" ");
  const parts = splitSummary(long);
  assert.ok(parts.length > 1 && parts.every((x) => x.length <= 292), "câu dài chia nhiều dòng, mỗi dòng dưới trần");
  assert.equal(parts.map((x, i) => (i ? x.replace(/^↳ /, "") : x)).join(" "), long, "không mất chữ nào");

  // toPosLite đi qua CHÍNH mapOrder của đồng bộ.
  const m = mapOrder({ id: "777", status: 2, inserted_at: "2026-10-10T05:00:00", bill_phone_number: "0900000001", money_to_collect: 300_000, total_price: 280_000, order_link: "https://pos.pages.fm/shop/1/order?order_id=555", partner: { partner_name: "Viettel Post", order_number_vtp: "PKE777", extend_code: "PKE777" } });
  assert.ok(m);
  const lite = toPosLite(m);
  assert.equal(lite.bucket, "VTP");
  assert.equal(lite.trackingCode, "PKE777");
  assert.equal(lite.linkOrderId, "555");
  assert.equal(lite.phone, "0900000001");
  assert.equal(lite.codDeclared, 300_000);

  // Ghép ba bậc.
  assert.deepEqual(matchPosToErp(pos({ linkOrderId: "555" }), [erp({ linkOrderId: "555", phones: [] })]), { cls: "LINK", erpId: "erp-aaaaaaaa-0000" });
  assert.equal(matchPosToErp(pos(), [erp()]).cls, "HINT_STRONG");
  assert.equal(matchPosToErp(pos({ moneyToCollect: 0, totalAfterDiscount: 280_000 }), [erp()]).cls, "HINT_STRONG", "tiền hàng sau giảm trùng cũng đủ");
  assert.equal(matchPosToErp(pos({ moneyToCollect: 150_000, totalAfterDiscount: 150_000 }), [erp()]).cls, "HINT_WEAK");
  assert.equal(matchPosToErp(pos({ phone: null, conversationId: "t1" }), [erp({ phones: [] })]).cls, "HINT_STRONG", "cùng mã hội thoại = cùng khách");
  assert.equal(matchPosToErp(pos({ insertedAt: new Date(T0.getTime() + 4 * 24 * H) }), [erp()]).cls, "NONE", "ngoài ±3 ngày ⇒ không ghép");
  assert.equal(matchPosToErp(pos({ phone: "0900000002" }), [erp()]).cls, "NONE", "khác khách ⇒ không ghép dù cùng tiền");
  const near = erp({ id: "erp-near", insertedAt: new Date(T0.getTime() + H) });
  assert.equal(matchPosToErp(pos({ moneyToCollect: 1, totalAfterDiscount: 1 }), [erp(), near]).erpId, "erp-near", "nhiều ứng viên cùng bậc ⇒ gần ngày nhất");

  // Gom: COD khai báo theo hãng, rủi ro hai vận đơn chỉ khi ERP CŨNG có lượt tạo vận đơn.
  const e1 = erp({ id: "erp-1", hasErpShipment: true });
  const e2 = erp({ id: "erp-2", phones: ["0900000002"] });
  const rows = [
    { pos: pos({ posId: "1" }), match: { cls: "HINT_STRONG" as const, erpId: "erp-1" } },
    { pos: pos({ posId: "2", phone: "0900000002" }), match: { cls: "HINT_STRONG" as const, erpId: "erp-2" } },
    { pos: pos({ posId: "3", bucket: "NO_SHIPMENT", trackingCode: null, codDeclared: 0 }), match: { cls: "HINT_WEAK" as const, erpId: "erp-1" } },
    { pos: pos({ posId: "4", bucket: "GHTK", codDeclared: 120_000 }), match: { cls: "NONE" as const, erpId: null } },
  ];
  const agg = aggregatePos(rows, new Map([e1, e2].map((e) => [e.id, e])));
  assert.equal(agg.total, 4);
  assert.equal(agg.withTracking, 3);
  assert.deepEqual(agg.byBucket.get("VTP"), { n: 2, cod: 600_000 });
  assert.deepEqual(agg.byBucket.get("GHTK"), { n: 1, cod: 120_000 });
  assert.equal(agg.erpAlsoShippedOnPos, 2);
  assert.equal(agg.doubleShipmentRisk, 1);
  assert.equal(agg.match.get("NONE"), 1);
  assert.equal(agg.matchWithTracking.get("HINT_WEAK") ?? 0, 0, "đơn POS không mã vận đơn không vào nhóm có mã");

  // Kết luận — ca HSLC đo 18/10: không gì cả ⇒ ERP không tạo / không nối POS (MEASURED), POS và VTP CHƯA ĐO ĐƯỢC (UNKNOWN).
  const hslc = baseFacts();
  assert.deepEqual([pathOf(hslc, "ERP_CARRIER").verdict, pathOf(hslc, "ERP_CARRIER").strength], ["KHÔNG DÙNG", "MEASURED"]);
  assert.deepEqual([pathOf(hslc, "ERP_POS_LINK").verdict, pathOf(hslc, "ERP_POS_LINK").strength], ["ERP KHÔNG NỐI POS", "MEASURED"]);
  assert.equal(pathOf(hslc, "POS_SHIPMENTS").strength, "UNKNOWN");
  assert.equal(pathOf(hslc, "VTP_WEBHOOK").strength, "UNKNOWN");
  assert.match(pathOf(hslc, "VTP_WEBHOOK").why, /không cấp API/);
  assert.equal(pathOf(hslc, "OUTSIDE_ERP").strength, "UNKNOWN");
  assert.match(overallSentence(concludeShippingSource(hslc)), /CHƯA XÁC ĐỊNH.*KHÔNG chuyển receive-only/);
  // Vắng trong mẫu: đủ mẫu ⇒ HINT, thiếu mẫu ⇒ UNKNOWN — không bao giờ MEASURED.
  assert.equal(pathOf(baseFacts({ pos: { sampleAsked: 20, sampleRead: 20, posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0 } }), "POS_SHIPMENTS").strength, "HINT");
  assert.equal(pathOf(baseFacts({ pos: { sampleAsked: 3, sampleRead: 3, posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0 } }), "POS_SHIPMENTS").strength, "UNKNOWN");
  // Thấy trong mẫu ⇒ MEASURED; và vận đơn POS không về ERP ⇒ «tạo trên POS, ERP không thấy».
  const seen = baseFacts({ pos: { sampleAsked: 20, sampleRead: 18, posOrders: 9, withTracking: 7, strongOrLink: 5, doubleShipmentRisk: 0 } });
  assert.deepEqual([pathOf(seen, "POS_SHIPMENTS").verdict, pathOf(seen, "POS_SHIPMENTS").strength], ["POS CÓ TẠO VẬN ĐƠN", "MEASURED"]);
  assert.equal(pathOf(seen, "OUTSIDE_ERP").verdict, "VẬN ĐƠN TẠO TRÊN POS, ERP KHÔNG THẤY");
  assert.match(overallSentence(concludeShippingSource(seen)), /POS_SHIPMENTS/);
  // API cả kỳ thắng mẫu: API đọc được 0 đơn ⇒ MEASURED «không có đơn», dù mẫu có thấy.
  const api = baseFacts({ posOrgPresent: true, posOrgActive: true, posApi: { status: "READ", posOrders: 0, withTracking: 0, strongOrLink: 0, doubleShipmentRisk: 0, truncated: false }, pos: seen.pos });
  assert.deepEqual([pathOf(api, "POS_SHIPMENTS").verdict, pathOf(api, "POS_SHIPMENTS").strength], ["POS KHÔNG CÓ ĐƠN TRONG KỲ", "MEASURED"]);
  assert.match(pathOf(baseFacts({ posOrgActive: true, posApi: { status: "READ", posOrders: 1000, withTracking: 900, strongOrLink: 0, doubleShipmentRisk: 0, truncated: true } }), "POS_SHIPMENTS").why, /CẮT/);
  // ERP có tạo ⇒ MEASURED đang dùng; kết nối bật mà không tạo ⇒ nói đúng như vậy.
  assert.equal(pathOf(baseFacts({ shipments: { withCode: 3, erpCreated: 3, pancakeSynced: 0, carrierOnlyNoOrder: 0 } }), "ERP_CARRIER").verdict, "ĐANG DÙNG");
  assert.equal(pathOf(baseFacts({ carrierCreateActive: ["viettelpost-carrier"] }), "ERP_CARRIER").verdict, "CÓ KẾT NỐI, KỲ NÀY KHÔNG TẠO");
  // Viettel Post có gói tin ⇒ MEASURED; chỉ có chứng từ cũ ⇒ «im lặng kỳ này».
  assert.equal(pathOf(baseFacts({ vtp: { packetsWindow: 4, packetsAll: 9, carrierEventsWindow: 0, importBatches: 0, statementLines: 0 } }), "VTP_WEBHOOK").verdict, "VIETTEL POST ĐANG BÁO VỀ");
  assert.equal(pathOf(baseFacts({ vtp: { packetsWindow: 0, packetsAll: 9, carrierEventsWindow: 0, importBatches: 0, statementLines: 0 } }), "VTP_WEBHOOK").verdict, "CÓ CHỨNG TỪ VIETTEL POST NHƯNG KỲ NÀY IM LẶNG");
}

function testSource() {
  const src = readFileSync("scripts/shipping-source-probe.ts", "utf8");
  assert.match(src, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /getDbForInspection\(/);
  assert.match(src, /connectionStatusRows\(db\)/, "kết nối đọc qua đường của service — không chạm bảng bí mật");
  assert.match(src, /bindReadOnlyOrgHandle\(org\)/, "API POS chỉ chạy sau khi gắn handle CHỈ ĐỌC (không migrate)");
  assert.match(src, /process\.stdout\.write\("", \(\) => process\.exit/, "xả stdout trước khi thoát");
  assert.doesNotMatch(src, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  assert.doesNotMatch(src, /\.post\(|createOrder|method: "POST"/, "Pancake CHỈ GET");
  assert.ok(!/\(\?<[=!]/.test(src), "không nhìn-ngược");
  for (const line of src.split("\n").filter((l) => /\b(say|tomTat)\(`/.test(l))) assert.doesNotMatch(line, /\$\{(?:pos\.(?:posId|trackingCode|phone)|match\.erpId|manualOrderShortCode|c\.thread|token|r\.ship|r\.bill)\b/, `dòng tóm tắt không in mã / SĐT: ${line.trim().slice(0, 120)}`);
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ops, /- shipping-source-probe\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bshipping-source-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bshipping-source-probe\b/, "làn ĐỌC nặng");
  assert.match(ops, /\n\s+shipping-source-probe\)\n[\s\S]*?fetch_script inbox-perf-probe\.ts[^\n]*\n\s+fetch_script shipping-source-probe\.ts[^\n]*\n\s+kiem_arg\n\s+ma_hoa_ket_qua chay_voi_arg[^\n]*scripts\/shipping-source-probe\.ts ;;/, "nhánh chạy đúng script (kèm inbox-perf-probe nó import), soát arg, trong ma_hoa_ket_qua");
  assert.ok(readFileSync("tests/platform-isolation-static.test.ts", "utf8").includes('"scripts/shipping-source-probe.ts":'), "khai getDbForInspection ở platform-isolation-static");
}

async function capture<T>(fn: () => Promise<T>): Promise<{ printed: string[]; result: T }> {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  try {
    return { printed, result: await fn() };
  } finally {
    console.log = orig;
  }
}

async function testDb() {
  const db = await getDb();
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const erpId = `erp-${randomUUID()}`;
  const short = erpId.slice(4, 12).toUpperCase();
  const PHONE = "0900007731";
  const PAGE = `ssp-page-${tag}`;
  const THREAD = `ssp-thread-${tag}`;
  const erpCode = `SSP${tag}E`;
  const posCode = `SSP${tag}P`;
  const now = new Date();
  const pancakeIso = (d: Date) => d.toISOString().slice(0, 19); // Pancake gửi ISO không múi giờ, là UTC
  const shipIds: string[] = [];
  try {
    await db.insert(schema.orders).values({ id: erpId, stage: "CONFIRMED", origin: "AI_AGENT", shipPhone: PHONE, shipProvince: "Thành phố Hà Nội", shipCommune: "Phường Ba Đình", moneyToCollect: 300_000, totalPriceAfterDiscount: 280_000, pageId: PAGE, conversationId: THREAD, insertedAt: new Date(now.getTime() - 2 * H) } as typeof schema.orders.$inferInsert);
    const rows = await db
      .insert(schema.shipments)
      .values({ orderId: erpId, attemptNo: 1, carrier: "Viettel Post", trackingCode: erpCode, vtpOrderNumber: erpCode, raw: { carrierCreate: { state: "CREATED", carrier: "VTP", reference: `ERP${short}-1`, by: null, at: now.toISOString() } } } as typeof schema.shipments.$inferInsert)
      .returning({ id: schema.shipments.id });
    shipIds.push(...rows.map((r) => r.id));

    const recent = [
      // Cùng khách, cùng ngày, cùng tiền, có mã vận đơn ⇒ HINT_STRONG + rủi ro hai vận đơn (ERP cũng đã tạo).
      { id: `${tag}1`, status: 2, inserted_at: pancakeIso(new Date(now.getTime() - H)), bill_phone_number: PHONE, money_to_collect: 300_000, total_price: 280_000, partner: { partner_name: "Viettel Post", order_number_vtp: posCode, extend_code: posCode } },
      // Cùng khách, khác tiền, chưa gửi hãng ⇒ HINT_WEAK, NO_SHIPMENT.
      { id: `${tag}2`, status: 0, inserted_at: pancakeIso(new Date(now.getTime() - 3 * H)), bill_phone_number: PHONE, money_to_collect: 150_000, total_price: 150_000 },
      // Ngoài kỳ (40 ngày trước) ⇒ không đếm.
      { id: `${tag}3`, status: 3, inserted_at: pancakeIso(new Date(now.getTime() - 40 * 24 * H)), bill_phone_number: PHONE, money_to_collect: 300_000, partner: { partner_name: "Viettel Post", extend_code: `${posCode}OLD` } },
    ];
    const asked: string[] = [];
    const fetcher: RecentOrdersFetcher = async (pageId, threadId, token) => {
      asked.push(`${pageId}|${threadId}|${token}`);
      return { ok: true, recentOrders: threadId === THREAD ? recent : [] };
    };
    const { printed, result } = await capture(() => probeShippingSource(db, { orgCode: "ssp-test", isHome: false, days: 1, sample: 100, now }, { fetchRecentOrders: fetcher, tokens: new Map([[PAGE, "tok-ssp"]]), gapMs: 0 }));
    assert.deepEqual(asked, [`${PAGE}|${THREAD}|tok-ssp`], "chỉ hội thoại có token page mới được hỏi, đúng một lần");
    assert.equal(result.pos.total, 2, "đơn POS ngoài kỳ không đếm");
    assert.equal(result.pos.withTracking, 1);
    assert.equal(result.pos.match.get("HINT_STRONG"), 1);
    assert.equal(result.pos.match.get("HINT_WEAK"), 1);
    assert.equal(result.pos.doubleShipmentRisk, 1, "đơn ERP đã có lượt tạo vận đơn ERP VÀ đơn POS mang mã vận đơn ⇒ rủi ro hai vận đơn");
    assert.deepEqual(result.pos.byBucket.get("VTP"), { n: 1, cod: 300_000 });
    assert.equal(result.posApi, null, "không kết nối pancake-pos-org ⇒ không gọi API POS");
    assert.equal(result.facts.posApi.status, "NOT_CONNECTED");
    const posLine = result.conclusions.find((c) => c.path === "POS_SHIPMENTS")!;
    assert.deepEqual([posLine.verdict, posLine.strength], ["POS CÓ TẠO VẬN ĐƠN", "MEASURED"]);
    assert.ok(result.facts.shipments.erpCreated >= 1);
    assert.ok(printed.some((l) => l.includes(`MẪU POS ${tag}1`) && l.includes(posCode) && l.includes("HINT_STRONG") && l.includes(`#${short}`) && l.includes("RỦI RO HAI VẬN ĐƠN")), "chi tiết (phần mã hoá) có mã POS + mã vận đơn + mã đơn ngắn");
    const summary = printed.filter((l) => l.startsWith("[ops:tom-tat]"));
    assert.ok(summary.some((l) => /KẾT LUẬN POS_SHIPMENTS: POS CÓ TẠO VẬN ĐƠN \[MEASURED\]/.test(l)), summary.join("\n"));
    assert.ok(summary.some((l) => /HINT_STRONG 1 · HINT_WEAK 1/.test(l)), summary.join("\n"));
    assert.ok(summary.some((l) => /ERP CŨNG có lượt tạo vận đơn 1/.test(l)), summary.join("\n"));
    for (const l of summary) {
      for (const leak of [PHONE, erpCode, posCode, short, `${tag}1`, THREAD, "tok-ssp"]) assert.ok(!l.includes(leak), `tóm tắt lọt «${leak}»: ${l}`);
    }
    for (const l of printed) assert.ok(!l.includes(PHONE) && !l.includes("tok-ssp"), `không in SĐT / token ở bất kỳ đâu: ${l}`);

    // --sample=0 ⇒ không gọi Pancake, POS CHƯA ĐO ĐƯỢC.
    asked.length = 0;
    const off = await capture(() => probeShippingSource(db, { orgCode: "ssp-test", isHome: false, days: 1, sample: 0, now }, { fetchRecentOrders: fetcher, tokens: new Map([[PAGE, "tok-ssp"]]), gapMs: 0 }));
    assert.equal(asked.length, 0);
    assert.equal(off.result.conclusions.find((c) => c.path === "POS_SHIPMENTS")!.strength, "UNKNOWN");
  } finally {
    if (shipIds.length) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipIds));
    await db.delete(schema.orders).where(inArray(schema.orders.id, [erpId]));
  }
}

export async function testShippingSourceProbe() {
  testPure();
  testSource();
  await testDb();
  console.log("  ✓ ops shipping-source-probe: vận đơn tạo ở đâu (ERP · POS · Viettel Post) — kết nối chở vận đơn, ERP → POS, đơn POS qua API (khoá tổ chức, handle chỉ đọc) / recent_orders mẫu, ghép LINK · HINT_STRONG · HINT_WEAK, COD khai báo theo hãng, rủi ro hai vận đơn, kết luận MEASURED / HINT / UNKNOWN; tóm tắt chỉ số đếm; chỉ đọc, khai đủ bốn chỗ");
}

if (process.argv[1] && /shipping-source-probe\.test\.ts$/.test(process.argv[1])) {
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(testShippingSourceProbe)
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
