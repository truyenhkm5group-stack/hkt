"""API FastAPI + phục vụ giao diện web tĩnh."""
import csv
import io
import os
from contextlib import asynccontextmanager
from datetime import date
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import categories as cat
from . import db, importer, reports
from .rules import load_rules, suggest, normalize

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

@asynccontextmanager
async def lifespan(_app):
    db.init_db()
    yield


app = FastAPI(title="HKT - Quản lý giao dịch MB Bank", version="1.0.0", lifespan=lifespan)


# ------------------------------------------------------------------ helpers

def _row(r):
    return dict(r) if r is not None else None


def _default_period(date_from, date_to):
    today = date.today()
    if not date_from:
        date_from = today.replace(day=1).isoformat()
    if not date_to:
        date_to = today.isoformat()
    return date_from, date_to


def _get_txn(conn, txn_id):
    r = conn.execute(
        "SELECT t.*, c.name AS category_name, c.grp AS grp FROM transactions t "
        "LEFT JOIN categories c ON c.code = t.category_code WHERE t.id = ?", (txn_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Không tìm thấy giao dịch")
    return dict(r)


def _validate_category(conn, code):
    if code is None:
        return
    if not conn.execute("SELECT 1 FROM categories WHERE code = ?", (code,)).fetchone():
        raise HTTPException(400, f"Danh mục không tồn tại: {code}")


# ------------------------------------------------------------------ schemas

class TxnIn(BaseModel):
    txn_date: str
    amount: int = Field(..., description="VND. Dương = tiền vào, âm = tiền ra")
    description: str = ""
    counterparty: str = ""
    category_code: Optional[str] = None
    note: str = ""
    txn_time: Optional[str] = None
    bank_ref: Optional[str] = None


class TxnPatch(BaseModel):
    txn_date: Optional[str] = None
    amount: Optional[int] = None
    description: Optional[str] = None
    counterparty: Optional[str] = None
    category_code: Optional[str] = None
    note: Optional[str] = None


class BulkCategorize(BaseModel):
    ids: list[int]
    category_code: str


class RuleIn(BaseModel):
    name: str = ""
    pattern: str
    match_type: str = "contains"
    direction: str = "any"
    category_code: str
    priority: int = 100
    enabled: bool = True


class ApplyRules(BaseModel):
    only_unclassified: bool = True
    date_from: Optional[str] = None
    date_to: Optional[str] = None


class CategoryIn(BaseModel):
    code: str
    name: str
    grp: str
    kind: str = "any"
    description: str = ""


class SettingsIn(BaseModel):
    values: dict[str, str]


# ------------------------------------------------------------------ categories

@app.get("/api/categories")
def list_categories():
    with db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM categories ORDER BY sort_order, code").fetchall()
        counts = {r["category_code"]: r["n"] for r in conn.execute(
            "SELECT category_code, COUNT(*) n FROM transactions GROUP BY category_code")}
    gm = cat.group_map()
    order = {g: i for i, g in enumerate(cat.GROUP_ORDER)}
    items = []
    for r in rows:
        d = dict(r)
        d["grp_name"] = gm[d["grp"]]["name"]
        d["account"] = gm[d["grp"]]["account"]
        d["txn_count"] = counts.get(d["code"], 0)
        items.append(d)
    items.sort(key=lambda d: (order.get(d["grp"], 99), d["sort_order"], d["code"]))
    return {"groups": [gm[g] for g in cat.GROUP_ORDER], "categories": items}


@app.post("/api/categories", status_code=201)
def create_category(body: CategoryIn):
    code = body.code.strip().upper().replace(" ", "_")
    if body.grp not in cat.GROUP_ORDER or body.grp == "UNCLASSIFIED":
        raise HTTPException(400, "Nhóm kế toán không hợp lệ")
    if body.kind not in ("in", "out", "any"):
        raise HTTPException(400, "kind phải là in/out/any")
    with db.get_conn() as conn:
        if conn.execute("SELECT 1 FROM categories WHERE code=?", (code,)).fetchone():
            raise HTTPException(409, "Mã danh mục đã tồn tại")
        conn.execute(
            "INSERT INTO categories(code,name,grp,kind,description,is_system,sort_order) VALUES(?,?,?,?,?,0,999)",
            (code, body.name.strip(), body.grp, body.kind, body.description))
        return _row(conn.execute("SELECT * FROM categories WHERE code=?", (code,)).fetchone())


@app.delete("/api/categories/{code}")
def delete_category(code: str):
    with db.get_conn() as conn:
        r = conn.execute("SELECT is_system FROM categories WHERE code=?", (code,)).fetchone()
        if not r:
            raise HTTPException(404, "Không tìm thấy danh mục")
        if r["is_system"]:
            raise HTTPException(400, "Không thể xoá danh mục hệ thống")
        conn.execute("UPDATE transactions SET category_code=? WHERE category_code=?", (cat.UNCLASSIFIED_CODE, code))
        conn.execute("DELETE FROM categories WHERE code=?", (code,))
    return {"ok": True}


# ------------------------------------------------------------------ transactions

@app.get("/api/transactions")
def list_transactions(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    category: Optional[str] = None, grp: Optional[str] = None,
    q: Optional[str] = None, direction: Optional[str] = None,
    unclassified: bool = False,
    page: int = Query(1, ge=1), limit: int = Query(100, ge=1, le=1000),
):
    where, params = ["1=1"], []
    if date_from:
        where.append("t.txn_date >= ?"); params.append(date_from)
    if date_to:
        where.append("t.txn_date <= ?"); params.append(date_to)
    if category:
        where.append("t.category_code = ?"); params.append(category)
    if grp:
        where.append("c.grp = ?"); params.append(grp)
    if unclassified:
        where.append("(t.category_code IS NULL OR t.category_code = ?)"); params.append(cat.UNCLASSIFIED_CODE)
    if direction == "in":
        where.append("t.amount > 0")
    elif direction == "out":
        where.append("t.amount < 0")
    if q:
        where.append("(lower(t.description) LIKE ? OR lower(t.counterparty) LIKE ? OR lower(t.note) LIKE ? OR t.bank_ref LIKE ?)")
        like = f"%{q.lower()}%"
        params += [like, like, like, f"%{q}%"]
    sql_where = " AND ".join(where)
    with db.get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END),0), "
            f"COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount ELSE 0 END),0) "
            f"FROM transactions t LEFT JOIN categories c ON c.code=t.category_code WHERE {sql_where}", params).fetchone()
        rows = conn.execute(
            f"SELECT t.*, c.name AS category_name, c.grp AS grp FROM transactions t "
            f"LEFT JOIN categories c ON c.code=t.category_code WHERE {sql_where} "
            f"ORDER BY t.txn_date DESC, COALESCE(t.txn_time,'') DESC, t.id DESC LIMIT ? OFFSET ?",
            params + [limit, (page - 1) * limit]).fetchall()
    return {"total": total[0], "sum_in": total[1], "sum_out": total[2], "page": page, "limit": limit,
            "items": [dict(r) for r in rows]}


