const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Groq = require("groq-sdk");

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

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

// Clave secreta simple para poder aprobar/rechazar verificaciones desde un panel manual
// (mientras no tengas un panel de administración propio). Cambiala en Railway.
const ADMIN_SECRET = process.env.ADMIN_SECRET || "cambia-esta-clave";

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
      acepto_politica BOOLEAN DEFAULT FALSE,
      acepto_politica_at TIMESTAMP,
      verificacion_estado TEXT DEFAULT 'sin_verificar',
      verificacion_imagen TEXT,
      verificacion_actualizada_at TIMESTAMP,
      suspendido BOOLEAN DEFAULT FALSE,
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
    CREATE TABLE IF NOT EXISTS calificaciones (
      id SERIAL PRIMARY KEY,
      email_califica TEXT REFERENCES usuarios(email),
      email_calificado TEXT REFERENCES usuarios(email),
      servicio_id INTEGER,
      estrellas INTEGER CHECK (estrellas BETWEEN 1 AND 5),
      comentario TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reportes (
      id SERIAL PRIMARY KEY,
      email_reporta TEXT REFERENCES usuarios(email),
      email_reportado TEXT REFERENCES usuarios(email),
      motivo TEXT,
      estado TEXT DEFAULT 'pendiente',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS incumplimientos (
      id SERIAL PRIMARY KEY,
      email_reporta TEXT REFERENCES usuarios(email),
      email_incumplido TEXT REFERENCES usuarios(email),
      detalle TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Indices para que la busqueda de redes no tenga que recorrer toda la tabla
    CREATE INDEX IF NOT EXISTS idx_servicios_email_tipo_estado ON servicios (email, tipo, estado);
    CREATE INDEX IF NOT EXISTS idx_servicios_tipo_estado ON servicios (tipo, estado);
  `);
  console.log("Base de datos lista");
}

// ofertasOrigen: lista de TODOS los servicios que ofrece el usuario origen (no solo uno)
async function buscarRed(emailOrigen, ofertasOrigen, necesitaActual, visitados = [], cadena = [], profundidad = 0) {
  if (profundidad > 4) return null; // se bajo de 6 a 4: cadenas mas largas rara vez son practicas y multiplican llamadas a Groq

  console.log(`Profundidad ${profundidad}: buscando quien ofrece "${necesitaActual}"`);

  // IMPORTANTE: se busca solo por lo que la gente OFRECE, sin cruzar con sus necesidades.
  const { rows: ofertantes } = await pool.query(
    `SELECT DISTINCT u.email, u.telefono, u.nombre, u.foto, s.nombre as ofrece
     FROM usuarios u
     JOIN servicios s ON u.email = s.email AND s.tipo = 'ofrece' AND s.estado = 'activo'
     WHERE u.email != ALL($1) AND u.suspendido = FALSE`,
    [[emailOrigen, ...visitados]]
  );

  console.log(`Ofertantes encontrados: ${ofertantes.length}`);

  const coincidentes = await encontrarCandidatosSemanticos(necesitaActual, ofertantes);
  console.log(`Coincidentes semanticos: ${coincidentes.length}`);

  // Se traen de una sola vez las necesidades activas de TODOS los candidatos (antes era 1 consulta por candidato)
  const emailsCandidatos = coincidentes.map(c => c.email);
  let necesidadesPorEmail = {};
  if (emailsCandidatos.length > 0) {
    const { rows: todasNecesidades } = await pool.query(
      `SELECT email, nombre FROM servicios WHERE email = ANY($1) AND tipo = 'necesita' AND estado = 'activo'`,
      [emailsCandidatos]
    );
    necesidadesPorEmail = todasNecesidades.reduce((acc, row) => {
      (acc[row.email] = acc[row.email] || []).push({ nombre: row.nombre });
      return acc;
    }, {});
  }

  for (const candidato of coincidentes) {
    const necesidadesCandidato = necesidadesPorEmail[candidato.email] || [];
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

    // 1) Antes de profundizar, se revisan EN PARALELO todas las necesidades de este
    // candidato contra lo que ofrece el origen, en vez de una llamada a Groq por cada una.
    const cierres = await Promise.all(
      necesidadesCandidato.map(nec =>
        encontrarCandidatosSemanticos(nec.nombre, ofertasOrigen.map(o => ({ ofrece: o })))
      )
    );
    const indiceCierre = cierres.findIndex(c => c.length > 0);
    if (indiceCierre !== -1) {
      console.log(`RED CERRADA con ${candidato.email} (origen ofrece: ${cierres[indiceCierre][0].ofrece})`);
      nuevaCadena[0] = { ...nuevaCadena[0], servicio: cierres[indiceCierre][0].ofrece };
      return nuevaCadena;
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

  // Se buscan todas las necesidades EN PARALELO en vez de una por una (antes era secuencial con await en un for)
  const busquedas = await Promise.all(
    necesidades.map(necesidad => {
      const cadenaInicial = [{
        email,
        servicio: "",
        telefono: datosUsuario.telefono || "",
        nombre: datosUsuario.nombre || "",
        foto: datosUsuario.foto || ""
      }];
      return buscarRed(email, ofertas, necesidad, [email], cadenaInicial).then(red => ({ necesidad, red }));
    })
  );

  const resultados = [];
  for (const { necesidad, red } of busquedas) {
    if (!red) continue;
    const firma = firmaRedServidor(necesidad, red);

    let pagado = !wompiHabilitado; // si Wompi no esta configurado, no se bloquea nada (modo de prueba)
    if (wompiHabilitado) {
      const { rows: pagoRows } = await pool.query(
        `SELECT estado FROM pagos_red WHERE email = $1 AND firma = $2 AND estado = 'pagado' LIMIT 1`,
        [email, firma]
      );
      pagado = pagoRows.length > 0;
    }

    const redParaMostrar = pagado
      ? red
      : red.map((p, i) => i === 0 ? p : { ...p, telefono: "🔒", email: "🔒 Paga para ver" });

    resultados.push({ necesita: necesidad, red: redParaMostrar, firma, pagado, precio: PRECIO_RED_COP });
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
      `SELECT email, nombre, telefono, foto, acepto_politica, verificacion_estado, suspendido FROM usuarios WHERE email = $1`,
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

// --- Política de Uso y Convivencia ---

app.post("/aceptar-politica", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Falta email" });
  try {
    await pool.query(
      `INSERT INTO usuarios (email, acepto_politica, acepto_politica_at) VALUES ($1, TRUE, NOW())
       ON CONFLICT (email) DO UPDATE SET acepto_politica = TRUE, acepto_politica_at = NOW()`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- Verificación de identidad (foto de cédula o selfie) ---
// Nota: guardar la imagen como base64 en la base de datos es funcional para un piloto,
// pero no escala bien. Cuando crezcas, conviene moverlo a un bucket (ej. Cloudflare R2, S3).

app.post("/verificacion", async (req, res) => {
  const { email, imagen } = req.body;
  if (!email || !imagen) return res.status(400).json({ error: "Faltan datos" });
  try {
    await pool.query(
      `INSERT INTO usuarios (email, verificacion_estado, verificacion_imagen, verificacion_actualizada_at)
       VALUES ($1, 'pendiente', $2, NOW())
       ON CONFLICT (email) DO UPDATE SET verificacion_estado = 'pendiente', verificacion_imagen = $2, verificacion_actualizada_at = NOW()`,
      [email, imagen]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// Panel manual muy simple para aprobar/rechazar verificaciones pendientes.
// Entra a https://TU-BACKEND/admin/verificaciones?clave=TU_ADMIN_SECRET desde el navegador.
app.get("/admin/verificaciones", async (req, res) => {
  if (req.query.clave !== ADMIN_SECRET) return res.status(403).send("No autorizado");
  const { rows } = await pool.query(
    `SELECT email, verificacion_imagen, verificacion_actualizada_at FROM usuarios WHERE verificacion_estado = 'pendiente' ORDER BY verificacion_actualizada_at ASC`
  );
  const html = rows.map(r => `
    <div style="border:1px solid #ccc;padding:12px;margin-bottom:12px;max-width:400px;">
      <p><strong>${r.email}</strong></p>
      <img src="${r.verificacion_imagen}" style="max-width:300px;display:block;margin-bottom:8px;" />
      <a href="/admin/verificar?clave=${ADMIN_SECRET}&email=${encodeURIComponent(r.email)}&estado=aprobada">✅ Aprobar</a>
      &nbsp;|&nbsp;
      <a href="/admin/verificar?clave=${ADMIN_SECRET}&email=${encodeURIComponent(r.email)}&estado=rechazada">❌ Rechazar</a>
    </div>
  `).join("") || "<p>No hay verificaciones pendientes.</p>";
  res.send(`<html><body>${html}</body></html>`);
});

app.get("/admin/verificar", async (req, res) => {
  if (req.query.clave !== ADMIN_SECRET) return res.status(403).send("No autorizado");
  const { email, estado } = req.query;
  if (!email || !["aprobada", "rechazada"].includes(estado)) return res.status(400).send("Datos invalidos");
  await pool.query(`UPDATE usuarios SET verificacion_estado = $1 WHERE email = $2`, [estado, email]);
  res.redirect(`/admin/verificaciones?clave=${ADMIN_SECRET}`);
});

// --- Calificaciones (reputación) ---

app.post("/calificar", async (req, res) => {
  const { emailCalifica, emailCalificado, servicioId, estrellas, comentario } = req.body;
  if (!emailCalifica || !emailCalificado || !estrellas) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  try {
    await pool.query(
      `INSERT INTO calificaciones (email_califica, email_calificado, servicio_id, estrellas, comentario)
       VALUES ($1, $2, $3, $4, $5)`,
      [emailCalifica, emailCalificado, servicioId || null, estrellas, comentario || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

app.get("/reputacion/:email", async (req, res) => {
  const { email } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as total, AVG(estrellas)::float as promedio
       FROM calificaciones WHERE email_calificado = $1`,
      [email]
    );
    res.json({ total: rows[0].total, promedio: rows[0].promedio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- Reportes y suspensión automática ---

const REPORTES_PARA_SUSPENDER = 3;

app.post("/reportar", async (req, res) => {
  const { emailReporta, emailReportado, motivo } = req.body;
  if (!emailReporta || !emailReportado || !motivo) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  try {
    await pool.query(
      `INSERT INTO reportes (email_reporta, email_reportado, motivo) VALUES ($1, $2, $3)`,
      [emailReporta, emailReportado, motivo]
    );
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as total FROM reportes WHERE email_reportado = $1`,
      [emailReportado]
    );
    if (rows[0].total >= REPORTES_PARA_SUSPENDER) {
      await pool.query(`UPDATE usuarios SET suspendido = TRUE WHERE email = $1`, [emailReportado]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --- Incumplimientos (no-show) ---

app.post("/incumplimiento", async (req, res) => {
  const { emailReporta, emailIncumplido, detalle } = req.body;
  if (!emailReporta || !emailIncumplido) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  try {
    await pool.query(
      `INSERT INTO incumplimientos (email_reporta, email_incumplido, detalle) VALUES ($1, $2, $3)`,
      [emailReporta, emailIncumplido, detalle || null]
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