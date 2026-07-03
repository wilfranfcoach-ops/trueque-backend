const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Groq = require("groq-sdk");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const crypto = require("crypto");
const PRECIO_RED_COP = 5000; // lo que paga cada persona por cada red que se le forme
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY;
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET;
const WOMPI_API_BASE = (WOMPI_PUBLIC_KEY || "").includes("test")
  ? "https://sandbox.wompi.co/v1"
  : "https://production.wompi.co/v1";
const wompiHabilitado = WOMPI_PUBLIC_KEY && WOMPI_PRIVATE_KEY && WOMPI_INTEGRITY_SECRET;

// Genera la "firma" que identifica una red especifica para un usuario (debe coincidir
// exactamente con la logica del frontend, para saber si esa red en particular ya se pago)
function firmaRedServidor(necesita, redArray) {
  const emails = redArray.map(p => p.email).sort().join(",");
  return `${necesita}::${emails}`;
}

const { Resend } = require("resend");
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const webpush = require("web-push");
const pushHabilitado = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
if (pushHabilitado) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:soporte@truequedefavores.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function enviarPush(emailDestino, payload) {
  if (!pushHabilitado) {
    console.log("VAPID keys no configuradas, se omite notificacion push");
    return;
  }
  try {
    const { rows: subs } = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE email = $1`,
      [emailDestino]
    );
    for (const sub of subs) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log(`Push enviado a ${emailDestino}`);
      } catch (err) {
        console.error(`Error enviando push a suscripcion ${sub.id}:`, err.statusCode, err.message);
        // 404/410 = la suscripcion ya no es valida (usuario desinstalo, expiro, etc.)
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        }
      }
    }
  } catch (err) {
    console.error("Error general enviando push:", err.message);
  }
}

async function enviarEmailRed(emailDestino, redes) {
  if (!resend) {
    console.log("RESEND_API_KEY no configurada, se omite envío de email");
    return;
  }
  if (!emailDestino || !redes || redes.length === 0) return;

  try {
    const bloques = redes.map(r => {
      const nombres = r.red.map(p => p.nombre || p.email.split("@")[0]).join(" → ");
      return `<p><strong>Para lo que necesitas (${r.necesita}):</strong><br/>${nombres} → tú</p>`;
    }).join("<hr/>");

    const { data, error } = await resend.emails.send({
      from: "Trueque de Favores <onboarding@resend.dev>",
      to: emailDestino,
      subject: redes.length === 1 ? "🎉 Se formó una red de trueque para ti" : `🎉 Se formaron ${redes.length} redes de trueque para ti`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#0f3460;">¡Tienes una red de trueque activa!</h2>
          <p>Estas son las cadenas encontradas:</p>
          ${bloques}
          <p style="margin-top:20px;">Entra a la app para ver los detalles de contacto de cada persona.</p>
          <a href="https://legendary-paletas-625914.netlify.app" style="display:inline-block;background:#0f3460;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;margin-top:10px;">Ver mi red</a>
        </div>
      `
    });

    if (error) {
      console.error("Resend devolvio un error:", JSON.stringify(error));
      return;
    }
    console.log(`Email enviado correctamente a ${emailDestino}, id: ${data?.id}`);
  } catch (err) {
    console.error("Error enviando email:", err.message);
  }
}

