/**
 * Booking Service
 * 
 * Handles all database operations for bookings.
 * 
 * Booking lifecycle: PENDING_PAYMENT → CONFIRMED | EXPIRED → CANCELLED
 * 
 * Key points:
 * - idempotency_key is UNIQUE — prevents duplicate webhook processing
 * - expires_at is set to NOW() + 15 minutes on creation
 * - state transitions are validated before execution
 */

const { query } = require('../db/pool');

const BookingService = {
  /**
   * Create a new booking within a transaction.
   * Called after seats have been successfully decremented.
   */
  async create(client, data) {
    const {
      trip_id, user_id, num_seats, price_at_booking,
      idempotency_key, expires_at,
    } = data;

    const result = await client.query(
      `INSERT INTO bookings
        (trip_id, user_id, num_seats, state, price_at_booking,
         idempotency_key, expires_at)
       VALUES ($1, $2, $3, 'PENDING_PAYMENT', $4, $5, $6)
       RETURNING *`,
      [trip_id, user_id, num_seats, price_at_booking, idempotency_key, expires_at]
    );
    return result.rows[0];
  },

  /**
   * Get booking by ID.
   */
  async getById(bookingId) {
    const result = await query(
      `SELECT b.*, t.title as trip_title, t.start_date as trip_start_date,
              t.refundable_until_days_before, t.cancellation_fee_percent
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = $1`,
      [bookingId]
    );
    return result.rows[0] || null;
  },

  /**
   * Get booking by ID with row lock (FOR UPDATE) within a transaction.
   */
  async getByIdForUpdate(client, bookingId) {
    const result = await client.query(
      `SELECT b.*, t.title as trip_title, t.start_date as trip_start_date,
              t.refundable_until_days_before, t.cancellation_fee_percent
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = $1
       FOR UPDATE OF b`,
      [bookingId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find booking by idempotency_key (for webhook deduplication).
   */
  async getByIdempotencyKey(idempotencyKey) {
    const result = await query(
      `SELECT * FROM bookings WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return result.rows[0] || null;
  },

  /**
   * Update booking state to CONFIRMED (after successful payment webhook).
   */
  async confirmBooking(client, bookingId, paymentReference) {
    const result = await client.query(
      `UPDATE bookings
       SET state = 'CONFIRMED', payment_reference = $2
       WHERE id = $1 AND state = 'PENDING_PAYMENT'
       RETURNING *`,
      [bookingId, paymentReference]
    );
    return result.rows[0] || null;
  },

  /**
   * Update booking state to EXPIRED.
   */
  async expireBooking(client, bookingId) {
    const result = await client.query(
      `UPDATE bookings
       SET state = 'EXPIRED'
       WHERE id = $1 AND state = 'PENDING_PAYMENT'
       RETURNING *`,
      [bookingId]
    );
    return result.rows[0] || null;
  },

  /**
   * Cancel booking and set refund amount.
   */
  async cancelBooking(client, bookingId, refundAmount) {
    const result = await client.query(
      `UPDATE bookings
       SET state = 'CANCELLED',
           cancelled_at = NOW(),
           refund_amount = $2
       WHERE id = $1 AND state IN ('PENDING_PAYMENT', 'CONFIRMED')
       RETURNING *`,
      [bookingId, refundAmount]
    );
    return result.rows[0] || null;
  },

  /**
   * Find all expired PENDING_PAYMENT bookings (for auto-expiry job).
   * Returns bookings where expires_at < NOW() and state is still PENDING_PAYMENT.
   */
  async findExpiredPending() {
    const result = await query(
      `SELECT id, trip_id, num_seats
       FROM bookings
       WHERE state = 'PENDING_PAYMENT'
         AND expires_at < NOW()`
    );
    return result.rows;
  },

  /**
   * Get all bookings for a trip (for admin metrics).
   */
  async getByTripId(tripId) {
    const result = await query(
      `SELECT * FROM bookings WHERE trip_id = $1 ORDER BY created_at DESC`,
      [tripId]
    );
    return result.rows;
  },

  /**
   * Get aggregated booking stats for a trip (for admin metrics).
   * Single query instead of fetching all rows and aggregating in JS.
   */
  async getTripBookingStats(tripId) {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'CONFIRMED') AS confirmed,
         COUNT(*) FILTER (WHERE state = 'PENDING_PAYMENT') AS pending_payment,
         COUNT(*) FILTER (WHERE state = 'CANCELLED') AS cancelled,
         COUNT(*) FILTER (WHERE state = 'EXPIRED') AS expired,
         COALESCE(SUM(price_at_booking) FILTER (WHERE state = 'CONFIRMED'), 0) AS gross_revenue,
         COALESCE(SUM(refund_amount) FILTER (WHERE state = 'CANCELLED' AND refund_amount > 0), 0) AS refunds_issued,
         COALESCE(SUM(num_seats) FILTER (WHERE state IN ('CONFIRMED', 'PENDING_PAYMENT')), 0) AS booked_seats
       FROM bookings
       WHERE trip_id = $1`,
      [tripId]
    );
    return result.rows[0];
  },
};

module.exports = BookingService;
