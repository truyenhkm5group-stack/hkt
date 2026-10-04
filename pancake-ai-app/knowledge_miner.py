"""
knowledge_miner.py — AI Knowledge Mining Studio: bóc tách tri thức bán hàng từ hàng nghìn hội thoại Pancake.

Quy trình một lượt nạp (chạy nền, có tiến độ, huỷ được):
  1. Với mỗi hội thoại được tích chọn: lấy lịch sử TỪ DB LOCAL; chỉ hội thoại chưa từng tải mới gọi Pancake
     một lần rồi lưu lại (local-first — lần nạp sau không gọi lại).
  2. Che số điện thoại trước khi gửi cho Gemini (không đẩy dữ liệu khách ra ngoài khi không cần).
  3. Gom 10–20 hội thoại / lượt gọi Gemini, yêu cầu trả JSON:
        faqs[]               — câu hỏi & câu trả lời mẫu của shop (đã được kiểm chứng trong hội thoại thành công)
        objection_scripts[]  — kịch bản xử lý từ chối: giá cao / phí ship / ngại size / nghi ngờ chất lượng
        closing_templates[]  — mẫu câu xin SĐT / địa chỉ / xác nhận đơn hay nhất, kèm điểm 0–10
  4. Gộp với kho hiện có: FAQ giống ≥ 0,85 ⇒ thêm biến thể + tăng `evidence`, không tạo dòng trùng.
  5. Trước MỖI lượt gọi đều kiểm hạn ngạch chi phí; vượt ⇒ dừng job ở trạng thái `blocked`, giữ phần đã học.

Hàm `build_reply_context()` dựng system prompt cho bot trả lời khách từ chính kho tri thức này.
"""
from __future__ import annotations

import json
import re
import threading
import traceback
from typing import Any

import database as db
import token_tracker as tt
from canned_matcher import PHONE_RE, matcher
from pancake_client import PancakeClient, PancakeError

MAX_MSGS_PER_CONV = 40
MAX_CHARS_PER_CONV = 3500
MERGE_SIMILARITY = 0.85
OBJECTION_KINDS = {"price", "shipping", "size", "trust", "other"}
CLOSING_PURPOSES = {"phone", "address", "phone_address", "confirm"}

MINING_SYSTEM = """Bạn là chuyên gia đào tạo nhân viên bán hàng online tại Việt Nam.
Bạn nhận các đoạn hội thoại THÀNH CÔNG (đã chốt đơn) giữa KHÁCH và SHOP trên Facebook/Zalo qua Pancake.
Nhiệm vụ: bóc tách tri thức tái sử dụng được để huấn luyện chatbot bán hàng.

QUY TẮC:
- Chỉ lấy thứ thật sự xuất hiện trong hội thoại. KHÔNG bịa giá, chính sách, chất liệu, thời gian giao.
- Câu trả lời mẫu phải viết lại gọn, lịch sự, xưng "em" – gọi "anh/chị", giữ đúng thông tin shop đã nói.
- Bỏ thông tin cá nhân: tên khách, SĐT, địa chỉ cụ thể, mã đơn.
- FAQ chỉ nhận câu hỏi CHUNG mà khách khác cũng sẽ hỏi (giá, ship, size, chất liệu, đổi trả, thanh toán, thời gian giao...).
  Câu trả lời phụ thuộc từng khách (vd "đơn của chị đến đâu rồi") thì đặt "fast_path": false.
- Gộp các câu hỏi cùng ý vào MỘT FAQ, liệt kê cách hỏi khác ở "variants" (giữ nguyên cách khách gõ, kể cả không dấu / teencode).
- Mẫu câu chốt đơn: chọn câu xin SĐT/địa chỉ khiến khách trả lời ngay; chấm "score" 0–10.

Trả về DUY NHẤT một JSON đúng dạng:
{
  "faqs": [{"question": "...", "variants": ["..."], "answer": "...", "category": "gia|ship|size|chat_lieu|doi_tra|thanh_toan|giao_hang|khuyen_mai|khac", "fast_path": true}],
  "objection_scripts": [{"kind": "price|shipping|size|trust|other", "customer_concern": "...", "response": "...", "rationale": "vì sao cách này thuyết phục"}],
  "closing_templates": [{"purpose": "phone|address|phone_address|confirm", "template": "...", "score": 8.5, "notes": "dùng khi nào"}]
}"""


def mask_pii(text: str) -> str:
    return PHONE_RE.sub("[SĐT]", text or "")


def _client() -> PancakeClient:
    return PancakeClient(db.get_setting("pancake_page_id"), db.get_setting("pancake_page_access_token"))


