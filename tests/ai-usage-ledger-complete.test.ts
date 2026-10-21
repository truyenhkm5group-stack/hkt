/**
 * ═══════════ SỔ DÙNG AI KHAI ĐỦ — GIAI ĐOẠN 2A «AI Sales Self-Optimizing» (chủ shop duyệt 21/10/2026) ═══════════
 *
 * Baseline 14 ngày HSLC: 7.848 lời gọi / 4,58 USD (18%) KHÔNG nhãn workload; event_key NULL mọi dòng (không đo được retry / trùng).
 * Khoá:
 *  1. `workload` là trường BẮT BUỘC của AiUsageEntry (TypeScript bắt mọi đường quên) và không đường ghi nào của mã chạy ghi `workload: null`
 *     thẳng; danh sách đóng `AI_USAGE_WORKLOADS` ⊇ danh sách chính sách model; CHECK của lược đồ + migration 0252 khớp ĐÚNG danh sách.
 *  2. Khoá sự kiện `aiCallKey`: lần thử nằm TRONG khoá ⇒ retry là dòng riêng (tiền không mất); chỉ bản sao tuyệt đối bị chặn và ĐƯỢC ĐẾM.
 *  3. SERVE-COMPAT 0252: lược đồ chưa áp (CHECK cũ) ⇒ ghi loại việc mới vẫn ra MỘT dòng tiền, workload NULL — không ném, không mất dòng.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { aiCallKey, duplicateBlockedCount, recordAiUsage } from "@/lib/ai-usage/ledger";
import { AI_USAGE_WORKLOADS, PLATFORM_WORKLOADS } from "@/lib/ai-usage/types";

const ORG = "ledger-2a";
const OLD_CHECK = `"workload" IS NULL OR "workload" IN ('sales_chatbot','order_sync','quick_extract','vision')`;
const listIn = (text: string, marker: string) => {
  const i = text.indexOf(marker);
  assert.ok(i >= 0, `thiếu ${marker}`);
  return [...text.slice(i, text.indexOf(")", text.indexOf("IN (", i) + 4)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

export async function testAiUsageLedgerComplete() {
  // 1 · Hợp đồng mã nguồn.
  const ledger = readFileSync("lib/ai-usage/ledger.ts", "utf8");
  assert.match(ledger, /\n {2}workload: AiUsageWorkload \| null;/, "workload là trường BẮT BUỘC của AiUsageEntry (không `workload?:`)");
  assert.ok(PLATFORM_WORKLOADS.every((w) => (AI_USAGE_WORKLOADS as readonly string[]).includes(w)), "danh sách sổ ⊇ danh sách chính sách model");
  assert.deepEqual(listIn(readFileSync("db/schema.ts", "utf8"), "platform_ai_usage_workload_check").sort(), [...AI_USAGE_WORKLOADS].sort(), "CHECK của lược đồ = AI_USAGE_WORKLOADS");
  assert.deepEqual(listIn(readFileSync("drizzle/0252_ai_usage_workloads.sql", "utf8"), "ADD CONSTRAINT").sort(), [...AI_USAGE_WORKLOADS].sort(), "migration 0252 = AI_USAGE_WORKLOADS");
  const files = execFileSync("git", ["ls-files", "lib", "app", "scripts", "chatbot"], { encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
  const nullWrites: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!src.includes("recordAiUsage(") && !src.includes("recordUsageEvent(")) continue;
    for (const m of src.matchAll(/record(?:AiUsage|UsageEvent)\(\{[^;]*?workload: null\b/g)) nullWrites.push(`${f}: ${m[0].slice(0, 80)}`);
  }
  assert.deepEqual(nullWrites, [], "đường ghi sổ của mã chạy không được khai thẳng `workload: null` — chọn một loại việc trong AI_USAGE_WORKLOADS");

  // 2 · Khoá sự kiện.
  assert.equal(aiCallKey({ workload: "sales_chatbot", scope: "conv-1", turn: 7, round: 1, attempt: 0 }), "sales_chatbot:conv-1:7:1:0");
  assert.equal(aiCallKey({ workload: "followup", scope: null, turn: 2 }), "followup:-:2:0:0", "thiếu hội thoại ⇒ «-», vòng / lần thử mặc định 0");
  const pdb = await getPlatformDb();
  const t = schema.platformAiUsage;
  const wipe = () => pdb.delete(t).where(eq(t.orgCode, ORG));
  const base = { orgCode: ORG, feature: "sales_chatbot" as const, source: "PLATFORM" as const, provider: "fake", model: "m", requests: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.001, status: "OK" as const, actorId: null };
  await wipe();
  try {
    const k0 = aiCallKey({ workload: "followup", scope: "conv-1", turn: 1, attempt: 0 });
    const k1 = aiCallKey({ workload: "followup", scope: "conv-1", turn: 1, attempt: 1 });
    assert.deepEqual(await recordAiUsage({ ...base, workload: "followup", eventKey: k0 }), { recorded: true });
    const blockedBefore = duplicateBlockedCount();
    assert.deepEqual(await recordAiUsage({ ...base, workload: "followup", eventKey: k0 }), { recorded: false }, "bản sao TUYỆT ĐỐI của cùng một lần thử ⇒ chặn");
    assert.equal(duplicateBlockedCount(), blockedBefore + 1, "mỗi lần chặn được ĐẾM");
    assert.deepEqual(await recordAiUsage({ ...base, workload: "followup", eventKey: k1 }), { recorded: true }, "lần thử lại ⇒ dòng RIÊNG, tiền không mất");
    const rows = await pdb.select().from(t).where(eq(t.orgCode, ORG));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.workload === "followup" && r.eventKey?.startsWith("followup:conv-1:1:0:")), JSON.stringify(rows.map((r) => [r.workload, r.eventKey])));

    // 3 · Lược đồ CŨ (0252 chưa áp) ⇒ loại việc mới vẫn ghi được MỘT dòng tiền, nhãn NULL.
    await pdb.execute(sql.raw(`ALTER TABLE platform_ai_usage DROP CONSTRAINT IF EXISTS platform_ai_usage_workload_check`));
    await pdb.execute(sql.raw(`ALTER TABLE platform_ai_usage ADD CONSTRAINT platform_ai_usage_workload_check CHECK (${OLD_CHECK}) NOT VALID`));
    try {
      assert.deepEqual(await recordAiUsage({ ...base, workload: "lessons", ref: "cu" }), { recorded: true }, "lược đồ cũ ⇒ không ném, không mất dòng");
      const old = await pdb.select().from(t).where(eq(t.ref, "cu"));
      assert.ok(old.length === 1 && old[0].workload === null && old[0].costUsd !== null, `dòng tiền còn, nhãn lùi về NULL: ${JSON.stringify(old)}`);
      assert.deepEqual(await recordAiUsage({ ...base, workload: "sales_chatbot", ref: "cu2" }), { recorded: true }, "loại việc cũ vẫn ghi nhãn");
      assert.equal((await pdb.select().from(t).where(eq(t.ref, "cu2")))[0]?.workload, "sales_chatbot");
    } finally {
      await pdb.execute(sql.raw(`ALTER TABLE platform_ai_usage DROP CONSTRAINT IF EXISTS platform_ai_usage_workload_check`));
      await pdb.execute(sql.raw(`ALTER TABLE platform_ai_usage ADD CONSTRAINT platform_ai_usage_workload_check CHECK ("workload" IS NULL OR "workload" IN (${AI_USAGE_WORKLOADS.map((w) => `'${w}'`).join(",")}))`));
    }
    await assert.rejects(() => recordAiUsage({ ...base, workload: "sales_chatbot", status: "LẠ" as never }), /Trạng thái lượt AI lạ/, "lỗi hình dạng khác vẫn ném như cũ");
    console.log("✓ Sổ dùng AI khai đủ (2A): workload bắt buộc + danh sách đóng khớp CHECK / migration · khoá sự kiện: retry là dòng riêng, chỉ bản sao tuyệt đối bị chặn và được đếm · lược đồ cũ lùi nhãn về NULL, không mất dòng tiền");
  } finally {
    await wipe();
  }
}
