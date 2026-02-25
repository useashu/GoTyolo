# GoTyolo — Booking System with Refunds

A backend API for a travel booking platform with payment webhooks, refund management, and admin visibility.

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js 18 | Fast async I/O, good for webhook-heavy workloads |
| Framework | Express.js | Minimal, flexible, widely understood |
| Database | PostgreSQL 15 | Row-level locking (`SELECT FOR UPDATE`), CHECK constraints, FILTER aggregates |
| Scheduler | node-cron | Lightweight in-process cron for booking expiry |
| Container | Docker + docker-compose | Single command startup with DB |

PostgreSQL was chosen specifically because of `SELECT FOR UPDATE` — it gives us row-level pessimistic locking which is the most straightforward way to prevent overbooking under concurrency.

## Setup & Run

### With Docker (recommended)

```bash
docker-compose up --build
```

App runs on `http://localhost:3000`. Database is automatically migrated and seeded.

To stop:
```bash
docker-compose down
```

To reset data:
```bash
docker-compose down -v
docker-compose up --build
```

### Without Docker

Prerequisites: Node.js 18+, PostgreSQL running locally.

```bash
# Install dependencies
npm install

# Copy and edit env
cp .env.example .env

# Run migrations
npm run migrate

# Seed sample data
npm run seed

# Start server
npm start
```

## API Endpoints

### Trips

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/trips` | List published trips (optional `?destination=paris`) |
| GET | `/trips/:tripId` | Get trip details |
| POST | `/trips` | Create trip (admin) |
| POST | `/trips/:tripId/book` | Book seats on a trip |

### Bookings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/bookings/:bookingId` | Get booking details |
| POST | `/bookings/:bookingId/cancel` | Cancel a booking |

### Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/payments/webhook` | Payment provider webhook |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/trips/:tripId/metrics` | Trip occupancy + financial metrics |
| GET | `/admin/trips/at-risk` | Trips departing within 7 days with <50% occupancy |

## Request/Response Examples

### Create a Trip (Admin)

```bash
curl -X POST http://localhost:3000/trips \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Goa Beach Getaway",
    "destination": "Goa, India",
    "start_date": "2026-04-01T00:00:00Z",
    "end_date": "2026-04-05T00:00:00Z",
    "price": 150.00,
    "max_capacity": 20,
    "status": "PUBLISHED",
    "refundable_until_days_before": 7,
    "cancellation_fee_percent": 10
  }'
```

### Book a Trip

```bash
curl -X POST http://localhost:3000/trips/<tripId>/book \
  -H "Content-Type: application/json" \
  -d '{"user_id": "some-uuid", "num_seats": 2}'
```

Response:
```json
{
  "booking": {
    "id": "booking-uuid",
    "trip_id": "trip-uuid",
    "state": "PENDING_PAYMENT",
    "price_at_booking": 200.00,
    "expires_at": "2026-02-25T12:15:00Z"
  },
  "payment_url": "https://pay.gotyolo.mock/checkout/booking-uuid"
}
```

### Payment Webhook

```bash
curl -X POST http://localhost:3000/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{"booking_id": "booking-uuid", "status": "success", "idempotency_key": "webhook-key-123"}'
```

### Cancel a Booking

```bash
curl -X POST http://localhost:3000/bookings/<bookingId>/cancel
```

### Admin Metrics

```bash
curl http://localhost:3000/admin/trips/<tripId>/metrics
```

### At-Risk Trips

```bash
curl http://localhost:3000/admin/trips/at-risk
```

## Architecture

### Booking Lifecycle (State Machine)

```
PENDING_PAYMENT (created on booking)
    │
    ├── webhook: status=success  →  CONFIRMED
    ├── webhook: status=failed   →  EXPIRED (seats released)
    └── 15 min timeout           →  EXPIRED (seats released via cron)

CONFIRMED
    │
    ├── cancel before cutoff  →  CANCELLED (refund issued, seats released)
    └── cancel after cutoff   →  CANCELLED (no refund, seats NOT released)

EXPIRED    → terminal
CANCELLED  → terminal
```

### Concurrency — Preventing Overbooking

The booking flow uses PostgreSQL's `SELECT FOR UPDATE`:

1. `BEGIN` transaction
2. `SELECT * FROM trips WHERE id = $1 FOR UPDATE` — locks the trip row
3. Check `available_seats >= requested`
4. `UPDATE trips SET available_seats = available_seats - N` with a `WHERE available_seats >= N` guard
5. Insert booking
6. `COMMIT` — releases the lock

