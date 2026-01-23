const express = require('express');
const router = express.Router();
const {
  initializePaystack,
  handlePaystackWebhook
} = require('../controllers/paymentController');

/**
 * POST /initialize-paystack
 * Initialize a Paystack payment transaction
 */
router.post('/initialize-paystack', initializePaystack);

/**
 * POST /webhook/paystack
 * Handle Paystack webhook events
 * 
 * IMPORTANT: This route uses express.raw() middleware to get the raw body
 * for signature verification. The bodyParser.json() middleware should NOT
 * be applied to this route.
 */
router.post('/webhook/paystack', express.raw({ type: 'application/json' }), handlePaystackWebhook);

module.exports = router;
