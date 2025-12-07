import express from "express";
import cors from "cors";
import pkg from "pg";

const { Pool } = pkg;

const app = express();

/* ======================
   MIDDLEWARE
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   DATABASE
====================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const LEADS_TABLE = `"Leads_value"`;

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (req, res) => {
  res.send("✅ AltoCRM API running");
});

/* ======================
   GET ALL LEADS
====================== */
app.get("/api/leads", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM ${LEADS_TABLE} ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET LEADS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   CREATE LEAD
====================== */
app.post("/api/leads", async (req, res) => {
  try {
    const {
      full_name,
      company,
      email1,
      phone1,
      pipeline,
      lead_source
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO ${LEADS_TABLE}
      (full_name, company, email1, phone1, pipeline, lead_source)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [full_name, company, email1, phone1, pipeline, lead_source]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("CREATE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   DELETE LEAD
====================== */
app.delete("/api/leads/:id", async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM ${LEADS_TABLE} WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE LEAD ERROR:", err.message);
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
