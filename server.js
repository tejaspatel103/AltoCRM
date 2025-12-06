const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// ---- Database
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

// ---- APIs
app.get("/api/leads", (req, res) => {
  const q = req.query.q || "";
  const sort = req.query.sort || "new";

  let orderBy = "created_at DESC";
  if (sort === "old") orderBy = "created_at ASC";
  if (sort === "name") orderBy = "full_name ASC";

  db.all(
    `
    SELECT * FROM leads
    WHERE full_name LIKE ? OR email LIKE ? OR company LIKE ?
    ORDER BY ${orderBy}
    `,
    [`%${q}%`, `%${q}%`, `%${q}%`],
    (err, rows) => {
      res.json(rows || []);
    }
  );
});


app.post("/api/leads", (req, res) => {
  const { full_name, email, company } = req.body;
  db.run(
    "INSERT INTO leads VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
    [uuidv4(), full_name || "", email || "", company || ""],
    () => res.json({ success: true })
  );
});

app.listen(PORT, () =>
  console.log("CRM running on port", PORT)
);
