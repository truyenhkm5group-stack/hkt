"""
token_tracker.py — Gọi Gemini, ghi nhận Token & tính chi phí thật, chặn theo hạn ngạch (Guardrail).

  * MỌI lời gọi Gemini đều đi qua `call_gemini()` ⇒ không có lời gọi nào lọt khỏi sổ chi phí.
  * Số token lấy từ `usageMetadata` Google trả về (số thật), không ước lượng.
  * Đơn giá (USD / 1 triệu token) nằm ở cài đặt `pricing_json` — sửa theo bảng giá hiện hành của Google.
  * Model chưa có đơn giá ⇒ chi phí là None (CHƯA BIẾT), không phải 0.
  * "Tiết kiệm nhờ Fast-Path" là ƯỚC TÍNH: số lần trả lời nhanh × chi phí trung bình thật của một lượt Gemini.
"""
from __future__ import annotations

import json
import time
from typing import Any

import httpx

import database as db

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Khi chưa có lượt Gemini nào để lấy trung bình, ước tính một lượt trả lời ~1.800 token vào / 150 token ra.
FALLBACK_REPLY_TOKENS = (1800, 150)


class GeminiError(RuntimeError):
    pass


class BudgetExceeded(RuntimeError):
    pass


class TruncatedOutput(GeminiError):
    """JSON bị cắt ngang vì chạm trần token trả về — chia nhỏ lô rồi gọi lại, KHÔNG bỏ qua."""


def price_for(model: str) -> dict[str, float] | None:
    table = db.get_setting("pricing_json") or {}
    if model in table:
        return table[model]
    # khớp theo tiền tố, vd "gemini-2.5-flash-001" → "gemini-2.5-flash" (ưu tiên khoá dài nhất)
    for key in sorted(table, key=len, reverse=True):
        if model.startswith(key):
            return table[key]
    return None


def cost_usd(model: str, prompt_tokens: int, output_tokens: int) -> float | None:
    p = price_for(model)
    if not p:
        return None
    return (prompt_tokens * float(p.get("input", 0)) + output_tokens * float(p.get("output", 0))) / 1_000_000


