const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");

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
    email TEXT,
    company TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --------------------
// API
// --------------------
app.get("/api/leads", (req, res) => {
  db.all("SELECT * FROM leads ORDER BY created_at DESC", (err, rows) => {
    res.json(rows || []);
  });
});

app.post("/api/leads", (req, res) => {
  const { full_name, email, company } = req.body;
  const id = uuidv4();

  db.run(
    "INSERT INTO leads (id, full_name, email, company) VALUES (?, ?, ?, ?)",
    [id, full_name || "", email || "", company || ""],
    () => {
      res.json({ success: true });
    }
  );
});

// --------------------
// UI (SERVER RENDERED)
// --------------------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AltoCRM</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 30px; }
    input, button { padding: 10px; margin: 6px 0; display: block; }
    table { border-collapse: collapse; margin-top: 20px; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
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
async function loadLeads() {
  const res = await fetch('/api/leads');
  const leads = await res.json();
  document.getElementById('tableBody').innerHTML =
    leads.map(l => \`
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      full_name: full_name.value,
      email: email.value,
      company: company.value
    })
  });
  full_name.value = '';
  email.value = '';
  company.value = '';
  loadLeads();
};

loadLeads();
</script>

</body>
</html>
  `);
});

// --------------------
app.listen(PORT, () => {
  console.log("CRM running on port", PORT);
});
