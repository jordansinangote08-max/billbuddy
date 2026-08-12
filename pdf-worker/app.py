from flask import Flask, request, jsonify
from io import BytesIO
import pikepdf
from pypdf import PdfReader

app = Flask(__name__)

@app.get("/")
def health():
    return {"status": "ok"}

@app.post("/extract")
def extract():
    try:
        uploaded = request.files.get("file")
        password = request.form.get("password", "")

        if not uploaded:
            return jsonify({"error": "Missing PDF file"}), 400

        raw_pdf = uploaded.read()
        unlocked_buffer = BytesIO()

        with pikepdf.open(BytesIO(raw_pdf), password=password) as pdf:
            pdf.save(unlocked_buffer)

        unlocked_buffer.seek(0)
        reader = PdfReader(unlocked_buffer)

        text_parts = []
        for page in reader.pages:
            text_parts.append(page.extract_text() or "")

        return jsonify({
            "ok": True,
            "text": "\n".join(text_parts)
        })

    except pikepdf.PasswordError:
        return jsonify({
            "ok": False,
            "error": "Invalid PDF password"
        }), 401

    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e)
        }), 500
