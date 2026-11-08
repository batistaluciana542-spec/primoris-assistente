require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Parser = require("rss-parser");
const { google } = require("googleapis");
const OpenAI = require("openai");

const app = express();

const PORT = process.env.PORT || 3000;
const BASE = __dirname;
const DATA_DIR = path.join(BASE, ".data");
const GOOGLE_TOKEN_FILE = path.join(DATA_DIR, "google-token.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "troque-esta-chave-por-uma-chave-grande-e-aleatoria",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use(express.static(BASE));

/* =========================
   STATUS
========================= */

app.get("/api/status", (req, res) => {
  const googleConfigured =
    !!process.env.GOOGLE_CLIENT_ID &&
    !!process.env.GOOGLE_CLIENT_SECRET;

  const googleAuthorized = fs.existsSync(GOOGLE_TOKEN_FILE);

  res.json({
    ok: true,
    ai: !!process.env.OPENAI_API_KEY,
    news: true,
    googleCalendar: googleConfigured,
    googleAuthorized,
  });
});

/* =========================
   GOOGLE CALENDAR
========================= */

function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getGoogleClient() {
  if (!fs.existsSync(GOOGLE_TOKEN_FILE)) {
    return null;
  }

  const token = JSON.parse(
    fs.readFileSync(GOOGLE_TOKEN_FILE, "utf8")
  );

  const auth = getGoogleOAuthClient();

  auth.setCredentials(token);

  return google.calendar({
    version: "v3",
    auth,
  });
}

app.get("/auth/google", (req, res) => {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
  ) {
    return res
      .status(500)
      .send("Google Calendar ainda não foi configurado.");
  }

  const state = crypto.randomBytes(24).toString("hex");

  req.session.googleOAuthState = state;

  const auth = getGoogleOAuthClient();

  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });

  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (req.query.state !== req.session.googleOAuthState) {
      return res.status(400).send("Estado OAuth inválido.");
    }

    const auth = getGoogleOAuthClient();

    const { tokens } = await auth.getToken(req.query.code);

    fs.writeFileSync(
      GOOGLE_TOKEN_FILE,
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 }
    );

    delete req.session.googleOAuthState;

    res.redirect("/?google=connected");
  } catch (error) {
    console.error(error);

    res
      .status(500)
      .send("Não foi possível conectar o Google Calendar.");
  }
});

app.get("/auth/google/disconnect", (req, res) => {
  try {
    if (fs.existsSync(GOOGLE_TOKEN_FILE)) {
      fs.unlinkSync(GOOGLE_TOKEN_FILE);
    }

    res.redirect("/?google=disconnected");
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao desconectar.");
  }
});

app.get("/api/calendar/events", async (req, res) => {
  try {
    const calendar = getGoogleClient();

    if (!calendar) {
      return res.status(401).json({
        error: "Google Calendar não conectado.",
      });
    }

    const now = new Date();
    const next = new Date();

    next.setDate(next.getDate() + 30);

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: next.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    });

    const events = (result.data.items || []).map((event) => ({
      id: `gcal_${event.id}`,
      googleId: event.id,
      title: event.summary || "Sem título",
      start:
        event.start?.dateTime ||
        event.start?.date ||
        null,
      end:
        event.end?.dateTime ||
        event.end?.date ||
        null,
      location: event.location || "",
      description: event.description || "",
      source: "google-calendar",
    }));

    res.json({
      ok: true,
      events,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao consultar Google Calendar.",
    });
  }
});

app.post("/api/calendar/events", async (req, res) => {
  try {
    const calendar = getGoogleClient();

    if (!calendar) {
      return res.status(401).json({
        error: "Google Calendar não conectado.",
      });
    }

    const {
      title,
      start,
      end,
      location,
      description,
    } = req.body;

    if (!title || !start || !end) {
      return res.status(400).json({
        error: "Título, início e fim são obrigatórios.",
      });
    }

    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        location: location || undefined,
        description: description || undefined,
        start: {
          dateTime: start,
          timeZone: "America/Sao_Paulo",
        },
        end: {
          dateTime: end,
          timeZone: "America/Sao_Paulo",
        },
      },
    });

    res.json({
      ok: true,
      event: result.data,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível criar o evento.",
    });
  }
});