@app.post("/api/transactions", status_code=201)
def create_transaction(body: TxnIn):
    if body.amount == 0:
        raise HTTPException(400, "Số tiền phải khác 0")
    txn_date, _ = importer.parse_date(body.txn_date)
    with db.get_conn() as conn:
        _validate_category(conn, body.category_code)
        code, labeled_by = body.category_code, "manual" if body.category_code else None
        if not code:
            code, rule_id = suggest(load_rules(conn), body.description, body.counterparty, body.amount)
            labeled_by = f"rule:{rule_id}" if rule_id else None
            code = code or cat.UNCLASSIFIED_CODE
        fp = importer.fingerprint(txn_date, body.amount, body.description, body.bank_ref, body.counterparty, body.txn_time)
        if conn.execute("SELECT 1 FROM transactions WHERE fingerprint=?", (fp,)).fetchone():
            fp = None  # cho phép nhập tay trùng, chỉ chặn trùng khi import
        cur = conn.execute(
            "INSERT INTO transactions(txn_date, txn_time, amount, description, counterparty, bank_ref, "
            "category_code, labeled_by, note, source, fingerprint) VALUES(?,?,?,?,?,?,?,?,?,'manual',?)",
            (txn_date, body.txn_time, body.amount, body.description.strip(), body.counterparty.strip(),
             body.bank_ref, code, labeled_by, body.note, fp))
        return _get_txn(conn, cur.lastrowid)


