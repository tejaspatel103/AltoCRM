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
   FIELD CATEGORY CONSTANTS
   (for Step 2 rules)
====================== */

// Fields that are driven by integrations / auto systems (⚡)
const INTEGRATION_FIELDS = [
  "email_1_status",
  "email_2_status",
  "email_sequence",
  "last_email_date",
  "last_phone_date",
  "call_count"
];

// Fields that are derived / computed and never manually edited
const DERIVED_FIELDS = [
  "local_time",
  "timezone"
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
   FIELD META HELPERS
   (source: manual | ai | integration)
====================== */
async function getFieldMeta(lead_id, field_name) {
  const { rows } = await pool.query(
    `
    SELECT source, locked, last_updated_by
    FROM lead_field_meta
    WHERE lead_id = $1 AND field_name = $2
    `,
    [lead_id, field_name]
  );
  return rows[0] || null;
}

async function upsertFieldMeta({
  lead_id,
  field_name,
  source,
  locked = false,
  last_updated_by = null
}) {
  await pool.query(
    `
    INSERT INTO lead_field_meta
      (lead_id, field_name, source, locked, last_updated_by)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (lead_id, field_name)
    DO UPDATE SET
      source = EXCLUDED.source,
      locked = EXCLUDED.locked,
      last_updated_by = EXCLUDED.last_updated_by,
      updated_at = now()
    `,
    [lead_id, field_name, source, locked, last_updated_by]
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
  if (job.job_type === "ai_enrich") {
    await processAIEnrichJob(job.payload);
  }

  if (job.job_type === "import_row") {
    await processImportRowJob(job.payload);
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

  const ai = aiSuggestLead(rows[0]);

  for (const field of Object.keys(ai.suggestions)) {
    await upsertFieldLock({
      lead_id,
      field_name: field,
      ai_value: ai.suggestions[field],
      confidence: ai.confidence[field]
    });

    // Optionally mark meta as AI-sourced suggestion (does not overwrite lead value)
    await upsertFieldMeta({
      lead_id,
      field_name: field,
      source: "ai",
      locked: true,
      last_updated_by: "ai_enrich_job"
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

  // Mark imported fields as manual by default
  // (We don't know actor, so store "import" as last_updated_by)
  // This is optional; you can expand to per-field if needed.
}

/* ======================
   INTEGRATION FIELD WRITER
   (used by future webhooks)
====================== */
async function writeIntegrationField({
  lead_id,
  field_name,
  value,
  source_system
}) {
  if (!INTEGRATION_FIELDS.includes(field_name)) {
    throw new Error(`Field ${field_name} is not registered as integration-driven`);
  }

  await pool.query(
    `UPDATE leads SET ${field_name} = $1 WHERE id = $2`,
    [value, lead_id]
  );

  await upsertFieldMeta({
    lead_id,
    field_name,
    source: "integration",
    locked: false,
    last_updated_by: source_system
  });
}

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* ======================
   UPDATE LEAD (LOCK-AWARE + SOURCE-AWARE)
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

    for (const [field, newValueRaw] of Object.entries(updates)) {
      const newValue = newValueRaw === undefined ? null : newValueRaw;
      const oldValue = oldLead[field];

      // No change → skip
      if (String(oldValue) === String(newValue)) continue;

      // Derived fields are never manually edited
      if (DERIVED_FIELDS.includes(field)) {
        continue;
      }

      // Integration fields: only editable if we *already* know this field is not integration-owned
      if (INTEGRATION_FIELDS.includes(field)) {
        const meta = await getFieldMeta(leadId, field);
        if (!meta || meta.source === "integration") {
          // Integration owns this field → ignore manual update
          continue;
        }
      }

      // AI lock: AI owns field until human explicitly unlocks
      const locked = await isFieldLocked(leadId, field);
      if (locked) continue;

      // Perform update
      await client.query(
        `UPDATE leads SET ${field} = $1 WHERE id = $2`,
        [newValue, leadId]
      );

      // Audit log
      await auditChange({
        lead_id: leadId,
        field_name: field,
        old_value: oldValue,
        new_value: newValue,
        actor_type: "human"
      });

      // Update field meta: mark as manual
      await upsertFieldMeta({
        lead_id: leadId,
        field_name: field,
        source: "manual",
        locked: false,
        last_updated_by: "human"
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
   AI ENQUEUE
====================== */
app.post("/api/leads/:id/ai/enqueue", async (req, res) => {
  await enqueueJob("ai_enrich", { lead_id: req.params.id });
  res.json({ queued: true });
});

/* ======================
   LOCK ENDPOINTS
====================== */
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

  // Also update meta to manual (unlocked)
  await upsertFieldMeta({
    lead_id: req.params.id,
    field_name,
    source: "manual",
    locked: false,
    last_updated_by: "human_unlock"
  });

  res.json({ unlocked: field_name });
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

/* ======================
   AUDIT HISTORY + UNDO
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

app.post("/api/leads/:id/undo", async (req, res) => {
  const client = await pool.connect();
  try {
    const leadId = req.params.id;

    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT *
      FROM lead_audit_logs
      WHERE lead_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [leadId]
    );

    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nothing to undo" });
    }

    const last = rows[0];

    await client.query(
      `UPDATE leads SET ${last.field_name} = $1 WHERE id = $2`,
      [last.old_value, leadId]
    );

    // Update meta: if this is an integration field, mark as integration source;
    // otherwise mark as manual (we don't track older meta history yet).
    let source = "manual";
    if (INTEGRATION_FIELDS.includes(last.field_name)) {
      source = "integration";
    }

    await upsertFieldMeta({
      lead_id: leadId,
      field_name: last.field_name,
      source,
      locked: false,
      last_updated_by: "undo"
    });

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
   DASHBOARD
====================== */
app.get("/api/pipeline/summary", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT pipeline, COUNT(*)::int AS count
    FROM leads
    WHERE deleted = false
    GROUP BY pipeline
  `);
  res.json(rows);
});

app.get("/api/dashboard/stats", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted = false) AS total_leads,
      COUNT(*) FILTER (WHERE deleted = false AND created_at::date = CURRENT_DATE) AS new_today,
      COUNT(*) FILTER (WHERE deleted = false AND pipeline = 'Won') AS won,
      COUNT(*) FILTER (WHERE deleted = false AND pipeline = 'Lost') AS lost
    FROM leads
  `);
  res.json(rows[0]);
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
