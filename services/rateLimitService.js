const { db } = require('../config/firestore');
const admin = require('firebase-admin');

const LIMITS = {
  chat: 20,
  quiz: 5,
  summary: 5,
  tutorial: 2
};

class RateLimitService {
  /**
   * Check if user has exceeded daily limit for a specific action.
   * Only enforces limits if system is in FREE MODE.
   * @param {string} userId
   * @param {'chat'|'quiz'|'summary'|'tutorial'} actionType
   */
  static async checkAndIncrement(userId, actionType) {
    // 1. Check if System is in Free Mode
    const configRef = db.collection('system_settings').doc('config');
    const configSnap = await configRef.get();
    const isFreeMode = configSnap.exists && configSnap.data()?.is_free_mode === true;

    if (!isFreeMode) {
      return; // Paid/Standard mode handling (usually credits)
    }

    const limit = LIMITS[actionType];
    if (limit === undefined) {
      console.warn(`No limit defined for action: ${actionType}`);
      return;
    }

    // 2. Determine Today's Date Document Key (YYYY-MM-DD)
    const dateStr = new Date().toISOString().split('T')[0];
    const userLimitsRef = db.collection('users').doc(userId).collection('daily_limits').doc(dateStr);

    // 3. Transactional Check & Increment
    await db.runTransaction(async (t) => {
      const doc = await t.get(userLimitsRef);
      const data = doc.exists ? doc.data() : {};
      const currentCount = data[actionType] || 0;

      if (currentCount >= limit) {
        const error = new Error(`Daily limit reached for ${actionType}s (${limit}/${limit}). Try again tomorrow.`);
        error.code = 'RATE_LIMIT_EXCEEDED';
        throw error;
      }

      t.set(userLimitsRef, { 
        [actionType]: currentCount + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }
}

module.exports = RateLimitService;