import express from "express";
import cors from "cors";
import pkg from "pg";
import multer from "multer";
import fs from "fs";
import csv from "csv-parser";
import { Parser } from "json2csv";

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
   FILE UPLOAD CONFIG
====================== */
const upload = multer({ dest: "uploads/" });

/* ======================
   PIPELINE STAGES
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
   AI HELPERS (STUB)
====================== */
function aiSuggestLead(lead) {
  const first = lead.full_name?.split(" ")[0] || null;
  const last = lead.full_name?.split(" ").slice(1).join(" ") || null;

  return {
    suggestions: {
      first_name: first,
      last_name: last,
      company_short: lead.company ? lead.company.split(" ")[0] : null
    },
    confidence: {
      first_name: 0.9,
      last_name: 0.9,
      company_short: 0.7
    }
  };
}

/* ======================
   AUDIT HELPER
====================== */
async function auditChange({
  lead_id,
  field_name,
  old_value,
  new_value,
  actor_type = "user",
  actor_id = null
}) {
  await pool.query(
    `
    INSERT INTO lead_audit_logs
      (lead_id, action_type, field_name, old_value, new_value, actor_type, actor_id)
    VALUES
      ($1, 'update', $2, $3, $4, $5, $6)
    `,
    [lead_id, field_name, old_value, new_value, actor_type, actor_id]
  );
}

/* ======================
   AI FIELD LOCK HELPERS
====================== */
async function isFieldLocked(lead_id, field_name) {
  const { rows } = await pool.query(
    `
    SELECT locked, locked_by
    FROM lead_field_locks
    WHERE lead_id = $1 AND field_name = $2
    `,
    [lead_id, field_name]
  );

  if (!rows.length) return false;
  return rows[0].locked && rows[0].locked_by === "ai";
}

async function upsertFieldLock({
  lead_id,
  field_name,
  ai_value,
  confidence,
  locked = true
}) {
  await pool.query(
    `
    INSERT INTO lead_field_locks
      (lead_id, field_name, ai_value, confidence, locked, locked_by)
    VALUES ($1, $2, $3, $4, $5, 'ai')
    ON CONFLICT (lead_id, field_name)
    DO UPDATE SET
      ai_value = EXCLUDED.ai_value,
      confidence = EXCLUDED.confidence,
      locked = EXCLUDED.locked,
      locked_by = 'ai',
      updated_at = now()
    `,
    [lead_id, field_name, ai_value, confidence, locked]
  );
}

/* ======================
   BACKGROUND QUEUE HELPERS
====================== */
async function enqueueJob(job_type, payload) {
  await pool.query(
    `
    INSERT INTO background_jobs (job_type, payload, status)
    VALUES ($1, $2, 'pending')
    `,
    [job_type, payload]
  );
}

async function processNextJob() {
  const client = await pool.connect();
  let job;

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT *
      FROM background_jobs
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return;
    }

    job = rows[0];

    await client.query(
      `
      UPDATE background_jobs
      SET status = 'processing', attempts = attempts + 1
      WHERE id = $1
      `,
      [job.id]
    );

    await client.query("COMMIT");

    await handleJob(job);

    await pool.query(
      `
      UPDATE background_jobs
      SET status = 'done', completed_at = now()
      WHERE id = $1
      `,
      [job.id]
    );
  } catch (err) {
    if (job) {
      await pool.query(
        `
        UPDATE background_jobs
        SET status = 'failed', last_error = $1
        WHERE id = $2
        `,
        [err.message, job.id]
      );
    }
  } finally {
    client.release();
  }
}

/* ======================
   JOB HANDLER
====================== */
async function handleJob(job) {
  const payload = job.payload;

  if (job.job_type === "ai_enrich") {
    await processAIEnrichJob(payload);
  }

  if (job.job_type === "import_row") {
    await processImportRowJob(payload);
  }
}

