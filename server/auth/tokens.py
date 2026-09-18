import hashlib
from typing import Any

from flask import current_app
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .models import User


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"])


def _password_version(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:24]


def generate_email_token(user: User, purpose: str) -> str:
    payload: dict[str, Any] = {
        "user_id": user.id,
        "email": user.email,
        "purpose": purpose,
    }
    if purpose == "reset-password":
        payload["password_version"] = _password_version(user.password_hash)
    return _serializer().dumps(payload, salt=f"magtransdb-{purpose}")


def load_email_token(token: str, purpose: str, max_age: int) -> dict[str, Any] | None:
    try:
        payload = _serializer().loads(
            token,
            salt=f"magtransdb-{purpose}",
            max_age=max_age,
        )
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(payload, dict) or payload.get("purpose") != purpose:
        return None
    return payload


def reset_token_matches_user(payload: dict[str, Any], user: User) -> bool:
    return (
        payload.get("email") == user.email
        and payload.get("password_version") == _password_version(user.password_hash)
    )
