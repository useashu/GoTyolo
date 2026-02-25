const express = require('express');
const router = express.Router();
const { getClient } = require('../db/pool');
const TripService = require('../services/tripService');
const BookingService = require('../services/bookingService');

router.get('/:bookingId', async (req, res, next) => {
  try {
    const booking = await BookingService.getById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.json({ booking });
  } catch (err) {
    next(err);
  }
});

router.post('/:bookingId/cancel', async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const booking = await BookingService.getByIdForUpdate(client, req.params.bookingId);

    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.state === 'CANCELLED' || booking.state === 'EXPIRED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Cannot cancel a booking that is already ${booking.state}`,
      });
    }

    if (booking.state !== 'PENDING_PAYMENT' && booking.state !== 'CONFIRMED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot cancel booking in state ${booking.state}` });
    }

    const tripStartDate = new Date(booking.trip_start_date);
    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysUntilTrip = Math.floor((tripStartDate - now) / msPerDay);

    let refundAmount = 0;
    const isBeforeCutoff = daysUntilTrip > booking.refundable_until_days_before;

    if (isBeforeCutoff) {
      // Before cutoff: refund with cancellation fee deducted
      const feePercent = booking.cancellation_fee_percent || 0;
      refundAmount = parseFloat(booking.price_at_booking) * (1 - feePercent / 100);
      refundAmount = Math.round(refundAmount * 100) / 100;
    }
    // After cutoff: refundAmount stays 0

    const cancelled = await BookingService.cancelBooking(client, booking.id, refundAmount);
    if (!cancelled) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Booking could not be cancelled' });
    }

    // Only release seats if before cutoff; after cutoff trip is imminent, seats stay reserved
    if (isBeforeCutoff) {
      await TripService.incrementSeats(client, booking.trip_id, booking.num_seats);
    }

    await client.query('COMMIT');

    res.json({
      booking: cancelled,
      refund: {
        amount: refundAmount,
        is_refundable: isBeforeCutoff,
        days_until_trip: daysUntilTrip,
        cutoff_days: booking.refundable_until_days_before,
        cancellation_fee_percent: booking.cancellation_fee_percent,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
