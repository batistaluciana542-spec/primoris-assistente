const express = require("express");
const crypto = require("crypto");
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

app.use(express.json({ limit: "12mb" }));

const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

const GOOGLE_REFRESH_COOKIE = "primoris_google_refresh";
const GOOGLE_COOKIE_KEY = crypto.createHash("sha256").update(SESSION_SECRET).digest();
function encryptGoogleToken(token){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv("aes-256-gcm",GOOGLE_COOKIE_KEY,iv);const encrypted=Buffer.concat([cipher.update(String(token),"utf8"),cipher.final()]);const tag=cipher.getAuthTag();return Buffer.concat([iv,tag,encrypted]).toString("base64url");}
function decryptGoogleToken(value){try{const raw=Buffer.from(String(value||""),"base64url");if(raw.length<29)return null;const decipher=crypto.createDecipheriv("aes-256-gcm",GOOGLE_COOKIE_KEY,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString("utf8");}catch{return null;}}
function getCookie(req,name){const header=String(req.headers.cookie||"");const found=header.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));return found?decodeURIComponent(found.slice(name.length+1)):null;}
function setGoogleRefreshCookie(res,token){const secure=process.env.NODE_ENV==="production"?"; Secure":"";res.setHeader("Set-Cookie",GOOGLE_REFRESH_COOKIE+"="+encodeURIComponent(encryptGoogleToken(token))+"; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax"+secure);}
function clearGoogleRefreshCookie(res){res.setHeader("Set-Cookie",GOOGLE_REFRESH_COOKIE+"=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");}
app.use((req,res,next)=>{if(!req.session.tokens){const refreshToken=decryptGoogleToken(getCookie(req,GOOGLE_REFRESH_COOKIE));if(refreshToken){req.session.tokens={refresh_token:refreshToken};req.session.gmailConnected=true;}}next();});

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
  const timeout = setTimeout(() => controller.abort(), 60000);
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

// CLOUDFLARE WORKERS AI - PROVEDOR ADICIONAL COM COTA GRATUITA DIÁRIA
async function chamarCloudflare(payload) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey = process.env.CLOUDFLARE_API_TOKEN;
  const model = process.env.CLOUDFLARE_MODEL || "@cf/openai/gpt-oss-120b";
  if (!accountId || !apiKey) return {ok:false,status:503,body:{error:{message:"CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_API_TOKEN não está configurado no servidor."}},model};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(accountId) + "/ai/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+apiKey},
      signal:controller.signal,
      body:JSON.stringify({...payload, model})
    });
    const raw = await response.text();
    let body={};
    try { body=raw?JSON.parse(raw):{}; } catch { body={error:{message:raw||"Resposta inválida do Cloudflare."}}; }
    if (!response.ok) {
      const cfMessage=(body?.errors?.map?.(e=>e?.message||e?.code).filter(Boolean).join(" · "))||body?.error?.message||body?.message||("Cloudflare HTTP "+response.status);
      body={...body,error:{...(body.error||{}),message:cfMessage}};
    }
    return {ok:response.ok,status:response.status,body,model};
  } catch(e) {
    return {ok:false,status:e.name==="AbortError"?504:502,body:{error:{message:e.name==="AbortError"?"Cloudflare AI excedeu 60 segundos.":e.message}},model};
  } finally { clearTimeout(timeout); }
}

