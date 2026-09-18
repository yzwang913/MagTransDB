import smtplib
import ssl
from email.message import EmailMessage

from flask import current_app


def send_email(subject: str, recipient: str, body: str) -> None:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = current_app.config["MAIL_DEFAULT_SENDER"]
    message["To"] = recipient
    message.set_content(body)

    if current_app.config["MAIL_SUPPRESS_SEND"]:
        outbox = current_app.extensions.setdefault("mail_outbox", [])
        outbox.append({"subject": subject, "recipient": recipient, "body": body})
        return

    host = current_app.config["MAIL_SERVER"]
    port = current_app.config["MAIL_PORT"]
    username = current_app.config.get("MAIL_USERNAME")
    password = current_app.config.get("MAIL_PASSWORD")
    timeout = current_app.config["MAIL_TIMEOUT"]

    if current_app.config["MAIL_USE_SSL"]:
        client = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ssl.create_default_context())
    else:
        client = smtplib.SMTP(host, port, timeout=timeout)

    with client:
        if current_app.config["MAIL_USE_TLS"] and not current_app.config["MAIL_USE_SSL"]:
            client.starttls(context=ssl.create_default_context())
        if username:
            client.login(username, password or "")
        client.send_message(message)


def verification_body(full_name: str, verification_url: str) -> str:
    return (
        f"Hello {full_name},\n\n"
        "Please verify your email address to activate your MagTransDB account:\n\n"
        f"{verification_url}\n\n"
        "This link expires in 24 hours. If you did not create this account, you can ignore this email.\n"
    )


def reset_body(full_name: str, reset_url: str) -> str:
    return (
        f"Hello {full_name},\n\n"
        "Use the following link to reset your MagTransDB password:\n\n"
        f"{reset_url}\n\n"
        "This link expires in 1 hour. If you did not request a reset, you can ignore this email.\n"
    )
