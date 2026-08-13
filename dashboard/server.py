import os
from urllib.parse import urlencode

import requests
from flask import Flask, jsonify, render_template

app = Flask(__name__)


def get_required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "billbuddy-dashboard"})


@app.get("/api/dashboard")
def dashboard():
    try:
        base_url = get_required_env("APPS_SCRIPT_API_URL")
        api_key = get_required_env("DASHBOARD_API_KEY")

        query = urlencode({
            "api": "dashboard",
            "key": api_key,
        })

        separator = "&" if "?" in base_url else "?"
        url = f"{base_url}{separator}{query}"

        response = requests.get(
            url,
            timeout=30,
            headers={
                "Accept": "application/json",
                "User-Agent": "BillBuddy-Dashboard/1.0",
            },
        )

        response.raise_for_status()
        payload = response.json()

        if payload.get("ok") is not True:
            return jsonify({
                "ok": False,
                "error": payload.get("error", "Apps Script API returned an error."),
            }), 502

        return jsonify(payload)

    except requests.Timeout:
        return jsonify({
            "ok": False,
            "error": "BillBuddy data service timed out. Please refresh in a moment.",
        }), 504

    except requests.RequestException:
        return jsonify({
            "ok": False,
            "error": "Unable to reach the BillBuddy data service.",
        }), 502

    except Exception as exc:
        app.logger.exception("Dashboard API error")
        return jsonify({
            "ok": False,
            "error": str(exc),
        }), 500
