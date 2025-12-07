const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const { v4: uuid } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
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

/* ------------------ ✅ FIXED: GET LEADS ------------------ */
app.get('/api/leads', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        l.id AS lead_id,
        f.key AS field_key,
        lv.value
      FROM leads l
      LEFT JOIN leads_value lv ON lv.lead_id = l.id
      LEFT JOIN fields f ON f.key = lv.field_key
      WHERE l.deleted_at IS NULL
      ORDER BY l.created_at DESC
    `);

    const leadsMap = {};

    result.rows.forEach(row => {
      if (!leadsMap[row.lead_id]) {
        leadsMap[row.lead_id] = { id: row.lead_id };
      }
      if (row.field_key) {
        leadsMap[row.lead_id][row.field_key] = row.value ?? '';
      }
    });

    res.json(Object.values(leadsMap));
  } catch (err) {
    console.error('LEADS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------ ✅ FIXED: CREATE LEAD ------------------ */
app.post('/api/leads', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const leadId = uuid();

    await client.query(
      `INSERT INTO leads (id) VALUES ($1)`,
      [leadId]
    );

    const fields = await client.query(
      `SELECT key FROM fields WHERE hidden = false`
    );

    for (const f of fields.rows) {
      await client.query(
        `
        INSERT INTO leads_value
          (lead_id, field_key, value, source, locked)
        VALUES
          ($1, $2, '', 'manual', false)
        `,
        [leadId, f.key]
      );
    }

    await client.query(
      `
      INSERT INTO action_log (lead_id, action_type, details)
      VALUES ($1,'create','Lead created')
      `,
      [leadId]
    );

    await client.query('COMMIT');
    res.json({ id: leadId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CREATE LEAD ERROR:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
        `
        INSERT INTO action_log (lead_id, action_type, details)
        VALUES ($1,'delete','Lead deleted')
        `,
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
