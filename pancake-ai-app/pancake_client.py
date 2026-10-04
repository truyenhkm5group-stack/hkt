"""
pancake_client.py — Client gọi Pancake (pages.fm) Public API + bộ chuẩn hoá webhook.

  * Token truyền qua query `page_access_token` (Pancake không dùng header Authorization).
  * Giới hạn ~5 request/giây/page ⇒ throttle 220 ms giữa hai lời gọi; 429/5xx thì thử lại có lùi dần.
  * Đọc `success: false` trong phong bì phản hồi — không tin mỗi HTTP status.
  * Page Access Token lấy tại Pancake → Page → Cài đặt → Công cụ → Page Access Token (dạng eyJ...).
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

import httpx

V1 = "https://pages.fm/api/public_api/v1"
V2 = "https://pages.fm/api/public_api/v2"
POS = "https://pos.pages.fm/api/v1"


class PancakeError(RuntimeError):
    pass


def to_epoch(value: Any) -> int | None:
    """Pancake trả ISO KHÔNG múi giờ nhưng là UTC; đôi khi trả số giây / mili giây."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value / 1000 if value > 1e12 else value)
    s = str(value).strip()
    if re.fullmatch(r"\d+", s):
        return to_epoch(int(s))
    if re.match(r"^\d{4}-\d{2}-\d{2}T", s) and not re.search(r"([zZ]|[+-]\d{2}:?\d{2})$", s):
        s += "Z"
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp())
    except ValueError:
        return None


_TAG_RE = re.compile(r"<[^>]+>")


def clean_text(value: Any) -> str:
    s = str(value or "")
    s = _TAG_RE.sub(" ", s.replace("<br>", "\n").replace("<br/>", "\n"))
    return re.sub(r"[ \t]+", " ", s).strip()


