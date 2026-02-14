const express = require('express');
const router = express.Router();
const {
  initializePaystack,
  handlePaystackWebhook,
  verifyGooglePlayPurchase
} = require('../controllers/paymentController');

/**
 * POST /initialize-paystack
 * Initialize a Paystack payment transaction (Web)
 */
router.post('/initialize-paystack', initializePaystack);

/**
 * POST /verify-google-play
 * Verify an Android Google Play Billing receipt natively
 */
router.post('/verify-google-play', verifyGooglePlayPurchase);

/**
 * POST /webhook/paystack
 * Handle Paystack webhook events (Web)
 * * IMPORTANT: Uses express.raw() to get the raw body for signature verification.
 */
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);

module.exports = router;