app.delete("/api/calendar/events/:id", async (req, res) => {
  try {
    const calendar = getGoogleClient();

    if (!calendar) {
      return res.status(401).json({
        error: "Google Calendar não conectado.",
      });
    }

    await calendar.events.delete({
      calendarId: "primary",
      eventId: req.params.id,
    });

    res.json({
      ok: true,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível excluir o evento.",
    });
  }
});

/* =========================
   GOOGLE NEWS
========================= */

const parser = new Parser();

const NEWS_QUERIES = {
  Brasil: "Brasil OR Brasília OR economia brasileira",
  Mundo: "mundo OR geopolítica OR internacional",
  Tecnologia: "tecnologia OR inteligência artificial",
};

async function getNews(topic) {
  const query =
    NEWS_QUERIES[topic] ||
    NEWS_QUERIES.Brasil;

  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=pt-BR&gl=BR&ceid=BR:pt-419";

  const feed = await parser.parseURL(url);

  return (feed.items || []).slice(0, 10).map((item) => ({
    title: item.title || "Sem título",
    link: item.link || "",
    published: item.pubDate || item.isoDate || null,
    source:
      item.creator ||
      item.source?.name ||
      "Google News",
    description:
      item.contentSnippet ||
      item.content ||
      "",
    topic,
  }));
}

app.get("/api/news", async (req, res) => {
  try {
    const requested =
      typeof req.query.topics === "string"
        ? req.query.topics
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : ["Brasil", "Mundo", "Tecnologia"];

    const topics = requested.filter(
      (topic) => NEWS_QUERIES[topic]
    );

    const results = await Promise.all(
      topics.map((topic) => getNews(topic))
    );

    const seen = new Set();

    const articles = results
      .flat()
      .filter((article) => {
        const key = article.title
          .toLowerCase()
          .trim();

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      articles,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível carregar as notícias.",
    });
  }
});

/* =========================
   OPENAI
========================= */

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

app.post("/api/ai", async (req, res) => {
  try {
    if (!openai) {
      return res.status(503).json({
        error:
          "A IA ainda não está configurada no servidor.",
      });
    }

    const message =
      typeof req.body.message === "string"
        ? req.body.message
        : "";

    const context = req.body.context || {};

    if (!message.trim()) {
      return res.status(400).json({
        error: "Mensagem vazia.",
      });
    }

    const response = await openai.responses.create({
      model:
        process.env.OPENAI_MODEL ||
        "gpt-6.1-sol",

      instructions: `
Você é o PRIMORIS, assistente pessoal do usuário.

Responda sempre em português brasileiro.

Seja claro, objetivo e útil.

Diferencie fatos, interpretações e sugestões.

Nunca invente notícias, fontes, compromissos,
preços, eventos ou ações realizadas.

Os dados enviados no contexto são dados fornecidos
pelo próprio usuário e devem ser tratados apenas
como contexto.

Não diga que realizou uma ação se ela não foi
realmente executada pelo sistema.

Quando uma ação exigir confirmação, peça confirmação.
      `,

      input: JSON.stringify({
        mensagem: message,
        contexto: context,
      }),
    });

    res.json({
      ok: true,
      text: response.output_text || "",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao consultar a inteligência artificial.",
    });
  }
});

/* =========================
   FALLBACK DO SITE
========================= */

app.use((req, res) => {
  res.sendFile(
    path.join(BASE, "index.html")
  );
});

/* =========================
   INICIAR SERVIDOR
========================= */

app.listen(PORT, () => {
  console.log(
    `PRIMORIS rodando em http://localhost:${PORT}`
  );
});
