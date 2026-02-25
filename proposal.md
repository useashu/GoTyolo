# Engineering Proposal — GoTyolo Booking System

## 1. Booking Lifecycle & State Transitions

```
                    ┌─────────────────┐
     book trip      │ PENDING_PAYMENT │  (seats decremented on entry)
    ────────────►   │  expires_at =   │
                    │  now + 15 min   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        webhook:success  webhook:failed  15min timeout
              │              │              │
              ▼              ▼              ▼
        ┌───────────┐  ┌──────────┐   ┌──────────┐
        │ CONFIRMED │  │ EXPIRED  │   │ EXPIRED  │
        └─────┬─────┘  └──────────┘   └──────────┘
              │         seats released  seats released
              │
     ┌────────┴────────┐
     │                 │
  cancel before     cancel after
    cutoff            cutoff
     │                 │
     ▼                 ▼
┌──────────┐     ┌──────────┐
│CANCELLED │     │CANCELLED │
│refund >0 │     │refund = 0│
│seats back│     │seats kept│
└──────────┘     └──────────┘
```

Terminal states: EXPIRED, CANCELLED — no further transitions allowed.

## 2. Overbooking Prevention Strategy

I use **pessimistic locking** via PostgreSQL `SELECT FOR UPDATE`.

**Flow:**
1. `BEGIN` transaction
2. `SELECT * FROM trips WHERE id = $1 FOR UPDATE` — acquires exclusive row lock
3. Application checks `available_seats >= requested_seats`
4. `UPDATE trips SET available_seats = available_seats - N WHERE available_seats >= N` — double guard
5. Insert booking row
6. `COMMIT` — releases lock

**Why pessimistic over optimistic:**
- Booking is a high-stakes write — a failed optimistic retry costs the user a confusing UX
- The critical section is short (< 10ms typically), so lock wait time is minimal
- Optimistic locking (version column + retry) is better for read-heavy workloads with rare conflicts; bookings can have bursts of writes to the same trip

**Fallback safety:** The database has `CHECK (available_seats >= 0)` — even if application logic fails, the DB rejects negative seats.

## 3. Database Transaction Boundaries

| Operation | Transaction scope | What's locked |
|-----------|------------------|---------------|
| Create booking | BEGIN → lock trip → decrement seats → insert booking → COMMIT | Trip row (FOR UPDATE) |
| Payment webhook | BEGIN → lock booking → update state → (if failed: release seats) → COMMIT | Booking row (FOR UPDATE OF b) |
| Cancel booking | BEGIN → lock booking → update state → release seats → COMMIT | Booking row (FOR UPDATE OF b) |
| Auto-expiry | Per-booking: BEGIN → lock booking → expire → release seats → COMMIT | Booking row (FOR UPDATE) |

Every state change to a booking happens inside a transaction with the booking row locked. Seat changes on the trip happen in the same transaction, ensuring atomicity.

## 4. Booking Auto-Expiry Implementation

**Approach:** In-process cron job using `node-cron`, running every 60 seconds.

**How it works:**
1. Query: `SELECT id, trip_id, num_seats FROM bookings WHERE state = 'PENDING_PAYMENT' AND expires_at < NOW()`
2. For each result, open a transaction:
   - `SELECT ... FOR UPDATE` on the booking (re-check state under lock)
   - If still `PENDING_PAYMENT`: set to `EXPIRED`, increment trip seats
   - If state already changed (webhook arrived between query and lock): skip
3. Each booking processed in its own transaction — one failure doesn't block others

**Why in-process cron instead of a database job (pg_cron) or external scheduler:**
- Simpler deployment — no external dependencies
- Adequate for this scale — a minute of latency on expiry is acceptable
- The webhook handler also checks `expires_at`, so a late webhook won't confirm an expired booking even if the cron hasn't run yet

**Trade-off:** In a multi-instance deployment, multiple cron jobs would fire simultaneously. The `FOR UPDATE` lock prevents double-processing, but it's wasted work. For production, I'd use a distributed lock (Redis) or move to a single-writer pattern.

## 5. Trade-offs Summary

| Decision | Pro | Con | Why suitable |
|----------|-----|-----|-------------|
| Pessimistic locking | Zero chance of overbooking | Serializes concurrent bookings for same trip | Correctness > throughput for financial transactions |
| Denormalized `available_seats` | Fast reads, natural lock point | Must stay in sync manually | All writes go through service layer with transactions |
| In-process cron | No external deps | Doesn't scale to multi-instance | Single instance is fine for this scope |
| Always return 200 to webhooks | Payment provider won't retry endlessly | Must handle errors internally | Industry standard for webhook receivers |
| 15-minute expiry window | Prevents indefinite seat holds | User must pay within 15 min | Standard for ticket/booking systems |
