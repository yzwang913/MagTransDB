import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from app import create_app
from auth.db import get_user_by_email


@pytest.fixture()
def app(tmp_path: Path, monkeypatch):
    data_root = tmp_path / "data"
    for name in ("Lattice", "MR", "Band", "fermi_surface", "download"):
        (data_root / name).mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("DATA_ROOT", str(data_root))
    monkeypatch.setenv("LATTICE_DIR", str(data_root / "Lattice"))
    monkeypatch.setenv("MR_DIR", str(data_root / "MR"))
    monkeypatch.setenv("BAND_DIR", str(data_root / "Band"))
    monkeypatch.setenv("FERMI_ROOT_DIR", str(data_root / "fermi_surface"))
    monkeypatch.setenv("DOWNLOAD_DIR", str(data_root / "download"))
    monkeypatch.setenv("BASE_URL", "")

    database_path = tmp_path / "state" / "auth.sqlite3"
    application = create_app(
        {
            "TESTING": True,
            "AUTH_ENABLED": True,
            "AUTH_DATABASE_PATH": str(database_path),
            "SECRET_KEY": "test-secret-key-that-is-not-used-in-production",
            "PUBLIC_BASE_URL": "https://cmpdc.iphy.ac.cn/mtdb",
            "MAIL_SUPPRESS_SEND": True,
            "MAIL_DEFAULT_SENDER": "test@example.org",
            "SESSION_COOKIE_SECURE": False,
            "WTF_CSRF_ENABLED": False,
        }
    )
    application.config["TEST_DATABASE_PATH"] = str(database_path)
    return application


@pytest.fixture()
def client(app):
    return app.test_client()


def register(client, email="ada@example.org", password="correct-horse-42"):
    return client.post(
        "/auth/register",
        data={
            "full_name": "Ada Lovelace",
            "institution": "Analytical Engine Institute",
            "position": "Researcher",
            "email": email,
            "password": password,
            "password_confirm": password,
        },
        follow_redirects=True,
    )


def internal_email_path(app, message_index=-1):
    message = app.extensions["mail_outbox"][message_index]
    url = re.search(r"https?://\S+", message["body"]).group(0)
    path = urlsplit(url).path
    return path.removeprefix("/mtdb")


def verify_registered_user(app, client):
    response = client.get(internal_email_path(app), follow_redirects=True)
    assert response.status_code == 200
    assert b"Email verified" in response.data


def test_protected_pages_and_api_require_login(client):
    response = client.get("/")
    assert response.status_code == 302
    assert response.headers["Location"].startswith("/auth/login")

    response = client.get("/api/search?q=Cu")
    assert response.status_code == 401
    assert response.get_json()["error"] == "authentication_required"

    assert client.get("/api/health").status_code == 200
    assert client.get("/static/base-url.js").status_code == 200

    response = client.get("/", headers={"X-Forwarded-Prefix": "/mtdb"})
    assert response.headers["Location"].startswith("/mtdb/auth/login")
    response = client.get("/auth/login", headers={"X-Forwarded-Prefix": "/mtdb"})
    assert b'href="/mtdb/auth/register"' in response.data


def test_registration_verification_login_and_logout(app, client):
    response = register(client)
    assert response.status_code == 200
    assert b"Registration successful" in response.data
    assert len(app.extensions["mail_outbox"]) == 1

    user = get_user_by_email(app.config["TEST_DATABASE_PATH"], "ADA@example.org")
    assert user is not None
    assert user.full_name == "Ada Lovelace"
    assert user.institution == "Analytical Engine Institute"
    assert user.position == "Researcher"
    assert user.password_hash != "correct-horse-42"
    assert not user.is_verified

    response = client.post(
        "/auth/login",
        data={"email": "ada@example.org", "password": "correct-horse-42"},
        follow_redirects=True,
    )
    assert b"Please verify your email address" in response.data

    verify_registered_user(app, client)
    response = client.post(
        "/auth/login",
        data={
            "email": "ada@example.org",
            "password": "correct-horse-42",
            "next_url": "/",
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Ada Lovelace" in response.data
    assert b"Analytical Engine Institute" in response.data

    response = client.post("/auth/logout", follow_redirects=True)
    assert response.status_code == 200
    assert b"You have signed out" in response.data


def test_duplicate_email_is_case_insensitive(app, client):
    register(client, email="Ada@Example.org")
    response = register(client, email="ada@example.org")
    assert b"already exists" in response.data
    assert len(app.extensions["mail_outbox"]) == 1


def test_password_reset_is_single_use(app, client):
    register(client)
    verify_registered_user(app, client)

    response = client.post(
        "/auth/forgot-password",
        data={"email": "ada@example.org"},
        follow_redirects=True,
    )
    assert b"password reset email has been sent" in response.data
    reset_path = internal_email_path(app)

    response = client.post(
        reset_path,
        data={
            "password": "a-new-secure-password",
            "password_confirm": "a-new-secure-password",
        },
        follow_redirects=True,
    )
    assert b"Password updated" in response.data

    response = client.get(reset_path, follow_redirects=True)
    assert b"invalid or has expired" in response.data

    response = client.post(
        "/auth/login",
        data={"email": "ada@example.org", "password": "a-new-secure-password"},
        follow_redirects=True,
    )
    assert b"Ada Lovelace" in response.data


def test_external_next_url_is_rejected(app, client):
    register(client)
    verify_registered_user(app, client)
    response = client.post(
        "/auth/login",
        data={
            "email": "ada@example.org",
            "password": "correct-horse-42",
            "next_url": "https://attacker.example/steal",
        },
    )
    assert response.status_code == 302
    assert response.headers["Location"] == "/"


def test_login_is_rate_limited(client):
    for _ in range(10):
        response = client.post(
            "/auth/login",
            data={"email": "missing@example.org", "password": "incorrect-password"},
        )
        assert response.status_code == 200

    response = client.post(
        "/auth/login",
        data={"email": "missing@example.org", "password": "incorrect-password"},
    )
    assert response.status_code == 429
    assert b"Too many requests" in response.data


def test_csrf_rejects_missing_token(tmp_path: Path, monkeypatch):
    data_root = tmp_path / "data"
    (data_root / "Lattice").mkdir(parents=True)
    monkeypatch.setenv("LATTICE_DIR", str(data_root / "Lattice"))
    monkeypatch.setenv("BASE_URL", "/mtdb")
    application = create_app(
        {
            "TESTING": True,
            "AUTH_ENABLED": True,
            "AUTH_DATABASE_PATH": str(tmp_path / "auth.sqlite3"),
            "SECRET_KEY": "csrf-test-secret",
            "PUBLIC_BASE_URL": "https://cmpdc.iphy.ac.cn/mtdb",
            "MAIL_SUPPRESS_SEND": True,
            "MAIL_DEFAULT_SENDER": "test@example.org",
            "SESSION_COOKIE_SECURE": False,
            "WTF_CSRF_ENABLED": True,
        }
    )
    csrf_client = application.test_client()
    redirect_response = csrf_client.get("/")
    assert redirect_response.status_code == 302
    assert redirect_response.headers["Location"].startswith("/mtdb/auth/login")

    response = csrf_client.post(
        "/auth/login",
        data={"email": "nobody@example.org", "password": "not-a-password"},
    )
    assert response.status_code == 400
