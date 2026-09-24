import assert from "node:assert/strict";
import { eq, inArray, like, notInArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import type { CreativeNotice } from "@/lib/creative/notify";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import type { CreativeWriter } from "@/lib/creative/publish";

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
