/**
 * COACHING SCHEDULER — backend
 * Reads incoming texts from Quo (OpenPhone), parses booking intent with Claude,
 * writes events to Google Calendar, sends confirmation + 24hr reminder texts.
 *
 * Stack: Node.js + Express. Deploy to Railway (free tier).
 *
 * ── ENV VARS TO SET IN RAILWAY ──────────────────────────────────
 *   GOOGLE_CLIENT_ID          (from your credentials JSON)
 *   GOOGLE_CLIENT_SECRET      (from your credentials JSON)
 *   GOOGLE_REFRESH_TOKEN      (generated once via the /auth flow below)
 *   ANTHROPIC_API_KEY         (from console.anthropic.com)
 *   OPENPHONE_API_KEY         (from Quo → Settings → API)
 *   OPENPHONE_NUMBER          +19789821975
 *   CALENDAR_ID               mohammedjobe96@gmail.com
 *   TIMEZONE                  America/Los_Angeles
 * ────────────────────────────────────────────────────────────────
 */

const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  ANTHROPIC_API_KEY,
  OPENPHONE_API_KEY,
  OPENPHONE_NUMBER,
  CALENDAR_ID = "mohammedjobe96@gmail.com",
  TIMEZONE = "America/Los_Angeles",
} = process.env;

// ── Google Calendar auth ────────────────────────────────────────
const oauth2 = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI ||
    "https://scheduler-production-38f1.up.railway.app/oauth-callback"
);
if (GOOGLE_REFRESH_TOKEN) {
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}
const calendar = google.calendar({ version: "v3", auth: oauth2 });

// ── Claude: parse a text message into structured booking intent ──
async function parseIntent(messageText) {
  const today = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  const prompt = `You are a scheduling assistant for a youth coaching business.
Today is ${today} (timezone ${TIMEZONE}).
A client or parent sent this text: "${messageText}"

Respond ONLY with a JSON object, no markdown, no preamble:
{
  "intent": "book" | "reschedule" | "cancel" | "unknown",
  "clientName": "<name if mentioned, else null>",
  "startISO": "<ISO 8601 datetime of the session, else null>",
  "durationMinutes": <number, default 60>,
  "reply": "<a short, warm confirmation text to send back>"
}
If you can't determine a date/time, set intent to "unknown" and write a reply asking for clarification.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Send a text back through Quo (OpenPhone) ────────────────────
async function sendText(to, body) {
  await fetch("https://api.openphone.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: OPENPHONE_API_KEY,
    },
    body: JSON.stringify({
      from: OPENPHONE_NUMBER,
      to: [to],
      content: body,
    }),
  });
}

// ── Create / update / cancel a calendar event ───────────────────
async function createEvent({ clientName, startISO, durationMinutes }) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + (durationMinutes || 60) * 60000);
  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `Coaching — ${clientName || "Client"}`,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
    },
  });
  return event.data;
}

async function findEventByClient(clientName) {
  const now = new Date().toISOString();
  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now,
    q: clientName,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 1,
  });
  return res.data.items?.[0] || null;
}

// ── Webhook: Quo posts incoming messages here ───────────────────
app.post("/webhook", async (req, res) => {
  if (!GOOGLE_REFRESH_TOKEN) {
    console.warn("Webhook received but GOOGLE_REFRESH_TOKEN is not set — skipping calendar operations.");
    return res.status(200).json({ message: "Calendar not configured. Complete /auth flow to set GOOGLE_REFRESH_TOKEN." });
  }
  try {
    const msg = req.body?.data?.object;
    // only react to inbound messages
    if (!msg || msg.direction !== "incoming") return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text || msg.body || "";
    const parsed = await parseIntent(text);

    if (parsed.intent === "book" && parsed.startISO) {
      await createEvent(parsed);
    } else if (parsed.intent === "reschedule" && parsed.startISO) {
      const existing = await findEventByClient(parsed.clientName);
      if (existing) {
        const end = new Date(
          new Date(parsed.startISO).getTime() +
            (parsed.durationMinutes || 60) * 60000
        );
        await calendar.events.update({
          calendarId: CALENDAR_ID,
          eventId: existing.id,
          requestBody: {
            summary: existing.summary,
            start: { dateTime: parsed.startISO, timeZone: TIMEZONE },
            end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
          },
        });
      }
    } else if (parsed.intent === "cancel") {
      const existing = await findEventByClient(parsed.clientName);
      if (existing) {
        await calendar.events.delete({
          calendarId: CALENDAR_ID,
          eventId: existing.id,
        });
      }
    }

    if (parsed.reply) await sendText(from, parsed.reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200); // always 200 so Quo doesn't retry-storm
  }
});

// ── Reminder sweep: run hourly, text anyone with a session in ~24h ──
app.get("/run-reminders", async (req, res) => {
  if (!GOOGLE_REFRESH_TOKEN) {
    console.warn("Run-reminders called but GOOGLE_REFRESH_TOKEN is not set — skipping calendar operations.");
    return res.status(200).json({ message: "Calendar not configured. Complete /auth flow to set GOOGLE_REFRESH_TOKEN." });
  }
  try {
    const in24 = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const in25 = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const events = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: in24.toISOString(),
      timeMax: in25.toISOString(),
      singleEvents: true,
    });
    for (const ev of events.data.items || []) {
      const phone = ev.description?.match(/\+\d{10,}/)?.[0];
      const when = new Date(ev.start.dateTime).toLocaleString("en-US", {
        timeZone: TIMEZONE,
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      });
      if (phone) {
        await sendText(
          phone,
          `Reminder: ${ev.summary.replace("Coaching — ", "")} session ${when}. Reply CANCEL if you need to change it.`
        );
      }
    }
    res.json({ sent: events.data.items?.length || 0 });
  } catch (err) {
    console.error("Reminder error:", err);
    res.sendStatus(500);
  }
});

// ── One-time helper to generate your GOOGLE_REFRESH_TOKEN ────────
app.get("/auth", (req, res) => {
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(url);
});
app.get("/oauth-callback", async (req, res) => {
  if (!req.query.code) {
    return res.status(400).send(
      `<pre>Error: No authorization code received from Google.\nMake sure you are redirected here from the /auth flow.</pre>`
    );
  }
  try {
    const { tokens } = await oauth2.getToken(req.query.code);
    res.send(
      `<pre>Your refresh token (save as GOOGLE_REFRESH_TOKEN):\n\n${tokens.refresh_token}</pre>`
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(
      `<pre>Error exchanging authorization code for tokens:\n\n${err.message}\n\nCommon causes:\n- The code has already been used (codes are single-use)\n- The code has expired (visit /auth to get a fresh one)\n- The redirect URI in your Google Cloud credentials does not match this app's URL</pre>`
    );
  }
});

app.get("/", (_, res) => res.send("Coaching scheduler is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "::", () => console.log(`Listening on ${PORT}`));
