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
// MODO DESENVOLVEDOR DA IA
// =====================================================
// A IA pode propor e aplicar alterações controladas no código do PRIMORIS.
// Para ativar no Render, defina PRIMORIS_DEV_KEY nas variáveis de ambiente.
// A chave nunca deve ser colocada no HTML nem enviada ao Gemini.

const fs = require("fs");
const { execFileSync } = require("child_process");

const DEV_ALLOWED_FILES = new Set([
  "index.html",
  "server.js",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg"
]);

function devKeyIsValid(req) {
  const expected = String(process.env.PRIMORIS_DEV_KEY || "");
  const received = String(req.headers["x-dev-key"] || "");
  return !!expected && received === expected;
}

function devFilePath(file) {
  if (!DEV_ALLOWED_FILES.has(file)) throw new Error("Arquivo não permitido: " + file);
  return path.join(__dirname, file);
}

function validateDevContent(file, content) {
  if (typeof content !== "string") throw new Error("Conteúdo inválido.");
  if (content.length > 600000) throw new Error("Arquivo maior que o limite de segurança.");

  if (file === "server.js") {
    const tmp = path.join(__dirname, ".primoris-server-check.js");
    try {
      fs.writeFileSync(tmp, content, "utf8");
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe", timeout: 10000 });
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  if (file === "index.html" && !/<html[\s>]/i.test(content)) {
    throw new Error("O index.html não parece ser um HTML válido.");
  }
}

function listDevBackups() {
  const backups = path.join(__dirname, ".primoris-backups");
  if (!fs.existsSync(backups)) return [];
  return fs.readdirSync(backups, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => {
      const dir = path.join(backups, x.name);
      const stat = fs.statSync(dir);
      const files = fs.readdirSync(dir).filter(f => DEV_ALLOWED_FILES.has(f));
      let request = "";
      try { request = fs.readFileSync(path.join(dir, "request.txt"), "utf8").slice(0, 500); } catch {}
      return { id: x.name, createdAt: stat.mtime.toISOString(), files, request };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function restoreDevBackup(id) {
  if (!/^[0-9TZ._-]+$/.test(id)) throw new Error("Backup inválido.");
  const backupDir = path.join(__dirname, ".primoris-backups", id);
  if (!fs.existsSync(backupDir)) throw new Error("Backup não encontrado.");
  const available = fs.readdirSync(backupDir).filter(f => DEV_ALLOWED_FILES.has(f));
  if (!available.length) throw new Error("Backup sem arquivos restauráveis.");

  const rollbackDir = path.join(__dirname, ".primoris-backups", "rollback-" + new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(rollbackDir, { recursive: true });
  for (const file of available) {
    const full = devFilePath(file);
    if (fs.existsSync(full)) fs.copyFileSync(full, path.join(rollbackDir, file));
  }
  for (const file of available) fs.copyFileSync(path.join(backupDir, file), devFilePath(file));
  fs.writeFileSync(path.join(rollbackDir, "request.txt"), "Estado salvo automaticamente antes da restauração de " + id, "utf8");
  return { restored: available, safetyBackup: path.basename(rollbackDir) };
}

app.get("/api/dev/history", (req, res) => {
  try {
    if (!devKeyIsValid(req)) return res.status(401).json({ error: "dev_unauthorized" });
    res.json({ ok: true, backups: listDevBackups().slice(0, 10) });
  } catch (e) { res.status(400).json({ error: "dev_history_failed", details: e.message }); }
});

app.post("/api/dev/undo", (req, res) => {
  try {
    if (!devKeyIsValid(req)) return res.status(401).json({ error: "dev_unauthorized" });
    const history = listDevBackups();
    if (!history.length) return res.status(404).json({ error: "dev_no_backup" });
    const target = history[0];
    const result = restoreDevBackup(target.id);
    res.json({ ok: true, backup: target.id, restored: result.restored, safetyBackup: result.safetyBackup });
  } catch (e) { console.error("Dev undo:", e); res.status(400).json({ error: "dev_undo_failed", details: e.message }); }
});

app.post("/api/dev/restore", (req, res) => {
  try {
    if (!devKeyIsValid(req)) return res.status(401).json({ error: "dev_unauthorized" });
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ error: "backup_required" });
    const result = restoreDevBackup(id);
    res.json({ ok: true, backup: id, restored: result.restored, safetyBackup: result.safetyBackup });
  } catch (e) { console.error("Dev restore:", e); res.status(400).json({ error: "dev_restore_failed", details: e.message }); }
});

app.get("/api/dev/status", (req, res) => {
  res.json({
    enabled: !!process.env.PRIMORIS_DEV_KEY,
    authenticated: devKeyIsValid(req),
    allowedFiles: Array.from(DEV_ALLOWED_FILES)
  });
});

app.post("/api/dev/edit", async (req, res) => {
  try {
    if (!devKeyIsValid(req)) {
      return res.status(401).json({ error: "dev_unauthorized", details: "Modo desenvolvedor não autorizado." });
    }

    const request = String(req.body?.request || "").trim();
    if (!request) return res.status(400).json({ error: "request_required" });
    if (request.length > 3000) return res.status(400).json({ error: "request_too_long" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "gemini_not_configured" });

    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const files = {};
    for (const file of DEV_ALLOWED_FILES) {
      const full = devFilePath(file);
      if (fs.existsSync(full)) files[file] = fs.readFileSync(full, "utf8");
    }

    const prompt = `
Você é o engenheiro de software do PRIMORIS.
O usuário autorizou uma alteração no próprio site.

PEDIDO DO USUÁRIO:
${request}

ARQUIVOS ATUAIS:
${JSON.stringify(files)}

REGRAS:
- Trabalhe somente nos arquivos permitidos.
- Não apague funcionalidades existentes sem necessidade.
- Preserve botões, formulários, voz, agenda, memória, finanças, notícias e IA já existentes.
- Faça a menor alteração necessária para cumprir o pedido.
- Retorne SOMENTE JSON válido, sem markdown.
- Formato exato:
{"summary":"resumo curto","operations":[{"file":"index.html","find":"texto exato existente","replace":"novo texto"}]}
- Cada operação deve ter file, find e replace.
- 'find' precisa existir exatamente no arquivo atual e ser suficientemente específico.
- Máximo de 12 operações.
- Não use operações para arquivos que não precisem mudar.
- Nunca coloque segredos, chaves de API ou senhas no HTML.
`;

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 12000, responseMimeType: "application/json" }
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: "dev_gemini_failed", details: body?.error?.message || "Falha ao gerar alteração." });

    const raw = body?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!raw) return res.status(502).json({ error: "dev_empty_response" });

    let plan;
    try { plan = JSON.parse(raw); } catch { return res.status(502).json({ error: "dev_invalid_plan", details: "A IA não retornou um plano JSON válido." }); }

    if (!plan || !Array.isArray(plan.operations) || plan.operations.length > 12) {
      return res.status(422).json({ error: "dev_invalid_operations" });
    }

    const backups = path.join(__dirname, ".primoris-backups");
    fs.mkdirSync(backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(backups, stamp);
    fs.mkdirSync(backupDir, { recursive: true });

    const changed = [];
    const prepared = new Map();
    for (const op of plan.operations) {
      if (!op || !DEV_ALLOWED_FILES.has(op.file)) throw new Error("Arquivo não permitido na operação.");
      if (typeof op.find !== "string" || typeof op.replace !== "string" || !op.find) throw new Error("Operação inválida.");
      if (op.find.length > 20000 || op.replace.length > 40000) throw new Error("Operação grande demais.");

      const full = devFilePath(op.file);
      if (!fs.existsSync(full)) throw new Error("Arquivo não encontrado: " + op.file);
      const current = prepared.has(op.file) ? prepared.get(op.file) : fs.readFileSync(full, "utf8");
      const occurrences = current.split(op.find).length - 1;
      if (occurrences !== 1) throw new Error(`O trecho de ${op.file} não foi encontrado de forma única (${occurrences} ocorrências).`);
      const next = current.replace(op.find, op.replace);
      prepared.set(op.file, next);
    }

    for (const [file, next] of prepared.entries()) {
      validateDevContent(file, next);
    }

    for (const [file, next] of prepared.entries()) {
      const full = devFilePath(file);
      fs.copyFileSync(full, path.join(backupDir, file));
      fs.writeFileSync(full, next, "utf8");
      changed.push(file);
    }

    fs.writeFileSync(path.join(backupDir, "request.txt"), request, "utf8");
    fs.writeFileSync(path.join(backupDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");

    res.json({
      ok: true,
      summary: String(plan.summary || "Alteração aplicada."),
      changed: Array.from(new Set(changed)),
      backup: ".primoris-backups/" + stamp,
      note: "A alteração foi aplicada no servidor atual. Para permanecer após novo deploy, publique os arquivos alterados no repositório de origem."
    });
  } catch (e) {
    console.error("Modo desenvolvedor:", e);
    res.status(400).json({ error: "dev_edit_failed", details: e.message });
  }
});


// =====================================================
// GROQ CLOUD - PROVEDOR ADICIONAL COM PLANO GRATUITO
// =====================================================
async function chamarGroq(payload) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  if (!apiKey) return { ok:false, status:503, body:{error:{message:"GROQ_API_KEY não está configurada no servidor."}}, model };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+apiKey},
      signal:controller.signal,
      body:JSON.stringify({...payload, model})
    });
    const body = await response.json().catch(()=>({}));
    return {ok:response.ok,status:response.status,body,model};
  } catch(e) {
    return {ok:false,status:e.name==="AbortError"?504:502,body:{error:{message:e.name==="AbortError"?"Groq excedeu 30 segundos.":e.message}},model};
  } finally { clearTimeout(timeout); }
}

