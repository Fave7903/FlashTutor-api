const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { db } = require('../config/firestore');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.warn('WARNING: PAYSTACK_SECRET_KEY is not set in environment variables');
}

/**
 * Initialize a Paystack payment transaction
 * POST /initialize-paystack
 */
async function initializePaystack(req, res) {
  try {
    const { email, amount, qredit_amount, userId } = req.body;

    // Validation
    if (!email || !amount || !qredit_amount || !userId) {
      return res.status(400).json({
        error: 'Missing required fields: email, amount, qredit_amount, userId'
      });
    }

    if (amount <= 0 || qredit_amount <= 0) {
      return res.status(400).json({
        error: 'amount and qredit_amount must be greater than 0'
      });
    }

    // Call Paystack API
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: Math.round(amount * 100), // Convert to Kobo (multiply by 100)
        metadata: {
          userId,
          qredit_amount,
          type: 'top_up'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { authorization_url, access_code } = response.data.data;

    res.json({
      authorization_url,
      access_code
    });
  } catch (err) {
    console.error('Error initializing Paystack payment:', err);
    
    if (err.response) {
      // Paystack API error
      return res.status(err.response.status || 500).json({
        error: err.response.data?.message || 'Failed to initialize payment'
      });
    }

    res.status(500).json({
      error: 'Internal Server Error'
    });
  }
}

/**
 * Verify Paystack webhook signature
 */
function verifyPaystackSignature(req, payload) { // Changed arg name to payload
  const signature = req.headers['x-paystack-signature'];
  
  if (!signature) {
    return false;
  }

  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(payload) // payload must be a Buffer or String
    .digest('hex');

  return hash === signature;
}

/**
 * Handle Paystack webhook
 * POST /webhook/paystack
 * 
 * Note: This route must use express.raw() middleware to get the raw body
 * for signature verification. The bodyParser.json() middleware should NOT
 * be applied to this route.
 */
async function handlePaystackWebhook(req, res) {
  try {
    // 1. GET THE RAW BUFFER (Strict Mode)
    // We do NOT use JSON.stringify() as a fallback. It is unreliable.
    const rawBody = req.rawBody;
    
    // Safety check: If req.rawBody is missing, it means app.js isn't configured correctly.
    // We must stop here to prevent security bypasses.
    if (!rawBody) {
        console.error('FATAL: req.rawBody is missing. Check bodyParser config in app.js');
        // Return 400 so Paystack knows we rejected it (or 500 to make them retry later)
        return res.status(500).json({ error: 'Webhook Configuration Error: Raw body missing' });
    }

    // 2. VERIFY SIGNATURE (Pass the BUFFER)
    const signatureValid = verifyPaystackSignature(req, rawBody);
    
    if (!signatureValid) {
      console.error('[Webhook] Invalid Paystack signature');
      // In production, you generally return 200 to stop Paystack from retrying a bad request,
      // but logging it as a security concern.
      return res.status(200).json({ message: 'Signature verification failed' }); 
    }

    // 3. USE THE PARSED BODY (Safe now because we verified the source)
    const event = req.body;

    // Only process successful charge events
    if (event.event !== 'charge.success') {
      console.log('[Webhook] Ignoring event:', event.event);
      return res.status(200).json({ message: 'Event ignored' });
    }

    console.log('[Webhook] Processing charge.success event');

    const { metadata, amount, reference } = event.data;

    if (!metadata || !metadata.userId || !metadata.qredit_amount) {
      console.error('Missing metadata in webhook:', event.data);
      return res.status(400).json({ error: 'Missing required metadata' });
    }

    const { userId, qredit_amount } = metadata;
    const qreditAmount = Number(qredit_amount);

    if (isNaN(qreditAmount) || qreditAmount <= 0) {
      console.error('Invalid qredit_amount:', qredit_amount);
      return res.status(400).json({ error: 'Invalid qredit_amount' });
    }

    // Update user balance and log transaction in a Firestore transaction
    const userRef = db.collection('users').doc(userId);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      
      if (!userSnap.exists) {
        throw new Error(`User ${userId} not found`);
      }

      // Get current balance
      const currentBalance = userSnap.data().qredit_balance || 0;
      const newBalance = currentBalance + qreditAmount;

      console.log(`[Webhook] Updating balance for user ${userId}: ${currentBalance} -> ${newBalance} (+${qreditAmount})`);

      // Update user balance
      tx.update(userRef, {
        qredit_balance: admin.firestore.FieldValue.increment(qreditAmount)
      });

      // Log transaction
      const txnRef = userRef.collection('transactions').doc();
      tx.set(txnRef, {
        type: 'credit',
        amount: qreditAmount,
        source: 'paystack',
        paystack_reference: reference || null,
        paystack_amount: amount || null,
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`[Webhook] Successfully processed payment for user ${userId}, added ${qreditAmount} Qredits`);

    // Return success quickly to Paystack
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Webhook] Error processing Paystack webhook:', err);
    console.error('[Webhook] Error stack:', err.stack);
    // Still return 200 to Paystack to prevent retries for our errors
    // (Paystack will retry on non-2xx responses)
    res.status(200).json({ 
      success: false, 
      error: 'Webhook processed but encountered an error',
      message: err.message 
    });
  }
}

module.exports = {
  initializePaystack,
  handlePaystackWebhook
};
