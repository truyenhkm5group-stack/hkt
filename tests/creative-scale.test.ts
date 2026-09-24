import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { verifyActionToken } from "@/lib/ai/policy";
import {
  CREATIVE_CONFIG_KEY,
  CREATIVE_HARD_LIMITS,
  CREATIVE_WRITE_ACTIONS,
  SCALE_WRITE_ACTIONS,
  normalizeCreativeConfig,
  type CreativeWriteDenial,
} from "@/lib/constants/creative-loop";
import { parseCampaignCopy, parseCampaignTree, scaleCopyFields, type CampaignTree } from "@/lib/integrations/facebook/ads-write";
import { gateScaleWrite, type ScaleGateInput } from "@/lib/marketing/creative-write-gate";
import {
  SCALE_ACTIVATE_TOOL,
  activateScaleDraft,
  buildScaleDraft,
  checkScaleTree,
  dismissScaleDraft,
  pauseScaleDraft,
  proposeScale,
  scaleLaunchProposal,
  scaleTicketPayload,
  scaleTreeDrift,
  type ScaleDeps,
  type ScaleWriter,
} from "@/lib/creative/scale";

/**
 * ═══════════ SCALE MẪU THẮNG — NGOẠI LỆ "SAO CHÉP CHIẾN DỊCH MẪU" PHẢI ĐÚNG TRƯỚC KHI CÓ TIỀN ĐI QUA ═══════════
 *
 * Đặc tả: `docs/creative-loop.md` §5f. Mẫu: `tests/creative-write.test.ts`.
 *
 *  (a) BẢNG CHÂN LÝ của `gateScaleWrite`, kể cả THỨ TỰ các chốt.
 *  (b) THAM SỐ sao chép (luôn PAUSED, deep_copy) · đọc phản hồi `/copies` · đọc cây · kiểm hình dạng.
 *  (c) LUỒNG trên PGlite với cửa ghi GIẢ: đề nghị không gọi gì · dựng nháp không bật gì · hỏng giữa
 *      chừng ⇒ không gì bật + id bản sao được ghi · không nháp trùng · bật chỉ với phiếu của đúng người,
 *      đọc lại Facebook trước khi bật, bật mẩu → nhóm → chiến dịch · tắt không ghi hai lần.
 *  (d) MỨC MÃ NGUỒN: không tệp scale nào tự gọi mạng; cửa ghi vẫn chỉ hai chỗ chạm mạng.
 *
 * Mốc thời gian: mã scale chỉ đọc `now` được truyền vào, và lô/mẫu gieo ở đây không có khung chạy nào
 * bị so với đồng hồ thật — mẫu THẮNG vì đã vào thư viện, không vì đếm đơn trong một cửa sổ (mục 50).
 */

const TPL_PM = "900000001";
const TPL_LEAD = "900000002";
const PAGE = "111222333";
const ACC = "444555666";
const BUDGET = CREATIVE_HARD_LIMITS.maxScaleDailyBudgetVnd;

function gin(over: Partial<ScaleGateInput> = {}): ScaleGateInput {
  return {
    hardEnabled: true,
    mode: "COPILOT",
    action: "COPY_SCALE_CAMPAIGN",
    configComplete: true,
    approved: true,
    approvalMatches: true,
    sourceCampaignId: TPL_PM,
    templateCampaignId: TPL_PM,
    ourCopy: false,
    verdict: "WIN",
    alreadyCopied: false,
    otherDraftsForVariant: 0,
    budgetVnd: BUDGET,
    activeTotalVnd: 0,
    ...over,
  };
}

function denialOf(i: ScaleGateInput): CreativeWriteDenial | "OK" {
  const r = gateScaleWrite(i);
  return r.ok ? "OK" : r.denial;
}

function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SPEC_PM = { page_id: PAGE, link_data: { link: "https://m.me/shop", message: "cũ", call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } } } };
const SPEC_LEAD = { page_id: PAGE, link_data: { link: "https://fb.me/", message: "cũ", call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "7777" } } } };

function cay(id: string, o: Partial<{ objective: string; status: string; adsets: number; ads: number; campaignDaily: number | null; adsetDaily: number | null; lifetime: number | null; creativeId: string; spec: Record<string, unknown>; adsetId: string; adId: string }> = {}): CampaignTree {
  const adsetId = o.adsetId ?? `${id}1`;
  const adId = o.adId ?? `${id}2`;
  return {
    id,
    name: `Chiến dịch ${id}`,
    status: o.status ?? "PAUSED",
    objective: o.objective ?? "OUTCOME_SALES",
    dailyBudgetMinor: o.campaignDaily === undefined ? 300_000 : o.campaignDaily,
    lifetimeBudgetMinor: o.lifetime ?? null,
    adsets: Array.from({ length: o.adsets ?? 1 }, (_, i) => ({ id: i === 0 ? adsetId : `${adsetId}${i}`, status: "ACTIVE", dailyBudgetMinor: o.adsetDaily ?? null, lifetimeBudgetMinor: null, promotedPageId: PAGE })),
    ads: Array.from({ length: o.ads ?? 1 }, (_, i) => ({ id: i === 0 ? adId : `${adId}${i}`, adsetId, status: "ACTIVE", creativeId: o.creativeId ?? "5550001", objectStorySpec: o.spec ?? SPEC_PM, hasAssetFeed: false })),
    truncated: false,
  };
}

