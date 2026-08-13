import os
import time
from urllib.parse import urlencode

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

CACHE = {"payload": None, "fetched_at": 0.0}
REQUEST_TIMEOUT_SECONDS = 55


def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def apps_script_url(api):
    base = env("APPS_SCRIPT_API_URL")
    query = urlencode({
        "api": api,
        "key": env("DASHBOARD_API_KEY"),
    })
    return f"{base}{'&' if '?' in base else '?'}{query}"


def get_json(api):
    response = requests.get(
        apps_script_url(api),
        timeout=REQUEST_TIMEOUT_SECONDS,
        headers={"Accept": "application/json", "User-Agent": "BillBuddy-Dashboard/2.0"},
    )
    response.raise_for_status()
    return response.json()


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "billbuddy-dashboard"})


@app.get("/api/dashboard")
def dashboard():
    try:
        payload = get_json("dashboard")
        if payload.get("ok") is not True:
            return jsonify(payload), 502
        CACHE["payload"] = payload
        CACHE["fetched_at"] = time.time()
        return jsonify({**payload, "cached": False})
    except Exception as exc:
        app.logger.warning("Dashboard fetch failed: %s", exc)
        if CACHE["payload"]:
            return jsonify({
                **CACHE["payload"],
                "cached": True,
                "warning": "Showing the latest successful BillBuddy data."
            })
        return jsonify({"ok": False, "error": "Unable to reach BillBuddy data service."}), 502


@app.get("/api/credit-limits")
def credit_limits():
    try:
        payload = get_json("credit_limits")
        return jsonify(payload)
    except Exception as exc:
        app.logger.warning("Credit limits fetch failed: %s", exc)
        return jsonify({"ok": False, "error": "Unable to load credit limits."}), 502


@app.post("/api/credit-limits")
def save_credit_limit():
    try:
        response = requests.post(
            apps_script_url("credit_limit"),
            json=request.get_json(silent=True) or {},
            timeout=REQUEST_TIMEOUT_SECONDS,
            headers={"Accept": "application/json", "User-Agent": "BillBuddy-Dashboard/2.0"},
        )
        response.raise_for_status()
        payload = response.json()
        return jsonify(payload)
    except Exception as exc:
        app.logger.warning("Credit limit save failed: %s", exc)
        return jsonify({"ok": False, "error": "Unable to save the credit limit."}), 502
