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
      resultados.push({ necesita: necesidad, red });
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

app.get("/", (req, res) => {
  res.json({ status: "Trueque Backend con Groq AI funcionando" });
});

initDB().then(() => {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
});