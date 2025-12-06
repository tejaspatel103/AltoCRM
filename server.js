const express = require("express");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =======================
   DB INITIALIZATION
======================= */

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fields (
      id SERIAL PRIMARY KEY,
      label TEXT,
      key TEXT UNIQUE,
      type TEXT,
      options JSONB,
      editable BOOLEAN,
      enrichable BOOLEAN,
      system_derived BOOLEAN,
      order_index INTEGER,
      hidden BOOLEAN DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_values (
      lead_id UUID,
      field_key TEXT,
      value TEXT,
      source TEXT,
      locked BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT,
      PRIMARY KEY (lead_id, field_key)
    );
  `);

  await seedFields();
}

/* =======================
   SAFE FIELD SEEDING
======================= */

async function seedFields() {
  const fields = [
    {
      label: "Full Name",
      key: "full_name",
      type: "text",
      options: null,
      editable: true,
      enrichable: true,
      system: false,
      order: 1
    },
    {
      label: "Company",
      key: "company",
      type: "text",
      options: null,
      editable: true,
      enrichable: true,
      system: false,
      order: 2
    },
    {
      label: "Pipeline",
      key: "pipeline",
      type: "select",
      options: {
        stages: [
          "New",
          "Trying",
          "Contacted",
          "Follow-up",
          "Meeting Booked",
          "Re-meeting",
          "Proposal",
          "Won",
          "Very Important",
          "Lost",
          "Not Interested",
          "Tired of trying"
        ]
      },
      editable: true,
      enrichable: false,
      system: false,
      order: 3
    },
    {
      label: "Lead Source",
      key: "lead_source",
      type: "select",
      options: {
        sources: [
          "LI Search",
          "Web Search",
          "Local list",
          "Job list",
          "DM",
          "Email",
          "Call",
          "Conference",
          "Reference",
          "1-o-1"
        ]
      },
      editable: true,
      enrichable: false,
      system: false,
      order: 4
    },
    {
      label: "Call Outcome",
      key: "call_outcome",
      type: "select",
      options: {
        outcomes: [
          "Interested",
          "Meeting booked",
          "Call back",
          "Voicemail",
          "Message to GK",
          "Tired of calling",
          "Req. correction",
          "Not Interested",
          "Wrong lead",
          "Other"
        ]
      },
      editable: true,
      enrichable: false,
      system: false,
      order: 5
    },
    {
      label: "Lead Score",
      key: "lead_score",
      type: "number",
      options: null,
      editable: true,
      enrichable: true,
      system: false,
      order: 6
    },
    {
      label: "Lead Score Reason",
      key: "lead_score_reason",
      type: "text",
      options: null,
      editable: true,
      enrichable: true,
      system: false,
      order: 7
    },
    {
      label: "Suggest AI",
      key: "suggest_ai",
      type: "long_text",
      options: null,
      editable: false,
      enrichable: true,
      system: true,
      order: 8
    },
    {
      label: "Suggest Human",
      key: "suggest_human",
      type: "long_text",
      options: null,
      editable: true,
      enrichable: false,
      system: false,
      order: 9
    },
    {
      label: "Manual Comment",
      key: "manual_comment",
      type: "long_text",
      options: null,
      editable: true,
      enrichable: false,
      system: false,
      order: 10
    }
  ];

  for (const f of fields) {
    await pool.query(
      `
      INSERT INTO fields
        (label, key, type, options, editable, enrichable, system_derived, order_index)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (key) DO NOTHING
      `,
      [
        f.label,
        f.key,
        f.type,
        f.options ? JSON.stringify(f.options) : null,
        f.editable,
        f.enrichable,
        f.system,
        f.order
      ]
    );
  }
}

/* =======================
   API ENDPOINTS
======================= */

app.get("/api/fields", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM fields WHERE hidden = FALSE ORDER BY order_index"
  );
  res.json(rows);
});

app.get("/api/leads", async (req, res) => {
  const { rows: leads } = await pool.query("SELECT * FROM leads");
  const { rows: values } = await pool.query("SELECT * FROM lead_values");

  const map = {};
  leads.forEach(l => (map[l.id] = { id: l.id }));

  values.forEach(v => {
    if (!map[v.lead_id]) return;
    map[v.lead_id][v.field_key] = v.value;
  });

  res.json(Object.values(map));
});

app.post("/api/leads", async (req, res) => {
  const id = uuidv4();
  await pool.query("INSERT INTO leads (id) VALUES ($1)", [id]);
  res.json({ id });
});

app.put("/api/cell", async (req, res) => {
  const { leadId, fieldKey, value } = req.body;

  await pool.query(
    `
    INSERT INTO lead_values (lead_id, field_key, value, source, locked)
    VALUES ($1,$2,$3,'manual',TRUE)
    ON CONFLICT (lead_id, field_key)
    DO UPDATE SET
      value = EXCLUDED.value,
      source = 'manual',
      locked = TRUE,
      updated_at = NOW()
    `,
    [leadId, fieldKey, value]
  );

  res.json({ success: true });
});

/* =======================
   START SERVER
======================= */

init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log("✅ AltoCRM running on port", PORT);
  });
});
