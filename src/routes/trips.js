/**
 * Trip Routes
 * 
 * GET  /trips              - List all published trips (optional ?destination= filter)
 * GET  /trips/:tripId      - Get trip details by ID
 * POST /trips              - Create a new trip (admin)
 */

const express = require('express');
const router = express.Router();
const TripService = require('../services/tripService');

/**
 * GET /trips
 * List all published trips. Supports optional ?destination=paris filter.
 */
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

/**
 * GET /trips/:tripId
 * Get full details of a single trip.
 */
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

/**
 * POST /trips
 * Create a new trip (admin endpoint, no auth for simplicity).
 * Body: { title, destination, start_date, end_date, price, max_capacity, 
 *         status?, refundable_until_days_before?, cancellation_fee_percent? }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      title, destination, start_date, end_date, price,
      max_capacity, status, refundable_until_days_before,
      cancellation_fee_percent,
    } = req.body;

    // Basic validation
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

module.exports = router;
