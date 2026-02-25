const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../db/pool');
const TripService = require('../services/tripService');
const BookingService = require('../services/bookingService');

// POST /trips/:tripId/book — handled via mount in index.js
// But we keep booking-specific routes here

// GET /bookings/:bookingId
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

module.exports = router;
