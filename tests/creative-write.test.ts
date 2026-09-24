import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { ADS_WRITE_KILL_KEY } from "@/lib/constants/ads-kill-switch";
import { CREATIVE_HARD_LIMITS, DEFAULT_CREATIVE_CONFIG, type CreativeLoopConfig, type CreativeRule, type CreativeWriteDenial } from "@/lib/constants/creative-loop";
import { shiftDay } from "@/lib/constants/marketing-decision-ledger";
import type { TemplateAd } from "@/lib/integrations/facebook/ads-write";
import { gateCreativeWrite, type CreativeGateInput } from "@/lib/marketing/creative-write-gate";
import { approvalDigest, batchTicket, verifyBatchTicket, type ApprovalContent } from "@/lib/creative/approval";
import { storeCreativeImage } from "@/lib/creative/images";
import { applyKills, batchApprovalContent, publishApprovedBatches, type CreativeWriteEnv, type CreativeWriter } from "@/lib/creative/publish";
import { batchWindow } from "@/lib/creative/schedule";
import { buildObjectStorySpec } from "@/lib/creative/story-spec";

/**
 * ═══════════ BÀN TAY CỦA VÒNG MẪU — HÀNG RÀO PHẢI ĐÚNG TRƯỚC KHI CÓ TIỀN ĐI QUA ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §2–§3. Mẫu: `tests/ads-write.test.ts`.
 *
 *  (a) BẢNG CHÂN LÝ của cổng, kể cả THỨ TỰ các chốt.
 *  (b) BÀI QUẢNG CÁO chép từ mẫu: chỉ thay bốn thứ, kiểu lạ bị từ chối.
 *  (c) PHIẾU DUYỆT: digest ổn định với thứ tự mẫu, đổi một ký tự là đổi.
 *  (d) LUỒNG ĐĂNG trên PGlite với cửa ghi GIẢ — không một lời gọi Facebook thật nào.
 *  (e) TẮT THEO LUẬT: luật không có trong ảnh chụp lô thì không tắt.
 *  (f) MỨC MÃ NGUỒN: mọi lời gọi đi qua cửa ghi duy nhất.
 *
 * Mốc thời gian dựng TỪ `batchWindow()` của chính lô (AGENTS.md mục 50): mã đăng chỉ đọc `now` được
 * truyền vào, không đọc đồng hồ thật, nên "trước giờ chạy" và "sau giờ chạy" là hai mốc suy từ cửa sổ.
 */

const KILL: CreativeRule = { metric: "messages", op: "lt", value: 1, minSpendVnd: 100_000, label: "Tiêu 100K không có tin nhắn" };
const KILL_LA: CreativeRule = { metric: "cpm", op: "gt", value: 90_000, minSpendVnd: 50_000, label: "Luật chưa ai duyệt" };
const BUDGET = CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd;
const START = new Date("2031-05-10T06:00:00+07:00");

function gin(over: Partial<CreativeGateInput> = {}): CreativeGateInput {
  return {
    hardEnabled: true,
    mode: "COPILOT",
    action: "CREATE_ADSET",
    configComplete: true,
    approved: true,
    approvalMatches: true,
    testCampaignId: "camp-test",
    targetCampaignId: "camp-test",
    templateCampaignId: "camp-test",
    ourAdset: false,
    now: new Date(START.getTime() - 3_600_000),
    startAt: START,
    budgetPerVariantVnd: BUDGET,
    publishedInBatch: 0,
    batchSize: CREATIVE_HARD_LIMITS.maxBatchSize,
    committedDayVnd: 0,
    variantHasAdset: false,
    pauseKind: null,
    killRuleFired: false,
    promising: false,
    extensionVnd: 0,
    extendedTodayVnd: 0,
    ...over,
  };
}

function denialOf(i: CreativeGateInput): CreativeWriteDenial | "OK" {
  const r = gateCreativeWrite(i);
  return r.ok ? "OK" : r.denial;
}

