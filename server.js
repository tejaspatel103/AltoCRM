const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const { v4: uuid } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/* ------------------ HEALTH ------------------ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/* ------------------ FIELDS ------------------ */
app.get('/api/fields', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        label,
        key,
        type,
        options,
        editable,
        enrichable,
        order_index
      FROM fields
      WHERE hidden = false
      ORDER BY order_index ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('FIELDS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ GET LEADS (from "Leads_value") ------------------ */
app.get('/api/leads', async (_req, res) => {
  try {
    // Distinct lead IDs from the value table
    const leads = await pool.query(`
      SELECT DISTINCT lead_id AS id
      FROM "Leads_value"
      ORDER BY lead_id
    `);

    // All field values
    const values = await pool.query(`
      SELECT lead_id, field_key, value
      FROM "Leads_value"
    `);

    res.json({
      leads: leads.rows,
      values: values.rows
    });
  } catch (err) {
    console.error('LEADS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ CREATE LEAD ------------------ */
app.post('/api/leads', async (_req, res) => {
  try {
    const id = uuid();

    // Create at least one value row so the lead exists in the grid
    await pool.query(
      `
      INSERT INTO "Leads_value" (lead_id, field_key, value, source, locked)
      VALUES ($1, 'full_name', '', 'manual', false)
      ON CONFLICT DO NOTHING
      `,
      [id]
    );

    await pool.query(
      `
      INSERT INTO action_log (lead_id, action_type, details)
      VALUES ($1, 'create', 'Lead created')
      `,
      [id]
    );

    res.json({ id });
  } catch (err) {
    console.error('CREATE LEAD ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ UPDATE CELL ------------------ */
app.post('/api/lead-value', async (req, res) => {
  const { lead_id, field_key, value, source = 'manual' } = req.body;

  try {
    await pool.query(
      `
      INSERT INTO "Leads_value" (lead_id, field_key, value, source, locked)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (lead_id, field_key)
      DO UPDATE SET
        value = EXCLUDED.value,
        source = EXCLUDED.source,
        updated_at = now()
      `,
      [lead_id, field_key, value, source]
    );

    await pool.query(
      `
      INSERT INTO action_log (lead_id, action_type, details)
      VALUES ($1, 'update', $2)
      `,
      [lead_id, `${field_key} updated`]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE VALUE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ DELETE LEAD (hard delete from "Leads_value") ------------------ */
app.post('/api/leads/delete', async (req, res) => {
  const { ids } = req.body;

  try {
    // Remove all values for those leads
    await pool.query(
      `
      DELETE FROM "Leads_value"
      WHERE lead_id = ANY($1)
      `,
      [ids]
    );

    // Log the deletion
    for (const id of ids) {
      await pool.query(
        `
        INSERT INTO action_log (lead_id, action_type, details)
        VALUES ($1, 'delete', 'Lead deleted')
        `,
        [id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE LEADS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ SERVE UI ------------------ */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------ START ------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