class PancakeClient:
    def __init__(self, page_id: str, page_access_token: str, timeout: float = 30.0):
        if not page_id or not page_access_token:
            raise PancakeError("Thiếu Page ID hoặc Page Access Token")
        self.page_id = str(page_id)
        self.token = page_access_token
        self._http = httpx.Client(timeout=timeout)
        self._lock = threading.Lock()
        self._last = 0.0
        self._tag_cache: dict[str, str] = {}

    # ------------------------------------------------------------ hạ tầng
    def _request(self, method: str, url: str, params: dict[str, Any] | None = None, body: Any = None, retries: int = 3) -> dict[str, Any]:
        q = {"page_access_token": self.token}
        for k, v in (params or {}).items():
            if v not in (None, ""):
                q[k] = ",".join(map(str, v)) if isinstance(v, (list, tuple)) else v
        attempt = 0
        while True:
            attempt += 1
            with self._lock:  # throttle 220ms / page
                wait = 0.22 - (time.monotonic() - self._last)
                if wait > 0:
                    time.sleep(wait)
                self._last = time.monotonic()
            try:
                res = self._http.request(method, url, params=q, json=body)
            except httpx.HTTPError as e:
                if attempt <= retries:
                    time.sleep(0.5 * 2**attempt)
                    continue
                raise PancakeError(f"Không kết nối được Pancake: {e}") from e
            if res.status_code == 429 or res.status_code >= 500:
                if attempt <= retries:
                    time.sleep(0.5 * 2**attempt)
                    continue
            try:
                data = res.json() if res.text else {}
            except ValueError:
                data = {"raw": res.text[:300]}
            if res.status_code >= 400 or (isinstance(data, dict) and data.get("success") is False):
                msg = (data.get("message") or data.get("error") or data.get("raw")) if isinstance(data, dict) else res.text[:200]
                # không bao giờ in token ra log
                raise PancakeError(f"Pancake {method} {httpx.URL(url).path} lỗi {res.status_code}: {msg}")
            return data if isinstance(data, dict) else {"data": data}

    # ------------------------------------------------------------ API
    def test_connection(self) -> dict[str, Any]:
        data = self._request("GET", f"{V2}/pages/{self.page_id}/conversations", params={"type": "INBOX"})
        convs = data.get("conversations") or []
        return {"ok": True, "sample_conversations": len(convs)}

    def get_tags(self) -> list[dict[str, Any]]:
        data = self._request("GET", f"{V1}/pages/{self.page_id}/tags")
        tags = data.get("tags") or data.get("data") or []
        out = [{"id": str(t.get("id")), "text": t.get("text") or t.get("name") or "", "color": t.get("color")} for t in tags if isinstance(t, dict)]
        self._tag_cache = {t["id"]: t["text"] for t in out}
        return out

    def get_staff(self) -> list[dict[str, Any]]:
        data = self._request("GET", f"{V1}/pages/{self.page_id}/users")
        users = data.get("users") or data.get("data") or []
        if isinstance(users, dict):
            users = users.get("users") or list(users.values())
        out = []
        for u in users:
            if not isinstance(u, dict):
                continue
            uid = u.get("id") or u.get("user_id") or u.get("fb_id")
            if uid:
                out.append({"id": str(uid), "name": u.get("name") or u.get("fb_name") or str(uid)})
        return out

    def list_conversations(self, last_conversation_id: str | None = None, since: int | None = None, until: int | None = None) -> list[dict[str, Any]]:
        """Một trang (~60) hội thoại INBOX mới nhất. Phân trang bằng last_conversation_id."""
        data = self._request(
            "GET", f"{V2}/pages/{self.page_id}/conversations",
            params={"type": "INBOX", "order_by": "updated_at", "last_conversation_id": last_conversation_id, "since": since, "until": until},
        )
        return [self.normalize_conversation(c) for c in (data.get("conversations") or []) if isinstance(c, dict)]

    def get_messages(self, conversation_id: str, current_count: int | None = None) -> list[dict[str, Any]]:
        """Một trang tin (Pancake trả mới → cũ). Gọi lặp với current_count để lùi về quá khứ."""
        data = self._request(
            "GET", f"{V1}/pages/{self.page_id}/conversations/{conversation_id}/messages",
            params={"current_count": current_count},
        )
        return [self.normalize_message(m, conversation_id) for m in (data.get("messages") or []) if isinstance(m, dict)]

    def get_all_messages(self, conversation_id: str, max_messages: int = 300) -> list[dict[str, Any]]:
        seen: dict[str, dict[str, Any]] = {}
        count = None
        while len(seen) < max_messages:
            page = self.get_messages(conversation_id, current_count=count)
            new = [m for m in page if m["id"] not in seen]
            if not new:
                break
            for m in new:
                seen[m["id"]] = m
            count = len(seen)
        return sorted(seen.values(), key=lambda m: (m["created_at"] or 0))

    def send_message(self, conversation_id: str, text: str) -> dict[str, Any]:
        return self._request(
            "POST", f"{V1}/pages/{self.page_id}/conversations/{conversation_id}/messages",
            body={"action": "reply_inbox", "message": text}, retries=0,  # gửi tin KHÔNG tự thử lại: tránh nhắn trùng cho khách
        )

    # ------------------------------------------------------------ chuẩn hoá
    def _tags(self, raw: Any) -> list[dict[str, str]]:
        out = []
        for t in raw or []:
            if isinstance(t, dict):
                out.append({"id": str(t.get("id", "")), "text": t.get("text") or t.get("name") or self._tag_cache.get(str(t.get("id")), "")})
            elif t is not None:
                out.append({"id": str(t), "text": self._tag_cache.get(str(t), "")})
        return out

    def normalize_conversation(self, c: dict[str, Any]) -> dict[str, Any]:
        frm = c.get("from") or {}
        assignees = c.get("assignee_ids") or c.get("current_assign_users") or []
        assignee_ids = [str(a.get("id") if isinstance(a, dict) else a) for a in assignees if a]
        return {
            "id": str(c.get("id")),
            "page_id": str(c.get("page_id") or self.page_id),
            "customer_id": str(frm.get("id") or c.get("customer_id") or "") or None,
            "customer_name": frm.get("name") or "",
            "snippet": clean_text(c.get("snippet"))[:300],
            "tags": self._tags(c.get("tags")),
            "tags_authoritative": True,
            "assignee_ids": assignee_ids,
            "updated_at": to_epoch(c.get("updated_at") or c.get("inserted_at")),
        }

    def normalize_message(self, m: dict[str, Any], conversation_id: str) -> dict[str, Any]:
        frm = m.get("from") or {}
        from_id = str(frm.get("id") or "")
        text = clean_text(m.get("original_message") or m.get("message"))
        if not text and m.get("attachments"):
            text = "[Tệp đính kèm]"
        return {
            "id": str(m.get("id")),
            "conversation_id": str(conversation_id),
            "page_id": self.page_id,
            "from_id": from_id,
            "from_name": frm.get("name") or "",
            "from_page": from_id == self.page_id or bool(frm.get("admin_id") or m.get("is_from_page")),
            "text": text,
            "created_at": to_epoch(m.get("inserted_at") or m.get("created_time")),
        }


