from app import db, reports


def _add(conn, d, amount, code, desc=""):
    conn.execute("INSERT INTO transactions(txn_date, amount, description, category_code) VALUES(?,?,?,?)",
                 (d, amount, desc, code))


def test_pnl_follows_accounting_structure(fresh_db):
    with db.get_conn(fresh_db) as conn:
        _add(conn, "2026-08-01", 10_000_000, "DT_BAN_HANG")
        _add(conn, "2026-08-02", -500_000, "HOAN_TIEN")          # giảm trừ
        _add(conn, "2026-08-03", -4_000_000, "MUA_HANG")         # giá vốn
        _add(conn, "2026-08-03", 200_000, "MUA_HANG")            # NCC hoàn tiền -> giảm giá vốn
        _add(conn, "2026-08-04", -1_000_000, "QUANG_CAO")        # bán hàng
        _add(conn, "2026-08-04", -300_000, "VAN_CHUYEN_BAN")     # bán hàng
        _add(conn, "2026-08-05", -1_500_000, "THUE_MAT_BANG")    # quản lý
        _add(conn, "2026-08-06", 50_000, "LAI_NGAN_HANG")        # DT tài chính
        _add(conn, "2026-08-06", -20_000, "PHI_NGAN_HANG")       # CP tài chính
        _add(conn, "2026-08-07", 100_000, "THU_KHAC")
        _add(conn, "2026-08-07", -40_000, "PHAT_BOI_THUONG")
        _add(conn, "2026-08-08", -150_000, "THUE_KHOAN")
        _add(conn, "2026-08-09", 20_000_000, "VON_GOP")          # không vào P&L
        _add(conn, "2026-08-10", -5_000_000, "RUT_VON")          # không vào P&L
        _add(conn, "2026-08-11", -99_000, "CHUA_PHAN_LOAI")
        _add(conn, "2026-09-01", 999_999_999, "DT_BAN_HANG")     # ngoài kỳ
        settings = {"tax_vat_rate": "1.0", "tax_pit_rate": "0.5", "tax_threshold_year": "0"}
        r = reports.pnl(conn, "2026-08-01", "2026-08-31", settings)

    s = r["summary"]
    assert s["revenue"] == 10_000_000
    assert s["deductions"] == 500_000
    assert s["net_revenue"] == 9_500_000
    assert s["cogs"] == 3_800_000
    assert s["gross_profit"] == 5_700_000
    assert s["gross_margin_pct"] == 60.0
    assert s["selling"] == 1_300_000
    assert s["admin"] == 1_500_000
    assert s["fin_income"] == 50_000 and s["fin_expense"] == 20_000
    assert s["operating_profit"] == 5_700_000 + 50_000 - 20_000 - 1_300_000 - 1_500_000
    assert s["other_income"] == 100_000 and s["other_expense"] == 40_000
    assert s["profit_before_tax"] == s["operating_profit"] + 60_000
    assert s["tax_paid"] == 150_000
    assert s["profit_after_tax"] == s["profit_before_tax"] - 150_000
    # vốn góp / rút vốn không ảnh hưởng lợi nhuận nhưng có trong dòng tiền
    assert s["non_pl_in"] == 20_000_000 and s["non_pl_out"] == 5_000_000
    assert s["cash_in"] == 10_000_000 + 200_000 + 50_000 + 100_000 + 20_000_000
    assert s["unclassified_count"] == 1
    # thuế ước tính 1,5% doanh thu thuần
    assert r["tax_estimate"]["total"] == 95_000 + 47_500
    assert r["tax_estimate"]["profit_after_tax_est"] == s["profit_before_tax"] - 142_500
    codes = [l["code"] for l in r["lines"]]
    assert codes == ["01", "02", "10", "11", "20", "21", "22", "25", "26", "30", "31", "32", "40", "50", "51", "60"]


def test_tax_threshold(fresh_db):
    with db.get_conn(fresh_db) as conn:
        _add(conn, "2026-03-01", 50_000_000, "DT_BAN_HANG")
        settings = {"tax_vat_rate": "1.0", "tax_pit_rate": "0.5", "tax_threshold_year": "200000000"}
        r = reports.pnl(conn, "2026-03-01", "2026-03-31", settings)
        assert r["tax_estimate"]["below_threshold"] is True
        assert r["tax_estimate"]["total"] == 0
        _add(conn, "2026-01-15", 180_000_000, "DT_BAN_HANG")  # luỹ kế năm vượt ngưỡng
        r = reports.pnl(conn, "2026-03-01", "2026-03-31", settings)
        assert r["tax_estimate"]["below_threshold"] is False
        assert r["tax_estimate"]["total"] == 750_000


def test_tax_threshold_per_year_for_multi_year_period(fresh_db):
    """Kỳ 'Tất cả' (2000-01-01 → nay) phải xét ngưỡng theo từng năm, không lấy năm 2000."""
    with db.get_conn(fresh_db) as conn:
        _add(conn, "2025-06-01", 50_000_000, "DT_BAN_HANG")    # 2025 dưới ngưỡng
        _add(conn, "2026-02-01", 250_000_000, "DT_BAN_HANG")   # 2026 vượt ngưỡng
        settings = {"tax_vat_rate": "1.0", "tax_pit_rate": "0.5", "tax_threshold_year": "200000000"}
        r = reports.pnl(conn, "2000-01-01", "2027-12-31", settings)
        te = r["tax_estimate"]
        assert te["below_threshold"] is False
        assert te["total"] == 3_750_000  # chỉ 1,5% của 250tr năm 2026
        assert [y["year"] for y in te["years"]] == ["2025", "2026"]
        assert te["years"][0]["below_threshold"] is True and te["years"][1]["total"] == 3_750_000
        assert te["profit_after_tax_est"] == 300_000_000 - 3_750_000
        # kỳ chỉ nằm trong quý 1/2026 nhưng ngưỡng vẫn xét theo cả năm 2026
        r = reports.pnl(conn, "2026-01-01", "2026-03-31", settings)
        assert r["tax_estimate"]["total"] == 3_750_000


def test_category_breakdown_and_monthly(fresh_db):
    with db.get_conn(fresh_db) as conn:
        _add(conn, "2026-08-01", 1_000_000, "DT_BAN_HANG")
        _add(conn, "2026-08-02", -400_000, "MUA_HANG")
        _add(conn, "2026-08-03", -100_000, "QUANG_CAO")
        _add(conn, "2026-09-03", 2_000_000, "DT_BAN_HANG")
        br = reports.category_breakdown(conn, "2026-08-01", "2026-08-31")
        by = {i["code"]: i for i in br["items"]}
        assert by["MUA_HANG"]["value"] == 400_000 and by["MUA_HANG"]["pct_of_revenue"] == 40.0
        assert [i["grp"] for i in br["items"]] == ["REVENUE", "COGS", "SELLING"]
        m = reports.monthly_series(conn, 2026)["months"]
        aug, sep = m[7], m[8]
        assert aug["net_revenue"] == 1_000_000 and aug["cogs"] == 400_000 and aug["profit_before_tax"] == 500_000
        assert sep["net_revenue"] == 2_000_000 and sep["expenses"] == 0
        assert m[0]["cash_in"] == 0
