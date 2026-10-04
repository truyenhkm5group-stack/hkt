"""
legacy_import.py — Lấy cấu hình từ BOT CŨ (thư mục `chatbot/`, Node.js) trên cùng máy.

Bot cũ giữ khoá ở các chỗ (không chỗ nào nằm trong kho mã — kho PUBLIC):
  * `chatbot/.env`                       PANCAKE_PAGES_JSON | PANCAKE_PAGE_ID + PANCAKE_PAGE_ACCESS_TOKEN,
                                         GEMINI_API_KEY, GEMINI_MODEL, POS_SHOP_ID, POS_API_KEY, SHOP_NAME
  * `BOT_ENV_FILE` (bản VPS)             cùng dạng .env
  * `chatbot/data/pages_tokens.json`     page thêm trong app quản lý — ghi đè .env khi trùng id (đúng luật bot cũ)
  * `SYSTEM_PROMPT_FILE` / `chatbot/prompts/system.md`  kịch bản tư vấn: thông tin shop, bảng size, bảng giá

Nguyên tắc:
  * `preview()` CHỈ ĐỌC và CHE token — không bao giờ trả token thật ra giao diện / log.
  * `apply()` chỉ ghi vào cài đặt của app mới; không sửa gì của bot cũ.
  * App mới chạy MỘT page; bot cũ nhiều page thì người chọn (tự nhập chỉ khi có đúng một page).
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import database as db

APP_DIR = os.path.dirname(os.path.abspath(__file__))


def candidate_dirs() -> list[str]:
    out = []
    for d in [os.environ.get("OLD_BOT_DIR", ""), os.path.join(APP_DIR, "..", "chatbot"), os.path.join(APP_DIR, "chatbot")]:
        if d:
            d = os.path.abspath(d)
            if d not in out and os.path.isdir(d):
                out.append(d)
    return out


def parse_env_file(path: str) -> dict[str, str]:
    """Cùng luật với loadDotEnv() của bot cũ: bỏ dòng #, bỏ một cặp nháy bao ngoài."""
    vals: dict[str, str] = {}
    if not os.path.isfile(path):
        return vals
    with open(path, encoding="utf-8-sig") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            vals.setdefault(key, val)
    return vals


def _mask(token: str) -> str:
    return ("•" * 6 + token[-4:]) if len(token) > 10 else "•" * 6


def read_old_bot(bot_dir: str) -> dict[str, Any]:
    bot_dir = os.path.abspath(bot_dir)
    env = parse_env_file(os.path.join(bot_dir, ".env"))
    extra = env.get("BOT_ENV_FILE") or os.environ.get("BOT_ENV_FILE")
    for f in [extra, os.path.join(bot_dir, "data", "bot.env")]:
        if f and os.path.isfile(f):
            for k, v in parse_env_file(f).items():
                env.setdefault(k, v)

    pages: dict[str, dict[str, str]] = {}
    raw_json = env.get("PANCAKE_PAGES_JSON", "")
    if raw_json:
        try:
            for pid, v in (json.loads(raw_json) or {}).items():
                tok = v if isinstance(v, str) else (v or {}).get("token") or (v or {}).get("page_token") or (v or {}).get("page_access_token")
                if tok:
                    pages[str(pid)] = {"token": tok, "name": "" if isinstance(v, str) else (v.get("name") or ""), "source": ".env (PANCAKE_PAGES_JSON)"}
        except ValueError:
            pass
    if env.get("PANCAKE_PAGE_ID") and env.get("PANCAKE_PAGE_ACCESS_TOKEN"):
        pages[env["PANCAKE_PAGE_ID"]] = {"token": env["PANCAKE_PAGE_ACCESS_TOKEN"], "name": env.get("SHOP_NAME", ""), "source": ".env"}
    data_dir = os.path.join(bot_dir, env.get("DATA_DIR") or "data")
    tokens_file = os.path.join(data_dir, "pages_tokens.json")
    if os.path.isfile(tokens_file):
        try:
            with open(tokens_file, encoding="utf-8") as f:
                for pid, v in (json.load(f) or {}).items():
                    tok = v if isinstance(v, str) else (v or {}).get("token")
                    if tok:
                        name = "" if isinstance(v, str) else (v.get("name") or "")
                        pages[str(pid)] = {"token": tok, "name": name or pages.get(str(pid), {}).get("name", ""), "source": "data/pages_tokens.json"}
        except (OSError, ValueError):
            pass

    prompt_path = None
    for p in [env.get("SYSTEM_PROMPT_FILE"), os.path.join(data_dir, "system.md"), os.path.join(bot_dir, "prompts", "system.md")]:
        if p and os.path.isfile(p if os.path.isabs(p) else os.path.join(bot_dir, p)):
            prompt_path = p if os.path.isabs(p) else os.path.join(bot_dir, p)
            break

    return {
        "dir": bot_dir, "pages": pages,
        "gemini_api_key": env.get("GEMINI_API_KEY", ""), "gemini_model": env.get("GEMINI_MODEL", ""),
        "pos_shop_id": env.get("POS_SHOP_ID", ""), "pos_api_key": env.get("POS_API_KEY", ""),
        "shop_name": env.get("SHOP_NAME", ""), "prompt_path": prompt_path,
        "found_env": os.path.isfile(os.path.join(bot_dir, ".env")), "found_tokens_file": os.path.isfile(tokens_file),
    }