def ensure_local_history(conversation_id: str, client: PancakeClient | None = None) -> bool:
    """Hội thoại đã có lịch sử local ⇒ không gọi Pancake. Trả True nếu vừa phải tải."""
    conv = db.row("SELECT messages_synced_at FROM conversations WHERE id = ?", (conversation_id,))
    if conv and conv["messages_synced_at"]:
        return False
    client = client or _client()
    msgs = client.get_all_messages(conversation_id)
    db.insert_messages([{**m, "source": "pancake"} for m in msgs])
    db.mark_messages_synced(conversation_id)
    return True


def transcript(conversation_id: str) -> str:
    msgs = db.get_history(conversation_id, limit=MAX_MSGS_PER_CONV)
    lines = []
    for m in msgs:
        t = mask_pii(m["text"]).strip()
        if t:
            lines.append(("SHOP: " if m["from_page"] else "KHÁCH: ") + t)
    out = "\n".join(lines)
    return out[-MAX_CHARS_PER_CONV:]


# ---------------------------------------------------------------- lưu kết quả
def _clean(s: Any, limit: int = 1200) -> str:
    return re.sub(r"\s+", " ", mask_pii(str(s or ""))).strip()[:limit]


def merge_results(data: dict[str, Any], job_id: int | None) -> dict[str, int]:
    stats = {"faqs_added": 0, "faqs_merged": 0, "scripts_added": 0, "templates_added": 0}
    batch_new: list[dict[str, Any]] = []  # FAQ vừa thêm trong lượt này (chỉ mục RAM chưa có chúng)
    for f in data.get("faqs") or []:
        q, a = _clean(f.get("question"), 300), _clean(f.get("answer"))
        if not q or not a:
            continue
        variants = [_clean(v, 300) for v in (f.get("variants") or []) if _clean(v, 300)]
        best_id, best = None, 0.0
        hits = matcher.search(q, top_k=1)  # chỉ mục RAM — không so từng cặp với cả kho
        if hits:
            best_id, best = hits[0]["faq_id"], hits[0]["score"]
        for e in batch_new:
            s = max(matcher.similarity(q, x) for x in [e["question"], *e["variants"]])
            if s > best:
                best_id, best = e["id"], s
        if best_id is not None and best >= MERGE_SIMILARITY:
            e = db.row("SELECT question, variants_json FROM faqs WHERE id = ?", (best_id,))
            if e is None:
                continue
            old = json.loads(e["variants_json"] or "[]")
            merged = (old + [v for v in dict.fromkeys([q, *variants]) if v not in old and v != e["question"]])[:40]
            with db.tx() as c:
                c.execute("UPDATE faqs SET variants_json = ?, evidence = evidence + 1, updated_at = ? WHERE id = ?",
                          (json.dumps(merged, ensure_ascii=False), db.now(), best_id))
            stats["faqs_merged"] += 1
        else:
            cat = _clean(f.get("category"), 40) or "khac"
            with db.tx() as c:
                cur = c.execute(
                    """INSERT INTO faqs(question, answer, category, variants_json, source, enabled, fast_path, job_id, created_at, updated_at)
                       VALUES(?,?,?,?, 'mined', 1, ?, ?, ?, ?)""",
                    (q, a, cat, json.dumps(variants[:20], ensure_ascii=False), int(f.get("fast_path", True) is not False), job_id, db.now(), db.now()),
                )
            batch_new.append({"id": int(cur.lastrowid), "question": q, "variants": variants})
            stats["faqs_added"] += 1
    if stats["faqs_added"] or stats["faqs_merged"]:
        db.bump_faq_version()

    have_scripts = {db._norm(r["customer_concern"]) for r in db.rows("SELECT customer_concern FROM objection_scripts")}
    for s in data.get("objection_scripts") or []:
        concern, resp = _clean(s.get("customer_concern"), 400), _clean(s.get("response"))
        if not concern or not resp:
            continue
        key = db._norm(concern)
        if key in have_scripts:
            with db.tx() as c:
                c.execute("UPDATE objection_scripts SET evidence = evidence + 1 WHERE customer_concern = ?", (concern,))
            continue
        kind = s.get("kind") if s.get("kind") in OBJECTION_KINDS else "other"
        with db.tx() as c:
            c.execute(
                """INSERT INTO objection_scripts(kind, customer_concern, response, rationale, job_id, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?)""", (kind, concern, resp, _clean(s.get("rationale"), 500), job_id, db.now(), db.now()))
        have_scripts.add(key)
        stats["scripts_added"] += 1

    have_tpl = {db._norm(r["template"]) for r in db.rows("SELECT template FROM closing_templates")}
    for t in data.get("closing_templates") or []:
        tpl = _clean(t.get("template"), 600)
        if not tpl or db._norm(tpl) in have_tpl:
            continue
        purpose = t.get("purpose") if t.get("purpose") in CLOSING_PURPOSES else "phone_address"
        try:
            score = max(0.0, min(10.0, float(t.get("score") or 0)))
        except (TypeError, ValueError):
            score = 0.0
        with db.tx() as c:
            c.execute(
                """INSERT INTO closing_templates(purpose, template, score, notes, job_id, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?)""", (purpose, tpl, score, _clean(t.get("notes"), 300), job_id, db.now(), db.now()))
        have_tpl.add(db._norm(tpl))
        stats["templates_added"] += 1
    return stats


