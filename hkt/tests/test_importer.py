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


def test_same_day_identical_transfers_without_ref_are_kept():
    csv_text = ("Ngày giao dịch,Số tiền,Nội dung\n"
                "05/08/2026 09:00:00,-35000,GHTK phi ship\n"
                "05/08/2026 15:30:00,-35000,GHTK phi ship\n")
    txns, errors = importer.parse_statement("mb.csv", csv_text.encode("utf-8"))
    assert errors == [] and len(txns) == 2
    assert txns[0]["fingerprint"] != txns[1]["fingerprint"]
    # không có giờ nhưng có số dư khác nhau cũng phân biệt được
    csv_text = ("Ngày giao dịch,Số tiền,Số dư,Nội dung\n"
                "05/08/2026,-35000,965000,GHTK phi ship\n"
                "05/08/2026,-35000,930000,GHTK phi ship\n")
    txns, _ = importer.parse_statement("mb.csv", csv_text.encode("utf-8"))
    assert txns[0]["fingerprint"] != txns[1]["fingerprint"]
    # cùng file nhập lại vẫn ra vân tay y hệt (khử trùng giữa các lần nhập)
    txns2, _ = importer.parse_statement("mb.csv", csv_text.encode("utf-8"))
    assert [t["fingerprint"] for t in txns] == [t["fingerprint"] for t in txns2]


def test_fingerprint_prefers_bank_ref():
    a = importer.fingerprint("2026-08-01", 100, "abc", "REF1")
    b = importer.fingerprint("2026-08-01", 100, "khac", "REF1")
    c = importer.fingerprint("2026-08-01", 100, "abc", None)
    assert a == b and a != c


def _mb_so_phu_xlsx():
    """Mô phỏng file 'Sổ phụ chi tiết kiêm báo nợ/báo có' xuất từ MBBank (tên/số TK giả)."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append([None, "SỔ PHỤ CHI TIẾT KIÊM BÁO NỢ/BÁO CÓ", None, None, None, None, "NGÂN HÀNG TMCP QUÂN ĐỘI"])
    ws.append([None, "Từ ngày / From: 01/08/2026 Đến ngày / To: 31/08/2026"])
    ws.append(["Tên khách hàng/ Customer name: NGUYEN VAN A", None, None, None, None, None, None,
               "Tài khoản/ Account No: 1234567890"])
    ws.append(["Số dư đầu kỳ/ Opening Balance: 2,154 VND"])
    ws.append(["Ngày giao dịch", "Ngày hạch toán", "Số bút toán", "Phát sinh nợ", "Phát sinh có", "Số dư lũy kế",
               "Nội dung", "Đơn vị thụ hưởng/ Đơn vị chuyển", "Tài khoản", "Ngân hàng đối tác"])
    ws.append(["Transaction date", "Accounting Date", "Transaction No", "Debit", "Credit", "Accumulated balance",
               "Details", "Beneficiary/Applicant", "Account", "Remitter Bank"])
    ws.append(["05/08/2026 14:08:08", "05/08/2026", "FT26217021601512", "", "3,122,361", "3,124,515",
               "Tong cong ty co phan Buu chinh Viet VTP GLMTQY05", "TONG CONG TY CO PHAN BUU CHINH VIETTEL", "0001", "MB"])
    ws.append(["10/08/2026 09:45:51", "10/08/2026", "FT26222139215282", "500,000", "", "2,624,515",
               "CUSTOMER NGUYEN VAN A chuyen tien. DEN: NGUYEN VAN A", "NGUYEN VAN A", "0002", "MB"])
    ws.append(["Tổng phát sinh trong kỳ / Total", None, None, "500,000", "3,122,361"])
    ws.append(["Số dư cuối kỳ / Closing Balance: 2,624,515 VND (Bằng chữ / In Words: Hai triệu ...)"])
    ws.append(["Chứng từ này được xuất tự động từ hệ thống của Ngân hàng TMCP Quân đội."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_parse_mb_so_phu_layout():
    r = importer.parse_statement_full("SAO_KE_TAI_KHOAN.xlsx", _mb_so_phu_xlsx())
    assert r["errors"] == []
    txns = r["transactions"]
    assert len(txns) == 2  # bỏ dòng tiêu đề tiếng Anh, dòng tổng, dòng số dư cuối kỳ
    assert txns[0]["amount"] == 3_122_361 and txns[0]["balance_after"] == 3_124_515
    assert txns[0]["bank_ref"] == "FT26217021601512"
    assert txns[0]["counterparty"] == "TONG CONG TY CO PHAN BUU CHINH VIETTEL"  # không phải cột "Ngân hàng đối tác"
    assert txns[1]["amount"] == -500_000 and txns[1]["txn_time"] == "09:45:51"
    assert r["meta"] == {"owner_name": "NGUYEN VAN A", "account_no": "1234567890",
                         "opening_balance": 2154, "closing_balance": 2_624_515}
