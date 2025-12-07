import express from "express";
import pkg from "pg";
import cors from "cors";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// DATABASE CONNECTION
// =====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =====================
// CONSTANTS
// =====================
const LEADS_TABLE = `"Leads_value"`;

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.send("✅ AltoCRM API running");
});

// =====================
// GET ALL LEADS
// =====================
app.get("/api/leads", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM ${LEADS_TABLE} ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error("GET LEADS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================
// CREATE LEAD
// =====================
app.post("/api/leads", async (req, res) => {
  try {
    const {
      full_name,
      company,
      email1,
      phone1,
      pipeline,
      lead_source,
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

// =====================
// DELETE LEAD (IMPORTANT FIX)
// =====================
app.delete("/api/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM ${LEADS_TABLE} WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================
// ASSIGN USER TO LEAD
// =====================
app.post("/api/leads/:id/assign", async (req, res) => {
  try {
    const { id } = req.params; // lead id
    const { user_id } = req.body;

    await pool.query(
      `
      INSERT INTO lead_assignments (lead_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [id, user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("ASSIGN LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
