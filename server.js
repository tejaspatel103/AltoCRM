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
   AI HELPERS (STUB – SAFE)
====================== */
function aiSuggestLead(lead) {
  const first = lead.full_name?.split(" ")[0] || null;
  const last = lead.full_name?.split(" ").slice(1).join(" ") || null;

  return {
    suggestions: {
      first_name: first,
      last_name: last,
      company_short: lead.company ? lead.company.split(" ")[0] : null,
      linkedin_url: null,
      website: null,
      city: null,
      state: null
    },
    confidence: {
      first_name: 0.9,
      last_name: 0.9,
      company_short: 0.7,
      linkedin_url: 0.4
    }
  };
}

function aiScoreLead(lead) {
  let score = 10;
  const reasons = [];

  if (!lead.email1) {
    score -= 2;
    reasons.push("Missing email");
  }
  if (!lead.company) {
    score -= 2;
    reasons.push("Missing company");
  }
  if (!lead.linkedin_url) {
    score -= 2;
    reasons.push("Missing LinkedIn");
  }

  return {
    score: Math.max(score, 1),
    reasons
  };
}

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* ======================
   GET LEADS WITH FILTERS
====================== */
app.get("/api/leads", async (req, res) => {
  try {
    const filters = [];
    const values = [];
    let i = 1;

    for (const [field, value] of Object.entries(req.query)) {
      if (value === "__blank__") {
        filters.push(`(${field} IS NULL OR ${field} = '')`);
      } else {
        filters.push(`${field} = $${i++}`);
        values.push(value);
      }
    }

    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `
      SELECT *
      FROM leads
      WHERE deleted = false
      ${where}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   CREATE LEAD
====================== */
app.post("/api/leads", async (req, res) => {
  const { full_name, email1, company, lead_source } = req.body;

  const { rows } = await pool.query(
    `
    INSERT INTO leads (full_name, email1, company, lead_source, pipeline)
    VALUES ($1, $2, $3, $4, 'New')
    RETURNING *
    `,
    [full_name, email1, company, lead_source]
  );

  res.json(rows[0]);
});

/* ======================
   UPDATE LEAD
====================== */
app.patch("/api/leads/:id", async (req, res) => {
  const fields = Object.keys(req.body);
  if (!fields.length) return res.status(400).json({ error: "No fields" });

  const set = fields.map((f, i) => `${f}=$${i + 1}`).join(", ");
  const values = Object.values(req.body);

  const { rows } = await pool.query(
    `
    UPDATE leads
    SET ${set}, updated_at = now()
    WHERE id = $${fields.length + 1}
    AND deleted = false
    RETURNING *
    `,
    [...values, req.params.id]
  );

  res.json(rows[0]);
});

/* ======================
   PIPELINE (SINGLE)
====================== */
app.patch("/api/leads/:id/pipeline", async (req, res) => {
  if (!PIPELINE_STAGES.includes(req.body.pipeline)) {
    return res.status(400).json({ error: "Invalid pipeline" });
  }

  const { rows } = await pool.query(
    `
    UPDATE leads
    SET pipeline=$1, updated_at=now()
    WHERE id=$2 AND deleted=false
    RETURNING *
    `,
    [req.body.pipeline, req.params.id]
  );

  res.json(rows[0]);
});

/* ======================
   BULK UPDATE / PIPELINE / DELETE / ENRICH
====================== */
app.patch("/api/leads/bulk", async (req, res) => {
  const { updates, ids } = req.body;
  const set = Object.keys(updates).map((f, i) => `${f}=$${i + 1}`).join(", ");
  const values = [...Object.values(updates), ids];

  const result = await pool.query(
    `
    UPDATE leads
    SET ${set}, updated_at=now()
    WHERE id = ANY($${values.length}) AND deleted=false
    `,
    values
  );

  res.json({ updated: result.rowCount });
});

app.delete("/api/leads/bulk", async (req, res) => {
  const result = await pool.query(
    `
    UPDATE leads SET deleted=true WHERE id = ANY($1)
    `,
    [req.body.ids]
  );
  res.json({ deleted: result.rowCount });
});

/* ======================
   AI – SUGGEST (READ ONLY)
====================== */
app.get("/api/leads/:id/ai/suggest", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE id=$1 AND deleted=false`,
    [req.params.id]
  );

  if (!rows[0]) return res.status(404).json({ error: "Not found" });

  const ai = aiSuggestLead(rows[0]);
  const score = aiScoreLead(rows[0]);

  res.json({
    suggestions: ai.suggestions,
    confidence: ai.confidence,
    score: score.score,
    reasons: score.reasons
  });
});

/* ======================
   AI – APPLY (APPROVED FIELDS)
====================== */
app.post("/api/leads/:id/ai/apply", async (req, res) => {
  const fields = Object.keys(req.body);
  const set = fields.map((f, i) => `${f}=$${i + 1}`).join(", ");
  const values = Object.values(req.body);

  const { rows } = await pool.query(
    `
    UPDATE leads
    SET ${set}, updated_at=now()
    WHERE id=$${values.length + 1}
    RETURNING *
    `,
    [...values, req.params.id]
  );

  res.json(rows[0]);
});

/* ======================
   AI – BULK SUGGEST
====================== */
app.post("/api/leads/bulk/ai/suggest", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE id = ANY($1) AND deleted=false`,
    [req.body.ids]
  );

  const result = rows.map(l => ({
    lead_id: l.id,
    ...aiScoreLead(l),
    ...aiSuggestLead(l)
  }));

  res.json(result);
});

/* ======================
   AI – SUGGEST HUMAN
====================== */
app.post("/api/leads/:id/ai/human", async (req, res) => {
  await pool.query(
    `UPDATE leads SET suggest_human=true WHERE id=$1`,
    [req.params.id]
  );
  res.json({ status: "Marked for human review" });
});

/* ======================
   DASHBOARD
====================== */
app.get("/api/dashboard/pipeline", async (_, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE deleted=false`);
  const grouped = {};
  rows.forEach(l => {
    grouped[l.pipeline || "Unassigned"] ||= [];
    grouped[l.pipeline || "Unassigned"].push(l);
  });
  res.json(grouped);
});

app.get("/api/dashboard/stats", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE pipeline='Won') AS won,
      COUNT(*) FILTER (WHERE pipeline='Lost') AS lost
    FROM leads WHERE deleted=false
  `);
  res.json(rows[0]);
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ AltoCRM running on ${PORT}`));
