import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  LANDING_EVIDENCE_TIERS,
  LANDING_GAP_REASONS,
  pageIdFromStoryId,
  resolveLandingAttribution,
  type AdRecord,
  type AdsetRecord,
  type CampaignByIdRecord,
  type CampaignRecord,
  type LandingTracking,
} from "@/lib/constants/landing-attribution";
import { readTracking } from "@/lib/attribution/landing";
import { rebuildFanpageAttribution } from "@/lib/attribution/fanpage";
import { listAttributionOrders } from "@/lib/queries/fanpage-attribution";

/**
 * ═══════════ QUY KẾT ĐƠN LANDING BẰNG TRACKING QUẢNG CÁO ═══════════
 *
 * Bài này khoá đúng chỗ đã làm 201 đơn landing treo trên production: chúng không mang `page_id`
 * nên rơi trọn vào nhóm "không có fanpage", trong khi form landing VẪN gửi kèm utm / ad_id.
 *
 * Luật được khoá ở đây, không cái nào được nới:
 *   · khớp phải TUYỆT ĐỐI (một khoá), không phải gần giống;
 *   · nhập nhằng ⇒ KHÔNG quy kết, không chọn bừa;
 *   · mã hàng của đơn KHÔNG bao giờ bị chiến dịch ghi đè;
 *   · đổi người phụ trách TKQC hôm nay không được viết lại đơn cũ;
 *   · chạy lại đối soát bao nhiêu lần cũng không cộng thêm lần nào.
 */

const P = "lda-";
const at = (day: number, hour = 9) => new Date(Date.UTC(2024, 7, day, hour));

const tracking = (v: Partial<LandingTracking>): LandingTracking => ({ adId: null, adsetId: null, campaignName: null, utmCampaign: null, landingUrl: null, ...v });

const AD: AdRecord = { adId: "120248142332810618", adsetId: "120248142332380618", campaignId: "camp-1", accountId: "act-777", storyId: "999000111_555" };

function lookups(over: Partial<Parameters<typeof resolveLandingAttribution>[0]> = {}) {
  const campaignByName = new Map<string, CampaignRecord>([
    ["QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3_5", { campaignName: "QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3_5", campaignIds: ["camp-2"], accountIds: ["act-777"], marketerIds: ["mkt-quan"] }],
    ["QA4_CĐ_HAI_NGUOI", { campaignName: "QA4_CĐ_HAI_NGUOI", campaignIds: ["camp-3"], accountIds: ["act-777"], marketerIds: ["mkt-quan", "mkt-trinh"] }],
    ["QA4_CĐ_CHUA_KHAI", { campaignName: "QA4_CĐ_CHUA_KHAI", campaignIds: ["camp-4"], accountIds: ["act-888"], marketerIds: [] }],
  ]);
  return {
    tracking: tracking({}),
    adById: new Map<string, AdRecord>([[AD.adId, AD]]),
    adsByAdsetId: new Map<string, AdRecord[]>([[AD.adsetId as string, [AD]]]),
    adsetById: new Map<string, AdsetRecord>(),
    campaignById: new Map<string, CampaignByIdRecord>(),
    campaignByName,
    // `camp-3` (hai người khai) và `camp-4` (chưa ai khai) CỐ Ý vắng mặt: ánh xạ này chỉ chứa
    // chiến dịch có ĐÚNG MỘT người phụ trách, đúng như truy vấn `having count(distinct …) = 1`.
    marketerOfCampaignId: new Map<string, string>([
      ["camp-1", "mkt-quan"],
      ["camp-2", "mkt-quan"],
    ]),
    knownPageIds: new Set<string>(["999000111"]),
    ...over,
  };
}

