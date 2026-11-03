"""Local email/password accounts and signed access tokens for QueueSense."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import Header, HTTPException, status

from database import (
    create_user, get_user_by_email, get_user_by_google_id, set_user_google_id,
    update_user_password, update_user_role,
)

PBKDF2_ITERATIONS = 600_000
VALID_ROLES = {"viewer", "operator", "admin"}


def _load_local_env() -> None:
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


_load_local_env()


def _required_env(name: str, minimum_length: int) -> str:
    value = os.getenv(name, "")
    if len(value) < minimum_length:
        raise RuntimeError(f"{name} must be set and at least {minimum_length} characters long.")
    return value


def normalize_email(email: str) -> str:
    email = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    return email


def validate_password(password: str) -> str | None:
    if len(password) < 12:
        return "Password must be at least 12 characters long."
    if not any(char.isupper() for char in password) or not any(char.islower() for char in password):
        return "Password must include uppercase and lowercase letters."
    if not any(char.isdigit() for char in password) or not any(not char.isalnum() for char in password):
        return "Password must include a number and a special character."
    return None


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        _, rounds, salt, expected = encoded.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(actual.hex(), expected)
    except (TypeError, ValueError):
        return False


def initialize_admin() -> None:
    """Validate Google Sign-In configuration; the owner is promoted on first login."""
    _required_env("APP_AUTH_SECRET", 32)
    normalize_email(_required_env("APP_OWNER_EMAIL", 5))
    _required_env("GOOGLE_CLIENT_ID", 20)


def _sign(payload: bytes) -> str:
    return hmac.new(_required_env("APP_AUTH_SECRET", 32).encode(), payload, hashlib.sha256).hexdigest()


def create_access_token(user: dict) -> str:
    payload = json.dumps({"sub": user["id"], "email": user["email"], "role": user["role"], "exp": int(time.time()) + 8 * 60 * 60}, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    return f"{encoded}.{_sign(payload)}"


def require_user(authorization: str | None = Header(default=None)) -> dict:
    try:
        scheme, token = (authorization or "").split(" ", 1)
        encoded, signature = token.split(".", 1)
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        claims = json.loads(payload)
        valid = scheme.lower() == "bearer" and hmac.compare_digest(signature, _sign(payload))
        if not valid or claims.get("role") not in VALID_ROLES or int(claims["exp"]) <= time.time():
            raise ValueError
        return claims
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in is required.")


def require_admin(authorization: str | None = Header(default=None)) -> dict:
    claims = require_user(authorization)
    if claims["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator access is required.")
    return claims


def require_operator(authorization: str | None = Header(default=None)) -> dict:
    """Allow operational actions without granting account administration."""
    claims = require_user(authorization)
    if claims["role"] not in {"operator", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operator access is required.")
    return claims


def authenticate(email: str, password: str):
    user = get_user_by_email(normalize_email(email))
    if user and user["is_active"] and verify_password(password, user["password_hash"]):
        return user
    return None


def authenticate_google(credential: str):
    """Verify a Google ID token server-side and provision a least-privilege account."""
    try:
        from google.auth.transport import requests
        from google.oauth2 import id_token
        claims = id_token.verify_oauth2_token(
            credential,
            requests.Request(),
            _required_env("GOOGLE_CLIENT_ID", 20),
        )
        if not claims.get("email_verified"):
            raise ValueError("Google email is not verified.")
        email = normalize_email(str(claims["email"]))
        google_id = str(claims["sub"])
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Google sign-in could not be verified.") from exc

    owner_email = normalize_email(_required_env("APP_OWNER_EMAIL", 5))
    user = get_user_by_google_id(google_id) or get_user_by_email(email)
    if user is None:
        user = create_user(email, "", "admin" if email == owner_email else "viewer", google_id)
    else:
        if not user.get("google_id"):
            set_user_google_id(user["id"], google_id)
        if email == owner_email and user["role"] != "admin":
            update_user_role(user["id"], "admin")
        user = get_user_by_google_id(google_id) or get_user_by_email(email)
    if not user or not user["is_active"]:
        raise HTTPException(status_code=403, detail="This account is disabled.")
    return user


def change_password(user_id: int, current_password: str, new_password: str) -> None:
    from database import get_user_by_id
    user = get_user_by_id(user_id)
    if user is None or not verify_password(current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    problem = validate_password(new_password)
    if problem:
        raise HTTPException(status_code=422, detail=problem)
    update_user_password(user_id, hash_password(new_password))