# ---------------------------------------------------------------- job
_cancel_flags: dict[int, threading.Event] = {}


def _log(job_id: int, line: str) -> None:
    r = db.row("SELECT log_json FROM mining_jobs WHERE id = ?", (job_id,))
    logs = json.loads((r or {}).get("log_json") or "[]")[-199:]
    logs.append(f"{db.now()}|{line}")
    with db.tx() as c:
        c.execute("UPDATE mining_jobs SET log_json = ? WHERE id = ?", (json.dumps(logs, ensure_ascii=False), job_id))


def _update(job_id: int, **fields: Any) -> None:
    sets = ", ".join(f"{k} = ?" for k in fields)
    with db.tx() as c:
        c.execute(f"UPDATE mining_jobs SET {sets} WHERE id = ?", list(fields.values()) + [job_id])


def create_job(conversation_ids: list[str], batch_size: int = 15) -> int:
    ids = list(dict.fromkeys(str(i) for i in conversation_ids))[:5000]
    batch_size = max(3, min(int(batch_size or 15), 30))
    with db.tx() as c:
        cur = c.execute(
            "INSERT INTO mining_jobs(status, total, batch_size, conversation_ids_json, created_at) VALUES('queued', ?, ?, ?, ?)",
            (len(ids), batch_size, json.dumps(ids), db.now()))
        job_id = int(cur.lastrowid)
    _cancel_flags[job_id] = threading.Event()
    threading.Thread(target=run_job, args=(job_id,), daemon=True, name=f"mining-{job_id}").start()
    return job_id


def cancel_job(job_id: int) -> None:
    ev = _cancel_flags.get(job_id)
    if ev:
        ev.set()
    else:  # tiến trình đã khởi động lại — job không còn chạy
        with db.tx() as c:
            c.execute("UPDATE mining_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')", (db.now(), job_id))


def run_job(job_id: int) -> None:
    job = db.row("SELECT * FROM mining_jobs WHERE id = ?", (job_id,))
    if not job:
        return
    cancel = _cancel_flags.setdefault(job_id, threading.Event())
    ids: list[str] = json.loads(job["conversation_ids_json"])
    bs = job["batch_size"]
    totals = {"faqs_added": 0, "faqs_merged": 0, "scripts_added": 0, "templates_added": 0}
    _update(job_id, status="running")
    _log(job_id, f"Bắt đầu nạp {len(ids)} hội thoại, {bs} hội thoại / lượt AI")
    client = None
    fetched = 0
    try:
        for start in range(0, len(ids), bs):
            if cancel.is_set():
                _update(job_id, status="cancelled", finished_at=db.now())
                _log(job_id, "Đã huỷ theo yêu cầu — giữ nguyên tri thức đã học")
                return
            chunk = ids[start:start + bs]
            blocks = []
            for cid in chunk:
                try:
                    conv = db.row("SELECT messages_synced_at FROM conversations WHERE id = ?", (cid,))
                    if not (conv and conv["messages_synced_at"]):
                        client = client or _client()
                        ensure_local_history(cid, client)
                        fetched += 1
                    t = transcript(cid)
                    if t.count("\n") >= 1:
                        blocks.append(f"### HỘI THOẠI {len(blocks) + 1}\n{t}")
                except PancakeError as e:
                    _log(job_id, f"Bỏ qua hội thoại {cid}: {e}")
            if blocks:
                try:
                    res = tt.call_gemini(
                        "Phân tích các hội thoại sau và trả JSON theo đúng định dạng:\n\n" + "\n\n".join(blocks),
                        purpose="mining", system=MINING_SYSTEM, json_mode=True, temperature=0.3, job_id=job_id,
                        max_output_tokens=8192,
                    )
                    data = tt.parse_json(res["text"])
                    stats = merge_results(data if isinstance(data, dict) else {}, job_id)
                    for k, v in stats.items():
                        totals[k] += v
                    cost = f"${res['cost_usd']:.4f}" if res["cost_usd"] is not None else "chưa có đơn giá"
                    _log(job_id, f"Lượt {start // bs + 1}: {len(blocks)} hội thoại · {res['prompt_tokens']}+{res['output_tokens']} token · {cost} · "
                                 f"+{stats['faqs_added']} FAQ, gộp {stats['faqs_merged']}, +{stats['scripts_added']} kịch bản, +{stats['templates_added']} mẫu chốt")
                except tt.BudgetExceeded as e:
                    _update(job_id, status="blocked", error=str(e), processed=start, finished_at=db.now(), **totals)
                    _log(job_id, f"DỪNG do vượt hạn ngạch: {e}")
                    return
                except (tt.GeminiError, ValueError) as e:
                    _log(job_id, f"Lượt {start // bs + 1} lỗi, bỏ qua: {e}")
            _update(job_id, processed=min(start + bs, len(ids)), **totals)
        _update(job_id, status="done", finished_at=db.now(), processed=len(ids), **totals)
        _log(job_id, f"Hoàn tất. Tải mới {fetched} lịch sử từ Pancake, phần còn lại đọc từ DB local.")
    except Exception as e:  # noqa: BLE001 — job nền không được làm sập server
        _update(job_id, status="failed", error=str(e), finished_at=db.now(), **totals)
        _log(job_id, "Lỗi: " + "".join(traceback.format_exception_only(type(e), e)).strip())
    finally:
        _cancel_flags.pop(job_id, None)


