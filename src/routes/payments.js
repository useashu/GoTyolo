const express = require('express');
const router = express.Router();
const { getClient } = require('../db/pool');
const BookingService = require('../services/bookingService');
const TripService = require('../services/tripService');

router.post('/webhook', async (req, res) => {
  const { booking_id, status, idempotency_key, payment_reference } = req.body;

  if (!booking_id || !status || !idempotency_key) {
    console.log('Webhook received with missing fields, acknowledging anyway');
    return res.status(200).json({ received: true });
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const booking = await BookingService.getByIdForUpdate(client, booking_id);

    if (!booking) {
      await client.query('ROLLBACK');
      console.log(`Webhook for unknown booking ${booking_id}, ignoring`);
      return res.status(200).json({ received: true });
    }

    // Idempotency check: if this booking is already past PENDING_PAYMENT,
    // the webhook was already processed (or booking expired)
    if (booking.state !== 'PENDING_PAYMENT') {
      await client.query('ROLLBACK');
      console.log(`Duplicate webhook for booking ${booking_id}, state=${booking.state}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Check if expires_at has passed — treat as expired even if webhook arrives late
    if (new Date(booking.expires_at) < new Date()) {
      const expired = await BookingService.expireBooking(client, booking_id);
      if (expired) {
        await TripService.incrementSeats(client, booking.trip_id, booking.num_seats);
      }
      await client.query('COMMIT');
      console.log(`Webhook arrived too late for booking ${booking_id}, already expired`);
      return res.status(200).json({ received: true, expired: true });
    }

    if (status === 'success') {
      await BookingService.confirmBooking(client, booking_id, payment_reference || idempotency_key);
      await client.query('COMMIT');
      console.log(`Booking ${booking_id} confirmed via webhook`);
      return res.status(200).json({ received: true, booking_state: 'CONFIRMED' });
    }

    if (status === 'failed') {
      await BookingService.expireBooking(client, booking_id);
      await TripService.incrementSeats(client, booking.trip_id, booking.num_seats);
      await client.query('COMMIT');
      console.log(`Booking ${booking_id} payment failed, seats released`);
      return res.status(200).json({ received: true, booking_state: 'EXPIRED' });
    }

    // Unknown status — just acknowledge
    await client.query('ROLLBACK');
    console.log(`Webhook with unknown status "${status}" for booking ${booking_id}`);
    return res.status(200).json({ received: true });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Webhook processing error:', err.message);
    return res.status(200).json({ received: true });
  } finally {
    client.release();
  }
});

module.exports = router;
