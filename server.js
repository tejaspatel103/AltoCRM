const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const fs = require("fs");
const csv = require("csv-parser");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  next();
});
// app.use(express.static("public"));


const db = new sqlite3.Database("./crm.db");

// Create table
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
  linkedin TEXT,
  city TEXT,
  state TEXT,
  timezone TEXT,
  ai_status TEXT
)
`);
// TEMP: Serve UI directly from server
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AltoCRM</title>
  <style>
    body { font-family: Arial; padding: 30px; }
    input, button { padding: 10px; margin: 6px 0; display: block; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f2f2f2; }
  </style>
</head>
<body>

<h1>AltoCRM</h1>

<form id="leadForm">
  <input id="full_name" placeholder="Full Name" />
  <input id="email" placeholder="Email" />
  <input id="company" placeholder="Company" />
  <button type="submit">Add Lead</button>
</form>

<table>
  <thead>
    <tr>
      <th>Full Name</th>
      <th>Email</th>
      <th>Company</th>
    </tr>
  </thead>
  <tbody id="tableBody"></tbody>
</table>

<script>
async function load() {
  const r = await fetch('/api/leads');
  const d = await r.json();
  document.getElementById('tableBody').innerHTML =
    d.map(l => \`
      <tr>
        <td>\${l.full_name || ''}</td>
        <td>\${l.email || ''}</td>
        <td>\${l.company || ''}</td>
      </tr>
    \`).join('');
}

document.getElementById('leadForm').onsubmit = async e => {
  e.preventDefault();
  await fetch('/api/leads', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      full_name: full_name.value,
      email: email.value,
      company: company.value
    })
  });
  load();
};

load();
</script>

</body>
</html>
  `);
});


load();
</script>

</body>
</html>
  `);
});

app.get("/api/leads", (req, res) => {
  db.all("SELECT * FROM leads", (err, rows) => {
    res.json(rows);
  });
});

app.post("/api/leads", (req, res) => {
  const id = uuidv4();
  const lead = req.body;
  db.run(
    `INSERT INTO leads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      lead.full_name || "",
      "",
      "",
      lead.email || "",
      lead.company || "",
      "",
      lead.website || "",
      lead.linkedin || "",
      "",
      "",
      "",
      "pending"
    ]
  );
  res.json({ success: true });
});

app.listen(PORT, () =>
  console.log("CRM running at http://localhost:" + PORT)
);