async function encontrarCandidatosSemanticos(necesita, candidatos) {
  if (candidatos.length === 0) return [];
  try {
    const lista = candidatos.map((c, i) => `${i}: "${c.ofrece}"`).join("\n");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Tengo un usuario que necesita: "${necesita}"
¿Cuáles de estos servicios son equivalentes o muy similares a lo que necesita?
${lista}
Responde SOLO con los números separados por comas, ejemplo: 0,2,3
Si ninguno coincide responde: ninguno`
      }],
      max_tokens: 50
    });
    const texto = completion.choices[0].message.content.trim();
    console.log(`Groq respuesta para "${necesita}": ${texto}`);
    if (texto.toLowerCase().includes("ninguno")) return [];
    const indices = texto.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    return indices.map(i => candidatos[i]).filter(Boolean);
  } catch (err) {
    console.error("Error Groq:", err.message);
    return candidatos.filter(c =>
      c.ofrece.toLowerCase().includes(necesita.toLowerCase()) ||
      necesita.toLowerCase().includes(c.ofrece.toLowerCase())
    );
  }
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      email TEXT PRIMARY KEY,
      nombre TEXT,
      telefono TEXT,
      foto TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS servicios (
      id SERIAL PRIMARY KEY,
      email TEXT REFERENCES usuarios(email),
      tipo TEXT CHECK (tipo IN ('ofrece', 'necesita')),
      nombre TEXT,
      estado TEXT DEFAULT 'activo',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (email, tipo, nombre)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      email TEXT REFERENCES usuarios(email),
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pagos_red (
      id SERIAL PRIMARY KEY,
      email TEXT REFERENCES usuarios(email),
      firma TEXT NOT NULL,
      referencia TEXT UNIQUE NOT NULL,
      estado TEXT DEFAULT 'pendiente',
      transaction_id TEXT,
      monto INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Base de datos lista");
}

// ofertasOrigen: lista de TODOS los servicios que ofrece el usuario origen (no solo uno)
async function buscarRed(emailOrigen, ofertasOrigen, necesitaActual, visitados = [], cadena = [], profundidad = 0) {
  if (profundidad > 6) return null;

  console.log(`Profundidad ${profundidad}: buscando quien ofrece "${necesitaActual}"`);

  // IMPORTANTE: se busca solo por lo que la gente OFRECE, sin cruzar con sus necesidades.
  // Cruzar ofrece x necesita en la misma consulta genera combinaciones falsas cuando
  // alguien tiene varios servicios (ej: "ofrece Lavar carro" no tiene relación real
  // con "necesita Contabilidad" solo porque son del mismo usuario).
  const { rows: ofertantes } = await pool.query(
    `SELECT DISTINCT u.email, u.telefono, u.nombre, u.foto, s.nombre as ofrece
     FROM usuarios u
     JOIN servicios s ON u.email = s.email AND s.tipo = 'ofrece' AND s.estado = 'activo'
     WHERE u.email != ALL($1)`,
    [[emailOrigen, ...visitados]]
  );

  console.log(`Ofertantes encontrados: ${ofertantes.length}`);

  const coincidentes = await encontrarCandidatosSemanticos(necesitaActual, ofertantes);
  console.log(`Coincidentes semanticos: ${coincidentes.length}`);

  for (const candidato of coincidentes) {
    // Se traen TODAS las necesidades activas reales de este candidato (no una sola cruzada al azar)
    const { rows: necesidadesCandidato } = await pool.query(
      `SELECT nombre FROM servicios WHERE email = $1 AND tipo = 'necesita' AND estado = 'activo'`,
      [candidato.email]
    );
    if (necesidadesCandidato.length === 0) continue; // no tiene necesidades activas, no puede continuar la cadena

    const nuevaEntrada = {
      email: candidato.email,
      servicio: candidato.ofrece,
      telefono: candidato.telefono || "",
      nombre: candidato.nombre || "",
      foto: candidato.foto || ""
    };
    const nuevosVisitados = [...visitados, candidato.email];
    const nuevaCadena = [...cadena, nuevaEntrada];

    // 1) Antes de profundizar, se revisa si CUALQUIERA de las necesidades de este
    // candidato cierra directo con CUALQUIERA de los servicios que ofrece el origen.
    for (const nec of necesidadesCandidato) {
      const cierre = await encontrarCandidatosSemanticos(
        nec.nombre,
        ofertasOrigen.map(o => ({ ofrece: o }))
      );
      if (cierre.length > 0) {
        console.log(`RED CERRADA con ${candidato.email} (origen ofrece: ${cierre[0].ofrece})`);
        nuevaCadena[0] = { ...nuevaCadena[0], servicio: cierre[0].ofrece };
        return nuevaCadena;
      }
    }

    // 2) Si no cerró directo, se intenta profundizar usando cada una de sus necesidades
    for (const nec of necesidadesCandidato) {
      const redProfunda = await buscarRed(
        emailOrigen,
        ofertasOrigen,
        nec.nombre,
        nuevosVisitados,
        nuevaCadena,
        profundidad + 1
      );
      if (redProfunda) return redProfunda;
    }
  }
  return null;
}

// Busca redes para TODOS los servicios activos ("necesita") del usuario, no solo el último ingresado
async function buscarRedesUsuario(email) {
  const { rows: serviciosActivos } = await pool.query(
    `SELECT tipo, nombre FROM servicios WHERE email = $1 AND estado = 'activo'`,
    [email]
  );
  const ofertas = serviciosActivos.filter(s => s.tipo === "ofrece").map(s => s.nombre);
  const necesidades = serviciosActivos.filter(s => s.tipo === "necesita").map(s => s.nombre);

  if (ofertas.length === 0 || necesidades.length === 0) {
    return [];
  }

  const { rows: usuarioRows } = await pool.query(
    `SELECT telefono, nombre, foto FROM usuarios WHERE email = $1`,
    [email]
  );
  const datosUsuario = usuarioRows[0] || {};

  const resultados = [];
  for (const necesidad of necesidades) {
    const cadenaInicial = [{
      email,
      servicio: "",
      telefono: datosUsuario.telefono || "",
      nombre: datosUsuario.nombre || "",
      foto: datosUsuario.foto || ""
    }];
    const red = await buscarRed(email, ofertas, necesidad, [email], cadenaInicial);
    if (red) {
      const firma = firmaRedServidor(necesidad, red);

      let pagado = !wompiHabilitado; // si Wompi no esta configurado, no se bloquea nada (modo de prueba)
      if (wompiHabilitado) {
        const { rows: pagoRows } = await pool.query(
          `SELECT estado FROM pagos_red WHERE email = $1 AND firma = $2 AND estado = 'pagado' LIMIT 1`,
          [email, firma]
        );
        pagado = pagoRows.length > 0;
      }

      // Si no ha pagado, se bloquean los datos de contacto de todos menos del propio usuario (indice 0)
      const redParaMostrar = pagado
        ? red
        : red.map((p, i) => i === 0 ? p : { ...p, telefono: "🔒", email: "🔒 Paga para ver" });

      resultados.push({ necesita: necesidad, red: redParaMostrar, firma, pagado, precio: PRECIO_RED_COP });
    }
  }
  return resultados;
}

app.post("/buscar-red", async (req, res) => {
  const { email, ofrece, necesita, telefono, foto, nombre } = req.body;
  if (!email || !ofrece || !necesita) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    await pool.query(
      `INSERT INTO usuarios (email, telefono, foto, nombre) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET telefono = EXCLUDED.telefono, foto = EXCLUDED.foto, nombre = EXCLUDED.nombre`,
      [email, telefono || null, foto || null, nombre || null]
    );

    // Se agrega el nuevo par sin borrar los servicios anteriores del usuario
    await pool.query(
      `INSERT INTO servicios (email, tipo, nombre, estado) VALUES ($1, 'ofrece', $2, 'activo'), ($1, 'necesita', $3, 'activo')
       ON CONFLICT (email, tipo, nombre) DO UPDATE SET estado = 'activo'`,
      [email, ofrece, necesita]
    );

    // Se buscan redes para TODOS los servicios activos del usuario, no solo el recién ingresado
    const redes = await buscarRedesUsuario(email);

    if (redes.length > 0) {
      enviarEmailRed(email, redes); // no se espera (fire-and-forget), no debe bloquear la respuesta
      enviarPush(email, {
        title: redes.length === 1 ? "🎉 Se formó una red de trueque" : `🎉 Se formaron ${redes.length} redes de trueque`,
        body: "Toca para ver los detalles de contacto",
        url: "/"
      });
    }

    res.json({ redes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// Consultar las redes disponibles del usuario sin necesidad de agregar un servicio nuevo
app.get("/mis-redes/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const redes = await buscarRedesUsuario(email);
    res.json({ redes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.get("/mis-servicios/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.tipo, s.nombre, s.estado, u.telefono
       FROM servicios s
       JOIN usuarios u ON s.email = u.email
       WHERE s.email = $1
       ORDER BY s.created_at DESC`,
      [email]
    );
    res.json({ servicios: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.patch("/servicio/:id/estado", async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  try {
    await pool.query(`UPDATE servicios SET estado = $1 WHERE id = $2`, [estado, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.delete("/servicio/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM servicios WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- Opción B: teléfono manejado por nuestra propia app, sin depender de Clerk ---

app.get("/usuario/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT email, nombre, telefono, foto FROM usuarios WHERE email = $1`,
      [email]
    );
    res.json({ usuario: rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.post("/usuario", async (req, res) => {
  const { email, telefono, foto, nombre } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Falta email" });
  }
  try {
    await pool.query(
      `INSERT INTO usuarios (email, telefono, foto, nombre) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET
         telefono = EXCLUDED.telefono,
         foto = COALESCE(EXCLUDED.foto, usuarios.foto),
         nombre = COALESCE(EXCLUDED.nombre, usuarios.nombre)`,
      [email, telefono || null, foto || null, nombre || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- Pagos con Wompi (cobro unico por cada red formada) ---

app.post("/crear-pago-red", async (req, res) => {
  if (!wompiHabilitado) {
    return res.status(400).json({ error: "Los pagos no estan configurados todavia" });
  }
  const { email, firma, necesita } = req.body;
  if (!email || !firma) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const referencia = `red-${crypto.randomBytes(6).toString("hex")}-${Date.now()}`;
    const amountInCents = PRECIO_RED_COP * 100;
    const cadena = `${referencia}${amountInCents}COP${WOMPI_INTEGRITY_SECRET}`;
    const signature = crypto.createHash("sha256").update(cadena).digest("hex");

    await pool.query(
      `INSERT INTO pagos_red (email, firma, referencia, estado, monto) VALUES ($1, $2, $3, 'pendiente', $4)`,
      [email, firma, referencia, PRECIO_RED_COP]
    );

    res.json({
      reference: referencia,
      amountInCents,
      currency: "COP",
      publicKey: WOMPI_PUBLIC_KEY,
      signature
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.get("/confirmar-pago/:transactionId", async (req, res) => {
  if (!wompiHabilitado) {
    return res.status(400).json({ error: "Los pagos no estan configurados todavia" });
  }
  const { transactionId } = req.params;
  try {
    const respuesta = await fetch(`${WOMPI_API_BASE}/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` }
    });
    const datos = await respuesta.json();
    const transaccion = datos.data;

    if (!transaccion) {
      return res.status(404).json({ estado: "no_encontrado" });
    }

    if (transaccion.status === "APPROVED") {
      await pool.query(
        `UPDATE pagos_red SET estado = 'pagado', transaction_id = $1 WHERE referencia = $2`,
        [transactionId, transaccion.reference]
      );
      return res.json({ estado: "pagado" });
    }

    if (transaccion.status === "DECLINED" || transaccion.status === "ERROR" || transaccion.status === "VOIDED") {
      await pool.query(
        `UPDATE pagos_red SET estado = 'fallido', transaction_id = $1 WHERE referencia = $2`,
        [transactionId, transaccion.reference]
      );
      return res.json({ estado: "fallido" });
    }

    res.json({ estado: "pendiente" });
  } catch (err) {
    console.error("Error confirmando pago:", err.message);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "Trueque Backend con Groq AI funcionando" });
});

// --- Notificaciones push reales (badge fuera de la app, como WhatsApp) ---

app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

app.post("/push-subscribe", async (req, res) => {
  const { email, subscription } = req.body;
  if (!email || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "Datos de suscripcion incompletos" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET email = EXCLUDED.email, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [email, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

initDB().then(() => {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
});