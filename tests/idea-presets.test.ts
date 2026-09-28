import assert from "node:assert/strict";
import { IDEA_PRESET_GROUPS, appendIdeaPreset } from "@/lib/constants/idea-presets";
import { MANUAL_GEN } from "@/lib/constants/creative-loop";

/** Gợi ý chọn nhanh ô ý tưởng: nối đúng cụm, không trùng, không vượt trần; nhóm đổi sản phẩm chỉ cho thiết kế mới. */
export function testIdeaPresets() {
  assert.equal(appendIdeaPreset("", "Bối cảnh", "phố cổ Hội An", 1000), "Bối cảnh: phố cổ Hội An");
  const a = appendIdeaPreset("đi biển,", "Mùa / dịp", "mùa hè", 1000);
  assert.equal(a, "đi biển; Mùa / dịp: mùa hè");
  assert.equal(appendIdeaPreset(a, "Mùa / dịp", "mùa hè", 1000), a, "không thêm trùng");
  assert.equal(appendIdeaPreset("x".repeat(995), "Bối cảnh", "phố cổ Hội An", 1000), "x".repeat(995), "không vượt trần ký tự");
  const keys = IDEA_PRESET_GROUPS.map((g) => g.key);
  for (const k of ["model", "background", "fabric", "color", "silhouette", "design", "detail", "season", "light", "trend"]) assert.ok(keys.includes(k), `thiếu nhóm ${k}`);
  assert.ok(IDEA_PRESET_GROUPS.filter((g) => ["fabric", "color", "silhouette", "design", "detail"].includes(g.key)).every((g) => g.scope === "DESIGN"), "nhóm đổi chính sản phẩm chỉ cho thiết kế mới");
  assert.equal(MANUAL_GEN.pickerDefault, 1, "chủ shop 28/09/2026: mặc định chọn 1 ảnh");
  console.log("✓ Gợi ý ý tưởng tạo ảnh: nối cụm không trùng / không vượt trần · nhóm đổi sản phẩm chỉ cho thiết kế mới · mặc định 1 ảnh");
}
