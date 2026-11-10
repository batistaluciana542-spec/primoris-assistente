const express=require("express");
const session=require("express-session");
const dotenv=require("dotenv");
const path=require("path");
const Parser=require("rss-parser");
const {google}=require("googleapis");
const {GoogleGenAI}=require("@google/genai");
dotenv.config();

const app=express();
const PORT=process.env.PORT||3000;
const parser=new Parser();
app.set("trust proxy",1);
app.use(express.json({limit:"2mb"}));
app.use(session({
  secret:process.env.SESSION_SECRET||"change-me",
  resave:false,saveUninitialized:false,
  cookie:{secure:process.env.NODE_ENV==="production",httpOnly:true,sameSite:"lax"}
}));
app.use(express.static(path.join(__dirname)));

function oauth(){return new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
)}

app.get("/api/status",(req,res)=>res.json({
  ok:true,calendar:!!req.session.tokens,
  ai:!!process.env.GEMINI_API_KEY,
  aiProvider:process.env.GEMINI_API_KEY?"Google Gemini":"local"
}));

app.get("/auth/google",(req,res)=>{
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET||!process.env.GOOGLE_REDIRECT_URI)
    return res.status(500).send("Google OAuth não configurado no Render.");
  const o=oauth();
  res.redirect(o.generateAuthUrl({
    access_type:"offline",prompt:"consent",
    scope:["https://www.googleapis.com/auth/calendar"]
  }));
});

app.get("/auth/google/callback",async(req,res)=>{
  try{
    const o=oauth();
    const {tokens}=await o.getToken(req.query.code);
    req.session.tokens=tokens;
    res.redirect("/#integrations");
  }catch(e){res.status(500).send("Falha no Google Calendar: "+e.message)}
});

app.get("/auth/google/disconnect",(req,res)=>{
  req.session.tokens=null;res.redirect("/");
});

function calendarClient(req){
  if(!req.session.tokens)return null;
  const o=oauth();o.setCredentials(req.session.tokens);
  return google.calendar({version:"v3",auth:o});
}

app.get("/api/calendar/events",async(req,res)=>{
  try{
    const c=calendarClient(req);
    if(!c)return res.status(401).json({error:"not_connected"});
    const r=await c.events.list({
      calendarId:"primary",timeMin:new Date().toISOString(),
      singleEvents:true,orderBy:"startTime",maxResults:2500
    });
    res.json({events:r.data.items||[]});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/calendar/events",async(req,res)=>{
  try{
    const c=calendarClient(req);
    if(!c)return res.status(401).json({error:"not_connected"});
    const {title,start,end,description}=req.body||{};
    if(!title||!start||!end)return res.status(400).json({error:"title_start_end_required"});
    const event=await c.events.insert({
      calendarId:"primary",
      requestBody:{
        summary:title,description:description||"",
        start:{dateTime:start,timeZone:"America/Sao_Paulo"},
        end:{dateTime:end,timeZone:"America/Sao_Paulo"}
      }
    });
    res.json({ok:true,event:event.data});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/ai",async(req,res)=>{
  try{
    const message=String(req.body?.message||"").trim();
    const context=req.body?.context||{};
    if(!message)return res.status(400).json({error:"message_required"});
    if(!process.env.GEMINI_API_KEY)
      return res.json({text:"A IA externa não está configurada. O PRIMORIS continua funcionando em modo local.",provider:"local"});
    const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
    const response=await ai.models.generateContent({
      model:process.env.GEMINI_MODEL||"gemini-flash-latest",
      contents:`Você é o PRIMORIS, assistente pessoal em português do Brasil. Seja objetivo, claro e útil.
Contexto: ${JSON.stringify(context)}
Mensagem: ${message}`
    });
    res.json({text:response.text||"Não consegui gerar uma resposta.",provider:"Google Gemini"});
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Falha ao consultar o Google Gemini.",details:e.message});
  }
});

app.get("/api/news",async(req,res)=>{
  try{
    const qs=["Brasil OR Brasília OR economia brasileira","mundo OR geopolítica OR internacional","tecnologia OR inteligência artificial"];
    const out=[];
    for(const q of qs){
      const url="https://news.google.com/rss/search?q="+encodeURIComponent(q)+"&hl=pt-BR&gl=BR&ceid=BR:pt-419";
      const feed=await parser.parseURL(url);
      for(const x of(feed.items||[]).slice(0,5))
        out.push({title:x.title,link:x.link,source:x.creator||"Google News",
          category:q.includes("tecnologia")?"Tecnologia":q.includes("mundo")?"Mundo":"Brasil"});
    }
    res.json({items:out});
  }catch(e){res.status(500).json({error:e.message})}
});

app.use((req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,"0.0.0.0",()=>console.log(`PRIMORIS rodando na porta ${PORT}`));