/** Bỏ chú thích trước khi quét mã nguồn. */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function testCreativeWrite() {
  // ═══════════ (a) BẢNG CHÂN LÝ CỦA CỔNG ═══════════

  assert.equal(denialOf(gin()), "OK", "đủ điều kiện thì phải cho tạo nhóm");

  const truth: { name: string; over: Partial<CreativeGateInput>; denial: CreativeWriteDenial }[] = [
    { name: "chốt cứng env tắt", over: { hardEnabled: false }, denial: "HARD_DISABLED" },
    { name: "nấc OFF", over: { mode: "OFF" }, denial: "MODE_OFF" },
    { name: "khai AUTO cũng không phải COPILOT", over: { mode: "AUTO" }, denial: "MODE_OFF" },
    { name: "cấu hình thiếu", over: { configComplete: false }, denial: "CONFIG_INCOMPLETE" },
    { name: "lô chưa duyệt", over: { approved: false }, denial: "NOT_APPROVED" },
    { name: "nội dung đổi sau khi duyệt", over: { approvalMatches: false }, denial: "APPROVAL_MISMATCH" },
    { name: "tạo nhóm vào chiến dịch khác", over: { targetCampaignId: "camp-cua-marketer" }, denial: "WRONG_CAMPAIGN" },
    { name: "tạo nhóm không rõ chiến dịch", over: { targetCampaignId: null }, denial: "WRONG_CAMPAIGN" },
    { name: "mẩu mẫu nằm ở chiến dịch khác", over: { templateCampaignId: "camp-cua-marketer" }, denial: "WRONG_CAMPAIGN" },
    { name: "không đọc được chiến dịch của mẩu mẫu", over: { templateCampaignId: null }, denial: "WRONG_CAMPAIGN" },
    { name: "đúng giờ chạy là đã muộn", over: { now: START }, denial: "TOO_LATE" },
    { name: "ngân sách một mẫu vượt trần", over: { budgetPerVariantVnd: BUDGET + 1 }, denial: "OVER_VARIANT_BUDGET" },
    { name: "ngân sách một mẫu bằng 0", over: { budgetPerVariantVnd: 0 }, denial: "OVER_VARIANT_BUDGET" },
    { name: "lô đã đủ mẫu", over: { publishedInBatch: CREATIVE_HARD_LIMITS.maxBatchSize }, denial: "OVER_BATCH_SIZE" },
    { name: "cấu hình lô hẹp hơn trần", over: { batchSize: 3, publishedInBatch: 3 }, denial: "OVER_BATCH_SIZE" },
    { name: "vượt trần tiền ngày một đồng", over: { committedDayVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd - BUDGET + 1 }, denial: "OVER_DAILY_CAP" },
    { name: "tải ảnh cho mẫu sẽ vượt trần ngày", over: { action: "UPLOAD_IMAGE", committedDayVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd }, denial: "OVER_DAILY_CAP" },
    { name: "tắt nhóm không do vòng tạo", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: false, pauseKind: "HUMAN" }, denial: "NOT_OUR_AD" },
    { name: "máy tắt mà không luật nào kích hoạt", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "KILL_RULE" }, denial: "NO_KILL_RULE" },
    { name: "máy tắt không khai căn cứ = coi như tắt theo luật", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: null }, denial: "NO_KILL_RULE" },
    { name: "tiêu thêm mẫu không hứa hẹn", over: { action: "EXTEND_ADSET", targetCampaignId: null, ourAdset: true, extensionVnd: 100_000 }, denial: "NOT_PROMISING" },
    { name: "tiêu thêm quá trần một lượt", over: { action: "EXTEND_ADSET", targetCampaignId: null, ourAdset: true, promising: true, extensionVnd: CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd + 1 }, denial: "OVER_EXTENSION_CAP" },
    {
      name: "tiêu thêm quá trần cả ngày",
      over: { action: "EXTEND_ADSET", targetCampaignId: null, ourAdset: true, promising: true, extensionVnd: 200_000, extendedTodayVnd: CREATIVE_HARD_LIMITS.maxDailyExtensionVnd - 199_999 },
      denial: "OVER_EXTENSION_CAP",
    },
    { name: "tiêu thêm số không hợp lệ", over: { action: "EXTEND_ADSET", targetCampaignId: null, ourAdset: true, promising: true, extensionVnd: 0 }, denial: "OVER_EXTENSION_CAP" },
    { name: "người tắt tay mà chưa bấm", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "HUMAN", approved: false }, denial: "NOT_APPROVED" },
  ];
  for (const t of truth) {
    const r = gateCreativeWrite(gin(t.over));
    assert.equal(r.ok ? "OK" : r.denial, t.denial, `${t.name}: sai mã chặn`);
    assert.ok(!r.ok && r.reason.length > 10, `${t.name}: lý do phải đọc được`);
  }

  // Những lượt PHẢI qua — cổng không được chặn thừa.
  const phaiQua: { name: string; over: Partial<CreativeGateInput> }[] = [
    { name: "bằng đúng trần tiền ngày", over: { committedDayVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd - BUDGET } },
    // Mẫu đã có nhóm: tiền đã tính lúc tạo nhóm; bước tạo mẩu không được đếm lại dù sổ đã chạm trần.
    { name: "tạo mẩu cho mẫu đã có nhóm", over: { action: "CREATE_AD", variantHasAdset: true, committedDayVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd, publishedInBatch: 10, targetCampaignId: null } },
    { name: "máy tắt theo luật đã kích hoạt", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "KILL_RULE", killRuleFired: true } },
    { name: "người tắt tay không cần luật", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "HUMAN" } },
    { name: "dọn nhóm đăng dở không cần luật", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "CLEANUP" } },
    // Tắt chỉ làm GIẢM tiền: không trần tiền nào, không giờ chạy nào chặn nó.
    { name: "tắt sau giờ chạy, sổ đã chạm trần", over: { action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: true, pauseKind: "HUMAN", now: new Date(START.getTime() + 3_600_000), committedDayVnd: 9_999_999 } },
    { name: "tiêu thêm đúng trần một lượt", over: { action: "EXTEND_ADSET", targetCampaignId: null, ourAdset: true, promising: true, extensionVnd: CREATIVE_HARD_LIMITS.maxExtensionPerClickVnd } },
  ];
  for (const t of phaiQua) assert.equal(denialOf(gin(t.over)), "OK", `${t.name}: phải qua`);

  /*
    ─── THỨ TỰ CÁC CHỐT ───

    Dựng một lượt tạo nhóm SAI Ở MỌI CHỖ, rồi sửa từng chỗ từ trên xuống: mã chặn phải lần lượt đi
    đúng thứ tự đã chốt. Một ngày có người xếp chốt env xuống sau phiếu duyệt thì chuỗi này lệch ngay
    ở bước đầu, và câu "không tổ hợp cấu hình nào lỡ tiêu tiền thật" thôi là "không" mà thành "tuỳ".
  */
  const tatCaSai: Partial<CreativeGateInput> = {
    hardEnabled: false,
    mode: "OFF",
    configComplete: false,
    approved: false,
    approvalMatches: false,
    targetCampaignId: "khac",
    templateCampaignId: "khac",
    now: START,
    budgetPerVariantVnd: BUDGET * 5,
    publishedInBatch: 10,
    committedDayVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd,
  };
  const suaLanLuot: { sua: Partial<CreativeGateInput>; ke: CreativeWriteDenial | "OK" }[] = [
    { sua: {}, ke: "HARD_DISABLED" },
    { sua: { hardEnabled: true }, ke: "MODE_OFF" },
    { sua: { mode: "COPILOT" }, ke: "CONFIG_INCOMPLETE" },
    { sua: { configComplete: true }, ke: "NOT_APPROVED" },
    { sua: { approved: true }, ke: "APPROVAL_MISMATCH" },
    { sua: { approvalMatches: true }, ke: "WRONG_CAMPAIGN" },
    { sua: { targetCampaignId: "camp-test" }, ke: "WRONG_CAMPAIGN" },
    { sua: { templateCampaignId: "camp-test" }, ke: "TOO_LATE" },
    { sua: { now: new Date(START.getTime() - 60_000) }, ke: "OVER_VARIANT_BUDGET" },
    { sua: { budgetPerVariantVnd: BUDGET }, ke: "OVER_BATCH_SIZE" },
    { sua: { publishedInBatch: 0 }, ke: "OVER_DAILY_CAP" },
    { sua: { committedDayVnd: 0 }, ke: "OK" },
  ];
  let dang: Partial<CreativeGateInput> = { ...tatCaSai };
  for (const [k, b] of suaLanLuot.entries()) {
    dang = { ...dang, ...b.sua };
    assert.equal(denialOf(gin(dang)), b.ke, `thứ tự chốt (tạo nhóm), bước ${k}: mong ${b.ke}`);
  }

  // Tiêu thêm: NOT_OUR_AD → NOT_PROMISING → OVER_EXTENSION_CAP, và phiếu đứng trước chiến dịch.
  let them: Partial<CreativeGateInput> = { action: "EXTEND_ADSET", approvalMatches: false, targetCampaignId: "khac", ourAdset: false, promising: false, extensionVnd: 10_000_000 };
  const thuTuThem: [Partial<CreativeGateInput>, CreativeWriteDenial | "OK"][] = [
    [{}, "APPROVAL_MISMATCH"],
    [{ approvalMatches: true }, "WRONG_CAMPAIGN"],
    [{ targetCampaignId: null }, "NOT_OUR_AD"],
    [{ ourAdset: true }, "NOT_PROMISING"],
    [{ promising: true }, "OVER_EXTENSION_CAP"],
    [{ extensionVnd: 100_000 }, "OK"],
  ];
  for (const [sua, ke] of thuTuThem) {
    them = { ...them, ...sua };
    assert.equal(denialOf(gin(them)), ke, `thứ tự chốt (tiêu thêm): mong ${ke}`);
  }
  // Tắt theo luật: nhóm của ai hỏi TRƯỚC luật nào.
  assert.equal(denialOf(gin({ action: "PAUSE_ADSET", targetCampaignId: null, ourAdset: false, pauseKind: "KILL_RULE" })), "NOT_OUR_AD");
  // Chốt env thắng MỌI hành động, kể cả tắt.
  for (const action of ["UPLOAD_IMAGE", "CREATE_CREATIVE", "CREATE_ADSET", "CREATE_AD", "PAUSE_ADSET", "EXTEND_ADSET"] as const) {
    assert.equal(denialOf(gin({ action, hardEnabled: false, approved: false, ourAdset: false })), "HARD_DISABLED", `${action}: chốt env phải đứng đầu`);
  }

  // ═══════════ (b) BÀI QUẢNG CÁO CHÉP TỪ MẪU ═══════════

  const mauLink = {
    page_id: "page-khac",
    instagram_user_id: "ig-1",
    link_data: {
      link: "https://m.me/shop",
      message: "câu cũ",
      name: "tiêu đề cũ",
      picture: "https://anh-cu.jpg",
      image_url: "https://anh-cu-2.jpg",
      image_hash: "hash-cu",
      image_crops: { "191x100": [[0, 0], [100, 50]] },
      child_attachments: [],
      call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } },
    },
  };
  const noiDung = { pageId: "page-cua-shop", imageHash: "hash-moi", primaryText: "Váy lụa mới về", headline: "Giảm 20% hôm nay" };
  const link = buildObjectStorySpec(mauLink, noiDung);
  assert.ok(link.ok && link.kind === "link_data", "link_data phải được hỗ trợ");
  if (link.ok) {
    const ld = link.spec.link_data as Record<string, unknown>;
    assert.equal(link.spec.page_id, "page-cua-shop", "page_id BỊ ÉP về fanpage của cấu hình");
    assert.equal(ld.image_hash, "hash-moi");
    assert.equal(ld.message, "Váy lụa mới về");
    assert.equal(ld.name, "Giảm 20% hôm nay");
    for (const k of ["picture", "image_url", "child_attachments", "image_crops"]) assert.ok(!(k in ld), `link_data phải bỏ ${k} của ảnh cũ`);
    assert.deepEqual(ld.call_to_action, mauLink.link_data.call_to_action, "nút kêu gọi chép NGUYÊN");
    assert.equal(ld.link, "https://m.me/shop", "đường dẫn chép NGUYÊN");
    assert.equal(link.spec.instagram_user_id, "ig-1");
  }
  assert.equal(mauLink.link_data.message, "câu cũ", "không được sửa vào đối tượng mẫu của nơi gọi");
  assert.equal(mauLink.page_id, "page-khac");

  const photo = buildObjectStorySpec({ page_id: "x", photo_data: { url: "https://anh-cu.jpg", caption: "cũ", image_hash: "h0" } }, noiDung);
  assert.ok(photo.ok && photo.kind === "photo_data");
  if (photo.ok) {
    const pd = photo.spec.photo_data as Record<string, unknown>;
    assert.equal(photo.spec.page_id, "page-cua-shop");
    assert.equal(pd.image_hash, "hash-moi");
    assert.equal(pd.caption, "Váy lụa mới về");
    assert.ok(!("url" in pd), "photo_data phải bỏ url ảnh cũ");
  }

  const tuChoi: [string, unknown][] = [
    ["video", { page_id: "x", video_data: { video_id: "v1" } }],
    ["băng chuyền", { page_id: "x", link_data: { link: "https://a", child_attachments: [{ link: "https://a" }, { link: "https://b" }] } }],
    ["template_data", { page_id: "x", template_data: {} }],
    ["không có gì", { page_id: "x" }],
    ["không đọc được", null],
  ];
  for (const [ten, mau] of tuChoi) {
    const r = buildObjectStorySpec(mau, noiDung);
    assert.equal(r.ok, false, `${ten}: phải bị từ chối, không đoán`);
    assert.ok(!r.ok && r.error.includes("không được hỗ trợ"), `${ten}: lý do phải nói rõ "không được hỗ trợ"`);
  }
  assert.equal(buildObjectStorySpec(mauLink, { ...noiDung, imageHash: "" }).ok, false, "thiếu image_hash thì không dựng bài");

  // ═══════════ (c) PHIẾU DUYỆT ═══════════

  const noiDungLo: ApprovalContent = {
    batchDay: "2031-05-10",
    startAt: START,
    endAt: new Date(START.getTime() + 86_400_000),
    budgetPerVariantVnd: BUDGET,
    killRules: [KILL],
    variants: [
      { id: "v-a", imageSha256: "aa", primaryText: "Câu A", headline: "Tiêu đề A" },
      { id: "v-b", imageSha256: "bb", primaryText: "Câu B", headline: "Tiêu đề B" },
    ],
  };
  const goc = approvalDigest(noiDungLo);
  assert.match(goc, /^[0-9a-f]{64}$/, "digest là sha256 hex");
  assert.equal(approvalDigest({ ...noiDungLo, variants: [...noiDungLo.variants].reverse() }), goc, "digest KHÔNG đổi theo thứ tự mẫu");
  const doiMot: [string, ApprovalContent][] = [
    ["một ký tự câu chữ", { ...noiDungLo, variants: [{ ...noiDungLo.variants[0], primaryText: "Câu A." }, noiDungLo.variants[1]] }],
    ["tiêu đề", { ...noiDungLo, variants: [{ ...noiDungLo.variants[0], headline: "Tiêu đề a" }, noiDungLo.variants[1]] }],
    ["băm ảnh", { ...noiDungLo, variants: [{ ...noiDungLo.variants[0], imageSha256: "ab" }, noiDungLo.variants[1]] }],
    ["ngân sách", { ...noiDungLo, budgetPerVariantVnd: BUDGET - 1 }],
    ["giờ bắt đầu", { ...noiDungLo, startAt: new Date(START.getTime() + 60_000) }],
    ["giờ kết thúc", { ...noiDungLo, endAt: new Date(START.getTime() + 2 * 86_400_000) }],
    ["ngưỡng luật tắt", { ...noiDungLo, killRules: [{ ...KILL, value: 2 }] }],
    ["bỏ luật tắt", { ...noiDungLo, killRules: [] }],
    ["ngày chạy", { ...noiDungLo, batchDay: "2031-05-11" }],
    ["gạt một mẫu", { ...noiDungLo, variants: [noiDungLo.variants[0]] }],
  ];
  for (const [ten, c] of doiMot) assert.notEqual(approvalDigest(c), goc, `đổi ${ten} ⇒ digest phải khác`);

  const phieu = batchTicket("user-1", "lo-1", goc);
  assert.equal(verifyBatchTicket(phieu, "user-1", "lo-1", goc), true);
  assert.equal(verifyBatchTicket(phieu, "user-2", "lo-1", goc), false, "không ai duyệt hộ người khác");
  assert.equal(verifyBatchTicket(phieu, "user-1", "lo-2", goc), false, "phiếu của lô này không dùng cho lô khác");
  assert.equal(verifyBatchTicket(phieu, "user-1", "lo-1", approvalDigest(doiMot[0][1])), false, "nội dung đổi ⇒ phiếu cũ vô hiệu");

  // ═══════════ (f) MỨC MÃ NGUỒN ═══════════

  for (const tep of ["lib/creative/publish.ts", "lib/actions/creative.ts", "lib/marketing/creative-write-gate.ts", "lib/creative/story-spec.ts", "lib/creative/approval.ts"]) {
    const src = boChuThich(readFileSync(tep, "utf8"));
    assert.ok(!src.includes("graph.facebook.com"), `${tep} không được nhắc tới Graph API — mọi lời gọi đi qua lib/integrations/facebook/ads-write.ts`);
    assert.ok(!src.includes("fetch("), `${tep} không được tự gọi mạng`);
  }
  // Cửa ghi vẫn chỉ có HAI chỗ chạm mạng: graphGet và graphPost. Hàm mới nào tự gọi fetch là lách chốt env.
  const cuaGhi = boChuThich(readFileSync("lib/integrations/facebook/ads-write.ts", "utf8"));
  assert.equal(cuaGhi.match(/fetchJson\(/g)?.length, 2, "ads-write.ts chỉ được gọi mạng ở graphGet và graphPost");
  assert.equal((cuaGhi.match(/retries: 0/g) ?? []).length, 1, "đúng một đường GHI, và nó không tự thử lại");

  console.log("  ✓ Bàn tay vòng mẫu: cổng 25 ca chặn + thứ tự chốt · bài QC chỉ thay 4 thứ, kiểu lạ bị từ chối · digest khoá 10 loại thay đổi · một cửa ghi");
}

