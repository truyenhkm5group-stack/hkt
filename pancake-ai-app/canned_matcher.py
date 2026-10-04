"""
canned_matcher.py — Fast-Path: trả lời câu hỏi lặp lại từ kho FAQ local trong < 0,5 giây, 0 token Gemini.

Cách khớp (thuần Python, không gọi mạng):
  1. Chuẩn hoá tiếng Việt: bỏ dấu, chữ thường, quy đổi teencode ("k/ko/hok" → "khong", "sp" → "san pham", "ship" …).
  2. Vector hoá câu = từ đơn + cặp từ + 3-gram ký tự (bắt được lỗi gõ / viết dính), trọng số TF-IDF.
  3. Cosine với câu hỏi gốc VÀ mọi biến thể của từng FAQ, lấy điểm cao nhất.
  4. Chỉ trả lời khi điểm ≥ ngưỡng (mặc định 0,62) VÀ cách biệt rõ với ứng viên thứ hai.

An toàn:
  * Tin có số điện thoại / địa chỉ (khách đang chốt đơn) KHÔNG đi Fast-Path — chuyển cho AI / nhân viên.
  * Tin quá dài (nhiều ý) không đi Fast-Path: câu trả lời mẫu chỉ đúng cho câu hỏi đơn.
  * Chỉ áp FAQ `enabled = 1 AND fast_path = 1`.
Chỉ mục giữ trong RAM, dựng lại khi kho FAQ đổi (đếm phiên bản trong database.py).
"""
from __future__ import annotations

import json
import math
import re
import threading
import time
import unicodedata
from collections import Counter
from typing import Any

import database as db

TEENCODE = {
    "k": "khong", "ko": "khong", "kh": "khong", "hok": "khong", "hong": "khong", "hem": "khong", "khg": "khong", "kg": "khong",
    "dc": "duoc", "dk": "duoc", "đc": "duoc", "ok": "duoc",
    "sp": "san pham", "sz": "size", "ship": "ship", "sip": "ship", "fs": "free ship", "freeship": "free ship",
    "bn": "bao nhieu", "bnh": "bao nhieu", "nhiu": "nhieu", "j": "gi", "gj": "gi", "z": "vay", "v": "vay",
    "ntn": "nhu the nao", "r": "roi", "ns": "noi", "mk": "minh", "m": "minh", "e": "em", "a": "anh", "c": "chi",
    "ib": "inbox", "inb": "inbox", "sdt": "so dien thoai", "dt": "dien thoai", "dchi": "dia chi", "đ/c": "dia chi",
    "cod": "thanh toan khi nhan hang", "tt": "thanh toan", "ck": "chuyen khoan", "kq": "ket qua", "hn": "ha noi",
    "hcm": "ho chi minh", "sg": "sai gon", "nt": "nhan tin", "tr": "trieu",
}
# Từ đệm không mang nghĩa câu hỏi — bỏ khi so khớp
STOPWORDS = {"a", "oi", "shop", "sop", "ad", "admin", "em", "anh", "chi", "minh", "nhe", "nha", "nhi", "voi", "the", "ah", "uh", "di", "la", "thi", "cho", "hoi"}

PHONE_RE = re.compile(r"(?:\+?84|0)(?:[\s.\-]?\d){8,10}\b")
ADDRESS_HINT_RE = re.compile(r"\b(so nha|ngo|ngach|hem|duong|phuong|xa|quan|huyen|tinh|thanh pho|tp|thon|ap|to dan pho)\b")
MAX_FASTPATH_CHARS = 160


def normalize(text: str) -> str:
    s = unicodedata.normalize("NFD", str(text or "").lower()).replace("đ", "d")
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"(\d)\s*k\b", r"\1 nghin", s)            # 250k → 250 nghin
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"(.)\1{2,}", r"\1", s)                     # "shipppp" → "ship"
    words = []
    for w in s.split():
        words.extend(TEENCODE.get(w, w).split())
    return " ".join(words)


def _features(text: str) -> Counter:
    norm = normalize(text)
    words = [w for w in norm.split() if w not in STOPWORDS] or norm.split()
    feats: Counter = Counter()
    for w in words:
        feats["w:" + w] += 1.0
    for a, b in zip(words, words[1:]):
        feats["b:" + a + "_" + b] += 1.5
    joined = " " + " ".join(words) + " "
    for i in range(len(joined) - 2):
        feats["c:" + joined[i:i + 3]] += 0.35
    return feats