@app.patch("/api/transactions/{txn_id}")
def update_transaction(txn_id: int, body: TxnPatch):
    with db.get_conn() as conn:
        _get_txn(conn, txn_id)
        sets, params = [], []
        if body.txn_date is not None:
            d, _ = importer.parse_date(body.txn_date)
            sets.append("txn_date=?"); params.append(d)
        if body.amount is not None:
            if body.amount == 0:
                raise HTTPException(400, "Số tiền phải khác 0")
            sets.append("amount=?"); params.append(body.amount)
        if body.description is not None:
            sets.append("description=?"); params.append(body.description.strip())
        if body.counterparty is not None:
            sets.append("counterparty=?"); params.append(body.counterparty.strip())
        if body.note is not None:
            sets.append("note=?"); params.append(body.note)
        if body.category_code is not None:
            _validate_category(conn, body.category_code)
            sets.append("category_code=?"); params.append(body.category_code)
            sets.append("labeled_by=?"); params.append("manual")
        if sets:
            sets.append("updated_at=datetime('now')")
            conn.execute(f"UPDATE transactions SET {', '.join(sets)} WHERE id=?", params + [txn_id])
        return _get_txn(conn, txn_id)


@app.delete("/api/transactions/{txn_id}")
def delete_transaction(txn_id: int):
    with db.get_conn() as conn:
        _get_txn(conn, txn_id)
        conn.execute("DELETE FROM transactions WHERE id=?", (txn_id,))
    return {"ok": True}


@app.post("/api/transactions/bulk-categorize")
def bulk_categorize(body: BulkCategorize):
    if not body.ids:
        return {"updated": 0}
    with db.get_conn() as conn:
        _validate_category(conn, body.category_code)
        marks = ",".join("?" * len(body.ids))
        cur = conn.execute(
            f"UPDATE transactions SET category_code=?, labeled_by='manual', updated_at=datetime('now') WHERE id IN ({marks})",
            [body.category_code] + body.ids)
        return {"updated": cur.rowcount}


@app.delete("/api/transactions")
def delete_all_transactions(confirm: str = ""):
    if confirm != "XOA":
        raise HTTPException(400, "Cần xác nhận confirm=XOA")
    with db.get_conn() as conn:
        cur = conn.execute("DELETE FROM transactions")
        return {"deleted": cur.rowcount}


# ------------------------------------------------------------------ import

@app.post("/api/import")
async def import_statement(file: UploadFile = File(...), dry_run: bool = False):
    data = await file.read()
    if not data:
        raise HTTPException(400, "File rỗng")
    try:
        txns, errors = importer.parse_statement(file.filename, data)
    except importer.ImportError_ as e:
        raise HTTPException(400, str(e))
    with db.get_conn() as conn:
        rules = load_rules(conn)
        cats = {r["code"]: r["name"] for r in conn.execute("SELECT code, name FROM categories")}
        existing = {r[0] for r in conn.execute("SELECT fingerprint FROM transactions WHERE fingerprint IS NOT NULL")}
        imported = skipped = labeled = 0
        preview = []
        seen = set()
        for t in txns:
            dup = t["fingerprint"] in existing or t["fingerprint"] in seen
            seen.add(t["fingerprint"])
            code, rule_id = suggest(rules, t["description"], t["counterparty"], t["amount"])
            code = code or cat.UNCLASSIFIED_CODE
            item = {**t, "duplicate": dup, "category_code": code, "category_name": cats.get(code, code)}
            if len(preview) < 500:
                preview.append(item)
            if dup:
                skipped += 1
                continue
            if code != cat.UNCLASSIFIED_CODE:
                labeled += 1
            if not dry_run:
                conn.execute(
                    "INSERT INTO transactions(txn_date, txn_time, amount, description, counterparty, bank_ref, "
                    "balance_after, category_code, labeled_by, source, fingerprint) VALUES(?,?,?,?,?,?,?,?,?,'import',?)",
                    (t["txn_date"], t["txn_time"], t["amount"], t["description"], t["counterparty"], t["bank_ref"],
                     t["balance_after"], code, f"rule:{rule_id}" if rule_id else None, t["fingerprint"]))
            imported += 1
    return {"dry_run": dry_run, "parsed": len(txns), "imported": imported, "skipped_duplicates": skipped,
            "auto_labeled": labeled, "unlabeled": imported - labeled, "errors": errors, "preview": preview}