// ═══════════════════════════ (d)(e) LUỒNG ĐĂNG TRÊN PGLITE ═══════════════════════════

const ON: CreativeWriteEnv = { hardEnabled: true, mode: "COPILOT" };
const OFF: CreativeWriteEnv = { hardEnabled: false, mode: "COPILOT" };
const TEST_CAMPAIGN = "cw-camp-test";

const SNAPSHOT: CreativeLoopConfig = {
  ...DEFAULT_CREATIVE_CONFIG,
  enabled: true,
  pageId: "cw-page",
  adAccountId: "123456789",
  testCampaignId: TEST_CAMPAIGN,
  templateAdId: "cw-tpl-ad",
  killRules: [KILL],
};

function template(campaignId = TEST_CAMPAIGN): TemplateAd {
  return {
    adId: "cw-tpl-ad",
    campaignId,
    accountId: "123456789",
    adset: {
      targeting: { geo_locations: { countries: ["VN"] } },
      optimizationGoal: "CONVERSATIONS",
      billingEvent: "IMPRESSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      bidAmount: null,
      promotedObject: { page_id: "cw-page" },
      destinationType: "MESSENGER",
      attributionSpec: null,
    },
    objectStorySpec: { page_id: "cw-page", link_data: { link: "https://m.me/cw", call_to_action: { type: "MESSAGE_PAGE" } } },
    hasAssetFeed: false,
  };
}

