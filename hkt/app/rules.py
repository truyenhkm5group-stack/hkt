"""Engine gán nhãn tự động dựa trên từ khoá / regex."""
import re
import unicodedata


def normalize(text):
    """Viết thường, bỏ dấu tiếng Việt, gộp khoảng trắng."""
    if not text:
        return ""
    s = unicodedata.normalize("NFD", str(text))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D").lower()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _direction_ok(rule_direction, amount):
    if rule_direction == "in":
        return amount > 0
    if rule_direction == "out":
        return amount < 0
    return True


def _pattern_matches(rule, text_norm):
    pattern = rule["pattern"] or ""
    if rule.get("match_type") == "regex":
        try:
            return re.search(pattern, text_norm, flags=re.IGNORECASE) is not None
        except re.error:
            return False
    # contains: bất kỳ từ khoá nào (phân tách bởi '|') xuất hiện trong text
    for kw in pattern.split("|"):
        kw = normalize(kw)
        if kw and kw in text_norm:
            return True
    return False


def _rule_text(rule, description, counterparty):
    field = rule.get("field") or "all"
    if field == "description":
        return normalize(description)
    if field == "counterparty":
        return normalize(counterparty)
    return normalize(f"{description} {counterparty}")


def rule_matches(rule, description, counterparty, amount):
    if not rule.get("enabled", 1):
        return False
    if not _direction_ok(rule.get("direction", "any"), amount):
        return False
    return _pattern_matches(rule, _rule_text(rule, description, counterparty))


OWNER_PLACEHOLDER = "{owner}"


def expand_owner(pattern, owner_name, match_type="contains"):
    """Thay {owner} bằng tên chủ tài khoản (đã bỏ dấu). Trả None nếu cần owner mà chưa có."""
    if OWNER_PLACEHOLDER not in (pattern or ""):
        return pattern
    owner = normalize(owner_name)
    if not owner:
        return None
    return pattern.replace(OWNER_PLACEHOLDER, re.escape(owner) if match_type == "regex" else owner)


def suggest(rules, description, counterparty, amount):
    """Trả về (category_code, rule_id) của quy tắc đầu tiên khớp (đã sắp theo priority)."""
    for rule in sorted(rules, key=lambda r: (r.get("priority", 100), r.get("id", 0))):
        if rule_matches(rule, description, counterparty, amount):
            return rule["category_code"], rule["id"]
    return None, None


def load_rules(conn, enabled_only=True):
    """Đọc quy tắc từ DB, thay {owner} bằng tên chủ tài khoản trong settings.
    Quy tắc cần {owner} mà settings chưa có tên thì bị bỏ qua."""
    q = "SELECT * FROM rules"
    if enabled_only:
        q += " WHERE enabled = 1"
    q += " ORDER BY priority, id"
    owner = conn.execute("SELECT value FROM settings WHERE key = 'owner_name'").fetchone()
    owner = owner[0] if owner else ""
    out = []
    for r in conn.execute(q):
        d = dict(r)
        pattern = expand_owner(d["pattern"], owner, d.get("match_type", "contains"))
        if pattern is None:
            continue
        d["pattern"] = pattern
        out.append(d)
    return out
