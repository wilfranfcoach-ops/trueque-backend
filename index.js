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

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      email TEXT PRIMARY KEY,
      nombre TEXT,
      telefono TEXT,
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
    `SELECT u.email, u.telefono, s_ofrece.nombre as ofrece, s_necesita.nombre as necesita
     FROM usuarios u
     JOIN servicios s_ofrece ON u.email = s_ofrece.email AND s_ofrece.tipo = 'ofrece'
     JOIN servicios s_necesita ON u.email = s_necesita.email AND s_necesita.tipo = 'necesita'
     WHERE LOWER(s_ofrece.nombre) LIKE LOWER($1)
     AND u.email != ALL($2)`,
    [`%${necesita}%`, [emailOrigen, ...visitados]]
  );

  for (const candidato of candidatos) {
    const