export function testCreativeScalePure() {
  // ═══════════ (a) BẢNG CHÂN LÝ CỦA CỔNG ═══════════
  assert.equal(denialOf(gin()), "OK", "đủ điều kiện thì cho sao chép");
  const truth: { name: string; over: Partial<ScaleGateInput>; denial: CreativeWriteDenial }[] = [
    { name: "chốt env tắt", over: { hardEnabled: false }, denial: "HARD_DISABLED" },
    { name: "nấc OFF", over: { mode: "OFF" }, denial: "MODE_OFF" },
    { name: "khai AUTO cũng không phải COPILOT", over: { mode: "AUTO" }, denial: "MODE_OFF" },
    { name: "chưa khai chiến dịch mẫu", over: { configComplete: false }, denial: "CONFIG_INCOMPLETE" },
    { name: "người chưa bấm", over: { approved: false }, denial: "NOT_APPROVED" },
    { name: "sao chép một chiến dịch khác mẫu", over: { sourceCampaignId: "123456789" }, denial: "NOT_SCALE_TEMPLATE" },
    { name: "sao chép khi mẫu rỗng", over: { templateCampaignId: "", sourceCampaignId: "" }, denial: "NOT_SCALE_TEMPLATE" },
    { name: "sao chép không rõ nguồn", over: { sourceCampaignId: null }, denial: "NOT_SCALE_TEMPLATE" },
    { name: "mẫu chỉ đang chạy", over: { verdict: "RUNNING" }, denial: "NOT_WINNER" },
    { name: "mẫu thua", over: { verdict: "LOSE" }, denial: "NOT_WINNER" },
    { name: "mẫu chưa kết luận", over: { verdict: "UNJUDGED" }, denial: "NOT_WINNER" },
    { name: "nháp này đã từng sao chép", over: { alreadyCopied: true }, denial: "SCALE_DUPLICATE" },
    { name: "mẫu đã đủ nháp", over: { otherDraftsForVariant: CREATIVE_HARD_LIMITS.maxScaleDraftsPerVariant }, denial: "SCALE_DUPLICATE" },
    { name: "ngân sách vượt 500.000đ một đồng", over: { budgetVnd: BUDGET + 1 }, denial: "OVER_SCALE_BUDGET" },
    { name: "ngân sách 0", over: { budgetVnd: 0 }, denial: "OVER_SCALE_BUDGET" },
    { name: "ngân sách lẻ", over: { budgetVnd: 1.5 }, denial: "OVER_SCALE_BUDGET" },
    { name: "bước sau nhắm vào thứ không phải bản sao", over: { action: "SET_SCALE_BUDGET", ourCopy: false }, denial: "NOT_OUR_AD" },
    { name: "đặt ngân sách quá trần", over: { action: "SET_SCALE_BUDGET", ourCopy: true, budgetVnd: BUDGET * 10 }, denial: "OVER_SCALE_BUDGET" },
    { name: "bật không có phiếu", over: { action: "ACTIVATE_SCALE", ourCopy: true, approved: false }, denial: "NOT_APPROVED" },
    { name: "bật khi phiếu lệch", over: { action: "ACTIVATE_SCALE", ourCopy: true, approvalMatches: false }, denial: "APPROVAL_MISMATCH" },
    { name: "bật khi mẫu đã rớt phán quyết", over: { action: "ACTIVATE_SCALE", ourCopy: true, verdict: "LOSE" }, denial: "NOT_WINNER" },
    { name: "bật vượt trần tổng một đồng", over: { action: "ACTIVATE_SCALE", ourCopy: true, activeTotalVnd: CREATIVE_HARD_LIMITS.maxScaleActiveDailyTotalVnd - BUDGET + 1 }, denial: "OVER_SCALE_DAILY_CAP" },
    { name: "tắt bản sao không phải của vòng", over: { action: "PAUSE_SCALE", ourCopy: false }, denial: "NOT_OUR_AD" },
  ];
  for (const t of truth) {
    const r = gateScaleWrite(gin(t.over));
    assert.equal(r.ok ? "OK" : r.denial, t.denial, `${t.name}: sai mã chặn`);
    assert.ok(!r.ok && r.reason.length > 10, `${t.name}: lý do phải đọc được`);
  }
  const phaiQua: { name: string; over: Partial<ScaleGateInput> }[] = [
    { name: "HỨA HẸN cũng scale được", over: { verdict: "PROMISING" } },
    { name: "đúng 500.000đ", over: { budgetVnd: BUDGET } },
    { name: "nháp thứ hai của mẫu (loại khác)", over: { otherDraftsForVariant: 1 } },
    { name: "bật đúng chạm trần tổng", over: { action: "ACTIVATE_SCALE", ourCopy: true, activeTotalVnd: CREATIVE_HARD_LIMITS.maxScaleActiveDailyTotalVnd - BUDGET } },
    // Tắt chỉ làm GIẢM tiền: không phán quyết, không trần nào giữ tiền chảy.
    { name: "tắt khi mẫu đã thua, ngân sách hỏng", over: { action: "PAUSE_SCALE", ourCopy: true, verdict: "LOSE", budgetVnd: 0, activeTotalVnd: 99_999_999 } },
    { name: "gắn bài vào bản sao", over: { action: "SET_SCALE_AD_CREATIVE", ourCopy: true, budgetVnd: 0 } },
  ];
  for (const t of phaiQua) assert.equal(denialOf(gin(t.over)), "OK", `${t.name}: phải qua`);

  // ─── THỨ TỰ CÁC CHỐT — sao chép: sai ở MỌI chỗ, sửa lần lượt từ trên xuống ───
  let dang: Partial<ScaleGateInput> = { hardEnabled: false, mode: "OFF", configComplete: false, approved: false, sourceCampaignId: "123456789", verdict: "LOSE", alreadyCopied: true, budgetVnd: BUDGET * 3 };
  const thuTu: [Partial<ScaleGateInput>, CreativeWriteDenial | "OK"][] = [
    [{}, "HARD_DISABLED"],
    [{ hardEnabled: true }, "MODE_OFF"],
    [{ mode: "COPILOT" }, "CONFIG_INCOMPLETE"],
    [{ configComplete: true }, "NOT_APPROVED"],
    [{ approved: true }, "NOT_SCALE_TEMPLATE"],
    [{ sourceCampaignId: TPL_PM }, "NOT_WINNER"],
    [{ verdict: "WIN" }, "SCALE_DUPLICATE"],
    [{ alreadyCopied: false }, "OVER_SCALE_BUDGET"],
    [{ budgetVnd: BUDGET }, "OK"],
  ];
  for (const [k, [sua, ke]] of thuTu.entries()) {
    dang = { ...dang, ...sua };
    assert.equal(denialOf(gin(dang)), ke, `thứ tự chốt (sao chép), bước ${k}: mong ${ke}`);
  }
  // ─── bật: phiếu → lệch phiếu → bản sao của ai → phán quyết → ngân sách → trần tổng ───
  let bat: Partial<ScaleGateInput> = { action: "ACTIVATE_SCALE", approved: false, approvalMatches: false, ourCopy: false, verdict: "KILL", budgetVnd: BUDGET + 1, activeTotalVnd: 99_000_000 };
  const thuTuBat: [Partial<ScaleGateInput>, CreativeWriteDenial | "OK"][] = [
    [{}, "NOT_APPROVED"],
    [{ approved: true }, "APPROVAL_MISMATCH"],
    [{ approvalMatches: true }, "NOT_OUR_AD"],
    [{ ourCopy: true }, "NOT_WINNER"],
    [{ verdict: "PROMISING" }, "OVER_SCALE_BUDGET"],
    [{ budgetVnd: BUDGET }, "OVER_SCALE_DAILY_CAP"],
    [{ activeTotalVnd: 0 }, "OK"],
  ];
  for (const [sua, ke] of thuTuBat) {
    bat = { ...bat, ...sua };
    assert.equal(denialOf(gin(bat)), ke, `thứ tự chốt (bật): mong ${ke}`);
  }
  // Chốt env thắng MỌI hành động scale, kể cả tắt.
  for (const action of SCALE_WRITE_ACTIONS) assert.equal(denialOf(gin({ action, hardEnabled: false, approved: false, ourCopy: false })), "HARD_DISABLED", `${action}: chốt env phải đứng đầu`);
  for (const a of SCALE_WRITE_ACTIONS) assert.ok((CREATIVE_WRITE_ACTIONS as readonly string[]).includes(a), `${a} phải nằm trong CREATIVE_WRITE_ACTIONS`);

  // ═══════════ (b) THAM SỐ SAO CHÉP · PHẢN HỒI · CÂY · HÌNH DẠNG ═══════════
  const f = scaleCopyFields("[VM scale MUA-TN] 2031-05-10 #3");
  assert.deepEqual(Object.keys(f).sort(), ["deep_copy", "rename_options", "status_option"], "chỉ ba trường — đối tượng/mục tiêu chép NGUYÊN");
  assert.equal(f.status_option, "PAUSED", "bản sao LUÔN TẮT, gửi tường minh");
  assert.equal(f.deep_copy, "true", "sao chép cả nhóm + mẩu");
  assert.equal((JSON.parse(f.rename_options) as { rename_prefix: string }).rename_prefix.startsWith("[VM scale MUA-TN]"), true);

  assert.equal(parseCampaignCopy({ success: true }), null, "không có copied_campaign_id ⇒ không đoán");
  const cp = parseCampaignCopy({ copied_campaign_id: "800001", ad_object_ids: [{ ad_object_type: "ad_set", source_id: "1", copied_id: "800002" }, { ad_object_type: "ad", source_id: "2", copied_id: "800003" }] });
  assert.deepEqual(cp?.objects.map((o) => o.type), ["ad_set", "ad"]);

  const tree = parseCampaignTree({
    id: "700",
    objective: "OUTCOME_LEADS",
    status: "PAUSED",
    daily_budget: "500000",
    adsets: { data: [{ id: "701", status: "ACTIVE", promoted_object: { page_id: PAGE } }] },
    ads: { data: [{ id: "702", adset_id: "701", status: "ACTIVE", creative: { id: "703", object_story_spec: SPEC_LEAD } }], paging: {} },
  });
  assert.equal(tree.dailyBudgetMinor, 500000);
  assert.equal(tree.adsets[0].promotedPageId, PAGE);
  assert.equal(tree.ads[0].creativeId, "703");
  assert.equal(tree.truncated, false);
  assert.equal(parseCampaignTree({ id: "1", ads: { data: [], paging: { next: "https://x" } } }).truncated, true, "còn trang sau ⇒ cây không đủ");

  const nd = { pageId: PAGE, imageHash: "hash-moi", primaryText: "Váy lụa", headline: "Giảm 20%" };
  const ok = checkScaleTree(cay("600"), "PURCHASE_MESSAGING", nd);
  assert.ok(ok.ok && ok.level === "CAMPAIGN", "chiến dịch có ngân sách ngày ⇒ CBO");
  const abo = checkScaleTree(cay("600", { campaignDaily: null, adsetDaily: 100_000 }), "PURCHASE_MESSAGING", nd);
  assert.ok(abo.ok && abo.level === "ADSET", "không có ngân sách chiến dịch ⇒ ABO, đặt ở nhóm");
  const tuChoi: [string, CampaignTree, "PURCHASE_MESSAGING" | "LEADS"][] = [
    ["hai nhóm", cay("600", { adsets: 2 }), "PURCHASE_MESSAGING"],
    ["hai mẩu", cay("600", { ads: 2 }), "PURCHASE_MESSAGING"],
    ["dán nhầm mẫu khách tiềm năng vào ô mua qua tin nhắn", cay("600", { objective: "OUTCOME_LEADS" }), "PURCHASE_MESSAGING"],
    ["ngân sách trọn đời", cay("600", { lifetime: 1_000_000 }), "PURCHASE_MESSAGING"],
    ["mẩu là video", cay("600", { spec: { page_id: PAGE, video_data: { video_id: "1" } } }), "PURCHASE_MESSAGING"],
  ];
  for (const [ten, t, k] of tuChoi) assert.equal(checkScaleTree(t, k, nd).ok, false, `${ten}: phải bị từ chối`);
  const lead = checkScaleTree(cay("600", { objective: "OUTCOME_LEADS", spec: SPEC_LEAD }), "LEADS", nd);
  assert.ok(lead.ok, "mẫu khách tiềm năng đúng mục tiêu ⇒ dùng được");
  if (lead.ok) assert.deepEqual((lead.spec.link_data as Record<string, unknown>).call_to_action, SPEC_LEAD.link_data.call_to_action, "biểu mẫu khách tiềm năng chép NGUYÊN");

  // Bản sao lệch phiếu (ai sửa trên Ads Manager) ⇒ không bật.
  const p = { draftId: "d", campaignId: "600", adsetId: "6001", adId: "6002", creativeId: "5550001", dailyBudgetVnd: BUDGET, budgetLevel: "CAMPAIGN" };
  assert.equal(scaleTreeDrift(cay("600", { campaignDaily: BUDGET }), p, "VND"), null);
  assert.ok(scaleTreeDrift(cay("600", { campaignDaily: BUDGET * 2 }), p, "VND"), "ngân sách bị sửa ⇒ lệch");
  assert.ok(scaleTreeDrift(cay("600", { campaignDaily: BUDGET, creativeId: "999" }), p, "VND"), "bài bị tráo ⇒ lệch");

  // Cấu hình: 500.000đ mặc định, không nới được; id mẫu lạ ⇒ rỗng.
  assert.equal(normalizeCreativeConfig({}).config.scaleDailyBudgetVnd, 500_000);
  assert.equal(normalizeCreativeConfig({ scaleDailyBudgetVnd: 5_000_000 }).config.scaleDailyBudgetVnd, 500_000, "cấu hình chỉ LÀM HẸP");
  assert.equal(normalizeCreativeConfig({ scaleDailyBudgetVnd: 300_000 }).config.scaleDailyBudgetVnd, 300_000);
  assert.deepEqual(normalizeCreativeConfig({ scaleTemplates: { purchaseMessagingCampaignId: "act_12;DROP", leadsCampaignId: " 900000002 " } }).config.scaleTemplates, { purchaseMessagingCampaignId: "", leadsCampaignId: TPL_LEAD });

  // ═══════════ (d) MỨC MÃ NGUỒN ═══════════
  for (const tep of ["lib/creative/scale.ts", "lib/actions/creative-scale.ts", "lib/queries/creative-scale.ts", "app/(dashboard)/marketing/creatives/scale-panel.tsx", "app/(dashboard)/marketing/creatives/scale-actions.tsx"]) {
    const src = boChuThich(readFileSync(tep, "utf8"));
    assert.ok(!src.includes("graph.facebook.com"), `${tep} không được nhắc tới Graph API — mọi lời gọi đi qua lib/integrations/facebook/ads-write.ts`);
    assert.ok(!src.includes("fetch("), `${tep} không được tự gọi mạng`);
  }
  const cuaGhi = boChuThich(readFileSync("lib/integrations/facebook/ads-write.ts", "utf8"));
  assert.equal(cuaGhi.match(/fetchJson\(/g)?.length, 2, "ads-write.ts vẫn chỉ gọi mạng ở graphGet và graphPost");
  assert.equal((cuaGhi.match(/retries: 0/g) ?? []).length, 1, "đúng một đường GHI, không tự thử lại");
  assert.ok(/copyScaleCampaign[\s\S]{0,400}graphPost\(`\$\{src\}\/copies`/.test(cuaGhi), "sao chép đi qua graphPost");
  assert.ok(!boChuThich(readFileSync("lib/integrations/facebook/client.ts", "utf8")).includes("copies"), "client.ts vẫn CHỈ-ĐỌC");

  console.log(`  ✓ Scale mẫu thắng: cổng ${truth.length} ca chặn + thứ tự chốt (sao chép · bật) · bản sao luôn PAUSED · hình dạng lạ bị từ chối · lệch phiếu không bật · một cửa ghi`);
}

// ═══════════════════════════ (c) LUỒNG TRÊN PGLITE ═══════════════════════════

const P = "csc-";
const ON = { hardEnabled: true, mode: "COPILOT" as const };
const MO = async () => ({ killed: false, reason: null });

type Goi = string[];

/**
 * Cửa ghi GIẢ có TRẠNG THÁI: bản sao đọc về phản ánh đúng những gì đã ghi (bài gắn vào mẩu, ngân sách
 * đặt vào chiến dịch), để bước "đọc lại trước khi bật" thật sự so được.
 */
function writerGia(opt: { failOn?: string; copyStatus?: string } = {}) {
  const calls: Goi = [];
  let dem = 0;
  const copies = new Map<string, { src: string; status: string; creativeId: string; campaignDaily: number; adsetStatus: string; adStatus: string }>();
  const nem = (k: string) => {
    if (opt.failOn === k) throw new Error(`Facebook: lỗi giả ở ${k}`);
  };
  const writer: ScaleWriter = {
    readCampaignTree: async (id) => {
      calls.push(`read:${id}`);
      const c = copies.get(id);
      if (!c) return cay(id, { objective: id === TPL_LEAD ? "OUTCOME_LEADS" : "OUTCOME_SALES", spec: id === TPL_LEAD ? SPEC_LEAD : SPEC_PM });
      return cay(id, { objective: c.src === TPL_LEAD ? "OUTCOME_LEADS" : "OUTCOME_SALES", spec: c.src === TPL_LEAD ? SPEC_LEAD : SPEC_PM, status: c.status, creativeId: c.creativeId, campaignDaily: c.campaignDaily });
    },
    copyScaleCampaign: async (src, i) => {
      calls.push(`copy:${src}`);
      nem("copy");
      assert.ok(i.namePrefix.startsWith("[VM scale"), "tên bản sao mang tiền tố của vòng");
      const id = `8${String(++dem).padStart(8, "0")}${src.slice(-1)}`;
      copies.set(id, { src, status: opt.copyStatus ?? "PAUSED", creativeId: "5550001", campaignDaily: 300_000, adsetStatus: "ACTIVE", adStatus: "ACTIVE" });
      return { copiedCampaignId: id, objects: [] };
    },
    createAdCreative: async (_acc, i) => {
      calls.push("createAdCreative");
      nem("creative");
      const ld = i.objectStorySpec.link_data as Record<string, unknown>;
      assert.equal(ld.image_hash, "csc-hash", "bài scale dùng ảnh của mẫu thắng");
      return { id: `66${++dem}`, effectiveObjectStoryId: "" };
    },
    setScaleAdCreative: async (adId, creativeId) => {
      calls.push(`setAdCreative:${adId}`);
      nem("setAdCreative");
      const c = [...copies.entries()].find(([cid]) => adId === `${cid}2`);
      if (c) c[1].creativeId = creativeId;
    },
    setScaleDailyBudget: async (id, minor) => {
      calls.push(`budget:${id}:${minor}`);
      nem("budget");
      const c = copies.get(id);
      if (c) c.campaignDaily = minor;
    },
    setScaleStatus: async (id, status) => {
      calls.push(`status:${id}:${status}`);
      if (status === "ACTIVE" && opt.failOn === "activate-adset" && id.length === 11 && id.endsWith("1")) throw new Error("Facebook: lỗi giả khi bật nhóm");
      const c = copies.get(id);
      if (c) c.status = status;
    },
  };
  return { writer, calls, copies };
}

async function donDep(db: Db) {
  const d = schema.creativeScaleDrafts;
  await db.delete(schema.creativeFbActions).where(like(schema.creativeFbActions.batchId, `${P}%`));
  await db.delete(d).where(like(d.batchId, `${P}%`));
  await db.delete(schema.creativeVariants).where(like(schema.creativeVariants.batchId, `${P}%`));
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

export async function testCreativeScaleDb(db: Db) {
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  await donDep(db);
  try {
    const cfg = JSON.stringify({ pageId: PAGE, adAccountId: ACC, scaleTemplates: { purchaseMessagingCampaignId: TPL_PM, leadsCampaignId: TPL_LEAD } });
    await db.insert(schema.settings).values({ key: CREATIVE_CONFIG_KEY, value: cfg }).onConflictDoUpdate({ target: schema.settings.key, set: { value: cfg } });
    await db.insert(schema.users).values([
      { id: `${P}user-a`, email: `${P}a@t.local`, name: "Người duyệt A", role: "ADMIN", passwordHash: "x", active: true },
      { id: `${P}user-b`, email: `${P}b@t.local`, name: "Người B", role: "ADMIN", passwordHash: "x", active: true },
    ]);
    const A = { id: `${P}user-a`, label: "Người duyệt A" };
    const B = { id: `${P}user-b`, label: "Người B" };

    const start = new Date("2031-05-10T06:00:00+07:00");
    const now = new Date(start.getTime() + 5 * 86_400_000);
    await db.insert(schema.creativeBatches).values({
      id: `${P}batch`,
      batchDay: "2031-05-10",
      status: "PUBLISHED",
      startAt: start,
      endAt: new Date(start.getTime() + 86_400_000),
      approvalDeadline: new Date(start.getTime() - 1_800_000),
      ruleVersion: 1,
      approvalDigest: "csc-digest",
      approvedAt: new Date(start.getTime() - 3_600_000),
    });
    // Mẫu THẮNG (đã vào thư viện) và mẫu KHÔNG đủ căn cứ (chưa có số chi, không luật giữ).
    await db.insert(schema.creativeVariants).values([
      { id: `${P}win`, batchId: `${P}batch`, slot: 1, mode: "EXPLORE", genes: {}, genesVersion: 1, primaryText: "Váy lụa mới về", headline: "Giảm 20%", status: "ENDED", fbAdId: `${P}ad-win`, fbImageHash: "csc-hash", libraryAt: now, libraryOrders: 120 },
      { id: `${P}meh`, batchId: `${P}batch`, slot: 2, mode: "EXPLORE", genes: {}, genesVersion: 1, primaryText: "Áo", headline: "", status: "ENDED", fbAdId: `${P}ad-meh`, fbImageHash: "csc-hash-2" },
    ]);
    const D = schema.creativeScaleDrafts;
    const draftOf = async (variantId: string, kind: string) => (await db.select().from(D).where(and(eq(D.variantId, variantId), eq(D.kind, kind))))[0];
    const so = async () => db.select().from(schema.creativeFbActions).where(eq(schema.creativeFbActions.batchId, `${P}batch`));

    // ── 1. ĐỀ NGHỊ: hai dòng (hai loại), chạy lại không đẻ thêm, mẫu không đủ căn cứ không được đề nghị ──
    const moi = await proposeScale(db, [
      { variantId: `${P}win`, batchId: `${P}batch`, verdict: "WIN", metrics: {} },
      { variantId: `${P}meh`, batchId: `${P}batch`, verdict: "UNJUDGED", metrics: {} },
    ]);
    assert.equal(moi.length, 2, "mẫu THẮNG ⇒ đúng hai đề nghị (mua qua tin nhắn · khách tiềm năng)");
    assert.equal((await proposeScale(db, [{ variantId: `${P}win`, batchId: `${P}batch`, verdict: "WIN", metrics: {} }])).length, 0, "chạy lại không đẻ dòng thứ hai");
    assert.equal((await so()).length, 0, "đề nghị không ghi sổ Facebook — nó không gọi Facebook");

    // ── 2. CHỐT ENV TẮT / CÔNG TẮC KÉO / MẪU KHÔNG ĐỦ CĂN CỨ ⇒ 0 lời gọi, có dòng DENIED ──
    {
      const g = writerGia();
      const r = await buildScaleDraft(db, { variantId: `${P}win`, kind: "PURCHASE_MESSAGING", actor: A }, now, { writer: g.writer, env: { hardEnabled: false, mode: "COPILOT" }, killSwitch: MO });
      assert.ok(!r.ok && r.denial === "HARD_DISABLED");
      const r2 = await buildScaleDraft(db, { variantId: `${P}win`, kind: "PURCHASE_MESSAGING", actor: A }, now, { writer: g.writer, env: ON, killSwitch: async () => ({ killed: true, reason: "kiểm thử" }) });
      assert.ok(!r2.ok && r2.denial === "KILL_SWITCH");
      await db.insert(D).values({ variantId: `${P}meh`, batchId: `${P}batch`, kind: "LEADS", status: "PROPOSED" });
      const r3 = await buildScaleDraft(db, { variantId: `${P}meh`, kind: "LEADS", actor: A }, now, { writer: g.writer, env: ON, killSwitch: MO });
      assert.ok(!r3.ok && r3.denial === "NOT_WINNER", "mẫu không THẮNG / HỨA HẸN ⇒ không scale");
      assert.deepEqual(g.calls, [], "bị chặn: không một lời gọi Facebook nào, kể cả đọc");
      assert.deepEqual((await so()).map((x) => x.denial).sort(), ["HARD_DISABLED", "KILL_SWITCH", "NOT_WINNER"], "mọi lượt bị chặn đều vào sổ");
      assert.equal((await draftOf(`${P}win`, "PURCHASE_MESSAGING")).status, "PROPOSED", "bị chặn thì đề nghị giữ nguyên, dựng lại được");
    }

    // ── 3. ĐƯỜNG ĐÚNG: sao chép (TẮT) → bài → gắn → ngân sách; KHÔNG một lời bật nào ──
    const g = writerGia();
    const deps: ScaleDeps = { writer: g.writer, env: ON, killSwitch: MO };
    const r = await buildScaleDraft(db, { variantId: `${P}win`, kind: "PURCHASE_MESSAGING", actor: A }, now, deps);
    assert.ok(r.ok, `dựng nháp phải được: ${r.detail}`);
    const dr = await draftOf(`${P}win`, "PURCHASE_MESSAGING");
    const copyId = dr.fbCampaignId ?? "∅";
    assert.deepEqual(
      g.calls,
      [`read:${TPL_PM}`, `copy:${TPL_PM}`, `read:${copyId}`, "createAdCreative", `setAdCreative:${copyId}2`, `budget:${copyId}:${BUDGET}`],
      "đúng thứ tự: đọc mẫu → sao chép → đọc bản sao → bài → gắn → ngân sách (CBO, VND không đổi đơn vị)",
    );
    assert.ok(!g.calls.some((c) => c.endsWith(":ACTIVE")), "dựng nháp KHÔNG bật gì");
    assert.equal(dr.status, "DRAFT");
    assert.equal(dr.dailyBudgetVnd, BUDGET);
    assert.equal(dr.budgetLevel, "CAMPAIGN");
    assert.equal(dr.sourceCampaignId, TPL_PM);
    assert.equal(dr.draftedByUserId, A.id, "quy kết bằng khoá tài khoản (mục 34)");
    const applied = (await so()).filter((x) => x.outcome === "APPLIED");
    assert.deepEqual(applied.map((x) => x.action).sort(), ["COPY_SCALE_CAMPAIGN", "CREATE_SCALE_CREATIVE", "SET_SCALE_AD_CREATIVE", "SET_SCALE_BUDGET"]);
    assert.ok(applied.every((x) => (x.request as Record<string, unknown>).scale_draft_id === dr.id && x.actorUserId === A.id), "mọi dòng mang id nháp + người bấm");
    assert.ok(!JSON.stringify(applied.map((x) => x.request)).includes("access_token"), "sổ KHÔNG BAO GIỜ chứa token");

    // ── 4. KHÔNG NHÁP TRÙNG: bấm lại ⇒ không gọi gì ──
    {
      const g2 = writerGia();
      const r2 = await buildScaleDraft(db, { variantId: `${P}win`, kind: "PURCHASE_MESSAGING", actor: A }, now, { ...deps, writer: g2.writer });
      assert.ok(!r2.ok);
      assert.deepEqual(g2.calls, [], "nháp đã dựng: bấm lại không sao chép lần hai");
    }

    // ── 5. HỎNG GIỮA CHỪNG ⇒ bản sao vẫn TẮT, id bản sao được ghi, không dựng lại, bỏ qua được ──
    {
      const gh = writerGia({ failOn: "setAdCreative" });
      const rh = await buildScaleDraft(db, { variantId: `${P}win`, kind: "LEADS", actor: A }, now, { ...deps, writer: gh.writer });
      assert.ok(!rh.ok);
      const dh = await draftOf(`${P}win`, "LEADS");
      assert.equal(dh.status, "FAILED");
      assert.ok(dh.fbCampaignId && dh.error.includes(dh.fbCampaignId) && dh.error.includes("TẮT"), `lỗi phải ghi id bản sao để xoá tay — "${dh.error}"`);
      assert.ok(!gh.calls.some((c) => c.includes(":ACTIVE")), "hỏng giữa chừng: KHÔNG một lời bật nào");
      assert.equal([...gh.copies.values()][0]?.status, "PAUSED", "bản sao trên Facebook vẫn TẮT");
      assert.ok((await so()).some((x) => x.action === "SET_SCALE_AD_CREATIVE" && x.outcome === "FAILED"), "bước hỏng vào sổ FAILED");
      const g3 = writerGia();
      const r3 = await buildScaleDraft(db, { variantId: `${P}win`, kind: "LEADS", actor: A }, now, { ...deps, writer: g3.writer });
      assert.ok(!r3.ok && g3.calls.length === 0, "đã sao chép rồi hỏng ⇒ KHÔNG sao chép lần hai (có thể đã có bản sao mồ côi)");
      const bo = await dismissScaleDraft(db, { draftId: dh.id, actor: A }, now);
      assert.ok(bo.ok && bo.detail.includes(dh.fbCampaignId), "bỏ qua nói ra bản sao còn nằm trên Ads Manager");
    }

    // ── 6. BẢN SAO ĐỌC VỀ ĐANG BẬT (không nên xảy ra) ⇒ tắt ngay, dừng ──
    {
      await db.insert(D).values({ variantId: `${P}meh`, batchId: `${P}batch`, kind: "PURCHASE_MESSAGING", status: "PROPOSED" });
      await db.update(schema.creativeVariants).set({ libraryAt: now, libraryOrders: 101 }).where(eq(schema.creativeVariants.id, `${P}meh`));
      const gb = writerGia({ copyStatus: "ACTIVE" });
      const rb = await buildScaleDraft(db, { variantId: `${P}meh`, kind: "PURCHASE_MESSAGING", actor: A }, now, { ...deps, writer: gb.writer });
      assert.ok(!rb.ok);
      assert.ok(gb.calls.some((c) => c.endsWith(":PAUSED")), "bản sao đang bật ⇒ máy xin tắt ngay");
      assert.ok(!gb.calls.includes("createAdCreative"), "và không dựng tiếp");
      assert.equal((await draftOf(`${P}meh`, "PURCHASE_MESSAGING")).status, "FAILED");
    }

    // ── 7. BẬT: phiếu của A, người B dùng ⇒ chặn; nội dung đổi sau phiếu ⇒ chặn; Facebook bị sửa ⇒ chặn ──
    const de = await scaleLaunchProposal(db, dr.id, A.id, now, deps);
    assert.ok(!("error" in de) && de.ticket, `đề nghị bật phải có phiếu: ${"error" in de ? de.error : de.blocked}`);
    if ("error" in de || !de.ticket) throw new Error("không có phiếu");
    assert.ok(verifyActionToken(de.ticket, A.id, SCALE_ACTIVATE_TOOL, de.payload));
    {
      const gx = writerGia();
      gx.copies.set(copyId, { ...g.copies.get(copyId)!, src: TPL_PM });
      const rb = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: B }, now, { ...deps, writer: gx.writer });
      assert.ok(!rb.ok && rb.denial === "NOT_APPROVED", "phiếu của A không bật được dưới tên B");
      const rs = await activateScaleDraft(db, { draftId: dr.id, signed: { ...de.payload, dailyBudgetVnd: 400_000 }, ticket: de.ticket, actor: A }, now, { ...deps, writer: gx.writer });
      assert.ok(!rs.ok && rs.denial === "NOT_APPROVED", "sửa một con số trên phiếu ⇒ phiếu vô hiệu");
      await db.update(D).set({ dailyBudgetVnd: 400_000 }).where(eq(D.id, dr.id));
      const rm = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: A }, now, { ...deps, writer: gx.writer });
      assert.ok(!rm.ok && rm.denial === "APPROVAL_MISMATCH", "ngân sách trong CSDL đổi sau khi phát phiếu ⇒ không bật");
      await db.update(D).set({ dailyBudgetVnd: BUDGET }).where(eq(D.id, dr.id));
      // Ai đó sửa ngân sách trên Ads Manager sau lúc phát phiếu.
      g.copies.get(copyId)!.campaignDaily = BUDGET * 4;
      const rf = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: A }, now, deps);
      assert.ok(!rf.ok && rf.denial === "APPROVAL_MISMATCH", "Facebook đã khác phiếu ⇒ không bật");
      g.copies.get(copyId)!.campaignDaily = BUDGET;
      assert.ok(!gx.calls.some((c) => c.includes(":ACTIVE")) && !g.calls.some((c) => c.includes(":ACTIVE")), "mọi lượt bị chặn: KHÔNG một lời bật nào");
      assert.equal((await draftOf(`${P}win`, "PURCHASE_MESSAGING")).status, "DRAFT");
    }

    // ── 8. BẬT HỎNG GIỮA CHỪNG (nhóm) ⇒ chiến dịch chưa bao giờ được bật ──
    {
      const gf = writerGia({ failOn: "activate-adset" });
      gf.copies.set(copyId, { ...g.copies.get(copyId)!, src: TPL_PM });
      const rf = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: A }, now, { ...deps, writer: gf.writer });
      assert.ok(!rf.ok);
      assert.ok(!gf.calls.includes(`status:${copyId}:ACTIVE`), "nhóm bật hỏng ⇒ chiến dịch (công tắc tổng) KHÔNG được bật");
      assert.equal((await draftOf(`${P}win`, "PURCHASE_MESSAGING")).status, "DRAFT", "vẫn là nháp — bấm lại được");
    }

    // ── 9. BẬT ĐÚNG: mẩu → nhóm → chiến dịch; bấm lần hai không ghi gì ──
    {
      const before = g.calls.length;
      const ra = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: A }, now, deps);
      assert.ok(ra.ok, ra.detail);
      assert.deepEqual(g.calls.slice(before), [`read:${copyId}`, `status:${copyId}2:ACTIVE`, `status:${copyId}1:ACTIVE`, `status:${copyId}:ACTIVE`], "đọc lại → mẩu → nhóm → chiến dịch cuối cùng");
      const da = await draftOf(`${P}win`, "PURCHASE_MESSAGING");
      assert.equal(da.status, "ACTIVE");
      assert.equal(da.approvedByUserId, A.id);
      const tien = (await so()).filter((x) => x.action === "ACTIVATE_SCALE" && x.outcome === "APPLIED" && x.amountVnd !== null);
      assert.deepEqual(tien.map((x) => x.amountVnd), [BUDGET], "đúng MỘT dòng mang tiền cam kết: lượt bật chiến dịch");
      const soDong = (await so()).length;
      const lan2 = await activateScaleDraft(db, { draftId: dr.id, signed: de.payload, ticket: de.ticket, actor: A }, now, deps);
      assert.ok(lan2.ok && (await so()).length === soDong && g.calls.length === before + 4, "bật lại: không gọi, không ghi (mục 61)");
    }

    // ── 10. TẮT: một lời PAUSED, bấm lại không ghi ──
    {
      const before = g.calls.length;
      const rp = await pauseScaleDraft(db, { draftId: dr.id, actor: A }, now, deps);
      assert.ok(rp.ok);
      assert.deepEqual(g.calls.slice(before), [`status:${copyId}:PAUSED`]);
      assert.equal((await draftOf(`${P}win`, "PURCHASE_MESSAGING")).status, "PAUSED");
      const soDong = (await so()).length;
      await pauseScaleDraft(db, { draftId: dr.id, actor: A }, now, deps);
      assert.equal((await so()).length, soDong, "tắt lại không ghi thêm dòng sổ");
    }

    // Phiếu: payload khoá đủ sáu thứ.
    assert.deepEqual(Object.keys(scaleTicketPayload(dr)).sort(), ["adId", "adsetId", "budgetLevel", "campaignId", "creativeId", "dailyBudgetVnd", "draftId"]);
    // Ràng buộc CSDL: ngân sách một nháp không vượt 500.000đ ngay cả khi mã có lỗi.
    await assert.rejects(db.update(D).set({ dailyBudgetVnd: BUDGET + 1 }).where(inArray(D.id, [dr.id])), "CSDL chặn ngân sách > 500.000đ");
  } finally {
    await donDep(db);
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
  console.log("  ✓ Scale mẫu thắng trên PGlite: đề nghị 0 lời gọi · nháp luôn TẮT · hỏng giữa chừng ghi id bản sao, không dựng lại · phiếu đúng người + đọc lại Facebook · bật mẩu → nhóm → chiến dịch · tắt không ghi hai lần");
}
