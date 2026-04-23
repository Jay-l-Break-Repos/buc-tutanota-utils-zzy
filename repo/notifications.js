/**
 * notifications.js
 *
 * Express router providing the POST /api/notifications/send endpoint.
 *
 * Accepts a recipient email address and a plain-text message body, wraps the
 * body in a minimal HTML template, and dispatches the email via Nodemailer.
 *
 * Environment variables (all optional – sensible defaults are used for local
 * development / testing):
 *
 *   SMTP_HOST     – SMTP server hostname          (default: "localhost")
 *   SMTP_PORT     – SMTP server port              (default: 587)
 *   SMTP_SECURE   – "true" to use TLS on connect  (default: false)
 *   SMTP_USER     – SMTP auth username
 *   SMTP_PASS     – SMTP auth password
 *   MAIL_FROM     – Sender address                (default: "noreply@example.com")
 */

"use strict";

const express = require("express");
const nodemailer = require("nodemailer");

const router = express.Router();

// ── Email address validation ─────────────────────────────────────────────────
// RFC 5322-inspired regex that covers the vast majority of real-world addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns true when `address` is a syntactically valid email address.
 * @param {string} address
 * @returns {boolean}
 */
function isValidEmail(address) {
  return typeof address === "string" && EMAIL_RE.test(address.trim());
}

// ── Nodemailer transporter factory ──────────────────────────────────────────
/**
 * Builds and returns a Nodemailer transporter configured from environment
 * variables.  Exported so tests can swap it out via `setTransporter()`.
 */
function createTransporter() {
  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "localhost",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    ...(auth ? { auth } : {}),
  });
}

// Allow tests (and future DI) to inject a custom transporter.
let _transporter = null;

/**
 * Replaces the active Nodemailer transporter.  Primarily used in tests.
 * @param {import("nodemailer").Transporter} transporter
 */
function setTransporter(transporter) {
  _transporter = transporter;
}

/**
 * Returns the active transporter, creating a default one on first call.
 * @returns {import("nodemailer").Transporter}
 */
function getTransporter() {
  if (!_transporter) {
    _transporter = createTransporter();
  }
  return _transporter;
}

// ── HTML body builder ────────────────────────────────────────────────────────
/**
 * Wraps a plain-text message in a simple HTML email template.
 * New-lines in the message are converted to <br> tags.
 *
 * @param {string} message  Plain-text message body
 * @returns {string}        HTML string
 */
function buildHtmlBody(message) {
  // Escape HTML special characters to prevent injection in the body text.
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Notification</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: #fff;
                 border-radius: 6px; padding: 32px; box-shadow: 0 2px 6px rgba(0,0,0,.1); }
    p { color: #333; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <p>${escaped}</p>
  </div>
</body>
</html>`;
}

// ── POST /api/notifications/send ─────────────────────────────────────────────
/**
 * @route  POST /api/notifications/send
 * @body   { to: string, message: string }
 *
 * Sends an HTML notification email to the specified recipient.
 *
 * Success (200):
 *   { success: true, messageId: "<smtp-message-id>" }
 *
 * Validation error (400):
 *   { error: "Invalid email address" }
 *   { error: "Missing required field: message" }
 *
 * Server error (500):
 *   { error: "Failed to send email: <reason>" }
 */
router.post("/send", async (req, res) => {
  const { to, message } = req.body || {};

  // ── Input validation ───────────────────────────────────────────────────────
  if (!isValidEmail(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Missing required field: message" });
  }

  // ── Build and send the email ───────────────────────────────────────────────
  const mailOptions = {
    from: process.env.MAIL_FROM || "noreply@example.com",
    to: to.trim(),
    subject: "Notification",
    html: buildHtmlBody(message.trim()),
  };

  try {
    const info = await getTransporter().sendMail(mailOptions);
    return res.status(200).json({ success: true, messageId: info.messageId });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `Failed to send email: ${err.message}` });
  }
});

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = { router, isValidEmail, buildHtmlBody, setTransporter, getTransporter };
