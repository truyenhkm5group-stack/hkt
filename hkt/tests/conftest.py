import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db  # noqa: E402


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.sqlite3")
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db(path)
    return path


@pytest.fixture()
def client(fresh_db):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


SAMPLE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sample_data", "mb_sao_ke_mau.csv")
