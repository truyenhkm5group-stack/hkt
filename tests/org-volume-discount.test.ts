/**
 * ops `org-volume-discount` (chủ shop HSLC 10/10/2026 «cài mặc định luôn cho tôi»): đọc tham số nghiêm; chạy thử KHÔNG ghi; --apply ghi
 * ĐÚNG ô volumeDiscount (ô khác giữ nguyên) + nhật ký; ghi lại cùng giá trị ⇒ không ghi; ops-vps khai đủ chỗ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSalesChatbotConfig } from "@/lib/sales-chatbot/engine";
import { SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { parseVolumeArgs, ruleText, saveVolumeDiscountAsOperator } from "@/scripts/org-volume-discount";

export async function testOrgVolumeDiscount() {
  const hslc = parseVolumeArgs(["hslc-hmt-shop", "--unit=1", "--min=2", "--amount=20000", "--mode=PER_STEP"]);
  assert.deepEqual(hslc, { ok: true, args: { code: "hslc-hmt-shop", apply: false, patch: { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" } } }, "không --apply ⇒ chạy thử");
  assert.equal((parseVolumeArgs(["x", "--apply"]) as { args: { apply: boolean } }).args.apply, true);
  assert.equal((parseVolumeArgs(["x", "--off"]) as { args: { patch: { enabled: boolean } } }).args.patch.enabled, false);
  for (const bad of [["--apply"], ["x", "--amount=20k"], ["x", "--mode=ALL"], ["x", "--unit=0"], ["x", "--xoa"], ["X Y"]]) assert.equal(parseVolumeArgs(bad).ok, false, `tham số sai bị từ chối: ${bad.join(" ")}`);
  assert.equal(ruleText({ enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" }), "BẬT · gói 1kg · từ 2kg · giảm 20.000 ₫ · mỗi lần đủ ngưỡng");

  const saved = await getSettingJson<unknown>(SALES_CHATBOT_SETTING_KEY, null);
  try {
    const before = await loadSalesChatbotConfig();
    const rule = { enabled: true, unitGrams: 1000, minWeightGrams: 2000, amount: 20_000, mode: "PER_STEP" as const };
    const op = { orgCode: "home", email: "script org-volume-discount" };
    const dry = await saveVolumeDiscountAsOperator({ rule, operator: op, reason: "bài kiểm", apply: false });
    assert.ok(dry.ok && dry.changed && !dry.written);
    assert.equal((await loadSalesChatbotConfig()).volumeDiscount.enabled, false, "chạy thử không ghi");
    const w = await saveVolumeDiscountAsOperator({ rule, operator: op, reason: "bài kiểm", apply: true });
    assert.ok(w.ok && w.written);
    const after = await loadSalesChatbotConfig();
    assert.deepEqual(after.volumeDiscount, rule);
    assert.deepEqual({ ...after, volumeDiscount: before.volumeDiscount }, before, "mọi ô khác của chủ shop giữ nguyên");
    const again = await saveVolumeDiscountAsOperator({ rule, operator: op, reason: "bài kiểm", apply: true });
    assert.ok(again.ok && !again.changed && !again.written, "cùng giá trị ⇒ không ghi lần hai");
    assert.equal((await saveVolumeDiscountAsOperator({ rule: { ...rule, amount: -1 }, operator: op, reason: "bài kiểm", apply: true })).ok, false, "lược đồ của màn Cấu hình chặn số âm");
  } finally {
    await setSettingJson(SALES_CHATBOT_SETTING_KEY, saved);
  }

  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- org-volume-discount\s+#/);
  assert.match(ops, /DOC_NANG="[^"]*\borg-volume-discount\b/, "không --apply ⇒ lớp ĐỌC; có --apply ⇒ tự sang GHI");
  assert.match(ops, /\n\s+org-volume-discount\)\n[\s\S]*?chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/org-volume-discount\.ts ;;/);
  console.log("✓ ops org-volume-discount: tham số nghiêm · chạy thử không ghi · --apply chỉ ô volumeDiscount + không ghi lại cùng giá trị · ops-vps khai đủ");
}