// OpenAI oficial: usa as variáveis já existentes no Render.
async function chamarOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return { ok:false, status:503, body:{error:{message:"OPENAI_API_KEY não está configurada no servidor."}}, model };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json", "Authorization":"Bearer "+apiKey},
      signal:controller.signal,
      body:JSON.stringify({...payload, model})
    });
    const body = await response.json().catch(()=>({}));
    return {ok:response.ok,status:response.status,body,model};
  } catch(e) {
    return {ok:false,status:e.name==="AbortError"?504:502,body:{error:{message:e.name==="AbortError"?"OpenAI excedeu 30 segundos.":e.message}},model};
  } finally { clearTimeout(timeout); }
}

function providerConfigured(provider) {
  return provider==="openai" ? !!process.env.OPENAI_API_KEY :
    provider==="gemini" ? !!process.env.GEMINI_API_KEY :
    provider==="groq" ? !!process.env.GROQ_API_KEY :
    provider==="openrouter" ? !!process.env.OPENROUTER_API_KEY : false;
}
function providerModel(provider) {
  return provider==="openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini") :
    provider==="gemini" ? (process.env.GEMINI_MODEL || "gemini-3.8-flash") :
    provider==="groq" ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b") :
    (process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free");
}
function extractProviderText(value, depth=0) {
  if (depth>5 || value==null) return "";
  if (typeof value==="string") return value.trim();
  if (Array.isArray(value)) return value.map(item=>extractProviderText(item,depth+1)).filter(Boolean).join("\n").trim();
  if (typeof value==="object") {
    // Alguns modelos do OpenRouter devolvem content como objeto/partes,
    // em vez de uma string simples. Extraímos somente campos de texto final.
    for (const key of ["text","output_text","content","parts","value"]) {
      if (value[key]!==undefined) {
        const extracted=extractProviderText(value[key],depth+1);
        if (extracted) return extracted;
      }
    }
  }
  return "";
}
async function callTextProvider(provider, prompt, maxTokens=900) {
  if (!providerConfigured(provider)) return {ok:false,status:503,provider,model:providerModel(provider),body:{error:{message:provider.toUpperCase()+"_API_KEY não configurada."}}};
  if (provider==="gemini") {
    const r=await chamarGeminiTexto(prompt,providerModel(provider));
    const text=extractProviderText(r.body?.candidates?.[0]?.content?.parts).trim();
    return {...r,provider,text};
  }
  const payload={messages:[
    {role:"system",content:"Você é o PRIMORIS, assistente pessoal em português do Brasil. Seja natural, atencioso e preciso. Nunca diga que executou algo sem confirmação."},
    {role:"user",content:prompt}
  ],temperature:0.35,max_tokens:maxTokens};
  const r=provider==="openai" ? await chamarOpenAI(payload) :
    provider==="groq" ? await chamarGroq(payload) : await chamarOpenRouter(payload,1);
  const content=r.body?.choices?.[0]?.message?.content;
  const text=extractProviderText(content);
  return {...r,provider,text};
}
function providerOrder(requested) {
  const all=["openai","openrouter","gemini","groq"];
  // Um provedor escolhido pelo usuário deve ser usado sozinho. Fallback entre
  // provedores acontece somente quando o usuário seleciona o modo automático.
  if(requested==="auto") return all.filter(providerConfigured);
  return all.includes(requested) ? [requested] : [];
}

