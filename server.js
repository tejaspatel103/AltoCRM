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
  "New","Trying","Contacted","Follow-up","Meeting Booked",
  "Proposal","Won","Very Important","Lost","Not Interested","Tired of trying"
];

/* ======================
   FIELD CATEGORY CONSTANTS
====================== */
const INTEGRATION_FIELDS = [
  "email1_status","email2_status","email_sequence",
  "last_email","last_phone_date","call_count"
];

const DERIVED_FIELDS = ["local_time","timezone"];

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
async function auditChange({ lead_id, field_name, old_value, new_value, actor_type }) {
  await pool.query(
    `
    INSERT INTO lead_audit_logs
    (lead_id, action_type, field_name, old_value, new_value, actor_type)
    VALUES ($1,'update',$2,$3,$4,$5)
    `,
    [lead_id, field_name, old_value, new_value, actor_type]
  );
}

/* ======================
   FIELD META HELPERS
====================== */
async function upsertFieldMeta({ lead_id, field_name, source, confidence = null, locked = false }) {
  await pool.query(
    `
    INSERT INTO lead_field_meta
    (lead_id, field_key, source, confidence, locked)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (lead_id, field_key)
    DO UPDATE SET source=$3, confidence=$4, locked=$5, updated_at=now()
    `,
    [lead_id, field_name, source, confidence, locked]
  );
}

async function isFieldLocked(lead_id, field_name) {
  const { rows } = await pool.query(
    `SELECT locked FROM lead_field_locks WHERE lead_id=$1 AND field_name=$2`,
    [lead_id, field_name]
  );
  return rows[0]?.locked === true;
}

/* ======================
   BACKGROUND QUEUE
====================== */
async function enqueueJob(job_type, payload) {
  await pool.query(
    `INSERT INTO background_jobs (job_type,payload,status) VALUES ($1,$2,'pending')`,
    [job_type, payload]
  );
}

async function processNextJob() {
  const client = await pool.connect();
  let job;

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(`
      SELECT * FROM background_jobs
      WHERE status='pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (!rows.length) {
      await client.query("ROLLBACK");
      return;
    }

    job = rows[0];
    await client.query(
      `UPDATE background_jobs SET status='processing' WHERE id=$1`,
      [job.id]
    );
    await client.query("COMMIT");

    if (job.job_type === "ai_enrich") {
      await processAIEnrichJob(job.payload);
    }

    await pool.query(
      `UPDATE background_jobs SET status='done', completed_at=now() WHERE id=$1`,
      [job.id]
    );
  } catch (err) {
    if (job) {
      await pool.query(
        `UPDATE background_jobs SET status='failed', last_error=$1 WHERE id=$2`,
        [err.message, job.id]
      );
    }
  } finally {
    client.release();
  }
}

/* ======================
   AI ENRICH JOB (REGISTRY-DRIVEN)
====================== */
async function processAIEnrichJob({ lead_id }) {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE id=$1`, [lead_id]);
  if (!rows.length) return;

  const lead = rows[0];
  const ai = aiSuggestLead(lead);

  const { rows: defs } = await pool.query(`
    SELECT field_key FROM crm_fields WHERE enrichable=true AND is_system=false
  `);
  const enrichable = defs.map(d => d.field_key);

  for (const field of Object.keys(ai.suggestions)) {
    if (!enrichable.includes(field)) continue;

    await pool.query(
      `
      INSERT INTO lead_field_locks (lead_id,field_name,ai_value,confidence,locked,locked_by)
      VALUES ($1,$2,$3,$4,true,'ai')
      ON CONFLICT (lead_id,field_name)
      DO UPDATE SET ai_value=$3, confidence=$4, locked=true, updated_at=now()
      `,
      [lead_id, field, ai.suggestions[field], ai.confidence[field]]
    );

    await upsertFieldMeta({
      lead_id,
      field_name: field,
      source: "ai",
      confidence: ai.confidence[field],
      locked: true
    });
  }
}

/* ======================
   FIELD REGISTRY API
====================== */
app.get("/api/fields", async (_, res) => {
  const { rows } = await pool.query(`SELECT * FROM crm_fields ORDER BY id`);
  res.json(rows);
});

/* ======================
   SCHEMA-AWARE LEADS FETCH
====================== */
app.get("/api/leads", async (_, res) => {
  const { rows: leads } = await pool.query(
    `SELECT * FROM leads WHERE deleted=false ORDER BY created_at DESC`
  );

  const { rows: meta } = await pool.query(`SELECT * FROM lead_field_meta`);
  const metaMap = {};
  meta.forEach(m => (metaMap[`${m.lead_id}:${m.field_key}`] = m));

  const result = leads.map(l => {
    const fields = {};
    Object.keys(l).forEach(k => {
      const m = metaMap[`${l.id}:${k}`];
      fields[k] = {
        value: l[k],
        source: m?.source || "manual",
        confidence: m?.confidence || null,
        locked: m?.locked || false
      };
    });
    return { id: l.id, fields };
  });

  res.json(result);
});

/* ======================
   UPDATE LEAD (LOCK & SOURCE AWARE)
====================== */
app.patch("/api/leads/:id", async (req, res) => {
  const client = await pool.connect();
  const leadId = req.params.id;

  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM leads WHERE id=$1 FOR UPDATE`,
      [leadId]
    );
    if (!rows.length) throw new Error("Lead not found");

    const old = rows[0];

    for (const [field, value] of Object.entries(req.body)) {
      if (DERIVED_FIELDS.includes(field)) continue;
      if (INTEGRATION_FIELDS.includes(field)) continue;
      if (await isFieldLocked(leadId, field)) continue;
      if (String(old[field]) === String(value)) continue;

      await client.query(
        `UPDATE leads SET ${field}=$1 WHERE id=$2`,
        [value, leadId]
      );

      await auditChange({
        lead_id: leadId,
        field_name: field,
        old_value: old[field],
        new_value: value,
        actor_type: "human"
      });

      await upsertFieldMeta({
        lead_id: leadId,
        field_name: field,
        source: "manual",
        locked: false
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
   DASHBOARD
====================== */
app.get("/api/pipeline/summary", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT pipeline, COUNT(*)::int AS count
    FROM leads WHERE deleted=false GROUP BY pipeline
  `);
  res.json(rows);
});

app.get("/api/dashboard/stats", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted=false) AS total,
      COUNT(*) FILTER (WHERE pipeline='Won') AS won,
      COUNT(*) FILTER (WHERE pipeline='Lost') AS lost
    FROM leads
  `);
  res.json(rows[0]);
});

/* ======================
   QUEUE LOOP
====================== */
setInterval(() => processNextJob(), 2000);

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ AltoCRM running on ${PORT}`));
