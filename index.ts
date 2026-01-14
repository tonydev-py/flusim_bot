import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WAMessage
} from "@whiskeysockets/baileys"
import P from "pino"
import axios from "axios"
import "dotenv/config"

/* ================= CONFIG ================= */

const GEMINI_KEY = process.env.GEMINI_KEY
if (!GEMINI_KEY) throw new Error("GEMINI_KEY não definida")

const logger = P({ level: "info" })
const usuariosEmUso = new Set<string>()

const PROMPT_SISTEMA = `
Você é um atendente humano educado, profissional e acessível.
Nunca diga que é um robô, IA ou chatbot.

Você trabalha para um serviço que ajuda pequenos negócios e profissionais autônomos
a ganharem tempo, organização e clareza no dia a dia.

O serviço funciona assim:
Primeiro é feito um diagnóstico rápido para entender como a tarefa funciona hoje,
onde estão os gargalos e o que pode ser melhorado.
Depois é criada uma solução sob medida, simples, prática e sem sistemas caros.

As soluções podem envolver:
- Organização de processos
- Automação de tarefas repetitivas
- Padronização de informações
- Apoio para lidar com grandes volumes de dados e textos

O foco não é tecnologia, é resultado:
menos tempo gasto, menos erros e mais clareza no trabalho.

Não existem mensalidades.
Cada caso é analisado individualmente e o cliente decide se quer ou não seguir com a solução.

Seu objetivo é:
- Atender bem
- Explicar com simplicidade
- Gerar confiança
- Eliminar dúvidas
- Convidar para o diagnóstico rápido quando fizer sentido

Nunca pressione o cliente.
Nunca use linguagem de vendedor agressivo.
Sempre converse como uma pessoa real.

Respostas devem ser curtas, claras, naturais e humanas.
Sempre que possível, faça uma pergunta suave para continuar a conversa.
`



/* ================= BOT ================= */

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth")

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut) {
        logger.warn("Reconectando...")
        startBot()
      } else {
        logger.error("Sessão encerrada. Apague a pasta auth.")
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg || !msg.message) return

    // Ignorar mensagens antigas
    if (msg.key.id?.startsWith("BAE5")) return

    // Ignorar mensagens do próprio bot
    if (msg.key.fromMe) return

    const from = msg.key.remoteJid!
    
    // Ignorar grupos
    if (from.endsWith("@g.us")) return

    const text = extrairTexto(msg)
    if (!text) return

    // Anti-spam
    if (usuariosEmUso.has(from)) return
    usuariosEmUso.add(from)

    try {
      await delayHumano()
      await sock.sendPresenceUpdate("composing", from)

      const resposta = await respostaIA(text)
      const partes = dividirMensagem(resposta)

      for (const parte of partes) {
        await sock.sendMessage(from, { text: parte })
      }

    } catch (err) {
      if (err instanceof Error) {
        logger.error({ err }, "Erro ao responder")
      } else {
        logger.error({ err }, "Erro desconhecido ao responder")
      }

      await sock.sendMessage(from, {
        text: "Tive um probleminha aqui 😅 tenta novamente."
      })
    } finally {
      setTimeout(() => usuariosEmUso.delete(from), 15000)
    }
  })
}

/* ================= IA ================= */

async function respostaIA(pergunta: string): Promise<string> {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: PROMPT_SISTEMA + "\nUsuário: " + pergunta }]
          }
        ]
      },
      { timeout: 15000 }
    )

    const text =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text

    return ajustarResposta(text || "Não consegui responder agora 😕")

  } catch (err: any) {
    logger.error(
      { err: err.response?.data || err.message },
      "Erro Gemini"
    )
    return "Me explica melhor pra eu conseguir te ajudar 😊"
  }
}

/* ================= UTIL ================= */

function extrairTexto(msg: WAMessage): string {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ""
  )
}

function ajustarResposta(texto: string): string {
  return texto
    .replace(/\n{2,}/g, "\n")
    .trim()
}

function dividirMensagem(texto: string, limite = 600): string[] {
  return texto.match(new RegExp(`.{1,${limite}}`, "g")) || []
}

function delayHumano(): Promise<void> {
  const tempo = Math.floor(Math.random() * 4000) + 3000
  return new Promise(resolve => setTimeout(resolve, tempo))
}

/* ================= START ================= */

startBot()