// =====================================================
// STATUS
// =====================================================

app.get("/api/status", (req, res) => {
  const requested=String(req.query.provider||"").toLowerCase();
  const chosen=["openai","openrouter","gemini","groq","auto"].includes(requested)?requested:"openai";
  const names={openai:"OpenAI",openrouter:"OpenRouter",gemini:"Google Gemini",groq:"Groq"};
  res.json({
    ok:true, calendar:!!req.session.tokens, gmail:!!req.session.gmailConnected,
    ai:["openai","openrouter","gemini","groq"].some(providerConfigured),
    aiProvider:chosen==="auto"?"Automático":(names[chosen]||"OpenRouter"),
    aiModel:chosen==="auto"?"Fallback automático":providerModel(chosen),
    providers:{
      openai:{available:providerConfigured("openai"),model:providerModel("openai")},
      openrouter:{available:providerConfigured("openrouter"),model:providerModel("openrouter")},
      gemini:{available:providerConfigured("gemini"),model:providerModel("gemini")},
      groq:{available:providerConfigured("groq"),model:providerModel("groq")}
    }
  });
});

// Teste real dos provedores. No modo automático, testa em paralelo para
// que um provedor lento não esconda o resultado dos outros.
app.post("/api/ai/test", async (req,res)=>{
  const requested=String(req.body?.provider||"openrouter").toLowerCase();
  const allowed=["openai","openrouter","gemini","groq"];
  const providers=requested==="auto"?allowed:[requested];
  const results=await Promise.all(providers.filter(p=>allowed.includes(p)).map(async provider=>{
    if(!providerConfigured(provider)){
      return {provider,ok:false,status:503,model:providerModel(provider),elapsedMs:0,error:provider.toUpperCase()+"_API_KEY não está configurada no servidor.",errorCode:"provider_not_configured",text:""};
    }
    const started=Date.now();
    try{
      const r=await callTextProvider(provider,"Responda exatamente: PRIMORIS "+provider.toUpperCase()+" OK",800);
      const hasText=typeof r.text==="string"&&r.text.trim().length>0;
      const ok=!!r.ok&&hasText;
      const error=ok?null:(r.body?.error?.message||r.body?.message||(r.ok?"A API respondeu, mas não retornou texto.":"Falha na API sem mensagem de erro."));
      console.log("Teste IA "+provider+": HTTP "+(r.status||200)+" | ok="+ok+" | modelo="+(r.model||providerModel(provider))+(error?" | erro="+error:""));
      return {
        provider,ok,status:r.status||200,model:r.model||providerModel(provider),
        elapsedMs:Date.now()-started,error,
        errorCode:r.body?.error?.code||r.body?.error?.type||null,
        responseInfo:provider==="openrouter"?{
          choices:Array.isArray(r.body?.choices)?r.body.choices.length:0,
          finishReason:r.body?.choices?.[0]?.finish_reason||null,
          contentType:Array.isArray(r.body?.choices?.[0]?.message?.content)?"array":typeof r.body?.choices?.[0]?.message?.content,
          contentKeys:r.body?.choices?.[0]?.message?.content&&typeof r.body.choices[0].message.content==="object"?Object.keys(r.body.choices[0].message.content).slice(0,12):[],
          responseId:r.body?.id||null
        }:undefined,
        text:hasText?r.text.trim():""
      };
    }catch(e){
      const error=e?.message||"Falha inesperada ao testar o provedor.";
      console.error("Teste IA "+provider+": erro | "+error);
      return {provider,ok:false,status:e?.name==="AbortError"?504:502,model:providerModel(provider),elapsedMs:Date.now()-started,error,errorCode:e?.name||"provider_test_error",text:""};
    }
  }));
  const first=results.find(x=>x.ok);
  res.status(first?200:502).json({ok:!!first,provider:first?.provider||null,results});
});

