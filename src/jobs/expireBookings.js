const cron = require('node-cron');
const { getClient } = require('../db/pool');
const BookingService = require('../services/bookingService');
const TripService = require('../services/tripService');

async function expireStaleBookings() {
  const expired = await BookingService.findExpiredPending();

  if (expired.length === 0) return;

  console.log(`[expiry-job] Found ${expired.length} stale PENDING_PAYMENT booking(s)`);

  for (const booking of expired) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Re-lock the booking row to avoid racing with a webhook arriving at the same time
      const locked = await BookingService.getByIdForUpdate(client, booking.id);

      if (!locked || locked.state !== 'PENDING_PAYMENT') {
        // Already handled by a webhook or another job run
        await client.query('ROLLBACK');
        continue;
      }

      await BookingService.expireBooking(client, booking.id);
      await TripService.incrementSeats(client, booking.trip_id, booking.num_seats);

      await client.query('COMMIT');
      console.log(`[expiry-job] Expired booking ${booking.id}, released ${booking.num_seats} seat(s)`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[expiry-job] Failed to expire booking ${booking.id}:`, err.message);
    } finally {
      client.release();
    }
  }
}

function startExpiryJob() {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      await expireStaleBookings();
    } catch (err) {
      console.error('[expiry-job] Unexpected error:', err.message);
    }
  });
  console.log('[expiry-job] Scheduled — runs every minute');
}

// Allow running standalone: node src/jobs/expireBookings.js
if (require.main === module) {
  require('dotenv').config();
  expireStaleBookings()
    .then(() => {
      console.log('[expiry-job] Manual run complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[expiry-job] Manual run failed:', err);
      process.exit(1);
    });
}

module.exports = { startExpiryJob, expireStaleBookings };
