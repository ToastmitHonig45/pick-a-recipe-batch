"""Railway entry point with secure first-run local admin setup."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "ui"))

import app as original
from flask import flash, redirect, render_template_string, request, session, url_for

flask_app = original.app
CREDENTIAL_FILE = os.environ.get("LOCAL_ADMIN_FILE", "/app/data/local_admin.json")

LOGIN_PAGE = """
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login - Pick-a-Recipe</title><style>
body{font-family:system-ui,sans-serif;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:100vh;margin:0}
main{width:min(92vw,420px);background:#1f2937;padding:2rem;border-radius:16px;box-shadow:0 20px 50px #0008}
h1{margin-top:0}label{display:block;margin-top:1rem}input{box-sizing:border-box;width:100%;padding:.8rem;margin-top:.35rem;border:1px solid #4b5563;border-radius:8px;background:#111827;color:white}
button,a{box-sizing:border-box;display:block;width:100%;padding:.85rem;margin-top:1.25rem;border:0;border-radius:8px;text-align:center;background:#7c3aed;color:white;font-weight:700;text-decoration:none;cursor:pointer}
.error{background:#7f1d1d;padding:.75rem;border-radius:8px}.note{color:#c4b5fd}
</style></head><body><main><h1>Pick-a-Recipe</h1><p>Extract recipes from social media videos</p>
{% with messages = get_flashed_messages(with_categories=true) %}{% for category, message in messages %}<p class="error">{{ message }}</p>{% endfor %}{% endwith %}
{% if setup %}<p class="note">First start: create your private administrator login.</p>{% endif %}
<form method="post" action="{{ url_for('local_login') }}">
<label>Username<input name="username" autocomplete="username" value="{{ 'admin' if setup else '' }}" required></label>
<label>Password<input type="password" name="password" autocomplete="{{ 'new-password' if setup else 'current-password' }}" minlength="12" required></label>
<button type="submit">{{ 'Create administrator' if setup else 'Sign in' }}</button></form>
{% if sso_enabled %}<a href="{{ url_for('auth_login') }}">Sign in with Authentik</a>{% endif %}
</main></body></html>
"""

def _derive(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310000)

def _load_credentials():
    env_user = os.environ.get("LOCAL_ADMIN_USERNAME", "").strip()
    env_password = os.environ.get("LOCAL_ADMIN_PASSWORD", "")
    if env_user and env_password:
        return {"type": "env", "username": env_user, "password": env_password}
    try:
        with open(CREDENTIAL_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None

def _save_credentials(username, password):
    os.makedirs(os.path.dirname(CREDENTIAL_FILE), exist_ok=True)
    salt = secrets.token_bytes(16)
    payload = {
        "type": "hash",
        "username": username,
        "salt": base64.b64encode(salt).decode("ascii"),
        "digest": base64.b64encode(_derive(password, salt)).decode("ascii"),
    }
    temp = CREDENTIAL_FILE + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.chmod(temp, 0o600)
    os.replace(temp, CREDENTIAL_FILE)

def _valid(credentials, username, password):
    if not credentials or not hmac.compare_digest(username, credentials.get("username", "")):
        return False
    if credentials.get("type") == "env":
        return hmac.compare_digest(password, credentials.get("password", ""))
    try:
        salt = base64.b64decode(credentials["salt"])
        expected = base64.b64decode(credentials["digest"])
    except (KeyError, ValueError, TypeError):
        return False
    return hmac.compare_digest(_derive(password, salt), expected)

def railway_login():
    if original._is_logged_in():
        return redirect(url_for("index"))
    credentials = _load_credentials()
    return render_template_string(LOGIN_PAGE, setup=credentials is None, sso_enabled=original.oauth is not None)

@flask_app.route("/local-login", methods=["POST"])
def local_login():
    credentials = _load_credentials()
    supplied_user = request.form.get("username", "").strip()
    supplied_password = request.form.get("password", "")
    if credentials is None:
        if len(supplied_user) < 3 or len(supplied_password) < 12:
            flash("Use a username and a password with at least 12 characters.", "error")
            return redirect(url_for("login"))
        _save_credentials(supplied_user, supplied_password)
        credentials = _load_credentials()
    if not _valid(credentials, supplied_user, supplied_password):
        flash("Invalid username or password.", "error")
        return redirect(url_for("login"))
    pending_url = session.get("shared_url")
    pending_auto = session.get("auto_start_extraction")
    user = original.upsert_oidc_user(sub=f"local:{supplied_user}", username=supplied_user, email=None, name=supplied_user, avatar_url=None, is_admin=True)
    session.clear()
    session["user"] = user["username"]
    session["is_admin"] = True
    session.permanent = True
    if pending_url:
        session["shared_url"] = pending_url
    if pending_auto:
        session["auto_start_extraction"] = True
    return redirect(url_for("index"))

flask_app.view_functions["login"] = railway_login

if __name__ == "__main__":
    original.socketio.run(flask_app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "5006")), debug=False, allow_unsafe_werkzeug=True)
