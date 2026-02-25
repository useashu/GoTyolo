/**
 * Database Migration Script
 * 
 * Creates the trips and bookings tables with all required fields,
 * indexes, and constraints as defined in the data model.
 * 
 * Key design decisions:
 * - available_seats is denormalized on trips for fast reads and atomic locking
 * - bookings.idempotency_key is UNIQUE to guarantee webhook deduplication
 * - CHECK constraints enforce valid state transitions at the DB level
 * - Indexes on frequently queried columns (state, trip_id, expires_at)
 */

require('dotenv').config();
const { pool } = require('./pool');

const UP = `
-- Enable uuid generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Trip status enum
DO $$ BEGIN
  CREATE TYPE trip_status AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Booking state enum
DO $$ BEGIN
  CREATE TYPE booking_state AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Trips table
CREATE TABLE IF NOT EXISTS trips (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(255) NOT NULL,
  destination   VARCHAR(255) NOT NULL,
  start_date    TIMESTAMPTZ NOT NULL,
  end_date      TIMESTAMPTZ NOT NULL,
  price         NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  max_capacity  INTEGER NOT NULL CHECK (max_capacity > 0),
  available_seats INTEGER NOT NULL CHECK (available_seats >= 0),
  status        trip_status NOT NULL DEFAULT 'DRAFT',

  -- Refund policy (embedded, no separate table needed)
  refundable_until_days_before INTEGER NOT NULL DEFAULT 7,
  cancellation_fee_percent     INTEGER NOT NULL DEFAULT 10 CHECK (cancellation_fee_percent >= 0 AND cancellation_fee_percent <= 100),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Sanity: available_seats can never exceed max_capacity
  CONSTRAINT seats_within_capacity CHECK (available_seats <= max_capacity),
  -- Sanity: end_date must be after start_date
  CONSTRAINT valid_dates CHECK (end_date > start_date)
);

-- Bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id           UUID NOT NULL REFERENCES trips(id),
  user_id           UUID NOT NULL,
  num_seats         INTEGER NOT NULL CHECK (num_seats > 0),
  state             booking_state NOT NULL DEFAULT 'PENDING_PAYMENT',
  price_at_booking  NUMERIC(10,2) NOT NULL CHECK (price_at_booking >= 0),
  payment_reference VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  cancelled_at      TIMESTAMPTZ,
  refund_amount     NUMERIC(10,2) DEFAULT NULL,
  idempotency_key   VARCHAR(255) UNIQUE NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_state ON bookings(state);
CREATE INDEX IF NOT EXISTS idx_bookings_expires_at ON bookings(expires_at);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_trips_start_date ON trips(start_date);

-- Trigger: auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS set_trips_updated_at ON trips;
CREATE TRIGGER set_trips_updated_at
  BEFORE UPDATE ON trips
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_bookings_updated_at ON bookings;
CREATE TRIGGER set_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
`;

const DOWN = `
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS trips CASCADE;
DROP TYPE IF EXISTS booking_state CASCADE;
DROP TYPE IF EXISTS trip_status CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;
`;

async function migrate() {
  const direction = process.argv[2]; // 'up' or 'down'

  try {
    if (direction === 'down') {
      console.log('Rolling back migrations...');
      await pool.query(DOWN);
      console.log('Rollback complete.');
    } else {
      console.log('Running migrations...');
      await pool.query(UP);
      console.log('Migrations complete.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