def recover_interrupted_jobs() -> None:
    """Job đang chạy khi tắt máy ⇒ đánh dấu bị gián đoạn (không tự chạy lại để tránh tốn tiền ngoài ý muốn)."""
    with db.tx() as c:
        c.execute("UPDATE mining_jobs SET status = 'failed', error = 'Bị gián đoạn do ứng dụng khởi động lại', finished_at = ? "
                  "WHERE status IN ('queued','running')", (db.now(),))


# ---------------------------------------------------------------- ngữ cảnh trả lời khách
def build_reply_context(customer_text: str, catalog: list[dict[str, Any]] | None = None) -> str:
    shop = db.get_setting("shop_name") or "Shop"
    profile = db.get_setting("shop_profile") or ""
    related = matcher.search(customer_text, top_k=6)
    faq_lines = [f"- H: {f['question']}\n  Đ: {f['answer']}" for f in related if f["score"] >= 0.25]
    if len(faq_lines) < 6:
        top = db.rows("SELECT question, answer FROM faqs WHERE enabled = 1 ORDER BY hit_count DESC, evidence DESC LIMIT ?", (12 - len(faq_lines),))
        faq_lines += [f"- H: {f['question']}\n  Đ: {f['answer']}" for f in top if f["question"] not in "".join(faq_lines)]
    scripts = db.rows("SELECT kind, customer_concern, response FROM objection_scripts WHERE enabled = 1 ORDER BY evidence DESC, id DESC LIMIT 12")
    closers = db.rows("SELECT purpose, template FROM closing_templates WHERE enabled = 1 ORDER BY score DESC LIMIT 5")
    cat = ""
    if catalog:
        items = []
        for p in catalog[:60]:
            price = f"{p['price_min']:,}đ".replace(",", ".") if p.get("price_min") else "liên hệ"
            if p.get("price_max") and p["price_max"] != p.get("price_min"):
                price += f"–{p['price_max']:,}đ".replace(",", ".")
            attrs = "; ".join(f"{k}: {', '.join(v)}" for k, v in (p.get("attributes") or {}).items())
            items.append(f"- {p['name']} ({p.get('code') or ''}) · {price} · {attrs}")
        cat = "\n## DANH MỤC SẢN PHẨM (Pancake POS)\n" + "\n".join(items)
    return f"""Bạn là nhân viên tư vấn bán hàng của {shop}, nhắn tin với khách qua Messenger.
Xưng "em", gọi khách "anh/chị". Trả lời ngắn (1–3 câu), tự nhiên, thân thiện, không dùng markdown.

## THÔNG TIN SHOP
{profile}
{cat}

## CÂU HỎI & TRẢ LỜI MẪU (học từ hội thoại chốt đơn thành công)
{chr(10).join(faq_lines) or '(chưa có)'}

## KỊCH BẢN XỬ LÝ TỪ CHỐI
{chr(10).join(f"- [{s['kind']}] Khách: {s['customer_concern']} → Shop: {s['response']}" for s in scripts) or '(chưa có)'}

## MẪU CÂU XIN SĐT / ĐỊA CHỈ CHỐT ĐƠN (dùng khi khách đã muốn mua)
{chr(10).join(f"- ({c['purpose']}) {c['template']}" for c in closers) or '(chưa có)'}

## LUẬT BẮT BUỘC
- Chỉ dùng thông tin có ở trên. KHÔNG bịa giá, tồn kho, khuyến mãi, thời gian giao.
- Không chắc / khách phàn nàn / hỏi đơn đã đặt / đòi gặp người thật ⇒ trả về đúng một dòng: [HANDOFF] <lý do ngắn>
- Khách đã cho SĐT + địa chỉ ⇒ xác nhận lại thông tin, báo nhân viên sẽ lên đơn; không tự hứa giờ giao."""
