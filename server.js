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

/* =========================================================
   FUNÇÕES AUXILIARES
========================================================= */

function escolher(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

function normalizar(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function horaAtual() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

function dataAtual() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date());
}

function listaBonita(lista, limite = 8) {
  return lista
    .slice(0, limite)
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

/* =========================================================
   STATUS
========================================================= */

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    calendar: !!req.session.tokens,
    ai: true,
    mode: "local"
  });
});

/* =========================================================
   GOOGLE CALENDAR
========================================================= */

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
      return res
        .status(400)
        .send("Código de autorização não recebido.");
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

/* =========================================================
   IA LOCAL
========================================================= */

app.post("/api/ai", async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const context = req.body.context || {};

    const texto = normalizar(message);

    let resposta = "";

    /* =========================
       SAUDAÇÕES
    ========================= */

    if (
      /^(oi|ola|e ai|eae|opa|hey|hello)$/.test(texto) ||
      texto.includes("bom dia") ||
      texto.includes("boa tarde") ||
      texto.includes("boa noite")
    ) {
      resposta = escolher([
        "Olá. PRIMORIS online. Como posso ajudar?",
        "Olá! Estou pronto para organizar seu dia.",
        "Olá. Tudo funcionando por aqui.",
        "Oi! O PRIMORIS está à disposição.",
        "Olá! Vamos cuidar das suas tarefas e agenda.",
        "Sistema ativo. Pode mandar.",
        "Olá! Estou pronto para receber seu próximo comando."
      ]);
    }

    /* =========================
       COMO ESTÁ / STATUS
    ========================= */

    else if (
      texto.includes("como voce esta") ||
      texto.includes("como voce ta") ||
      texto.includes("tudo bem") ||
      texto.includes("como esta")
    ) {
      resposta = escolher([
        "Tudo funcionando normalmente por aqui.",
        "Operacional. Agenda e recursos locais disponíveis.",
        "Estou funcionando normalmente.",
        "Sistema estável e pronto para trabalhar.",
        "Tudo certo por aqui."
      ]);
    }

    /* =========================
       HORA
    ========================= */

    else if (
      texto.includes("que horas") ||
      texto.includes("qual a hora") ||
      texto.includes("hora agora") ||
      texto.includes("horas agora")
    ) {
      resposta =
        `Agora são ${horaAtual()}.`;

    }

    /* =========================
       DATA
    ========================= */

    else if (
      texto.includes("que dia e hoje") ||
      texto.includes("qual a data") ||
      texto.includes("data de hoje") ||
      texto.includes("hoje e que dia")
    ) {
      resposta =
        `Hoje é ${dataAtual()}.`;
    }

    /* =========================
       AGENDA
    ========================= */

    else if (
      texto.includes("agenda") ||
      texto.includes("compromisso") ||
      texto.includes("compromissos") ||
      texto.includes("calendario") ||
      texto.includes("calendario") ||
      texto.includes("tenho algo marcado") ||
      texto.includes("o que tenho hoje") ||
      texto.includes("o que tem hoje")
    ) {
      const eventos = Array.isArray(context.calendar)
        ? context.calendar
        : [];

      if (eventos.length === 0) {
        resposta = escolher([
          "Sua agenda não tem compromissos próximos registrados.",
          "Não encontrei compromissos próximos na agenda.",
          "Por enquanto, sua agenda está livre.",
          "Não há eventos próximos que eu consiga encontrar."
        ]);
      } else {

        const nomes = eventos.slice(0, 8).map(evento => {
          const nome =
            evento.summary ||
            evento.title ||
            "Compromisso sem título";

          const inicio =
            evento.start?.dateTime ||
            evento.start?.date ||
            "";

          let horario = "";

          if (inicio.includes("T")) {
            horario = new Date(inicio).toLocaleTimeString(
              "pt-BR",
              {
                hour: "2-digit",
                minute: "2-digit"
              }
            );
          }

          return horario
            ? `${nome} • ${horario}`
            : nome;
        });

        resposta =
          escolher([
            "Encontrei estes compromissos:",
            "Aqui está sua agenda próxima:",
            "Estes são os eventos que encontrei:",
            "Sua agenda está assim:",
            "Confira seus próximos compromissos:"
          ]) +
          "\n\n" +
          listaBonita(nomes);
      }
    }

    /* =========================
       TAREFAS
    ========================= */

    else if (
      texto.includes("tarefa") ||
      texto.includes("tarefas") ||
      texto.includes("pendencia") ||
      texto.includes("pendencias") ||
      texto.includes("o que preciso fazer") ||
      texto.includes("o que tenho para fazer")
    ) {
      const tarefas = Array.isArray(context.tasks)
        ? context.tasks
        : [];

      if (tarefas.length === 0) {
        resposta = escolher([
          "Você não tem tarefas cadastradas no momento.",
          "Não encontrei tarefas pendentes.",
          "Sua lista de tarefas está vazia.",
          "Por enquanto, nenhuma tarefa cadastrada."
        ]);
      } else {

        const nomes = tarefas.slice(0, 10).map(tarefa => {
          return (
            tarefa.title ||
            tarefa.nome ||
            tarefa.name ||
            "Tarefa sem nome"
          );
        });

        resposta =
          escolher([
            "Estas são suas tarefas:",
            "Encontrei estas tarefas:",
            "Aqui está sua lista:",
            "Suas tarefas atuais são:",
            "Confira o que está pendente:"
          ]) +
          "\n\n" +
          listaBonita(nomes, 10);
      }
    }

    /* =========================
       ESTUDOS
    ========================= */

    else if (
      texto.includes("estudo") ||
      texto.includes("estudar") ||
      texto.includes("estudos") ||
      texto.includes("materia") ||
      texto.includes("materias")
    ) {
      const estudos = Array.isArray(context.studies)
        ? context.studies
        : [];

      if (estudos.length === 0) {
        resposta = escolher([
          "Não encontrei sessões de estudo cadastradas.",
          "Você ainda não tem estudos registrados.",
          "Não há sessões de estudo salvas no momento.",
          "Sua área de estudos está sem registros."
        ]);
      } else {

        const nomes = estudos.slice(0, 10).map(estudo => {
          return (
            estudo.title ||
            estudo.subject ||
            estudo.nome ||
            "Sessão de estudo"
          );
        });

        resposta =
          escolher([
            "Confira seus estudos:",
            "Estas são suas sessões de estudo:",
            "Encontrei estes estudos:",
            "Sua programação de estudos contém:",
            "Aqui estão seus estudos:"
          ]) +
          "\n\n" +
          listaBonita(nomes, 10);
      }
    }

    /* =========================
       MEMÓRIA
    ========================= */

    else if (
      texto.includes("memoria") ||
      texto.includes("lembranca") ||
      texto.includes("o que voce lembra")
    ) {
      resposta = escolher([
        "Minha memória local usa as informações que o PRIMORIS mantém salvas no dispositivo.",
        "Posso utilizar os dados armazenados pelo PRIMORIS para manter contexto.",
        "As informações salvas localmente podem ser usadas para contextualizar suas respostas.",
        "A memória do PRIMORIS funciona localmente neste dispositivo."
      ]);
    }

    /* =========================
       QUEM É O PRIMORIS
    ========================= */

    else if (
      texto.includes("quem e voce") ||
      texto.includes("o que e voce") ||
      texto.includes("o que voce e") ||
      texto.includes("quem e o primoris")
    ) {
      resposta = escolher([
        "Eu sou o PRIMORIS, seu assistente pessoal.",
        "Sou o PRIMORIS, responsável por ajudar na sua organização.",
        "PRIMORIS. Um assistente pessoal integrado à sua agenda e às suas ferramentas.",
        "Sou seu assistente pessoal dentro deste sistema."
      ]);
    }

    /* =========================
       CAPACIDADES
    ========================= */

    else if (
      texto.includes("o que voce consegue fazer") ||
      texto.includes("o que voce pode fazer") ||
      texto.includes("quais suas funcoes") ||
      texto.includes("como voce pode ajudar")
    ) {
      resposta =
        "Posso ajudar com agenda, tarefas, estudos, organização, informações salvas e comandos relacionados ao PRIMORIS. Também posso consultar os eventos do seu Google Calendar quando ele estiver conectado.";
    }

    /* =========================
       AGRADECIMENTO
    ========================= */

    else if (
      texto.includes("obrigado") ||
      texto.includes("obrigada") ||
      texto.includes("valeu") ||
      texto.includes("agradeco")
    ) {
      resposta = escolher([
        "Disponha.",
        "Por nada.",
        "Sempre que precisar.",
        "Serviço concluído.",
        "Disponha. Mais uma tarefa resolvida.",
        "Sem problemas."
      ]);
    }

    /* =========================
       DESPEDIDA
    ========================= */

    else if (
      texto.includes("tchau") ||
      texto.includes("ate mais") ||
      texto.includes("ate depois") ||
      texto.includes("vou dormir")
    ) {
      resposta = escolher([
        "Até mais.",
        "Até depois. O PRIMORIS continuará aqui.",
        "Até a próxima.",
        "Encerrando por enquanto. Até mais.",
        "Boa noite. Descanse."
      ]);
    }

    /* =========================
       MOTIVAÇÃO
    ========================= */

    else if (
      texto.includes("me motive") ||
      texto.includes("motivacao") ||
      texto.includes("estou desanimado") ||
      texto.includes("to desanimado")
    ) {
      resposta = escolher([
        "Faça uma coisa de cada vez. Consistência costuma vencer a pressa.",
        "Comece pela menor tarefa possível. Depois avance para a próxima.",
        "Você não precisa resolver tudo agora. Precisa apenas começar.",
        "Organize o próximo passo, execute e depois pense no seguinte.",
        "Um progresso pequeno ainda é progresso."
      ]);
    }

    /* =========================
       ORGANIZAÇÃO
    ========================= */

    else if (
      texto.includes("me ajude a organizar") ||
      texto.includes("organizar meu dia") ||
      texto.includes("organize meu dia") ||
      texto.includes("planejar meu dia")
    ) {
      resposta =
        "Uma boa ordem é: primeiro compromissos com horário definido, depois tarefas importantes e, por último, estudos ou atividades flexíveis.";
    }

    /* =========================
       PERGUNTAS SOBRE O SISTEMA
    ========================= */

    else if (
      texto.includes("voce esta online") ||
      texto.includes("esta funcionando") ||
      texto.includes("sistema funcionando")
    ) {
      resposta =
        "Sim. O PRIMORIS está funcionando em modo local.";

    }

    /* =========================
       COMANDO DESCONHECIDO
    ========================= */

    else {
      resposta = escolher([
        `Entendi: "${message}". Ainda estou aprendendo a interpretar esse tipo de comando no modo local.`,
        `Recebi sua mensagem: "${message}". Posso trabalhar melhor com agenda, tarefas, estudos e organização.`,
        `"${message}" foi recebido. Ainda não tenho uma ação específica para esse comando.`,
        `Entendi o que você escreveu. No momento, consigo ajudar principalmente com agenda, tarefas, estudos e organização.`,
        `Comando recebido. Minha versão local ainda não reconhece essa solicitação específica.`
      ]);
    }

    res.json({
      text: resposta,
      mode: "local"
    });

  } catch (error) {

    console.error(
      "Erro IA local:",
      error
    );

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================================================
   GOOGLE NEWS
========================================================= */

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

      const feed =
        await parser.parseURL(url);

      for (
        const article of
        (feed.items || []).slice(0, 5)
      ) {

        items.push({
          title:
            article.title ||
            "Notícia",

          link:
            article.link ||
            "",

          source:
            article.creator ||
            "Google News",

          category:
            item.category,

          date:
            article.pubDate ||
            ""
        });
      }
    }

    res.json({
      items
    });

  } catch (error) {

    console.error(
      "Erro notícias:",
      error
    );

    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================================================
   FALLBACK
========================================================= */

app.use((req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      "index.html"
    )
  );
});

/* =========================================================
   SERVIDOR
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `PRIMORIS iniciado com sucesso na porta ${PORT}`
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "ERRO NÃO CAPTURADO:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "PROMISE NÃO TRATADA:",
      error
    );
  }
);
