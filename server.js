const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static("public"));

/* ----------------------------------
   Health check
---------------------------------- */
app.get("/health", async (req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------------
   FETCH CRM FIELD DEFINITIONS ✅✅
---------------------------------- */
app.get("/api/fields", async (req, res) => {
  const result = await pool.query(`
    SELECT *
    FROM fields
    WHERE hidden = false
    ORDER BY order_index
  `);
  res.json(result.rows);
});

/* ----------------------------------
   FETCH LEADS + VALUES ✅✅
---------------------------------- */
app.get("/api/leads", async (req, res) => {
  const leads = await pool.query(`SELECT * FROM leads ORDER BY created_at DESC`);
  const values = await pool.query(`SELECT * FROM leads_value`);
  res.json({
    leads: leads.rows,
    values: values.rows
  });
});

/* ----------------------------------
   CREATE NEW LEAD
---------------------------------- */
app.post("/api/leads", async (req, res) => {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO leads (id, created_at) VALUES ($1, now())`,
    [id]
  );
  res.json({ id });
});

/* ----------------------------------
   DELETE LEAD (SOFT SAFE)
---------------------------------- */
app.delete("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM leads_value WHERE lead_id = $1", [id]);
  await pool.query("DELETE FROM action_log WHERE lead_id = $1", [id]);
  await pool.query("DELETE FROM leads WHERE id = $1", [id]);
  res.json({ success: true });
});

/* ----------------------------------
   SPA fallback
---------------------------------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ----------------------------------
   Start server
---------------------------------- */
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
