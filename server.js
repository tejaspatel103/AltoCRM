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

/* ======================
   PIPELINE STAGES (LOCKED)
====================== */
const PIPELINE_STAGES = [
  "New",
  "Trying",
  "Contacted",
  "Follow-up",
  "Meeting Booked",
  "Proposal",
  "Won",
  "Very Important",
  "Lost",
  "Not Interested",
  "Tired of trying"
];

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (req, res) => {
  res.send("✅ AltoCRM API running");
});

/* ======================
   GET LEADS WITH FILTERS
====================== */
app.get("/api/leads", async (req, res) => {
  try {
    const filters = [];
    const values = [];
    let index = 1;

    for (const [field, value] of Object.entries(req.query)) {
      if (value === "__blank__") {
        filters.push(`(${field} IS NULL OR ${field} = '')`);
      } else {
        filters.push(`${field} = $${index}`);
        values.push(value);
        index++;
      }
    }

    const whereClause =
      filters.length > 0
        ? `AND ${filters.join(" AND ")}`
        : "";

    const query = `
      SELECT *
      FROM leads
      WHERE deleted = false
      ${whereClause}
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("FILTER ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   CREATE LEAD (MINIMAL)
====================== */
app.post("/api/leads", async (req, res) => {
  try {
    const {
      full_name,
      email1,
      company,
      lead_source
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO leads (
        full_name,
        email1,
        company,
        lead_source,
        pipeline
      )
      VALUES ($1, $2, $3, $4, 'New')
      RETURNING *
      `,
      [full_name, email1, company, lead_source]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("CREATE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   UPDATE LEAD (GENERIC)
====================== */
app.patch("/api/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const fields = Object.keys(req.body);

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields provided" });
    }

    const setClause = fields
      .map((field, index) => `${field} = $${index + 1}`)
      .join(", ");

    const values = Object.values(req.body);

    const query = `
      UPDATE leads
      SET ${setClause}, updated_at = now()
      WHERE id = $${fields.length + 1}
      AND deleted = false
      RETURNING *
    `;

    const result = await pool.query(query, [...values, id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("UPDATE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   UPDATE PIPELINE (VALIDATED)
====================== */
app.patch("/api/leads/:id/pipeline", async (req, res) => {
  try {
    const { id } = req.params;
    const { pipeline } = req.body;

    if (!PIPELINE_STAGES.includes(pipeline)) {
      return res.status(400).json({
        error: "Invalid pipeline stage",
        allowed: PIPELINE_STAGES
      });
    }

    const result = await pool.query(
      `
      UPDATE leads
      SET pipeline = $1, updated_at = now()
      WHERE id = $2
      AND deleted = false
      RETURNING *
      `,
      [pipeline, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PIPELINE UPDATE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   PIPELINE SUMMARY (DASHBOARD)
====================== */
app.get("/api/pipeline/summary", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT pipeline, COUNT(*) AS count
      FROM leads
      WHERE deleted = false
      GROUP BY pipeline
      ORDER BY pipeline
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("PIPELINE SUMMARY ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   SOFT DELETE LEAD
====================== */
app.delete("/api/leads/:id", async (req, res) => {
  try {
    await pool.query(
      `
      UPDATE leads
      SET deleted = true, updated_at = now()
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   ACTION LOG
====================== */
app.post("/api/leads/:id/actions", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, action_type, comment, lead_status } = req.body;

    const result = await pool.query(
      `
      INSERT INTO lead_actions (
        lead_id,
        user_id,
        action_type,
        comment,
        lead_status
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [id, user_id, action_type, comment, lead_status]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ACTION LOG ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   ASSIGN USER TO LEAD
====================== */
app.post("/api/leads/:id/assign", async (req, res) => {
  try {
    const { id } = req.params;
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

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
