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
      model: "llama3-8b-8192",
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
    if (texto.toLowerCase().includes("ninguno")) return [];
    const indices = texto.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    return indices.map(i => candidatos[i]).filter(Boolean);
  } catch (err) {
    console.error("Error Groq:", err);
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
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Base de datos lista");
}

async function buscarRed(emailOrigen, origenOfrece, necesita, visitados = [], cadena = [], profundidad = 0) {
  if (profundidad > 5) return null;

  const { rows: candidatos } = await pool.query(
    `SELECT u.email, u.telefono, u.nombre, u.foto, s_ofrece.nombre as ofrece, s_necesita.nombre as necesita
     FROM usuarios u
     JOIN servicios s_ofrece ON u.email = s_ofrece.email AND s_ofrece.tipo = 'ofrece' AND s_ofrece.estado = 'activo'
     JOIN servicios s_necesita ON u.email = s_necesita.email AND s_necesita.tipo = 'necesita' AND s_necesita.estado = 'activo'
     WHERE u.email != ALL($1)`,
    [[emailOrigen, ...visitados]]
  );

  const coincidentes = await encontrarCandidatosSemanticos(necesita, candidatos);

  for (const candidato of coincidentes) {
    const nuevaEntrada = {
      email: candidato.email,
      servicio: candidato.ofrece,
      telefono: candidato.telefono || "",
      nombre: candidato.nombre || "",
      foto: candidato.foto || ""
    };
    const nuevosVisitados = [...visitados, candidato.email];
    const nuevaCadena = [...cadena, nuevaEntrada];

    const cierraMatch = await encontrarCandidatosSemanticos(origenOfrece, [{ ofrece: candidato.necesita }]);
    if (cierraMatch.length > 0) return nuevaCadena;

    const redProfunda = await buscarRed(emailOrigen, origenOfrece, candidato.necesita, nuevosVisitados, nuevaCadena, profundidad + 1);
    if (redProfunda) return redProfunda;
  }
  return null;
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
    await pool.query(`DELETE FROM servicios WHERE email = $1`, [email]);
    await pool.query(
      `INSERT INTO servicios (email, tipo, nombre, estado) VALUES ($1, 'ofrece', $2, 'activo'), ($1, 'necesita', $3, 'activo')`,
      [email, ofrece, necesita]
    );

    const cadenaInicial = [{ email, servicio: necesita, telefono: telefono || "", nombre: nombre || "", foto: foto || "" }];
    const red = await buscarRed(email, ofrece, necesita, [email], cadenaInicial);

    if (red) {
      res.json({ encontrada: true, red });
    } else {
      res.json({ encontrada: false, red: [] });
    }
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

app.get("/", (req, res) => {
  res.json({ status: "Trueque Backend con Groq AI funcionando" });
});

initDB().then(() => {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));
});  