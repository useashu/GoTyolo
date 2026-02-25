const { query } = require('../db/pool');

const TripService = {
  async listPublished(filters = {}) {
    let sql = `
      SELECT id, title, destination, start_date, end_date, price,
             max_capacity, available_seats, status,
             refundable_until_days_before, cancellation_fee_percent,
             created_at, updated_at
      FROM trips
      WHERE status = 'PUBLISHED'
    `;
    const params = [];

    if (filters.destination) {
      params.push(`%${filters.destination}%`);
      sql += ` AND destination ILIKE $${params.length}`;
    }

    sql += ` ORDER BY start_date ASC`;

    const result = await query(sql, params);
    return result.rows;
  },

  async getById(tripId) {
    const result = await query(
      `SELECT id, title, destination, start_date, end_date, price,
              max_capacity, available_seats, status,
              refundable_until_days_before, cancellation_fee_percent,
              created_at, updated_at
       FROM trips
       WHERE id = $1`,
      [tripId]
    );
    return result.rows[0] || null;
  },

  async create(data) {
    const {
      title, destination, start_date, end_date, price,
      max_capacity, status = 'DRAFT',
      refundable_until_days_before = 7,
      cancellation_fee_percent = 10,
    } = data;

    const result = await query(
      `INSERT INTO trips 
        (title, destination, start_date, end_date, price,
         max_capacity, available_seats, status,
         refundable_until_days_before, cancellation_fee_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [title, destination, start_date, end_date, price,
       max_capacity, max_capacity, status,
       refundable_until_days_before, cancellation_fee_percent]
    );
    return result.rows[0];
  },

  async getByIdForUpdate(client, tripId) {
    const result = await client.query(
      `SELECT * FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId]
    );
    return result.rows[0] || null;
  },

  async decrementSeats(client, tripId, numSeats) {
    const result = await client.query(
      `UPDATE trips
       SET available_seats = available_seats - $2
       WHERE id = $1 AND available_seats >= $2
       RETURNING available_seats`,
      [tripId, numSeats]
    );
    return result.rowCount > 0;
  },

  async incrementSeats(client, tripId, numSeats) {
    await client.query(
      `UPDATE trips
       SET available_seats = LEAST(available_seats + $2, max_capacity)
       WHERE id = $1`,
      [tripId, numSeats]
    );
  },
};

module.exports = TripService;
