from tests.conftest import SAMPLE


def test_import_sample_then_report(client):
    with open(SAMPLE, "rb") as f:
        r = client.post("/api/import?dry_run=true", files={"file": ("mb.csv", f.read(), "text/csv")})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["dry_run"] and j["parsed"] == 26 and j["imported"] == 26 and j["skipped_duplicates"] == 0
    assert client.get("/api/stats").json()["transactions"] == 0  # dry run không ghi

    with open(SAMPLE, "rb") as f:
        r = client.post("/api/import", files={"file": ("mb.csv", f.read(), "text/csv")})
    j = r.json()
    assert j["imported"] == 26
    assert j["auto_labeled"] >= 22
    # nhập lại lần 2: toàn bộ trùng
    with open(SAMPLE, "rb") as f:
        r = client.post("/api/import", files={"file": ("mb.csv", f.read(), "text/csv")})
    assert r.json()["imported"] == 0 and r.json()["skipped_duplicates"] == 26

    pnl = client.get("/api/reports/pnl?date_from=2026-08-01&date_to=2026-08-31").json()
    s = pnl["summary"]
    assert s["revenue"] == 450_000 + 1_200_000 + 6_750_000 + 5_400_000 + 2_300_000 + 7_100_000
    assert s["deductions"] == 150_000
    assert s["cogs"] == 8_500_000 + 5_000_000
    assert s["selling"] == 35_000 * 2 + 2_000_000 + 320_000 + 250_000 + 410_000
    assert s["admin"] == 3_000_000 + 550_000 + 220_000 + 4_000_000
    assert s["fin_income"] == 12_345 and s["fin_expense"] == 11_000
    assert s["tax_paid"] == 350_000
    assert s["non_pl_in"] == 15_000_000 and s["non_pl_out"] == 3_000_000
    assert s["opening_balance"] == 10_000_000 and s["closing_balance"] == 20_131_345
    # 2 giao dịch không có quy tắc: máy in tem, "Hoang E gui tien"
    assert s["unclassified_count"] == 2

    # gán tay giao dịch chưa phân loại
    un = client.get("/api/transactions?unclassified=true").json()
    assert un["total"] == 2
    ids = [t["id"] for t in un["items"]]
    r = client.post("/api/transactions/bulk-categorize", json={"ids": ids, "category_code": "MUA_TAI_SAN"})
    assert r.json()["updated"] == 2
    assert client.get("/api/stats").json()["unclassified"] == 0

    # apply rules (không gán tay) không đè lên nhãn tay
    r = client.post("/api/rules/apply", json={"only_unclassified": False}).json()
    t = client.get("/api/transactions?category=MUA_TAI_SAN").json()
    assert t["total"] == 2

    csv_out = client.get("/api/export.csv?date_from=2026-08-01&date_to=2026-08-31")
    assert csv_out.status_code == 200 and csv_out.text.count("\n") == 27


def test_manual_transaction_and_rules(client):
    r = client.post("/api/transactions", json={"txn_date": "05/08/2026", "amount": -75000, "description": "GHTK phí ship đơn 99"})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["txn_date"] == "2026-08-05" and t["category_code"] == "VAN_CHUYEN_BAN" and t["labeled_by"].startswith("rule:")

    r = client.patch(f"/api/transactions/{t['id']}", json={"category_code": "DONG_GOI", "note": "test"})
    assert r.json()["category_code"] == "DONG_GOI" and r.json()["labeled_by"] == "manual"

    r = client.post("/api/transactions", json={"txn_date": "2026-08-06", "amount": -120000, "description": "Thue host livestream toi thu 7"})
    assert r.json()["category_code"] == "CHUA_PHAN_LOAI"

    r = client.post("/api/categories", json={"code": "phi livestream", "name": "Phí livestream", "grp": "SELLING", "kind": "out"})
    assert r.status_code == 201 and r.json()["code"] == "PHI_LIVESTREAM"
    r = client.post("/api/rules", json={"name": "Livestream", "pattern": "livestream", "direction": "out", "category_code": "PHI_LIVESTREAM", "priority": 5})
    assert r.status_code == 201
    test = client.get("/api/rules/test?pattern=livestream&direction=out").json()
    assert test["count"] == 1
    r = client.post("/api/rules/apply", json={"only_unclassified": True}).json()
    assert r["updated"] == 1
    tx = client.get("/api/transactions?category=PHI_LIVESTREAM").json()
    assert tx["total"] == 1

    assert client.post("/api/rules", json={"pattern": "(", "match_type": "regex", "category_code": "DONG_GOI"}).status_code == 400
    assert client.post("/api/transactions", json={"txn_date": "2026-08-06", "amount": 0}).status_code == 400
    assert client.delete("/api/categories/DONG_GOI").status_code == 400
    r = client.delete("/api/categories/PHI_LIVESTREAM")
    assert r.status_code == 200
    assert client.get("/api/transactions?unclassified=true").json()["total"] == 1


def test_settings_and_delete_all(client):
    r = client.put("/api/settings", json={"values": {"shop_name": "Shop Test", "tax_vat_rate": "1"}})
    assert r.json()["shop_name"] == "Shop Test"
    assert client.put("/api/settings", json={"values": {"bogus": "1"}}).status_code == 400
    client.post("/api/transactions", json={"txn_date": "2026-08-06", "amount": 1000, "description": "x"})
    assert client.delete("/api/transactions").status_code == 400
    assert client.delete("/api/transactions?confirm=XOA").json()["deleted"] == 1
    assert client.get("/").status_code == 200
