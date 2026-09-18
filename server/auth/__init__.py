import os
from datetime import timedelta

from flask import Flask, jsonify, redirect, request
from flask_login import LoginManager, current_user
from flask_wtf.csrf import CSRFProtect
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import generate_password_hash

from .db import get_user_by_id, init_database
from .forms import LogoutForm
from .routes import blueprint
from .urls import auth_url, public_path

login_manager = LoginManager()
csrf = CSRFProtect()


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def init_auth(app: Flask, config_overrides=None) -> None:
    base_url = app.config.get("BASE_URL", "")
    app.config.from_mapping(
        AUTH_ENABLED=_bool_env("AUTH_ENABLED", True),
        AUTH_DATABASE_PATH=os.environ.get("AUTH_DATABASE_PATH", "/state/auth.sqlite3"),
        SECRET_KEY=os.environ.get("SECRET_KEY"),
        PUBLIC_BASE_URL=os.environ.get("PUBLIC_BASE_URL", ""),
        EMAIL_VERIFICATION_MAX_AGE=int(os.environ.get("EMAIL_VERIFICATION_MAX_AGE", "86400")),
        PASSWORD_RESET_MAX_AGE=int(os.environ.get("PASSWORD_RESET_MAX_AGE", "3600")),
        MAIL_SERVER=os.environ.get("MAIL_SERVER", ""),
        MAIL_PORT=int(os.environ.get("MAIL_PORT", "587")),
        MAIL_USE_TLS=_bool_env("MAIL_USE_TLS", True),
        MAIL_USE_SSL=_bool_env("MAIL_USE_SSL", False),
        MAIL_USERNAME=os.environ.get("MAIL_USERNAME", ""),
        MAIL_PASSWORD=os.environ.get("MAIL_PASSWORD", ""),
        MAIL_DEFAULT_SENDER=os.environ.get("MAIL_DEFAULT_SENDER", ""),
        MAIL_TIMEOUT=int(os.environ.get("MAIL_TIMEOUT", "10")),
        MAIL_SUPPRESS_SEND=_bool_env("MAIL_SUPPRESS_SEND", False),
        SESSION_COOKIE_SECURE=_bool_env("SESSION_COOKIE_SECURE", True),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_PATH=base_url or "/",
        REMEMBER_COOKIE_SECURE=_bool_env("SESSION_COOKIE_SECURE", True),
        REMEMBER_COOKIE_HTTPONLY=True,
        REMEMBER_COOKIE_SAMESITE="Lax",
        REMEMBER_COOKIE_PATH=base_url or "/",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        REMEMBER_COOKIE_DURATION=timedelta(days=14),
    )
    if config_overrides:
        app.config.update(config_overrides)

    if not app.config["AUTH_ENABLED"]:
        return
    if not app.config.get("SECRET_KEY"):
        raise RuntimeError("SECRET_KEY is required when AUTH_ENABLED=true")
    if not app.config["MAIL_SUPPRESS_SEND"]:
        required_mail = ("MAIL_SERVER", "MAIL_DEFAULT_SENDER")
        missing = [name for name in required_mail if not app.config.get(name)]
        if missing:
            raise RuntimeError(f"Missing required mail configuration: {', '.join(missing)}")
    if app.config["MAIL_USE_TLS"] and app.config["MAIL_USE_SSL"]:
        raise RuntimeError("MAIL_USE_TLS and MAIL_USE_SSL cannot both be true")

    init_database(app.config["AUTH_DATABASE_PATH"])
    app.config["DUMMY_PASSWORD_HASH"] = generate_password_hash("not-a-real-user-password")
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    login_manager.session_protection = "strong"
    csrf.init_app(app)
    app.register_blueprint(blueprint, url_prefix="/auth")

    @login_manager.user_loader
    def load_user(user_id: str):
        try:
            user = get_user_by_id(app.config["AUTH_DATABASE_PATH"], int(user_id))
        except (TypeError, ValueError):
            return None
        return user if user and user.is_active else None

    @login_manager.unauthorized_handler
    def unauthorized():
        login_url = auth_url("auth.login", next=request.full_path.rstrip("?"))
        if request.path.startswith("/api/"):
            return jsonify({"error": "authentication_required", "login_url": login_url}), 401
        return redirect(login_url)

    @app.before_request
    def require_authenticated_user():
        endpoint = request.endpoint or ""
        if request.method == "OPTIONS":
            return None
        if endpoint == "static" or endpoint == "health" or endpoint.startswith("auth."):
            return None
        if current_user.is_authenticated:
            return None
        return login_manager.unauthorized()

    @app.context_processor
    def auth_template_context():
        return {
            "auth_url": auth_url,
            "public_path": public_path,
            "logout_form": LogoutForm(),
        }
