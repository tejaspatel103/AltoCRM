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
      filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

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
   CREATE LEAD
====================== */
app.post("/api/leads", async (req, res) => {
  try {
    const { full_name, email1, company, lead_source } = req.body;

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
      .map((field, i) => `${field} = $${i + 1}`)
      .join(", ");

    const values = Object.values(req.body);

    const result = await pool.query(
      `
      UPDATE leads
      SET ${setClause}, updated_at = now()
      WHERE id = $${fields.length + 1}
      AND deleted = false
      RETURNING *
      `,
      [...values, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("UPDATE LEAD ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   UPDATE PIPELINE (SINGLE)
====================== */
app.patch("/api/leads/:id/pipeline", async (req, res) => {
  try {
    const { pipeline } = req.body;

    if (!PIPELINE_STAGES.includes(pipeline)) {
      return res.status(400).json({ error: "Invalid pipeline" });
    }

    const result = await pool.query(
      `
      UPDATE leads
      SET pipeline = $1, updated_at = now()
      WHERE id = $2 AND deleted = false
      RETURNING *
      `,
      [pipeline, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PIPELINE UPDATE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   BULK UPDATE (FIELDS)
====================== */
app.patch("/api/leads/bulk", async (req, res) => {
  try {
    const { ids, filters, updates } = req.body;

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    const setFields = Object.keys(updates);
    const setClause = setFields
      .map((f, i) => `${f} = $${i + 1}`)
      .join(", ");

    const values = Object.values(updates);
    let whereClause = "deleted = false";
    let index = values.length;

    if (ids && ids.length > 0) {
      whereClause += ` AND id = ANY($${index + 1})`;
      values.push(ids);
    }

    if (filters) {
      for (const [field, value] of Object.entries(filters)) {
        if (value === "__blank__") {
          whereClause += ` AND (${field} IS NULL OR ${field} = '')`;
        } else {
          index++;
          whereClause += ` AND ${field} = $${index}`;
          values.push(value);
        }
      }
    }

    const result = await pool.query(
      `
      UPDATE leads
      SET ${setClause}, updated_at = now()
      WHERE ${whereClause}
      RETURNING id
      `,
      values
    );

    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error("BULK UPDATE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   BULK PIPELINE MOVE
====================== */
app.patch("/api/leads/bulk/pipeline", async (req, res) => {
  try {
    const { ids, pipeline } = req.body;

    if (!PIPELINE_STAGES.includes(pipeline)) {
      return res.status(400).json({ error: "Invalid pipeline" });
    }

    const result = await pool.query(
      `
      UPDATE leads
      SET pipeline = $1, updated_at = now()
      WHERE id = ANY($2) AND deleted = false
      `,
      [pipeline, ids]
    );

    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error("BULK PIPELINE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   BULK DELETE
====================== */
app.delete("/api/leads/bulk", async (req, res) => {
  try {
    const { ids } = req.body;

    const result = await pool.query(
      `
      UPDATE leads
      SET deleted = true, updated_at = now()
      WHERE id = ANY($1)
      `,
      [ids]
    );

    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error("BULK DELETE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   BULK ENRICH (AI / HUMAN STUB)
====================== */
app.post("/api/leads/bulk/enrich", async (req, res) => {
  const { ids, mode, fields } = req.body;

  res.json({
    status: "queued",
    mode,
    fields,
    leads: ids?.length || 0
  });
});

/* ======================
   PIPELINE SUMMARY
====================== */
app.get("/api/pipeline/summary", async (req, res) => {
  const result = await pool.query(`
    SELECT pipeline, COUNT(*) AS count
    FROM leads
    WHERE deleted = false
    GROUP BY pipeline
  `);
  res.json(result.rows);
});

/* ======================
   DASHBOARD ENDPOINTS
====================== */
app.get("/api/dashboard/pipeline", async (_, res) => {
  const result = await pool.query(`
    SELECT * FROM leads WHERE deleted = false
  `);

  const grouped = {};
  result.rows.forEach(l => {
    grouped[l.pipeline || "Unassigned"] ||= [];
    grouped[l.pipeline || "Unassigned"].push(l);
  });

  res.json(grouped);
});

app.get("/api/dashboard/stats", async (_, res) => {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted=false) AS total,
      COUNT(*) FILTER (WHERE pipeline='Won') AS won,
      COUNT(*) FILTER (WHERE pipeline='Lost') AS lost
    FROM leads
  `);
  res.json(result.rows[0]);
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
