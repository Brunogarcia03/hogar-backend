const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const dataPath = (file) => path.join(__dirname, "../data", file);
const read = (file) => JSON.parse(fs.readFileSync(dataPath(file), "utf8"));
const write = (file, data) =>
  fs.writeFileSync(dataPath(file), JSON.stringify(data, null, 2));

// ─── ESTADO DEL BOT ────────────────────────────────────────────────────────
router.get("/estado", (req, res) => {
  const { getBotStatus, getQR } = require("../index");
  res.json({ status: getBotStatus(), qr: getQR() });
});

// ─── CONTACTOS ─────────────────────────────────────────────────────────────
router.get("/contactos", (req, res) => {
  res.json(read("contactos.json"));
});

router.post("/contactos", (req, res) => {
  const { nombre, numero } = req.body;
  if (!nombre || !numero)
    return res.status(400).json({ error: "Faltan campos" });

  const contactos = read("contactos.json");
  const nuevo = { id: Date.now(), nombre, numero: numero.replace(/\D/g, "") };
  contactos.push(nuevo);
  write("contactos.json", contactos);
  res.json(nuevo);
});

router.delete("/contactos/:id", (req, res) => {
  let contactos = read("contactos.json");
  contactos = contactos.filter((c) => c.id !== parseInt(req.params.id));
  write("contactos.json", contactos);
  res.json({ ok: true });
});

// ─── MENSAJE ───────────────────────────────────────────────────────────────
router.get("/mensaje", (req, res) => {
  res.json(read("mensaje.json"));
});

router.put("/mensaje", (req, res) => {
  const { texto, diaEnvio, horaEnvio } = req.body;
  if (!texto || !diaEnvio || !horaEnvio)
    return res.status(400).json({ error: "Faltan campos" });

  const data = { texto, diaEnvio: parseInt(diaEnvio), horaEnvio };
  write("mensaje.json", data);

  // Reiniciar el cron con la nueva configuración
  const { reiniciarCron } = require("../index");
  reiniciarCron();

  res.json(data);
});

// ─── HISTORIAL ─────────────────────────────────────────────────────────────
router.get("/historial", (req, res) => {
  const historial = read("historial.json");
  res.json(historial.reverse()); // más reciente primero
});

router.delete("/historial", (req, res) => {
  write("historial.json", []);
  res.json({ ok: true });
});

// ─── ENVÍO MANUAL ──────────────────────────────────────────────────────────
router.post("/enviar", async (req, res) => {
  const { enviarMensajes } = require("../index");
  try {
    await enviarMensajes();
    res.json({ ok: true, mensaje: "Mensajes enviados correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
