"""
Đọc file sao kê MB Bank (CSV hoặc Excel) với cấu trúc cột linh hoạt.

MB Bank xuất sao kê với nhiều mẫu khác nhau (app MBBank, Biz MBBank, sao kê
chi nhánh in ra). Module này tự tìm dòng tiêu đề và ánh xạ cột theo từ khoá
(đã bỏ dấu), nên chỉ cần file có các cột cơ bản:
  - ngày giao dịch
  - số tiền (hoặc 2 cột ghi nợ / ghi có)
  - nội dung
và tuỳ chọn: số dư, số tham chiếu/mã giao dịch, đối tác/tài khoản đối ứng.
"""
import csv
import hashlib
import io
import re
from datetime import date, datetime

from .rules import normalize

COLUMN_KEYWORDS = {
    # thứ tự quan trọng: cột "Ngân hàng đối tác" phải bắt trước "đối tác"
    "partner_bank": ["ngan hang doi tac", "ngan hang thu huong", "remitter bank", "beneficiary bank"],
    "date": ["ngay giao dich", "ngay gd", "ngay hieu luc", "ngay hach toan", "ngay", "transaction date", "trans date", "date"],
    "debit": ["so tien ghi no", "phat sinh no", "ghi no", "tien ra", "debit", "withdrawal", "rut"],
    "credit": ["so tien ghi co", "phat sinh co", "ghi co", "tien vao", "credit", "deposit", "nop"],
    "amount": ["so tien", "amount", "gia tri"],
    "balance": ["so du", "balance"],
    "description": ["noi dung chi tiet", "noi dung", "dien giai", "mo ta", "description", "remark", "narrative", "chi tiet"],
    "ref": ["so tham chieu", "ma giao dich", "so but toan", "so giao dich", "reference", "transaction id", "ma gd", "ref"],
    "counterparty": ["ten doi tac", "doi tac", "tai khoan doi ung", "tk doi ung", "nguoi thu huong", "ben thu huong",
                     "don vi thu huong", "thu huong", "don vi chuyen", "nguoi chuyen", "ten nguoi", "counterparty",
                     "beneficiary", "applicant", "doi ung"],
}

DATE_FORMATS = [
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y",
    "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
    "%d/%m/%y %H:%M:%S", "%d/%m/%y", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d",
]


class ImportError_(Exception):
    pass


