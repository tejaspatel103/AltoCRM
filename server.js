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
      `UPDATE background_jobs SET status='done' WHERE id=$1`,
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
   AI ENRICH JOB
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
   FIELD REGISTRY API (STEP 5)
====================== */
app.get("/api/fields", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      field_key,
      label,
      field_type,
      editable,
      enrichable,
      source,
      options,
      visible,
      order_index,
      is_system,
      is_core
    FROM crm_fields
    WHERE visible IS TRUE
    ORDER BY order_index ASC
  `);

  const fields = rows.map(f => ({
    id: f.field_key,
    label: f.label,
    type: f.field_type,
    group: f.is_core ? "core" : f.is_system ? "system" : "custom",
    order: f.order_index ?? 0,
    is_required: false,
    is_editable: f.editable === true,
    is_filterable: true,
    is_sortable: true,
    source: f.source || "system",
    meta: {
      options: f.options || [],
      enrichable: f.enrichable === true
    }
  }));

  res.json(fields);
});

/* ======================
   LEADS FETCH (STEP 5)
====================== */
app.get("/api/leads", async (req, res) => {
  const page = Number(req.query.page || 1);
  const pageSize = Number(req.query.page_size || 50);
  const offset = (page - 1) * pageSize;

  const { rows: fieldDefs } = await pool.query(`
    SELECT field_key FROM crm_fields WHERE visible IS TRUE
  `);
  const fieldKeys = fieldDefs.map(f => f.field_key);

  const { rows: leads } = await pool.query(
    `
    SELECT * FROM leads
    WHERE deleted IS NOT TRUE
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [pageSize, offset]
  );

  if (!leads.length) {
    return res.json({ data: [], page, page_size: pageSize, total: 0 });
  }

  const leadIds = leads.map(l => l.id);

  const { rows: meta } = await pool.query(
    `
    SELECT lead_id, field_name, source, confidence, locked
FROM lead_field_meta
WHERE lead_id = ANY($1)

    `,
    [leadIds]
  );

  const metaMap = {};
  meta.forEach(m => {
    metaMap[`${m.lead_id}:${m.field_name}`] = m;

  });

  const data = leads.map(lead => {
    const fields = {};
    fieldKeys.forEach(key => {
      if (!(key in lead)) return;
      const m = metaMap[`${lead.id}:${key}`];

      fields[key] = {
        value: lead[key],
        source: m?.source || "manual",
        confidence: m?.confidence ?? 1,
        locked: m?.locked === true
      };
    });

    return {
      id: lead.id,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      fields
    };
  });

  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE deleted IS NOT TRUE`
  );

  res.json({
    data,
    page,
    page_size: pageSize,
    total: Number(rows[0].count)
  });
});

/* ======================
   UPDATE LEAD
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
