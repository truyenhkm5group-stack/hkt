"""
Tính toán báo cáo kết quả kinh doanh (P&L) theo cơ sở TIỀN (cash basis).

Vì dữ liệu lấy từ sao kê ngân hàng nên doanh thu / chi phí được ghi nhận
tại thời điểm tiền thực vào / ra tài khoản. Cách này phù hợp với hộ kinh
doanh cá thể (nộp thuế theo doanh thu thực thu - TT 40/2021, TT 88/2021).

Quy ước dấu: amount > 0 là tiền vào, amount < 0 là tiền ra.
Số dư ròng của một nhóm = SUM(amount). Ví dụ nhóm COGS thường âm; nếu nhà
cung cấp hoàn tiền (dương) thì tự động làm giảm giá vốn - đúng nghiệp vụ.
"""
from decimal import Decimal, ROUND_HALF_UP

from . import categories as cat


def _group_totals(conn, date_from, date_to):
    rows = conn.execute(
        """
        SELECT c.grp AS grp, COALESCE(SUM(t.amount), 0) AS net,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS cash_in,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS cash_out,
               COUNT(*) AS n
        FROM transactions t
        LEFT JOIN categories c ON c.code = t.category_code
        WHERE t.txn_date BETWEEN ? AND ?
        GROUP BY c.grp
        """,
        (date_from, date_to),
    )
    totals = {g: {"net": 0, "cash_in": 0, "cash_out": 0, "n": 0} for g in cat.GROUP_ORDER}
    for r in rows:
        g = r["grp"] or "UNCLASSIFIED"
        totals.setdefault(g, {"net": 0, "cash_in": 0, "cash_out": 0, "n": 0})
        totals[g]["net"] += r["net"]
        totals[g]["cash_in"] += r["cash_in"]
        totals[g]["cash_out"] += r["cash_out"]
        totals[g]["n"] += r["n"]
    return totals


