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
   SAFE DB MIGRATION
======================= */
async function migrate() {
  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY
    )
  `);

  // Add missing columns safely
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS full_name TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS company TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);

  // Backward compatibility (older schema used "name")
  await pool.query(`
    UPDATE leads
    SET full_name = name
    WHERE full_name IS NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name='leads' AND column_name='name'
    )
  `);

  // Action log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_log (
      id SERIAL PRIMARY KEY,
      lead_id INT,
      action TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log("✅ DB migrated safely");
}

migrate();

/* =======================
   API
======================= */

app.get("/api/leads", async (_, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM leads WHERE deleted = false ORDER BY id DESC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/leads", async (req, res) => {
  const { full_name, email, company } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO leads (full_name, email, company)
     VALUES ($1,$2,$3)
     RETURNING *`,
    [full_name, email, company]
  );

  res.json(rows[0]);
});

/* ---- DELETE (SOFT) ---- */
app.post("/api/leads/delete", async (req, res) => {
  const { ids } = req.body;

  await pool.query(
    `UPDATE leads SET deleted = true WHERE id = ANY($1::int[])`,
    [ids]
  );

  for (const id of ids) {
    await pool.query(
      `INSERT INTO action_log (lead_id, action) VALUES ($1,'DELETED')`,
      [id]
    );
  }

  res.json({ success: true });
});

/* ---- RESTORE ---- */
app.post("/api/leads/restore", async (req, res) => {
  const { ids } = req.body;

  await pool.query(
    `UPDATE leads SET deleted = false WHERE id = ANY($1::int[])`,
    [ids]
  );

  for (const id of ids) {
    await pool.query(
      `INSERT INTO action_log (lead_id, action) VALUES ($1,'RESTORED')`,
      [id]
    );
  }

  res.json({ success: true });
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