export function testLandingAttributionPure() {
  const base = lookups();

  /* ═══ CA 1 · CÓ ad_id ⇒ ra đủ TKQC · chiến dịch · marketer · fanpage ═══ */
  const ca1 = resolveLandingAttribution({ ...base, tracking: tracking({ adId: AD.adId, adsetId: AD.adsetId }) });
  assert.equal(ca1.resolved, true);
  assert.equal(ca1.tier, "AD_ID", "ad_id là bằng chứng mạnh nhất, phải được hỏi trước");
  assert.equal(ca1.marketerId, "mkt-quan");
  assert.equal(ca1.adAccountId, "act-777");
  assert.equal(ca1.campaignId, "camp-1");
  assert.equal(ca1.pageId, "999000111", "fanpage suy ra từ story_id của mẩu quảng cáo");
  assert.ok(ca1.evidence.includes(AD.adId), "kết luận phải mang theo căn cứ đọc được");

  /* ═══ CA 2 · CÓ chiến dịch + TKQC + marketer nhưng KHÔNG xác định được fanpage ═══ */
  const ca2 = resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3_5" }) });
  assert.equal(ca2.resolved, true, "thiếu fanpage KHÔNG được làm mất người phụ trách");
  assert.equal(ca2.tier, "CAMPAIGN_NAME");
  assert.equal(ca2.marketerId, "mkt-quan");
  assert.equal(ca2.adAccountId, "act-777");
  assert.equal(ca2.pageId, null, "không có bằng chứng về page ⇒ null, KHÔNG đoán một page nào");

  /* ═══ CA 3 · TÊN CHIẾN DỊCH RA HAI NGƯỜI ⇒ KHÔNG ĐOÁN ═══ */
  const ca3 = resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "QA4_CĐ_HAI_NGUOI" }) });
  assert.equal(ca3.resolved, false, "hai người cùng khai một chiến dịch là CHƯA AI QUYẾT — chọn bừa là ghi tiền của người này cho người kia");
  assert.equal(ca3.marketerId, null);
  assert.equal(ca3.gap, "AMBIGUOUS_MARKETER");

  // Chiến dịch khớp nhưng chưa ai khai người phụ trách — một lỗ hổng KHÁC, cách sửa cũng khác.
  const chuaKhai = resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "QA4_CĐ_CHUA_KHAI" }) });
  assert.equal(chuaKhai.resolved, false);
  assert.equal(chuaKhai.gap, "NO_MARKETER_DECLARED");
  assert.equal(chuaKhai.adAccountId, "act-888", "vẫn nói được TKQC — thiếu người không có nghĩa là không biết gì");

  /* ═══ MỖI LỖ HỔNG MỘT CÁI TÊN — "NO_MATCH" CHUNG LÀ CÁI TÊN KHÔNG AI SỬA ĐƯỢC ═══ */
  assert.equal(resolveLandingAttribution({ ...base, tracking: tracking({}) }).gap, "NO_TRACKING");
  assert.equal(
    resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "CHIEN_DICH_LA" }) }).gap,
    "CAMPAIGN_NOT_SYNCED",
    "tên chiến dịch không có trong bảng chi tiêu ⇒ nói thẳng là CHƯA ĐỒNG BỘ CHIẾN DỊCH, để người đọc biết phải chạy job nào",
  );
  assert.equal(
    resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "(trực tiếp)" }) }).gap,
    "NO_AD_SOURCE",
    "form tự khai khách vào thẳng ⇒ KHÔNG phải chỗ trống phải lấp, mà là câu trả lời: không thuộc ai",
  );

  /* ═══ KHỚP TUYỆT ĐỐI, KHÔNG PHẢI GẦN GIỐNG ═══ */
  assert.equal(
    resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: "QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3" }) }).gap,
    "CAMPAIGN_NOT_SYNCED",
    "thiếu đúng một hậu tố '_5' là một chiến dịch KHÁC — không được coi là cùng một cái",
  );

  /* ═══ MÃ SỐ NẰM Ở Ô "TÊN CHIẾN DỊCH" VẪN LÀ MỘT MÃ ═══

     Đây chính là ca đã làm 29 đơn treo trên production: form đổi bố cục, ghi thẳng `adset_id` vào
     `utm_source`. Coi dãy 18 chữ số ấy là một cái TÊN thì nó không bao giờ khớp cái gì. */
  const ADSET_ID = "120248121229960618";
  const CAMPAIGN_CHA = "120248121229780618";
  const chuaTra = resolveLandingAttribution({ ...base, tracking: tracking({ campaignName: ADSET_ID }) });
  assert.equal(chuaTra.gap, "META_ADSET_NOT_SYNCED", "chưa tra nhóm quảng cáo về ERP ⇒ nói đúng việc phải làm, không nói 'không khớp'");
  assert.equal(chuaTra.adsetId, ADSET_ID, "và mã ấy được ghi lại là ADSET, không phải một cái tên");

  const daTra = {
    ...base,
    adsetById: new Map<string, AdsetRecord>([[ADSET_ID, { adsetId: ADSET_ID, campaignId: CAMPAIGN_CHA, accountId: "968797992379957", missing: false }]]),
    campaignById: new Map<string, CampaignByIdRecord>([
      [CAMPAIGN_CHA, { campaignId: CAMPAIGN_CHA, campaignName: "QA4_CĐ_06/09_Q002_ĐEN_Linh Tây Luxury_4", accountIds: ["968797992379957"], marketerIds: ["mkt-quan"] }],
    ]),
  };
  const quaAdset = resolveLandingAttribution({ ...daTra, tracking: tracking({ campaignName: ADSET_ID }) });
  assert.equal(quaAdset.resolved, true, "tra được nhóm ⇒ đi tiếp lên chiến dịch cha ⇒ ra marketer");
  assert.equal(quaAdset.tier, "ADSET_ID");
  assert.equal(quaAdset.marketerId, "mkt-quan");
  assert.equal(quaAdset.campaignId, CAMPAIGN_CHA);
  assert.equal(quaAdset.adAccountId, "968797992379957");
  assert.equal(quaAdset.pageId, null, "vẫn không có bằng chứng về page — và vẫn quy kết được người");

  /* Nhóm tra được nhưng chiến dịch cha CHƯA có dòng chi tiêu nào: một lỗ hổng KHÁC, việc sửa KHÁC. */
  const thieuChiTieu = resolveLandingAttribution({
    ...daTra,
    campaignById: new Map<string, CampaignByIdRecord>(),
    tracking: tracking({ campaignName: ADSET_ID }),
  });
  assert.equal(thieuChiTieu.gap, "CAMPAIGN_NOT_SYNCED");
  assert.equal(thieuChiTieu.campaignId, CAMPAIGN_CHA, "vẫn nói được chiến dịch cha là cái nào — thiếu người không có nghĩa là không biết gì");

  /* Đã hỏi Meta và bị từ chối (`missing`) KHÁC HẲN chưa hỏi. */
  const metaTuChoi = resolveLandingAttribution({
    ...daTra,
    adsetById: new Map<string, AdsetRecord>([[ADSET_ID, { adsetId: ADSET_ID, campaignId: null, accountId: null, missing: true }]]),
    tracking: tracking({ campaignName: ADSET_ID }),
  });
  assert.equal(metaTuChoi.gap, "NO_MATCH", "hỏi rồi mà Meta không trả ⇒ hết đường, KHÔNG phải 'chưa đồng bộ'");

  /* Chính mã ấy là một campaign_id trong bảng chi tiêu. */
  const laCampaignId = resolveLandingAttribution({
    ...base,
    campaignById: new Map<string, CampaignByIdRecord>([
      [ADSET_ID, { campaignId: ADSET_ID, campaignName: "QA4_CĐ_X", accountIds: ["968797992379957"], marketerIds: ["mkt-quan"] }],
    ]),
    tracking: tracking({ campaignName: ADSET_ID }),
  });
  assert.equal(laCampaignId.tier, "CAMPAIGN_ID");
  assert.equal(laCampaignId.marketerId, "mkt-quan");

  /* ═══ adset chỉ được dùng khi cả nhóm thuộc ĐÚNG MỘT chiến dịch ═══ */
  const adsetHaiChienDich = resolveLandingAttribution({
    ...base,
    tracking: tracking({ adsetId: AD.adsetId }),
    adsByAdsetId: new Map<string, AdRecord[]>([[AD.adsetId as string, [AD, { ...AD, adId: "120248142332810619", campaignId: "camp-9" }]]]),
  });
  assert.equal(adsetHaiChienDich.resolved, false, "một adset trải trên hai chiến dịch thì nó không xác định được chiến dịch nào");

  /* ═══ FANPAGE SUY RA PHẢI CÓ THẬT TRONG SỔ ═══ */
  const pageLa = resolveLandingAttribution({ ...base, tracking: tracking({ adId: AD.adId }), knownPageIds: new Set<string>() });
  assert.equal(pageLa.pageId, null, "page suy ra mà ERP chưa từng thấy ⇒ không gán; kết luận về người vẫn giữ");
  assert.equal(pageLa.marketerId, "mkt-quan");

  assert.equal(pageIdFromStoryId("999000111_555"), "999000111");
  assert.equal(pageIdFromStoryId("khong-phai-story"), null, "chuỗi lạ ⇒ null, không cắt bừa");
  assert.equal(pageIdFromStoryId(null), null);

  /* ═══ ĐỌC Ô TRACKING: ba bố cục sheet, một cách đọc ═══ */
  const bocucMoi = readTracking({ "Cột 16": "120248142332380618", "Cột 17": "120248142332810618", "Cột 15": "Quảng cáo Lượt tương tác mới TXT", "Cột 13": "QA4_CĐ_Q002_Đ_04/09_Linh Tây Luxury_8" });
  assert.equal(bocucMoi.adId, "120248142332810618");
  assert.equal(bocucMoi.adsetId, "120248142332380618");
  assert.equal(bocucMoi.campaignName, "QA4_CĐ_Q002_Đ_04/09_Linh Tây Luxury_8");
  const bocucCoTieuDe = readTracking({ utm_source: "QA4_CĐ_X_03/09_Q003_Hải An Fashion_6", utm_term: "QA4_CĐ_08/09_Q003_ĐỎ_Hải An Luxury CS3_5", utm_campaign: "Quảng cáo Lượt tương tác mới TXT" });
  assert.equal(bocucCoTieuDe.campaignName, "QA4_CĐ_X_03/09_Q003_Hải An Fashion_6");
  assert.equal(
    bocucCoTieuDe.adId,
    null,
    "`utm_term` chứa TÊN chiến dịch chứ không phải id — tin vào cái tên ô là tự dựng một bằng chứng không tồn tại",
  );
  assert.equal(readTracking({ utm_source: "  " }).campaignName, null, "ô toàn khoảng trắng là KHÔNG CÓ, không phải chuỗi rỗng");

  console.log("✓ Quy kết landing: ad_id > adset > tên chiến dịch khớp tuyệt đối · nhập nhằng KHÔNG đoán · thiếu page vẫn ra người · ba bố cục sheet một cách đọc");
}

