const express = require('express');
const router = express.Router();
const TripService = require('../services/tripService');
const BookingService = require('../services/bookingService');
const { query } = require('../db/pool');

// GET /admin/trips/:tripId/metrics
router.get('/trips/:tripId/metrics', async (req, res, next) => {
  try {
    const trip = await TripService.getById(req.params.tripId);
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const stats = await BookingService.getTripBookingStats(trip.id);

    const bookedSeats = parseInt(stats.booked_seats, 10) || 0;
    const grossRevenue = parseFloat(stats.gross_revenue) || 0;
    const refundsIssued = parseFloat(stats.refunds_issued) || 0;
    const occupancyPercent = trip.max_capacity > 0
      ? Math.round((bookedSeats / trip.max_capacity) * 100)
      : 0;

    res.json({
      trip_id: trip.id,
      title: trip.title,
      occupancy_percent: occupancyPercent,
      total_seats: trip.max_capacity,
      booked_seats: bookedSeats,
      available_seats: trip.available_seats,
      booking_summary: {
        confirmed: parseInt(stats.confirmed, 10) || 0,
        pending_payment: parseInt(stats.pending_payment, 10) || 0,
        cancelled: parseInt(stats.cancelled, 10) || 0,
        expired: parseInt(stats.expired, 10) || 0,
      },
      financial: {
        gross_revenue: grossRevenue,
        refunds_issued: refundsIssued,
        net_revenue: Math.round((grossRevenue - refundsIssued) * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/trips/at-risk
// Returns trips departing within 7 days with occupancy < 50%
router.get('/trips/at-risk', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.id, t.title, t.start_date, t.max_capacity, t.available_seats,
              COALESCE(SUM(b.num_seats) FILTER (WHERE b.state IN ('CONFIRMED','PENDING_PAYMENT')), 0) AS booked_seats
       FROM trips t
       LEFT JOIN bookings b ON b.trip_id = t.id
       WHERE t.status = 'PUBLISHED'
         AND t.start_date > NOW()
         AND t.start_date <= NOW() + INTERVAL '7 days'
       GROUP BY t.id
       ORDER BY t.start_date ASC`
    );

    const atRiskTrips = result.rows
      .map(row => {
        const booked = parseInt(row.booked_seats, 10) || 0;
        const occupancy = row.max_capacity > 0
          ? Math.round((booked / row.max_capacity) * 100)
          : 0;
        return {
          trip_id: row.id,
          title: row.title,
          departure_date: row.start_date,
          total_seats: row.max_capacity,
          booked_seats: booked,
          available_seats: row.available_seats,
          occupancy_percent: occupancy,
          reason: 'Low occupancy with imminent departure',
        };
      })
      .filter(t => t.occupancy_percent < 50);

    res.json({ at_risk_trips: atRiskTrips });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