let dem = 0;
const idMoi = (loai: string) => `cw-${loai}-${++dem}-${Math.random().toString(36).slice(2, 8)}`;

type WriterGia = { writer: CreativeWriter; calls: string[] };

function writerGia(db: Db, opt: { templateCampaign?: string; createAdFails?: boolean } = {}): WriterGia {
  const calls: string[] = [];
  const writer: CreativeWriter = {
    readTemplateAd: async (adId) => {
      calls.push(`readTemplateAd:${adId}`);
      return template(opt.templateCampaign);
    },
    uploadAdImage: async () => {
      calls.push("uploadAdImage");
      return idMoi("hash");
    },
    createAdCreative: async () => {
      calls.push("createAdCreative");
      return { id: idMoi("creative"), effectiveObjectStoryId: idMoi("post") };
    },
    createTestAdset: async (_acc, i) => {
      calls.push(`createTestAdset:${i.lifetimeBudgetMinor}`);
      return idMoi("adset");
    },
    createAd: async (_acc, i) => {
      calls.push(`createAd:${i.adsetId}`);
      // Id nhóm phải ĐÃ nằm trong CSDL trước khi tạo mẩu — chết ngay ở đây thì lượt sau không tạo nhóm thứ hai.
      const [v] = await db.select({ id: schema.creativeVariants.id }).from(schema.creativeVariants).where(eq(schema.creativeVariants.fbAdsetId, i.adsetId));
      assert.ok(v, "id nhóm phải được lưu vào mẫu NGAY sau khi tạo, trước bước tạo mẩu");
      if (opt.createAdFails) throw new Error("Facebook: lỗi giả khi tạo mẩu");
      return idMoi("ad");
    },
    pauseAdset: async (id) => {
      calls.push(`pauseAdset:${id}`);
    },
    extendAdset: async (id) => {
      calls.push(`extendAdset:${id}`);
    },
  };
  return { writer, calls };
}

