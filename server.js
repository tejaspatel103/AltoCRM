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

/* ------------------ HEALTH CHECK ------------------ */
app.get('/api/health', (_, res) => res.json({ ok: true }));

/* ------------------ FIELDS (CRM SCHEMA) ------------------ */
app.get('/api/fields', async (_req, res) => {
  try {
    const result = await pool.query(`
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
    res.json(result.rows);
  } catch (err) {
    console.error('FIELDS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ GET LEADS ------------------ */
app.get('/api/leads', async (_req, res) => {
  try {
    const leads = await pool.query(`
      SELECT id
      FROM leads
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
    `);

    const values = await pool.query(`
      SELECT lead_id, field_key, value
      FROM leads_value
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
    await pool.query(`INSERT INTO leads (id) VALUES ($1)`, [id]);
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
      INSERT INTO leads_value (lead_id, field_key, value, source, locked)
      VALUES ($1,$2,$3,$4,true)
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
      VALUES ($1,'update',$2)
      `,
      [lead_id, `${field_key} updated`]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('UPDATE VALUE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ DELETE LEAD (SOFT) ------------------ */
app.post('/api/leads/delete', async (req, res) => {
  const { ids } = req.body;
  try {
    await pool.query(
      `UPDATE leads SET deleted_at = now() WHERE id = ANY($1)`,
      [ids]
    );

    for (const id of ids) {
      await pool.query(
        `INSERT INTO action_log (lead_id, action_type, details)
         VALUES ($1,'delete','Lead deleted')`,
        [id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE ERROR:', err);
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
