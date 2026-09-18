from dataclasses import dataclass

from flask_login import UserMixin


@dataclass
class User(UserMixin):
    id: int
    full_name: str
    institution: str
    position: str
    email: str
    password_hash: str
    email_verified_at: str | None
    active: bool
    created_at: str
    last_login_at: str | None

    @property
    def is_active(self) -> bool:
        return self.active

    @property
    def is_verified(self) -> bool:
        return bool(self.email_verified_at)

    def get_id(self) -> str:
        return str(self.id)
