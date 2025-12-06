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

/* ------------ DB INIT ------------ */
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
      integration_source TEXT,
      system_derived BOOLEAN,
      order_index INTEGER,
      hidden BOOLEAN DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    )
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
    )
  `);

  await seedFields();
}

/* ------------ SEED FIELDS ------------ */
async function seedFields() {
  const fields = [
    ["Full Name","full_name","text",null,true,true,null,false,1],
    ["First Name","first_name","text",null,true,true,null,false,2],
    ["Last Name","last_name","text",null,true,true,null,false,3],
    ["Company","company","text",null,true,true,null,false,4],
    ["Company Short","company_short","text",null,true,true,null,false,5],
    ["Title","title","text",null,true,true,null,false,6],
    ["LinkedIn URL","linkedin_url","text",null,true,true,null,false,7],
    ["Website","website","text",null,true,true,null,false,8],
    ["City","city","text",null,true,true,null,false,9],
    ["State","state","text",null,true,true,null,false,10],
    ["Pipeline","pipeline","select",
      ["New","Trying","Contacted","Follow-up","Meeting Booked","Re-meeting","Proposal","Won","Very Important","Lost","Not Interested","Tired of trying"],
      true,false,null,false,11],
    ["Lead Source","lead_source","select",
      ["LI Search","Web Search","Local list","Job list","DM","Email","Call","Conference","Reference","1-o-1"],
      true,false,null,false,12],
    ["Call Outcome","call_outcome","select",
      ["Interested","Meeting booked","Call back","Voicemail","Message to GK","Tired of calling","Req. correction","Not Interested","Wrong lead","Other"],
      true,false,null,false,13],
    ["Email 1","email_1","email",null,true,true,null,false,14],
    ["Email 1 Status","email_1_status","select",
      ["Unverified","Valid","Invalid","Abuse","Do not mail","Catch-all score"],
      true,false,"zerobounce",false,15],
    ["GK","gk","text",null,true,false,null,false,16],
    ["Lead Score","lead_score","number",null,true,true,null,false,17],
    ["Lead Score Reason","lead_score_reason","text",null,true,true,null,false,18],
    ["Suggest Human","suggest_human","long_text",null,true,false,null,false,19],
    ["Suggest AI","suggest_ai","long_text",null,false,true,null,false,20],
    ["Manual Comment","manual_comment","long_text",null,true,false,null,false,21]
  ];

  for (const f of fields) {
    await pool.query(
      `INSERT INTO fields
       (label, key, type, options, editable, enrichable, integration_source, system_derived, order_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO NOTHING`,
      f
    );
  }
}

/* ------------ APIs ------------ */

// Fetch fields
app.get("/api/fields", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM fields WHERE hidden = FALSE ORDER BY order_index"
  );
  res.json(rows);
});

// Fetch leads + values
app.get("/api/leads", async (req, res) => {
  const { rows: leads } = await pool.query("SELECT * FROM leads");
  const { rows: values } = await pool.query("SELECT * FROM lead_values");

  const map = {};
  leads.forEach(l => map[l.id] = { id: l.id });
  values.forEach(v => {
    if (map[v.lead_id]) map[v.lead_id][v.field_key] = v.value;
  });

  res.json(Object.values(map));
});

// Create new blank lead
app.post("/api/leads", async (req, res) => {
  const id = uuidv4();
  await pool.query("INSERT INTO leads (id) VALUES ($1)", [id]);
  res.json({ id });
});

// Update single cell (manual edit)
app.put("/api/cell", async (req, res) => {
  const { leadId, fieldKey, value } = req.body;

  await pool.query(
    `
    INSERT INTO lead_values
    (lead_id, field_key, value, source, locked, updated_at)
    VALUES ($1, $2, $3, 'manual', TRUE, NOW())
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

/* ------------ START SERVER ------------ */
init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () =>
    console.log("CRM running on port", PORT)
  );
});
