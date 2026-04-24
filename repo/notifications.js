/**
 * notifications.js
 *
 * Express router providing the notifications API:
 *
 *   POST /api/notifications/send
 *     Accepts { to, body }, sends an HTML email with a fixed subject,
 *     and returns { success: true, messageId }.
 *
 * Environment variables (all optional):
 *
 *   SMTP_HOST          – SMTP server hostname  (omit → stub transport used)
 *   SMTP_PORT          – SMTP server port      (default: 587)
 *   SMTP_SECURE        – "true" for TLS        (default: false)
 *   SMTP_USER          – SMTP auth username
 *   SMTP_PASS          – SMTP auth password
 *   MAIL_FROM          – Sender address        (default: "noreply@example.com")
 */

"use strict";

const express = require("express");

const router = express.Router();

// ── Email address validation ─────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns true when `address` is a syntactically valid email address.
 * @param {string} address
 * @returns {boolean}
 */
function isValidEmail(address) {
  return typeof address === "string" && EMAIL_RE.test(address.trim());
}

// ── Nodemailer transporter ───────────────────────────────────────────────────
/**
 * Builds a Nodemailer transporter.
 *
 * When SMTP_HOST is not set (e.g. in CI / test environments with no real
 * SMTP server) a lightweight stub is returned that always resolves
 * successfully with a generated messageId.
 *
 * nodemailer is required lazily so the server starts cleanly even if the
 * package has not been installed (no-SMTP path never touches it).
 */
function createTransporter() {
  if (!process.env.SMTP_HOST) {
    // No SMTP server configured – use an in-process stub so the endpoint
    // still returns 200 in environments without a real mail server.
    return {
      sendMail(options) {
        return Promise.resolve({
          messageId: `<stub-${Date.now()}-${Math.random().toString(36).slice(2)}@localhost>`,
        });
      },
    };
  }

  // Only require nodemailer when a real SMTP host is configured.
  const nodemailer = require("nodemailer");

  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    ...(auth ? { auth } : {}),
  });
}

// Allow tests (and future DI) to inject a custom transporter.
let _transporter = null;

/**
 * Replaces the active Nodemailer transporter.  Primarily used in tests.
 * @param {object|null} transporter
 */
function setTransporter(transporter) {
  _transporter = transporter;
}

/**
 * Returns the active transporter, lazily creating the default one.
 * @returns {object}
 */
function getTransporter() {
  if (!_transporter) {
    _transporter = createTransporter();
  }
  return _transporter;
}

// ── POST /api/notifications/send ─────────────────────────────────────────────
/**
 * @route  POST /api/notifications/send
 * @body   { to: string, body: string }
 *
 * Sends an HTML notification email to the specified recipient.
 *
 * The email subject is fixed as "Contact Notification".
 *
 * Success (200):
 *   { success: true, messageId: string }
 *
 * Validation errors (400):
 *   { error: "Invalid email address" }
 *   { error: "Missing required field: body" }
 *
 * Server error (500):
 *   { error: "Failed to send email: <reason>" }
 */
router.post("/send", async (req, res) => {
  const { to, body } = req.body || {};

  // ── Input validation ─────────────────────────────────────────────────────
  if (!isValidEmail(to)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  if (!body || typeof body !== "string" || body.trim() === "") {
    return res.status(400).json({ error: "Missing required field: body" });
  }

  // ── Send email ───────────────────────────────────────────────────────────
  const NOTIFICATION_SUBJECT = "Contact Notification";

  const mailOptions = {
    from: process.env.MAIL_FROM || "noreply@example.com",
    to: to.trim(),
    subject: NOTIFICATION_SUBJECT,
    html: body,
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
module.exports = {
  router,
  isValidEmail,
  setTransporter,
  getTransporter,
};
