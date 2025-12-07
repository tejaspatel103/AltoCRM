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
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* ======================
   UPDATE LEAD + AUDIT
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

      if (String(oldValue) !== String(newValue)) {
        await client.query(
          `UPDATE leads SET ${field} = $1 WHERE id = $2`,
          [newValue, leadId]
        );

        await auditChange({
          lead_id: leadId,
          field_name: field,
          old_value: oldValue,
          new_value: newValue
        });
      }
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
