-- Chỉ tạo ràng buộc/hàm/trigger mới; không ghi lại dữ liệu legacy.
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS trước mỗi CREATE TRIGGER.
-- Lý do: docker-entrypoint.sh chạy `drizzle-kit migrate` với `set -e`. Nếu file này lỗi giữa chừng,
-- journal không được ghi nên lần khởi động sau chạy lại từ đầu và `CREATE FUNCTION` sẽ báo
-- "already exists" — container restart vô hạn, không bao giờ tự phục hồi.
-- Mọi hàm đều cố định search_path để trigger không thể bị chuyển hướng bằng bảng tạm cùng tên.
CREATE OR REPLACE FUNCTION payment_check_target() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE linked_order text;
BEGIN
  IF NEW.shipment_id IS NOT NULL THEN
    SELECT order_id INTO linked_order FROM shipments WHERE id = NEW.shipment_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_SHIPMENT_NOT_FOUND'; END IF;
    IF NEW.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM linked_order THEN
      RAISE EXCEPTION 'PAYMENT_TARGET_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_transactions_target ON payment_transactions;
--> statement-breakpoint
CREATE TRIGGER payment_transactions_target BEFORE INSERT OR UPDATE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION payment_check_target();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_reviews_target ON payment_reviews;
--> statement-breakpoint
CREATE TRIGGER payment_reviews_target BEFORE INSERT ON payment_reviews
FOR EACH ROW EXECUTE FUNCTION payment_check_target();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_protect_shipment_link() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id AND (
    EXISTS (SELECT 1 FROM payment_transactions WHERE shipment_id = OLD.id) OR
    EXISTS (SELECT 1 FROM payment_reviews WHERE shipment_id = OLD.id)
  ) THEN RAISE EXCEPTION 'PAYMENT_SHIPMENT_LINK_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_shipment_link ON shipments;
--> statement-breakpoint
CREATE TRIGGER payment_shipment_link BEFORE UPDATE OF order_id ON shipments
FOR EACH ROW EXECUTE FUNCTION payment_protect_shipment_link();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_transaction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE original payment_transactions%ROWTYPE; actor text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PAYMENT_APPEND_ONLY'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.verification_status <> 'PENDING' OR NEW.verified_at IS NOT NULL OR NEW.verified_by IS NOT NULL THEN
      RAISE EXCEPTION 'PAYMENT_CREATE_PENDING_FIRST';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['verification_status','verified_at','verified_by','reason'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['verification_status','verified_at','verified_by','reason']) THEN
      RAISE EXCEPTION 'PAYMENT_IMMUTABLE_USE_REVERSAL_REPLACEMENT';
    END IF;
    actor := nullif(trim(current_setting('erp.payment_actor', true)), '');
    IF actor IS NULL THEN RAISE EXCEPTION 'PAYMENT_ACTOR_REQUIRED'; END IF;
    IF NOT ((OLD.verification_status = 'PENDING' AND NEW.verification_status IN ('VERIFIED','REJECTED','DISPUTED'))
      OR (OLD.verification_status = 'VERIFIED' AND NEW.verification_status = 'DISPUTED')) THEN
      RAISE EXCEPTION 'PAYMENT_INVALID_TRANSITION';
    END IF;
    IF NEW.verification_status = 'VERIFIED' THEN
      IF NEW.verified_by IS DISTINCT FROM actor OR NEW.verified_at IS NULL THEN RAISE EXCEPTION 'PAYMENT_VERIFIER_REQUIRED'; END IF;
      IF NEW.amount IS NULL THEN RAISE EXCEPTION 'PAYMENT_AMOUNT_REQUIRED'; END IF;
      IF NOT EXISTS (SELECT 1 FROM payment_evidence WHERE transaction_id = NEW.id
        AND payload->>'amountVnd' = NEW.amount::text AND payload->>'direction' = NEW.direction
        AND payload->>'evidenceRole' = CASE WHEN NEW.transaction_type = 'REFUND' THEN 'REFUND'
          WHEN NEW.transaction_type IN ('REVERSAL','ADJUSTMENT') THEN 'CORRECTION' ELSE 'CUSTOMER_PAYMENT' END
      ) THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REQUIRED'; END IF;
    ELSIF NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.verified_by IS DISTINCT FROM OLD.verified_by THEN
      RAISE EXCEPTION 'PAYMENT_VERIFICATION_HISTORY_IMMUTABLE';
    END IF;
    IF NEW.reason IS DISTINCT FROM OLD.reason AND NEW.verification_status NOT IN ('DISPUTED','REJECTED') THEN
      RAISE EXCEPTION 'PAYMENT_REASON_IMMUTABLE';
    END IF;
  END IF;
  IF NEW.transaction_type = 'REVERSAL' THEN
    SELECT * INTO original FROM payment_transactions WHERE id = NEW.reverses_transaction_id FOR SHARE;
    IF NOT FOUND OR original.verified_at IS NULL OR original.transaction_type = 'REVERSAL'
      OR original.amount IS DISTINCT FROM NEW.amount OR original.direction = NEW.direction
      OR original.order_id IS DISTINCT FROM NEW.order_id OR original.shipment_id IS DISTINCT FROM NEW.shipment_id
      OR original.currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'PAYMENT_INVALID_REVERSAL'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_transactions_guard ON payment_transactions;