If two requests hit simultaneously for the last seat, one blocks at step 2 until the other commits. The second request then sees the updated `available_seats` and gets a 409.

The `WHERE available_seats >= N` in the UPDATE is a secondary safety net — even if the application logic had a bug, the DB won't go negative (CHECK constraint `available_seats >= 0`).

### Webhook Idempotency

- The booking row is locked with `FOR UPDATE` before processing
- If `state` is not `PENDING_PAYMENT`, the webhook was already handled → return 200 with `duplicate: true`
- Always returns 200 to the payment provider regardless of outcome
- Late webhooks (after `expires_at`) trigger expiry instead of confirmation

### Auto-Expiry

- `node-cron` runs every minute
- Queries bookings where `state = 'PENDING_PAYMENT' AND expires_at < NOW()`
- Each booking is expired in its own transaction with `FOR UPDATE` lock
- Handles race with webhooks: if state already changed, skip

### Denormalized `available_seats`

`available_seats` is stored directly on the `trips` table instead of being calculated from bookings.

**Why:**
- Every trip listing would need a JOIN + aggregate to compute available seats dynamically
- Under high load, that JOIN becomes expensive
- `SELECT FOR UPDATE` on the trip row gives us a natural lock point for concurrency

**Risks:**
- If any code path modifies bookings without updating `available_seats`, they go out of sync
- Mitigation: all seat changes go through `decrementSeats()` / `incrementSeats()` which run inside the same transaction as the booking state change
- The DB CHECK constraint `available_seats >= 0` and `available_seats <= max_capacity` act as a final safety net

## Bugs Found and Fixed

### Bug 1: Incorrect Parameter Binding in Trip Creation

**File:** `src/services/tripService.js` → `create()`

**What was wrong:**
```sql
VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
```
The SQL used `$6` twice — once for `max_capacity` and once for `available_seats`. The params array only had 9 values for 10 columns. PostgreSQL reused `$6` (max_capacity) for `available_seats`, which happened to produce the correct result since they're equal on creation. But:
- The parameter count was wrong (9 params for what should be 10)
- If anyone reordered the columns or params, the bug would silently produce wrong data
- It's a fragile coincidence, not correct code

**Fix:**
```sql
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
```
And pass `max_capacity` explicitly as both `$6` and `$7` in the params array.

### Bug 2: Seats Released After Cancellation Cutoff

**File:** `src/routes/bookings.js` → `POST /:bookingId/cancel`

**What was wrong:**
Seats were always released back to the trip on cancellation, regardless of whether the cancellation was before or after the refund cutoff. Per the business rules: "After cutoff, don't release seats (trip is imminent)."

If a user cancelled a non-refundable booking 2 days before the trip, the seats went back to `available_seats`, allowing new bookings for a trip that's about to depart. This creates operational risk — the trip operator sees inflated availability right before departure.

**Fix:**
Only call `incrementSeats()` when `isBeforeCutoff` is true. After cutoff, the booking is cancelled (state changes) but seats remain allocated.

## High Traffic Scenario (500 requests in 5 seconds)

### What could fail
- **Connection pool exhaustion**: 500 concurrent requests with default pool size of 20 means most requests queue for a DB connection
- **Lock contention**: All 500 requests `SELECT FOR UPDATE` the same trip row — they serialize, response times spike
- **Timeout cascade**: Blocked requests hold connections, new requests can't get connections, timeouts propagate

### Protections in place
- `WHERE available_seats >= N` guard prevents negative seats even if app logic fails
- CHECK constraint on `available_seats >= 0` is a DB-level safety net
- Each booking is a short transaction (lock, check, decrement, insert, commit) — typically <10ms

### What I'd add for production
- **Connection pool tuning**: increase `max` to 50-100, add a request queue with timeout
- **Rate limiting**: per-user rate limit on booking endpoint (e.g., 5 req/min)
- **Request queuing**: for very hot trips, push booking requests to a queue (Redis/Bull) and process sequentially — eliminates lock contention
- **Optimistic locking alternative**: instead of `FOR UPDATE`, use a version column and retry on conflict — better throughput under moderate contention
- **Database read replicas**: serve `/trips` (read-only) from replicas, writes go to primary
- **Circuit breaker**: if error rate spikes, reject new bookings fast instead of queuing