// =====================================================
// GOOGLE OAUTH
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
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose"
      ]
    })
  );
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const o = oauth();

    const { tokens } = await o.getToken(req.query.code);

    req.session.tokens = tokens;
    req.session.gmailConnected = true;

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
  req.session.gmailConnected = false;
  res.redirect("/");
});

// =====================================================
// GMAIL
// =====================================================
function gmailClient(req) {
  if (!req.session.tokens) return null;
  const o = oauth();
  o.setCredentials(req.session.tokens);
  return google.gmail({ version: "v1", auth: o });
}
function gmailHeader(headers, name) {
  const h = (headers || []).find(x => String(x.name || "").toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}
function decodeBase64Url(value) {
  if (!value) return "";
  try { return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}

app.get("/api/gmail/messages", async (req, res) => {
  try {
    const gmail = gmailClient(req);
    if (!gmail) return res.status(401).json({ error: "gmail_not_connected", details: "Conecte sua conta Google novamente para liberar o Gmail." });
    const max = Math.min(Math.max(Number(req.query.max) || 10, 1), 20);
    const q = String(req.query.q || "").slice(0, 200);
    const list = await gmail.users.messages.list({ userId: "me", maxResults: max, q: q || undefined });
    const messages = [];
    for (const item of (list.data.messages || []).slice(0, max)) {
      const full = await gmail.users.messages.get({ userId: "me", id: item.id, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
      const payload = full.data.payload || {};
      messages.push({
        id: item.id,
        subject: gmailHeader(payload.headers, "Subject"),
        from: gmailHeader(payload.headers, "From"),
        date: gmailHeader(payload.headers, "Date"),
        snippet: full.data.snippet || ""
      });
    }
    res.json({ ok: true, messages });
  } catch (e) {
    console.error("Gmail messages:", e);
    res.status(502).json({ error: "gmail_request_failed", details: e.message || "Falha ao consultar Gmail." });
  }
});

function makeRawEmail({ to, subject, body }) {
  const safe = String(body || "").replace(/\r?\n/g, "\r\n");
  const raw = [
    `To: ${String(to).trim()}`,
    `Subject: ${String(subject).trim()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    safe
  ].join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

app.post("/api/gmail/draft", async (req, res) => {
  try {
    const gmail = gmailClient(req);
    if (!gmail) return res.status(401).json({ error: "gmail_not_connected", details: "Conecte sua conta Google para criar rascunhos." });
    const to = String(req.body?.to || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!to || !subject || !body) return res.status(400).json({ error: "draft_fields_required", details: "Informe destinatário, assunto e mensagem." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "invalid_email", details: "O endereço de e-mail não parece válido." });
    const draft = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: makeRawEmail({ to, subject, body }) } } });
    res.json({ ok: true, draftId: draft.data.id });
  } catch (e) {
    console.error("Gmail draft:", e);
    res.status(502).json({ error: "gmail_draft_failed", details: e.message || "Falha ao criar rascunho." });
  }
});

// =====================================================
// GOOGLE CALENDAR CLIENT
// =====================================================

function calendarClient(req) {
  if (!req.session.tokens) {
    return null;
  }

  const o = oauth();

  o.setCredentials(req.session.tokens);

  return google.calendar({
    version: "v3",
    auth: o
  });
}

// =====================================================
// LISTAR EVENTOS
// =====================================================

app.get("/api/calendar/events", async (req, res) => {
  try {
    const c = calendarClient(req);

    if (!c) {
      return res.status(401).json({
        error: "not_connected",
        message: "Google Calendar não está conectado."
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
    console.error("Calendar events:", e);

    res.status(500).json({
      error: "calendar_error",
      message: e.message
    });
  }
});

// =====================================================
// CRIAR COMPROMISSO
// =====================================================

app.post("/api/calendar/create", async (req, res) => {
  try {
    const c = calendarClient(req);

    if (!c) {
      return res.status(401).json({
        error: "not_connected",
        message: "Google Calendar não está conectado."
      });
    }

    const {
      summary,
      description,
      location,
      start,
      end,
      allDay
    } = req.body || {};

    if (!summary) {
      return res.status(400).json({
        error: "summary_required",
        message: "O título do compromisso é obrigatório."
      });
    }

    if (!start) {
      return res.status(400).json({
        error: "start_required",
        message: "A data/horário inicial é obrigatório."
      });
    }

    const evento = {
      summary: String(summary),
      description: description
        ? String(description)
        : undefined,
      location: location
        ? String(location)
        : undefined
    };

    if (allDay) {
      evento.start = {
        date: String(start).slice(0, 10)
      };

      evento.end = {
        date: String(end || start).slice(0, 10)
      };

    } else {
      if (!end) {
        return res.status(400).json({
          error: "end_required",
          message:
            "O horário final é obrigatório para eventos com horário."
        });
      }

      evento.start = {
        dateTime: new Date(start).toISOString()
      };

      evento.end = {
        dateTime: new Date(end).toISOString()
      };
    }

    const criado = await c.events.insert({
      calendarId: "primary",
      requestBody: evento
    });

    console.log(
      "Evento criado:",
      criado.data.id
    );

    res.json({
      ok: true,
      event: criado.data
    });

  } catch (e) {
    console.error(
      "Erro ao criar evento:",
      e
    );

    res.status(500).json({
      error: "calendar_create_error",
      message: e.message
    });
  }
});

// =====================================================
// EDITAR COMPROMISSO
// =====================================================

app.put("/api/calendar/edit/:eventId", async (req, res) => {
  try {
    const c = calendarClient(req);

    if (!c) {
      return res.status(401).json({
        error: "not_connected",
        message: "Google Calendar não está conectado."
      });
    }

    const eventId = req.params.eventId;

    if (!eventId) {
      return res.status(400).json({
        error: "event_id_required",
        message: "ID do evento não informado."
      });
    }

    const {
      summary,
      description,
      location,
      start,
      end,
      allDay
    } = req.body || {};

    const evento = {};

    if (summary !== undefined) {
      evento.summary = String(summary);
    }

    if (description !== undefined) {
      evento.description = String(description);
    }

    if (location !== undefined) {
      evento.location = String(location);
    }

    if (start) {
      if (allDay) {
        evento.start = {
          date: String(start).slice(0, 10)
        };
      } else {
        evento.start = {
          dateTime: new Date(start).toISOString()
        };
      }
    }

    if (end) {
      if (allDay) {
        evento.end = {
          date: String(end).slice(0, 10)
        };
      } else {
        evento.end = {
          dateTime: new Date(end).toISOString()
        };
      }
    }

    const atualizado = await c.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: evento
    });

    console.log(
      "Evento atualizado:",
      atualizado.data.id
    );

    res.json({
      ok: true,
      event: atualizado.data
    });

  } catch (e) {
    console.error(
      "Erro ao editar evento:",
      e
    );

    res.status(500).json({
      error: "calendar_edit_error",
      message: e.message
    });
  }
});

// =====================================================
// EXCLUIR COMPROMISSO
// =====================================================

app.delete(
  "/api/calendar/delete/:eventId",
  async (req, res) => {
    try {
      const c = calendarClient(req);

      if (!c) {
        return res.status(401).json({
          error: "not_connected",
          message:
            "Google Calendar não está conectado."
        });
      }

      const eventId = req.params.eventId;

      if (!eventId) {
        return res.status(400).json({
          error: "event_id_required",
          message:
            "ID do evento não informado."
        });
      }

      await c.events.delete({
        calendarId: "primary",
        eventId
      });

      console.log(
        "Evento excluído:",
        eventId
      );

      res.json({
        ok: true,
        deleted: true,
        eventId
      });

    } catch (e) {
      console.error(
        "Erro ao excluir evento:",
        e
      );

      res.status(500).json({
        error: "calendar_delete_error",
        message: e.message
      });
    }
  }
);

// =====================================================
// OPENROUTER - IA PRINCIPAL DO PRIMORIS
// =====================================================

async function chamarOpenRouter(payload, tentativa = 1) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, body: { error: { message: "OPENROUTER_API_KEY não está configurada no Render." } } };
  }

  const model = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    console.log("OpenRouter: tentativa " + tentativa + " | modelo " + model);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": process.env.PRIMORIS_PUBLIC_URL || "https://primoris-assistente.onrender.com",
        "X-OpenRouter-Title": "PRIMORIS"
      },
      signal: controller.signal,
      body: JSON.stringify({ ...payload, model })
    });

    const raw = await response.text();
    let body = {};
    try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 1000) }; }
    console.log("OpenRouter: resposta HTTP " + response.status + " | " + (response.ok ? "sucesso" : "erro") + (response.ok ? "" : " | " + (body?.error?.message || body?.message || raw.slice(0, 500) || "sem mensagem")));
    return { ok: response.ok, status: response.status, body, model };
  } catch (e) {
    console.error("OpenRouter: falha na chamada | " + (e.name || "Erro") + " | " + (e.message || "erro desconhecido"));
    if (e.name === "AbortError") {
      return { ok: false, status: 504, body: { error: { message: "O OpenRouter demorou mais de 30 segundos para responder." } }, model };
    }
    return { ok: false, status: 502, body: { error: { message: "Falha de conexão com OpenRouter: " + (e.message || "erro desconhecido") } }, model };
  } finally {
    clearTimeout(timeout);
  }
}

async function chamarGeminiTexto(prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, status: 503, body: { error: { message: "GEMINI_API_KEY não está configurada no Render." } }, model };
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 700 }
      })
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body, model };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, status: 504, body: { error: { message: "O Gemini demorou mais de 30 segundos para responder." } }, model };
    throw e;
  } finally { clearTimeout(timeout); }
}

app.post("/api/ai", async (req,res)=>{
  try{
    const message=String(req.body?.message||"").trim(),context=req.body?.context||{};
    if(!message)return res.status(400).json({error:"message_required"});
    const memories=(Array.isArray(context.memories)?context.memories:[]).filter(x=>x&&typeof x.text==="string"&&x.text.trim()).slice(0,100).map(x=>({category:String(x.category||"Observações").slice(0,80),text:x.text.trim().slice(0,1200)}));
    const safeContext={...context};delete safeContext.memories;
    const prompt=`Você é o PRIMORIS, assistente pessoal inteligente.\nResponda em português do Brasil, com naturalidade, cordialidade e objetividade. Use o nome da pessoa somente se estiver explicitamente presente nas configurações/memórias. Não invente dados nem afirme ações não executadas. Considere as memórias quando relevantes.\nMEMÓRIAS: ${JSON.stringify(memories)}\nCONTEXTO: ${JSON.stringify(safeContext)}\nMENSAGEM: ${message}`;
    const requested=String(req.body?.provider||"openai").toLowerCase();
    const order=providerOrder(requested==="auto"?"auto":(["openai","openrouter","gemini","groq"].includes(requested)?requested:"openai"));
    let last=null;
    for(const provider of order){
      const r=await callTextProvider(provider,prompt,900);
      if(r.ok&&r.text)return res.json({text:r.text,provider:({openai:"OpenAI",openrouter:"OpenRouter",gemini:"Google Gemini",groq:"Groq"})[provider]||provider,providerId:provider,model:r.model});
      last=r;
      if(![429,401,403,500,502,503,504].includes(r.status))break;
    }
    const status=last?.status||503;
    const provider=last?.provider||order[0]||requested;
    const details=last?.body?.error?.message||last?.body?.message||"Nenhum provedor disponível respondeu.";
    console.error("Falha na IA selecionada:",provider,"HTTP",status,details);
    return res.status([400,401,403,429,503,504].includes(status)?status:502).json({
      error:"ai_providers_failed",provider,providerId:provider,status,model:last?.model||providerModel(provider),details
    });
  }catch(e){console.error("Erro geral na IA:",e);res.status(500).json({error:"ai_server_error",details:e.message});}
});

// Interpretação estruturada para ações. A execução e persistência continuam no navegador
// para manter os dados locais e não expor o armazenamento do usuário ao servidor.
app.post("/api/ai/action", async (req,res)=>{
  const message=String(req.body?.message||"").trim();
  if(!message)return res.status(400).json({error:"message_required"});
  const q=message.toLocaleLowerCase("pt-BR");
  const titleFrom=(patterns)=>{
    for(const re of patterns){const m=message.match(re);if(m?.[1])return m[1].trim().replace(/[.!?]+$/,"");}
    return "";
  };
  // Frases de estudo, sessão e plano.
  if(/\b(crie|cria|adicione|adiciona|registre|registra|monte|monta|faça|faz)\b/i.test(q)&&/\b(estudo|estudos|plano de estudos|sess[aã]o de estudo|estudar)\b/i.test(q)){
    const topicPair=message.match(/estudo\s+de\s+(.+?)\s+sobre\s+(.+?)(?:\s+(?:por|durante)\s+\d+\s*minutos?|\s+amanh[ãa]|\s+hoje|$)/i);
    let title=topicPair ? (topicPair[1].trim()+" — "+topicPair[2].trim()) : titleFrom([
      /sobre\s+(.+?)(?:\s+(?:por|durante)\s+\d+\s*minutos?|\s+amanh[ãa]|\s+hoje|$)/i,
      /estudos?\s+(?:de|sobre|em)\s+(.+?)(?:\s+(?:por|durante)\s+\d+\s*minutos?|\s+amanh[ãa]|\s+hoje|$)/i,
      /(?:sobre|de|para|em)\s+(.+?)(?:\s+(?:por|durante)\s+\d+\s*minutos?|\s+amanh[ãa]|\s+hoje|$)/i,
      /(?:estudar|estudo)\s+(?:de\s+)?(.+?)(?:\s+(?:por|durante)\s+\d+\s*minutos?|\s+amanh[ãa]|\s+hoje|$)/i
    ]);
    const mins=Number((q.match(/(\d{1,3})\s*minutos?/i)||[])[1]||0);
    if(title) return res.json({action:{type:"study",title,kind:/plano de estudos/i.test(q)?"Plano de estudos":/sess[aã]o/i.test(q)?"Sessão":"matéria",minutes:mins,notes:message}});
    // "esse assunto" depende do histórico/contexto; deixa a interpretação contextual decidir.

  }
  if(/\b(crie|cria|adicione|adiciona|registre|registra|salve|salva)\b/i.test(q)&&/\boportunidade\b/i.test(q)){
    let title=titleFrom([/(?:chamada?|nomeada?)\s+(.+?)$/i,/(?:oportunidade)\s+(?:para|de|sobre)?\s*(.+?)$/i,/(?:aprender|pesquisar|fazer|estudar)\s+(.+?)$/i]);
    if(!title)title=message.replace(/.*oportunidade(?:\s+(?:para|de|sobre))?\s*/i,"").trim();
    title=title.replace(/^eu\s+/i,"").replace(/^pesquisar\s+/i,"Pesquisar ").replace(/[.!?]+$/,"").trim();
    if(title) return res.json({action:{type:"opportunity",title,notes:message}});

  }
  // Interpretação semântica para frases não cobertas pelas regras determinísticas.
  // O modelo apenas propõe uma ação estruturada; a validação e gravação ficam no frontend.
  try {
    const context=req.body?.context||{};
    const prompt=`Interprete o comando do usuário para o PRIMORIS. Data/hora local: ${String(req.body?.currentDate||"não informada")}.
Responda SOMENTE JSON válido neste formato: {"action":{"type":"task|reminder|event|study|opportunity|note|expense|delete_task","title":"...","target":"...","description":"...","date":"YYYY-MM-DD ou vazio","time":"HH:MM ou vazio","minutes":0,"kind":"...","amount":0,"category":"...","notes":"..."},"clarification":""}.
Se faltar informação essencial ou houver ambiguidade, action deve ser null e clarification deve perguntar apenas o dado necessário.
Não invente datas, horários, valores ou títulos. Para apagar uma tarefa, use delete_task e identifique target usando a lista disponível; se houver mais de uma candidata, peça esclarecimento.
Contexto existente: ${JSON.stringify(context).slice(0,12000)}
Comando: ${message}`;
    const requested=String(req.body?.provider||"openai").toLowerCase();
    const order=providerOrder(requested==="auto"?"auto":(["openai","openrouter","gemini","groq"].includes(requested)?requested:"openai"));
    for(const provider of order){
      const result=await callTextProvider(provider,prompt,500);
      if(!result.ok||!result.text)continue;
      try{
        const cleaned=result.text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
        const parsed=JSON.parse(cleaned);
        const allowed=["task","reminder","event","study","opportunity","note","expense","delete_task"];
        if(parsed?.action&&allowed.includes(parsed.action.type))return res.json({action:parsed.action});
        if(parsed?.clarification)return res.json({action:null,clarification:String(parsed.clarification).slice(0,500)});
      }catch(parseError){console.warn("Ação IA retornou JSON inválido:",parseError.message);}
    }
  } catch(e) { console.warn("Interpretação semântica indisponível:",e.message); }
  return res.json({action:null});
});

// =====================================================
// PESQUISA NA INTERNET COM GEMINI + GOOGLE SEARCH
// =====================================================
app.post("/api/web-search", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!query) return res.status(400).json({ error: "query_required" });
    if (query.length > 500) return res.status(400).json({ error: "query_too_long" });
    if (!apiKey) return res.status(503).json({ error: "gemini_not_configured", details: "GEMINI_API_KEY não está configurada." });
    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Pesquise na internet agora sobre: ${query}. Responda em português do Brasil com um resumo factual e indique as fontes. Não invente informações.` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1000 }
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: "web_search_failed", details: body?.error?.message || "O Gemini não conseguiu realizar a pesquisa." });
    const candidate = body?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text || "").join("").trim() || "Sem resumo.";
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks.map(c => c?.web).filter(x => x && x.uri).map(x => ({ url: x.uri, title: x.title || x.uri }));
    res.json({ ok: true, text, sources: Array.from(new Map(sources.map(x => [x.url, x])).values()).slice(0, 8) });
  } catch (e) {
    console.error("Web search:", e);
    res.status(500).json({ error: "web_search_server_error", details: e.message || "Falha na pesquisa." });
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

      const feed =
        await parser.parseURL(url);

      for (
        const item of
          (feed.items || []).slice(0, 5)
      ) {
        items.push({
          title: item.title,
          link: item.link,
          source:
            item.creator ||
            "Google News",

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
// FALLBACK DO SITE
// =====================================================

app.use((req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
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
      "PRIMORIS rodando na porta " +
        PORT
    );
  }
);