# ------------------------------------------------------------------ rules

@app.get("/api/rules")
def list_rules():
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT r.*, c.name AS category_name FROM rules r LEFT JOIN categories c ON c.code=r.category_code "
            "ORDER BY r.priority, r.id").fetchall()
        return [dict(r) for r in rows]


def _validate_rule(conn, body: RuleIn):
    if body.match_type not in ("contains", "regex"):
        raise HTTPException(400, "match_type phải là contains/regex")
    if body.direction not in ("in", "out", "any"):
        raise HTTPException(400, "direction phải là in/out/any")
    if not body.pattern.strip():
        raise HTTPException(400, "pattern không được rỗng")
    if body.match_type == "regex":
        import re
        try:
            re.compile(body.pattern)
        except re.error as e:
            raise HTTPException(400, f"Regex không hợp lệ: {e}")
    _validate_category(conn, body.category_code)


@app.post("/api/rules", status_code=201)
def create_rule(body: RuleIn):
    with db.get_conn() as conn:
        _validate_rule(conn, body)
        cur = conn.execute(
            "INSERT INTO rules(name, pattern, match_type, direction, category_code, priority, enabled) VALUES(?,?,?,?,?,?,?)",
            (body.name, body.pattern.strip(), body.match_type, body.direction, body.category_code, body.priority,
             int(body.enabled)))
        return _row(conn.execute("SELECT * FROM rules WHERE id=?", (cur.lastrowid,)).fetchone())


