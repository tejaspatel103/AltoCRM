// BEFORE
const { full_name, email, company } = req.body;

await pool.query(
  `
  INSERT INTO leads (full_name, email, company)
  VALUES ($1, $2, $3)
  RETURNING *
  `,
  [full_name, email, company]
);

// AFTER
const { full_name, email1, company } = req.body;

await pool.query(
  `
  INSERT INTO leads (full_name, email1, company)
  VALUES ($1, $2, $3)
  RETURNING *
  `,
  [full_name, email1, company]
);
