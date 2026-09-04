"""
Đóng gói app thành MỘT file HTML chạy hoàn toàn trong trình duyệt (không cần server).

    python tools/build_standalone.py                      # dữ liệu mặc định (không có giao dịch)
    python tools/build_standalone.py --db data/hkt.sqlite3 -o dist/hkt.html   # kèm dữ liệu từ DB
    python tools/build_standalone.py --fragment           # không có <html>/<head>/<body> (để nhúng)

File tạo ra mở trực tiếp bằng trình duyệt; dữ liệu chỉnh sửa lưu trong localStorage.
Đọc Excel dùng SheetJS tải từ cdnjs (cần mạng lần đầu); CSV đọc offline.
"""
import argparse
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import categories as cat  # noqa: E402
from app import db  # noqa: E402

STATIC = os.path.join(ROOT, "app", "static")
XLSX_CDN = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"


def export_seed(db_path):
    with db.get_conn(db_path) as conn:
        gm = cat.group_map()
        return {
            "groups": [gm[g] for g in cat.GROUP_ORDER],
            "categories": [dict(r) for r in conn.execute("SELECT * FROM categories ORDER BY sort_order, code")],
            "rules": [dict(r) for r in conn.execute("SELECT * FROM rules ORDER BY priority, id")],
            "settings": db.get_settings(conn),
            "transactions": [dict(r) for r in conn.execute("SELECT * FROM transactions ORDER BY id")],
        }


def build(db_path=None, fragment=False):
    if db_path is None:
        tmp = os.path.join(tempfile.mkdtemp(), "seed.sqlite3")
        db.init_db(tmp)
        db_path = tmp
    else:
        db.init_db(db_path)  # đảm bảo schema/quy tắc mới nhất
    seed = export_seed(db_path)
    seed_js = json.dumps(seed, ensure_ascii=False).replace("</", "<\\/")

    html = open(os.path.join(STATIC, "index.html"), encoding="utf-8").read()
    css = open(os.path.join(STATIC, "style.css"), encoding="utf-8").read()
    app_js = open(os.path.join(STATIC, "app.js"), encoding="utf-8").read()
    local_js = open(os.path.join(STATIC, "local-api.js"), encoding="utf-8").read()

    html = html.replace('<link rel="stylesheet" href="/static/style.css">', f"<style>\n{css}\n</style>")
    scripts = (
        f"<script>window.HKT_SEED = {seed_js};</script>\n"
        f'<script src="{XLSX_CDN}"></script>\n'
        f"<script>\n{local_js}\n</script>\n"
        f"<script>\n{app_js}\n</script>"
    )
    html = html.replace('<script src="/static/app.js"></script>', scripts)
    if fragment:
        head_start = html.index("<head>") + len("<head>")
        head_end = html.index("</head>")
        head = html[head_start:head_end]
        head = "\n".join(l for l in head.splitlines() if "<meta" not in l)
        body = html[html.index("<body>") + len("<body>"):html.index("</body>")]
        html = head.strip() + "\n" + body.strip() + "\n"
    return html


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", help="SQLite để lấy dữ liệu (mặc định: dữ liệu trống)")
    ap.add_argument("-o", "--out", default=os.path.join(ROOT, "dist", "hkt-standalone.html"))
    ap.add_argument("--fragment", action="store_true", help="Bỏ khung html/head/body")
    a = ap.parse_args()
    out = build(a.db, a.fragment)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"Đã tạo {a.out} ({len(out.encode('utf-8')) // 1024} KB)")


if __name__ == "__main__":
    main()
