require('dotenv').config();
const { pool } = require('./pool');
const { v4: uuidv4 } = require('uuid');

const USERS = [
  uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4(),
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing data
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM trips');

    // --- TRIPS ---
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;

    const trips = [
      {
        id: uuidv4(),
        title: 'Paris City Tour',
        destination: 'Paris, France',
        start_date: new Date(now.getTime() + 30 * day),
        end_date: new Date(now.getTime() + 35 * day),
        price: 100.00,
        max_capacity: 20,
        available_seats: 20,
        status: 'PUBLISHED',
        refundable_until_days_before: 7,
        cancellation_fee_percent: 10,
      },
      {
        id: uuidv4(),
        title: 'Tokyo Adventure',
        destination: 'Tokyo, Japan',
        start_date: new Date(now.getTime() + 5 * day), // departing soon
        end_date: new Date(now.getTime() + 12 * day),
        price: 250.00,
        max_capacity: 15,
        available_seats: 15,
        status: 'PUBLISHED',
        refundable_until_days_before: 10,
        cancellation_fee_percent: 15,
      },
      {
        id: uuidv4(),
        title: 'Bali Beach Retreat',
        destination: 'Bali, Indonesia',
        start_date: new Date(now.getTime() + 3 * day), // departing very soon
        end_date: new Date(now.getTime() + 10 * day),
        price: 180.00,
        max_capacity: 10,
        available_seats: 10,
        status: 'PUBLISHED',
        refundable_until_days_before: 5,
        cancellation_fee_percent: 20,
      },
      {
        id: uuidv4(),
        title: 'London Historical Walk',
        destination: 'London, UK',
        start_date: new Date(now.getTime() + 60 * day),
        end_date: new Date(now.getTime() + 65 * day),
        price: 75.00,
        max_capacity: 25,
        available_seats: 25,
        status: 'PUBLISHED',
        refundable_until_days_before: 14,
        cancellation_fee_percent: 5,
      },
      {
        id: uuidv4(),
        title: 'New York Food Tour',
        destination: 'New York, USA',
        start_date: new Date(now.getTime() + 45 * day),
        end_date: new Date(now.getTime() + 48 * day),
        price: 120.00,
        max_capacity: 12,
        available_seats: 12,
        status: 'DRAFT',
        refundable_until_days_before: 7,
        cancellation_fee_percent: 10,
      },
    ];

    for (const t of trips) {
      await client.query(
        `INSERT INTO trips (id, title, destination, start_date, end_date, price,
          max_capacity, available_seats, status, refundable_until_days_before, cancellation_fee_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [t.id, t.title, t.destination, t.start_date, t.end_date, t.price,
         t.max_capacity, t.available_seats, t.status, t.refundable_until_days_before, t.cancellation_fee_percent]
      );
    }

    console.log(`Seeded ${trips.length} trips`);

    // --- BOOKINGS ---
    const bookings = [];

    // Paris: 5 confirmed, 2 pending, 1 cancelled with refund, 1 expired
    for (let i = 0; i < 5; i++) {
      bookings.push({
        trip: trips[0], user: USERS[i % 5], num_seats: 2, state: 'CONFIRMED',
        payment_reference: `PAY-PARIS-${i}`,
      });
    }
    bookings.push({
      trip: trips[0], user: USERS[0], num_seats: 1, state: 'PENDING_PAYMENT',
    });
    bookings.push({
      trip: trips[0], user: USERS[1], num_seats: 1, state: 'PENDING_PAYMENT',
    });
    bookings.push({
      trip: trips[0], user: USERS[2], num_seats: 1, state: 'CANCELLED',
      refund_amount: 90.00, // 100 - 10% fee
    });
    bookings.push({
      trip: trips[0], user: USERS[3], num_seats: 1, state: 'EXPIRED',
    });

    // Tokyo: 2 confirmed (departing soon, low occupancy = at-risk)
    bookings.push({
      trip: trips[1], user: USERS[0], num_seats: 2, state: 'CONFIRMED',
      payment_reference: 'PAY-TOKYO-0',
    });
    bookings.push({
      trip: trips[1], user: USERS[1], num_seats: 1, state: 'CONFIRMED',
      payment_reference: 'PAY-TOKYO-1',
    });

    // Bali: 1 confirmed, 1 cancelled no refund (departing very soon, at-risk)
    bookings.push({
      trip: trips[2], user: USERS[2], num_seats: 2, state: 'CONFIRMED',
      payment_reference: 'PAY-BALI-0',
    });
    bookings.push({
      trip: trips[2], user: USERS[3], num_seats: 1, state: 'CANCELLED',
      refund_amount: 0, // after cutoff
    });

    // London: 3 confirmed (healthy trip, far out)
    for (let i = 0; i < 3; i++) {
      bookings.push({
        trip: trips[3], user: USERS[i], num_seats: 3, state: 'CONFIRMED',
        payment_reference: `PAY-LONDON-${i}`,
      });
    }

    let seatAdjustments = {};

    for (const b of bookings) {
      const id = uuidv4();
      const priceAtBooking = parseFloat(b.trip.price) * b.num_seats;
      const expiresAt = b.state === 'PENDING_PAYMENT'
        ? new Date(now.getTime() + 15 * 60 * 1000)
        : new Date(now.getTime() - 60 * 60 * 1000); // past for non-pending
      const cancelledAt = b.state === 'CANCELLED' ? new Date(now.getTime() - 2 * day) : null;

      await client.query(
        `INSERT INTO bookings (id, trip_id, user_id, num_seats, state, price_at_booking,
          payment_reference, expires_at, cancelled_at, refund_amount, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, b.trip.id, b.user, b.num_seats, b.state, priceAtBooking,
         b.payment_reference || null, expiresAt, cancelledAt,
         b.refund_amount !== undefined ? b.refund_amount : null, uuidv4()]
      );

      // Track seat adjustments for confirmed + pending bookings
      if (b.state === 'CONFIRMED' || b.state === 'PENDING_PAYMENT') {
        if (!seatAdjustments[b.trip.id]) seatAdjustments[b.trip.id] = 0;
        seatAdjustments[b.trip.id] += b.num_seats;
      }
    }

    // Update available_seats to reflect booked seats
    for (const [tripId, seatsBooked] of Object.entries(seatAdjustments)) {
      await client.query(
        `UPDATE trips SET available_seats = max_capacity - $2 WHERE id = $1`,
        [tripId, seatsBooked]
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded ${bookings.length} bookings`);
    console.log('Seed complete.');

    // Print summary
    const tripRows = await client.query('SELECT id, title, max_capacity, available_seats FROM trips ORDER BY title');
    console.log('\n--- Trip Summary ---');
    for (const r of tripRows.rows) {
      console.log(`  ${r.title}: ${r.available_seats}/${r.max_capacity} seats available`);
    }

    const bookingRows = await client.query(
      `SELECT state, COUNT(*) as count FROM bookings GROUP BY state ORDER BY state`
    );
    console.log('\n--- Booking Summary ---');
    for (const r of bookingRows.rows) {
      console.log(`  ${r.state}: ${r.count}`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
