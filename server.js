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
   ✅ AUDIT HELPER
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
    VALUES ($1, 'update', $2, $3, $4, $5, $6)
    `,
    [lead_id, field_name, old_value, new_value, actor_type, actor_id]
  );
}

/* ======================
   ✅ AI FIELD LOCK HELPERS
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
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* ======================
   ✅ UPDATE LEAD (RESPECT AI LOCKS)
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
      if (locked) {
        continue; // ✅ AI lock respected
      }

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
   ✅ AI SUGGEST + LOCK FIELDS
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

/* ======================
   ✅ GET FIELD LOCK STATUS
====================== */
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
   ✅ HUMAN OVERRIDE / UNLOCK FIELD
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
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`✅ AltoCRM running on ${PORT}`)
);
