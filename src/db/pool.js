const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'gotyolo',
  user: process.env.DB_USER || 'gotyolo_user',
  password: process.env.DB_PASSWORD || 'gotyolo_pass',
  max: 20,                // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Helper: run a query
const query = (text, params) => pool.query(text, params);

// Helper: get a client from pool (for transactions)
const getClient = () => pool.connect();

module.exports = { pool, query, getClient };
