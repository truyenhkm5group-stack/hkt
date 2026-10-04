"""
sentiment_analyzer.py — Máy phát hiện BỨC XÚC & cảm xúc khách hàng (Frustration & Sentiment Detection Engine).

Chấm điểm 0–100 hoàn toàn local (không tốn token), từ các tín hiệu:
  * Từ khoá phàn nàn về câu trả lời sai: "sai rồi", "nhầm rồi", "vớ vẩn", "trả lời linh tinh", "không hiểu à"…
  * Đòi gặp người thật: "gặp người thật", "cho gặp nhân viên", "bot à", "máy trả lời à"…
  * Lời lẽ nặng / chửi thề, doạ bóc phốt, doạ báo cáo.
  * VIẾT HOA cả câu, chuỗi dấu ??? / !!!.
  * Khách nhắc lại y nguyên câu đã hỏi (bot trả lời chưa trúng).
  * Ngay trước đó là tin của BOT ⇒ cộng thêm (rất có thể bot vừa trả lời sai).

Điểm > `frustration_threshold` (mặc định 70) ⇒ server gửi lời xin lỗi, TẮT AI cho hội thoại đó và
ghi một dòng `frustration_alerts` để nhân viên CSKH nhảy vào.
Mọi tín hiệu được trả về kèm điểm để nhân viên thấy VÌ SAO máy kết luận khách đang bực.
"""
from __future__ import annotations

import re
from typing import Any

from canned_matcher import normalize

# Lưu ý: normalize() đổi teencode ("à"/"a" → "anh", "v" → "vay") nên mẫu viết theo chữ ĐÃ đổi.

# (mẫu regex trên chữ ĐÃ CHUẨN HOÁ không dấu, điểm, nhãn hiển thị)
SIGNALS: list[tuple[str, int, str]] = [
    # bot trả lời sai
    (r"\bsai (roi|bet|het|be bet)\b|\bnoi sai\b|\btra loi sai\b", 45, "Chê trả lời sai"),
    (r"\bnham (roi|het|lan)\b|\bnham lan\b", 40, "Chê nhầm lẫn"),
    (r"\bvo van\b|\blinh tinh\b|\blung tung\b|\btam bay\b|\bnham nhi\b|\bvo duyen\b", 50, "Chê vớ vẩn / linh tinh"),
    (r"\bkhong (hieu|doc) (a|anh|ah|ha|gi|sao|tin)\b|\bdoc ky\b|\bhoi (1|mot) dang\b|\bhoi (cai|mot) .{0,20} tra loi (cai|mot)\b|\bkhong dung y\b", 40, "Bot không hiểu ý"),
    (r"\bda noi (roi|bao nhieu lan)\b|\bnoi (may|bao nhieu) lan\b|\bhoi (may|bao nhieu) lan\b|\bnhac lai\b", 35, "Phải nói nhiều lần"),
    # đòi người thật
    (r"\b(gap|cho gap|goi|chuyen|can) (nguoi that|nhan vien|admin|chu shop|quan ly|nguoi)\b|\bnguoi that\b", 55, "Đòi gặp người thật"),
    (r"\b(bot|robot) (a|anh|ah|ha|tra loi|tu dong)\b|\bmay (tra loi|tu dong)\b|\bla bot\b|\bnoi chuyen voi may\b", 35, "Phát hiện đang chat với bot"),
    # bực bội / doạ
    (r"\bbuc (minh|qua|thiet)\b|\bkho chiu\b|\bphien (qua|phuc|chet)\b|\bmet (qua|moi) (voi|vi)\b|\bchan (qua|that|ghe|vai)\b|\bthat vong\b|\bbat tien\b", 40, "Bày tỏ bực bội"),
    (r"\blam an (kieu|the|nhu) (gi|nay|vay)\b|\bthai do\b|\bcoi thuong\b|\bxem thuong\b", 45, "Chê cách làm ăn / thái độ"),
    (r"\bboc phot\b|\bbao cao\b|\brevi?ew (xau|1 sao)\b|\b1 sao\b|\blua dao\b|\bluadao\b|\bscam\b", 55, "Doạ bóc phốt / tố lừa đảo"),
    (r"\b(dm|dcm|vcl|vkl|clm|dmm|vl|cc|dit|me may)\b|\bngu (the|vay|qua|anh)\b|\bdo ngu\b|\boc cho\b", 60, "Lời lẽ nặng"),
]
_COMPILED = [(re.compile(p), w, label) for p, w, label in SIGNALS]
REPEAT_PUNCT = re.compile(r"[?？]{3,}|[!！]{3,}|[?!]{4,}")


def _caps_ratio(text: str) -> tuple[float, int]:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0, 0
    return sum(1 for c in letters if c.isupper()) / len(letters), len(letters)


def analyze(text: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """
    text: các tin khách vừa gửi (đã gộp). history: lịch sử local cũ → mới (dict có from_page, source, text).
    Trả {score, level, signals: [{label, points}], sentiment}.
    """
    raw = text or ""
    norm = normalize(raw)
    signals: list[dict[str, Any]] = []
    for rx, w, label in _COMPILED:
        if rx.search(norm):
            signals.append({"label": label, "points": w})

    ratio, n_letters = _caps_ratio(raw)
    if n_letters >= 8 and ratio >= 0.7:
        signals.append({"label": "VIẾT HOA cả câu", "points": 25})
    punct = REPEAT_PUNCT.findall(raw)
    if punct:
        signals.append({"label": f"Dấu {punct[0][:3]} liên tiếp", "points": min(30, 15 * len(punct))})

    history = history or []
    prev_customer = [h for h in history if not h.get("from_page")]
    if norm and len(norm) >= 6 and any(normalize(h.get("text", "")) == norm for h in prev_customer[-6:-1]):
        signals.append({"label": "Nhắc lại y nguyên câu đã hỏi", "points": 25})

    score = sum(s["points"] for s in signals)
    # Ngay trước tin khách là câu của BOT ⇒ phàn nàn nhiều khả năng nhắm vào câu trả lời của bot.
    shop_msgs = [h for h in history if h.get("from_page")]
    if score and shop_msgs and shop_msgs[-1].get("source") == "bot":
        bonus = round(score * 0.2)
        signals.append({"label": "Ngay sau câu trả lời của bot", "points": bonus})
        score += bonus
    score = min(100, score)
    level = "furious" if score > 85 else "frustrated" if score > 70 else "annoyed" if score >= 35 else "calm"
    return {"score": score, "level": level, "signals": signals,
            "sentiment": "negative" if score >= 35 else "neutral"}