def record_usage(purpose: str, model: str, prompt_tokens: int, output_tokens: int, thinking_tokens: int = 0,
                 conversation_id: str | None = None, job_id: int | None = None) -> float | None:
    # Token "suy nghĩ" của Gemini 2.5 tính tiền theo đơn giá đầu ra.
    c = cost_usd(model, prompt_tokens, output_tokens + thinking_tokens)
    with db.tx() as conn:
        conn.execute(
            """INSERT INTO token_usage(created_at, purpose, model, prompt_tokens, output_tokens, thinking_tokens, cost_usd, conversation_id, job_id)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (db.now(), purpose, model, prompt_tokens, output_tokens, thinking_tokens, c, conversation_id, job_id),
        )
    return c


# ---------------------------------------------------------------- Guardrail
def _spent_since(ts: int) -> float:
    return float(db.scalar("SELECT COALESCE(SUM(cost_usd), 0) FROM token_usage WHERE created_at >= ?", (ts,)) or 0)


def _day_start(ts: int | None = None) -> int:
    """00:00 giờ Việt Nam (UTC+7) của ngày chứa ts."""
    ts = ts or db.now()
    return ts - ((ts + 7 * 3600) % 86400)


def _month_start(ts: int | None = None) -> int:
    import datetime as dt

    vn = dt.timezone(dt.timedelta(hours=7))
    d = dt.datetime.fromtimestamp(ts or db.now(), vn)
    return int(dt.datetime(d.year, d.month, 1, tzinfo=vn).timestamp())


def guardrail_status() -> dict[str, Any]:
    daily_budget = float(db.get_setting("daily_budget_usd") or 0)
    monthly_budget = float(db.get_setting("monthly_budget_usd") or 0)
    spent_day = _spent_since(_day_start())
    spent_month = _spent_since(_month_start())
    reasons = []
    if daily_budget > 0 and spent_day >= daily_budget:
        reasons.append(f"Đã tiêu ${spent_day:.4f} hôm nay ≥ hạn ngạch ngày ${daily_budget:.2f}")
    if monthly_budget > 0 and spent_month >= monthly_budget:
        reasons.append(f"Đã tiêu ${spent_month:.4f} tháng này ≥ hạn ngạch tháng ${monthly_budget:.2f}")
    return {
        "blocked": bool(reasons), "reasons": reasons, "action": db.get_setting("guardrail_action"),
        "spent_today_usd": spent_day, "spent_month_usd": spent_month,
        "daily_budget_usd": daily_budget, "monthly_budget_usd": monthly_budget,
    }


def check_budget() -> None:
    st = guardrail_status()
    if st["blocked"]:
        raise BudgetExceeded("; ".join(st["reasons"]))


# ---------------------------------------------------------------- Gemini
def call_gemini(prompt: str, *, purpose: str, system: str | None = None, history: list[dict[str, str]] | None = None,
                json_mode: bool = False, max_output_tokens: int | None = None, temperature: float = 0.6,
                conversation_id: str | None = None, job_id: int | None = None, timeout: float = 120.0,
                response_schema: dict[str, Any] | None = None, no_thinking: bool = False) -> dict[str, Any]:
    """Trả {text, prompt_tokens, output_tokens, cost_usd, latency_ms}. Ném BudgetExceeded nếu vượt hạn ngạch."""
    api_key = db.get_setting("gemini_api_key")
    if not api_key:
        raise GeminiError("Chưa cấu hình Gemini API key (lấy tại https://aistudio.google.com/apikey)")
    check_budget()
    model = db.get_setting("gemini_model") or "gemini-2.5-flash"

    contents = []
    for h in history or []:
        contents.append({"role": "model" if h["role"] == "model" else "user", "parts": [{"text": h["text"]}]})
    contents.append({"role": "user", "parts": [{"text": prompt}]})
    gen_cfg: dict[str, Any] = {"temperature": temperature}
    if max_output_tokens:
        gen_cfg["maxOutputTokens"] = max_output_tokens
    if json_mode:
        gen_cfg["responseMimeType"] = "application/json"
        if response_schema:
            gen_cfg["responseSchema"] = response_schema
    if (purpose == "reply" or no_thinking) and "2.5" in model:
        # Gemini 2.5 tính token "suy nghĩ" VÀO maxOutputTokens: để nó nghĩ thì câu trả lời JSON dài bị cắt ngang.
        # Flash tắt hẳn được (0); Pro tối thiểu 128.
        gen_cfg["thinkingConfig"] = {"thinkingBudget": 128 if "pro" in model else 0}
    body: dict[str, Any] = {"contents": contents, "generationConfig": gen_cfg}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    t0 = time.perf_counter()
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            res = httpx.post(GEMINI_URL.format(model=model), params={"key": api_key}, json=body, timeout=timeout)
        except httpx.HTTPError as e:
            last_err = e
            time.sleep(2 ** attempt)
            continue
        if res.status_code in (429, 500, 503) and attempt < 2:
            last_err = GeminiError(f"Gemini {res.status_code}")
            time.sleep(2 * 2 ** attempt)
            continue
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code == 400 and "responseSchema" in gen_cfg:
            # Model / phiên bản API không nhận khuôn JSON ⇒ gọi lại không khuôn (vẫn JSON mode), không làm hỏng cả lượt
            gen_cfg.pop("responseSchema")
            continue
        if res.status_code >= 400:
            msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else None
            raise GeminiError(f"Gemini lỗi {res.status_code}: {msg or res.text[:200]}")
        usage = data.get("usageMetadata") or {}
        pt = int(usage.get("promptTokenCount") or 0)
        ot = int(usage.get("candidatesTokenCount") or 0)
        th = int(usage.get("thoughtsTokenCount") or 0)
        c = record_usage(purpose, model, pt, ot, th, conversation_id, job_id)
        cands = data.get("candidates") or []
        parts = ((cands[0].get("content") or {}).get("parts") or []) if cands else []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        finish = cands[0].get("finishReason") if cands else None
        if not text:
            reason = finish or (data.get("promptFeedback") or {}).get("blockReason")
            raise GeminiError(f"Gemini không trả nội dung (lý do: {reason or 'không rõ'})")
        if json_mode and finish == "MAX_TOKENS":
            raise TruncatedOutput(f"Câu trả lời bị cắt vì quá dài ({ot + th} token)")
        return {"text": text, "finish_reason": finish, "model": model, "prompt_tokens": pt, "output_tokens": ot + th, "cost_usd": c,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 1)}
    raise GeminiError(f"Gemini không phản hồi sau 3 lần thử: {last_err}")


def parse_json(text: str) -> Any:
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        s = s.rsplit("```", 1)[0]
    try:
        return json.loads(s)
    except ValueError:
        start, end = s.find("{"), s.rfind("}")
        if start >= 0 and end > start:
            return json.loads(s[start:end + 1])
        raise


# ---------------------------------------------------------------- Analytics
def avg_reply_cost_usd() -> float:
    r = db.row("SELECT AVG(cost_usd) AS a, COUNT(*) AS n FROM token_usage WHERE purpose = 'reply' AND cost_usd IS NOT NULL")
    if r and r["n"] and r["n"] >= 5:
        return float(r["a"] or 0)
    model = db.get_setting("gemini_model") or "gemini-2.5-flash"
    return cost_usd(model, *FALLBACK_REPLY_TOKENS) or 0.0


def analytics(days: int = 30) -> dict[str, Any]:
    since = _day_start() - (days - 1) * 86400
    rate = float(db.get_setting("usd_vnd_rate") or 26000)
    by_purpose = db.rows(
        """SELECT purpose, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(output_tokens + thinking_tokens) AS output_tokens,
                  SUM(cost_usd) AS cost_usd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls
           FROM token_usage WHERE created_at >= ? GROUP BY purpose""", (since,))
    daily = db.rows(
        """SELECT date(created_at + 25200, 'unixepoch') AS day, SUM(prompt_tokens) AS prompt_tokens,
                  SUM(output_tokens + thinking_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
           FROM token_usage WHERE created_at >= ? GROUP BY day ORDER BY day""", (since,))
    paths = db.rows(
        """SELECT path, COUNT(*) AS n, AVG(latency_ms) AS avg_latency_ms, SUM(est_saved_usd) AS saved_usd
           FROM bot_replies WHERE created_at >= ? GROUP BY path""", (since,))
    path_daily = db.rows(
        """SELECT date(created_at + 25200, 'unixepoch') AS day, path, COUNT(*) AS n
           FROM bot_replies WHERE created_at >= ? GROUP BY day, path ORDER BY day""", (since,))
    total_cost = sum((p["cost_usd"] or 0) for p in by_purpose)
    saved = sum((p["saved_usd"] or 0) for p in paths)
    replies = sum(p["n"] for p in paths if p["path"] in ("fastpath", "gemini"))
    fast = next((p["n"] for p in paths if p["path"] == "fastpath"), 0)
    return {
        "days": days, "usd_vnd_rate": rate,
        "total_cost_usd": total_cost, "total_cost_vnd": round(total_cost * rate),
        "saved_usd": saved, "saved_vnd": round(saved * rate),
        "fastpath_ratio": (fast / replies) if replies else None,
        "avg_reply_cost_usd": avg_reply_cost_usd(),
        "unpriced_calls": sum(p["unpriced_calls"] or 0 for p in by_purpose),
        "by_purpose": by_purpose, "daily": daily, "paths": paths, "path_daily": path_daily,
        "guardrail": guardrail_status(),
        "recent_replies": db.rows("SELECT * FROM bot_replies ORDER BY id DESC LIMIT 30"),
    }
