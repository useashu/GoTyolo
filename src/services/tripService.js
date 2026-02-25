/**
 * Trip Service
 * 
 * Handles all database operations for trips.
 * Trips are the core entity — each trip has a capacity, price, dates, 
 * and an embedded refund policy.
 * 
 * available_seats is denormalized here for performance:
 *   - Reads don't need to JOIN/aggregate bookings
 *   - Atomic decrement via SQL prevents overselling under concurrency
 *   - Trade-off: must be kept in sync on every booking/cancel/expire
 */

const { query } = require('../db/pool');

const TripService = {
  /**
   * List all published trips, with optional destination filter.
   * Only PUBLISHED trips are visible to users.
   */
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

  /**
   * Get a single trip by ID. Returns null if not found.
   */
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

  /**
   * Create a new trip (admin action).
   * Defaults: status=DRAFT, available_seats=max_capacity.
   */
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
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
       RETURNING *`,
      [title, destination, start_date, end_date, price,
       max_capacity, status,
       refundable_until_days_before, cancellation_fee_percent]
    );
    return result.rows[0];
  },

  /**
   * Lock a trip row FOR UPDATE within a transaction.
   * This is the core concurrency mechanism — any concurrent booking
   * on the same trip will block here until the first transaction commits.
   */
  async getByIdForUpdate(client, tripId) {
    const result = await client.query(
      `SELECT * FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId]
    );
    return result.rows[0] || null;
  },

  /**
   * Atomically decrement available_seats within a transaction.
   * The CHECK constraint (available_seats >= 0) acts as a final safety net.
   */
  async decrementSeats(client, tripId, numSeats) {
    const result = await client.query(
      `UPDATE trips
       SET available_seats = available_seats - $2
       WHERE id = $1 AND available_seats >= $2
       RETURNING available_seats`,
      [tripId, numSeats]
    );
    return result.rowCount > 0; // false if not enough seats
  },

  /**
   * Atomically increment available_seats (on cancel/expire).
   * Capped at max_capacity by the DB CHECK constraint.
   */
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
