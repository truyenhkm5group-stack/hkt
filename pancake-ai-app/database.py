"""
database.py — SQLite engine & CRUD cho Pancake AI Sales Manager.

Nguyên tắc LOCAL-FIRST:
  * Mọi hội thoại / tin nhắn lưu theo `conversation_id` trong SQLite trên máy.
  * Khi khách nhắn tin mới, bot đọc lịch sử TỪ ĐÂY — không gọi lại API đọc lịch sử của Pancake.
  * Tin nhắn là append-only, khoá tự nhiên là id tin của Pancake (INSERT OR IGNORE ⇒ webhook trùng
    không nhân đôi dòng).

Mỗi luồng (thread) dùng một kết nối riêng; WAL cho phép đọc song song khi tiến trình nạp tri thức đang ghi.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator

# Biến để trống trong .env (APP_DB_PATH=) cũng coi như chưa đặt
DB_PATH = os.environ.get("APP_DB_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "pancake_ai.db")

_local = threading.local()
PHONE_IN_TEXT = re.compile(r"(?<!\d)(?:\+?84|0)[35789]\d{8}(?!\d)")
_init_lock = threading.Lock()
_initialized = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id                 TEXT PRIMARY KEY,
    page_id            TEXT NOT NULL,
    customer_id        TEXT,
    customer_name      TEXT,
    snippet            TEXT,
    tags_json          TEXT DEFAULT '[]',     -- [{"id": "...", "text": "..."}]
    assignee_ids_json  TEXT DEFAULT '[]',
    updated_at         INTEGER,               -- epoch giây (UTC)
    is_closed_order    INTEGER DEFAULT 0,     -- có nhãn "Đã chốt đơn" (theo cấu hình closed_tag_names)
    has_phone          INTEGER DEFAULT 0,     -- khách đã để lại SĐT (Pancake báo, hoặc thấy trong tin của khách)
    message_count      INTEGER DEFAULT 0,
    messages_synced_at INTEGER,               -- NULL = chưa tải lịch sử về máy
    bot_paused         INTEGER DEFAULT 0,
    created_local_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_closed ON conversations(is_closed_order);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    page_id         TEXT,
    from_id         TEXT,
    from_name       TEXT,
    from_page       INTEGER DEFAULT 0,        -- 1 = shop/nhân viên/bot gửi
    text            TEXT,
    created_at      INTEGER,                  -- epoch giây
    source          TEXT DEFAULT 'pancake'    -- pancake | webhook | bot | suggestion
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tags (
    id      TEXT,
    page_id TEXT,
    text    TEXT,
    color   TEXT,
    PRIMARY KEY (page_id, id)
);

CREATE TABLE IF NOT EXISTS staff (
    id      TEXT,
    page_id TEXT,
    name    TEXT,
    PRIMARY KEY (page_id, id)
);

CREATE TABLE IF NOT EXISTS faqs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    question      TEXT NOT NULL,
    answer        TEXT NOT NULL,
    category      TEXT DEFAULT 'general',
    variants_json TEXT DEFAULT '[]',          -- các cách hỏi khác cùng ý
    source        TEXT DEFAULT 'manual',      -- mined | manual
    enabled       INTEGER DEFAULT 1,
    fast_path     INTEGER DEFAULT 1,          -- 1 = được trả lời thẳng không qua Gemini
    hit_count     INTEGER DEFAULT 0,
    evidence      INTEGER DEFAULT 1,          -- số lần AI gặp lại câu hỏi này khi nạp
    job_id        INTEGER,
    created_at    INTEGER,
    updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS objection_scripts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT DEFAULT 'other',    -- price | shipping | size | trust | other
    customer_concern TEXT NOT NULL,
    response         TEXT NOT NULL,
    rationale        TEXT,
    enabled          INTEGER DEFAULT 1,
    evidence         INTEGER DEFAULT 1,
    job_id           INTEGER,
    created_at       INTEGER,
    updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS closing_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose    TEXT DEFAULT 'phone_address',  -- phone | address | phone_address | confirm
    template   TEXT NOT NULL,
    score      REAL DEFAULT 0,                -- AI chấm 0–10
    notes      TEXT,
    enabled    INTEGER DEFAULT 1,
    job_id     INTEGER,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS mining_jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    status                TEXT DEFAULT 'queued',  -- queued | running | done | failed | cancelled | blocked
    total                 INTEGER DEFAULT 0,
    processed             INTEGER DEFAULT 0,
    batch_size            INTEGER DEFAULT 15,
    faqs_added            INTEGER DEFAULT 0,
    faqs_merged           INTEGER DEFAULT 0,
    scripts_added         INTEGER DEFAULT 0,
    templates_added       INTEGER DEFAULT 0,
    error                 TEXT,
    log_json              TEXT DEFAULT '[]',
    conversation_ids_json TEXT DEFAULT '[]',
    created_at            INTEGER,
    finished_at           INTEGER
);

CREATE TABLE IF NOT EXISTS token_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      INTEGER NOT NULL,
    purpose         TEXT NOT NULL,            -- mining | reply | test
    model           TEXT,
    prompt_tokens   INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    thinking_tokens INTEGER DEFAULT 0,
    cost_usd        REAL DEFAULT 0,
    conversation_id TEXT,
    job_id          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_time ON token_usage(created_at);

CREATE TABLE IF NOT EXISTS bot_replies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    created_at      INTEGER NOT NULL,
    path            TEXT NOT NULL,            -- fastpath | gemini | handoff | blocked | error
    latency_ms      REAL,
    faq_id          INTEGER,
    match_score     REAL,
    question        TEXT,
    answer          TEXT,
    sent            INTEGER DEFAULT 0,        -- 1 = đã gửi qua Pancake, 0 = chỉ gợi ý / chạy thử
    simulated       INTEGER DEFAULT 0,
    est_saved_usd   REAL DEFAULT 0,
    note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_time ON bot_replies(created_at);

-- Cảnh báo khách bức xúc: mỗi lần máy phát hiện (điểm > ngưỡng) hoặc AI tự chuyển nhân viên.
CREATE TABLE IF NOT EXISTS frustration_alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    customer_name   TEXT,
    trigger         TEXT DEFAULT 'sentiment',   -- sentiment | handoff
    score           INTEGER,
    level           TEXT,
    signals_json    TEXT DEFAULT '[]',
    customer_text   TEXT,
    apology_sent    INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'OPEN',        -- OPEN | IN_PROGRESS | RESOLVED
    handled_by      TEXT,
    note            TEXT,
    created_at      INTEGER NOT NULL,
    resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON frustration_alerts(status, created_at);

-- Giữ chân khách / huỷ đơn. Ứng dụng KHÔNG sửa đơn trên POS: nhân viên làm theo trạng thái ở đây.
CREATE TABLE IF NOT EXISTS cancel_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    customer_name   TEXT,
    status          TEXT NOT NULL,
        -- ASKED_REASON     bot đã hỏi lý do
        -- OFFERED          bot đã đề xuất ưu đãi giữ chân
        -- RETAINED         khách đồng ý giữ đơn ⇒ nhân viên áp ưu đãi trên POS
        -- CANCEL_REQUESTED khách vẫn huỷ ⇒ nhân viên huỷ đơn trên POS
        -- DETECTED         phát hiện ý định huỷ khi bot đang ở chế độ gợi ý (không tự nhắn) ⇒ nhân viên xử lý
        -- DONE             nhân viên đã xử lý xong trên POS
        -- EXPIRED          khách im lặng quá hạn, luồng giữ chân đóng
    reason          TEXT,                       -- price | size | speed | other
    first_text      TEXT,
    reason_text     TEXT,
    final_text      TEXT,
    offer_text      TEXT,
    handled_by      TEXT,
    note            TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cancel_conv ON cancel_requests(conversation_id, status);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "pancake_page_id": "",
    "pancake_page_access_token": "",
    "pancake_shop_id": "",
    "pancake_pos_api_key": "",
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",
    "webhook_secret": "",
    "closed_tag_names": "Đã chốt đơn, Chốt đơn, Đã chốt, Chốt",
    "pause_tag_names": "Tắt bot, Nhân viên xử lý",
    "shop_name": "Shop",
    "shop_profile": "Shop thời trang online. Giờ làm việc 8h–22h. Phí ship 25.000đ, miễn phí từ 2 sản phẩm.",
    "bot_enabled": False,
    "auto_send": False,               # False = chỉ lưu gợi ý, không gửi cho khách (an toàn khi mới cài)
    "debounce_seconds": 4,
    "history_limit": 20,
    "fastpath_threshold": 0.62,
    "usd_vnd_rate": 26000,
    "daily_budget_usd": 2.0,
    "monthly_budget_usd": 30.0,
    "max_output_tokens": 600,
    "guardrail_action": "fastpath_only",  # fastpath_only | stop_all
    # ---- Máy phát hiện bức xúc
    "frustration_enabled": True,
    "frustration_threshold": 70,
    "frustration_apology_text": "Dạ em xin lỗi chị vì đã làm chị phiền ạ! Em đã chuyển cuộc trò chuyện này cho nhân viên CSKH trực ca hỗ trợ ngay lập tức ạ!",
    # ---- Giữ chân khách & huỷ đơn (các câu ưu đãi là CAM KẾT với khách — chủ shop tự sửa cho đúng chính sách)
    "retention_enabled": True,
    "retention_window_hours": 72,
    "retention_ask_text": "Dạ chị ơi, em hỗ trợ chị ngay ạ. Chị cho em hỏi chút là sản phẩm có điểm nào chị chưa ưng ý hay do lý do gì mà mình muốn hủy đơn vậy ạ? Em muốn nghe góp ý để phục vụ chị tốt hơn ạ ❤️",
    "retention_offer_price_text": "Dạ mẫu này đang rất hot ạ. Để hỗ trợ chị trải nghiệm, shop xin phép áp cho chị mã GIẢM 30K + MIỄN PHÍ SHIP trực tiếp vào đơn này luôn ạ!",
    "retention_offer_size_text": "Dạ nếu chị lo mặc không vừa hay đổi màu khác, shop hỗ trợ đổi size/màu miễn phí tận nhà 100% cho chị luôn ạ!",
    "retention_offer_speed_text": "Dạ em hiểu chị cần hàng sớm ạ. Shop xin phép ưu tiên gửi HỎA TỐC đơn của chị để chị nhận hàng nhanh nhất ạ!",
    "retention_offer_other_text": "Dạ em cảm ơn góp ý của chị ạ. Nếu shop hỗ trợ được gì để chị yên tâm nhận hàng, chị cứ nói em nhé, em muốn giữ đơn giúp chị ạ ❤️",
    "retention_retained_text": "Dạ em cảm ơn chị nhiều ạ! Em đã ghi nhận giữ đơn kèm ưu đãi cho chị, nhân viên sẽ cập nhật vào đơn ngay ạ ❤️",
    "retention_cancel_text": "Dạ vâng em đã tiếp nhận hủy đơn cho chị rồi ạ. Hi vọng shop có cơ hội phục vụ chị ở các mẫu mới tiếp theo ạ. Em cảm ơn chị!",
    # Đơn giá USD / 1 triệu token — sửa theo bảng giá Google hiện hành.
    "pricing_json": {
        "gemini-2.5-flash": {"input": 0.30, "output": 2.50},
        "gemini-2.5-flash-lite": {"input": 0.10, "output": 0.40},
        "gemini-2.5-pro": {"input": 1.25, "output": 10.00},
        "gemini-2.0-flash": {"input": 0.10, "output": 0.40},
    },
}

SECRET_KEYS = {"pancake_page_access_token", "pancake_pos_api_key", "gemini_api_key", "webhook_secret"}


def now() -> int:
    return int(time.time())


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        init_db()
        conn = _connect()
        _local.conn = conn
    return conn


def init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        conn = _connect()
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
        conn.close()
        _initialized = True


# Cột thêm sau bản đầu — DB đã tạo trên máy người dùng không tự có (CREATE TABLE IF NOT EXISTS không thêm cột).
_ADDED_COLUMNS = {
    "conversations": {"has_phone": "INTEGER DEFAULT 0"},
    "mining_jobs": {"failed_ids_json": "TEXT"},  # NULL = bản cũ, không ghi phần lỗi; '[]' = không lỗi
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in _ADDED_COLUMNS.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if not have:  # bảng chưa có — SCHEMA sẽ tạo đủ cột
            continue
        for col, decl in cols.items():
            if col not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_page ON conversations(page_id, updated_at DESC)")


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def rows(sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in get_conn().execute(sql, tuple(params)).fetchall()]


def row(sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    r = get_conn().execute(sql, tuple(params)).fetchone()
    return dict(r) if r else None


def scalar(sql: str, params: Iterable[Any] = ()) -> Any:
    r = get_conn().execute(sql, tuple(params)).fetchone()
    return r[0] if r else None


# ---------------------------------------------------------------- settings
def get_setting(key: str) -> Any:
    r = row("SELECT value FROM settings WHERE key = ?", (key,))
    if r is None:
        env_val = os.environ.get(key.upper())
        if env_val not in (None, ""):
            return _coerce(key, env_val)
        return DEFAULT_SETTINGS.get(key)
    try:
        return json.loads(r["value"])
    except (TypeError, ValueError):
        return r["value"]


def _coerce(key: str, raw: str) -> Any:
    default = DEFAULT_SETTINGS.get(key)
    if isinstance(default, bool):
        return raw.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(default, (int, float)) and not isinstance(default, bool):
        try:
            return type(default)(raw)
        except ValueError:
            return default
    if isinstance(default, dict):
        try:
            return json.loads(raw)
        except ValueError:
            return default
    return raw


def set_settings(values: dict[str, Any]) -> None:
    with tx() as conn:
        for k, v in values.items():
            if k not in DEFAULT_SETTINGS:
                continue
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, json.dumps(v, ensure_ascii=False)),
            )


def all_settings(mask_secrets: bool = True) -> dict[str, Any]:
    out = {}
    for k in DEFAULT_SETTINGS:
        v = get_setting(k)
        if mask_secrets and k in SECRET_KEYS and v:
            s = str(v)
            v = ("•" * 6 + s[-4:]) if len(s) > 8 else "•" * 6
            out[k + "_set"] = True
        elif k in SECRET_KEYS:
            out[k + "_set"] = bool(v)
        out[k] = v
    return out


def split_names(raw: str | None) -> list[str]:
    return [x.strip() for x in str(raw or "").split(",") if x.strip()]


# ---------------------------------------------------------------- conversations & messages
def upsert_conversation(conv: dict[str, Any]) -> None:
    """conv: id, page_id, customer_id, customer_name, snippet, tags (list[{id,text}]), assignee_ids, updated_at."""
    tags = conv.get("tags") or []
    closed_names = {_norm(n) for n in split_names(get_setting("closed_tag_names"))}
    is_closed = int(any(_norm(t.get("text", "")) in closed_names for t in tags))
    with tx() as c:
        c.execute(
            """
            INSERT INTO conversations(id, page_id, customer_id, customer_name, snippet, tags_json, assignee_ids_json,
                                      updated_at, is_closed_order, created_local_at, has_phone)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                customer_id = COALESCE(excluded.customer_id, conversations.customer_id),
                customer_name = COALESCE(NULLIF(excluded.customer_name, ''), conversations.customer_name),
                snippet = COALESCE(excluded.snippet, conversations.snippet),
                tags_json = CASE WHEN excluded.tags_json = '[]' AND ? = 0 THEN conversations.tags_json ELSE excluded.tags_json END,
                assignee_ids_json = CASE WHEN excluded.assignee_ids_json = '[]' THEN conversations.assignee_ids_json
                                         ELSE excluded.assignee_ids_json END,
                updated_at = MAX(COALESCE(conversations.updated_at, 0), COALESCE(excluded.updated_at, 0)),
                has_phone = MAX(COALESCE(conversations.has_phone, 0), excluded.has_phone),  -- chỉ nâng, không hạ
                is_closed_order = CASE WHEN excluded.tags_json = '[]' AND ? = 0 THEN conversations.is_closed_order
                                       ELSE excluded.is_closed_order END
            """,
            (
                str(conv["id"]), str(conv.get("page_id") or ""), conv.get("customer_id"), conv.get("customer_name") or "",
                conv.get("snippet"), json.dumps(tags, ensure_ascii=False), json.dumps(conv.get("assignee_ids") or []),
                conv.get("updated_at"), is_closed, now(), int(bool(conv.get("has_phone"))),
                # tags_authoritative: 1 khi nguồn (danh sách hội thoại) chắc chắn trả đủ nhãn — kể cả rỗng
                int(bool(conv.get("tags_authoritative"))), int(bool(conv.get("tags_authoritative"))),
            ),
        )


def recompute_closed_flags() -> int:
    closed_names = {_norm(n) for n in split_names(get_setting("closed_tag_names"))}
    changed = 0
    with tx() as c:
        for r in c.execute("SELECT id, tags_json, is_closed_order FROM conversations").fetchall():
            tags = json.loads(r["tags_json"] or "[]")
            flag = int(any(_norm(t.get("text", "")) in closed_names for t in tags))
            if flag != r["is_closed_order"]:
                c.execute("UPDATE conversations SET is_closed_order = ? WHERE id = ?", (flag, r["id"]))
                changed += 1
    return changed


def insert_messages(msgs: list[dict[str, Any]]) -> int:
    """Trả về số tin MỚI thực sự được ghi (tin trùng id bị bỏ qua)."""
    if not msgs:
        return 0
    added = 0
    with tx() as c:
        for m in msgs:
            cur = c.execute(
                """INSERT OR IGNORE INTO messages(id, conversation_id, page_id, from_id, from_name, from_page, text, created_at, source)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    str(m["id"]), str(m["conversation_id"]), m.get("page_id"), m.get("from_id"), m.get("from_name"),
                    int(bool(m.get("from_page"))), m.get("text") or "", m.get("created_at") or now(), m.get("source", "pancake"),
                ),
            )
            added += cur.rowcount
            if not m.get("from_page") and PHONE_IN_TEXT.search(re.sub(r"[.\s-]", "", m.get("text") or "")):
                c.execute("UPDATE conversations SET has_phone = 1 WHERE id = ?", (str(m["conversation_id"]),))
        conv_ids = {str(m["conversation_id"]) for m in msgs}
        for cid in conv_ids:
            c.execute(
                "UPDATE conversations SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND source != 'suggestion') WHERE id = ?",
                (cid, cid),
            )
    return added


