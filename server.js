const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const path = require("path");
const Parser = require("rss-parser");
const { google } = require("googleapis");
const OpenAI = require("openai");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const parser = new Parser();

app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "primoris-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

const PUBLIC_DIR = __dirname;

app.use(express.static(PUBLIC_DIR));

/* =========================
   STATUS
========================= */

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    calendar: !!req.session.tokens,
    ai: !!process.env.OPENAI_API_KEY
  });
});

/* =========================
   GOOGLE CALENDAR
========================= */

function createOAuthClient() {
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
      .send("Google Calendar ainda não está configurado no Render.");
  }

  const oauth = createOAuthClient();

  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar"
    ]
  });

  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code) {
      return res.status(400).send("Código de autorização não recebido.");
    }

    const oauth = createOAuthClient();

    const { tokens } = await oauth.getToken(req.query.code);

    req.session.tokens = tokens;

    res.redirect("/#integrations");
  } catch (error) {
    console.error("Erro Google OAuth:", error);

    res
      .status(500)
      .send("Falha ao conectar o Google Calendar.");
  }
});

app.get("/auth/google/disconnect", (req, res) => {
  req.session.tokens = null;
  res.redirect("/");
});

app.get("/api/calendar/events", async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.status(401).json({
        error: "not_connected"
      });
    }

    const oauth = createOAuthClient();

    oauth.setCredentials(req.session.tokens);

    const calendar = google.calendar({
      version: "v3",
      auth: oauth
    });

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50
    });

    res.json({
      events: result.data.items || []
    });
  } catch (error) {
    console.error("Erro Calendar:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   IA
========================= */

app.post("/api/ai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        text:
          "A IA externa não está configurada. O PRIMORIS continua funcionando em modo local."
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const model =
      process.env.OPENAI_MODEL || "gpt-6.1-sol";

    const message = req.body.message || "";

    const context = req.body.context || {};

    const response = await client.responses.create({
      model,
      input:
        "Você é o PRIMORIS, um assistente pessoal objetivo e útil. " +
        "Responda em português do Brasil.\n\n" +
        "Contexto do usuário:\n" +
        JSON.stringify(context) +
        "\n\nMensagem:\n" +
        message
    });

    res.json({
      text: response.output_text || "Sem resposta."
    });
  } catch (error) {
    console.error("Erro IA:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   GOOGLE NEWS
========================= */

app.get("/api/news", async (req, res) => {
  try {
    const queries = [
      {
        query: "Brasil OR Brasília OR economia brasileira",
        category: "Brasil"
      },
      {
        query: "mundo OR geopolítica OR internacional",
        category: "Mundo"
      },
      {
        query: "tecnologia OR inteligência artificial",
        category: "Tecnologia"
      }
    ];

    const items = [];

    for (const item of queries) {
      const url =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(item.query) +
        "&hl=pt-BR&gl=BR&ceid=BR:pt-419";

      const feed = await parser.parseURL(url);

      for (const article of (feed.items || []).slice(0, 5)) {
        items.push({
          title: article.title || "Notícia",
          link: article.link || "",
          source: article.creator || "Google News",
          category: item.category,
          date: article.pubDate || ""
        });
      }
    }

    res.json({
      items
    });
  } catch (error) {
    console.error("Erro notícias:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   FRONTEND
========================= */

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* =========================
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `PRIMORIS iniciado com sucesso na porta ${PORT}`
  );
});

process.on("uncaughtException", (error) => {
  console.error("ERRO NÃO CAPTURADO:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("PROMISE NÃO TRATADA:", error);
});
