/**
 * routes/notifications.js
 *
 * Notification API endpoints:
 *
 *   POST /api/notifications/send
 *     Body: { recipient: string, body: string }
 *     - Validates the recipient email address (RFC-5322 compliant regex).
 *     - Sends an HTML email via nodemailer (SMTP transport configured through
 *       environment variables).
 *     - Persists a record to the notification history store.
 *     - Returns 200 { messageId, message } on success.
 *     - Returns 400 { error } when the email address is invalid.
 *     - Returns 500 { error } on transport failure.
 *
 *   GET /api/notifications
 *     - Returns 200 { notifications: [...] } — full history, newest first.
 *
 * Environment variables consumed by the SMTP transport:
 *   SMTP_HOST     — SMTP server hostname  (default: "localhost")
 *   SMTP_PORT     — SMTP server port      (default: 587)
 *   SMTP_SECURE   — "true" for TLS/SSL    (default: false)
 *   SMTP_USER     — SMTP auth username    (optional)
 *   SMTP_PASS     — SMTP auth password    (optional)
 *   SMTP_FROM     — Sender address        (default: "notifications@tutanota-utils.local")
 *   NOTIFICATION_SUBJECT — Email subject  (default: "Contact Import / Update Summary")
 */

"use strict";

const express = require("express");
const nodemailer = require("nodemailer");
const notificationModel = require("../models/notification");

const router = express.Router();

// ── Email validation ─────────────────────────────────────────────────────────
// RFC-5322-inspired regex that covers the vast majority of valid addresses
// while rejecting obviously malformed ones.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns true when `email` is a syntactically valid email address.
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  return typeof email === "string" && EMAIL_REGEX.test(email.trim());
}

// ── SMTP transport factory ───────────────────────────────────────────────────
/**
 * Build a nodemailer transporter from environment variables.
 * Falls back to safe defaults so the app starts without any configuration.
 *
 * @returns {import("nodemailer").Transporter}
 */
function createTransport() {
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

// ── POST /api/notifications/send ─────────────────────────────────────────────
/**
 * Send a notification email and record it in the history store.
 *
 * Request body (JSON):
 *   {
 *     "recipient": "user@example.com",   // required — recipient email address
 *     "body":      "<p>Hello!</p>"       // required — HTML message body
 *   }
 *
 * Success response (200):
 *   {
 *     "messageId": "<unique-id@smtp-server>",
 *     "message":   "Notification sent successfully."
 *   }
 *
 * Error responses:
 *   400 — { "error": "Invalid email address." }
 *   500 — { "error": "<transport error message>" }
 */
router.post("/send", async (req, res) => {
  const { recipient, body } = req.body || {};

  // ── 1. Validate recipient ──────────────────────────────────────────────────
  if (!recipient || !isValidEmail(recipient)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  if (!body || typeof body !== "string" || body.trim() === "") {
    return res.status(400).json({ error: "Message body is required." });
  }

  const subject =
    process.env.NOTIFICATION_SUBJECT || "Contact Import / Update Summary";
  const from =
    process.env.SMTP_FROM || "notifications@tutanota-utils.local";

  // ── 2. Send the email ──────────────────────────────────────────────────────
  let info;
  try {
    const transporter = createTransport();
    info = await transporter.sendMail({
      from,
      to: recipient.trim(),
      subject,
      html: body,
    });
  } catch (err) {
    // Persist a failed record so the history reflects the attempt.
    notificationModel.create({
      recipient: recipient.trim(),
      subject,
      body,
      status: "failed",
    });
    return res.status(500).json({ error: err.message });
  }

  // ── 3. Persist a success record ────────────────────────────────────────────
  const record = notificationModel.create({
    recipient: recipient.trim(),
    subject,
    body,
    status: "sent",
  });

  return res.status(200).json({
    messageId: info.messageId || record.id,
    message: "Notification sent successfully.",
  });
});

// ── GET /api/notifications ────────────────────────────────────────────────────
/**
 * Retrieve the full notification history, newest first.
 *
 * Success response (200):
 *   {
 *     "notifications": [
 *       {
 *         "id":        "uuid",
 *         "recipient": "user@example.com",
 *         "subject":   "Contact Import / Update Summary",
 *         "body":      "<p>Hello!</p>",
 *         "status":    "sent",
 *         "sentAt":    "2024-01-01T00:00:00.000Z"
 *       },
 *       ...
 *     ]
 *   }
 */
router.get("/", (req, res) => {
  const notifications = notificationModel.findAll();
  return res.status(200).json({ notifications });
});

module.exports = router;
