"""
server.py — Pancake AI Sales Manager: REST API (FastAPI) + webhook Pancake + bộ máy trả lời khách.

Chạy:   python server.py         (mặc định http://127.0.0.1:8800)
Webhook Pancake trỏ tới:  https://<tên-miền-công-khai>/webhook/pancake?secret=<webhook_secret>

Luồng trả lời một tin khách (`ReplyEngine`):
  webhook → lưu tin vào SQLite (local-first) → chờ gom tin (debounce vài giây vì khách hay nhắn nhiều dòng)
    → 0a. Máy phát hiện BỨC XÚC (sentiment_analyzer): điểm > ngưỡng ⇒ xin lỗi, TẮT AI hội thoại, ghi cảnh báo
    → 0b. GIỮ CHÂN / HUỶ ĐƠN (RetentionFlow): hỏi lý do → ưu đãi theo lý do → huỷ văn minh (CANCEL_REQUESTED)
    → 1. Fast-Path: khớp FAQ local (< 0,5 s, 0 token)          → gửi
    → 2. Guardrail: vượt hạn ngạch chi phí?                        → dừng / chỉ Fast-Path
    → 3. Gemini: lịch sử ĐỌC TỪ DB LOCAL + kho tri thức đã học     → gửi (hoặc [HANDOFF] cho nhân viên)
  `auto_send = false` (mặc định) ⇒ chỉ ghi GỢI Ý, không nhắn cho khách — bật khi đã chạy thử ổn.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import threading
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:  # python-dotenv là tuỳ chọn
    pass

import canned_matcher as cm  # noqa: E402
import database as db  # noqa: E402 — phải nạp .env trước (APP_DB_PATH)
import knowledge_miner as km  # noqa: E402
import legacy_import  # noqa: E402
import sentiment_analyzer as sa  # noqa: E402
import token_tracker as tt  # noqa: E402
from canned_matcher import matcher, record_hit  # noqa: E402
from pancake_client import PancakeClient, PancakeError, PancakePosClient, generate_page_token, list_user_pages, parse_webhook  # noqa: E402

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pancake-ai")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
VN = timezone(timedelta(hours=7))

@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    db.init_db()
    km.recover_interrupted_jobs()
    if not db.get_setting("webhook_secret"):
        db.set_settings({"webhook_secret": secrets.token_urlsafe(18)})
    got = legacy_import.auto_import_on_startup()
    if got:
        log.info("Đã tự lấy cấu hình từ bot cũ: %s", got)
    log.info("Pancake AI Sales Manager sẵn sàng — DB: %s", db.DB_PATH)
    yield


app = FastAPI(title="Pancake AI Sales Manager", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ====================================================================== bảo vệ trang quản trị
def require_admin(request: Request) -> None:
    """Đặt ADMIN_TOKEN trong .env khi mở app ra Internet (vd qua tunnel). Chạy riêng trên máy thì có thể bỏ trống."""
    if ADMIN_TOKEN and not secrets.compare_digest(request.headers.get("x-admin-token", ""), ADMIN_TOKEN):
        raise HTTPException(401, "Sai hoặc thiếu mã quản trị (ADMIN_TOKEN)")


admin = [Depends(require_admin)]


# ====================================================================== tiện ích Pancake
_client_cache: dict[str, Any] = {"key": None, "client": None}
_catalog_cache: dict[str, Any] = {"at": 0, "items": None}


def pancake() -> PancakeClient:
    pid, tok = db.get_setting("pancake_page_id"), db.get_setting("pancake_page_access_token")
    if not pid or not tok:
        raise HTTPException(400, "Chưa cấu hình Page ID / Page Access Token (tab Kết nối)")
    key = (pid, tok)
    if _client_cache["key"] != key:
        _client_cache.update(key=key, client=PancakeClient(pid, tok))
    return _client_cache["client"]


def catalog() -> list[dict[str, Any]] | None:
    shop, key = db.get_setting("pancake_shop_id"), db.get_setting("pancake_pos_api_key")
    if not shop or not key:
        return None
    if _catalog_cache["items"] is None or time.time() - _catalog_cache["at"] > 1800:
        try:
            _catalog_cache.update(items=PancakePosClient(shop, key).get_catalog(), at=time.time())
        except Exception as e:  # noqa: BLE001 — thiếu danh mục không được làm hỏng lượt trả lời
            log.warning("Không tải được danh mục POS: %s", e)
            _catalog_cache["at"] = time.time()
    return _catalog_cache["items"]


def tag_text_lookup() -> dict[str, str]:
    return {r["id"]: r["text"] for r in db.rows("SELECT id, text FROM tags")}


def pancake_inbox_url(conversation_id: str) -> str:
    return f"https://pancake.vn/{db.get_setting('pancake_page_id')}?c_id={conversation_id}"


def customer_name(conversation_id: str | None) -> str:
    if not conversation_id:
        return ""
    return db.scalar("SELECT customer_name FROM conversations WHERE id = ?", (conversation_id,)) or ""


def bot_is_live() -> bool:
    return bool(db.get_setting("bot_enabled")) and bool(db.get_setting("auto_send"))


# ====================================================================== giữ chân khách & huỷ đơn
class RetentionFlow:
    """
    Máy trạng thái theo hội thoại, lưu ở bảng `cancel_requests`:
        (khách muốn huỷ) ──► ASKED_REASON ──(nêu lý do)──► OFFERED ──(đồng ý)──► RETAINED
                    │ (đã nêu lý do ngay)          │ (vẫn huỷ)            │ (vẫn huỷ)
                    └────────────► OFFERED         └──────────────► CANCEL_REQUESTED ◄┘
    `decide()` là hàm CHỈ ĐỌC — trạng thái chỉ được ghi (`apply()`) khi câu trả lời THẬT SỰ tới khách,
    nếu không lượt sau sẽ hiểu tin khách theo một câu hỏi khách chưa từng thấy.
    """

    OPEN = ("ASKED_REASON", "OFFERED")

    def open_request(self, conversation_id: str) -> dict[str, Any] | None:
        window = int(db.get_setting("retention_window_hours") or 72) * 3600
        with db.tx() as c:
            c.execute("UPDATE cancel_requests SET status = 'EXPIRED', updated_at = ? WHERE conversation_id = ? AND status IN ('ASKED_REASON','OFFERED') "
                      "AND updated_at < ?", (db.now(), conversation_id, db.now() - window))
        return db.row("SELECT * FROM cancel_requests WHERE conversation_id = ? AND status IN ('ASKED_REASON','OFFERED') ORDER BY id DESC LIMIT 1",
                      (conversation_id,))

    def decide(self, conversation_id: str | None, text: str) -> dict[str, Any] | None:
        open_req = self.open_request(conversation_id) if conversation_id else None
        if open_req is None:
            if not cm.detect_cancel_intent(text):
                return None
            reason = cm.classify_cancel_reason(text)
            if reason != "other":  # khách nói luôn lý do ⇒ đề xuất ưu đãi ngay
                return self._offer(None, reason, text, first_text=text)
            return {"answer": db.get_setting("retention_ask_text"), "step": "ask_reason",
                    "transition": {"id": None, "status": "ASKED_REASON", "first_text": text}}
        if open_req["status"] == "ASKED_REASON":
            if cm.detect_firm_cancel(text):
                return self._cancel(open_req, text)
            if cm.detect_accept(text):
                return {"answer": "Dạ em cảm ơn chị nhiều ạ, em giữ đơn cho chị nhé ❤️", "step": "retained",
                        "transition": {"id": open_req["id"], "status": "RETAINED", "final_text": text}}
            return self._offer(open_req, cm.classify_cancel_reason(text), text)
        # OFFERED
        if cm.detect_accept(text):
            return {"answer": db.get_setting("retention_retained_text"), "step": "retained",
                    "transition": {"id": open_req["id"], "status": "RETAINED", "final_text": text}}
        if cm.detect_firm_cancel(text) or cm.detect_cancel_intent(text):
            return self._cancel(open_req, text)
        return None  # khách hỏi chuyện khác ⇒ để luồng thường trả lời, luồng giữ chân vẫn mở

    def _offer(self, open_req: dict[str, Any] | None, reason: str, text: str, first_text: str | None = None) -> dict[str, Any]:
        offer = db.get_setting(f"retention_offer_{reason}_text") or db.get_setting("retention_offer_other_text")
        return {"answer": offer, "step": f"offer_{reason}",
                "transition": {"id": open_req["id"] if open_req else None, "status": "OFFERED", "reason": reason,
                               "reason_text": text, "offer_text": offer, **({"first_text": first_text} if first_text else {})}}

    def _cancel(self, open_req: dict[str, Any], text: str) -> dict[str, Any]:
        return {"answer": db.get_setting("retention_cancel_text"), "step": "cancel_confirmed",
                "transition": {"id": open_req["id"], "status": "CANCEL_REQUESTED", "final_text": text}}

    def apply(self, conversation_id: str, transition: dict[str, Any]) -> None:
        t = dict(transition)
        req_id, status = t.pop("id"), t.pop("status")
        resolved = db.now() if status in ("RETAINED", "CANCEL_REQUESTED") else None
        with db.tx() as c:
            if req_id is None:
                c.execute(
                    """INSERT INTO cancel_requests(conversation_id, customer_name, status, reason, first_text, reason_text, offer_text,
                                                   created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (conversation_id, customer_name(conversation_id), status, t.get("reason"), t.get("first_text"),
                     t.get("reason_text"), t.get("offer_text"), db.now(), db.now()))
            else:
                fields = {k: v for k, v in t.items() if k in ("reason", "reason_text", "offer_text", "final_text")}
                sets = "".join(f", {k} = ?" for k in fields)
                c.execute(f"UPDATE cancel_requests SET status = ?, updated_at = ?{sets} WHERE id = ?",
                          [status, db.now(), *fields.values(), req_id])
        if resolved:
            log.warning("[%s] Đơn chuyển %s — cần nhân viên xử lý trên POS", conversation_id, status)


