import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { audit, redactSecrets } from "@/lib/audit";
import { auditActionLabel, auditEntityLabel } from "@/lib/constants/audit";

/**
 * NHẬT KÝ TRUY VẾT.
 *
 * Một dòng nhật ký chỉ có ích khi trả lời đủ sáu câu: ai · làm gì · trên cái gì · trước ra sao ·
 * sau ra sao · vì sao. Và tuyệt đối không được chứa bí mật — kho mã này là PUBLIC.
 */
export async function testAuditTrail(db: Db) {
  // ───────── 1. CHE BÍ MẬT trước khi ghi ─────────
  const redacted = redactSecrets({
    token: "abc123",
    apiKey: "k-secret",
    webhookUrl: "https://open.larksuite.com/hook/xyz",
    password: "",
    nested: { access_token: "t", authorization: "Bearer x", ten: "giữ nguyên" },
    soTien: 499_000,
  }) as Record<string, unknown>;
  assert.equal(redacted.token, "***", "token phải bị che");
  assert.equal(redacted.apiKey, "***");
  assert.equal(redacted.webhookUrl, "***", "URL webhook cũng là bí mật");
  assert.equal(redacted.password, "", "trống thì giữ trống — vẫn phải biết là CHƯA CÓ hay ĐÃ CÓ");
  assert.equal((redacted.nested as Record<string, unknown>).access_token, "***", "che cả trong lồng nhau");
  assert.equal((redacted.nested as Record<string, unknown>).authorization, "***");
  assert.equal((redacted.nested as Record<string, unknown>).ten, "giữ nguyên", "trường thường không bị đụng");
  assert.equal(redacted.soTien, 499_000, "số liệu nghiệp vụ phải giữ nguyên để còn đối chiếu");

  // ───────── 2. Sáu câu hỏi phải trả lời được từ chính dòng nhật ký ─────────
  await audit({
    userEmail: "test:audit",
    action: "reconcile.repair",
    entity: "SHIPMENT",
    entityId: "ship-audit-1",
    before: { stage: "PENDING" },
    after: { stage: "DELIVERED" },
    reason: "Dựng lại từ lịch sử sự kiện Viettel Post",
    correlationId: "run-audit-1",
    detail: { token: "phải-bị-che" },
  });
  const [row] = await db
    .select()
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.entityId, "ship-audit-1"))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(1);
  assert.ok(row, "phải ghi được nhật ký");
  const detail = row.detail as Record<string, unknown>;
  assert.equal(row.userEmail, "test:audit", "AI làm");
  assert.equal(row.action, "reconcile.repair", "làm GÌ");
  assert.equal(row.entity, "SHIPMENT", "trên CÁI GÌ");
  assert.deepEqual(detail.before, { stage: "PENDING" }, "TRƯỚC ra sao");
  assert.deepEqual(detail.after, { stage: "DELIVERED" }, "SAU ra sao");
  assert.ok(String(detail.reason).length > 5, "VÌ SAO");
  assert.equal(detail.correlationId, "run-audit-1", "nối được các thay đổi cùng một lần chạy");
  assert.ok(row.createdAt instanceof Date, "thời điểm");
  assert.equal(detail.token, "***", "bí mật lọt vào detail vẫn phải bị che trước khi ghi");

  // ───────── 3. Mọi hành động quan trọng đều có nhãn tiếng Việt ─────────
  for (const action of ["reconcile.repair", "backfill.canonical-state", "webhook.replay", "case.assign", "case.acknowledge", "case.resolve", "STOCK_RECEIPT_CREATE", "COD_RECONCILE"]) {
    assert.notEqual(auditActionLabel(action), action, `hành động ${action} phải có nhãn tiếng Việt`);
  }
  for (const entity of ["SHIPMENT", "ORDER", "NOTIFICATION", "WEBHOOK_EVENT", "STOCK_RECEIPT"]) {
    assert.notEqual(auditEntityLabel(entity), entity, `đối tượng ${entity} phải có nhãn tiếng Việt`);
  }

  // ───────── 4. Các luồng SỬA DỮ LIỆU tự động đều đã để lại dấu vết ─────────
  const actions = await db.selectDistinct({ action: schema.auditLogs.action }).from(schema.auditLogs);
  const seen = new Set(actions.map((a) => a.action));
  for (const required of ["reconcile.repair", "backfill.canonical-state"]) {
    assert.ok(seen.has(required), `luồng ${required} phải để lại nhật ký khi chạy`);
  }

  console.log(
    `✓ Nhật ký truy vết: đủ sáu câu (ai · gì · trên cái gì · trước · sau · vì sao) · nối theo lần chạy · bí mật bị che trước khi ghi · ${seen.size} loại hành động được ghi`,
  );
}
