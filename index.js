const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

// ─── RUTAS DE DATOS ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const CONTACTOS_FILE = path.join(DATA_DIR, "contactos.json");
const MENSAJE_FILE = path.join(DATA_DIR, "mensaje.json");
const HISTORIAL_FILE = path.join(DATA_DIR, "historial.json");

const leer = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const escribir = (file, data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ─── ESTADO DEL BOT ───────────────────────────────────────────────────────────
let botStatus = "desconectado";
let qrActual = null;
let client = null;

// ─── CREAR CLIENTE ────────────────────────────────────────────────────────────
function crearCliente() {
  const c = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        "/usr/bin/google-chrome-stable",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });

  c.on("qr", async (qr) => {
    console.log("QR generado");
    qrcode.generate(qr, { small: true });
    qrActual = qr;
    botStatus = "esperando_qr";
  });

  c.on("ready", () => {
    console.log("WhatsApp listo 🚀");
    botStatus = "listo";
    qrActual = null;
  });

  c.on("disconnected", (reason) => {
    console.log("WhatsApp desconectado:", reason);
    botStatus = "desconectado";
    qrActual = null;
    // Reiniciar después de 5 segundos
    console.log("Reiniciando en 5 segundos...");
    setTimeout(() => {
      try {
        client = crearCliente();
        client
          .initialize()
          .catch((err) => console.error("Error al reiniciar:", err.message));
      } catch (err) {
        console.error("Error al crear cliente:", err.message);
      }
    }, 5000);
  });

  // Atrapar errores no capturados del cliente
  c.on("auth_failure", (msg) => {
    console.error("Error de autenticación:", msg);
    botStatus = "desconectado";
  });

  return c;
}

// Atrapar crashes globales para que el proceso no muera
process.on("uncaughtException", (err) => {
  console.error("Error no capturado:", err.message);
  botStatus = "desconectado";
});

process.on("unhandledRejection", (reason) => {
  console.error("Promesa rechazada:", reason?.message || reason);
});

// Inicializar
client = crearCliente();
client
  .initialize()
  .catch((err) => console.error("Error al inicializar:", err.message));

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
      const numero = `${contacto.numero}@c.us`;
      await client.sendMessage(numero, mensaje);
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
// API ROUTES
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
