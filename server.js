const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./crm.db");

/* ---------------- DB INIT ---------------- */

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      key TEXT UNIQUE,
      type TEXT,
      options TEXT,
      editable INTEGER,
      enrichable INTEGER,
      integration_source TEXT,
      system_derived INTEGER,
      order_index INTEGER,
      hidden INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lead_values (
      lead_id TEXT,
      field_key TEXT,
      value TEXT,
      source TEXT,
      locked INTEGER DEFAULT 0,
      updated_at TEXT,
      updated_by TEXT
    )
  `);
});

/* -------- SEED FIELDS (RUNS ONCE SAFELY) -------- */

const fields = [
  ["Full Name","full_name","text",null,1,1,null,0,1],
  ["First Name","first_name","text",null,1,1,null,0,2],
  ["Last Name","last_name","text",null,1,1,null,0,3],
  ["Company","company","text",null,1,1,null,0,4],
  ["Company Short","company_short","text",null,1,1,null,0,5],
  ["Title","title","text",null,1,1,null,0,6],
  ["LinkedIn URL","linkedin_url","text",null,1,1,null,0,7],
  ["Website","website","text",null,1,1,null,0,8],
  ["City","city","text",null,1,1,null,0,9],
  ["State","state","text",null,1,1,null,0,10],
  ["Pipeline","pipeline","select",
    JSON.stringify(["New","Trying","Contacted","Follow-up","Meeting Booked","Re-meeting","Proposal","Won","Very Important","Lost","Not Interested","Tired of trying"]),
    1,0,null,0,11],
  ["Lead Source","lead_source","select",
    JSON.stringify(["LI Search","Web Search","Local list","Job list","DM","Email","Call","Conference","Reference","1-o-1"]),
    1,0,null,0,12],
  ["Call Outcome","call_outcome","select",
    JSON.stringify(["Interested","Meeting booked","Call back","Voicemail","Message to GK","Tired of calling","Req. correction","Not Interested","Wrong lead","Other"]),
    1,0,null,0,13],
  ["Email 1","email_1","email",null,1,1,null,0,14],
  ["Email 1 Status","email_1_status","select",
    JSON.stringify(["Unverified","Valid","Invalid","Abuse","Do not mail","Catch-all score"]),
    1,0,"zerobounce",0,15],
  ["GK","gk","text",null,1,0,null,0,16],
  ["Lead Score","lead_score","number",null,1,1,null,0,17],
  ["Lead Score Reason","lead_score_reason","text",null,1,1,null,0,18],
  ["Suggest Human","suggest_human","long_text",null,1,0,null,0,19],
  ["Suggest AI","suggest_ai","long_text",null,0,1,null,0,20],
  ["Manual Comment","manual_comment","long_text",null,1,0,null,0,21]
];

fields.forEach(f => {
  db.run(
    `INSERT OR IGNORE INTO fields
     (label, key, type, options, editable, enrichable, integration_source, system_derived, order_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f
  );
});

/* ---------------- API ---------------- */

app.get("/api/fields", (req, res) => {
  db.all("SELECT * FROM fields WHERE hidden = 0 ORDER BY order_index", (_, rows) => {
    res.json(rows);
  });
});

app.get("/api/leads", (req, res) => {
  db.all("SELECT * FROM leads", (_, leads) => {
    db.all("SELECT * FROM lead_values", (_, values) => {
      const map = {};
      leads.forEach(l => map[l.id] = { id: l.id });
      values.forEach(v => {
        if (map[v.lead_id]) map[v.lead_id][v.field_key] = v.value;
      });
      res.json(Object.values(map));
    });
  });
});

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("CRM running on port", PORT));
