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
// API: Get leads
// --------------------
app.get("/api/leads", (req, res) => {
  db.all("SELECT * FROM leads ORDER BY created_at DESC", (err, rows) => {
    res.json(rows || []);
  });
});

// --------------------
// API: Create lead
// --------------------
app.post("/api/leads", (req, res) => {
  const { full_name, email, company } = req.body;
  const id = uuidv4();

  db.run(
    `INSERT INTO leads 
      (id, full_name, email, company) 
     VALUES (?, ?, ?, ?)`,
    [id, full_name || "", email || "", company || ""],
    () => res.json({ success: true })
  );
});

// --------------------
// API: AI Enrich lead
// --------------------
app.post("/api/enrich/:id", async (req, res) => {
  const leadId = req.params.id;

  db.get("SELECT * FROM leads WHERE id = ?", [leadId], async (err, lead) => {
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const prompt = `
You are enriching CRM lead data.

Input:
Full Name: ${lead.full_name}
Email: ${lead.email}
Company: ${lead.company}

Return ONLY valid JSON like:
{
  "first_name": "",
  "last_name": "",
  "company_short": "",
  "website": "",
  "lead_score": 1,
  "lead_reason": ""
}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const data = await response.json();
    const text = data.choices[0].message.content;
    const ai = JSON.parse(text);

    db.run(
      `UPDATE leads SET
        first_name = ?,
        last_name = ?,
        company_short = ?,
        website = ?,
        lead_score = ?,
        lead_reason = ?
      WHERE id = ?`,
      [
        ai.first_name,
        ai.last_name,
        ai.company_short,
        ai.website,
        ai.lead_score,
        ai.lead_reason,
        leadId
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
    input, button { padding: 8px; margin: 5px; }
    table { border-collapse: collapse; width: 100%; margin-top: 15px; }
    th, td { border: 1px solid #ccc; padding: 8px; }
    th { background: #f4f4f4; }
  </style>
</head>
<body>

<h1>AltoCRM</h1>

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
      <th>AI Data</th>
      <th>Action</th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>

<script>
async function load() {
  const r = await fetch("/api/leads");
  const d = await r.json();

  rows.innerHTML = d.map(l => \`
    <tr>
      <td>\${l.full_name}</td>
      <td>\${l.email}</td>
      <td>\${l.company}</td>
      <td>
        \${l.first_name ? 
          'Name: ' + l.first_name + ' ' + l.last_name +
          '<br>Company Short: ' + l.company_short +
          '<br>Website: ' + l.website +
          '<br>Score: ' + l.lead_score +
          '<br>Reason: ' + l.lead_reason 
        : 'Not enriched'}
      </td>
      <td>
        <button onclick="enrich('\${l.id}')">Enrich</button>
      </td>
    </tr>
  \`).join("");
}

async function enrich(id) {
  alert("Enriching lead with AI...");
  await fetch("/api/enrich/" + id, { method: "POST" });
  load();
}

leadForm.onsubmit = async e => {
  e.preventDefault();
  await fetch("/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: full_name.value,
      email: email.value,
      company: company.value
    })
  });
  full_name.value = email.value = company.value = "";
  load();
};

load();
</script>

</body>
</html>
  `);
});

// --------------------
app.listen(PORT, () => {
  console.log("CRM running on port", PORT);
});
