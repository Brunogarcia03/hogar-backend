const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const pino = require("pino");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

// ─── RUTAS DE DATOS ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const CONTACTOS_FILE = path.join(DATA_DIR, "contactos.json");
const MENSAJE_FILE = path.join(DATA_DIR, "mensaje.json");
const HISTORIAL_FILE = path.join(DATA_DIR, "historial.json");

// Carpeta donde Baileys guarda la sesión vinculada (credenciales + claves).
// IMPORTANTE: en Railway esto tiene que vivir en un Volume persistente,
// si no cada redeploy borra la sesión y hay que volver a escanear el QR.
const AUTH_FOLDER =
  process.env.AUTH_FOLDER || path.join(__dirname, "auth_info_baileys");

const leer = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const escribir = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ─── ESTADO DEL BOT ───────────────────────────────────────────────────────────
let botStatus = "desconectado"; // "desconectado" | "esperando_qr" | "listo"
let qrActual = null;
let sock = null;

// ─── CREAR / RECONECTAR SOCKET ────────────────────────────────────────────────
async function iniciarSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }), // Baileys requiere un logger (pino)
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR generado");
      qrActual = qr;
      botStatus = "esperando_qr";
    }

    if (connection === "open") {
      console.log("WhatsApp listo 🚀");
      botStatus = "listo";
      qrActual = null;
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const sesionCerrada = statusCode === DisconnectReason.loggedOut;

      botStatus = "desconectado";
      qrActual = null;

      if (sesionCerrada) {
        // El usuario desvinculó el dispositivo desde el teléfono: hay que
        // borrar la sesión guardada y esperar un nuevo QR.
        console.log("Sesión cerrada desde el teléfono. Hay que reescanear el QR.");
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      } else {
        console.log("Conexión cerrada, reconectando en 5 segundos...");
      }

      setTimeout(() => {
        iniciarSock().catch((err) =>
          console.error("Error al reconectar:", err.message),
        );
      }, 5000);
    }
  });

  return sock;
}

// Atrapar crashes globales para que el proceso no muera
process.on("uncaughtException", (err) => {
  console.error("Error no capturado:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Promesa rechazada:", reason?.message || reason);
});

// Inicializar
iniciarSock().catch((err) =>
  console.error("Error al inicializar:", err.message),
);

// ─── FUNCIÓN DE ENVÍO ─────────────────────────────────────────────────────────
const enviarMensajes = async () => {
  if (botStatus !== "listo") {
    console.log("Bot no está listo, cancelando envío");
    return;
  }

  const contactos = leer(CONTACTOS_FILE);
  const { texto } = leer(MENSAJE_FILE);
  const historial = leer(HISTORIAL_FILE);
  const fecha = new Date().toLocaleDateString("es-AR");
  const mensaje = texto.replace("{{fecha}}", fecha);

  const resultado = {
    id: Date.now(),
    fecha: new Date().toISOString(),
    enviados: [],
    fallidos: [],
  };

  for (const contacto of contactos) {
    try {
      const jid = `${contacto.numero}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: mensaje });
      console.log(`✅ Enviado a ${contacto.nombre}`);
      resultado.enviados.push({
        nombre: contacto.nombre,
        numero: contacto.numero,
      });
      await new Promise((res) => setTimeout(res, 20000));
    } catch (err) {
      console.error(`❌ Error con ${contacto.nombre}:`, err.message);
      resultado.fallidos.push({
        nombre: contacto.nombre,
        numero: contacto.numero,
        error: err.message,
      });
    }
  }

  historial.unshift(resultado);
  escribir(HISTORIAL_FILE, historial.slice(0, 100));
  console.log("Envío completado");
};

// ─── CRON (día 10 a las 10:00) ────────────────────────────────────────────────
cron.schedule("0 10 10 * *", () => {
  console.log("Cron disparado");
  enviarMensajes();
});

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES (mismo contrato que antes, el frontend no cambia)
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/api/status", async (req, res) => {
  let qrImagen = null;
  if (qrActual) {
    try {
      qrImagen = await QRCode.toDataURL(qrActual);
    } catch {}
  }
  res.json({ status: botStatus, qr: qrImagen });
});

// ─── CONTACTOS ────────────────────────────────────────────────────────────────
app.get("/api/contactos", (req, res) => {
  res.json(leer(CONTACTOS_FILE));
});

app.post("/api/contactos", (req, res) => {
  const { nombre, numero } = req.body;
  if (!nombre || !numero)
    return res.status(400).json({ error: "Nombre y número requeridos" });
  const contactos = leer(CONTACTOS_FILE);
  const nuevo = { id: Date.now(), nombre, numero: numero.replace(/\D/g, "") };
  contactos.push(nuevo);
  escribir(CONTACTOS_FILE, contactos);
  res.json(nuevo);
});

app.delete("/api/contactos/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const contactos = leer(CONTACTOS_FILE).filter((c) => c.id !== id);
  escribir(CONTACTOS_FILE, contactos);
  res.json({ ok: true });
});

// ─── MENSAJE ──────────────────────────────────────────────────────────────────
app.get("/api/mensaje", (req, res) => {
  res.json(leer(MENSAJE_FILE));
});

app.put("/api/mensaje", (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ error: "Texto requerido" });
  escribir(MENSAJE_FILE, { texto });
  res.json({ ok: true });
});

// ─── HISTORIAL ────────────────────────────────────────────────────────────────
app.get("/api/historial", (req, res) => {
  res.json(leer(HISTORIAL_FILE));
});

// ─── ENVÍO MANUAL ─────────────────────────────────────────────────────────────
app.post("/api/enviar", async (req, res) => {
  if (botStatus !== "listo") {
    return res
      .status(400)
      .json({ error: "El bot no está conectado a WhatsApp" });
  }
  res.json({ ok: true, mensaje: "Envío iniciado" });
  enviarMensajes();
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