@app.put("/api/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleIn):
    with db.get_conn() as conn:
        if not conn.execute("SELECT 1 FROM rules WHERE id=?", (rule_id,)).fetchone():
            raise HTTPException(404, "Không tìm thấy quy tắc")
        _validate_rule(conn, body)
        conn.execute(
            "UPDATE rules SET name=?, pattern=?, match_type=?, direction=?, category_code=?, priority=?, enabled=? WHERE id=?",
            (body.name, body.pattern.strip(), body.match_type, body.direction, body.category_code, body.priority,
             int(body.enabled), rule_id))
        return _row(conn.execute("SELECT * FROM rules WHERE id=?", (rule_id,)).fetchone())


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    with db.get_conn() as conn:
        cur = conn.execute("DELETE FROM rules WHERE id=?", (rule_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Không tìm thấy quy tắc")
    return {"ok": True}


@app.post("/api/rules/apply")
def apply_rules(body: ApplyRules):
    """Chạy lại toàn bộ quy tắc. Mặc định chỉ với giao dịch chưa phân loại;
    nếu only_unclassified=false thì gán lại cả những giao dịch do quy tắc gán
    trước đó (KHÔNG đụng vào giao dịch người dùng gán tay)."""
    where, params = [], []
    if body.only_unclassified:
        where.append("(category_code IS NULL OR category_code = ?)"); params.append(cat.UNCLASSIFIED_CODE)
    else:
        where.append("(labeled_by IS NULL OR labeled_by != 'manual')")
    if body.date_from:
        where.append("txn_date >= ?"); params.append(body.date_from)
    if body.date_to:
        where.append("txn_date <= ?"); params.append(body.date_to)
    with db.get_conn() as conn:
        rules = load_rules(conn)
        rows = conn.execute(f"SELECT id, description, counterparty, amount, category_code FROM transactions "
                            f"WHERE {' AND '.join(where)}", params).fetchall()
        updated = 0
        for r in rows:
            code, rule_id = suggest(rules, r["description"], r["counterparty"], r["amount"])
            if code and code != r["category_code"]:
                conn.execute("UPDATE transactions SET category_code=?, labeled_by=?, updated_at=datetime('now') WHERE id=?",
                             (code, f"rule:{rule_id}", r["id"]))
                updated += 1
    return {"scanned": len(rows), "updated": updated}


@app.get("/api/rules/test")
def test_rule(pattern: str, match_type: str = "contains", direction: str = "any", limit: int = 50):
    """Xem trước: quy tắc này sẽ khớp những giao dịch nào."""
    rule = {"id": 0, "pattern": pattern, "match_type": match_type, "direction": direction, "enabled": 1,
            "category_code": "", "priority": 0}
    from .rules import rule_matches
    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, txn_date, amount, description, counterparty, category_code FROM transactions "
                            "ORDER BY txn_date DESC LIMIT 5000").fetchall()
    matched = [dict(r) for r in rows if rule_matches(rule, r["description"], r["counterparty"], r["amount"])]
    return {"count": len(matched), "items": matched[:limit]}


# ------------------------------------------------------------------ reports

@app.get("/api/reports/pnl")
def report_pnl(date_from: Optional[str] = None, date_to: Optional[str] = None):
    date_from, date_to = _default_period(date_from, date_to)
    with db.get_conn() as conn:
        return reports.pnl(conn, date_from, date_to, db.get_settings(conn))


@app.get("/api/reports/categories")
def report_categories(date_from: Optional[str] = None, date_to: Optional[str] = None):
    date_from, date_to = _default_period(date_from, date_to)
    with db.get_conn() as conn:
        return reports.category_breakdown(conn, date_from, date_to)


@app.get("/api/reports/monthly")
def report_monthly(year: Optional[int] = None):
    year = year or date.today().year
    with db.get_conn() as conn:
        return reports.monthly_series(conn, year)


@app.get("/api/export.csv")
def export_csv(date_from: Optional[str] = None, date_to: Optional[str] = None):
    date_from, date_to = _default_period(date_from, date_to)
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT t.txn_date, t.txn_time, t.amount, t.description, t.counterparty, t.bank_ref, t.balance_after, "
            "t.category_code, c.name AS category_name, c.grp, t.note, t.source FROM transactions t "
            "LEFT JOIN categories c ON c.code=t.category_code WHERE t.txn_date BETWEEN ? AND ? "
            "ORDER BY t.txn_date, COALESCE(t.txn_time,''), t.id", (date_from, date_to)).fetchall()
    gm = cat.group_map()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Ngày", "Giờ", "Tiền vào", "Tiền ra", "Nội dung", "Đối tác", "Mã GD", "Số dư",
                "Mã danh mục", "Danh mục", "Nhóm kế toán", "TK tham chiếu", "Ghi chú", "Nguồn"])
    for r in rows:
        grp = r["grp"] or "UNCLASSIFIED"
        w.writerow([r["txn_date"], r["txn_time"] or "", r["amount"] if r["amount"] > 0 else "",
                    -r["amount"] if r["amount"] < 0 else "", r["description"], r["counterparty"],
                    r["bank_ref"] or "", r["balance_after"] if r["balance_after"] is not None else "",
                    r["category_code"] or "", r["category_name"] or "Chưa phân loại", gm[grp]["name"],
                    gm[grp]["account"], r["note"], r["source"]])
    data = ("﻿" + buf.getvalue()).encode("utf-8")
    return StreamingResponse(io.BytesIO(data), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="giao-dich_{date_from}_{date_to}.csv"'})


# ------------------------------------------------------------------ settings

@app.get("/api/settings")
def get_settings():
    with db.get_conn() as conn:
        return db.get_settings(conn)


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    with db.get_conn() as conn:
        for k, v in body.values.items():
            if k not in cat.DEFAULT_SETTINGS:
                raise HTTPException(400, f"Khoá cài đặt không hợp lệ: {k}")
            conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (k, str(v)))
        return db.get_settings(conn)


@app.get("/api/stats")
def stats():
    with db.get_conn() as conn:
        r = conn.execute("SELECT COUNT(*) n, MIN(txn_date) d0, MAX(txn_date) d1 FROM transactions").fetchone()
        u = conn.execute("SELECT COUNT(*) FROM transactions WHERE category_code IS NULL OR category_code=?",
                         (cat.UNCLASSIFIED_CODE,)).fetchone()[0]
    return {"transactions": r["n"], "first_date": r["d0"], "last_date": r["d1"], "unclassified": u}


# ------------------------------------------------------------------ static UI

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
