// server.js
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8080;

// ---- DB SETUP -------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

// Simple connectivity check
async function checkDb() {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB ready");
  } catch (err) {
    console.error("❌ DB connection error:", err.message);
  }
}

// ---- MIDDLEWARE -----------------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

// root route -> index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- HELPERS --------------------------------------------------------------

// Fetch visible fields (columns)
async function getFields() {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        label,
        key,
        type,
        options,
        editable,
        enrichable,
        integration_source,
        system_derived,
        order_index,
        hidden
      FROM fields
      WHERE hidden = false OR hidden IS NULL
      ORDER BY order_index ASC, id ASC
    `
  );
  return rows;
}

// Fetch all leads as a pivoted grid from leads_value
async function getLeadsGrid() {
  // all distinct lead_ids based on leads_value
  const { rows: entries } = await pool.query(
    `
      WITH all_leads AS (
        SELECT DISTINCT lead_id
        FROM leads_value
      )
      SELECT
        al.lead_id,
        f.key AS field_key,
        lv.value
      FROM all_leads al
      CROSS JOIN fields f
      LEFT JOIN leads_value lv
        ON lv.lead_id = al.lead_id
       AND lv.field_key = f.key
      WHERE (f.hidden = false OR f.hidden IS NULL)
      ORDER BY al.lead_id, f.order_index, f.id
    `
  );

  const leadsMap = new Map();

  for (const row of entries) {
    const leadId = row.lead_id;
    if (!leadsMap.has(leadId)) {
      leadsMap.set(leadId, { id: leadId });
    }
    const lead = leadsMap.get(leadId);
    lead[row.field_key] = row.value === null ? "" : row.value;
  }

  return Array.from(leadsMap.values());
}

// Insert/Update one cell in leads_value
async function upsertLeadValue({ leadId, fieldKey, value, source = "manual", locked = false }) {
  // delete existing cell
  await pool.query(
    `
      DELETE FROM leads_value
      WHERE lead_id = $1 AND field_key = $2
    `,
    [leadId, fieldKey]
  );

  // insert new value
  await pool.query(
    `
      INSERT INTO leads_value (lead_id, field_key, value, source, locked, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, NOW(), NULL)
    `,
    [leadId, fieldKey, value, source, locked]
  );
}

// ---- API ROUTES -----------------------------------------------------------

// GET /api/leads -> fields + grid
app.get("/api/leads", async (req, res) => {
  try {
    const fields = await getFields();
    const leads = await getLeadsGrid();
    res.json({ fields, leads });
  } catch (err) {
    console.error("GET /api/leads error:", err);
    res.status(500).json({ error: "Failed to load leads" });
  }
});

// POST /api/leads -> create a new blank lead (at least one cell so it appears in grid)
app.post("/api/leads", async (req, res) => {
  try {
    // generate uuid (Node 22+ has crypto.randomUUID)
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : require("crypto").randomBytes(16).toString("hex");

    // ensure it appears in grid by inserting a single empty full_name cell
    await pool.query(
      `
        INSERT INTO leads_value (lead_id, field_key, value, source, locked, updated_at, updated_by)
        VALUES ($1, $2, $3, 'manual', false, NOW(), NULL)
      `,
      [id, "full_name", ""]
    );

    res.json({ id });
  } catch (err) {
    console.error("POST /api/leads error:", err);
    res.status(500).json({ error: "Failed to create lead" });
  }
});

// PUT /api/leads/:leadId/fields/:fieldKey -> update one cell
app.put("/api/leads/:leadId/fields/:fieldKey", async (req, res) => {
  const { leadId, fieldKey } = req.params;
  const { value, source, locked } = req.body || {};

  try {
    await upsertLeadValue({
      leadId,
      fieldKey,
      value: value ?? "",
      source: source || "manual",
      locked: !!locked,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /api/leads/:leadId/fields/:fieldKey error:", err);
    res.status(500).json({ error: "Failed to update cell" });
  }
});

// DELETE /api/leads/:leadId -> hard delete from leads_value
// (Undo is handled on the frontend by delaying this call)
app.delete("/api/leads/:leadId", async (req, res) => {
  const { leadId } = req.params;
  try {
    await pool.query(
      `
        DELETE FROM leads_value
        WHERE lead_id = $1
      `,
      [leadId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/leads/:leadId error:", err);
    res.status(500).json({ error: "Failed to delete lead" });
  }
});

// POST /api/leads/bulk-delete -> delete multiple leads
// body: { ids: [leadId1, leadId2, ...] }
app.post("/api/leads/bulk-delete", async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: true });
  }

  try {
    // simple & safe: delete one by one
    for (const id of ids) {
      await pool.query(
        `
          DELETE FROM leads_value
          WHERE lead_id = $1
        `,
        [id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/leads/bulk-delete error:", err);
    res.status(500).json({ error: "Failed to bulk delete leads" });
  }
});

// health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- STARTUP --------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
  checkDb();
});