def looks_like_order_info(text: str) -> bool:
    if PHONE_RE.search(text or ""):
        return True
    norm = normalize(text)
    hints = len(ADDRESS_HINT_RE.findall(norm))
    # "ship xa không" chỉ có 1 gợi ý và không có số ⇒ không phải địa chỉ
    return hints >= 2 or (hints >= 1 and bool(re.search(r"\d", norm)))


class CannedMatcher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._version = -1
        self._entries: list[tuple[int, dict[str, float], float]] = []  # (faq_id, vector, norm)
        self._faqs: dict[int, dict[str, Any]] = {}
        self._idf: dict[str, float] = {}

    def _ensure_index(self) -> None:
        v = db.faq_version()
        if v == self._version:
            return
        with self._lock:
            if v == self._version:
                return
            faqs = db.rows("SELECT id, question, answer, category, variants_json FROM faqs WHERE enabled = 1 AND fast_path = 1")
            docs: list[tuple[int, Counter]] = []
            for f in faqs:
                for q in [f["question"], *json.loads(f["variants_json"] or "[]")]:
                    if str(q).strip():
                        docs.append((f["id"], _features(q)))
            df: Counter = Counter()
            for _, feats in docs:
                df.update(feats.keys())
            n = max(len(docs), 1)
            self._idf = {k: math.log((1 + n) / (1 + c)) + 1.0 for k, c in df.items()}
            entries = []
            for fid, feats in docs:
                vec = {k: tf * self._idf[k] for k, tf in feats.items()}
                entries.append((fid, vec, math.sqrt(sum(x * x for x in vec.values())) or 1.0))
            self._entries = entries
            self._faqs = {f["id"]: f for f in faqs}
            self._version = v

    def _vector(self, text: str) -> tuple[dict[str, float], float]:
        default_idf = max(self._idf.values(), default=1.0)
        vec = {k: tf * self._idf.get(k, default_idf) for k, tf in _features(text).items()}
        return vec, math.sqrt(sum(x * x for x in vec.values())) or 1.0

    def search(self, text: str, top_k: int = 3) -> list[dict[str, Any]]:
        self._ensure_index()
        if not self._entries or not normalize(text):
            return []
        qv, qn = self._vector(text)
        best: dict[int, float] = {}
        for fid, vec, n in self._entries:
            small, big = (qv, vec) if len(qv) < len(vec) else (vec, qv)
            dot = sum(w * big.get(k, 0.0) for k, w in small.items())
            score = dot / (qn * n)
            if score > best.get(fid, 0.0):
                best[fid] = score
        ranked = sorted(best.items(), key=lambda x: x[1], reverse=True)[:top_k]
        return [{"faq_id": fid, "score": round(s, 4), **{k: self._faqs[fid][k] for k in ("question", "answer", "category")}} for fid, s in ranked]

    def match(self, text: str, threshold: float | None = None) -> dict[str, Any]:
        """{matched, faq?, score, latency_ms, reason}. Không bao giờ gọi mạng."""
        t0 = time.perf_counter()
        threshold = float(threshold if threshold is not None else db.get_setting("fastpath_threshold") or 0.62)
        result: dict[str, Any] = {"matched": False, "score": 0.0, "reason": ""}
        if not (text or "").strip():
            result["reason"] = "Tin rỗng"
        elif looks_like_order_info(text):
            result["reason"] = "Tin chứa SĐT / địa chỉ — chuyển AI/nhân viên để chốt đơn"
        elif len(text) > MAX_FASTPATH_CHARS:
            result["reason"] = "Tin dài nhiều ý — không dùng câu trả lời mẫu"
        else:
            cands = self.search(text, top_k=2)
            if not cands:
                result["reason"] = "Kho FAQ trống"
            else:
                top = cands[0]
                second = cands[1]["score"] if len(cands) > 1 else 0.0
                result.update(score=top["score"], candidates=cands)
                if top["score"] < threshold:
                    result["reason"] = f"Điểm {top['score']:.2f} < ngưỡng {threshold:.2f}"
                elif top["score"] - second < 0.04 and top["answer"].strip() != cands[1]["answer"].strip():
                    result["reason"] = "Hai FAQ khác nhau sát điểm — để AI quyết"
                else:
                    result.update(matched=True, faq=top, reason="Khớp FAQ")
        result["latency_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        return result

    def similarity(self, a: str, b: str) -> float:
        """Độ giống hai câu (dùng để gộp FAQ trùng khi nạp tri thức)."""
        self._ensure_index()
        va, na = self._vector(a)
        vb, nb = self._vector(b)
        return sum(w * vb.get(k, 0.0) for k, w in va.items()) / (na * nb)


matcher = CannedMatcher()


def record_hit(faq_id: int) -> None:
    with db.tx() as c:
        c.execute("UPDATE faqs SET hit_count = hit_count + 1 WHERE id = ?", (faq_id,))


# =====================================================================================================
# GIỮ CHÂN KHÁCH & XỬ LÝ HUỶ ĐƠN (Order Retention & Anti-Cancellation) — nhận diện ý định, KHÔNG gọi mạng.
# Máy trạng thái (hỏi lý do → đề xuất ưu đãi → huỷ văn minh) nằm ở server.py::RetentionFlow.
# =====================================================================================================
CANCEL_INTENT_RE = re.compile(
    r"\bhuy (don|giup|di|luon|nha|nhe|dum|ho|giu|cho)\b|\bhuy\b$|^huy\b|\bcancel\b|\bbo don\b"
    r"|\bkhong (lay|mua|nhan|can|dat) (nua|dau|hang nua)\b|\bkhoi (gui|giao|ship|lay)\b|\bthoi khoi\b"
    r"|\bdung (gui|giao|ship)\b|\bkhong nhan hang\b|\bthoi (khong|khoi) (lay|mua)\b"
)
FIRM_CANCEL_RE = re.compile(
    r"\bvan huy\b|\bhuy di\b|\bhuy luon\b|\bcu huy\b|\bhuy (giup|dum|ho) (di|luon|nha|nhe)\b|\bvan khong (lay|mua|nhan)\b"
    r"|\bkhong (lay|mua|nhan) dau\b|\bquyet dinh huy\b|\bnoi (roi|la) huy\b|\bdung (gui|giao) (nua|di|luon)\b"
)
ACCEPT_RE = re.compile(
    r"\bdong y\b|\bvay (lay|giu|chot|duoc)\b|\bthe (thi )?(lay|giu|chot|duoc)\b|\bgiu (don|lai)\b|\bvan lay\b"
    r"|\blay (nhe|nha|di|luon)\b|\bchot (nhe|nha|di|luon)\b|^(duoc|vang|uh|um|oke|okie)( (nhe|nha|di|anh|em|chi|shop))*$"
)
NEGATION_RE = re.compile(r"\bkhong (duoc|dong y|can|lay)\b|\bthoi\b")

# lý do huỷ → khoá ưu đãi (khoá trùng tên cài đặt `retention_offer_<khoá>_text`)
REASON_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("price", re.compile(
        r"\b(dat|mac) (qua|the|vay|hon|lam|thiet)\b|\bhoi (dat|mac)\b|\bgia (cao|chat|mac|dat)\b|\bre hon\b|\bkhong du tien\b"
        r"|\bhet tien\b|\b(phi|tien) ship\b|\bship (cao|dat|mac|nhieu)\b|\btien (van chuyen|giao hang)\b|\bcho khac re\b")),
    ("size", re.compile(
        r"\bsize\b|\bco (ao|quan|nho|lon|khong vua)\b|\bkhong vua\b|\b(bi |hoi )?(chat|rong) (qua|qua troi|lam)\b|\bmac khong (vua|hop|dep)\b"
        r"|\bmau\b|\bdoi mau\b|\bkhong hop\b|\bcan nang\b|\b(beo|gay|map|om) qua\b|\bso (khong vua|chat|rong)\b")),
    ("speed", re.compile(
        r"\b(giao|ship|gui|cho|doi) (lau|cham)\b|\blau qua\b|\bcham qua\b|\bcan gap\b|\bcan (som|ngay)\b|\bkhong kip\b"
        r"|\bdoi (lau|mai|lau qua)\b|\bmua (cho|o) (khac|ngoai) roi\b|\bmua roi\b")),
]


def detect_cancel_intent(text: str) -> bool:
    return bool(CANCEL_INTENT_RE.search(normalize(text)))


def detect_firm_cancel(text: str) -> bool:
    return bool(FIRM_CANCEL_RE.search(normalize(text)))


def detect_accept(text: str) -> bool:
    n = normalize(text)
    return bool(ACCEPT_RE.search(n)) and not NEGATION_RE.search(n) and not CANCEL_INTENT_RE.search(n)


def classify_cancel_reason(text: str) -> str:
    """price | size | speed | other — lý do đầu tiên khớp (thứ tự: giá/ship → size/màu → giao chậm)."""
    n = normalize(text)
    for key, rx in REASON_PATTERNS:
        if rx.search(n):
            return key
    return "other"