def parse_webhook(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Webhook Pancake (event_type = messaging) → {conversation, message} đã chuẩn hoá, hoặc None nếu bỏ qua."""
    if not isinstance(payload, dict) or payload.get("event_type") != "messaging":
        return None
    data = payload.get("data") or {}
    msg, conv = data.get("message") or {}, data.get("conversation") or {}
    if not msg.get("id") or not conv.get("id") or msg.get("is_removed"):
        return None
    if str(msg.get("type") or conv.get("type") or "INBOX").upper() != "INBOX":
        return None
    page_id = str(payload.get("page_id") or conv.get("page_id") or "")
    helper = PancakeClient.__new__(PancakeClient)
    helper.page_id, helper._tag_cache = page_id, {}
    c = helper.normalize_conversation(conv)
    c["tags_authoritative"] = "tags" in conv
    return {"conversation": c, "message": {**helper.normalize_message(msg, c["id"]), "source": "webhook"}}


class PancakePosClient:
    """Pancake POS Open API (tuỳ chọn) — đọc danh mục sản phẩm theo Shop ID để bot nói đúng giá / size / màu."""

    def __init__(self, shop_id: str, api_key: str, timeout: float = 30.0):
        if not shop_id or not api_key:
            raise PancakeError("Thiếu Shop ID hoặc POS API key")
        self.shop_id, self.api_key = str(shop_id), api_key
        self._http = httpx.Client(timeout=timeout)

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        res = self._http.get(f"{POS}{path}", params={"api_key": self.api_key, **params})
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code >= 400 or data.get("success") is False:
            raise PancakeError(f"Pancake POS lỗi {res.status_code}: {data.get('message') or res.text[:200]}")
        return data

    def test_connection(self) -> dict[str, Any]:
        data = self._get(f"/shops/{self.shop_id}/products", {"page_size": 1, "page_number": 1})
        return {"ok": True, "total_products": data.get("total_entries") or len(data.get("data") or [])}

    def get_catalog(self, max_pages: int = 20) -> list[dict[str, Any]]:
        """Danh mục rút gọn: tên, mã, khoảng giá, các giá trị thuộc tính (size/màu) còn bán."""
        out, page = [], 1
        while page <= max_pages:
            data = self._get(f"/shops/{self.shop_id}/products", {"page_size": 100, "page_number": page})
            for p in data.get("data") or []:
                if p.get("is_removed"):
                    continue
                variations = [v for v in p.get("variations") or [] if not v.get("is_removed") and not v.get("is_hidden")]
                if not variations:
                    continue
                prices = sorted({int(v.get("retail_price_after_discount") or v.get("retail_price") or 0) for v in variations} - {0})
                attrs: dict[str, set[str]] = {}
                for v in variations:
                    for f in v.get("fields") or []:
                        if f and f.get("name"):
                            attrs.setdefault(f["name"], set()).add(str(f.get("value")))
                out.append({
                    "name": p.get("name"), "code": p.get("display_id") or p.get("custom_id"),
                    "price_min": prices[0] if prices else None, "price_max": prices[-1] if prices else None,
                    "attributes": {k: sorted(v) for k, v in attrs.items()},
                })
            if page >= int(data.get("total_pages") or 1) or not data.get("data"):
                break
            page += 1
            time.sleep(0.3)
        return out