type LoDung = { batchId: string; day: string; start: Date; end: Date; truoc: Date; sau: Date; variantIds: string[]; imageIds: string[] };

const lo: { batchIds: string[]; variantIds: string[]; imageIds: string[] } = { batchIds: [], variantIds: [], imageIds: [] };

async function anhGia(db: Db): Promise<string> {
  // Chữ ký PNG + khối IHDR 1×1 + 16 byte riêng cho mỗi ảnh — `storeCreativeImage` tự băm, tự nhận loại và kích thước.
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1];
  const bytes = new Uint8Array([...png, ...Array.from({ length: 16 }, (_, i) => (dem * 31 + i * 7) % 256)]);
  dem += 1;
  const img = await storeCreativeImage(db, bytes);
  lo.imageIds.push(img.id);
  return img.id;
}

let ngayK = 0;

/** Dựng một lô có `n` mẫu `GENERATED`. `duyet` ⇒ lô `APPROVED` với digest tính từ CHÍNH CSDL. */
async function dungLo(db: Db, n: number, duyet: boolean, snapshot: Partial<CreativeLoopConfig> = {}): Promise<LoDung> {
  ngayK += 1;
  const day = shiftDay("2036-03-01", ngayK);
  const w = batchWindow(day, SNAPSHOT);
  const batchId = idMoi("batch");
  lo.batchIds.push(batchId);
  await db.insert(schema.creativeBatches).values({
    id: batchId,
    batchDay: day,
    status: "PENDING_APPROVAL",
    slotCount: n,
    startAt: w.startAt,
    endAt: w.endAt,
    approvalDeadline: w.approvalDeadline,
    configSnapshot: { ...SNAPSHOT, ...snapshot } as unknown as Record<string, unknown>,
    ruleVersion: 1,
  });
  const variantIds: string[] = [];
  const imageIds: string[] = [];
  for (let slot = 1; slot <= n; slot += 1) {
    const id = idMoi("variant");
    const imageId = await anhGia(db);
    variantIds.push(id);
    imageIds.push(imageId);
    lo.variantIds.push(id);
    await db.insert(schema.creativeVariants).values({
      id,
      batchId,
      slot,
      mode: "EXPLORE",
      genes: {},
      genesVersion: 1,
      primaryText: `Câu chữ mẫu ${slot}`,
      headline: `Tiêu đề ${slot}`,
      imageId,
      status: "GENERATED",
    });
  }
  if (duyet) await duyetLo(db, batchId);
  return { batchId, day, start: w.startAt, end: w.endAt, truoc: new Date(w.startAt.getTime() - 3_600_000), sau: new Date(w.startAt.getTime() + 60_000), variantIds, imageIds };
}

