import os
import time
from urllib.parse import urlencode

import requests
from flask import Flask, jsonify, render_template

app = Flask(__name__)

# Keep the most recent successful dashboard payload in memory.
# This prevents a temporary Apps Script slowdown from making the
# whole dashboard look broken.
CACHE = {
    "payload": None,
    "fetched_at": 0.0,
}

CACHE_TTL_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 60
MAX_ATTEMPTS = 2


def get_required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def build_apps_script_url():
    base_url = get_required_env("APPS_SCRIPT_API_URL")
    api_key = get_required_env("DASHBOARD_API_KEY")

    query = urlencode({
        "api": "dashboard",
        "key": api_key,
    })

    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}{query}"


def fetch_dashboard_from_apps_script():
    url = build_apps_script_url()

    last_error = None

    for attempt in range(MAX_ATTEMPTS):
        try:
            response = requests.get(
                url,
                timeout=REQUEST_TIMEOUT_SECONDS,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "BillBuddy-Dashboard/1.1",
                },
            )

            response.raise_for_status()
            payload = response.json()

            if payload.get("ok") is not True:
                raise RuntimeError(
                    payload.get(
                        "error",
                        "Apps Script API returned an error.",
                    )
                )

            CACHE["payload"] = payload
            CACHE["fetched_at"] = time.time()

            return payload

        except (
            requests.Timeout,
            requests.RequestException,
            ValueError,
            RuntimeError,
        ) as exc:
            last_error = exc

            # Small pause before the one retry.
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(1.0)

    raise last_error


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "billbuddy-dashboard",
    })


@app.get("/api/dashboard")
def dashboard():
    try:
        payload = fetch_dashboard_from_apps_script()

        return jsonify({
            **payload,
            "cached": False,
        })

    except Exception as exc:
        app.logger.warning(
            "Apps Script dashboard request failed: %s",
            exc,
        )

        cached = CACHE.get("payload")

        if cached:
            age_seconds = max(
                0,
                int(time.time() - CACHE["fetched_at"]),
            )

            return jsonify({
                **cached,
                "cached": True,
                "cache_age_seconds": age_seconds,
                "warning": (
                    "Live refresh was temporarily unavailable. "
                    "Showing the most recent successful BillBuddy data."
                ),
            })

        if isinstance(exc, requests.Timeout):
            message = (
                "BillBuddy data service is taking longer than usual. "
                "Please refresh in a moment."
            )
            status = 504
        else:
            message = (
                "Unable to reach the BillBuddy data service right now."
            )
            status = 502

        return jsonify({
            "ok": False,
            "error": message,
        }), status
