require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const tripRoutes = require('./routes/trips');
const bookingRoutes = require('./routes/bookings');
const paymentRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const { startExpiryJob } = require('./jobs/expireBookings');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/trips', tripRoutes);
app.use('/bookings', bookingRoutes);
app.use('/payments', paymentRoutes);
app.use('/admin', adminRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`GoTyolo API running on port ${PORT}`);
  // Start background job for auto-expiring bookings
  startExpiryJob();
});

module.exports = app; // for testing