retention = RetentionFlow()


# ====================================================================== bộ máy trả lời
class ReplyEngine:
    def __init__(self) -> None:
        self._timers: dict[str, asyncio.Task] = {}
        self._answered_upto: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def schedule(self, conversation_id: str) -> None:
        """Gom tin: mỗi tin mới huỷ hẹn cũ và hẹn lại sau `debounce_seconds`."""
        old = self._timers.get(conversation_id)
        if old and not old.done():
            old.cancel()
        delay = float(db.get_setting("debounce_seconds") or 4)
        self._timers[conversation_id] = asyncio.create_task(self._delayed(conversation_id, delay))

    async def _delayed(self, conversation_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            await self.handle(conversation_id)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("Lỗi xử lý hội thoại %s", conversation_id)

    async def handle(self, conversation_id: str) -> dict[str, Any] | None:
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            if db.scalar("SELECT bot_paused FROM conversations WHERE id = ?", (conversation_id,)):
                return None  # vừa bị tắt AI (khách bức xúc / nhân viên nhận) trong lúc chờ gom tin
            pending = db.pending_customer_messages(conversation_id)
            if not pending:
                return None
            last_id = pending[-1]["id"]
            if self._answered_upto.get(conversation_id) == last_id:
                return None  # đã xử lý đúng các tin này rồi (webhook trùng)
            text = "\n".join(m["text"] for m in pending if m["text"]).strip()
            if not text or text == "[Tệp đính kèm]":
                return None
            result = await self.answer(text, conversation_id=conversation_id, simulate=False)
            self._answered_upto[conversation_id] = last_id
            return result

    async def answer(self, text: str, conversation_id: str | None = None, simulate: bool = False, sandbox: bool = False) -> dict[str, Any]:
        t0 = time.perf_counter()
        guard = tt.guardrail_status()
        out: dict[str, Any] = {"question": text, "path": None, "answer": None, "sent": False, "_sandbox": sandbox}

        # ---- 0a. Bức xúc: ưu tiên cao nhất — khách đang bực thì không bot nào được nói tiếp
        if db.get_setting("frustration_enabled"):
            hist = db.get_history(conversation_id, limit=12) if conversation_id else []
            senti = sa.analyze(text, hist)
            out["sentiment"] = senti
            if senti["score"] > float(db.get_setting("frustration_threshold") or 70):
                out.update(path="frustration", answer=db.get_setting("frustration_apology_text"),
                           note=f"Bức xúc {senti['score']}/100: " + ", ".join(x["label"] for x in senti["signals"]))
                return await self._finish(out, conversation_id, t0, simulate)

        # ---- 0b. Giữ chân khách / huỷ đơn
        if db.get_setting("retention_enabled"):
            decision = retention.decide(conversation_id, text)
            if decision:
                out.update(path="retention", answer=decision["answer"], retention=decision,
                           note=f"Giữ chân: {decision['step']}")
                return await self._finish(out, conversation_id, t0, simulate)

        # ---- 1. Fast-Path
        if not (guard["blocked"] and guard["action"] == "stop_all"):
            m = matcher.match(text)
            out["match"] = {k: m.get(k) for k in ("matched", "score", "reason", "latency_ms", "candidates")}
            if m["matched"]:
                faq = m["faq"]
                out.update(path="fastpath", answer=faq["answer"], faq_id=faq["faq_id"], match_score=m["score"])
                if not simulate:
                    record_hit(faq["faq_id"])
                return await self._finish(out, conversation_id, t0, simulate, saved=tt.avg_reply_cost_usd())

        # ---- 2. Guardrail
        if guard["blocked"]:
            out.update(path="blocked", note="; ".join(guard["reasons"]))
            return await self._finish(out, conversation_id, t0, simulate)

        # ---- 3. Gemini với lịch sử từ DB local
        history: list[dict[str, str]] = []
        if conversation_id:
            limit = int(db.get_setting("history_limit") or 20)
            pending_ids = {m["id"] for m in db.pending_customer_messages(conversation_id)} if not simulate else set()
            for m in db.get_history(conversation_id, limit=limit + len(pending_ids)):
                if m["id"] in pending_ids or not m["text"]:
                    continue
                role = "model" if m["from_page"] else "user"
                if history and history[-1]["role"] == role:
                    history[-1]["text"] += "\n" + m["text"]
                else:
                    history.append({"role": role, "text": m["text"]})
            if history and history[0]["role"] == "model":
                history.insert(0, {"role": "user", "text": "(bắt đầu hội thoại)"})
            if history and history[-1]["role"] == "user":  # phải xen kẽ user/model trước câu hỏi mới
                history.append({"role": "model", "text": "(shop chưa trả lời)"})
        system = await asyncio.to_thread(lambda: km.build_reply_context(text, catalog()))
        try:
            res = await asyncio.to_thread(
                tt.call_gemini, text, purpose="test" if simulate else "reply", system=system, history=history,
                max_output_tokens=int(db.get_setting("max_output_tokens") or 600), conversation_id=conversation_id,
            )
        except tt.BudgetExceeded as e:
            out.update(path="blocked", note=str(e))
            return await self._finish(out, conversation_id, t0, simulate)
        except tt.GeminiError as e:
            out.update(path="error", note=str(e))
            return await self._finish(out, conversation_id, t0, simulate)
        reply = res["text"].strip()
        out.update(tokens={"prompt": res["prompt_tokens"], "output": res["output_tokens"]}, cost_usd=res["cost_usd"])
        if reply.startswith("[HANDOFF]"):
            out.update(path="handoff", note=reply.replace("[HANDOFF]", "").strip() or "AI chuyển nhân viên")
        else:
            out.update(path="gemini", answer=reply)
        return await self._finish(out, conversation_id, t0, simulate)

    async def _finish(self, out: dict[str, Any], conversation_id: str | None, t0: float, simulate: bool, saved: float = 0.0) -> dict[str, Any]:
        if out["answer"] and not simulate and conversation_id and db.get_setting("auto_send") and db.get_setting("bot_enabled"):
            try:
                resp = await asyncio.to_thread(pancake().send_message, conversation_id, out["answer"])
                msg_id = str(resp.get("id") or resp.get("message_id") or (resp.get("message") or {}).get("id") or f"bot-{uuid.uuid4()}")
                db.insert_messages([{
                    "id": msg_id, "conversation_id": conversation_id, "page_id": db.get_setting("pancake_page_id"),
                    "from_id": db.get_setting("pancake_page_id"), "from_name": "Bot AI", "from_page": True,
                    "text": out["answer"], "created_at": db.now(), "source": "bot",
                }])
                out["sent"] = True
            except (PancakeError, HTTPException) as e:
                out["note"] = f"Gửi Pancake lỗi: {getattr(e, 'detail', e)}"
        if not simulate and conversation_id:
            self._after_reply(out, conversation_id)
        elif out.pop("_sandbox", False) and conversation_id and out["path"] == "retention":
            # Chat thử: kịch bản giữ chân phải đi tiếp qua nhiều câu như với khách thật (cuộc chat thử bị loại khỏi mọi danh sách)
            retention.apply(conversation_id, out["retention"]["transition"])
        out.pop("_sandbox", None)
        out["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        with db.tx() as c:
            c.execute(
                """INSERT INTO bot_replies(conversation_id, created_at, path, latency_ms, faq_id, match_score, question, answer, sent,
                                           simulated, est_saved_usd, note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (conversation_id, db.now(), out["path"], out["latency_ms"], out.get("faq_id"), out.get("match_score"),
                 out["question"][:2000], out["answer"], int(out["sent"]), int(simulate), 0.0 if simulate else saved, out.get("note")),
            )
        log.info("[%s] %s %.0fms sent=%s", conversation_id or "simulate", out["path"], out["latency_ms"], out["sent"])
        return out


    def _after_reply(self, out: dict[str, Any], conversation_id: str) -> None:
        """Hệ quả nghiệp vụ của một lượt trả lời THẬT (không chạy khi chạy thử)."""
        if out["path"] == "frustration":
            # Tắt AI + cảnh báo LUÔN xảy ra, kể cả khi bot đang ở chế độ gợi ý (lời xin lỗi khi đó không gửi).
            with db.tx() as c:
                c.execute("UPDATE conversations SET bot_paused = 1 WHERE id = ?", (conversation_id,))
            s = out["sentiment"]
            self._alert(conversation_id, "sentiment", s["score"], s["level"], s["signals"], out["question"], out["sent"])
        elif out["path"] == "handoff":
            self._alert(conversation_id, "handoff", None, None, [{"label": out.get("note") or "AI chuyển nhân viên", "points": 0}],
                        out["question"], False)
        elif out["path"] == "retention":
            tr = out["retention"]["transition"]
            if out["sent"]:
                retention.apply(conversation_id, tr)
            elif tr["id"] is None:
                # Chế độ gợi ý: bot không nhắn nên không đi tiếp kịch bản — báo nhân viên tự giữ chân khách.
                retention.apply(conversation_id, {"id": None, "status": "DETECTED", "first_text": out["question"],
                                                  "reason": tr.get("reason")})

    @staticmethod
    def _alert(conversation_id: str, trigger: str, score: int | None, level: str | None, signals: list[dict[str, Any]],
               text: str, apology_sent: bool) -> None:
        # Một hội thoại chỉ có MỘT cảnh báo đang mở: khách nhắn thêm thì cập nhật dòng cũ, không đẻ dòng mới.
        existing = db.row("SELECT id, score FROM frustration_alerts WHERE conversation_id = ? AND status != 'RESOLVED' ORDER BY id DESC LIMIT 1",
                          (conversation_id,))
        with db.tx() as c:
            if existing:
                c.execute("""UPDATE frustration_alerts SET score = MAX(COALESCE(score, 0), COALESCE(?, 0)), level = COALESCE(?, level),
                             signals_json = ?, customer_text = ?, apology_sent = MAX(apology_sent, ?) WHERE id = ?""",
                          (score, level, json.dumps(signals, ensure_ascii=False), text[:2000], int(apology_sent), existing["id"]))
            else:
                c.execute("""INSERT INTO frustration_alerts(conversation_id, customer_name, trigger, score, level, signals_json, customer_text,
                                                            apology_sent, created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                          (conversation_id, customer_name(conversation_id), trigger, score, level,
                           json.dumps(signals, ensure_ascii=False), text[:2000], int(apology_sent), db.now()))
        log.warning("[%s] CẢNH BÁO %s điểm=%s", conversation_id, trigger, score)


engine = ReplyEngine()


# ====================================================================== đồng bộ danh sách hội thoại (nền)
sync_state: dict[str, Any] = {"running": False, "fetched": 0, "pages": 0, "error": None, "started_at": None, "finished_at": None, "target": 0}


def _sync_worker(max_conversations: int, days: int, fetch_messages: bool, stop_at_phone: int | None = None) -> None:
    sync_state.update(running=True, fetched=0, pages=0, error=None, started_at=db.now(), finished_at=None, target=max_conversations,
                      messages_fetched=0, with_phone=0, stop_at_phone=stop_at_phone, stop_reason=None)
    try:
        client = PancakeClient(db.get_setting("pancake_page_id"), db.get_setting("pancake_page_access_token"))
        try:
            tags = client.get_tags()
            with db.tx() as c:
                for t in tags:
                    c.execute("INSERT INTO tags(id, page_id, text, color) VALUES(?,?,?,?) ON CONFLICT(page_id, id) DO UPDATE SET text=excluded.text, color=excluded.color",
                              (t["id"], client.page_id, t["text"], t.get("color")))
        except PancakeError as e:
            log.warning("Không đọc được nhãn: %s", e)
        try:
            staff = client.get_staff()
            with db.tx() as c:
                for s in staff:
                    c.execute("INSERT INTO staff(id, page_id, name) VALUES(?,?,?) ON CONFLICT(page_id, id) DO UPDATE SET name=excluded.name",
                              (s["id"], client.page_id, s["name"]))
        except PancakeError as e:
            log.warning("Không đọc được danh sách nhân viên: %s", e)
        since = db.now() - days * 86400 if days else None
        last_id = None
        while sync_state["fetched"] < max_conversations and sync_state["running"]:
            convs = client.list_conversations(last_conversation_id=last_id)
            if not convs:
                sync_state["stop_reason"] = "Đã tải hết hội thoại của page"
                break
            for conv in convs:
                db.upsert_conversation(conv)
            sync_state["fetched"] += len(convs)
            sync_state["pages"] += 1
            sync_state["with_phone"] = db.scalar("SELECT COUNT(*) FROM conversations WHERE page_id = ? AND has_phone = 1", (client.page_id,))
            if stop_at_phone and sync_state["with_phone"] >= stop_at_phone:
                sync_state["stop_reason"] = f"Đã đủ {stop_at_phone} hội thoại có SĐT"
                break
            if last_id == convs[-1]["id"]:
                break
            last_id = convs[-1]["id"]
            if since and (convs[-1]["updated_at"] or 0) < since:
                sync_state["stop_reason"] = "Hết hội thoại trong khoảng ngày đã chọn"
                break
        else:
            sync_state["stop_reason"] = sync_state["stop_reason"] or "Đủ số hội thoại tối đa / hết hội thoại"
        if fetch_messages:
            ids = [r["id"] for r in db.rows("SELECT id FROM conversations WHERE page_id = ? AND messages_synced_at IS NULL "
                                            "ORDER BY updated_at DESC LIMIT ?", (client.page_id, max_conversations))]
            for cid in ids:
                if not sync_state["running"]:
                    break
                try:
                    km.ensure_local_history(cid, client)
                    sync_state["messages_fetched"] += 1
                except PancakeError as e:
                    log.warning("Tải tin %s lỗi: %s", cid, e)
    except Exception as e:  # noqa: BLE001
        sync_state["error"] = str(e)
        log.exception("Đồng bộ hội thoại lỗi")
    finally:
        sync_state.update(running=False, finished_at=db.now())


# ====================================================================== schema đầu vào
class SettingsIn(BaseModel):
    values: dict[str, Any]


class SyncIn(BaseModel):
    max_conversations: int = Field(1000, ge=1, le=50000)
    stop_at_phone: int | None = Field(None, ge=1, le=50000)  # dừng khi page đã có đủ N hội thoại có SĐT trong máy
    days: int = Field(90, ge=0, le=3650)
    fetch_messages: bool = False


class FilterIn(BaseModel):
    q: str = ""
    tag: str = ""
    staff: str = ""
    date_from: str | None = None   # YYYY-MM-DD (giờ VN)
    date_to: str | None = None
    only_closed: bool = False
    only_phone: bool = False
    limit: int = Field(100, ge=1, le=5000)


class MiningIn(BaseModel):
    conversation_ids: list[str]
    batch_size: int = 15  # create_job() tự kẹp về 3–30 — nhập 733 thì dùng 30, không báo lỗi


class TextIn(BaseModel):
    text: str
    conversation_id: str | None = None


def _vn_date(s: str | None, end: bool = False) -> int | None:
    if not s:
        return None
    d = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=VN)
    return int((d + timedelta(days=1) - timedelta(seconds=1)).timestamp() if end else d.timestamp())


# ====================================================================== routes: giao diện
@app.get("/")
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "chatbot_manager.html"))


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "app": "pancake-ai-sales-manager", "pid": os.getpid(), "time": db.now(), "auth_required": bool(ADMIN_TOKEN)}


