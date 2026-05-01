const admin = require('firebase-admin');
const { db } = require('../config/firestore');

async function handleAdMobWebhook(req, res) {
  try {
    // 1. Google sends query parameters, including the custom_data you set in Flutter
    const { ad_network, ad_unit, reward_amount, custom_data, signature, key_id, transaction_id } = req.query;
    
    if (!custom_data) return res.status(400).send('Missing custom_data (userId)');
    const userId = custom_data; // We will pass the user.uid as custom_data from Flutter

    // Note: For production, you MUST verify the cryptographic 'signature' using Google's public 'key_id'.
    // For this implementation, we will focus on the business logic.

    const userRef = db.collection('users').doc(userId);
    
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const data = userSnap.data();
      const adMetadata = data.ad_metadata || {};
      let adsWatchedToday = adMetadata.ads_watched_today || 0;
      let lastAdDate = adMetadata.last_ad_date ? adMetadata.last_ad_date.toDate() : new Date(0);
      
      const now = new Date();
      // Check if the last ad was watched on a previous calendar day
      if (lastAdDate.toDateString() !== now.toDateString()) {
        adsWatchedToday = 0; // Reset for a new day
      }

      if (adsWatchedToday >= 5) {
         throw new Error('Daily limit reached');
      }

      // Add Qredits and update limits
      const currentBalance = data.qredit_balance || 0;
      const qreditsToAward = 5; // Standard reward amount

      tx.update(userRef, {
        qredit_balance: currentBalance + qreditsToAward,
        'ad_metadata.ads_watched_today': adsWatchedToday + 1,
        'ad_metadata.last_ad_date': admin.firestore.FieldValue.serverTimestamp()
      });

      // Log the transaction (similar to your QreditService)
      const txnRef = userRef.collection('transactions').doc();
      tx.set(txnRef, {
        type: 'credit',
        amount: qreditsToAward,
        source: 'admob_reward',
        transaction_id: transaction_id || null,
        balance_before: currentBalance,
        balance_after: currentBalance + qreditsToAward,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[AdMob Webhook] Error:', err);
    // Return 200 even on logical errors so Google stops retrying the ping
    res.status(200).json({ error: err.message }); 
  }
}

module.exports = { handleAdMobWebhook };