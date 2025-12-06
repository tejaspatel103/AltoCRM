const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false
});

/* =======================
   SAFE BOOT (NO ASSUMPTIONS)
======================= */
async function boot() {
  // Create minimal table ONLY if it does not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY
    )
  `);

  console.log("✅ DB ready (no destructive migrations)");
}

boot();

/* =======================
   API (STABLE BASELINE)
======================= */

// Get all leads (no deleted logic for now)
app.get("/api/leads", async (_, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leads ORDER BY id DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Insert (works with dynamic columns)
app.post("/api/leads", async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    const values = Object.values(req.body);

    const columns = keys.join(",");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(",");

    const { rows } = await pool.query(
      `INSERT INTO leads (${columns}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
