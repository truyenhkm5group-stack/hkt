import io
from datetime import datetime

import openpyxl
import pytest

from app import importer
from tests.conftest import SAMPLE


@pytest.mark.parametrize("raw,expected", [
    ("1.234.567", 1234567), ("1,234,567", 1234567), ("1234567", 1234567),
    ("1234567.00", 1234567), ("1.234.567,50", 1234568), ("-500.000", -500000),
    ("(500.000)", -500000), ("+12,345", 12345), ("  ", None), ("", None), (None, None),
    (1500.0, 1500), ("12.345 VND", 12345), ("1.5", 2),
])
def test_parse_amount(raw, expected):
    assert importer.parse_amount(raw) == expected


def test_parse_amount_invalid():
    with pytest.raises(ValueError):
        importer.parse_amount("abc")


@pytest.mark.parametrize("raw,expected", [
    ("01/08/2026", ("2026-08-01", None)),
    ("01/08/2026 08:15:22", ("2026-08-01", "08:15:22")),
    ("2026-08-01", ("2026-08-01", None)),
    ("2026-08-01 10:00:00", ("2026-08-01", "10:00:00")),
    ("01-08-2026 10:00", ("2026-08-01", "10:00:00")),
    ("01/08/2026\n08:15:22", ("2026-08-01", "08:15:22")),
    (datetime(2026, 8, 1, 9, 30), ("2026-08-01", "09:30:00")),
])
def test_parse_date(raw, expected):
    assert importer.parse_date(raw) == expected


def test_parse_sample_csv():
    with open(SAMPLE, "rb") as f:
        txns, errors = importer.parse_statement("mb.csv", f.read())
    assert errors == []
    assert len(txns) == 26  # bỏ qua dòng tiêu đề, dòng trống, dòng tổng cộng
    first = txns[0]
    assert first["txn_date"] == "2026-08-01"
    assert first["txn_time"] == "08:15:22"
    assert first["amount"] == 15_000_000
    assert first["bank_ref"] == "FT26213000001"
    assert first["balance_after"] == 25_000_000
    debit = txns[1]
    assert debit["amount"] == -8_500_000
    assert sum(t["amount"] for t in txns if t["amount"] > 0) == 38_852_345
    assert sum(-t["amount"] for t in txns if t["amount"] < 0) == 28_721_000
    assert len({t["fingerprint"] for t in txns}) == 26


def test_parse_xlsx_with_signed_amount_column():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Sao kê tài khoản"])
    ws.append([])
    ws.append(["Ngày GD", "Số tiền", "Nội dung", "Đối tác", "Mã giao dịch"])
    ws.append([datetime(2026, 8, 3, 9, 0), -35000, "GHTK phi ship", "GHTK", "A1"])
    ws.append(["04/08/2026", "1.200.000", "Khach tt don hang", "LE VAN C", "A2"])
    ws.append([None, None, "Tổng", None, None])
    buf = io.BytesIO()
    wb.save(buf)
    txns, errors = importer.parse_statement("sao_ke.xlsx", buf.getvalue())
    assert errors == []
    assert [t["amount"] for t in txns] == [-35000, 1200000]
    assert txns[0]["counterparty"] == "GHTK"
    assert txns[1]["txn_date"] == "2026-08-04"


def test_header_detection_failure():
    data = "a,b,c\n1,2,3\n".encode("utf-8")
    with pytest.raises(importer.ImportError_):
        importer.parse_statement("x.csv", data)


def test_semicolon_csv_and_utf8_bom():
    csv_text = "﻿Ngày giao dịch;Ghi nợ;Ghi có;Nội dung\n05/08/2026;;500000;Khach chuyen khoan\n06/08/2026;20000;;Phi SMS\n"
    txns, errors = importer.parse_statement("mb.csv", csv_text.encode("utf-8"))
    assert errors == []
    assert [t["amount"] for t in txns] == [500000, -20000]


def test_fingerprint_prefers_bank_ref():
    a = importer.fingerprint("2026-08-01", 100, "abc", "REF1")
    b = importer.fingerprint("2026-08-01", 100, "khac", "REF1")
    c = importer.fingerprint("2026-08-01", 100, "abc", None)
    assert a == b and a != c