def _pct(part, base):
    if not base:
        return None
    return float(Decimal(part * 100 / base).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def estimate_tax(revenue_net, settings, year_revenue=None):
    """Thuế hộ kinh doanh ước tính = doanh thu thuần x (GTGT% + TNCN%).
    Nếu doanh thu cả năm (year_revenue) dưới ngưỡng thì = 0."""
    vat = float(settings.get("tax_vat_rate", "1.0") or 0)
    pit = float(settings.get("tax_pit_rate", "0.5") or 0)
    threshold = float(settings.get("tax_threshold_year", "0") or 0)
    basis = year_revenue if year_revenue is not None else revenue_net
    if threshold and basis <= threshold:
        return {"vat": 0, "pit": 0, "total": 0, "below_threshold": True,
                "vat_rate": vat, "pit_rate": pit, "threshold": threshold}
    vat_amt = int(round(revenue_net * vat / 100))
    pit_amt = int(round(revenue_net * pit / 100))
    return {"vat": vat_amt, "pit": pit_amt, "total": vat_amt + pit_amt, "below_threshold": False,
            "vat_rate": vat, "pit_rate": pit, "threshold": threshold}


def _net_revenue(conn, date_from, date_to):
    """Doanh thu thuần (doanh thu - giảm trừ) trong khoảng ngày."""
    return conn.execute(
        """SELECT COALESCE(SUM(t.amount),0) FROM transactions t
           JOIN categories c ON c.code = t.category_code
           WHERE c.grp IN ('REVENUE','REVENUE_DEDUCTION') AND t.txn_date BETWEEN ? AND ?""",
        (date_from, date_to),
    ).fetchone()[0]


def tax_estimate_for_period(conn, date_from, date_to, settings):
    """Ước tính thuế cho kỳ, tính riêng từng năm dương lịch mà kỳ đi qua.

    Ngưỡng miễn thuế áp dụng theo doanh thu cả năm, nên với kỳ trải nhiều năm
    (ví dụ "Tất cả") phải xét từng năm: thuế của phần doanh thu thuộc năm Y
    chỉ phát sinh nếu tổng doanh thu năm Y vượt ngưỡng."""
    years = range(int(date_from[:4]), int(date_to[:4]) + 1)
    per_year = []
    for y in years:
        f = max(date_from, f"{y}-01-01")
        t = min(date_to, f"{y}-12-31")
        period_rev = _net_revenue(conn, f, t)
        year_rev = _net_revenue(conn, f"{y}-01-01", f"{y}-12-31")
        est = estimate_tax(period_rev, settings, year_revenue=year_rev)
        per_year.append({"year": str(y), "period_net_revenue": period_rev, "year_net_revenue": year_rev, **est})
    active = [p for p in per_year if p["period_net_revenue"] or p["year_net_revenue"]] or per_year[-1:]
    total = {
        "vat": sum(p["vat"] for p in per_year),
        "pit": sum(p["pit"] for p in per_year),
        "total": sum(p["total"] for p in per_year),
        "below_threshold": all(p["below_threshold"] for p in active),
        "vat_rate": per_year[0]["vat_rate"], "pit_rate": per_year[0]["pit_rate"], "threshold": per_year[0]["threshold"],
        "years": active,
        # tương thích: năm và doanh thu năm của năm cuối có phát sinh
        "year": active[-1]["year"],
        "year_net_revenue": active[-1]["year_net_revenue"],
    }
    return total


def pnl(conn, date_from, date_to, settings):
    g = _group_totals(conn, date_from, date_to)

    revenue = g["REVENUE"]["net"]                    # 01
    deductions = -g["REVENUE_DEDUCTION"]["net"]      # 02 (tiền ra -> dương)
    net_revenue = revenue - deductions               # 10
    cogs = -g["COGS"]["net"]                         # 11
    gross_profit = net_revenue - cogs                # 20
    fin_income = g["FIN_INCOME"]["net"]              # 21
    fin_expense = -g["FIN_EXPENSE"]["net"]           # 22
    selling = -g["SELLING"]["net"]                   # 25
    admin = -g["ADMIN"]["net"]                       # 26
    operating_profit = gross_profit + fin_income - fin_expense - selling - admin  # 30
    other_income = g["OTHER_INCOME"]["net"]          # 31
    other_expense = -g["OTHER_EXPENSE"]["net"]       # 32
    other_profit = other_income - other_expense      # 40
    profit_before_tax = operating_profit + other_profit  # 50
    tax_paid = -g["TAX"]["net"]                      # 51 (thực nộp trong kỳ)
    profit_after_tax = profit_before_tax - tax_paid  # 60

    tax_est = tax_estimate_for_period(conn, date_from, date_to, settings)
    profit_after_tax_est = profit_before_tax - tax_est["total"]

    total_expenses = cogs + selling + admin + fin_expense + other_expense
    cash_in = sum(v["cash_in"] for v in g.values())
    cash_out = sum(v["cash_out"] for v in g.values())

    # Số dư đầu/cuối kỳ (nếu sao kê có cột số dư)
    first = conn.execute(
        "SELECT balance_after, amount FROM transactions WHERE txn_date BETWEEN ? AND ? AND balance_after IS NOT NULL "
        "ORDER BY txn_date, COALESCE(txn_time,''), id LIMIT 1", (date_from, date_to)).fetchone()
    last = conn.execute(
        "SELECT balance_after FROM transactions WHERE txn_date BETWEEN ? AND ? AND balance_after IS NOT NULL "
        "ORDER BY txn_date DESC, COALESCE(txn_time,'') DESC, id DESC LIMIT 1", (date_from, date_to)).fetchone()
    opening_balance = (first["balance_after"] - first["amount"]) if first else None
    closing_balance = last["balance_after"] if last else None

    lines = [
        {"code": "01", "label": "Doanh thu bán hàng và cung cấp dịch vụ", "value": revenue, "level": 1},
        {"code": "02", "label": "Các khoản giảm trừ doanh thu", "value": deductions, "level": 1, "negative": True},
        {"code": "10", "label": "Doanh thu thuần (10 = 01 - 02)", "value": net_revenue, "level": 0},
        {"code": "11", "label": "Giá vốn hàng bán", "value": cogs, "level": 1, "negative": True},
        {"code": "20", "label": "Lợi nhuận gộp (20 = 10 - 11)", "value": gross_profit, "level": 0},
        {"code": "21", "label": "Doanh thu hoạt động tài chính", "value": fin_income, "level": 1},
        {"code": "22", "label": "Chi phí tài chính", "value": fin_expense, "level": 1, "negative": True},
        {"code": "25", "label": "Chi phí bán hàng", "value": selling, "level": 1, "negative": True},
        {"code": "26", "label": "Chi phí quản lý", "value": admin, "level": 1, "negative": True},
        {"code": "30", "label": "Lợi nhuận thuần từ hoạt động kinh doanh (30 = 20 + 21 - 22 - 25 - 26)",
         "value": operating_profit, "level": 0},
        {"code": "31", "label": "Thu nhập khác", "value": other_income, "level": 1},
        {"code": "32", "label": "Chi phí khác", "value": other_expense, "level": 1, "negative": True},
        {"code": "40", "label": "Lợi nhuận khác (40 = 31 - 32)", "value": other_profit, "level": 0},
        {"code": "50", "label": "Tổng lợi nhuận kế toán trước thuế (50 = 30 + 40)", "value": profit_before_tax, "level": 0, "highlight": True},
        {"code": "51", "label": "Thuế đã nộp trong kỳ (GTGT + TNCN hộ kinh doanh)", "value": tax_paid, "level": 1, "negative": True},
        {"code": "60", "label": "Lợi nhuận sau thuế (60 = 50 - 51)", "value": profit_after_tax, "level": 0, "highlight": True},
    ]

    return {
        "period": {"from": date_from, "to": date_to},
        "lines": lines,
        "summary": {
            "revenue": revenue,
            "deductions": deductions,
            "net_revenue": net_revenue,
            "cogs": cogs,
            "gross_profit": gross_profit,
            "gross_margin_pct": _pct(gross_profit, net_revenue),
            "selling": selling,
            "admin": admin,
            "fin_income": fin_income,
            "fin_expense": fin_expense,
            "operating_profit": operating_profit,
            "other_income": other_income,
            "other_expense": other_expense,
            "profit_before_tax": profit_before_tax,
            "tax_paid": tax_paid,
            "profit_after_tax": profit_after_tax,
            "net_margin_pct": _pct(profit_after_tax, net_revenue),
            "total_expenses": total_expenses,
            "expense_ratio_pct": _pct(total_expenses, net_revenue),
            "cash_in": cash_in,
            "cash_out": cash_out,
            "net_cash_flow": cash_in - cash_out,
            "opening_balance": opening_balance,
            "closing_balance": closing_balance,
            "non_pl_in": g["NON_PL"]["cash_in"],
            "non_pl_out": g["NON_PL"]["cash_out"],
            "unclassified_count": g["UNCLASSIFIED"]["n"],
            "unclassified_in": g["UNCLASSIFIED"]["cash_in"],
            "unclassified_out": g["UNCLASSIFIED"]["cash_out"],
        },
        "tax_estimate": {**tax_est, "profit_after_tax_est": profit_after_tax_est},
        "groups": g,
    }


def category_breakdown(conn, date_from, date_to):
    """Chi tiết từng đầu mục (danh mục) trong kỳ, kèm % so với doanh thu thuần."""
    rows = conn.execute(
        """
        SELECT c.code, c.name, c.grp, COALESCE(SUM(t.amount),0) AS net,
               COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END),0) AS cash_in,
               COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount ELSE 0 END),0) AS cash_out,
               COUNT(t.id) AS n
        FROM transactions t
        LEFT JOIN categories c ON c.code = t.category_code
        WHERE t.txn_date BETWEEN ? AND ?
        GROUP BY c.code, c.name, c.grp
        """,
        (date_from, date_to),
    ).fetchall()
    gm = cat.group_map()
    order = {g: i for i, g in enumerate(cat.GROUP_ORDER)}
    net_rev = _net_revenue(conn, date_from, date_to)
    items = []
    for r in rows:
        grp = r["grp"] or "UNCLASSIFIED"
        code = r["code"] or cat.UNCLASSIFIED_CODE
        name = r["name"] or "Chưa phân loại"
        # Giá trị "kế toán": chi phí hiển thị dương, doanh thu dương
        kind = gm[grp]["kind"]
        value = -r["net"] if kind == "out" else r["net"]
        items.append({
            "code": code, "name": name, "grp": grp, "grp_name": gm[grp]["name"],
            "account": gm[grp]["account"], "net": r["net"], "value": value,
            "cash_in": r["cash_in"], "cash_out": r["cash_out"], "count": r["n"],
            "pct_of_revenue": None if grp in ("NON_PL", "UNCLASSIFIED") else _pct(value, net_rev),
        })
    items.sort(key=lambda x: (order.get(x["grp"], 99), -abs(x["value"])))
    return {"period": {"from": date_from, "to": date_to}, "net_revenue": net_rev, "items": items}


def monthly_series(conn, year):
    rows = conn.execute(
        """
        SELECT substr(t.txn_date,1,7) AS ym, COALESCE(c.grp,'UNCLASSIFIED') AS grp,
               COALESCE(SUM(t.amount),0) AS net,
               COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END),0) AS cash_in,
               COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount ELSE 0 END),0) AS cash_out
        FROM transactions t LEFT JOIN categories c ON c.code = t.category_code
        WHERE t.txn_date BETWEEN ? AND ?
        GROUP BY ym, grp
        """,
        (f"{year}-01-01", f"{year}-12-31"),
    ).fetchall()
    months = {f"{year}-{m:02d}": {"month": f"{year}-{m:02d}", "revenue": 0, "deductions": 0, "cogs": 0,
                                  "selling": 0, "admin": 0, "fin_income": 0, "fin_expense": 0,
                                  "other_income": 0, "other_expense": 0, "tax": 0,
                                  "cash_in": 0, "cash_out": 0} for m in range(1, 13)}
    key = {"REVENUE": ("revenue", 1), "REVENUE_DEDUCTION": ("deductions", -1), "COGS": ("cogs", -1),
           "SELLING": ("selling", -1), "ADMIN": ("admin", -1), "FIN_INCOME": ("fin_income", 1),
           "FIN_EXPENSE": ("fin_expense", -1), "OTHER_INCOME": ("other_income", 1),
           "OTHER_EXPENSE": ("other_expense", -1), "TAX": ("tax", -1)}
    for r in rows:
        m = months.get(r["ym"])
        if not m:
            continue
        m["cash_in"] += r["cash_in"]
        m["cash_out"] += r["cash_out"]
        if r["grp"] in key:
            field, sign = key[r["grp"]]
            m[field] += sign * r["net"]
    out = []
    for m in months.values():
        m["net_revenue"] = m["revenue"] - m["deductions"]
        m["gross_profit"] = m["net_revenue"] - m["cogs"]
        m["expenses"] = m["cogs"] + m["selling"] + m["admin"] + m["fin_expense"] + m["other_expense"]
        m["profit_before_tax"] = (m["gross_profit"] + m["fin_income"] - m["fin_expense"]
                                  - m["selling"] - m["admin"] + m["other_income"] - m["other_expense"])
        m["profit_after_tax"] = m["profit_before_tax"] - m["tax"]
        out.append(m)
    return {"year": year, "months": out}