/**
 * ĐƯỜNG THẬT, TRÊN CSDL: đơn landing không có `page_id` phải ra khỏi nhóm "không có fanpage",
 * đơn Messenger không được đụng tới, và chạy lại không được đổi gì.
 */
export async function testLandingAttributionDb() {
  const db = await getDb();

  await db
    .insert(schema.adSpends)
    .values([
      { id: `${P}spend-1`, platform: "Facebook", campaign: `${P}QA4_CĐ_10/08_Q003_Hải An Fashion_1`, campaignId: `${P}camp-1`, accountId: `${P}act-1`, marketerId: `${P}mkt-quan`, spend: 500_000, spendDate: at(10) },
      { id: `${P}spend-2`, platform: "Facebook", campaign: `${P}QA4_CĐ_HAI_NGUOI`, campaignId: `${P}camp-2`, accountId: `${P}act-1`, marketerId: `${P}mkt-quan`, spend: 100_000, spendDate: at(10) },
      { id: `${P}spend-3`, platform: "Facebook", campaign: `${P}QA4_CĐ_HAI_NGUOI`, campaignId: `${P}camp-2`, accountId: `${P}act-1`, marketerId: `${P}mkt-trinh`, spend: 100_000, spendDate: at(11) },
    ])
    .onConflictDoNothing();

  // Đơn landing: KHÔNG có page_id, nhưng dòng landing mang tên chiến dịch khớp tuyệt đối.
  await db
    .insert(schema.orders)
    .values([
      { id: `${P}o-landing`, stage: "CONFIRMED", insertedAt: at(12), shipPhone: "0913000001", shipFullName: "Khách LD", shipFullAddress: "1 LD", totalPriceAfterDiscount: 499_000, source: "Web" },
      { id: `${P}o-mo-ho`, stage: "CONFIRMED", insertedAt: at(13), shipPhone: "0913000002", shipFullName: "Khách MH", shipFullAddress: "2 MH", totalPriceAfterDiscount: 499_000, source: "Web" },
      { id: `${P}o-tay`, stage: "CONFIRMED", insertedAt: at(14), shipPhone: "0913000003", shipFullName: "Khách Tay", shipFullAddress: "3 Tay", totalPriceAfterDiscount: 499_000, source: "Web" },
    ])
    .onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values([
      { id: `${P}o-landing-i0`, orderId: `${P}o-landing`, sku: "LDA-Q004", productName: "LDA Q004", quantity: 1, unitPrice: 499_000 },
      { id: `${P}o-mo-ho-i0`, orderId: `${P}o-mo-ho`, sku: "LDA-Q004", productName: "LDA Q004", quantity: 1, unitPrice: 499_000 },
      { id: `${P}o-tay-i0`, orderId: `${P}o-tay`, sku: "LDA-Q004", productName: "LDA Q004", quantity: 1, unitPrice: 499_000 },
    ])
    .onConflictDoNothing();
  await db
    .insert(schema.landingOrders)
    .values([
      {
        id: `${P}l1`,
        rowKey: `${P}gid:1`,
        orderId: `${P}o-landing`,
        submittedAt: at(12, 8),
        phone: "0913000001",
        // Chiến dịch nói Q003; đơn thật là Q004 — CA 4.
        raw: { utm_source: `${P}QA4_CĐ_10/08_Q003_Hải An Fashion_1`, utm_campaign: "Quảng cáo Lượt tương tác mới TXT", "Link landing": "https://haianluxury.click/q003/?utm_source=x" },
      },
      { id: `${P}l2`, rowKey: `${P}gid:2`, orderId: `${P}o-mo-ho`, submittedAt: at(13, 8), phone: "0913000002", raw: { utm_source: `${P}QA4_CĐ_HAI_NGUOI` } },
    ])
    .onConflictDoNothing();

  await rebuildFanpageAttribution({ db });
  clearMemo();
  const quyKet = async (id: string) => (await db.select().from(schema.orderAttributions).where(eq(schema.orderAttributions.orderId, id)).limit(1))[0];
  const landing = async (id: string) => (await db.select().from(schema.landingAttributions).where(eq(schema.landingAttributions.orderId, id)).limit(1))[0];

  /* ═══ CA 1 + 2 · ĐƠN LANDING RA KHỎI NHÓM "KHÔNG CÓ FANPAGE" ═══ */
  const d1 = await quyKet(`${P}o-landing`);
  assert.equal(d1?.status, "ATTRIBUTED", "đơn landing có bằng chứng tracking KHÔNG được nằm trong NO_PAGE nữa");
  assert.equal(d1?.marketerId, `${P}mkt-quan`);
  assert.equal(d1?.attributionSource, "LANDING_UTM", "và phải nói rõ nó đi bằng đường nào");
  assert.equal(d1?.sourcePageId, null, "page_id của Pancake KHÔNG được giả mạo — đơn này vốn không có");
  assert.equal(d1?.attributedPageId, null, "không có bằng chứng về page ⇒ để trống, đó là câu trả lời đúng");

  /* ═══ CA 4 · CHIẾN DỊCH NÓI MỘT MÃ, ĐƠN LÀ MÃ KHÁC ⇒ GIỮ MÃ CỦA ĐƠN, ĐÁNH DẤU ═══ */
  const ev1 = await landing(`${P}o-landing`);
  assert.equal(ev1?.tier, "CAMPAIGN_NAME");
  assert.equal(ev1?.adAccountId, `${P}act-1`, "TKQC đọc từ chính bảng chi tiêu của chiến dịch ấy");
  assert.ok((ev1?.evidence ?? "").length > 0, "kết luận phải kèm câu căn cứ");
  assert.equal(ev1?.campaignProductCode, "Q003", "chiến dịch nói Q003");
  assert.equal(ev1?.productMismatch, true, "đơn thật là mã khác ⇒ ĐÁNH DẤU để rà");
  const dongHang = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, `${P}o-landing`));
  assert.equal(dongHang[0]?.sku, "LDA-Q004", "và mã hàng của ĐƠN tuyệt đối không bị chiến dịch ghi đè");

  /* ═══ CA 3 · NHẬP NHẰNG THÌ KHÔNG QUY KẾT ═══ */
  const d2 = await quyKet(`${P}o-mo-ho`);
  assert.equal(d2?.status, "NO_PAGE", "chiến dịch hai người ⇒ vẫn chưa quy kết được");
  assert.equal(d2?.marketerId, null, "và tuyệt đối không mang tên ai");
  assert.equal((await landing(`${P}o-mo-ho`))?.gap, "AMBIGUOUS_MARKETER", "nhưng phải nói được vì sao, để có cái mà sửa");

  // Đơn không có dòng landing nào: không có gì để quy kết, và cũng không có dòng bằng chứng nào.
  const d3 = await quyKet(`${P}o-tay`);
  assert.equal(d3?.status, "NO_PAGE");
  assert.equal(await landing(`${P}o-tay`), undefined, "đơn không đi đường landing thì KHÔNG dựng một dòng bằng chứng rỗng");

  /* ═══ CA 6 · CHẠY LẠI KHÔNG ĐỔI GÌ, KHÔNG NHÂN ĐÔI ═══ */
  const lan2 = await rebuildFanpageAttribution({ db });
  clearMemo();
  assert.equal(lan2.changed, 0, "chạy lại trên cùng dữ liệu phải KHÔNG đổi dòng nào — đó là phép thử idempotent");
  assert.equal(lan2.landing.changed, 0, "ảnh chụp bằng chứng landing cũng vậy");
  const demDong = await db.select().from(schema.landingAttributions).where(eq(schema.landingAttributions.orderId, `${P}o-landing`));
  assert.equal(demDong.length, 1, "MỘT đơn MỘT dòng — không có đường nào cộng doanh thu hai lần");

  /* ═══ BỘ LỌC "ĐƠN LANDING" PHẢI GOM ĐƯỢC CẢ ĐÃ QUY KẾT LẪN CÒN TREO ═══

     Gộp nguồn vào ô "Tình trạng" thì không cách nào xem hết đơn landing trong một lần — người đi
     rà kênh phải mở hai lần rồi tự cộng. */
  const ky = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null } as const;
  const thamSo = { period: ky, page: 1, pageSize: 100, sort: "sourceOrderAt", dir: "desc" as const, q: "", filters: {} };
  const locLanding = await listAttributionOrders(thamSo, { source: "LANDING" });
  const idLanding = new Set(locLanding.rows.map((r) => r.orderId));
  assert.ok(idLanding.has(`${P}o-landing`), "lọc Landing phải gồm đơn ĐÃ quy kết bằng tracking");
  assert.ok(idLanding.has(`${P}o-mo-ho`), "và cả đơn landing CÒN TREO — đó mới là cái người đi rà cần thấy");
  assert.ok(!idLanding.has(`${P}o-tay`), "đơn không có form landing thì không lọt vào");
  const locDaQuyKet = await listAttributionOrders(thamSo, { source: "LANDING_UTM" });
  assert.ok(locDaQuyKet.rows.some((r) => r.orderId === `${P}o-landing`) && !locDaQuyKet.rows.some((r) => r.orderId === `${P}o-mo-ho`), "lọc 'đã quy kết' chỉ ra đơn đã có người");
  const locConTreo = await listAttributionOrders(thamSo, { source: "LANDING_UNRESOLVED" });
  assert.ok(locConTreo.rows.some((r) => r.orderId === `${P}o-mo-ho`) && !locConTreo.rows.some((r) => r.orderId === `${P}o-landing`), "lọc 'còn treo' chỉ ra đơn chưa có người");

  // Dòng đơn phải mang đủ bằng chứng để màn hình in được cả chuỗi ad → chiến dịch → TKQC → MKTer.
  const dongLanding = locDaQuyKet.rows.find((r) => r.orderId === `${P}o-landing`);
  assert.equal(dongLanding?.attributionSource, "LANDING_UTM");
  assert.equal(dongLanding?.landing?.tier, "CAMPAIGN_NAME");
  assert.equal(dongLanding?.landing?.adAccountId, `${P}act-1`);
  assert.equal(dongLanding?.landing?.productMismatch, true);
  assert.equal(dongLanding?.pageId, null, "và Page vẫn để trống — màn hình in “Không xác định”, KHÔNG bịa một Page ID");

  /* ═══ CA 5 · TKQC / CHIẾN DỊCH ĐỔI NGƯỜI PHỤ TRÁCH ⇒ ĐƠN CŨ GIỮ NGƯỜI CŨ ═══

     Đây là ca quan trọng nhất của cả bài. `ad_spends.marketer_id` là SỔ KHAI HIỆN HÀNH — chủ shop
     sửa hôm nay là ô ấy đổi ngay. Nếu đối soát tính lại từ đầu mỗi lượt thì đơn tháng trước đổi
     chủ theo, và một kỳ đã trả tiền tự viết lại chính nó. Kết luận đã chụp phải ĐỨNG YÊN. */
  await db.update(schema.adSpends).set({ marketerId: `${P}mkt-trinh` }).where(eq(schema.adSpends.id, `${P}spend-1`));
  const lan3 = await rebuildFanpageAttribution({ db });
  clearMemo();
  const d1Sau = await quyKet(`${P}o-landing`);
  assert.equal(d1Sau?.marketerId, `${P}mkt-quan`, "đổi người phụ trách chiến dịch HÔM NAY không được viết lại quy kết của đơn CŨ");
  assert.equal((await landing(`${P}o-landing`))?.marketerId, `${P}mkt-quan`, "ảnh chụp bằng chứng cũng đứng yên");
  assert.equal(lan3.changed, 0, "và không dòng nào bị đổi — đối soát lại KHÔNG phải một lượt viết lại lịch sử");

  // Đơn CHƯA quy kết được thì vẫn hỏi lại sổ mỗi lượt: khai người phụ trách xong là nó quy kết được.
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, `${P}spend-3`));
  await rebuildFanpageAttribution({ db });
  clearMemo();
  assert.equal((await quyKet(`${P}o-mo-ho`))?.marketerId, `${P}mkt-quan`, "hết nhập nhằng thì đơn đang treo phải quy kết được ngay ở lượt sau");
  await db.update(schema.adSpends).set({ marketerId: `${P}mkt-quan` }).where(eq(schema.adSpends.id, `${P}spend-1`));

  /* ═══ DANH SÁCH Ở CSDL PHẢI ĐI CÙNG DANH SÁCH Ở MÃ NGUỒN ═══

     SỰ CỐ THẬT (15/09/2026): mã nguồn thêm lý do treo mới, ràng buộc CHECK của 0091 thì không —
     và lượt đối soát trên production hỏng NGUYÊN LƯỢT GHI ở dòng đầu tiên mang lý do mới. Bộ kiểm
     thử cũ không bắt được vì mọi ca thử chỉ sinh ra giá trị CŨ.

     Nên ở đây ghi THỬ TỪNG giá trị trong cả hai danh sách xuống CSDL. Thêm một lý do mà quên nới
     ràng buộc thì bài này đỏ ngay trên máy người viết, không đợi tới production. */
  for (const reason of LANDING_GAP_REASONS) {
    await db
      .insert(schema.landingAttributions)
      .values({ id: `${P}gap-${reason}`, orderId: `${P}o-tay`, gap: reason })
      .onConflictDoUpdate({ target: schema.landingAttributions.orderId, set: { gap: reason, marketerId: null, tier: null, evidence: "" } });
  }
  for (const tier of LANDING_EVIDENCE_TIERS) {
    await db
      .insert(schema.landingAttributions)
      .values({ id: `${P}tier-${tier}`, orderId: `${P}o-tay`, tier, marketerId: `${P}mkt-quan`, evidence: `thử bậc ${tier}` })
      .onConflictDoUpdate({ target: schema.landingAttributions.orderId, set: { tier, marketerId: `${P}mkt-quan`, evidence: `thử bậc ${tier}`, gap: null } });
  }
  await db.delete(schema.landingAttributions).where(eq(schema.landingAttributions.orderId, `${P}o-tay`));
  console.log(`✓ CSDL nhận đủ ${LANDING_GAP_REASONS.length} lý do treo và ${LANDING_EVIDENCE_TIERS.length} bậc bằng chứng đang khai trong mã nguồn`);

  console.log("✓ Landing trên CSDL: đơn có bằng chứng ra khỏi NO_PAGE · nhập nhằng giữ nguyên · mã hàng của đơn bất khả xâm phạm · chạy lại không đổi gì · lọc riêng được kênh Landing");
}
