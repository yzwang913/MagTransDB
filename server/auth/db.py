import hashlib
import hmac
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from .models import User

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    institution TEXT NOT NULL,
    position TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    email_verified_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase
    ON users(email COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS auth_rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    key_digest TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_rate_events_lookup
    ON auth_rate_events(event_type, key_digest, created_at_epoch);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_email(email: str) -> str:
    return (email or "").strip().casefold()


def connect(database_path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_database(database_path: str) -> None:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(str(path)) as connection:
        # The production database may live on Lustre, where WAL is unsupported.
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("PRAGMA synchronous = FULL")
        connection.executescript(SCHEMA)


def row_to_user(row: sqlite3.Row | None) -> User | None:
    if row is None:
        return None
    return User(
        id=int(row["id"]),
        full_name=str(row["full_name"]),
        institution=str(row["institution"]),
        position=str(row["position"]),
        email=str(row["email"]),
        password_hash=str(row["password_hash"]),
        email_verified_at=row["email_verified_at"],
        active=bool(row["is_active"]),
        created_at=str(row["created_at"]),
        last_login_at=row["last_login_at"],
    )


def get_user_by_id(database_path: str, user_id: int) -> User | None:
    with connect(database_path) as connection:
        row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return row_to_user(row)


def get_user_by_email(database_path: str, email: str) -> User | None:
    with connect(database_path) as connection:
        row = connection.execute(
            "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
            (normalize_email(email),),
        ).fetchone()
    return row_to_user(row)


def create_user(
    database_path: str,
    *,
    full_name: str,
    institution: str,
    position: str,
    email: str,
    password_hash: str,
) -> User:
    now = utc_now()
    with connect(database_path) as connection:
        cursor = connection.execute(
            """
            INSERT INTO users (
                full_name, institution, position, email, password_hash,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                full_name.strip(),
                institution.strip(),
                position.strip(),
                normalize_email(email),
                password_hash,
                now,
                now,
            ),
        )
        user_id = int(cursor.lastrowid)
    user = get_user_by_id(database_path, user_id)
    if user is None:
        raise RuntimeError("Failed to load the newly created user")
    return user


def mark_email_verified(database_path: str, user_id: int) -> None:
    now = utc_now()
    with connect(database_path) as connection:
        connection.execute(
            """
            UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
            WHERE id = ?
            """,
            (now, now, user_id),
        )


def update_password(database_path: str, user_id: int, password_hash: str) -> None:
    now = utc_now()
    with connect(database_path) as connection:
        connection.execute(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, now, user_id),
        )


def update_last_login(database_path: str, user_id: int) -> None:
    now = utc_now()
    with connect(database_path) as connection:
        connection.execute(
            "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
            (now, now, user_id),
        )


def consume_rate_limit(
    database_path: str,
    *,
    event_type: str,
    key: str,
    secret_key: str,
    limit: int,
    window_seconds: int,
) -> bool:
    digest = hmac.new(
        secret_key.encode("utf-8"),
        key.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    now = int(time.time())
    cutoff = now - window_seconds
    with connect(database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "DELETE FROM auth_rate_events WHERE created_at_epoch < ?",
            (now - 86400,),
        )
        count = connection.execute(
            """
            SELECT COUNT(*) FROM auth_rate_events
            WHERE event_type = ? AND key_digest = ? AND created_at_epoch >= ?
            """,
            (event_type, digest, cutoff),
        ).fetchone()[0]
        if count >= limit:
            return False
        connection.execute(
            "INSERT INTO auth_rate_events(event_type, key_digest, created_at_epoch) VALUES (?, ?, ?)",
            (event_type, digest, now),
        )
    return True