async function duyetLo(db: Db, batchId: string) {
  const [b] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, batchId));
  const digest = approvalDigest(await batchApprovalContent(db, b));
  await db.update(schema.creativeBatches).set({ status: "APPROVED", approvalDigest: digest, approvedAt: b.approvalDeadline, approvedByName: "cw-kiem-thu" }).where(eq(schema.creativeBatches.id, batchId));
}

async function soCuaLo(db: Db, batchId: string) {
  return db.select().from(schema.creativeFbActions).where(eq(schema.creativeFbActions.batchId, batchId));
}

async function mau(db: Db, id: string) {
  const [v] = await db.select().from(schema.creativeVariants).where(eq(schema.creativeVariants.id, id));
  return v;
}

async function trangThaiLo(db: Db, id: string) {
  const [b] = await db.select({ status: schema.creativeBatches.status }).from(schema.creativeBatches).where(eq(schema.creativeBatches.id, id));
  return b?.status;
}

/** Lô đã xong việc thì đưa ra khỏi `APPROVED` để luồng sau không vô tình đăng nó. */
async function khoaLo(db: Db, id: string) {
  await db.update(schema.creativeBatches).set({ status: "REJECTED" }).where(and(eq(schema.creativeBatches.id, id), eq(schema.creativeBatches.status, "APPROVED")));
}

async function donDep(db: Db) {
  if (lo.batchIds.length) await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.batchId, lo.batchIds));
  if (lo.variantIds.length) await db.delete(schema.creativeFbActions).where(inArray(schema.creativeFbActions.variantId, lo.variantIds));
  if (lo.variantIds.length) await db.delete(schema.creativeVariants).where(inArray(schema.creativeVariants.id, lo.variantIds));
  if (lo.batchIds.length) await db.delete(schema.creativeBatches).where(inArray(schema.creativeBatches.id, lo.batchIds));
  if (lo.imageIds.length) await db.delete(schema.creativeImages).where(inArray(schema.creativeImages.id, lo.imageIds));
}

