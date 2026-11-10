const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const path = require("path");
const Parser = require("rss-parser");
const { google } = require("googleapis");

dotenv.config();

const app = express();
app.set("trust proxy", 1);

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
    ai: true,
    mode: "local"
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
    res.status(500).send("Falha ao conectar o Google Calendar.");
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
   IA LOCAL
========================= */

app.post("/api/ai", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const context = req.body.context || {};

    const texto = message.toLowerCase();

    let resposta = "";

    if (!message) {
      resposta =
        "Estou ouvindo. Diga o que você precisa.";
    }

    else if (
      texto.includes("olá") ||
      texto.includes("ola") ||
      texto.includes("oi") ||
      texto.includes("bom dia") ||
      texto.includes("boa tarde") ||
      texto.includes("boa noite")
    ) {
      resposta =
        "Olá. Eu sou o PRIMORIS. Estou funcionando em modo local e pronto para ajudar.";
    }

    else if (
      texto.includes("agenda") ||
      texto.includes("compromisso") ||
      texto.includes("compromissos") ||
      texto.includes("calendário") ||
      texto.includes("calendario")
    ) {
      const eventos = Array.isArray(context.calendar)
        ? context.calendar
        : [];

      if (eventos.length === 0) {
        resposta =
          "Não encontrei compromissos próximos na agenda.";
      } else {
        resposta =
          "Seus próximos compromissos:\n\n" +
          eventos
            .slice(0, 8)
            .map((evento, i) => {
              const nome =
                evento.summary || "Sem título";

              const inicio =
                evento.start?.dateTime ||
                evento.start?.date ||
                "";

              return `${i + 1}. ${nome}${inicio ? " • " + inicio : ""}`;
            })
            .join("\n");
      }
    }

    else if (
      texto.includes("tarefa") ||
      texto.includes("tarefas")
    ) {
      const tarefas = Array.isArray(context.tasks)
        ? context.tasks
        : [];

      if (tarefas.length === 0) {
        resposta =
          "Você não possui tarefas cadastradas no momento.";
      } else {
        resposta =
          "Suas tarefas:\n\n" +
          tarefas
            .slice(0, 10)
            .map((tarefa, i) => {
              const titulo =
                tarefa.title ||
                tarefa.nome ||
                tarefa.name ||
                "Tarefa sem nome";

              return `${i + 1}. ${titulo}`;
            })
            .join("\n");
      }
    }

    else if (
      texto.includes("estudo") ||
      texto.includes("estudar") ||
      texto.includes("estudos")
    ) {
      const estudos = Array.isArray(context.studies)
        ? context.studies
        : [];

      if (estudos.length === 0) {
        resposta =
          "Ainda não encontrei sessões de estudo cadastradas.";
      } else {
        resposta =
          "Seus estudos:\n\n" +
          estudos
            .slice(0, 10)
            .map((estudo, i) => {
              const nome =
                estudo.title ||
                estudo.subject ||
                estudo.nome ||
                "Estudo";

              return `${i + 1}. ${nome}`;
            })
            .join("\n");
      }
    }

    else if (
      texto.includes("memória") ||
      texto.includes("memoria")
    ) {
      resposta =
        "A memória do PRIMORIS fica armazenada localmente no dispositivo. Posso usar essas informações para contextualizar suas respostas.";
    }

    else if (
      texto.includes("quem é você") ||
      texto.includes("quem e voce") ||
      texto.includes("quem você é") ||
      texto.includes("quem voce e")
    ) {
      resposta =
        "Eu sou o PRIMORIS, seu assistente pessoal. Nesta versão, minha inteligência funciona localmente, sem depender de uma API externa.";
    }

    else if (
      texto.includes("ajuda") ||
      texto.includes("o que você faz") ||
      texto.includes("o que voce faz")
    ) {
      resposta =
        "Posso consultar sua agenda, tarefas e estudos, além de organizar informações e responder comandos relacionados ao PRIMORIS.";
    }

    else {
      resposta =
        "Entendi: \"" +
        message +
        "\"\n\n" +
        "Ainda estou aprendendo a lidar com esse tipo de comando no modo local. Posso trabalhar melhor com agenda, tarefas, estudos, memória e organização pessoal.";
    }

    res.json({
      text: resposta,
      mode: "local"
    });

  } catch (error) {
    console.error("Erro IA local:", error);

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
   FALLBACK
========================= */

app.use((req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

/* =========================
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `PRIMORIS iniciado com sucesso na porta ${PORT}`
  );
});

process.on("uncaughtException", error => {
  console.error(
    "ERRO NÃO CAPTURADO:",
    error
  );
});

process.on("unhandledRejection", error => {
  console.error(
    "PROMISE NÃO TRATADA:",
    error
  );
});
