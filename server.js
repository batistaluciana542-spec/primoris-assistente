const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const path = require("path");
const Parser = require("rss-parser");
const { google } = require("googleapis");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const parser = new Parser();

app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

app.use(express.static(path.join(__dirname)));

// =====================================================
// STATUS
// =====================================================

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    calendar: !!req.session.tokens,
    ai: !!process.env.GEMINI_API_KEY,
    aiProvider: process.env.GEMINI_API_KEY
      ? "Google Gemini"
      : "local"
  });
});

// =====================================================
// GOOGLE CALENDAR
// =====================================================

function oauth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

app.get("/auth/google", (req, res) => {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GOOGLE_REDIRECT_URI
  ) {
    return res
      .status(500)
      .send("Google OAuth não configurado no Render.");
  }

  const o = oauth();

  res.redirect(
    o.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/calendar"
      ]
    })
  );
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const o = oauth();

    const { tokens } = await o.getToken(req.query.code);

    req.session.tokens = tokens;

    res.redirect("/#integrations");
  } catch (e) {
    console.error("Google OAuth:", e);

    res
      .status(500)
      .send("Falha no Google Calendar: " + e.message);
  }
});

app.get("/auth/google/disconnect", (req, res) => {
  req.session.tokens = null;
  res.redirect("/");
});

function calendarClient(req) {
  if (!req.session.tokens) return null;

  const o = oauth();

  o.setCredentials(req.session.tokens);

  return google.calendar({
    version: "v3",
    auth: o
  });
}

app.get("/api/calendar/events", async (req, res) => {
  try {
    const c = calendarClient(req);

    if (!c) {
      return res.status(401).json({
        error: "not_connected"
      });
    }

    const r = await c.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500
    });

    res.json({
      events: r.data.items || []
    });

  } catch (e) {
    console.error("Calendar:", e);

    res.status(500).json({
      error: e.message
    });
  }
});

// =====================================================
// GEMINI - IA
// =====================================================

app.post("/api/ai", async (req, res) => {
  try {
    const message = String(
      req.body?.message || ""
    ).trim();

    const context = req.body?.context || {};

    if (!message) {
      return res.status(400).json({
        error: "message_required"
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "gemini_not_configured",
        details:
          "GEMINI_API_KEY não está configurada no Render."
      });
    }

    const model =
      process.env.GEMINI_MODEL ||
      "gemini-3.8-flash";

    const prompt = `
Você é o PRIMORIS, um assistente pessoal.

Responda em português do Brasil.

Seja rápido, claro e objetivo.

Ajude com:
- organização
- estudos
- tarefas
- agenda
- planejamento
- informações
- programação
- finanças
- ideias
- explicações

Use o contexto quando for útil.

Não invente informações.

CONTEXTO:
${JSON.stringify(context)}

USUÁRIO:
${message}
`;

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

    // Timeout de 15 segundos
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    let response;

    try {
      response = await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        signal: controller.signal,

        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 600
          }
        })
      });

    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();

    let body = {};

    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }

    if (!response.ok) {
      console.error(
        "Erro Gemini:",
        response.status,
        body
      );

      return res.status(502).json({
        error: "gemini_request_failed",
        details:
          body?.error?.message ||
          "Erro ao consultar o Gemini."
      });
    }

    const text =
      body?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!text) {
      console.error(
        "Gemini sem resposta:",
        JSON.stringify(body)
      );

      return res.status(502).json({
        error: "gemini_empty_response",
        details:
          "O Gemini não retornou uma resposta."
      });
    }

    res.json({
      text,
      provider: "Google Gemini",
      model
    });

  } catch (e) {

    if (e.name === "AbortError") {
      console.error(
        "Gemini demorou mais de 15 segundos."
      );

      return res.status(504).json({
        error: "gemini_timeout",
        details:
          "A IA demorou demais para responder."
      });
    }

    console.error(
      "Erro na IA:",
      e
    );

    res.status(500).json({
      error: "ai_server_error",
      details: e.message
    });
  }
});

// =====================================================
// GOOGLE NEWS
// =====================================================

app.get("/api/news", async (req, res) => {
  try {
    const queries = [
      "Brasil OR Brasília OR economia brasileira",
      "mundo OR geopolítica OR internacional",
      "tecnologia OR inteligência artificial"
    ];

    const items = [];

    for (const q of queries) {

      const url =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(q) +
        "&hl=pt-BR&gl=BR&ceid=BR:pt-419";

      const feed = await parser.parseURL(url);

      for (
        const item of (feed.items || []).slice(0, 5)
      ) {
        items.push({
          title: item.title,
          link: item.link,
          source:
            item.creator || "Google News",

          category:
            q.includes("tecnologia")
              ? "Tecnologia"
              : q.includes("mundo")
              ? "Mundo"
              : "Brasil"
        });
      }
    }

    res.json({
      items
    });

  } catch (e) {

    console.error(
      "News:",
      e
    );

    res.status(500).json({
      error: e.message
    });
  }
});

// =====================================================
// FALLBACK
// =====================================================

app.use((req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// =====================================================
// SERVIDOR
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `PRIMORIS rodando na porta ${PORT}`
    );
  }
);
