import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (req, res) => {
  res.send("✅ AltoCRM API running");
});

/* ======================
   GET LEADS (exclude deleted)
====================== */
app.get("/api/leads", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM leads WHERE deleted = false ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   CREATE LEAD
====================== */
app.post("/api/leads", async (req, res) => {
  try {
    const { full_name, email, company } = req.body;

    const result = await pool.query(
      `
      INSERT INTO leads (full_name, email, company)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [full_name, email, company]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   SOFT DELETE LEAD
====================== */
app.delete("/api/leads/:id", async (req, res) => {
  try {
    await pool.query(
      `UPDATE leads SET deleted = true WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