export async function testCreativeWriteDb(db: Db) {
  try {
    // ── 1. KHÔNG DUYỆT ⇒ KHÔNG MỘT LỜI GỌI NÀO ──
    {
      const L = await dungLo(db, 2, false);
      const g = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      assert.deepEqual(g.calls, [], "lô chưa duyệt: không một lời gọi Facebook nào, kể cả lời gọi ĐỌC");
      assert.equal((await soCuaLo(db, L.batchId)).length, 0);
      await db.update(schema.creativeBatches).set({ status: "REJECTED" }).where(eq(schema.creativeBatches.id, L.batchId));
    }

    // ── 2. DIGEST LỆCH ⇒ KHÔNG LỜI GỌI NÀO + SỔ DENIED (MỘT dòng dù chạy lại) ──
    {
      const L = await dungLo(db, 2, true);
      await db.update(schema.creativeVariants).set({ primaryText: "Câu chữ bị sửa sau khi duyệt" }).where(eq(schema.creativeVariants.id, L.variantIds[0]));
      const g = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      await publishApprovedBatches(db, new Date(L.truoc.getTime() + 600_000), { writer: g.writer, env: ON });
      assert.deepEqual(g.calls, [], "nội dung đổi sau khi duyệt: không một lời gọi nào");
      const so = await soCuaLo(db, L.batchId);
      assert.equal(so.length, 1, "lượt chặn trùng hệt chỉ ghi MỘT dòng dù vòng hỏi lại");
      assert.equal(so[0].outcome, "DENIED");
      assert.equal(so[0].denial, "APPROVAL_MISMATCH");
      assert.equal((await mau(db, L.variantIds[0])).status, "GENERATED");
      await khoaLo(db, L.batchId);
    }

    // ── 3. CHỐT ENV TẮT ⇒ HARD_DISABLED TRƯỚC MỌI THỨ (kể cả digest lệch) ──
    {
      const L = await dungLo(db, 1, true);
      await db.update(schema.creativeVariants).set({ headline: "đổi" }).where(eq(schema.creativeVariants.id, L.variantIds[0]));
      const g = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: OFF });
      assert.deepEqual(g.calls, [], "chốt env tắt: không một lời gọi nào, kể cả đọc mẩu mẫu");
      const so = await soCuaLo(db, L.batchId);
      assert.deepEqual(so.map((r) => r.denial), ["HARD_DISABLED"], "chốt env phải thắng cả lỗi lệch digest");
      await khoaLo(db, L.batchId);
    }

    // ── 3b. CÔNG TẮC KHẨN CẤP KÉO ⇒ KILL_SWITCH, KHÔNG LỜI GỌI NÀO, LÔ VẪN "ĐÃ DUYỆT" ──
    {
      const L = await dungLo(db, 1, true);
      await db
        .insert(schema.settings)
        .values({ key: ADS_WRITE_KILL_KEY, value: JSON.stringify({ killed: true, reason: "kiểm thử" }) })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ killed: true, reason: "kiểm thử" }) } });
      try {
        const g = writerGia(db);
        await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
        assert.deepEqual(g.calls, [], "công tắc kéo: không một lời gọi Facebook nào, kể cả đọc mẩu mẫu");
        assert.deepEqual((await soCuaLo(db, L.batchId)).map((r) => r.denial), ["KILL_SWITCH"]);
        for (const id of L.variantIds) assert.equal((await mau(db, id)).status, "GENERATED", "mẫu KHÔNG thành PUBLISH_FAILED — kéo công tắc năm phút không được giết lô");
        assert.equal(await trangThaiLo(db, L.batchId), "APPROVED", "lô vẫn ĐÃ DUYỆT: nhả trước giờ chạy là đăng tiếp");
      } finally {
        await db.delete(schema.settings).where(eq(schema.settings.key, ADS_WRITE_KILL_KEY));
      }
      await khoaLo(db, L.batchId);
    }

    // ── 4. SAU GIỜ CHẠY ⇒ KHÔNG ĐĂNG, MẪU GIỮ NGUYÊN, LÔ RỜI "ĐÃ DUYỆT" ──
    {
      const L = await dungLo(db, 2, true);
      const g = writerGia(db);
      await publishApprovedBatches(db, L.sau, { writer: g.writer, env: ON });
      assert.deepEqual(g.calls, [], "sau giờ chạy: không đăng gì");
      for (const id of L.variantIds) assert.equal((await mau(db, id)).status, "GENERATED", "mẫu chưa đăng giữ nguyên trạng thái");
      const so = await soCuaLo(db, L.batchId);
      assert.deepEqual(so.map((r) => r.denial).sort(), ["TOO_LATE", "TOO_LATE"], "mỗi mẫu để lại một dòng TOO_LATE");
      assert.equal(await trangThaiLo(db, L.batchId), "EXPIRED", "không mẫu nào lên được ⇒ lô quá hạn, không đồng nào được chi");
    }

    // ── 5. ĐƯỜNG ĐÚNG: hai mẫu lên, mỗi bước một dòng sổ, không token trong sổ ──
    {
      const L = await dungLo(db, 2, true);
      const g = writerGia(db);
      const rep = await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      assert.equal(rep.find((r) => r.batchId === L.batchId)?.result, "PUBLISHED");
      assert.equal(g.calls[0], `readTemplateAd:${SNAPSHOT.templateAdId}`, "đọc mẩu mẫu MỘT lần cho cả lô");
      assert.equal(g.calls.filter((c) => c.startsWith("readTemplateAd")).length, 1);
      assert.equal(g.calls.filter((c) => c === `createTestAdset:${BUDGET}`).length, 2, "mỗi mẫu đúng MỘT nhóm, ngân sách trọn đời = ngân sách của ảnh chụp (VND không đổi đơn vị)");
      assert.equal(g.calls.filter((c) => c.startsWith("createAd:")).length, 2);
      for (const id of L.variantIds) {
        const v = await mau(db, id);
        assert.equal(v.status, "LIVE");
        assert.equal(v.committedBudgetVnd, BUDGET);
        assert.ok(v.publishedAt && v.fbPostId && v.fbAdId && v.fbAdsetId && v.fbCreativeId && v.fbImageHash, "mọi id Facebook phải được lưu");
      }
      assert.equal(await trangThaiLo(db, L.batchId), "PUBLISHED");
      const so = await soCuaLo(db, L.batchId);
      assert.equal(so.length, 8, "hai mẫu × bốn bước = tám dòng sổ");
      assert.ok(so.every((r) => r.outcome === "APPLIED" && r.actorUserId === null && r.mode === "COPILOT"), "máy làm ⇒ actor_user_id NULL");
      const tien = so.filter((r) => r.action === "CREATE_ADSET");
      assert.deepEqual(tien.map((r) => r.amountVnd), [BUDGET, BUDGET], "chỉ lượt tạo nhóm mang tiền cam kết");
      assert.ok(so.filter((r) => r.action !== "CREATE_ADSET").every((r) => r.amountVnd === null));
      assert.ok(!JSON.stringify(so.map((r) => r.request)).includes("access_token"), "sổ KHÔNG BAO GIỜ chứa token");
      // Chạy lại: lô đã đăng ⇒ không lời gọi nào nữa.
      const g2 = writerGia(db);
      await publishApprovedBatches(db, new Date(L.truoc.getTime() + 600_000), { writer: g2.writer, env: ON });
      assert.deepEqual(g2.calls, [], "lô đã đăng: chạy lại không đăng thêm");

      // ── (e) TẮT THEO LUẬT trên chính lô này ──
      const [v0, v1] = [await mau(db, L.variantIds[0]), await mau(db, L.variantIds[1])];
      const gk = writerGia(db);
      const kq = await applyKills(
        db,
        [
          { variantId: v0.id, batchId: L.batchId, adsetId: v0.fbAdsetId ?? "", rule: KILL_LA },
          { variantId: v1.id, batchId: L.batchId, adsetId: "cw-nhom-cua-marketer", rule: KILL },
        ],
        L.truoc,
        { writer: gk.writer, env: ON },
      );
      assert.deepEqual(gk.calls, [], "luật không có trong ảnh chụp lô / nhóm không phải của vòng ⇒ không tắt gì");
      assert.deepEqual(kq.map((k) => k.denial), ["NO_KILL_RULE", "NOT_OUR_AD"]);
      assert.equal((await mau(db, v0.id)).status, "LIVE");

      const kq2 = await applyKills(db, [{ variantId: v0.id, batchId: L.batchId, adsetId: v0.fbAdsetId ?? "", rule: { ...KILL } }], L.truoc, { writer: gk.writer, env: ON });
      assert.equal(kq2[0].ok, true, "luật nằm trong ảnh chụp lô ⇒ tắt");
      assert.deepEqual(gk.calls, [`pauseAdset:${v0.fbAdsetId}`]);
      const tat = await mau(db, v0.id);
      assert.equal(tat.status, "PAUSED");
      assert.ok(tat.pausedAt);
      assert.ok(tat.pauseReason.includes(KILL.label ?? "∅"), `lý do tắt phải là nhãn luật — "${tat.pauseReason}"`);
      // Tắt lại lần nữa: không lời gọi, không dòng sổ mới.
      const truocLan2 = (await soCuaLo(db, L.batchId)).length;
      await applyKills(db, [{ variantId: v0.id, batchId: L.batchId, adsetId: v0.fbAdsetId ?? "", rule: KILL }], L.truoc, { writer: gk.writer, env: ON });
      assert.equal(gk.calls.length, 1, "mẫu đã tắt: tắt lại không gọi Facebook");
      assert.equal((await soCuaLo(db, L.batchId)).length, truocLan2, "mẫu đã tắt: tắt lại không ghi thêm dòng sổ");
    }

    // ── 6. CHẾT GIỮA CHỪNG RỒI CHẠY LẠI ⇒ KHÔNG TẠO NHÓM THỨ HAI ──
    {
      const L = await dungLo(db, 1, true);
      const adsetCu = idMoi("adset-cu");
      // Trạng thái đúng như sau khi tiến trình chết ngay sau lượt tạo nhóm: có ảnh, bài, nhóm; chưa có mẩu.
      await db.update(schema.creativeVariants).set({ fbImageHash: "cw-hash-cu", fbCreativeId: "cw-creative-cu", fbAdsetId: adsetCu }).where(eq(schema.creativeVariants.id, L.variantIds[0]));
      await db.insert(schema.creativeFbActions).values({ actionDay: L.day, batchId: L.batchId, variantId: L.variantIds[0], action: "CREATE_ADSET", outcome: "APPLIED", targetId: adsetCu, amountVnd: BUDGET, mode: "COPILOT" });
      const g = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      assert.deepEqual(g.calls, [`readTemplateAd:${SNAPSHOT.templateAdId}`, `createAd:${adsetCu}`], "chạy tiếp đúng bước dở: chỉ tạo mẩu, KHÔNG tải ảnh / tạo bài / tạo nhóm lại");
      assert.equal((await mau(db, L.variantIds[0])).status, "LIVE");
      assert.equal(await trangThaiLo(db, L.batchId), "PUBLISHED");
    }

    // ── 7. TẠO MẨU HỎNG ⇒ NHÓM BỊ TẮT + PUBLISH_FAILED ──
    {
      const L = await dungLo(db, 1, true);
      const g = writerGia(db, { createAdFails: true });
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      const v = await mau(db, L.variantIds[0]);
      assert.equal(v.status, "PUBLISH_FAILED");
      assert.ok(v.fbAdsetId);
      assert.equal(g.calls.at(-1), `pauseAdset:${v.fbAdsetId}`, "nhóm đã tạo mà không có mẩu ⇒ phải tắt nhóm");
      const so = await soCuaLo(db, L.batchId);
      assert.ok(so.some((r) => r.action === "CREATE_AD" && r.outcome === "FAILED"), "lượt tạo mẩu hỏng vào sổ FAILED");
      assert.ok(so.some((r) => r.action === "PAUSE_ADSET" && r.outcome === "APPLIED" && r.targetId === v.fbAdsetId), "lượt dọn dẹp vào sổ");
      assert.equal(await trangThaiLo(db, L.batchId), "FAILED", "không mẫu nào lên ⇒ lô lỗi, không nói là đã đăng");
      // Không tự thử lại: lượt sau không gọi gì nữa.
      const g2 = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g2.writer, env: ON });
      assert.deepEqual(g2.calls, []);
    }

    // ── 8. TRẦN NGÀY ĐẾM TRÊN SỔ ──
    {
      const L = await dungLo(db, 2, true);
      // Sổ đã ghi sẵn gần trần cho NGÀY CHẠY này: còn chỗ cho đúng một mẫu.
      await db.insert(schema.creativeFbActions).values({
        actionDay: L.day,
        batchId: L.batchId,
        action: "CREATE_ADSET",
        outcome: "APPLIED",
        targetId: "cw-nhom-truoc",
        amountVnd: CREATIVE_HARD_LIMITS.maxDailyTestSpendVnd - BUDGET,
        mode: "COPILOT",
      });
      const g = writerGia(db);
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      assert.equal(g.calls.filter((c) => c.startsWith("createTestAdset")).length, 1, "sổ còn chỗ cho MỘT mẫu ⇒ đúng một nhóm");
      assert.equal((await mau(db, L.variantIds[0])).status, "LIVE");
      assert.equal((await mau(db, L.variantIds[1])).status, "GENERATED", "mẫu vượt trần giữ nguyên");
      const chan = (await soCuaLo(db, L.batchId)).filter((r) => r.outcome === "DENIED");
      assert.deepEqual(chan.map((r) => [r.variantId, r.denial]), [[L.variantIds[1], "OVER_DAILY_CAP"]], "mẫu thứ hai bị chặn OVER_DAILY_CAP — đếm trên sổ, kể cả lượt vừa áp trong cùng vòng");
      assert.equal(await trangThaiLo(db, L.batchId), "PUBLISHED");
    }

    // ── 9. MẨU MẪU NẰM Ở CHIẾN DỊCH KHÁC ⇒ WRONG_CAMPAIGN, CHỈ MỘT LỜI ĐỌC ──
    {
      const L = await dungLo(db, 1, true);
      const g = writerGia(db, { templateCampaign: "cw-camp-cua-marketer" });
      await publishApprovedBatches(db, L.truoc, { writer: g.writer, env: ON });
      assert.deepEqual(g.calls, [`readTemplateAd:${SNAPSHOT.templateAdId}`], "mẩu mẫu sai chiến dịch: chỉ đọc, không ghi gì");
      assert.deepEqual((await soCuaLo(db, L.batchId)).map((r) => r.denial), ["WRONG_CAMPAIGN"]);
      await khoaLo(db, L.batchId);
    }
  } finally {
    await donDep(db);
  }
  console.log("  ✓ Đăng lô trên PGlite với cửa ghi giả: không duyệt / lệch digest / env tắt / quá giờ ⇒ 0 lời gọi · chạy lại không tạo nhóm thứ hai · mẩu hỏng ⇒ tắt nhóm · trần ngày đếm trên sổ · luật ngoài ảnh chụp không tắt được");
}
