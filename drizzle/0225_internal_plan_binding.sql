-- ═══════════ PHASE 14 — GÓI CỦA WORKSPACE NHÀ LÀ DỮ LIỆU, KHÔNG PHẢI NHÁNH MÃ (docs/saas/ENTITLEMENTS.md) ═══════════
--
-- Trước bản này `planKeyOf` tự gán gói `internal` cho nhà (`if (org.isHome)`), còn cột `platform_organizations.plan` của
-- nhà để trống. Nay mọi workspace — kể cả nhà — lấy gói từ ĐÚNG cột ấy rồi đi chung một đường: gói → ghi đè
-- (`platform_org_pricing`) → giữ từ trước. Migration này chỉ GHI LẠI THÀNH DỮ LIỆU đúng cái gói mã cũ tự gán, để deploy
-- không đổi một quyết định nào của nhà (bài so trước / sau: `tests/saas-internal-plan.test.ts`).
--
-- KHÔNG gieo, KHÔNG sửa, KHÔNG mở rộng gói nào (`platform_plans` không bị đụng — bảng giá là việc của sứ mệnh
-- saas-d-pricing-overage). Chỉ ghi khi cột còn TRỐNG: gói đã được ai gán cho nhà (kể cả phase D chạy trước) giữ nguyên.
-- Gán gói khác cho nhà sau này = ghi cột này, không cần sửa resolver (đường ghi có chạy thử là việc của phase D —
-- hôm nay org-plan.ts và đường khớp tiền gia hạn còn chặn đổi gói của nhà).
-- Không workspace khách nào bị đụng; không trần cứng nào được bật. Mọi câu chạy lại được.
INSERT INTO "platform_audit_log" ("id", "target_org_code", "action", "subject", "before", "after", "reason", "source")
SELECT 'audit-0225-home-plan-internal', o."code", 'ORG_PLAN_SET', 'plan', jsonb_build_object('plan', o."plan"), '{"plan":"internal"}'::jsonb,
       'Phase 14: gói của workspace nhà ghi thành dữ liệu (trước đó mã tự gán internal) — hành vi không đổi.', 'MIGRATION'
FROM "platform_organizations" o
WHERE o."is_home" = true AND (o."plan" IS NULL OR btrim(o."plan") = '')
  AND NOT EXISTS (SELECT 1 FROM "platform_audit_log" WHERE "id" = 'audit-0225-home-plan-internal');
--> statement-breakpoint
UPDATE "platform_organizations" SET "plan" = 'internal', "updated_at" = now()
WHERE "is_home" = true AND ("plan" IS NULL OR btrim("plan") = '');