def parse_amount(value):
    """Chuyển '1.234.567', '1,234,567', '1234567.00', '-500.000', '(500)' -> int VND. Trả None nếu rỗng."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(round(value))
    s = str(value).strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1]
    s = s.replace("VND", "").replace("vnd", "").replace("đ", "").replace("₫", "").strip()
    if s.startswith("-"):
        neg, s = True, s[1:]
    elif s.startswith("+"):
        s = s[1:]
    s = s.replace(" ", "")
    if not s:
        return None
    # Xác định dấu thập phân: chỉ khi phần cuối có 1-2 chữ số sau dấu VÀ dấu đó
    # không dùng làm phân cách hàng nghìn ở chỗ khác.
    m = re.match(r"^(\d[\d.,]*?)([.,])(\d{1,2})$", s)
    if m and m.group(2) not in m.group(1):
        integer_part = re.sub(r"[.,]", "", m.group(1))
        frac = float("0." + m.group(3))
        num = float(integer_part or 0) + frac
    else:
        digits = re.sub(r"[.,]", "", s)
        if not digits.isdigit():
            raise ValueError(f"Không đọc được số tiền: {value!r}")
        num = float(digits)
    val = int(round(num))
    return -val if neg else val


def parse_date(value):
    """Trả về (YYYY-MM-DD, HH:MM:SS | None)."""
    if value is None or value == "":
        return None, None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d"), value.strftime("%H:%M:%S") if (value.hour or value.minute or value.second) else None
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d"), None
    s = str(value).strip()
    s = re.sub(r"\s+", " ", s)
    for fmt in DATE_FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
            has_time = "%H" in fmt
            return dt.strftime("%Y-%m-%d"), (dt.strftime("%H:%M:%S") if has_time else None)
        except ValueError:
            continue
    # dạng "dd/mm/yyyy\nHH:MM:SS" hoặc có text thừa: lấy phần ngày đầu tiên
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if m:
        d, mo, y = map(int, m.groups())
        t = re.search(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", s)
        tt = None
        if t:
            tt = f"{int(t.group(1)):02d}:{t.group(2)}:{t.group(3) or '00'}"
        return date(y, mo, d).strftime("%Y-%m-%d"), tt
    raise ValueError(f"Không đọc được ngày: {value!r}")


def fingerprint(txn_date, amount, description, bank_ref=None, counterparty="", txn_time=None, balance_after=None):
    """Khoá khử trùng. Ưu tiên số tham chiếu của ngân hàng; nếu sao kê không có
    thì dùng ngày + giờ + số tiền + nội dung + đối tác + số dư sau giao dịch,
    để hai lần chuyển giống hệt nhau trong cùng ngày không bị gộp làm một."""
    if bank_ref:
        key = f"ref|{str(bank_ref).strip()}|{txn_date}|{amount}"
    else:
        key = "|".join(["raw", txn_date, txn_time or "", str(amount), normalize(description), normalize(counterparty),
                        "" if balance_after is None else str(balance_after)])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- đọc bảng thô

def _read_csv_rows(data: bytes):
    text = None
    for enc in ("utf-8-sig", "utf-16", "cp1258", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        raise ImportError_("Không đọc được mã hoá ký tự của file CSV")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect)]


def _read_xlsx_rows(data: bytes):
    try:
        import openpyxl
    except ImportError as e:  # pragma: no cover
        raise ImportError_("Cần cài openpyxl để đọc file Excel") from e
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(list(row))
    return rows


def read_rows(filename: str, data: bytes):
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        return _read_xlsx_rows(data)
    if name.endswith(".xls"):
        raise ImportError_("Định dạng .xls cũ chưa hỗ trợ - hãy mở bằng Excel và lưu lại thành .xlsx hoặc .csv")
    return _read_csv_rows(data)


# ---------------------------------------------------------------- ánh xạ cột

def _match_column(header_norm):
    for field, keywords in COLUMN_KEYWORDS.items():
        for kw in keywords:
            if kw == header_norm or (len(kw) >= 4 and kw in header_norm):
                return field
    return None


def detect_header(rows, max_scan=40):
    """Tìm dòng tiêu đề: dòng có cột ngày + cột nội dung (và một cột tiền)."""
    for idx, row in enumerate(rows[:max_scan]):
        cells = [normalize(c) if c is not None else "" for c in row]
        mapping = {}
        for ci, cell in enumerate(cells):
            if not cell:
                continue
            field = _match_column(cell)
            if field and field not in mapping:
                mapping[field] = ci
        has_money = any(k in mapping for k in ("amount", "debit", "credit"))
        if "date" in mapping and "description" in mapping and has_money:
            return idx, mapping
    raise ImportError_(
        "Không tìm thấy dòng tiêu đề. File cần có các cột: Ngày giao dịch, Nội dung, "
        "và Số tiền (hoặc Ghi nợ / Ghi có)."
    )


META_KEYWORDS = {
    "owner_name": ["ten khach hang", "customer name", "chu tai khoan", "account holder", "ten tai khoan"],
    "account_no": ["so tai khoan", "account no", "tai khoan/", "account number"],
    "opening_balance": ["so du dau ky", "opening balance", "so du dau"],
    "closing_balance": ["so du cuoi ky", "closing balance", "so du cuoi"],
}


def extract_meta(rows):
    """Đọc thông tin đầu/cuối sao kê: chủ tài khoản, số tài khoản, số dư đầu/cuối kỳ."""
    meta = {}
    for row in rows:
        for c in row or []:
            if not isinstance(c, str) or ":" not in c:
                continue
            cn = normalize(c)
            for key, kws in META_KEYWORDS.items():
                if key in meta or not any(k in cn for k in kws):
                    continue
                value = c.split(":", 1)[1].strip()
                if key in ("opening_balance", "closing_balance"):
                    m = re.search(r"[\d][\d.,]*", value)
                    if m:
                        try:
                            meta[key] = parse_amount(m.group(0))
                        except ValueError:
                            pass
                elif key == "account_no":
                    m = re.search(r"\d{6,}", value)
                    if m:
                        meta[key] = m.group(0)
                elif value:
                    meta[key] = value.split("(")[0].strip()
    return meta


def parse_statement(filename: str, data: bytes):
    """Trả về (list giao dịch đã chuẩn hoá, list lỗi theo dòng)."""
    result = parse_statement_full(filename, data)
    return result["transactions"], result["errors"]


def parse_statement_full(filename: str, data: bytes):
    """Như parse_statement nhưng kèm 'meta' (chủ tài khoản, số TK, số dư đầu/cuối kỳ)."""
    rows = read_rows(filename, data)
    header_idx, mapping = detect_header(rows)
    txns, errors = [], []

    def cell(row, field):
        ci = mapping.get(field)
        if ci is None or ci >= len(row):
            return None
        v = row[ci]
        return v if v is not None else None

    for rn, row in enumerate(rows[header_idx + 1:], start=header_idx + 2):
        if row is None or all((c is None or str(c).strip() == "") for c in row):
            continue
        try:
            raw_date = cell(row, "date")
            if raw_date is None or not re.search(r"\d", str(raw_date)):
                continue  # dòng trống hoặc dòng "Tổng cộng" không có ngày
            try:
                txn_date, txn_time = parse_date(raw_date)
            except ValueError:
                # dòng chân trang kiểu "Số dư cuối kỳ: 6,494,320 VND" - không có số tiền phát sinh thì bỏ qua
                has_money = any(cell(row, f) not in (None, "") for f in ("debit", "credit", "amount"))
                if not has_money:
                    continue
                raise

            amount = None
            if "debit" in mapping or "credit" in mapping:
                debit = parse_amount(cell(row, "debit")) or 0
                credit = parse_amount(cell(row, "credit")) or 0
                amount = abs(credit) - abs(debit)
                if amount == 0 and "amount" in mapping:
                    amount = parse_amount(cell(row, "amount"))
            else:
                amount = parse_amount(cell(row, "amount"))
            if amount is None or amount == 0:
                continue

            description = str(cell(row, "description") or "").strip()
            description = re.sub(r"\s+", " ", description)
            counterparty = str(cell(row, "counterparty") or "").strip()
            bank_ref = cell(row, "ref")
            bank_ref = str(bank_ref).strip() if bank_ref not in (None, "") else None
            if isinstance(bank_ref, str) and bank_ref.endswith(".0"):
                bank_ref = bank_ref[:-2]
            bal = cell(row, "balance")
            balance_after = parse_amount(bal) if bal not in (None, "") else None

            txns.append({
                "txn_date": txn_date,
                "txn_time": txn_time,
                "amount": int(amount),
                "description": description,
                "counterparty": counterparty,
                "bank_ref": bank_ref,
                "balance_after": balance_after,
                "fingerprint": fingerprint(txn_date, int(amount), description, bank_ref, counterparty,
                                           txn_time, balance_after),
            })
        except Exception as e:  # noqa: BLE001
            errors.append({"row": rn, "error": str(e)})
    return {"transactions": txns, "errors": errors, "meta": extract_meta(rows)}