def mark_messages_synced(conversation_id: str) -> None:
    with tx() as c:
        c.execute("UPDATE conversations SET messages_synced_at = ? WHERE id = ?", (now(), conversation_id))


def get_history(conversation_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """Lịch sử ĐỌC TỪ DB LOCAL (cũ → mới), bỏ các gợi ý chưa gửi."""
    data = rows(
        """SELECT * FROM messages WHERE conversation_id = ? AND source != 'suggestion'
           ORDER BY created_at DESC, rowid DESC LIMIT ?""",
        (conversation_id, limit),
    )
    return list(reversed(data))


def pending_customer_messages(conversation_id: str) -> list[dict[str, Any]]:
    """
    Các tin của khách đứng SAU tin cuối cùng của shop — tức là chưa ai trả lời.
    "Sau" xét theo THỨ TỰ GHI vào DB (rowid) chứ không chỉ theo giờ: tin bot gửi mang giờ máy mình, tin khách mang
    giờ Pancake — lệch đồng hồ vài giây là đủ để một tin đã trả lời bị gom lại lần nữa. Điều kiện giờ (dung sai 60 s)
    chặn chiều ngược lại: lịch sử cũ tải về SAU (rowid lớn) nhưng giờ cũ hơn tin của shop.
    """
    last_page = row(
        """SELECT rowid AS rid, created_at FROM messages WHERE conversation_id = ? AND from_page = 1 AND source != 'suggestion'
           ORDER BY created_at DESC, rowid DESC LIMIT 1""",
        (conversation_id,),
    )
    rid, at = (last_page["rid"], last_page["created_at"] or 0) if last_page else (0, 0)
    data = rows(
        """SELECT * FROM messages WHERE conversation_id = ? AND from_page = 0 AND rowid > ? AND created_at >= ?
           ORDER BY created_at, rowid""",
        (conversation_id, rid, at - 60),
    )
    if data:  # chưa từng có tin shop: chỉ lấy cụm tin gần nhất (6 giờ), không lôi cả lịch sử cũ ra trả lời
        newest = max(m["created_at"] or 0 for m in data)
        data = [m for m in data if (m["created_at"] or 0) >= newest - 6 * 3600][-10:]
    return data


def list_conversations(
    q: str = "", tag: str = "", staff: str = "", date_from: int | None = None, date_to: int | None = None,
    only_closed: bool = False, only_synced: bool = False, page: int = 1, page_size: int = 50, ids_only_limit: int | None = None,
    only_phone: bool = False, page_id: str | None = None,
) -> dict[str, Any]:
    where, params = ["1=1"], []
    if page_id:  # chỉ hội thoại của page đang kết nối — token page khác không đọc được chúng
        where.append("page_id = ?")
        params.append(str(page_id))
    if only_phone:
        where.append("has_phone = 1")
    if q:
        where.append("(customer_name LIKE ? OR snippet LIKE ? OR id LIKE ?)")
        params += [f"%{q}%"] * 3
    if tag:
        where.append("EXISTS (SELECT 1 FROM json_each(conversations.tags_json) t WHERE json_extract(t.value, '$.id') = ? OR json_extract(t.value, '$.text') = ?)")
        params += [tag, tag]
    if staff:
        where.append("EXISTS (SELECT 1 FROM json_each(conversations.assignee_ids_json) a WHERE a.value = ?)")
        params.append(staff)
    if date_from:
        where.append("updated_at >= ?")
        params.append(date_from)
    if date_to:
        where.append("updated_at <= ?")
        params.append(date_to)
    if only_closed:
        where.append("is_closed_order = 1")
    if only_synced:
        where.append("messages_synced_at IS NOT NULL")
    w = " AND ".join(where)
    if ids_only_limit is not None:
        ids = [r["id"] for r in rows(f"SELECT id FROM conversations WHERE {w} ORDER BY updated_at DESC LIMIT ?", params + [ids_only_limit])]
        return {"ids": ids, "count": len(ids)}
    total = scalar(f"SELECT COUNT(*) FROM conversations WHERE {w}", params)
    page_size = max(1, min(page_size, 500))
    items = rows(
        f"SELECT * FROM conversations WHERE {w} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
        params + [page_size, (max(page, 1) - 1) * page_size],
    )
    for it in items:
        it["tags"] = json.loads(it.pop("tags_json") or "[]")
        it["assignee_ids"] = json.loads(it.pop("assignee_ids_json") or "[]")
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ---------------------------------------------------------------- knowledge CRUD (bảng tri thức)
KNOWLEDGE_TABLES = {
    "faqs": ["question", "answer", "category", "variants_json", "source", "enabled", "fast_path"],
    "objection_scripts": ["kind", "customer_concern", "response", "rationale", "enabled"],
    "closing_templates": ["purpose", "template", "score", "notes", "enabled"],
}

_faq_version = 0
_faq_version_lock = threading.Lock()


def bump_faq_version() -> None:
    global _faq_version
    with _faq_version_lock:
        _faq_version += 1


def faq_version() -> int:
    return _faq_version


def knowledge_list(table: str, q: str = "") -> list[dict[str, Any]]:
    cols = KNOWLEDGE_TABLES[table]
    if q:
        text_cols = [c for c in cols if c not in ("enabled", "fast_path", "score")]
        cond = " OR ".join(f"{c} LIKE ?" for c in text_cols)
        data = rows(f"SELECT * FROM {table} WHERE {cond} ORDER BY id DESC", [f"%{q}%"] * len(text_cols))
    else:
        data = rows(f"SELECT * FROM {table} ORDER BY id DESC")
    for d in data:
        if "variants_json" in d:
            d["variants"] = json.loads(d.pop("variants_json") or "[]")
    return data


def knowledge_save(table: str, data: dict[str, Any], item_id: int | None = None) -> int:
    cols = KNOWLEDGE_TABLES[table]
    data = dict(data)
    if "variants" in data:
        data["variants_json"] = json.dumps([v for v in data.pop("variants") if str(v).strip()], ensure_ascii=False)
    vals = {c: data[c] for c in cols if c in data}
    with tx() as c:
        if item_id:
            if vals:
                sets = ", ".join(f"{k} = ?" for k in vals)
                c.execute(f"UPDATE {table} SET {sets}, updated_at = ? WHERE id = ?", list(vals.values()) + [now(), item_id])
            new_id = item_id
        else:
            keys = list(vals) + ["created_at", "updated_at"]
            cur = c.execute(
                f"INSERT INTO {table}({', '.join(keys)}) VALUES({', '.join('?' for _ in keys)})",
                list(vals.values()) + [now(), now()],
            )
            new_id = int(cur.lastrowid)
    if table == "faqs":
        bump_faq_version()
    return new_id


def knowledge_delete(table: str, item_id: int) -> None:
    with tx() as c:
        c.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
    if table == "faqs":
        bump_faq_version()


# ---------------------------------------------------------------- tiện ích
def _norm(s: str) -> str:
    import unicodedata

    s = unicodedata.normalize("NFD", str(s or "").lower()).replace("đ", "d")
    return " ".join("".join(ch for ch in s if unicodedata.category(ch) != "Mn").split())
