const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Crear tablas si no existen
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      email TEXT PRIMARY KEY,
      nombre TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS servicios (
      id SERIAL PRIMARY KEY,
      email TEXT REFERENCES usuarios(email),
      tipo TEXT CHECK (tipo IN ('ofrece', 'necesita')),
      nombre TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("Base de datos lista");
}

async function buscarRed(emailOrigen, origenOfrece, necesita, visitados = [], cadena = [], profundidad = 0) {
  if (profundidad > 5) return null;

  const { rows: candidatos } = await pool.query(
    `SELECT u.email, s_ofrece.nombre as ofrece, s_necesita.nombre as necesita
     FROM usuarios u
     JOIN servicios s_ofrece ON u.email = s_ofrece.email AND s_ofrece.tipo = 'ofrece'
     JOIN servicios s_necesita ON u.email = s_necesita.email AND s_necesita.tipo = 'necesita'
     WHERE LOWER(s_ofrece.nombre) LIKE LOWER($1)
     AND u.email != ALL($2)`,
    [`%${necesita}%`, [emailOrigen, ...visitados]]
  );

  for (const candidato of candidatos) {
    const nuevaEntrada = { email: candidato.email, servicio: candidato.ofrece };
    const nuevosVisitados = [...visitados, candidato.email];
    const nuevaCadena = [...cadena, nuevaEntrada];

    if (candidato.necesita.toLowerCase().includes(origenOfrece.toLowerCase())) {
      return nuevaCadena;
    }

    const redProfunda = await buscarRed(emailOrigen, origenOfrece, candidato.necesita, nuevosVisitados, nuevaCadena, profundidad + 1);
    if (redProfunda) return redProfunda;
  }
  return null;
}

app.post("/buscar-red", async (req, res) => {
  const { email, ofrece, necesita } = req.body;
  if (!email || !ofrece || !necesita) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    // Guardar usuario y servicios
    await pool.query(`INSERT INTO usuarios (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
    await pool.query(`DELETE FROM servicios WHERE email = $1`, [email]);
    await pool.query(`INSERT INTO servicios (email, tipo, nombre) VALUES ($1, 'ofrece', $2), ($1, 'necesita', $3)`, [email, ofrece, necesita]);

    const cadenaInicial = [{ email, servicio: necesita }];
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

app.get("/", (req, res) => {
  res.json({ status: "Trueque Backend con PostgreSQL funcionando" });
});

initDB().then(() => {
  app.listen(4000, () => console.log("Backend corriendo en http://localhost:4000"));
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));