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
app.use(express.static("public"));


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
