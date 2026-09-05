from app.rules import expand_owner, normalize, suggest, rule_matches
from app.categories import DEFAULT_RULES


def _rules(owner="NGUYEN VAN A"):
    out = []
    for i, (n, p, mt, d, c, pr, f) in enumerate(DEFAULT_RULES):
        p = expand_owner(p, owner, mt)
        if p is None:
            continue
        out.append({"id": i + 1, "name": n, "pattern": p, "match_type": mt, "direction": d, "category_code": c,
                    "priority": pr, "enabled": 1, "field": f})
    return out


def test_normalize_strips_diacritics():
    assert normalize("Phí Vận Chuyển ĐƠN hàng") == "phi van chuyen don hang"
    assert normalize("  nhiều   khoảng  trắng ") == "nhieu khoang trang"


def test_direction_filter():
    rule = {"pattern": "shopee", "match_type": "contains", "direction": "in", "enabled": 1}
    assert rule_matches(rule, "SHOPEE PAYOUT", "", 100000)
    assert not rule_matches(rule, "SHOPEE PAYOUT", "", -100000)


def test_regex_rule():
    rule = {"pattern": r"don\s+#\d+", "match_type": "regex", "direction": "any", "enabled": 1}
    assert rule_matches(rule, "thanh toan đơn #1023", "", 100)
    assert not rule_matches(rule, "thanh toan don hang", "", 100)


def test_default_rules_cover_common_cases():
    rules = _rules()
    cases = [
        ("SHOPEE PAYOUT ky 01-04/08", "", 6750000, "DT_BAN_HANG"),
        ("Phi dich vu san Shopee", "", -320000, "PHI_SAN"),
        ("GHTK phi van chuyen don", "", -35000, "VAN_CHUYEN_BAN"),
        ("GIAO HANG NHANH thanh toan COD", "", 5400000, "DT_BAN_HANG"),
        ("META PLATFORMS thanh toan quang cao", "", -2000000, "QUANG_CAO"),
        ("Tra lai tien gui thang 8", "", 12345, "LAI_NGAN_HANG"),
        ("Phi SMS Banking", "", -11000, "PHI_NGAN_HANG"),
        ("Nop thue GTGT TNCN quy 3 - Kho bac", "", -350000, "THUE_KHOAN"),
        ("Hoan tien khach hang huy don", "", -150000, "HOAN_TIEN"),
        ("Nhap hang dot 2 - Xuong may", "", -5000000, "MUA_HANG"),
        ("Tra tien thue kho thang 8", "", -3000000, "THUE_MAT_BANG"),
        ("Tra luong nhan vien", "", -4000000, "LUONG"),
        ("NGUYEN VAN A chuyen tien gop von kinh doanh", "", 15000000, "VON_GOP"),
        ("rut tien chi tieu ca nhan", "", -3000000, "RUT_VON"),
        ("TRAN THI B chuyen khoan thanh toan don hang #1023", "", 450000, "DT_BAN_HANG"),
    ]
    for desc, cp, amount, expected in cases:
        code, rule_id = suggest(rules, desc, cp, amount)
        assert code == expected, f"{desc!r} -> {code}, expected {expected}"
        assert rule_id


def test_no_match_returns_none():
    code, rule_id = suggest(_rules(), "Mua may in tem nhiet", "", -890000)
    assert code is None and rule_id is None


def test_field_scoped_rule_only_looks_at_counterparty():
    rule = {"pattern": "nguyen van a", "match_type": "contains", "direction": "any", "enabled": 1, "field": "counterparty"}
    assert rule_matches(rule, "chuyen tien", "NGUYỄN VĂN A", -100)
    # tên chủ TK xuất hiện trong nội dung ("CUSTOMER NGUYEN VAN A chuyen tien") nhưng đối tác là người khác
    assert not rule_matches(rule, "CUSTOMER NGUYEN VAN A chuyen tien", "TRAN ANH QUAN", -100)


def test_owner_rule_real_mb_layout():
    rules = _rules("HO KHAC TRUYEN")
    # chuyển cho chính mình -> nội bộ, dù nội dung giống khách chuyển khoản
    code, _ = suggest(rules, "CUSTOMER HO KHAC TRUYEN chuyen tien. DEN: HO KHAC TRUYEN", "HO KHAC TRUYEN", -1_000_000)
    assert code == "CHUYEN_NOI_BO"
    code, _ = suggest(rules, "HO KHAC TRUYEN Chuyen tien- Ma GD", "HO KHAC TRUYEN", 15_000_000)
    assert code == "CHUYEN_NOI_BO"
    # chuyển cho người khác, nội dung vẫn chứa tên chủ TK -> không phải nội bộ
    code, _ = suggest(rules, "CUSTOMER HO KHAC TRUYEN chuyen tien", "TRAN ANH QUAN", -6_000_000)
    assert code is None
    # COD Viettel Post về -> doanh thu ; trả nợ thẻ tín dụng -> không tính lãi lỗ
    code, _ = suggest(rules, "Tong cong ty co phan Buu chinh Viet VTP GLMTQY05 050826", "TONG CONG TY CO PHAN BUU CHINH VIETTEL", 3_122_361)
    assert code == "DT_BAN_HANG"
    code, _ = suggest(rules, "CUSTOMER THU NO THE TIN DUNG THANG 08.2026", "", -2_366_200)
    assert code == "TRA_NO_GOC"


def test_owner_placeholder_skipped_without_owner():
    assert expand_owner("{owner}", "") is None
    assert expand_owner("{owner}", "Hồ Khắc Truyền") == "ho khac truyen"
    assert expand_owner("^{owner}$", "A.B", "regex") == "^a\\.b$"
    assert expand_owner("ghtk", "") == "ghtk"
    assert all(r["pattern"] != "{owner}" for r in _rules(owner=""))