/* ======================
   AI ENRICH JOB
====================== */
async function processAIEnrichJob({ lead_id }) {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE id = $1`,
    [lead_id]
  );

  if (!rows.length) return;

  const lead = rows[0];
  const ai = aiSuggestLead(lead);

  for (const field of Object.keys(ai.suggestions)) {
    await upsertFieldLock({
      lead_id,
      field_name: field,
      ai_value: ai.suggestions[field],
      confidence: ai.confidence[field]
    });
  }
}

/* ======================
   IMPORT ROW JOB
====================== */
async function processImportRowJob({ data }) {
  const fields = Object.keys(data);
  const values = Object.values(data);
  const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");

  await pool.query(
    `
    INSERT INTO leads (${fields.join(", ")}, pipeline)
    VALUES (${placeholders}, 'New')
    `,
    values
  );
}

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* ======================
   UPDATE LEAD (RESPECT AI LOCKS)
====================== */
app.patch("/api/leads/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const leadId = req.params.id;
    const updates = req.body;

    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM leads WHERE id = $1 FOR UPDATE",
      [leadId]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Lead not found" });
    }

    const oldLead = rows[0];

    for (const [field, newValue] of Object.entries(updates)) {
      const oldValue = oldLead[field];
      if (String(oldValue) === String(newValue)) continue;

      const locked = await isFieldLocked(leadId, field);
      if (locked) continue;

      await client.query(
        `UPDATE leads SET ${field} = $1 WHERE id = $2`,
        [newValue, leadId]
      );

      await auditChange({
        lead_id: leadId,
        field_name: field,
        old_value: oldValue,
        new_value: newValue,
        actor_type: "human"
      });
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ======================
   AI ENQUEUE (BACKGROUND)
====================== */
app.post("/api/leads/:id/ai/enqueue", async (req, res) => {
  await enqueueJob("ai_enrich", { lead_id: req.params.id });
  res.json({ queued: true });
});

/* ======================
   FIELD LOCK ENDPOINTS
====================== */
app.post("/api/leads/:id/ai/lock", async (req, res) => {
  const leadId = req.params.id;

  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE id = $1`,
    [leadId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: "Lead not found" });
  }

  const ai = aiSuggestLead(rows[0]);

  for (const field of Object.keys(ai.suggestions)) {
    await upsertFieldLock({
      lead_id: leadId,
      field_name: field,
      ai_value: ai.suggestions[field],
      confidence: ai.confidence[field]
    });
  }

  res.json({ locked_fields: ai.suggestions });
});

app.get("/api/leads/:id/locks", async (req, res) => {
  const { rows } = await pool.query(
    `
    SELECT field_name, locked, locked_by, ai_value, confidence
    FROM lead_field_locks
    WHERE lead_id = $1
    `,
    [req.params.id]
  );
  res.json(rows);
});

app.post("/api/leads/:id/unlock", async (req, res) => {
  const { field_name } = req.body;

  await pool.query(
    `
    UPDATE lead_field_locks
    SET locked = false, locked_by = 'human', updated_at = now()
    WHERE lead_id = $1 AND field_name = $2
    `,
    [req.params.id, field_name]
  );

  res.json({ unlocked: field_name });
});

/* ======================
   VIEW AUDIT HISTORY
====================== */
app.get("/api/leads/:id/history", async (req, res) => {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM lead_audit_logs
    WHERE lead_id = $1
    ORDER BY created_at DESC
    `,
    [req.params.id]
  );
  res.json(rows);
});

/* ======================
   UNDO LAST CHANGE
====================== */
app.post("/api/leads/:id/undo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT *
      FROM lead_audit_logs
      WHERE lead_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [req.params.id]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nothing to undo" });
    }

    const last = rows[0];

    await client.query(
      `UPDATE leads SET ${last.field_name} = $1 WHERE id = $2`,
      [last.old_value, req.params.id]
    );

    await client.query(
      "DELETE FROM lead_audit_logs WHERE id = $1",
      [last.id]
    );

    await client.query("COMMIT");
    res.json({ undone: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ======================
   DASHBOARD ENDPOINTS
====================== */

/* Pipeline summary counts for each stage */
app.get("/api/pipeline/summary", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pipeline, COUNT(*) AS count
      FROM leads
      WHERE deleted = false
      GROUP BY pipeline
      ORDER BY pipeline
    `);
    res.json(rows);
  } catch (err) {
    console.error("PIPELINE SUMMARY ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* Kanban-style pipeline columns */
app.get("/api/dashboard/pipeline", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM leads
      WHERE deleted = false
      ORDER BY created_at DESC
    `);

    const grouped = {};
    rows.forEach(lead => {
      const stage = lead.pipeline || "Unassigned";
      if (!grouped[stage]) grouped[stage] = [];
      grouped[stage].push(lead);
    });

    res.json(grouped);
  } catch (err) {
    console.error("DASHBOARD PIPELINE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* Top-level stats cards */
app.get("/api/dashboard/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE deleted = false) AS total_leads,
        COUNT(*) FILTER (WHERE deleted = false AND created_at::date = CURRENT_DATE) AS new_today,
        COUNT(*) FILTER (WHERE deleted = false AND (email1 IS NULL OR email1 = '')) AS missing_email,
        COUNT(*) FILTER (WHERE deleted = false AND (pipeline IS NULL OR pipeline = '')) AS missing_pipeline,
        COUNT(*) FILTER (WHERE deleted = false AND pipeline = 'Won') AS won,
        COUNT(*) FILTER (WHERE deleted = false AND pipeline = 'Lost') AS lost
      FROM leads
    `);

    res.json(rows[0]);
  } catch (err) {
    console.error("DASHBOARD STATS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* Upcoming next actions list */
app.get("/api/dashboard/next-actions", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM leads
      WHERE deleted = false
      AND next_action_date IS NOT NULL
      ORDER BY next_action_date ASC
      LIMIT 50
    `);

    res.json(rows);
  } catch (err) {
    console.error("NEXT ACTION ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   QUEUE WORKER LOOP
====================== */
setInterval(() => {
  processNextJob().catch(err =>
    console.error("Queue error:", err.message)
  );
}, 2000);

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`✅ AltoCRM running on ${PORT}`)
);