// OpenAI oficial: usa as variáveis já existentes no Render.
async function chamarOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return { ok:false, status:503, body:{error:{message:"OPENAI_API_KEY não está configurada no servidor."}}, model };
  // O roteador gratuito pode demorar quando está escolhendo/acionando um provedor.
  // Damos até 60s antes de considerar a chamada realmente travada.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
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
    provider==="cloudflare" ? !!process.env.CLOUDFLARE_API_TOKEN && !!process.env.CLOUDFLARE_ACCOUNT_ID :
    provider==="openrouter" ? !!process.env.OPENROUTER_API_KEY : false;
}
function providerModel(provider) {
  return provider==="openai" ? (process.env.OPENAI_MODEL || "gpt-4o-mini") :
    provider==="gemini" ? (process.env.GEMINI_MODEL || "gemini-3.8-flash") :
    provider==="groq" ? (process.env.GROQ_MODEL || "openai/gpt-oss-120b") :
    provider==="cloudflare" ? (process.env.CLOUDFLARE_MODEL || "@cf/openai/gpt-oss-120b") :
    (process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free");
}
function extractAIText(value, depth=0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(item => extractAIText(item, depth+1)).filter(Boolean).join("\n").trim();
  if (typeof value === "object") {
    // APIs compatíveis com OpenAI podem devolver content como objeto/partes,
    // em vez de uma string simples. Prioriza campos que representam texto final.
    for (const key of ["text", "output_text", "content", "value"]) {
      if (value[key] != null) {
        const found = extractAIText(value[key], depth+1);
        if (found) return found;
      }
    }
  }
  return "";
}

async function callTextProvider(provider, prompt, maxTokens=1200) {
  if (!providerConfigured(provider)) return {ok:false,status:503,provider,model:providerModel(provider),body:{error:{message:provider.toUpperCase()+"_API_KEY não configurada."}}};
  if (provider==="gemini") {
    const r=await chamarGeminiTexto(prompt,providerModel(provider));
    const text=extractAIText(r.body?.candidates?.[0]?.content?.parts);
    return {...r,provider,text};
  }
  const payload={messages:[
    {role:"system",content:"Você é o PRIMORIS, assistente pessoal em português do Brasil. Seja natural, atencioso e preciso. Nunca diga que executou algo sem confirmação."},
    {role:"user",content:prompt}
  ],temperature:0.35,max_tokens:maxTokens};
  const r=provider==="openai" ? await chamarOpenAI(payload) :
    provider==="groq" ? await chamarGroq(payload) :
    provider==="cloudflare" ? await chamarCloudflare(payload) : await chamarOpenRouter(payload,1);
  const choice=r.body?.choices?.[0];
  const content=choice?.message?.content;
  const text=extractAIText(content);
  return {...r,provider,text,finishReason:choice?.finish_reason||choice?.native_finish_reason||null,contentType:Array.isArray(content)?"array":(content===null?"null":typeof content)};
}
function providerOrder(requested) {
  const all=["openai","openrouter","gemini","groq","cloudflare"];
  // Um provedor escolhido pelo usuário deve ser usado sozinho. Fallback entre
  // provedores acontece somente quando o usuário seleciona o modo automático.
  if(requested==="auto") return all.filter(providerConfigured);
  return all.includes(requested) ? [requested] : [];
}

// =====================================================
// ELEVENLABS TTS
// =====================================================
app.post("/api/tts", async (req,res)=>{
  console.log("[TTS] /api/tts recebido", new Date().toISOString());
  try{
    const apiKey=process.env.ELEVENLABS_API_KEY;
    if(!apiKey)return res.status(503).json({error:"elevenlabs_not_configured",details:"ELEVENLABS_API_KEY não está configurada no servidor."});
    const text=String(req.body?.text||"").replace(/\\s+/g," ").trim();
    if(!text)return res.status(400).json({error:"text_required"});
    if(text.length>4000)return res.status(400).json({error:"text_too_long"});
    const voiceId=process.env.ELEVENLABS_VOICE_ID||"JBFqnCBsd6RMkjVDRZzb";
    const modelId=process.env.ELEVENLABS_MODEL||"eleven_flash_v2_5";
    const response=await fetch("https://api.elevenlabs.io/v1/text-to-speech/"+encodeURIComponent(voiceId)+"?output_format=mp3_44100_128",{method:"POST",headers:{"xi-api-key":apiKey,"Content-Type":"application/json","Accept":"audio/mpeg"},body:JSON.stringify({text,model_id:modelId,language_code:"pt",voice_settings:{stability:0.5,similarity_boost:0.75,style:0.15,use_speaker_boost:true}})});
    const raw=await response.arrayBuffer();
    if(!response.ok){let detail="ElevenLabs respondeu com erro HTTP "+response.status+".";try{const j=JSON.parse(Buffer.from(raw).toString("utf8"));detail=j?.detail?.message||j?.detail||j?.message||detail}catch{} console.error("[TTS] ElevenLabs HTTP",response.status,detail); return res.status(response.status).json({error:"elevenlabs_error",details:detail});}
    res.set("Content-Type",response.headers.get("content-type")||"audio/mpeg");
    res.set("Cache-Control","no-store");
    console.log("[TTS] ElevenLabs respondeu OK", response.status, response.headers.get("content-type")||"audio/mpeg");
    res.send(Buffer.from(raw));
  }catch(e){console.error("[TTS] ElevenLabs conexão:",e?.message||e);res.status(e?.name==="AbortError"?504:502).json({error:"elevenlabs_connection_error",details:e?.message||"Falha de conexão com ElevenLabs."});}
});

// =====================================================
// STATUS
// =====================================================

app.get("/api/status", (req, res) => {
  const requested=String(req.query.provider||"").toLowerCase();
  const chosen=["openai","openrouter","gemini","groq","cloudflare","auto"].includes(requested)?requested:"openai";
  const names={openai:"OpenAI",openrouter:"OpenRouter",gemini:"Google Gemini",groq:"Groq",cloudflare:"Cloudflare AI"};
  res.json({
    ok:true, calendar:!!req.session.tokens, gmail:!!req.session.gmailConnected,
    ai:["openai","openrouter","gemini","groq","cloudflare"].some(providerConfigured),
    aiProvider:chosen==="auto"?"Automático":(names[chosen]||"OpenRouter"),
    aiModel:chosen==="auto"?"Fallback automático":providerModel(chosen),
    providers:{
      openai:{available:providerConfigured("openai"),model:providerModel("openai")},
      openrouter:{available:providerConfigured("openrouter"),model:providerModel("openrouter")},
      gemini:{available:providerConfigured("gemini"),model:providerModel("gemini")},
      groq:{available:providerConfigured("groq"),model:providerModel("groq")},
      cloudflare:{available:providerConfigured("cloudflare"),model:providerModel("cloudflare")}
    }
  });
});

// Teste real dos provedores. No modo automático, testa em paralelo para
// que um provedor lento não esconda o resultado dos outros.
app.post("/api/ai/test", async (req,res)=>{
  const requested=String(req.body?.provider||"openrouter").toLowerCase();
  const allowed=["openai","openrouter","gemini","groq","cloudflare"];
  const providers=requested==="auto"?allowed:[requested];
  const results=await Promise.all(providers.filter(p=>allowed.includes(p)).map(async provider=>{
    if(!providerConfigured(provider)){
      return {provider,ok:false,status:503,model:providerModel(provider),elapsedMs:0,error:provider.toUpperCase()+"_API_KEY não está configurada no servidor.",errorCode:"provider_not_configured",text:""};
    }
    const started=Date.now();
    try{
      const r=await callTextProvider(provider,"Responda exatamente: PRIMORIS "+provider.toUpperCase()+" OK",256);
      const hasText=typeof r.text==="string"&&r.text.trim().length>0;
      const ok=!!r.ok&&hasText;
      const error=ok?null:(r.body?.error?.message||r.body?.message||(r.finishReason==="length"?"A geração atingiu o limite de tokens antes de entregar uma resposta completa.":(r.ok?"A API respondeu, mas não retornou texto.":"Falha na API sem mensagem de erro.")));
      console.log("Teste IA "+provider+": HTTP "+(r.status||200)+" | ok="+ok+" | modelo="+(r.model||providerModel(provider))+(error?" | erro="+error:""));
      return {
        provider,ok,status:r.status||200,model:r.model||providerModel(provider),
        elapsedMs:Date.now()-started,error,
        errorCode:r.body?.error?.code||r.body?.error?.type||(r.finishReason==="length"?"max_tokens_reached":null),
        finishReason:r.finishReason||null,
        contentType:r.contentType||null,
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
    if (tokens.refresh_token) setGoogleRefreshCookie(res, tokens.refresh_token);

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
  clearGoogleRefreshCookie(res);
  res.redirect("/");
});

// =====================================================
// GMAIL
// =====================================================
function gmailClient(req) {
  if (!req.session.tokens) return null;
  const o = oauth();
  o.setCredentials(req.session.tokens);
  o.on("tokens", tokens => { if (tokens.refresh_token) req.session.tokens.refresh_token = tokens.refresh_token; });
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

function decodeGmailPart(part) {
  if (!part) return "";
  if (part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of (part.parts || [])) {
    const text = decodeGmailPart(child);
    if (text) return text;
  }
  return "";
}

app.get("/api/gmail/message/:id", async (req, res) => {
  try {
    const gmail = gmailClient(req);
    if (!gmail) return res.status(401).json({ error: "gmail_not_connected", details: "Conecte sua conta Google para visualizar e-mails." });
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "message_id_required" });
    const full = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const payload = full.data.payload || {};
    const body = decodeGmailPart(payload) || full.data.snippet || "";
    res.json({ ok: true, id, subject: gmailHeader(payload.headers, "Subject"), from: gmailHeader(payload.headers, "From"), date: gmailHeader(payload.headers, "Date"), snippet: full.data.snippet || "", body });
  } catch (e) {
    console.error("Gmail message:", e);
    res.status(502).json({ error: "gmail_message_failed", details: e.message || "Falha ao abrir e-mail." });
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
  o.on("tokens", tokens => { if (tokens.refresh_token) req.session.tokens.refresh_token = tokens.refresh_token; });

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
      return { ok: false, status: 504, body: { error: { message: "O OpenRouter demorou mais de 60 segundos para responder." } }, model };
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

// Reduz o contexto enviado aos provedores sem alterar nem apagar os dados locais.
function compactAIContext(value, key="", depth=0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const limit = key === "text" ? 450 : key === "memory" ? 900 : 240;
    return value.trim().slice(0, limit);
  }
  if (Array.isArray(value)) {
    const limit = key === "memories" ? 8 : key === "transactions" ? 4 : 4;
    return value.slice(-limit).map(item => compactAIContext(item, "", depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return undefined;
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 18)) {
      // calendar duplica events no payload do navegador.
      if (childKey === "calendar") continue;
      const compacted = compactAIContext(childValue, childKey, depth + 1);
      if (compacted !== undefined) result[childKey] = compacted;
    }
    return result;
  }
  return undefined;
}


app.post("/api/vision", async (req,res)=>{
  try{
    const apiKey=process.env.GEMINI_API_KEY;
    if(!apiKey)return res.status(503).json({error:"gemini_not_configured",details:"GEMINI_API_KEY não está configurada no Render."});
    const image=String(req.body?.image||"");
    const prompt=String(req.body?.prompt||"").trim();
    if(!image.startsWith("data:image/"))return res.status(400).json({error:"image_required",details:"Envie uma imagem válida."});
    if(!prompt)return res.status(400).json({error:"prompt_required",details:"Informe o que a IA deve fazer com a imagem."});
    if(image.length>9000000)return res.status(413).json({error:"image_too_large",details:"A imagem ficou grande demais. Tente uma foto menor."});
    const match=image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if(!match)return res.status(400).json({error:"invalid_image"});
    const mime=match[1],data=match[2];
    const model=process.env.GEMINI_VISION_MODEL||process.env.GEMINI_MODEL||"gemini-2.5-flash";
    const url="https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent?key="+encodeURIComponent(apiKey);
    const visionPrompt=`Você é o módulo de visão do PRIMORIS. Analise cuidadosamente a imagem enviada e cumpra o pedido do usuário. Se for uma atividade escolar, transcreva as questões relevantes, resolva com raciocínio correto e organize as respostas de forma numerada. Explique de maneira clara e adequada para estudo. Não invente texto que não esteja legível na imagem; quando algo estiver ilegível, avise. Responda em português do Brasil.

PEDIDO DO USUÁRIO:
${prompt.slice(0,5000)}`;
    const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{inline_data:{mime_type:mime,data}},{text:visionPrompt}]}],generationConfig:{temperature:.2,maxOutputTokens:1800}})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(502).json({error:"vision_failed",details:body?.error?.message||"O Gemini não conseguiu analisar a imagem."});
    const text=body?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();
    if(!text)return res.status(502).json({error:"vision_empty",details:"A IA não retornou uma resposta."});
    res.json({ok:true,text,provider:"Google Gemini Vision",model});
  }catch(e){
    console.error("Vision:",e);
    res.status(500).json({error:"vision_server_error",details:e.message||"Falha ao analisar a imagem."});
  }
});

app.post("/api/ai", async (req,res)=>{
  try{
    const message=String(req.body?.message||"").trim(),context=req.body?.context||{};
    if(!message)return res.status(400).json({error:"message_required"});
    const memories=(Array.isArray(context.memories)?context.memories:[])
      .filter(x=>x&&typeof x.text==="string"&&x.text.trim())
      .slice(-8)
      .map(x=>({category:String(x.category||"Observações").slice(0,60),text:x.text.trim().slice(0,450)}));
    const safeContext=compactAIContext(context)||{};
    delete safeContext.memories;
    let contextJson=JSON.stringify(safeContext);
    // Limite conservador para manter a solicitação abaixo dos limites de contexto/TPM
    // comuns, mesmo quando o armazenamento local acumula muitos registros.
    while(contextJson.length>14000){
      const arrays=[];
      for(const [key,value] of Object.entries(safeContext)) if(Array.isArray(value)&&value.length>1) arrays.push({key,value});
      if(arrays.length){
        arrays.sort((a,b)=>b.value.length-a.value.length);
        arrays[0].value.shift();
      } else {
        const strings=Object.entries(safeContext).filter(([,value])=>typeof value==="string"&&value.length>80).sort((a,b)=>b[1].length-a[1].length);
        if(!strings.length) break;
        const [key,value]=strings[0]; safeContext[key]=value.slice(0,Math.max(80,Math.floor(value.length*0.7)));
      }
      contextJson=JSON.stringify(safeContext);
    }
    const prompt=`Você é o PRIMORIS, assistente pessoal inteligente.\nResponda em português do Brasil, com naturalidade, cordialidade e objetividade. Use o nome da pessoa somente se estiver explicitamente presente nas configurações/memórias. Não invente dados nem afirme ações não executadas. Considere as memórias quando relevantes.\nMEMÓRIAS: ${JSON.stringify(memories)}\nCONTEXTO: ${contextJson}\nMENSAGEM: ${message.slice(0,8000)}`;
    const requested=String(req.body?.provider||"openai").toLowerCase();
    const order=providerOrder(requested==="auto"?"auto":(["openai","openrouter","gemini","groq","cloudflare"].includes(requested)?requested:"openai"));
    let last=null;
    for(const provider of order){
      const r=await callTextProvider(provider,prompt,900);
      if(r.ok&&r.text)return res.json({text:r.text,provider:({openai:"OpenAI",openrouter:"OpenRouter",gemini:"Google Gemini",groq:"Groq",cloudflare:"Cloudflare AI"})[provider]||provider,providerId:provider,model:r.model});
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
  // Oportunidades: reconhece tanto comandos diretos quanto frases naturais
  // como "quero criar uma nova oportunidade para X" ou "pode adicionar a oportunidade Y".
  if(/\boportunidade(?:s)?\b/i.test(q)&&/\b(?:crie|criar|cria|adicione|adicionar|adiciona|registre|registrar|registra|salve|salvar|salva|guarde|guardar|guarda|lance|lançar|lan[cç]a|quero|gostaria|pode|poderia|preciso)\b/i.test(q)){
    let title=titleFrom([
      /(?:chamada?|nomeada?)\s+(.+?)(?:\s+e\s+(?:com|com ela|anote|adicione)|$)/i,
      /oportunidades?\s+(?:para|de|sobre|chamada?|nomeada?)\s*(.+?)$/i,
      /(?:criar|crie|cria|adicionar|adicione|adiciona|registrar|registre|registra|salvar|salve|salva|guardar|guarde|guarda|lançar|lance|lan[cç]a)\s+(?:uma\s+)?(?:nova\s+)?oportunidade(?:\s+(?:para|de|sobre))?\s+(.+?)$/i,
      /(?:quero|gostaria|preciso|pode|poderia)\s+(?:de\s+)?(?:criar|adicionar|registrar|salvar|guardar|lançar)\s+(?:uma\s+)?(?:nova\s+)?oportunidade(?:\s+(?:para|de|sobre))?\s+(.+?)$/i,
      /(?:aprender|pesquisar|fazer|estudar)\s+(.+?)$/i
    ]);
    if(!title)title=message.replace(/.*oportunidades?\s*(?:para|de|sobre)?\s*/i,"").trim();
    title=title.replace(/^(?:uma|uma nova|nova)\s+/i,"").replace(/^eu\s+/i,"").replace(/^pesquisar\s+/i,"Pesquisar ").replace(/[.!?]+$/,"").trim();
    if(title && !/^(?:criar|crie|cria|adicionar|adicione|adiciona|registrar|registre|salvar|salve|guardar|guarde)$/i.test(title)){
      return res.json({action:{type:"opportunity",title,notes:message}});
    }
  }
  // Exclusão de oportunidades também é determinística: não depende do provedor de IA.
  // Isso evita que um erro temporário do OpenRouter impeça uma ação local segura.
  if(/\\b(?:exclua|excluir|apague|apagar|remova|remover|delete|deletar)\\b/i.test(q)&&/\\boportunidade(?:s)?\\b/i.test(q)){
    let target=titleFrom([
      /oportunidade(?:s)?\\s+(?:chamada?|nomeada?)\\s+(.+?)$/i,
      /(?:oportunidade|oportunidades)\\s+(?:de|sobre|para)\\s+(.+?)$/i,
      /(?:exclua|excluir|apague|apagar|remova|remover|delete|deletar)\\s+(?:a|a\\s+)?(?:oportunidade|oportunidades)(?:\\s+(?:de|sobre|para|chamada?|nomeada?))?\\s+(.+?)$/i
    ]);
    if(!target) target=message.replace(/.*?\\b(?:oportunidade(?:s)?)\\b/i,"").replace(/^\\s*(?:de|sobre|para|chamada?|nomeada?)\\s+/i,"").trim();
    target=target.replace(/[.!?]+$/i,"").trim();
    if(target)return res.json({action:{type:"delete_opportunity",target}});
    return res.json({action:null,clarification:"Qual oportunidade você quer excluir? Informe o título."});
  }
  // Interpretação semântica para frases não cobertas pelas regras determinísticas.
  // O modelo apenas propõe uma ação estruturada; a validação e gravação ficam no frontend.
  try {
    const context=req.body?.context||{};
    const activeSkills=context.activeSkills||{};
    const prompt=`Interprete o comando do usuário para o PRIMORIS. Data/hora local: ${String(req.body?.currentDate||"não informada")}.
Skills ativas: ${JSON.stringify(activeSkills)}. Nunca proponha uma ação que dependa de uma Skill desativada. Mapeamento: task/reminder=taskAgent, event=agenda, study/opportunity=study, note=memory, expense=finance, delete_task=taskAgent, delete_opportunity=study.
Responda SOMENTE JSON válido neste formato: {"action":{"type":"task|reminder|event|study|opportunity|note|expense|delete_task|delete_opportunity","title":"...","target":"...","description":"...","date":"YYYY-MM-DD ou vazio","time":"HH:MM ou vazio","minutes":0,"kind":"...","amount":0,"category":"...","notes":"..."},"clarification":""}.
Se faltar informação essencial ou houver ambiguidade, action deve ser null e clarification deve perguntar apenas o dado necessário.
Não invente datas, horários, valores ou títulos. Para tarefas, use priority=alta quando o usuário indicar urgente/importante/alta prioridade, priority=baixa quando indicar baixa prioridade, e media nos demais casos. Para apagar uma tarefa, use delete_task e identifique target usando a lista disponível; se houver mais de uma candidata, peça esclarecimento. Para apagar uma oportunidade, use delete_opportunity e identifique target pelo título usando a lista disponível; se houver mais de uma candidata, peça esclarecimento. Nunca transforme um pedido de exclusão em criação.
Contexto existente: ${JSON.stringify(context).slice(0,12000)}
Comando: ${message}`;
    const requested=String(req.body?.provider||"openai").toLowerCase();
    const order=providerOrder(requested==="auto"?"auto":(["openai","openrouter","gemini","groq","cloudflare"].includes(requested)?requested:"openai"));
    for(const provider of order){
      const result=await callTextProvider(provider,prompt,500);
      if(!result.ok||!result.text)continue;
      try{
        const cleaned=result.text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
        const parsed=JSON.parse(cleaned);
        const allowed=["task","reminder","event","study","opportunity","note","expense","delete_task","delete_opportunity"];
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

// Health check leve para Render e para o diagnóstico do PRIMORIS.
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "PRIMORIS",
    version: "1.3.0",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// =====================================================
// CHAT GLOBAL // ORION
// =====================================================
const globalChatClients = new Set();
const globalChatRate = new Map();
const GLOBAL_CHAT_MAX = 120;
const GLOBAL_CHAT_ADMIN_NAME = process.env.ORION_ADMIN_NAME || "Anthony ADM";
const GLOBAL_CHAT_ADMIN_KEY = String(process.env.ORION_ADMIN_KEY || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || "").trim();
let supabase = null;

if(SUPABASE_URL && SUPABASE_SECRET_KEY){
  try{
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
    });
    console.log("Supabase conectado para o Chat Global.");
  }catch(e){
    console.error("Falha ao inicializar Supabase:",e.message);
  }
}else{
  console.warn("SUPABASE_URL/SUPABASE_SECRET_KEY não configuradas. Chat Global usará apenas memória.");
}

const globalChatMemory = [];

function cleanGlobalChatText(value,max=500){
  return String(value||'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').trim().slice(0,max);
}
function isGlobalChatAdmin(req){
  return req.session?.globalChatAdmin === true;
}
function normalizeGlobalChatRow(row){
  if(!row)return null;
  return {
    id:String(row.id),
    name:cleanGlobalChatText(row.name,30)||'Visitante',
    text:cleanGlobalChatText(row.text,500),
    role:row.role==="admin"?"admin":"user",
    createdAt:row.created_at||new Date().toISOString()
  };
}
function broadcastGlobalChat(message){
  const payload='data: '+JSON.stringify(message)+'\\n\\n';
  for(const client of globalChatClients){
    try{client.write(payload);}catch(e){globalChatClients.delete(client);}
  }
}
function rememberGlobalChatMessage(message){
  globalChatMemory.push(message);
  while(globalChatMemory.length>GLOBAL_CHAT_MAX)globalChatMemory.shift();
}
async function getGlobalChatMessages(){
  if(supabase){
    const {data,error}=await supabase
      .from("global_chat_messages")
      .select("id,name,text,role,created_at")
      .order("created_at",{ascending:false})
      .limit(80);
    if(error)throw error;
    return (data||[]).reverse().map(normalizeGlobalChatRow).filter(Boolean);
  }
  return globalChatMemory.slice(-80);
}
async function insertGlobalChatMessage(name,text,role="user"){
  const cleanName=cleanGlobalChatText(name,30)||"Visitante";
  const cleanText=cleanGlobalChatText(text,500);
  if(!cleanText)return null;

  if(supabase){
    const {data,error}=await supabase
      .from("global_chat_messages")
      .insert({
        id:Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8),
        name:cleanName,
        text:cleanText,
        role:role==="admin"?"admin":"user"
      })
      .select("id,name,text,role,created_at")
      .single();
    if(error)throw error;
    return normalizeGlobalChatRow(data);
  }

  return {
    id:Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8),
    name:cleanName,
    text:cleanText,
    role:role==="admin"?"admin":"user",
    createdAt:new Date().toISOString()
  };
}
async function deleteGlobalChatMessage(id){
  if(supabase){
    const {data,error}=await supabase
      .from("global_chat_messages")
      .delete()
      .eq("id",String(id))
      .select("id,name,text,role,created_at")
      .maybeSingle();
    if(error)throw error;
    return normalizeGlobalChatRow(data);
  }
  const index=globalChatMemory.findIndex(m=>String(m.id)===String(id));
  if(index<0)return null;
  return globalChatMemory.splice(index,1)[0]||null;
}
async function clearGlobalChatMessages(){
  if(supabase){
    const {error}=await supabase
      .from("global_chat_messages")
      .delete()
      .not("id","is",null);
    if(error)throw error;
    return;
  }
  globalChatMemory.length=0;
}

app.get("/api/global-chat/messages",async(req,res)=>{
  res.set("Cache-Control","no-store");
  try{
    const messages=await getGlobalChatMessages();
    res.json({
      ok:true,
      persistent:!!supabase,
      admin:isGlobalChatAdmin(req),
      adminName:GLOBAL_CHAT_ADMIN_NAME,
      messages
    });
  }catch(e){
    console.error("Global chat load:",e);
    res.status(503).json({
      error:"global_chat_storage_unavailable",
      details:"Não foi possível carregar o histórico do Chat Global.",
      persistent:false
    });
  }
});

app.get("/api/global-chat/stream",(req,res)=>{
  res.set({
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform",
    "Connection":"keep-alive",
    "X-Accel-Buffering":"no"
  });
  if(res.flushHeaders)res.flushHeaders();
  res.write('retry: 3000\\n\\n');
  res.write('event: admin-state\\ndata: '+JSON.stringify({admin:isGlobalChatAdmin(req),adminName:GLOBAL_CHAT_ADMIN_NAME})+'\\n\\n');
  globalChatClients.add(res);
  const heartbeat=setInterval(()=>{try{res.write(': ping\\n\\n');}catch(e){}},25000);
  req.on("close",()=>{clearInterval(heartbeat);globalChatClients.delete(res);});
});

app.post("/api/global-chat/admin/login",(req,res)=>{
  if(!GLOBAL_CHAT_ADMIN_KEY){
    return res.status(503).json({error:"admin_not_configured",details:"O acesso ADM ainda não foi configurado no servidor."});
  }
  const supplied=String(req.body?.key||"");
  const a=Buffer.from(supplied);
  const b=Buffer.from(GLOBAL_CHAT_ADMIN_KEY);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)){
    return res.status(401).json({error:"invalid_admin_key",details:"Chave ADM inválida."});
  }
  req.session.regenerate(err=>{
    if(err)return res.status(500).json({error:"admin_session_error"});
    req.session.globalChatAdmin=true;
    req.session.globalChatAdminName=GLOBAL_CHAT_ADMIN_NAME;
    req.session.save(saveErr=>{
      if(saveErr)return res.status(500).json({error:"admin_session_error"});
      res.json({ok:true,admin:true,name:GLOBAL_CHAT_ADMIN_NAME});
    });
  });
});

app.post("/api/global-chat/admin/logout",(req,res)=>{
  req.session.globalChatAdmin=false;
  req.session.globalChatAdminName=null;
  req.session.save(()=>res.json({ok:true,admin:false}));
});

function requireGlobalChatAdmin(req,res,next){
  if(!isGlobalChatAdmin(req))return res.status(403).json({error:"admin_required",details:"Acesso restrito ao ADM."});
  next();
}

app.delete("/api/global-chat/messages/:id",requireGlobalChatAdmin,async(req,res)=>{
  try{
    const removed=await deleteGlobalChatMessage(String(req.params.id||""));
    if(!removed)return res.status(404).json({error:"message_not_found",details:"Mensagem não encontrada."});
    broadcastGlobalChat({type:"delete",messageId:removed.id});
    res.json({ok:true});
  }catch(e){
    console.error("Global chat delete:",e);
    res.status(503).json({error:"global_chat_delete_failed",details:"Não foi possível excluir a mensagem do banco."});
  }
});

app.post("/api/global-chat/admin/clear",requireGlobalChatAdmin,async(req,res)=>{
  try{
    await clearGlobalChatMessages();
    globalChatMemory.length=0;
    broadcastGlobalChat({type:"clear"});
    res.json({ok:true});
  }catch(e){
    console.error("Global chat clear:",e);
    res.status(503).json({error:"global_chat_clear_failed",details:"Não foi possível limpar o histórico do banco."});
  }
});

app.post("/api/global-chat/messages",async(req,res)=>{
  const ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim();
  const now=Date.now();
  const last=globalChatRate.get(ip)||0;
  if(now-last<700)return res.status(429).json({error:"rate_limited",details:"Espere um instante antes de enviar outra mensagem."});

  const admin=isGlobalChatAdmin(req);
  const name=admin?GLOBAL_CHAT_ADMIN_NAME:cleanGlobalChatText(req.body?.name,30);
  const text=cleanGlobalChatText(req.body?.text,500);

  if(!name)return res.status(400).json({error:"name_required",details:"Escolha um apelido para entrar no chat."});
  if(!text)return res.status(400).json({error:"message_required",details:"Digite uma mensagem."});

  globalChatRate.set(ip,now);
  try{
    const message=await insertGlobalChatMessage(name,text,admin?"admin":"user");
    if(!message)return res.status(400).json({error:"message_required",details:"Digite uma mensagem."});
    rememberGlobalChatMessage(message);
    while(globalChatMemory.length>GLOBAL_CHAT_MAX)globalChatMemory.shift();
    broadcastGlobalChat({type:"message",message});
    res.status(201).json({ok:true,persistent:!!supabase,message});
  }catch(e){
    console.error("Global chat insert:",e);
    res.status(503).json({
      error:"global_chat_storage_unavailable",
      details:"Não foi possível salvar a mensagem. Verifique a conexão com o Supabase e a tabela global_chat_messages."
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

// =====================================================
// CLIMA - OPEN-METEO (SEM CHAVE DE API)
// =====================================================
function weatherCode(code) {
  const n=Number(code);
  if(n===0) return {condition:"Céu limpo",icon:"☀️"};
  if([1,2].includes(n)) return {condition:"Parcialmente nublado",icon:"🌤️"};
  if(n===3) return {condition:"Nublado",icon:"☁️"};
  if([45,48].includes(n)) return {condition:"Neblina",icon:"🌫️"};
  if([51,53,55,56,57].includes(n)) return {condition:"Garoa",icon:"🌦️"};
  if([61,63,65,66,67].includes(n)) return {condition:"Chuva",icon:"🌧️"};
  if([71,73,75,77].includes(n)) return {condition:"Neve",icon:"🌨️"};
  if([80,81,82].includes(n)) return {condition:"Pancadas de chuva",icon:"🌦️"};
  if([85,86].includes(n)) return {condition:"Pancadas de neve",icon:"🌨️"};
  if([95,96,99].includes(n)) return {condition:"Trovoadas",icon:"⛈️"};
  return {condition:"Condição variável",icon:"☁️"};
}
async function fetchJson(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try { const r=await fetch(url,{signal:controller.signal,headers:{"User-Agent":"PRIMORIS/1.0"}}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j?.reason||"Fonte de clima indisponível."); return j; }
  finally { clearTimeout(timer); }
}
app.get("/api/weather", async (req,res)=>{
  try {
    const city=String(req.query.city||"").trim().slice(0,100);
    if(!city) return res.status(400).json({error:"city_required",details:"Informe sua cidade."});
    const geo=await fetchJson("https://geocoding-api.open-meteo.com/v1/search?name="+encodeURIComponent(city)+"&count=1&language=pt&format=json");
    const place=geo?.results?.[0];
    if(!place) return res.status(404).json({error:"city_not_found",details:"Não encontrei essa cidade."});
    const url="https://api.open-meteo.com/v1/forecast?latitude="+encodeURIComponent(place.latitude)+"&longitude="+encodeURIComponent(place.longitude)+"&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto";
    const w=await fetchJson(url), c=w.current||{}, cw=weatherCode(c.weather_code);
    const times=w.hourly?.time||[], temps=w.hourly?.temperature_2m||[], rains=w.hourly?.precipitation_probability||[], codes=w.hourly?.weather_code||[];
    const nowIndex=Math.max(0,times.findIndex(t=>t>=c.time));
    const hourly=Array.from({length:12},(_,i)=>{const k=nowIndex+i;return k<times.length?{time:new Date(times[k]).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}),temperature:temps[k],rain:rains[k],...weatherCode(codes[k])}:null}).filter(Boolean);
    const dailyTimes=w.daily?.time||[], max=w.daily?.temperature_2m_max||[], min=w.daily?.temperature_2m_min||[], dr=w.daily?.precipitation_probability_max||[], dc=w.daily?.weather_code||[];
    const daily=dailyTimes.map((d,i)=>({day:new Date(d+"T12:00:00").toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit"}),max:max[i],min:min[i],rain:dr[i],...weatherCode(dc[i])}));
    res.json({ok:true,location:{name:place.name,country:place.country,admin1:place.admin1||""},current:{temperature:c.temperature_2m,apparentTemperature:c.apparent_temperature,humidity:c.relative_humidity_2m,precipitation:c.precipitation,precipitationProbability:hourly[0]?.rain||0,windSpeed:c.wind_speed_10m,condition:cw.condition,icon:cw.icon},weather:{hourly,daily}});
  } catch(e) { console.error("Weather:",e); res.status(502).json({error:"weather_failed",details:e.message||"Falha ao atualizar o clima."}); }
});
app.get("/api/weather/reverse", async (req,res)=>{
  try {
    const lat=Number(req.query.lat),lon=Number(req.query.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)) return res.status(400).json({error:"coordinates_required"});
    const geo=await fetchJson("https://geocoding-api.open-meteo.com/v1/reverse?latitude="+encodeURIComponent(lat)+"&longitude="+encodeURIComponent(lon)+"&count=1&language=pt&format=json");
    const p=geo?.results?.[0]; if(!p) return res.status(404).json({error:"location_not_found",details:"Não foi possível identificar sua cidade."});
    res.json({ok:true,city:p.name+(p.admin1?', '+p.admin1:'')});
  } catch(e) { console.error("Weather reverse:",e); res.status(502).json({error:"weather_reverse_failed",details:e.message||"Falha ao identificar cidade."}); }
});