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
app.get('/api/health', (_, res) => res.json({ ok: true }));

/* ------------------ FIELDS ------------------ */
app.get('/api/fields', async (_, res) => {
  const { rows } = await pool.query(`
    SELECT label, key, type, options, editable, enrichable, order_index
    FROM fields
    WHERE hidden = false
    ORDER BY order_index
  `);
  res.json(rows);
});

/* ------------------ GET LEADS (SAFE MODE) ------------------ */
app.get('/api/leads', async (_, res) => {
  try {
    const leads = await pool.query(`
      SELECT DISTINCT lead_id AS id
      FROM leads_value
      ORDER BY id
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
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ ADD LEAD ------------------ */
app.post('/api/leads', async (_, res) => {
  try {
    const id = uuid();

    await pool.query(
      `INSERT INTO leads_value (lead_id, field_key, value, source, locked)
       VALUES ($1,'full_name','', 'manual', false)
       ON CONFLICT DO NOTHING`,
      [id]
    );

    await pool.query(
      `INSERT INTO action_log (lead_id, action_type, details)
       VALUES ($1,'create','Lead created')`,
      [id]
    );

    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ UPDATE CELL ------------------ */
app.post('/api/lead-value', async (req, res) => {
  const { lead_id, field_key, value } = req.body;

  await pool.query(`
    INSERT INTO leads_value (lead_id, field_key, value, source, locked)
    VALUES ($1,$2,$3,'manual',true)
    ON CONFLICT (lead_id, field_key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `, [lead_id, field_key, value]);

  await pool.query(`
    INSERT INTO action_log (lead_id, action_type, details)
    VALUES ($1,'update',$2)
  `, [lead_id, `${field_key} updated`]);

  res.json({ success: true });
});

/* ------------------ DELETE LEAD (LOGICAL) ------------------ */
app.post('/api/leads/delete', async (req, res) => {
  const { ids } = req.body;

  await pool.query(
    `DELETE FROM leads_value WHERE lead_id = ANY($1)`,
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
});

/* ------------------ UI ------------------ */
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ AltoCRM running on ${PORT}`));
