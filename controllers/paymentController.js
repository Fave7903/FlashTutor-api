const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { db } = require('../config/firestore');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.warn('WARNING: PAYSTACK_SECRET_KEY is not set in environment variables');
}

/**
 * Initialize a Paystack payment transaction (Web Flow)
 * POST /initialize-paystack
 */
async function initializePaystack(req, res) {
  try {
    const { email, amount, qredit_amount, userId } = req.body;

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

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: Math.round(amount * 100), // Convert to Kobo
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
      return res.status(err.response.status || 500).json({
        error: err.response.data?.message || 'Failed to initialize payment'
      });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * Verify Paystack webhook signature
 */
function verifyPaystackSignature(req, payload) {
  const signature = req.headers['x-paystack-signature'];
  if (!signature) return false;

  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(payload)
    .digest('hex');

  return hash === signature;
}

/**
 * Handle Paystack webhook (Web Flow)
 * POST /webhook/paystack
 */
async function handlePaystackWebhook(req, res) {
  try {
    const rawBody = req.rawBody;
    if (!rawBody) {
        console.error('FATAL: req.rawBody is missing. Check bodyParser config in app.js');
        return res.status(500).json({ error: 'Webhook Configuration Error: Raw body missing' });
    }

    const signatureValid = verifyPaystackSignature(req, rawBody);
    if (!signatureValid) {
      console.error('[Webhook] Invalid Paystack signature');
      return res.status(200).json({ message: 'Signature verification failed' }); 
    }

    const event = req.body;
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

    const userRef = db.collection('users').doc(userId);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error(`User ${userId} not found`);
      }

      const currentBalance = userSnap.data().qredit_balance || 0;
      const newBalance = currentBalance + qreditAmount;

      tx.update(userRef, {
        qredit_balance: admin.firestore.FieldValue.increment(qreditAmount)
      });

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
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Webhook] Error processing Paystack webhook:', err);
    res.status(200).json({ success: false, error: 'Webhook processed but encountered an error', message: err.message });
  }
}

/**
 * Verify Google Play Purchase (Android Flow)
 * POST /verify-google-play
 */
async function verifyGooglePlayPurchase(req, res) {
  try {
    const { purchaseToken, productId, userId, qreditAmount } = req.body;

    if (!purchaseToken || !productId || !userId || !qreditAmount) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 1. Read and parse the JSON string from Azure environment variables
    if (!process.env.GOOGLE_CREDENTIALS_JSON) {
      throw new Error("Missing GOOGLE_CREDENTIALS_JSON environment variable");
    }
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    const cleanPrivateKey = credentials.private_key.replace(/\\n/g, '\n');

  // 2. Pass the credentials explicitly
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: credentials.client_email,
        private_key: cleanPrivateKey,
      },
      scopes: ['https://www.googleapis.com/auth/androidpublisher']
    });
    const androidpublisher = google.androidpublisher({ version: 'v3', auth });

    // Ensure your Package Name is stored in ENV or fallback to your app ID
    const packageName = process.env.PACKAGE_NAME || 'com.soartech.qlearit';

    // Verify token with Google's servers
    const playRes = await androidpublisher.purchases.products.get({
      packageName: packageName,
      productId: productId,
      token: purchaseToken,
    });

    // purchaseState 0 means "Purchased"
    if (playRes.data.purchaseState !== 0) {
      return res.status(400).json({ error: 'Purchase is pending or cancelled.' });
    }

    const userRef = db.collection('users').doc(userId);
    const tokenRef = db.collection('purchase_tokens').doc(purchaseToken);

    await db.runTransaction(async (tx) => {
      // 1. Check for Replay Attack / Duplicates
      const tokenSnap = await tx.get(tokenRef);
      if (tokenSnap.exists) {
        throw new Error('Purchase token already consumed');
      }

      // 2. Ensure User Exists
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const currentBalance = userSnap.data().qredit_balance || 0;
      const newBalance = currentBalance + Number(qreditAmount);

      // 3. Update Balance
      tx.update(userRef, {
        qredit_balance: admin.firestore.FieldValue.increment(Number(qreditAmount))
      });

      // 4. Lock Purchase Token
      tx.set(tokenRef, {
        userId,
        productId,
        qreditAmount,
        status: 'consumed',
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });

      // 5. Log Transaction
      const txnRef = userRef.collection('transactions').doc();
      tx.set(txnRef, {
        type: 'credit',
        amount: Number(qreditAmount),
        source: 'google_play',
        play_product_id: productId,
        play_purchase_token: purchaseToken,
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`[GooglePlay] Successfully processed payment for user ${userId}, added ${qreditAmount} Qredits`);
    res.status(200).json({ success: true, message: 'Qredits added successfully' });

  } catch (err) {
    console.error('[GooglePlay] Verification Error:', err);
    if (err.message === 'Purchase token already consumed') {
      return res.status(200).json({ success: true, message: 'Already consumed' }); // Safely acknowledge
    }
    res.status(500).json({ error: err.message || 'Verification failed' });
  }
}

module.exports = {
  initializePaystack,
  handlePaystackWebhook,
  verifyGooglePlayPurchase
};