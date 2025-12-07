const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const { v4: uuid } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ------------------ HEALTH ------------------ */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/* ------------------ FIELDS ------------------ */
app.get('/api/fields', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT label, key, type, options, editable, enrichable, order_index
      FROM public.fields
      WHERE hidden = false
      ORDER BY order_index
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------ GET LEADS (FIXED) ------------------ */
app.get('/api/leads', async (_req, res) => {
  try {
    const rows = await pool.query(`
      SELECT
        l.id AS lead_id,
        v.field_key,
        v.value
      FROM public.leads l
      LEFT JOIN public.leads_value v ON v.lead_id = l.id
      ORDER BY l.id DESC
    `);

    const map = {};

    rows.rows.forEach(r => {
      if (!map[r.lead_id]) map[r.lead_id] = { id: r.lead_id };
      if (r.field_key) map[r.lead_id][r.field_key] = r.value ?? '';
    });

    res.json(Object.values(map));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------ CREATE LEAD (FIXED) ------------------ */
app.post('/api/leads', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const leadId = uuid();

    await client.query(
      `INSERT INTO public.leads (id) VALUES ($1)`,
      [leadId]
    );

    const fields = await client.query(
      `SELECT key FROM public.fields WHERE hidden = false`
    );

    for (const f of fields.rows) {
      await client.query(
        `
        INSERT INTO public.leads_value
          (lead_id, field_key, value, source, locked)
        VALUES ($1, $2, '', 'manual', false)
        `,
        [leadId, f.key]
      );
    }

    await client.query(
      `
      INSERT INTO public.action_log (lead_id, action_type, details)
      VALUES ($1, 'create', 'Lead created')
      `,
      [leadId]
    );

    await client.query('COMMIT');
    res.json({ id: leadId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ------------------ UPDATE CELL ------------------ */
app.post('/api/lead-value', async (req, res) => {
  const { lead_id, field_key, value } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO public.leads_value
        (lead_id, field_key, value, source, locked)
      VALUES ($1,$2,$3,'manual',true)
      ON CONFLICT (lead_id, field_key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `,
      [lead_id, field_key, value]
    );

    await pool.query(
      `
      INSERT INTO public.action_log (lead_id, action_type, details)
      VALUES ($1,'update',$2)
      `,
      [lead_id, `${field_key} updated`]
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------ FRONTEND ------------------ */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------ START ------------------ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ AltoCRM running on port ${PORT}`);
});
