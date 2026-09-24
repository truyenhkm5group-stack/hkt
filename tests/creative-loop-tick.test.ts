import assert from "node:assert/strict";
import { eq, inArray, like, notInArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { CreativeNotice } from "@/lib/creative/notify";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import type { CreativeWriter } from "@/lib/creative/publish";
import { evaluateCreatives } from "@/lib/creative/evaluate";
import { vnStartOfDay } from "@/lib/format";

/**
 * ═══════════ VÒNG MẪU — MỘT LƯỢT ═══════════
 *
 * Khoá ba tính chất của `runCreativeLoopTick` (đặc tả `docs/creative-loop.md` §1):
 *  1. Lô quá hạn duyệt ⇒ `EXPIRED` + tin báo — không một đồng nào được chi.
 *  2. Vòng TẮT ⇒ KHÔNG đăng, KHÔNG dựng — một lô đã duyệt nằm chờ cũng không được gọi Facebook.
 *  3. Vòng TẮT vẫn CHẤM (và vẫn tắt theo luật): tắt vòng là "đừng làm gì mới", không phải bỏ mặc
 *     các mẫu đang tiêu tiền.
 *
 * Mốc thời gian tương đối với đồng hồ thật (AGENTS.md mục 50).
 */

const P = "clt-";
const H = 3_600_000;

async function cleanup(db: Db) {
  await db.delete(schema.adSpends).where(like(schema.adSpends.adId, `${P}%`));
  await db.delete(schema.creativeVerdicts).where(like(schema.creativeVerdicts.variantId, `${P}%`));
  await db.delete(schema.creativeFbActions).where(like(schema.creativeFbActions.batchId, `${P}%`));
  await db.delete(schema.creativeVariants).where(like(schema.creativeVariants.batchId, `${P}%`));
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
}

export async function testCreativeLoopTick(db: Db) {
  const now = new Date();
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const prevLearnings = (await db.select({ id: schema.creativeLearnings.id }).from(schema.creativeLearnings)).map((r) => r.id);
  await cleanup(db);
  try {
    await db
      .insert(schema.settings)
      .values({ key: CREATIVE_CONFIG_KEY, value: JSON.stringify({ enabled: false }) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ enabled: false }) } });

    const base = (id: string, start: Date, status: string, extra: Record<string, unknown> = {}) => ({
      id: `${P}${id}`,
      batchDay: vnDay(start),
      status,
      slotCount: 1,
      startAt: start,
      endAt: new Date(start.getTime() + 24 * H),
      approvalDeadline: new Date(start.getTime() - 0.5 * H),
      configSnapshot: { budgetPerVariantVnd: 200_000 },
      ruleVersion: 1,
      ...extra,
    });
    // Lô A: chờ duyệt mà hạn duyệt đã qua 1 giờ. Ngày lô đặt xa trong quá khứ để không đụng lô thật.
    const pastStart = new Date(now.getTime() - 40 * 24 * H);
    await db.insert(schema.creativeBatches).values(base("a", new Date(pastStart.getTime()), "PENDING_APPROVAL", { approvalDeadline: new Date(now.getTime() - H) }));
    // Lô B: đã duyệt, chạy sau 40 ngày nữa — vòng TẮT thì không được đăng.
    const futureStart = new Date(now.getTime() + 40 * 24 * H);
    await db.insert(schema.creativeBatches).values(base("b", futureStart, "APPROVED", { approvedAt: now, approvalDigest: "x" }));

    const notices: CreativeNotice[] = [];
    let fbCalls = 0;
    const writer = new Proxy({} as CreativeWriter, {
      get: () => async () => {
        fbCalls += 1;
        throw new Error("không được gọi Facebook khi vòng TẮT");
      },
    });

    const r = await runCreativeLoopTick(db, now, {
      notify: async (n) => {
        notices.push(n);
      },
      write: { writer },
      evaluate: { writeNarrative: null },
    });

    // 1. Quá hạn ⇒ EXPIRED + tin báo.
    const [a] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, `${P}a`));
    assert.equal(a.status, "EXPIRED");
    assert.ok(r.expired.includes(vnDay(pastStart)));
    assert.ok(notices.some((n) => n.kind === "EXPIRED" && n.batchDay === vnDay(pastStart)));

    // 2. Vòng TẮT ⇒ không đăng, không dựng, không một lời gọi Facebook.
    assert.equal(r.enabled, false);
    assert.deepEqual(r.published, []);
    assert.equal(r.build, null);
    assert.equal(fbCalls, 0);
    const [b] = await db.select().from(schema.creativeBatches).where(eq(schema.creativeBatches.id, `${P}b`));
    assert.equal(b.status, "APPROVED", "lô đã duyệt nằm nguyên chờ vòng BẬT lại");

    // 3. Vòng TẮT vẫn CHẤM.
    assert.ok(r.evaluation, "chấm + tắt chạy ở mọi lượt");

    // Lượt thứ hai: không có gì quá hạn thêm, không báo lại.
    const r2 = await runCreativeLoopTick(db, now, { notify: async (n) => void notices.push(n), write: { writer }, evaluate: { writeNarrative: null } });
    assert.deepEqual(r2.expired, []);
  } finally {
    await cleanup(db);
    // Dòng sổ học mà lượt chấm vừa ghi thuộc về bài kiểm này — dọn để khối khác thấy ngày học trống.
    if (prevLearnings.length) await db.delete(schema.creativeLearnings).where(notInArray(schema.creativeLearnings.id, prevLearnings));
    else await db.delete(schema.creativeLearnings).where(inArray(schema.creativeLearnings.learningDay, [vnDay(now)]));
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
  console.log("✓ Vòng mẫu — một lượt: quá hạn ⇒ EXPIRED + báo · vòng TẮT không đăng/không dựng · vẫn chấm");
}

