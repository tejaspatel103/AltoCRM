const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// --------------------
// Database
// --------------------
const db = new sqlite3.Database("./crm.db");

db.run(`
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  full_name TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  company TEXT,
  company_short TEXT,
  website TEXT,
  lead_score INTEGER,
  lead_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// --------------------
// API: Get leads (with search + sort)
// --------------------
app.get("/api/leads", (req, res) => {
  const q = req.query.q || "";
  const sort = req.query.sort || "new";

  let orderBy = "created_at DESC";
  if (sort === "old") orderBy = "created_at ASC";
  if (sort === "name") orderBy = "full_name ASC";

  db.all(
    `
    SELECT *
    FROM leads
    WHERE 
      full_name LIKE ? OR
      email LIKE ? OR
      company LIKE ?
    ORDER BY ${orderBy}
    `,
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});

// --------------------
// API: Create lead
// --------------------
app.post("/api/leads", (req, res) => {
  const { full_name, email, company } = req.body;
  db.run(
    `INSERT INTO leads (id, full_name, email, company)
     VALUES (?, ?, ?, ?)`,
    [uuidv4(), full_name || "", email || "", company || ""],
    () => res.json({ success: true })
  );
});

// --------------------
// API: AI Enrichment
// --------------------
app.post("/api/enrich/:id", async (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM leads WHERE id = ?", [id], async (err, lead) => {
    if (!lead) return res.json({ error: "Not found" });

    const prompt = `
You are enriching CRM data.

Full Name: ${lead.full_name}
Email: ${lead.email}
Company: ${lead.company}

Return ONLY valid JSON:
{
  "first_name":"",
  "last_name":"",
  "company_short":"",
  "website":"",
  "lead_score":1,
  "lead_reason":""
}
`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0
      })
    });

    const ai = JSON.parse((await r.json()).choices[0].message.content);

    db.run(
      `UPDATE leads SET
        first_name=?,
        last_name=?,
        company_short=?,
        website=?,
        lead_score=?,
        lead_reason=?
       WHERE id=?`,
      [
        ai.first_name,
        ai.last_name,
        ai.company_short,
        ai.website,
        ai.lead_score,
        ai.lead_reason,
        id
      ],
      () => res.json({ success: true })
    );
  });
});

// --------------------
// UI
// --------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>AltoCRM</title>
  <style>
    body { font-family: Arial; padding: 30px; }
    input, select, button { padding: 8px; margin: 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 15px; }
    th, td { border: 1px solid #ccc; padding: 8px; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>

<h1>AltoCRM</h1>

<input id="search" placeholder="Search name, email, company">
<select id="sort">
  <option value="new">Newest First</option>
  <option value="old">Oldest First</option>
  <option value="name">Name A–Z</option>
</select>

<form id="leadForm">
  <input id="full_name" placeholder="Full Name">
  <input id="email" placeholder="Email">
  <input id="company" placeholder="Company">
  <button>Add Lead</button>
</form>

<table>
<thead>
<tr>
  <th>Name</th>
  <th>Email</th>
  <th>Company</th>
  <th>AI Info</th>
  <th>Action</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>

<script>
async function load(){
  const q = search.value;
  const s = sort.value;
  const r = await fetch('/
