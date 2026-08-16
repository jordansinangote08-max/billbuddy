from flask import Flask, request, jsonify
from io import BytesIO

import pikepdf
from pypdf import PdfReader

app = Flask(__name__)


@app.get("/")
def health():
    return {
        "status": "ok",
        "service": "billbuddy-pdf-worker"
    }


def extract_with_pypdf(raw_pdf, password):
    """
    Try pypdf first.

    Some encrypted bank PDFs can be opened by pypdf even when
    pikepdf/qpdf rejects the same valid user password.
    """
    reader = PdfReader(BytesIO(raw_pdf))

    if reader.is_encrypted:
        result = reader.decrypt(password)

        # pypdf returns a PasswordType / integer-like value.
        # 0 means the password failed.
        if not result:
            raise ValueError("PYPDF_PASSWORD_REJECTED")

    text_parts = []

    for page in reader.pages:
        text_parts.append(
            page.extract_text() or ""
        )

    return "\n".join(text_parts)


def extract_with_pikepdf(raw_pdf, password):
    """
    Fallback for PDFs that pypdf cannot decrypt/read cleanly.
    """
    unlocked_buffer = BytesIO()

    with pikepdf.open(
        BytesIO(raw_pdf),
        password=password
    ) as pdf:
        pdf.save(unlocked_buffer)

    unlocked_buffer.seek(0)

    reader = PdfReader(
        unlocked_buffer
    )

    text_parts = []

    for page in reader.pages:
        text_parts.append(
            page.extract_text() or ""
        )

    return "\n".join(text_parts)


@app.post("/extract")
def extract():
    uploaded = request.files.get("file")

    if not uploaded:
        return jsonify({
            "ok": False,
            "error": "Missing PDF file"
        }), 400

    # Keep the password exactly as Apps Script sent it.
    # Do not log it.
    password = request.form.get(
        "password",
        ""
    )

    raw_pdf = uploaded.read()

    if not raw_pdf:
        return jsonify({
            "ok": False,
            "error": "Empty PDF file"
        }), 400

    errors = []

    # ---------------------------------------------------------
    # 1. Try pypdf first
    # ---------------------------------------------------------
    try:
        text = extract_with_pypdf(
            raw_pdf,
            password
        )

        return jsonify({
            "ok": True,
            "engine": "pypdf",
            "text": text
        })

    except Exception as exc:
        errors.append(
            "pypdf: " + str(exc)
        )

    # ---------------------------------------------------------
    # 2. Fall back to pikepdf
    # ---------------------------------------------------------
    try:
        text = extract_with_pikepdf(
            raw_pdf,
            password
        )

        return jsonify({
            "ok": True,
            "engine": "pikepdf",
            "text": text
        })

    except pikepdf.PasswordError:
        errors.append(
            "pikepdf: password rejected"
        )

    except Exception as exc:
        errors.append(
            "pikepdf: " + str(exc)
        )

    # ---------------------------------------------------------
    # Neither engine could open the encrypted PDF.
    # Do not expose/log the password itself.
    # ---------------------------------------------------------
    return jsonify({
        "ok": False,
        "error": "Unable to decrypt PDF with supplied password",
        "details": errors
    }), 401


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=10000
    )
