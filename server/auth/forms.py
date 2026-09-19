from flask_wtf import FlaskForm
from wtforms import (
    BooleanField,
    HiddenField,
    PasswordField,
    SelectField,
    StringField,
    SubmitField,
)
from wtforms.validators import DataRequired, Email, EqualTo, Length

POSITION_CHOICES = [
    ("Professor", "Professor"),
    ("Associate Professor", "Associate Professor"),
    ("Assistant Professor", "Assistant Professor"),
    ("Researcher", "Researcher"),
    ("Postdoctoral Researcher", "Postdoctoral Researcher"),
    ("Student", "Student"),
    ("Other", "Other"),
]


def _strip(value):
    return value.strip() if isinstance(value, str) else value


class LoginForm(FlaskForm):
    email = StringField("Email", filters=[_strip], validators=[DataRequired(), Email(), Length(max=254)])
    password = PasswordField("Password", validators=[DataRequired(), Length(max=128)])
    remember = BooleanField("Keep me signed in")
    next_url = HiddenField()
    submit = SubmitField("Sign in")


class RegistrationForm(FlaskForm):
    full_name = StringField(
        "Full name", filters=[_strip], validators=[DataRequired(), Length(min=2, max=120)]
    )
    institution = StringField(
        "Institution", filters=[_strip], validators=[DataRequired(), Length(min=2, max=200)]
    )
    position = SelectField("Position", choices=POSITION_CHOICES, validators=[DataRequired()])
    email = StringField("Email", filters=[_strip], validators=[DataRequired(), Email(), Length(max=254)])
    password = PasswordField("Password", validators=[DataRequired(), Length(min=10, max=128)])
    password_confirm = PasswordField(
        "Confirm password",
        validators=[DataRequired(), EqualTo("password", message="Passwords must match.")],
    )
    submit = SubmitField("Create account")


class EmailForm(FlaskForm):
    email = StringField("Email", filters=[_strip], validators=[DataRequired(), Email(), Length(max=254)])
    submit = SubmitField("Send email")


class ResetPasswordForm(FlaskForm):
    password = PasswordField("New password", validators=[DataRequired(), Length(min=10, max=128)])
    password_confirm = PasswordField(
        "Confirm new password",
        validators=[DataRequired(), EqualTo("password", message="Passwords must match.")],
    )
    submit = SubmitField("Reset password")


class LogoutForm(FlaskForm):
    submit = SubmitField("Sign out")