# ---------------------------------------------------------------------- cài đặt & kết nối
@app.get("/api/settings", dependencies=admin)
def get_settings() -> dict[str, Any]:
    return {**db.all_settings(mask_secrets=True), "webhook_path": "/webhook/pancake"}


@app.post("/api/settings", dependencies=admin)
def save_settings(body: SettingsIn) -> dict[str, Any]:
    vals = {k: v for k, v in body.values.items() if not (k in db.SECRET_KEYS and isinstance(v, str) and v.startswith("•"))}
    db.set_settings(vals)
    if "closed_tag_names" in vals:
        db.recompute_closed_flags()
    _catalog_cache.update(items=None, at=0)
    return {"ok": True}


@app.get("/api/webhook-info", dependencies=admin)
def webhook_info(request: Request) -> dict[str, Any]:
    base = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/") or "https://<tên-miền-công-khai>"
    return {"url": f"{base}/webhook/pancake?secret={db.get_setting('webhook_secret')}", "local": str(request.base_url)}


class LegacyIn(BaseModel):
    dir: str | None = None
    page_id: str | None = None
    import_prompt: bool = True


@app.get("/api/legacy/preview", dependencies=admin)
def legacy_preview(dir: str | None = None) -> dict[str, Any]:  # noqa: A002
    """Đọc cấu hình bot cũ (thư mục chatbot/) — token đã CHE, không trả token thật."""
    return legacy_import.preview(dir or None)