/**
 * HỒI QUY: mẫu đã được "cho tiêu thêm" vẫn ĐANG CHẠY sau khung gốc của lô.
 *
 * Lỗi đã có thật khi ghép gói (24/09/2026): lượt chấm đọc `batch.endAt` nên chuyển mẫu sang ENDED và
 * THÔI xét luật tắt, trong khi nhóm trên Facebook vẫn tiêu tiền tới hạn mới — tiền chảy không phanh.
 * Hạn hiệu lực phải đọc từ sổ `EXTEND_ADSET` đã áp (`extendedEndAtOf`).
 */
export async function testCreativeExtendedWindow(db: Db) {
  const now = new Date();
  const prevLearnings = (await db.select({ id: schema.creativeLearnings.id }).from(schema.creativeLearnings)).map((r) => r.id);
  await cleanup(db);
  try {
    const start = new Date(now.getTime() - 26 * H); // khung gốc 24 giờ ⇒ đã hết 2 giờ trước
    const kill = { metric: "messages", op: "lt", value: 1, minSpendVnd: 100_000, label: "Tiêu 100K không có tin nhắn" };
    await db.insert(schema.creativeBatches).values({
      id: `${P}ext`,
      batchDay: vnDay(start),
      status: "PUBLISHED",
      slotCount: 1,
      startAt: start,
      endAt: new Date(start.getTime() + 24 * H),
      approvalDeadline: new Date(start.getTime() - 0.5 * H),
      configSnapshot: { budgetPerVariantVnd: 200_000, killRules: [kill] },
      ruleVersion: 1,
      approvedAt: start,
      approvalDigest: "x",
    });
    await db.insert(schema.creativeVariants).values({
      id: `${P}v-ext`,
      batchId: `${P}ext`,
      slot: 1,
      mode: "EXPLORE",
      genes: { angle: "LIFESTYLE", scene: "CAFE", model: "NONE", composition: "SINGLE_HERO", textOverlay: "NONE", palette: "WARM" },
      genesVersion: 1,
      status: "LIVE",
      fbAdsetId: `${P}as-ext`,
      fbAdId: `${P}ad-ext`,
      committedBudgetVnd: 400_000,
      publishedAt: start,
    });
    await db.insert(schema.creativeFbActions).values({
      actionDay: vnDay(start),
      batchId: `${P}ext`,
      variantId: `${P}v-ext`,
      action: "EXTEND_ADSET",
      outcome: "APPLIED",
      amountVnd: 200_000,
      request: { end_time: new Date(now.getTime() + 20 * H).toISOString() },
      mode: "COPILOT",
    });
    await db.insert(schema.adSpends).values({
      platform: "FACEBOOK",
      campaign: "CLT test",
      campaignId: "clt-camp",
      grain: "AD",
      adId: `${P}ad-ext`,
      adsetId: `${P}as-ext`,
      spend: 150_000,
      impressions: 4_000,
      clicks: 10,
      messages: 0,
      spendDate: vnStartOfDay(vnDay(now)),
      createdBy: "test",
    });

    const r = await evaluateCreatives(db, now, { writeNarrative: null });
    const [v] = await db.select({ status: schema.creativeVariants.status }).from(schema.creativeVariants).where(eq(schema.creativeVariants.id, `${P}v-ext`));
    assert.equal(v.status, "LIVE", "đã tiêu thêm tới hạn mới ⇒ KHÔNG được chuyển ENDED theo khung gốc");
    assert.ok(!r.ended.includes(`${P}v-ext`));
    assert.ok(
      r.kills.some((k) => k.variantId === `${P}v-ext`),
      "đang tiêu tiền theo hạn đã kéo ⇒ luật tắt của lô VẪN phải bắn",
    );
  } finally {
    await cleanup(db);
    if (prevLearnings.length) await db.delete(schema.creativeLearnings).where(notInArray(schema.creativeLearnings.id, prevLearnings));
    else await db.delete(schema.creativeLearnings).where(inArray(schema.creativeLearnings.learningDay, [vnDay(now)]));
  }
  console.log("✓ Vòng mẫu — mẫu đã tiêu thêm: khung hiệu lực đọc từ sổ, không ENDED sớm, luật tắt vẫn bắn");
}
