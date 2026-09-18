from urllib.parse import urlsplit

from flask import current_app, request, url_for


def public_path(path: str) -> str:
    value = path if path.startswith("/") else f"/{path}"
    configured_prefix = current_app.config.get("BASE_URL", "")
    request_prefix = (request.script_root or "").rstrip("/")
    prefix = request_prefix or configured_prefix
    if prefix and (value == prefix or value.startswith(f"{prefix}/")):
        return value
    return f"{prefix}{value}" if prefix else value


def auth_url(endpoint: str, **values) -> str:
    return public_path(url_for(endpoint, **values))


def external_auth_url(endpoint: str, **values) -> str:
    internal_path = url_for(endpoint, **values)
    configured = (current_app.config.get("PUBLIC_BASE_URL") or "").rstrip("/")
    if configured:
        return f"{configured}{internal_path}"
    return f"{request.url_root.rstrip('/')}{public_path(internal_path)}"


def safe_next_path(value: str) -> str:
    candidate = (value or "").strip()
    parts = urlsplit(candidate)
    if parts.scheme or parts.netloc or not candidate.startswith("/") or candidate.startswith("//"):
        return "/"
    prefix = current_app.config.get("BASE_URL", "")
    if prefix and (candidate == prefix or candidate.startswith(f"{prefix}/")):
        candidate = candidate[len(prefix):] or "/"
    return candidate