@app.post("/api/legacy/import", dependencies=admin)
def legacy_apply(body: LegacyIn) -> dict[str, Any]:
    try:
        res = legacy_import.apply(body.dir or None, body.page_id, body.import_prompt)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _client_cache.update(key=None, client=None)
    _catalog_cache.update(items=None, at=0)
    return res


class UserTokenIn(BaseModel):
    user_token: str = Field(min_length=10)
    page_id: str | None = None
    name: str | None = None


@app.post("/api/pancake/user-pages", dependencies=admin)
def pancake_user_pages(body: UserTokenIn) -> dict[str, Any]:
    """Liệt kê page của tài khoản. User Access Token KHÔNG được lưu."""
    try:
        return {"pages": list_user_pages(body.user_token.strip())}
    except (PancakeError, httpx.HTTPError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/pancake/use-page", dependencies=admin)
def pancake_use_page(body: UserTokenIn) -> dict[str, Any]:
    """Sinh Page Access Token cho page đã chọn, THỬ nó với Pancake rồi mới lưu. User Access Token không được lưu."""
    if not body.page_id:
        raise HTTPException(400, "Chưa chọn page")
    try:
        token = generate_page_token(body.user_token.strip(), body.page_id)
        probe = PancakeClient(body.page_id, token).test_connection()
    except (PancakeError, httpx.HTTPError) as e:
        raise HTTPException(400, str(e)) from e
    vals: dict[str, Any] = {"pancake_page_id": str(body.page_id), "pancake_page_access_token": token}
    if body.name:
        vals["shop_name"] = body.name
    db.set_settings(vals)
    _client_cache.update(key=None, client=None)
    return {"ok": True, "page_id": body.page_id, "name": body.name, **probe}


@app.post("/api/pancake/test", dependencies=admin)
def test_pancake() -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        out["pages"] = pancake().test_connection()
    except PancakeError as e:
        out["pages"] = {"ok": False, "error": str(e)}
    if db.get_setting("pancake_shop_id") and db.get_setting("pancake_pos_api_key"):
        try:
            out["pos"] = PancakePosClient(db.get_setting("pancake_shop_id"), db.get_setting("pancake_pos_api_key")).test_connection()
        except PancakeError as e:
            out["pos"] = {"ok": False, "error": str(e)}
    else:
        out["pos"] = {"ok": None, "error": "Chưa nhập Shop ID + POS API key (tuỳ chọn)"}
    return out


@app.post("/api/gemini/test", dependencies=admin)
def test_gemini() -> dict[str, Any]:
    try:
        r = tt.call_gemini("Trả lời đúng một từ: OK", purpose="test", max_output_tokens=20)
        return {"ok": True, **r}
    except (tt.GeminiError, tt.BudgetExceeded) as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------- hội thoại
@app.post("/api/sync/conversations", dependencies=admin)
def start_sync(body: SyncIn) -> dict[str, Any]:
    pancake()  # kiểm cấu hình
    if sync_state["running"]:
        raise HTTPException(409, "Đang đồng bộ")
    threading.Thread(target=_sync_worker, args=(body.max_conversations, body.days, body.fetch_messages, body.stop_at_phone), daemon=True).start()
    return {"ok": True}


@app.post("/api/sync/stop", dependencies=admin)
def stop_sync() -> dict[str, Any]:
    sync_state["running"] = False
    return {"ok": True}


@app.get("/api/sync/status", dependencies=admin)
def sync_status() -> dict[str, Any]:
    pid = db.get_setting("pancake_page_id")
    return {**sync_state, "page_id": pid, "shop_name": db.get_setting("shop_name"),
            "local_conversations": db.scalar("SELECT COUNT(*) FROM conversations WHERE page_id = ?", (pid,)),
            "local_with_phone": db.scalar("SELECT COUNT(*) FROM conversations WHERE page_id = ? AND has_phone = 1", (pid,)),
            "local_messages": db.scalar("SELECT COUNT(*) FROM messages WHERE page_id = ?", (pid,)),
            "local_with_history": db.scalar("SELECT COUNT(*) FROM conversations WHERE page_id = ? AND messages_synced_at IS NOT NULL", (pid,))}


@app.get("/api/filters", dependencies=admin)
def filters() -> dict[str, Any]:
    pid = db.get_setting("pancake_page_id")
    return {"tags": db.rows("SELECT id, text, color FROM tags WHERE page_id = ? ORDER BY text", (pid,)),
            "staff": db.rows("SELECT id, name FROM staff WHERE page_id = ? ORDER BY name", (pid,))}


@app.get("/api/conversations", dependencies=admin)
def conversations(q: str = "", tag: str = "", staff: str = "", date_from: str | None = None, date_to: str | None = None,
                  only_closed: bool = False, only_phone: bool = False, page: int = 1, page_size: int = Query(50, le=500)) -> dict[str, Any]:
    data = db.list_conversations(q, tag, staff, _vn_date(date_from), _vn_date(date_to, end=True), only_closed, page=page, page_size=page_size,
                                 only_phone=only_phone, page_id=db.get_setting("pancake_page_id"))
    staff_names = {r["id"]: r["name"] for r in db.rows("SELECT id, name FROM staff")}
    tag_txt = tag_text_lookup()
    for it in data["items"]:
        it["staff_names"] = [staff_names.get(a, a) for a in it["assignee_ids"]]
        it["tags"] = [{**t, "text": t.get("text") or tag_txt.get(t.get("id"), t.get("id"))} for t in it["tags"]]
    return data


@app.post("/api/conversations/select", dependencies=admin)
def select_conversations(body: FilterIn) -> dict[str, Any]:
    """Tích chọn hàng loạt: trả về tối đa `limit` (100 / 500 / 1.000…) id hội thoại khớp bộ lọc, mới nhất trước."""
    return db.list_conversations(body.q, body.tag, body.staff, _vn_date(body.date_from), _vn_date(body.date_to, end=True),
                                 body.only_closed, ids_only_limit=body.limit, only_phone=body.only_phone,
                                 page_id=db.get_setting("pancake_page_id"))


@app.get("/api/conversations/{conversation_id}/messages", dependencies=admin)
def conversation_messages(conversation_id: str, refresh: bool = False) -> dict[str, Any]:
    fetched = False
    if refresh:
        db.insert_messages([{**m, "source": "pancake"} for m in pancake().get_all_messages(conversation_id)])
        db.mark_messages_synced(conversation_id)
        fetched = True
    else:
        try:
            fetched = km.ensure_local_history(conversation_id, pancake())
        except (PancakeError, HTTPException) as e:
            log.warning("Không tải được lịch sử %s: %s", conversation_id, e)
    return {"messages": db.get_history(conversation_id, limit=500), "fetched_from_pancake": fetched,
            "conversation": db.row("SELECT * FROM conversations WHERE id = ?", (conversation_id,))}


@app.post("/api/conversations/{conversation_id}/pause", dependencies=admin)
def pause_conversation(conversation_id: str, paused: bool = True) -> dict[str, Any]:
    with db.tx() as c:
        c.execute("UPDATE conversations SET bot_paused = ? WHERE id = ?", (int(paused), conversation_id))
    return {"ok": True}


# ---------------------------------------------------------------------- nạp tri thức
@app.post("/api/mining/jobs", dependencies=admin)
def create_mining_job(body: MiningIn) -> dict[str, Any]:
    if not body.conversation_ids:
        raise HTTPException(400, "Chưa chọn hội thoại nào")
    if not db.get_setting("gemini_api_key"):
        raise HTTPException(400, "Chưa cấu hình Gemini API key")
    running = db.scalar("SELECT COUNT(*) FROM mining_jobs WHERE status IN ('queued','running')")
    if running:
        raise HTTPException(409, "Đang có một lượt nạp tri thức chạy — đợi xong hoặc huỷ")
    return {"job_id": km.create_job(body.conversation_ids, body.batch_size)}


@app.get("/api/mining/estimate", dependencies=admin)
def estimate_mining(n: int = 1000, batch_size: int = 15) -> dict[str, Any]:
    """Ước tính chi phí TRƯỚC khi bấm nạp (nhãn ƯỚC TÍNH): ~900 token vào / hội thoại, ~1.500 token ra / lượt."""
    model = db.get_setting("gemini_model")
    calls = -(-n // max(batch_size, 1))
    c = tt.cost_usd(model, n * 900 + calls * 700, calls * 1500)
    rate = float(db.get_setting("usd_vnd_rate") or 26000)
    return {"estimated": True, "calls": calls, "model": model, "cost_usd": c, "cost_vnd": round(c * rate) if c is not None else None}


@app.get("/api/mining/jobs", dependencies=admin)
def list_jobs() -> list[dict[str, Any]]:
    return db.rows("SELECT id, status, total, processed, batch_size, faqs_added, faqs_merged, scripts_added, templates_added, error, created_at, finished_at "
                   "FROM mining_jobs ORDER BY id DESC LIMIT 50")


@app.get("/api/mining/jobs/{job_id}", dependencies=admin)
def get_job(job_id: int) -> dict[str, Any]:
    j = db.row("SELECT * FROM mining_jobs WHERE id = ?", (job_id,))
    if not j:
        raise HTTPException(404, "Không có lượt nạp này")
    j["log"] = json.loads(j.pop("log_json") or "[]")
    j.pop("conversation_ids_json", None)
    j["cost_usd"] = db.scalar("SELECT SUM(cost_usd) FROM token_usage WHERE job_id = ?", (job_id,))
    j["tokens"] = db.row("SELECT SUM(prompt_tokens) AS prompt, SUM(output_tokens + thinking_tokens) AS output FROM token_usage WHERE job_id = ?", (job_id,))
    return j


@app.post("/api/mining/jobs/{job_id}/cancel", dependencies=admin)
def cancel_job(job_id: int) -> dict[str, Any]:
    km.cancel_job(job_id)
    return {"ok": True}


# ---------------------------------------------------------------------- kho tri thức
def _table(kind: str) -> str:
    if kind not in db.KNOWLEDGE_TABLES:
        raise HTTPException(404, "Loại tri thức không hợp lệ")
    return kind


@app.get("/api/knowledge/{kind}", dependencies=admin)
def knowledge_list(kind: str, q: str = "") -> list[dict[str, Any]]:
    return db.knowledge_list(_table(kind), q)


@app.post("/api/knowledge/{kind}", dependencies=admin)
def knowledge_create(kind: str, body: dict[str, Any]) -> dict[str, Any]:
    return {"id": db.knowledge_save(_table(kind), {**body, "source": "manual"} if kind == "faqs" else body)}


@app.put("/api/knowledge/{kind}/{item_id}", dependencies=admin)
def knowledge_update(kind: str, item_id: int, body: dict[str, Any]) -> dict[str, Any]:
    return {"id": db.knowledge_save(_table(kind), body, item_id)}


@app.delete("/api/knowledge/{kind}/{item_id}", dependencies=admin)
def knowledge_delete(kind: str, item_id: int) -> dict[str, Any]:
    db.knowledge_delete(_table(kind), item_id)
    return {"ok": True}


@app.get("/api/knowledge-export", dependencies=admin)
def knowledge_export() -> JSONResponse:
    data = {k: db.knowledge_list(k) for k in db.KNOWLEDGE_TABLES}
    return JSONResponse(data, headers={"Content-Disposition": "attachment; filename=pancake_ai_knowledge.json"})


@app.post("/api/knowledge-import", dependencies=admin)
def knowledge_import(body: dict[str, Any]) -> dict[str, Any]:
    stats = km.merge_results({"faqs": body.get("faqs") or [], "objection_scripts": body.get("objection_scripts") or [],
                              "closing_templates": body.get("closing_templates") or []}, None)
    return {"ok": True, **stats}


# ---------------------------------------------------------------------- chạy thử & Fast-Path
@app.post("/api/match", dependencies=admin)
def match(body: TextIn) -> dict[str, Any]:
    return matcher.match(body.text)


@app.post("/api/simulate", dependencies=admin)
async def simulate(body: TextIn) -> dict[str, Any]:
    """Chạy đúng bộ máy trả lời nhưng KHÔNG gửi cho khách (gọi Gemini vẫn tính tiền, ghi mục 'test')."""
    return await engine.answer(body.text, conversation_id=body.conversation_id, simulate=True)


@app.post("/api/conversations/{conversation_id}/reply-now", dependencies=admin)
async def reply_now(conversation_id: str) -> dict[str, Any]:
    res = await engine.handle(conversation_id)
    return res or {"path": None, "note": "Không có tin khách nào đang chờ trả lời"}


# ---------------------------------------------------------------------- cảnh báo bức xúc & huỷ đơn
class AlertUpdate(BaseModel):
    status: str = Field(pattern="^(OPEN|IN_PROGRESS|RESOLVED)$")
    handled_by: str | None = None
    note: str | None = None
    resume_bot: bool = False


class CancelUpdate(BaseModel):
    status: str = Field(pattern="^(DONE|RETAINED|CANCEL_REQUESTED|EXPIRED)$")
    handled_by: str | None = None
    note: str | None = None


class SendIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@app.post("/api/sentiment", dependencies=admin)
def sentiment(body: TextIn) -> dict[str, Any]:
    hist = db.get_history(body.conversation_id, limit=12) if body.conversation_id else []
    return {**sa.analyze(body.text, hist), "threshold": db.get_setting("frustration_threshold")}


@app.get("/api/alerts", dependencies=admin)
def alerts(status: str = "active") -> list[dict[str, Any]]:
    cond = ("status != 'RESOLVED'" if status == "active" else "1=1") + " AND a.conversation_id NOT LIKE 'sandbox-%'"
    data = db.rows(f"""SELECT a.*, c.bot_paused, c.snippet FROM frustration_alerts a LEFT JOIN conversations c ON c.id = a.conversation_id
                       WHERE {cond} ORDER BY CASE a.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
                       COALESCE(a.score, 0) DESC, a.id DESC LIMIT 300""")
    for d in data:
        d["signals"] = json.loads(d.pop("signals_json") or "[]")
        d["pancake_url"] = pancake_inbox_url(d["conversation_id"])
    return data


@app.post("/api/alerts/{alert_id}", dependencies=admin)
def update_alert(alert_id: int, body: AlertUpdate) -> dict[str, Any]:
    a = db.row("SELECT conversation_id FROM frustration_alerts WHERE id = ?", (alert_id,))
    if not a:
        raise HTTPException(404, "Không có cảnh báo này")
    with db.tx() as c:
        c.execute("UPDATE frustration_alerts SET status = ?, handled_by = COALESCE(?, handled_by), note = COALESCE(?, note), resolved_at = ? WHERE id = ?",
                  (body.status, body.handled_by, body.note, db.now() if body.status == "RESOLVED" else None, alert_id))
        if body.resume_bot:  # bật lại AI là quyết định của NGƯỜI, không bao giờ tự động
            c.execute("UPDATE conversations SET bot_paused = 0 WHERE id = ?", (a["conversation_id"],))
    return {"ok": True}


@app.get("/api/cancel-requests", dependencies=admin)
def cancel_requests(status: str = "active") -> list[dict[str, Any]]:
    cond = ("status NOT IN ('DONE','EXPIRED')" if status == "active" else "1=1") + " AND conversation_id NOT LIKE 'sandbox-%'"
    data = db.rows(f"""SELECT * FROM cancel_requests WHERE {cond}
                       ORDER BY CASE status WHEN 'CANCEL_REQUESTED' THEN 0 WHEN 'RETAINED' THEN 1 WHEN 'DETECTED' THEN 2 ELSE 3 END, id DESC LIMIT 300""")
    for d in data:
        d["pancake_url"] = pancake_inbox_url(d["conversation_id"])
    return data


@app.post("/api/cancel-requests/{req_id}", dependencies=admin)
def update_cancel_request(req_id: int, body: CancelUpdate) -> dict[str, Any]:
    with db.tx() as c:
        cur = c.execute("UPDATE cancel_requests SET status = ?, handled_by = COALESCE(?, handled_by), note = COALESCE(?, note), updated_at = ?, "
                        "resolved_at = COALESCE(resolved_at, ?) WHERE id = ?",
                        (body.status, body.handled_by, body.note, db.now(), db.now() if body.status == "DONE" else None, req_id))
    if not cur.rowcount:
        raise HTTPException(404, "Không có yêu cầu này")
    return {"ok": True}


@app.get("/api/notifications", dependencies=admin)
def notifications() -> dict[str, Any]:
    return {
        "frustration_open": db.scalar("SELECT COUNT(*) FROM frustration_alerts WHERE status = 'OPEN' AND conversation_id NOT LIKE 'sandbox-%'"),
        "cancel_requested": db.scalar("SELECT COUNT(*) FROM cancel_requests WHERE status = 'CANCEL_REQUESTED' AND conversation_id NOT LIKE 'sandbox-%'"),
        "retained": db.scalar("SELECT COUNT(*) FROM cancel_requests WHERE status = 'RETAINED' AND conversation_id NOT LIKE 'sandbox-%'"),
        "detected": db.scalar("SELECT COUNT(*) FROM cancel_requests WHERE status = 'DETECTED' AND conversation_id NOT LIKE 'sandbox-%'"),
    }


@app.post("/api/conversations/{conversation_id}/send", dependencies=admin)
def staff_send(conversation_id: str, body: SendIn) -> dict[str, Any]:
    """Nhân viên nhắn trực tiếp từ app (đi qua Pancake). Không tự bật lại AI."""
    try:
        resp = pancake().send_message(conversation_id, body.text)
    except PancakeError as e:
        raise HTTPException(502, str(e)) from e
    msg_id = str(resp.get("id") or resp.get("message_id") or f"staff-{uuid.uuid4()}")
    db.insert_messages([{"id": msg_id, "conversation_id": conversation_id, "page_id": db.get_setting("pancake_page_id"),
                         "from_id": db.get_setting("pancake_page_id"), "from_name": "Nhân viên", "from_page": True,
                         "text": body.text, "created_at": db.now(), "source": "staff"}])
    return {"ok": True, "id": msg_id}


# ---------------------------------------------------------------------- chat thử (sandbox)
SANDBOX_PAGE = "SANDBOX"


class SandboxMsg(BaseModel):
    conversation_id: str = Field(pattern=r"^sandbox-[a-f0-9]{8,32}$")
    text: str = Field(min_length=1, max_length=2000)


class TeachIn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    answer: str = Field(min_length=1, max_length=2000)
    category: str = "khac"
    fast_path: bool = True


@app.get("/api/sandbox/info", dependencies=admin)
def sandbox_info() -> dict[str, Any]:
    """Bot đang biết gì về sản phẩm — để người chạy thử hiểu vì sao bot trả lời như vậy."""
    cat = catalog()
    return {
        "shop_name": db.get_setting("shop_name"),
        "gemini_ready": bool(db.get_setting("gemini_api_key")),
        "pos_connected": bool(db.get_setting("pancake_shop_id") and db.get_setting("pancake_pos_api_key")),
        "catalog_products": len(cat) if cat else 0,
        "catalog_sample": [p["name"] for p in (cat or [])[:8]],
        "shop_profile_chars": len(db.get_setting("shop_profile") or ""),
        "faqs": db.scalar("SELECT COUNT(*) FROM faqs WHERE enabled = 1"),
        "scripts": db.scalar("SELECT COUNT(*) FROM objection_scripts WHERE enabled = 1"),
        "templates": db.scalar("SELECT COUNT(*) FROM closing_templates WHERE enabled = 1"),
    }


@app.post("/api/sandbox/new", dependencies=admin)
def sandbox_new() -> dict[str, Any]:
    cid = f"sandbox-{uuid.uuid4().hex[:16]}"
    db.upsert_conversation({"id": cid, "page_id": SANDBOX_PAGE, "customer_name": "Khách thử", "tags": []})
    return {"conversation_id": cid}


@app.post("/api/sandbox/message", dependencies=admin)
async def sandbox_message(body: SandboxMsg) -> dict[str, Any]:
    """Một lượt chat thử: bot trả lời theo ĐÚNG bộ máy thật, nhớ các câu trước, KHÔNG gửi cho khách nào."""
    cid = body.conversation_id
    if not db.row("SELECT 1 FROM conversations WHERE id = ?", (cid,)):
        db.upsert_conversation({"id": cid, "page_id": SANDBOX_PAGE, "customer_name": "Khách thử", "tags": []})
    res = await engine.answer(body.text, conversation_id=cid, simulate=True, sandbox=True)
    now = db.now()
    msgs = [{"id": f"{cid}-c-{uuid.uuid4().hex[:8]}", "conversation_id": cid, "page_id": SANDBOX_PAGE, "from_id": "khach",
             "from_name": "Khách thử", "from_page": False, "text": body.text, "created_at": now, "source": "sandbox"}]
    if res.get("answer"):
        msgs.append({"id": f"{cid}-b-{uuid.uuid4().hex[:8]}", "conversation_id": cid, "page_id": SANDBOX_PAGE, "from_id": "bot",
                     "from_name": "Bot AI", "from_page": True, "text": res["answer"], "created_at": now + 1, "source": "bot"})
    db.insert_messages(msgs)
    return res


@app.post("/api/sandbox/teach", dependencies=admin)
def sandbox_teach(body: TeachIn) -> dict[str, Any]:
    """Dạy bot: câu khách hỏi → câu trả lời đúng. Trùng ý một FAQ có sẵn (≥ 0,85) thì SỬA FAQ đó và thêm cách hỏi này."""
    q, a = body.question.strip(), body.answer.strip()
    hit = matcher.search(q, top_k=1)
    if hit and hit[0]["score"] >= 0.85:
        fid = hit[0]["faq_id"]
        old = db.row("SELECT question, variants_json FROM faqs WHERE id = ?", (fid,))
        variants = json.loads((old or {}).get("variants_json") or "[]")
        if old and q != old["question"] and q not in variants:
            variants.append(q)
        db.knowledge_save("faqs", {"answer": a, "variants": variants, "enabled": 1, "fast_path": int(body.fast_path)}, fid)
        return {"ok": True, "action": "updated", "faq_id": fid, "matched_question": hit[0]["question"]}
    fid = db.knowledge_save("faqs", {"question": q, "answer": a, "category": body.category, "variants": [],
                                     "source": "manual", "enabled": 1, "fast_path": int(body.fast_path)})
    return {"ok": True, "action": "created", "faq_id": fid}


# ---------------------------------------------------------------------- analytics
@app.get("/api/analytics", dependencies=admin)
def analytics(days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    data = tt.analytics(days)
    data["knowledge"] = {
        "faqs": db.scalar("SELECT COUNT(*) FROM faqs WHERE enabled = 1"),
        "faqs_fastpath": db.scalar("SELECT COUNT(*) FROM faqs WHERE enabled = 1 AND fast_path = 1"),
        "scripts": db.scalar("SELECT COUNT(*) FROM objection_scripts WHERE enabled = 1"),
        "templates": db.scalar("SELECT COUNT(*) FROM closing_templates WHERE enabled = 1"),
    }
    return data


# ====================================================================== webhook Pancake
@app.post("/webhook/pancake")
async def webhook(request: Request, background: BackgroundTasks) -> JSONResponse:
    secret = db.get_setting("webhook_secret")
    given = request.query_params.get("secret") or request.headers.get("x-webhook-secret") or ""
    if not secret or not secrets.compare_digest(given, secret):
        return JSONResponse({"ok": False}, status_code=403)
    try:
        payload = await request.json()
    except ValueError:
        return JSONResponse({"ok": True})
    background.add_task(_ingest_webhook, payload)
    return JSONResponse({"ok": True})  # trả 200 ngay, xử lý sau


async def _ingest_webhook(payload: dict[str, Any]) -> None:
    parsed = parse_webhook(payload)
    if not parsed:
        return
    conv, msg = parsed["conversation"], parsed["message"]
    if str(conv["page_id"]) != str(db.get_setting("pancake_page_id")):
        return
    lookup = tag_text_lookup()
    conv["tags"] = [{**t, "text": t.get("text") or lookup.get(t["id"], "")} for t in conv["tags"]]
    db.upsert_conversation(conv)
    if not db.insert_messages([msg]):
        return  # webhook trùng
    if msg["from_page"]:
        return  # tin của shop / nhân viên chỉ lưu lại
    if not db.get_setting("bot_enabled"):
        return
    row = db.row("SELECT bot_paused, tags_json FROM conversations WHERE id = ?", (conv["id"],))
    pause_names = {db._norm(n) for n in db.split_names(db.get_setting("pause_tag_names"))}
    tags = json.loads((row or {}).get("tags_json") or "[]")
    if (row and row["bot_paused"]) or any(db._norm(t.get("text", "")) in pause_names for t in tags):
        return
    engine.schedule(conv["id"])


if __name__ == "__main__":
    import uvicorn

    import socket
    import webbrowser

    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8800"))
    def _busy(p: int) -> bool:
        with socket.socket() as sock:
            return sock.connect_ex(("127.0.0.1", p)) == 0

    if _busy(port):
        # run.bat đã tắt bản cũ của CHÍNH app này (stop_old.ps1); còn bận nghĩa là chương trình khác giữ cổng
        # ⇒ chuyển sang cổng trống kế tiếp thay vì dừng hẳn.
        wanted = port
        port = next((p for p in range(wanted + 1, wanted + 20) if not _busy(p)), 0)
        if not port:
            print(f"\n[LOI] Cong {wanted} va 19 cong ke tiep deu dang bi dung. Doi PORT trong file .env\n")
            raise SystemExit(1)
        print(f"\n[CHU Y] Cong {wanted} dang bi chuong trinh khac dung -> bot chay o cong {port}.")
        print(f"        Webhook / dia chi trinh duyet dung cong {port}. Muon co dinh: dat PORT={port} trong file .env\n")

    def _open_browser_when_ready() -> None:
        """Chỉ mở trình duyệt khi bot ĐÃ trả lời — mở sớm thì trình duyệt báo ERR_CONNECTION_REFUSED."""
        import urllib.request

        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
                webbrowser.open(f"http://127.0.0.1:{port}")
                return
            except OSError:
                time.sleep(0.5)

    if os.environ.get("OPEN_BROWSER", "1") != "0":
        threading.Thread(target=_open_browser_when_ready, daemon=True).start()
    print(f"\n  Bot dang chay tai http://127.0.0.1:{port}  (giu cua so nay mo; dong cua so = tat bot)\n")
    uvicorn.run(app, host=host, port=port, reload=False)
