import sqlite3

from flask import Blueprint, current_app, flash, redirect, render_template, request
from flask_login import current_user, login_user, logout_user
from werkzeug.security import check_password_hash, generate_password_hash

from .db import (
    consume_rate_limit,
    create_user,
    get_user_by_email,
    get_user_by_id,
    mark_email_verified,
    normalize_email,
    update_last_login,
    update_password,
)
from .forms import EmailForm, LoginForm, LogoutForm, RegistrationForm, ResetPasswordForm
from .mailer import reset_body, send_email, verification_body
from .tokens import generate_email_token, load_email_token, reset_token_matches_user
from .urls import auth_url, external_auth_url, public_path, safe_next_path

blueprint = Blueprint("auth", __name__, template_folder="../templates")


def _database_path() -> str:
    return current_app.config["AUTH_DATABASE_PATH"]


def _within_rate_limit(event_type: str, key: str, limit: int, window_seconds: int) -> bool:
    remote_address = request.remote_addr or "unknown"
    allowed = consume_rate_limit(
        _database_path(),
        event_type=event_type,
        key=f"{remote_address}|{key}",
        secret_key=current_app.config["SECRET_KEY"],
        limit=limit,
        window_seconds=window_seconds,
    )
    if not allowed:
        flash("Too many requests. Please wait and try again.", "error")
    return allowed


def _send_verification(user) -> None:
    token = generate_email_token(user, "verify-email")
    verification_url = external_auth_url("auth.verify_email", token=token)
    send_email(
        "Verify your MagTransDB account",
        user.email,
        verification_body(user.full_name, verification_url),
    )


@blueprint.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(public_path("/"))

    form = LoginForm()
    if request.method == "GET":
        form.next_url.data = request.args.get("next", "")

    if form.validate_on_submit():
        if not _within_rate_limit("login", normalize_email(form.email.data), 10, 900):
            return render_template("auth/login.html", form=form), 429
        user = get_user_by_email(_database_path(), form.email.data)
        password_hash = user.password_hash if user else current_app.config["DUMMY_PASSWORD_HASH"]
        valid_password = check_password_hash(password_hash, form.password.data)
        if not valid_password or user is None or not user.is_active:
            flash("Invalid email or password.", "error")
        elif not user.is_verified:
            flash("Please verify your email address before signing in.", "warning")
        else:
            login_user(user, remember=form.remember.data, fresh=True)
            update_last_login(_database_path(), user.id)
            return redirect(public_path(safe_next_path(form.next_url.data or request.args.get("next", ""))))

    return render_template("auth/login.html", form=form)


@blueprint.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(public_path("/"))

    form = RegistrationForm()
    if form.validate_on_submit():
        if not _within_rate_limit("register", "registration", 5, 3600):
            return render_template("auth/register.html", form=form), 429
        email = normalize_email(form.email.data)
        existing = get_user_by_email(_database_path(), email)
        if existing:
            flash("An account with this email address already exists.", "error")
        else:
            try:
                user = create_user(
                    _database_path(),
                    full_name=form.full_name.data,
                    institution=form.institution.data,
                    position=form.position.data,
                    email=email,
                    password_hash=generate_password_hash(form.password.data),
                )
            except sqlite3.IntegrityError:
                flash("An account with this email address already exists.", "error")
            else:
                try:
                    _send_verification(user)
                    flash("Registration successful. Check your email to activate your account.", "success")
                except Exception:
                    current_app.logger.exception("Failed to send verification email")
                    flash(
                        "Your account was created, but the verification email could not be sent. "
                        "Use the resend verification page or contact the site administrator.",
                        "warning",
                    )
                return redirect(auth_url("auth.login"))

    return render_template("auth/register.html", form=form)


@blueprint.route("/verify/<token>")
def verify_email(token: str):
    payload = load_email_token(
        token,
        "verify-email",
        current_app.config["EMAIL_VERIFICATION_MAX_AGE"],
    )
    try:
        user_id = int(payload.get("user_id")) if payload else 0
    except (TypeError, ValueError):
        user_id = 0
    user = get_user_by_id(_database_path(), user_id) if user_id else None
    if not user or payload.get("email") != user.email:
        flash("This verification link is invalid or has expired.", "error")
        return redirect(auth_url("auth.resend_verification"))

    mark_email_verified(_database_path(), user.id)
    flash("Email verified. You can now sign in.", "success")
    return redirect(auth_url("auth.login"))


@blueprint.route("/resend-verification", methods=["GET", "POST"])
def resend_verification():
    form = EmailForm()
    if form.validate_on_submit():
        if not _within_rate_limit("resend-verification", normalize_email(form.email.data), 5, 3600):
            return render_template(
                "auth/email_form.html",
                form=form,
                heading="Resend verification email",
                description="Enter the email address used during registration.",
            ), 429
        user = get_user_by_email(_database_path(), form.email.data)
        if user and user.is_active and not user.is_verified:
            try:
                _send_verification(user)
            except Exception:
                current_app.logger.exception("Failed to resend verification email")
        flash("If the account exists and still needs verification, a new email has been sent.", "success")
        return redirect(auth_url("auth.login"))
    return render_template(
        "auth/email_form.html",
        form=form,
        heading="Resend verification email",
        description="Enter the email address used during registration.",
    )


@blueprint.route("/forgot-password", methods=["GET", "POST"])
def forgot_password():
    form = EmailForm()
    if form.validate_on_submit():
        if not _within_rate_limit("forgot-password", normalize_email(form.email.data), 5, 3600):
            return render_template(
                "auth/email_form.html",
                form=form,
                heading="Reset your password",
                description="Enter your verified email address.",
            ), 429
        user = get_user_by_email(_database_path(), form.email.data)
        if user and user.is_active and user.is_verified:
            token = generate_email_token(user, "reset-password")
            reset_url = external_auth_url("auth.reset_password", token=token)
            try:
                send_email(
                    "Reset your MagTransDB password",
                    user.email,
                    reset_body(user.full_name, reset_url),
                )
            except Exception:
                current_app.logger.exception("Failed to send password reset email")
        flash("If the account exists, a password reset email has been sent.", "success")
        return redirect(auth_url("auth.login"))
    return render_template(
        "auth/email_form.html",
        form=form,
        heading="Reset your password",
        description="Enter your verified email address.",
    )


@blueprint.route("/reset-password/<token>", methods=["GET", "POST"])
def reset_password(token: str):
    payload = load_email_token(
        token,
        "reset-password",
        current_app.config["PASSWORD_RESET_MAX_AGE"],
    )
    try:
        user_id = int(payload.get("user_id")) if payload else 0
    except (TypeError, ValueError):
        user_id = 0
    user = get_user_by_id(_database_path(), user_id) if user_id else None
    if not user or not user.is_active or not user.is_verified or not reset_token_matches_user(payload, user):
        flash("This password reset link is invalid or has expired.", "error")
        return redirect(auth_url("auth.forgot_password"))

    form = ResetPasswordForm()
    if form.validate_on_submit():
        update_password(_database_path(), user.id, generate_password_hash(form.password.data))
        logout_user()
        flash("Password updated. You can now sign in.", "success")
        return redirect(auth_url("auth.login"))
    return render_template("auth/reset_password.html", form=form)


@blueprint.route("/logout", methods=["POST"])
def logout():
    form = LogoutForm()
    if form.validate_on_submit():
        logout_user()
        flash("You have signed out.", "success")
    return redirect(auth_url("auth.login"))
