"""Kết nối SQLite và khởi tạo schema + dữ liệu mặc định."""
import os
import sqlite3
from contextlib import contextmanager

from . import categories as cat

DB_PATH = os.environ.get("HKT_DB", os.path.join("data", "hkt.sqlite3"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    grp         TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'any',
    description TEXT NOT NULL DEFAULT '',
    is_system   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_date      TEXT NOT NULL,              -- YYYY-MM-DD
    txn_time      TEXT,                       -- HH:MM:SS (nếu có)
    amount        INTEGER NOT NULL,           -- VND, dương = tiền vào, âm = tiền ra
    description   TEXT NOT NULL DEFAULT '',
    counterparty  TEXT NOT NULL DEFAULT '',
    bank_ref      TEXT,
    balance_after INTEGER,
    category_code TEXT REFERENCES categories(code) ON DELETE SET NULL,
    labeled_by    TEXT,                       -- 'manual' | 'rule:<id>' | NULL
    note          TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'import'
    fingerprint   TEXT UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_code);

CREATE TABLE IF NOT EXISTS rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL DEFAULT '',
    pattern       TEXT NOT NULL,
    match_type    TEXT NOT NULL DEFAULT 'contains',   -- 'contains' | 'regex'
    direction     TEXT NOT NULL DEFAULT 'any',        -- 'in' | 'out' | 'any'
    category_code TEXT NOT NULL REFERENCES categories(code) ON DELETE CASCADE,
    priority      INTEGER NOT NULL DEFAULT 100,
    enabled       INTEGER NOT NULL DEFAULT 1,
    is_system     INTEGER NOT NULL DEFAULT 0,
    field         TEXT NOT NULL DEFAULT 'all'          -- 'all' | 'description' | 'counterparty'
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
"""


def connect(path=None):
    path = path or DB_PATH
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_conn(path=None):
    conn = connect(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(path=None):
    with get_conn(path) as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        # Danh mục hệ thống
        for i, (code, name, grp, kind, desc) in enumerate(cat.CATEGORIES):
            conn.execute(
                "INSERT INTO categories(code, name, grp, kind, description, is_system, sort_order) "
                "VALUES(?,?,?,?,?,1,?) ON CONFLICT(code) DO UPDATE SET "
                "name=excluded.name, grp=excluded.grp, kind=excluded.kind, "
                "description=excluded.description, sort_order=excluded.sort_order",
                (code, name, grp, kind, desc, i),
            )
        # Quy tắc mặc định: thêm những quy tắc hệ thống chưa có (theo tên)
        existing = {r[0] for r in conn.execute("SELECT name FROM rules WHERE is_system = 1")}
        for name, pattern, mt, direction, code, prio, field in cat.DEFAULT_RULES:
            if name not in existing:
                conn.execute(
                    "INSERT INTO rules(name, pattern, match_type, direction, category_code, priority, enabled, is_system, field) "
                    "VALUES(?,?,?,?,?,?,1,1,?)", (name, pattern, mt, direction, code, prio, field))
        for k, v in cat.DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)", (k, v))


def _migrate(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(rules)")}
    if "field" not in cols:
        conn.execute("ALTER TABLE rules ADD COLUMN field TEXT NOT NULL DEFAULT 'all'")


def get_settings(conn):
    return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
