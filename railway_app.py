"""Railway entry point with secure local-admin authentication fallback."""
import os
import secrets
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "ui"))

import app as original
from flask import flash, redirect, render_template_string, request, session, url_for

flask_app = original.app

LOGIN_PAGE = """
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login - Pick-a-Recipe</title><style>
body{font-family:system-ui,sans-serif;background:#111827;color:#f9fafb;display:grid;place-items:center;min-height:100vh;margin:0}
main{width:min(92vw,420px);background:#1f2937;padding:2rem;border-radius:16px;box-shadow:0 20px 50px #0008}
h1{margin-top:0}label{display:block;margin-top:1rem}input{box-sizing:border-box;width:100%;padding:.8rem;margin-top:.35rem;border:1px solid #4b5563;border-radius:8px;background:#111827;color:white}
button,a{box-sizing:border-box;display:block;width:100%;padding:.85rem;margin-top:1.25rem;border:0;border-radius:8px;text-align:center;background:#7c3aed;color:white;font-weight:700;text-decoration:none;cursor:pointer}
.error{background:#7f1d1d;padding:.75rem;border-radius:8px}
</style></head><body><main><h1>Pick-a-Recipe</h1><p>Extract recipes from social media videos</p>
{% with messages = get_flashed_messages(with_categories=true) %}{% for category, message in messages %}<p class="error">{{ message }}</p>{% endfor %}{% endwith %}
{% if local_enabled %}<form method="post" action="{{ url_for('local_login') }}">
<label>Username<input name="username" autocomplete="username" required></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form>
{% else %}<p class="error">Set LOCAL_ADMIN_USERNAME and LOCAL_ADMIN_PASSWORD in Railway.</p>{% endif %}
{% if sso_enabled %}<a href="{{ url_for('auth_login') }}">Sign in with Authentik</a>{% endif %}
</main></body></html>
"""


def _local_credentials():
    return (os.environ.get("LOCAL_ADMIN_USERNAME", "").strip(), os.environ.get("LOCAL_ADMIN_PASSWORD", ""))


def railway_login():
    if original._is_logged_in():
        return redirect(url_for("index"))
    username, password = _local_credentials()
    return render_template_string(LOGIN_PAGE, local_enabled=bool(username and password), sso_enabled=original.oauth is not None)


@flask_app.route("/local-login", methods=["POST"])
def local_login():
    expected_user, expected_password = _local_credentials()
    supplied_user = request.form.get("username", "")
    supplied_password = request.form.get("password", "")
    valid = bool(expected_user and expected_password)
    valid = valid and secrets.compare_digest(supplied_user, expected_user)
    valid = valid and secrets.compare_digest(supplied_password, expected_password)
    if not valid:
        flash("Invalid username or password.", "error")
        return redirect(url_for("login"))
    pending_url = session.get("shared_url")
    pending_auto = session.get("auto_start_extraction")
    user = original.upsert_oidc_user(sub=f"local:{expected_user}", username=expected_user, email=None, name=expected_user, avatar_url=None, is_admin=True)
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