def preview(bot_dir: str | None = None) -> dict[str, Any]:
    """Bản xem trước ĐÃ CHE token — an toàn để trả ra giao diện."""
    dirs = [bot_dir] if bot_dir else candidate_dirs()
    if not dirs:
        return {"found": False, "searched": [os.path.abspath(os.path.join(APP_DIR, "..", "chatbot"))],
                "hint": "Không thấy thư mục bot cũ. Nhập đường dẫn tới thư mục `chatbot` (nơi có file .env)."}
    d = dirs[0]
    if not os.path.isdir(d):
        return {"found": False, "searched": [d], "hint": "Đường dẫn không tồn tại."}
    cfg = read_old_bot(d)
    return {
        "found": bool(cfg["pages"] or cfg["gemini_api_key"]), "dir": cfg["dir"],
        "found_env": cfg["found_env"], "found_tokens_file": cfg["found_tokens_file"],
        "pages": [{"id": pid, "name": p["name"], "token": _mask(p["token"]), "source": p["source"]} for pid, p in cfg["pages"].items()],
        "gemini_api_key": _mask(cfg["gemini_api_key"]) if cfg["gemini_api_key"] else None,
        "gemini_model": cfg["gemini_model"] or None,
        "pos_shop_id": cfg["pos_shop_id"] or None, "pos_api_key": _mask(cfg["pos_api_key"]) if cfg["pos_api_key"] else None,
        "prompt_path": cfg["prompt_path"],
        "hint": None if cfg["found_env"] else "Thư mục có nhưng không thấy file .env — bot cũ chưa cấu hình ở máy này (có thể đang chạy trên VPS).",
    }


def prompt_as_profile(prompt_path: str, shop_name: str) -> str:
    """Kịch bản bot cũ → ô 'Thông tin shop'. Bỏ chỗ điền danh mục (app mới tự chèn danh mục POS)."""
    with open(prompt_path, encoding="utf-8") as f:
        text = f.read()
    text = text.replace("{{SHOP_NAME}}", shop_name or "shop")
    text = re.sub(r"^.*\{\{CATALOG\}\}.*$\n?", "", text, flags=re.M)
    return re.sub(r"\{\{[A-Z_]+\}\}", "", text).strip()


def apply(bot_dir: str | None = None, page_id: str | None = None, import_prompt: bool = True) -> dict[str, Any]:
    dirs = [bot_dir] if bot_dir else candidate_dirs()
    if not dirs or not os.path.isdir(dirs[0]):
        raise ValueError("Không thấy thư mục bot cũ")
    cfg = read_old_bot(dirs[0])
    vals: dict[str, Any] = {}
    imported: list[str] = []
    if cfg["pages"]:
        if not page_id:
            if len(cfg["pages"]) > 1:
                raise ValueError(f"Bot cũ có {len(cfg['pages'])} page — chọn một page để nhập")
            page_id = next(iter(cfg["pages"]))
        page = cfg["pages"].get(str(page_id))
        if not page:
            raise ValueError("Bot cũ không có page này")
        vals.update(pancake_page_id=str(page_id), pancake_page_access_token=page["token"])
        imported.append(f"Page {page_id}" + (f" ({page['name']})" if page["name"] else ""))
        if page["name"]:
            vals["shop_name"] = page["name"]
    if cfg["gemini_api_key"]:
        vals["gemini_api_key"] = cfg["gemini_api_key"]
        imported.append("Gemini API key")
    if cfg["gemini_model"]:
        vals["gemini_model"] = cfg["gemini_model"]
    if cfg["pos_shop_id"] and cfg["pos_api_key"]:
        vals.update(pancake_shop_id=cfg["pos_shop_id"], pancake_pos_api_key=cfg["pos_api_key"])
        imported.append("Shop ID + POS API key")
    if not vals.get("shop_name") and cfg["shop_name"]:
        vals["shop_name"] = cfg["shop_name"]
    if import_prompt and cfg["prompt_path"]:
        vals["shop_profile"] = prompt_as_profile(cfg["prompt_path"], vals.get("shop_name") or cfg["shop_name"])
        imported.append("kịch bản tư vấn (" + os.path.basename(cfg["prompt_path"]) + ")")
    if not vals:
        raise ValueError("Không đọc được khoá nào từ bot cũ")
    db.set_settings(vals)
    return {"ok": True, "imported": imported, "dir": cfg["dir"]}


def auto_import_on_startup() -> str | None:
    """Lần đầu chạy (chưa có Page ID) mà thấy bot cũ có ĐÚNG MỘT page ⇒ tự nhập. Không bao giờ ghi đè cấu hình đã có."""
    if db.get_setting("pancake_page_id") or not candidate_dirs():
        return None
    try:
        cfg = read_old_bot(candidate_dirs()[0])
        if len(cfg["pages"]) != 1:
            return None
        return ", ".join(apply(cfg["dir"], None, import_prompt=True)["imported"])
    except (OSError, ValueError):
        return None