--> statement-breakpoint
CREATE TRIGGER payment_transactions_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION payment_transaction_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'PAYMENT_APPEND_ONLY'; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_evidence_immutable ON payment_evidence;
--> statement-breakpoint
CREATE TRIGGER payment_evidence_immutable BEFORE UPDATE OR DELETE ON payment_evidence FOR EACH ROW EXECUTE FUNCTION payment_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_reviews_immutable ON payment_reviews;
--> statement-breakpoint
CREATE TRIGGER payment_reviews_immutable BEFORE UPDATE OR DELETE ON payment_reviews FOR EACH ROW EXECUTE FUNCTION payment_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_transactions_no_truncate ON payment_transactions;
--> statement-breakpoint
CREATE TRIGGER payment_transactions_no_truncate BEFORE TRUNCATE ON payment_transactions FOR EACH STATEMENT EXECUTE FUNCTION payment_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_evidence_no_truncate ON payment_evidence;
--> statement-breakpoint
CREATE TRIGGER payment_evidence_no_truncate BEFORE TRUNCATE ON payment_evidence FOR EACH STATEMENT EXECUTE FUNCTION payment_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_reviews_no_truncate ON payment_reviews;
--> statement-breakpoint
CREATE TRIGGER payment_reviews_no_truncate BEFORE TRUNCATE ON payment_reviews FOR EACH STATEMENT EXECUTE FUNCTION payment_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE actor text; operation text; previous jsonb;
BEGIN
  previous := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  IF TG_TABLE_NAME = 'payment_transactions' THEN
    actor := CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by ELSE current_setting('erp.payment_actor', true) END;
    operation := CASE WHEN TG_OP = 'INSERT' THEN 'CREATE'
      WHEN NEW.verification_status = 'DISPUTED' THEN 'DISPUTE'
      WHEN NEW.verification_status = 'VERIFIED' AND NEW.transaction_type = 'REVERSAL' THEN 'REVERSAL'
      WHEN NEW.verification_status = 'VERIFIED' THEN 'VERIFY' ELSE 'REJECT' END;
  ELSIF TG_TABLE_NAME = 'payment_reviews' THEN actor := NEW.reviewed_by; operation := 'REVIEW';
  ELSE actor := NEW.created_by; operation := 'EVIDENCE'; END IF;
  INSERT INTO audit_logs (id, user_email, action, entity, entity_id, detail, created_at)
  VALUES (gen_random_uuid()::text, actor, 'payment.' || lower(operation), TG_TABLE_NAME, NEW.id,
    jsonb_build_object('actor', actor, 'before', previous, 'after', to_jsonb(NEW)), now());
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_transactions_audit ON payment_transactions;
--> statement-breakpoint
CREATE TRIGGER payment_transactions_audit AFTER INSERT OR UPDATE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION payment_audit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_evidence_audit ON payment_evidence;
--> statement-breakpoint
CREATE TRIGGER payment_evidence_audit AFTER INSERT ON payment_evidence FOR EACH ROW EXECUTE FUNCTION payment_audit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_reviews_audit ON payment_reviews;
--> statement-breakpoint
CREATE TRIGGER payment_reviews_audit AFTER INSERT ON payment_reviews FOR EACH ROW EXECUTE FUNCTION payment_audit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_protect_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.entity IN ('payment_transactions','payment_evidence','payment_reviews') THEN RAISE EXCEPTION 'PAYMENT_AUDIT_IMMUTABLE'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_audit_immutable ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER payment_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION payment_protect_audit();
