"""Kiểm thử không gọi mạng: python -m unittest discover -s tests -v"""
import asyncio
import os
import sys
import tempfile
import time
import unittest

os.environ["APP_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import canned_matcher as cm  # noqa: E402
import database as db  # noqa: E402
import knowledge_miner as km  # noqa: E402
import sentiment_analyzer as sa  # noqa: E402
import server  # noqa: E402
import token_tracker as tt  # noqa: E402
from pancake_client import parse_webhook, to_epoch  # noqa: E402


class FakePancake:
    def __init__(self):
        self.sent = []

    def send_message(self, cid, text):
        self.sent.append((cid, text))
        return {"id": f"sent-{len(self.sent)}"}


def run(coro):
    return asyncio.run(coro)


class Base(unittest.TestCase):
    def setUp(self):
        db.init_db()
        with db.tx() as c:
            for t in ("faqs", "messages", "conversations", "bot_replies", "frustration_alerts", "cancel_requests", "token_usage", "settings"):
                c.execute(f"DELETE FROM {t}")
        db.bump_faq_version()
        db.set_settings({"pancake_page_id": "P1", "pancake_page_access_token": "x", "bot_enabled": True, "auto_send": True})
        self.fake = FakePancake()
        server.pancake = lambda: self.fake  # không gọi mạng thật

    def customer_says(self, cid, text, mid):
        db.upsert_conversation({"id": cid, "page_id": "P1", "customer_name": "Lan", "tags": []})
        db.insert_messages([{"id": mid, "conversation_id": cid, "page_id": "P1", "from_id": "C", "from_page": False,
                             "text": text, "created_at": int(time.time()) - 5, "source": "webhook"}])
        return run(server.engine.handle(cid))


class FastPathTest(Base):
    def test_fastpath_match_under_half_second(self):
        db.knowledge_save("faqs", {"question": "Ship về Hà Nội mất bao lâu?", "answer": "Dạ 1–2 ngày ạ",
                                   "variants": ["ship ha noi may ngay", "giao hn bao lau"]})
        db.knowledge_save("faqs", {"question": "Có đổi trả không?", "answer": "Dạ đổi trong 7 ngày ạ"})
        r = cm.matcher.match("ship về hn bao lâu vậy shop")
        self.assertTrue(r["matched"], r)
        self.assertEqual(r["faq"]["answer"], "Dạ 1–2 ngày ạ")
        self.assertLess(r["latency_ms"], 500)

    def test_order_info_never_fastpath(self):
        db.knowledge_save("faqs", {"question": "ship bao lâu", "answer": "1-2 ngày"})
        self.assertFalse(cm.matcher.match("0912 345 678 ship bao lâu")["matched"])

    def test_pii_masked_before_gemini(self):
        self.assertNotIn("0912345678", km.mask_pii("sdt em 0912345678 nha"))


class SentimentTest(Base):
    def test_scores(self):
        self.assertGreater(sa.analyze("SAI RỒI!!! cho gặp người thật")["score"], 70)
        self.assertEqual(sa.analyze("áo này còn size M không ạ")["score"], 0)
        self.assertLessEqual(sa.analyze("ship xa không shop?")["score"], 70)

    def test_frustration_apologises_pauses_and_alerts(self):
        r = self.customer_says("c1", "vớ vẩn, sai rồi!!! cho gặp người thật", "m-1")
        self.assertEqual(r["path"], "frustration")
        self.assertTrue(r["sent"])
        self.assertIn("xin lỗi", self.fake.sent[-1][1])
        self.assertEqual(db.scalar("SELECT bot_paused FROM conversations WHERE id='c1'"), 1)
        self.assertEqual(db.scalar("SELECT COUNT(*) FROM frustration_alerts WHERE conversation_id='c1' AND status='OPEN'"), 1)
        # tin tiếp theo: AI đã tắt ⇒ không trả lời
        self.assertIsNone(self.customer_says("c1", "alo", "m-2"))

    def test_pause_and_alert_even_in_suggestion_mode(self):
        db.set_settings({"auto_send": False})
        r = self.customer_says("c2", "SAI RỒI!!! gặp người thật", "m-3")
        self.assertFalse(r["sent"])
        self.assertEqual(db.scalar("SELECT bot_paused FROM conversations WHERE id='c2'"), 1)
        self.assertEqual(db.scalar("SELECT apology_sent FROM frustration_alerts WHERE conversation_id='c2'"), 0)


class RetentionTest(Base):
    def test_ask_offer_then_firm_cancel(self):
        r = self.customer_says("r1", "hủy đơn giúp mình", "m-1")
        self.assertEqual((r["path"], r["retention"]["step"]), ("retention", "ask_reason"))
        r = self.customer_says("r1", "đắt quá, phí ship cao", "m-2")
        self.assertEqual(r["retention"]["step"], "offer_price")
        self.assertIn("GIẢM 30K", r["answer"])
        r = self.customer_says("r1", "vẫn hủy", "m-3")
        self.assertEqual(r["retention"]["step"], "cancel_confirmed")
        self.assertEqual(db.scalar("SELECT status FROM cancel_requests WHERE conversation_id='r1'"), "CANCEL_REQUESTED")

    def test_reason_in_first_message_and_accept(self):
        r = self.customer_says("r2", "thôi khỏi gửi, sợ mặc không vừa", "m-1")
        self.assertEqual(r["retention"]["step"], "offer_size")
        r = self.customer_says("r2", "ok vậy lấy nhé", "m-2")
        self.assertEqual(r["retention"]["step"], "retained")
        self.assertEqual(db.scalar("SELECT status FROM cancel_requests WHERE conversation_id='r2'"), "RETAINED")

    def test_suggestion_mode_only_flags_staff(self):
        db.set_settings({"auto_send": False})
        self.customer_says("r3", "tôi không lấy nữa", "m-1")
        self.assertEqual(db.scalar("SELECT status FROM cancel_requests WHERE conversation_id='r3'"), "DETECTED")
        self.assertEqual(self.fake.sent, [])

    def test_simulate_writes_no_state(self):
        run(server.engine.answer("hủy đơn giúp mình", conversation_id=None, simulate=True))
        self.assertEqual(db.scalar("SELECT COUNT(*) FROM cancel_requests"), 0)


class GuardrailAndWebhookTest(Base):
    def test_budget_blocks_gemini(self):
        db.set_settings({"daily_budget_usd": 0.001, "gemini_api_key": "k"})
        tt.record_usage("reply", "gemini-2.5-flash", 10000, 1000)
        self.assertTrue(tt.guardrail_status()["blocked"])
        self.assertRaises(tt.BudgetExceeded, tt.check_budget)

    def test_unknown_model_cost_is_none_not_zero(self):
        self.assertIsNone(tt.cost_usd("model-la", 1000, 1000))

    def test_webhook_parse_and_dedupe(self):
        payload = {"event_type": "messaging", "page_id": "P1", "data": {
            "conversation": {"id": "w1", "from": {"id": "C", "name": "Hoa"}, "tags": []},
            "message": {"id": "mm1", "message": "<div>alo shop</div>", "from": {"id": "C"}, "inserted_at": "2026-10-01T03:00:00"}}}
        p = parse_webhook(payload)
        self.assertEqual(p["message"]["text"], "alo shop")
        self.assertEqual(p["message"]["created_at"], to_epoch("2026-10-01T03:00:00Z"))
        db.upsert_conversation(p["conversation"])
        self.assertEqual(db.insert_messages([p["message"]]), 1)
        self.assertEqual(db.insert_messages([p["message"]]), 0)


if __name__ == "__main__":
    unittest.main()
