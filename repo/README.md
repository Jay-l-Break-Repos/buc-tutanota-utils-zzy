# tutanota-utils carrier — Notifications API

A lightweight Express server that demonstrates the Tutanota GHSA-24v3-254g-jv85 Mithril hyperscript selector-injection vulnerability **and** provides a production-ready email notification API.

---

## Quick start

```bash
npm install
node app.js          # listens on :9090
```

Or with Docker:

```bash
docker build -t tutanota-carrier .
docker run -p 9090:9090 tutanota-carrier
```

---

## Notifications API

### `POST /api/notifications/send`

Sends an HTML notification email to the specified recipient.

**Request body** (`application/json`):

| Field     | Type   | Required | Description                        |
|-----------|--------|----------|------------------------------------|
| `to`      | string | ✅        | Recipient email address            |
| `subject` | string | ✅        | Email subject line                 |
| `body`    | string | ✅        | HTML body of the email             |

**Responses:**

| Status | Body                                              | Meaning                        |
|--------|---------------------------------------------------|--------------------------------|
| 200    | `{ "success": true, "messageId": "<id@host>" }`  | Email sent successfully        |
| 400    | `{ "error": "Invalid email address" }`            | `to` is not a valid email      |
| 400    | `{ "error": "Missing required field: subject" }`  | `subject` is absent/blank      |
| 400    | `{ "error": "Missing required field: body" }`     | `body` is absent/blank         |
| 429    | `{ "error": "Too many requests" }`                | Rate limit exceeded            |
| 500    | `{ "error": "Failed to send email: <reason>" }`   | SMTP / transport error         |

**Example:**

```bash
curl -X POST http://localhost:9090/api/notifications/send \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "user@example.com",
    "subject": "Contact Updated",
    "body": "<h1>Hello</h1><p>Your contact was updated successfully.</p>"
  }'
```

```json
{ "success": true, "messageId": "<stub-1714000000000-abc123@localhost>" }
```

---

### `GET /api/notifications`

Returns the in-memory history of all successfully sent notifications (resets on server restart).

**Response (200):**

```json
[
  {
    "to": "user@example.com",
    "subject": "Contact Updated",
    "sentAt": "2026-04-24T12:00:00.000Z",
    "messageId": "<stub-1714000000000-abc123@localhost>"
  }
]
```

---

## Environment variables

All variables are optional. When `SMTP_HOST` is not set, a stub transport is used (no real email is sent).

| Variable           | Default                 | Description                          |
|--------------------|-------------------------|--------------------------------------|
| `SMTP_HOST`        | *(stub transport)*      | SMTP server hostname                 |
| `SMTP_PORT`        | `587`                   | SMTP server port                     |
| `SMTP_SECURE`      | `false`                 | Set `"true"` to enable TLS           |
| `SMTP_USER`        | —                       | SMTP auth username                   |
| `SMTP_PASS`        | —                       | SMTP auth password                   |
| `MAIL_FROM`        | `noreply@example.com`   | Sender address                       |
| `RATE_LIMIT_MAX`   | `10`                    | Max requests per rolling window      |
| `RATE_LIMIT_WINDOW`| `60000`                 | Rolling window duration (ms)         |

---

## Other endpoints

| Method | Path    | Description                                      |
|--------|---------|--------------------------------------------------|
| GET    | `/`     | Health check — returns `{ "status": "ok" }`      |
| GET    | `/health` | Health check — returns `{ "status": "ok" }`    |
| POST   | `/vuln` | Demonstrates Mithril selector injection (CVE)    |
| GET    | `/vuln?input=<id>&type=twitter` | Same, via query string  |

---

## Running tests

```bash
node --test tests/notifications.test.js
```

Tests use Node's built-in test runner — no extra framework required. A stub transporter is injected automatically so no SMTP server is needed.
