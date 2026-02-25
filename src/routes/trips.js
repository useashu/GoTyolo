const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../db/pool');
const TripService = require('../services/tripService');
const BookingService = require('../services/bookingService');

router.get('/', async (req, res, next) => {
  try {
    const filters = {};
    if (req.query.destination) {
      filters.destination = req.query.destination;
    }
    const trips = await TripService.listPublished(filters);
    res.json({ trips });
  } catch (err) {
    next(err);
  }
});

router.get('/:tripId', async (req, res, next) => {
  try {
    const trip = await TripService.getById(req.params.tripId);
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      title, destination, start_date, end_date, price,
      max_capacity, status, refundable_until_days_before,
      cancellation_fee_percent,
    } = req.body;

    if (!title || !destination || !start_date || !end_date || !price || !max_capacity) {
      return res.status(400).json({
        error: 'Missing required fields: title, destination, start_date, end_date, price, max_capacity',
      });
    }

    if (new Date(end_date) <= new Date(start_date)) {
      return res.status(400).json({ error: 'end_date must be after start_date' });
    }

    if (price < 0) {
      return res.status(400).json({ error: 'price must be non-negative' });
    }

    if (max_capacity < 1) {
      return res.status(400).json({ error: 'max_capacity must be at least 1' });
    }

    const trip = await TripService.create({
      title, destination, start_date, end_date, price,
      max_capacity, status, refundable_until_days_before,
      cancellation_fee_percent,
    });

    res.status(201).json({ trip });
  } catch (err) {
    next(err);
  }
});

router.post('/:tripId/book', async (req, res, next) => {
  const client = await getClient();
  try {
    const { user_id, num_seats = 1 } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (num_seats < 1) {
      return res.status(400).json({ error: 'num_seats must be at least 1' });
    }

    await client.query('BEGIN');

    const trip = await TripService.getByIdForUpdate(client, req.params.tripId);

    if (!trip) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Trip not found' });
    }

    if (trip.status !== 'PUBLISHED') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Trip is not available for booking' });
    }

    if (trip.available_seats < num_seats) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Not enough seats available',
        available_seats: trip.available_seats,
        requested: num_seats,
      });
    }

    const decremented = await TripService.decrementSeats(client, trip.id, num_seats);
    if (!decremented) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not enough seats available' });
    }

    const expiryMinutes = parseInt(process.env.BOOKING_EXPIRY_MINUTES, 10) || 15;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const booking = await BookingService.create(client, {
      trip_id: trip.id,
      user_id,
      num_seats,
      price_at_booking: parseFloat(trip.price) * num_seats,
      idempotency_key: uuidv4(),
      expires_at: expiresAt,
    });

    await client.query('COMMIT');

    res.status(201).json({
      booking,
      payment_url: `https://pay.gotyolo.mock/checkout/${booking.id}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
