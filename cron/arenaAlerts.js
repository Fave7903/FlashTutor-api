// cron/arenaAlerts.js
const cron = require('node-cron');
const { db, admin } = require('../config/firestore');
const fcmService = require('../services/fcmService');

function initCronJobs() {
  // Runs every 60 seconds at the 0th second of the minute
  cron.schedule('* * * * *', async () => {
    const now = admin.firestore.Timestamp.now();
    
    // Create a strict 1-minute window threshold
    const windowEnd = admin.firestore.Timestamp.fromMillis(now.toMillis() + 60000);

    try {
      // ⚡ OPTIMIZED QUERY: Only fetch pending arenas starting in the next 60 seconds
      const snapshot = await db.collection('challenges')
        .where('status', '==', 'pending')
        .where('startsAt', '>=', now)
        .where('startsAt', '<=', windowEnd)
        .get();

      if (snapshot.empty) return;

      const batch = db.batch();

      for (const doc of snapshot.docs) {
        const challenge = doc.data();
        const challengeId = doc.id;

        // Fetch all participants to alert them
        const participantsSnap = await doc.ref.collection('participants').get();
        const userIds = participantsSnap.docs.map(pDoc => pDoc.id);

        if (userIds.length > 0) {
          await fcmService.sendTargetedAlert(
            userIds,
            'Arena Starting! ⚡', // Keeping the high-impact Qlearit branding
            `The Arena "${challenge.title}" is commencing. Enter the arena now!`,
            { action: 'open_arena', challengeId: challengeId },
            'arenaAlerts'
          );
        }

        // Lock the challenge status to 'active' so the cron job never queries it again
        batch.update(doc.ref, { status: 'active' });
      }

      await batch.commit();

    } catch (error) {
      console.error('[Cron] Arena Start Alert Error:', error);
    }
  });

  // Add this inside initCronJobs(), right below your first cron.schedule block

  // ⚡ THE AUTO-CLOSER: Runs every 2 minutes to find and finalize expired arenas
  cron.schedule('*/2 * * * *', async () => {
    const now = admin.firestore.Timestamp.now();

    try {
      // Find arenas that are still 'active' but their time has run out
      const snapshot = await db.collection('challenges')
        .where('status', '==', 'active')
        .where('endsAt', '<=', now)
        .get();

      if (snapshot.empty) return;

      // For every expired arena, ping our own /finalize endpoint to trigger the payout and FCM push
      for (const doc of snapshot.docs) {
        const challengeId = doc.id;
        console.log(`[Cron] Auto-finalizing expired Arena: ${challengeId}`);

        try {
          // We use standard fetch to call our own endpoint locally. 
          // Adjust the port if your local/production port is different than 3000.
          const port = process.env.PORT || 3000; 
          await fetch(`http://localhost:${port}/challenge/finalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId })
          });
        } catch (err) {
          console.error(`[Cron] Failed to auto-finalize ${challengeId}:`, err);
        }
      }
    } catch (error) {
      console.error('[Cron] Arena Auto-Closer Error:', error);
    }
  });
}

module.exports = { initCronJobs };