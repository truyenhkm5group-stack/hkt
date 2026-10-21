/**
 * ═══════════ SỔ ĐỀ XUẤT CÁCH HỎI — HÀM THUẦN (Phần H, 21/10/2026) ═══════════
 * Khoá: cụm đã có / đang chờ / người đã BỎ không bị đề xuất lại; khoá theo (câu mẫu, cụm đã gấp dấu); quá trần chỉ bỏ dòng ĐÃ QUYẾT
 * cũ nhất, KHÔNG BAO GIỜ bỏ dòng đang chờ; đọc lại dữ liệu hỏng thì bỏ dòng hỏng, không đoán.
 */
import assert from "node:assert/strict";
import { addTriggerProposals, capTriggerProposals, parseTriggerProposals, pendingTriggerCount, TRIGGER_PROPOSAL_LIMIT, triggerProposalId, type TriggerProposal } from "@/lib/sales-chatbot/trigger-proposals-shared";

export function testTriggerProposals() {
  const entry = { id: "qr-1", title: "Hỏi giá chả mực", triggers: ["chả mực giá"] };
  const meta = { by: "Bot", at: "2026-10-21T01:00:00.000Z" };
  const a = addTriggerProposals([], entry, ["Chả Mực Giá", "chả mực loại nào ngon", "  ", "chả mực loại nào ngon"], meta);
  assert.deepEqual(a.added.map((p) => p.trigger), ["chả mực loại nào ngon"], "cụm đã có trên câu mẫu (khác hoa thường) / rỗng / trùng trong lượt ⇒ bỏ");
  assert.equal(a.added[0].status, "PENDING");
  assert.equal(a.added[0].id, triggerProposalId("qr-1", "Chả mực loại nào NGON"), "khoá theo cụm đã gấp");
  assert.equal(addTriggerProposals(a.list, entry, ["chả mực loại nào ngon"], meta).added.length, 0, "đang chờ ⇒ không đề xuất lại");
  const rejected = a.list.map((p) => ({ ...p, status: "REJECTED" as const, decidedAt: meta.at, decidedBy: "chu@shop" }));
  assert.equal(addTriggerProposals(rejected, entry, ["chả mực loại nào ngon"], meta).added.length, 0, "người đã BỎ ⇒ máy không đòi lại");
  const removed = a.list.map((p) => ({ ...p, status: "REMOVED" as const }));
  assert.equal(addTriggerProposals(removed, entry, ["chả mực loại nào ngon"], meta).added.length, 1, "đã gỡ (không còn trên câu mẫu) ⇒ được đề xuất lại");
  assert.equal(addTriggerProposals(a.list, { ...entry, id: "qr-2" }, ["chả mực loại nào ngon"], meta).added.length, 1, "câu mẫu khác ⇒ khoá khác");

  // Trần: dòng đang chờ không bao giờ bị bỏ.
  const mk = (i: number, status: TriggerProposal["status"]): TriggerProposal => ({ id: `e:${i}`, entryId: "e", entryTitle: "E", trigger: `cụm ${i}`, at: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, by: "Bot", status, decidedAt: status === "PENDING" ? null : `2026-01-01T00:${String(i % 60).padStart(2, "0")}`, decidedBy: null });
  const many = [...Array.from({ length: TRIGGER_PROPOSAL_LIMIT }, (_, i) => mk(i, i % 2 ? "APPROVED" : "PENDING")), ...Array.from({ length: 20 }, (_, i) => mk(1000 + i, "PENDING"))];
  const capped = capTriggerProposals(many);
  assert.equal(capped.length, TRIGGER_PROPOSAL_LIMIT);
  assert.equal(pendingTriggerCount(capped), pendingTriggerCount(many), "quá trần ⇒ chỉ bỏ dòng đã quyết, mọi dòng đang chờ còn nguyên");

  // Đọc lại: dòng hỏng bị bỏ, không đoán trạng thái.
  const parsed = parseTriggerProposals([{ entryId: "qr-1", trigger: "a b", status: "PENDING", at: "t" }, { entryId: "qr-1", trigger: "c", status: "LẠ" }, null, "x", { trigger: "thiếu câu mẫu", status: "PENDING" }]);
  assert.deepEqual(parsed.map((p) => p.trigger), ["a b"]);
  assert.deepEqual(parseTriggerProposals("không phải mảng"), []);
  console.log("✓ Đề xuất cách hỏi (Phần H): không đề xuất lại cụm có sẵn / đang chờ / đã bỏ · khoá theo cụm đã gấp · trần không bỏ dòng đang chờ · dòng hỏng bị bỏ");
}
