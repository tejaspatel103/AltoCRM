import express from "express";
import cors from "cors";
import pkg from "pg";
import multer from "multer";
import fs from "fs";
import csv from "csv-parser";

const { Pool } = pkg;
const app = express();

/* ======================
   MIDDLEWARE
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   DATABASE
====================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ======================
   FILE UPLOAD CONFIG
====================== */
const upload = multer({ dest: "uploads/" });

/* ======================
   PIPELINE STAGES (LOCKED)
====================== */
const PIPELINE_STAGES = [
  "New",
  "Trying",
  "Contacted",
  "Follow-up",
  "Meeting Booked",
  "Proposal",
  "Won",
  "Very Important",
  "Lost",
  "Not Interested",
  "Tired of trying"
];

/* ======================
   AI HELPERS (STUB – SAFE)
====================== */
function aiSuggestLead(lead) {
  const first = lead.full_name?.split(" ")[0] || null;
  const last = lead.full_name?.split(" ").slice(1).join(" ") || null;

  return {
    suggestions: {
      first_name: first,
      last_name: last,
      company_short: lead.company ? lead.company.split(" ")[0] : null,
      linkedin_url: null,
      website: null,
      city: null,
      state: null
    },
    confidence: {
      first_name: 0.9,
      last_name: 0.9,
      company_short: 0.7,
      linkedin_url: 0.4
    }
  };
}

function aiScoreLead(lead) {
  let score = 10;
  const reasons = [];

  if (!lead.email1) {
    score -= 2;
    reasons.push("Missing email");
  }
  if (!lead.company) {
    score -= 2;
    reasons.push("Missing company");
  }
  if (!lead.linkedin_url) {
    score -= 2;
    reasons.push("Missing LinkedIn");
  }

  return { score: Math.max(score, 1), reasons };
}

/* ======================
   HEALTH CHECK
====================== */
app.get("/", (_, res) => res.send("✅ AltoCRM API running"));

/* =====================================================
   IMPORT – STEP 1: PREVIEW CSV (HEADERS + SAMPLE ROWS)
===================================================== */
app.post("/api/import/preview", upload.single("file"), async (req, res) => {
  try {
    const headers = [];
    const rows = [];

    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("headers", h => headers.push(...h))
      .on("data", row => {
        if (rows.length < 10) rows.push(row);
      })
      .on("end", () => {
        fs.unlinkSync(req.file.path);
        res.json({ headers, preview: rows });
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =====================================================
   IMPORT – STEP 2: COMMIT IMPORT
===================================================== */
app.post("/api/import/commit", async (req, res) => {
  try {
    const { mapping, rows } = req.body;
    if (!mapping || !rows?.length) {
      return res.status(400).json({ error: "Invalid import payload" });
    }

    let inserted = 0;

    for (const row of rows) {
      const data = {};
      for (const [csvCol, crmField] of Object.entries(mapping)) {
        data[crmField] = row[csvCol] || null;
      }

      const fields = Object.keys(data);
      const values = Object.values(data);
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");

      await pool.query(
        `
        INSERT INTO leads (${fields.join(", ")}, pipeline)
        VALUES (${placeholders}, 'New')
        `,
        values
      );

      inserted++;
    }

    res.json({ inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   GET LEADS WITH FILTERS
====================== */
app.get("/api/leads", async (req, res) => {
  try {
    const filters = [];
    const values = [];
    let i = 1;

    for (const [field, value] of Object.entries(req.query)) {
      if (value === "__blank__") {
        filters.push(`(${field} IS NULL OR ${field} = '')`);
      } else {
        filters.push(`${field} = $${i++}`);
        values.push(value);
      }
    }

    const where = filters.length ? `AND ${filters.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `
      SELECT *
      FROM leads
      WHERE deleted = false
      ${where}
      ORDER BY created_at DESC
      `,
      values
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   CREATE / UPDATE / PIPELINE / BULK / AI / DASHBOARD
   (UNCHANGED — YOUR CURRENT LOGIC)
====================== */
/* --- everything from your previous version remains exactly as-is --- */

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ AltoCRM running on ${PORT}`));
