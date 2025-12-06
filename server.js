const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------- DB ----------------
const db = new sqlite3.Database("./crm.db");

db.run(`
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  full_name TEXT,
  email TEXT,
  company TEXT,
  first_name TEXT,
  last_name TEXT,
  company_short TEXT,
  website TEXT,
  lead_score INTEGER,
  lead_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// ---------------- API ----------------
app.get("/api/leads", (req, res) => {
  const q = req.query.q || "";
  const sort = req.query.sort || "new";

  let order = "created_at DESC";
  if (sort === "old") order = "created_at ASC";
  if (sort === "name") order = "full_name ASC";

  db.all(
    `SELECT * FROM leads
     WHERE full_name LIKE ? OR email LIKE ? OR company LIKE ?
     ORDER BY ${order}`,
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => res.json(rows || [])
  );
});

app.post("/api/leads", (req, res) => {
  const { full_name, email, company } = req.body;
  db.run(
    `INSERT INTO leads (id, full_name, email, company)
     VALUES (?, ?, ?, ?)`,
    [uuidv4(), full_name || "", email || "", company || ""],
    () => res.json({ success: true })
  );
});

app.post("/api/enrich/:id", async (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM leads WHERE id = ?", [id], async (err, lead) => {
    if (!lead) return res.json({ error: "Not found" });

    const prompt = `
Return JSON only.

Full Name: ${lead.full_name}
Email: ${lead.email}
Company: ${lead.company}

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
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
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
        first_name=?, last_name=?, company_short=?, website=?,
        lead_score=?, lead_reason=?
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

// ---------------- UI ----------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<body style="font-family:Arial;padding:30px">

<h2>AltoCRM</h2>

<input id="q" placeholder="Search">
<select id="s">
  <option value="new">Newest</option>
  <option value="old">Oldest</option>
  <option value="name">Name A–Z</option>
</select>

<form id="f">
  <input id="n" placeholder="Full Name">
  <input id="e" placeholder="Email">
  <input id="c" placeholder="Company">
  <button>Add Lead</button>
</form>

<table border="1" cellpadding="6" style="margin-top:10px;width:100%">
<thead>
<tr><th>Name</th><th>Email</th><th>Company</th><th>AI</th><t
