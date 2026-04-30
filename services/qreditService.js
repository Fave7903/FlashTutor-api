const admin = require('firebase-admin');
const { db } = require('../config/firestore');
const RateLimitService = require('./rateLimitService');

class QreditService {
  /**
   * Deduct Qredits from a user (Hard Deduction) OR Check Rate Limits (Free Mode).
   * Throws an error if balance is insufficient or rate limit exceeded.
   * @param {string} userId
   * @param {number} amount
   * @param {string} description
   * @param {string} [category] - Optional category for rate limiting ('chat', 'quiz', 'summary', 'tutorial')
   */
  static async deduct(userId, amount, description, category) {
    // Step A: Free Mode Check & Rate Limiting
    const configRef = db.collection('system_settings').doc('config');
    const configSnap = await configRef.get();
    const isFreeMode = configSnap.exists && configSnap.data()?.is_free_mode === true;
    
    if (isFreeMode) {
      if (category) {
        await RateLimitService.checkAndIncrement(userId, category);
      }
      return { success: true, deducted: false, message: 'Free Mode' };
    }

    // Step B: Transaction (Paid Mode)
    const userRef = db.collection('users').doc(userId);

    return await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        const err = new Error('User not found');
        err.code = 'USER_NOT_FOUND';
        throw err;
      }

      const currentBalance = userSnap.data().qredit_balance || 0;

      if (currentBalance < amount) {
        const err = new Error('Insufficient Qredits');
        err.code = 'INSUFFICIENT_FUNDS';
        err.current = currentBalance;
        err.required = amount;
        throw err;
      }

      const newBalance = currentBalance - amount;

      tx.update(userRef, { qredit_balance: newBalance });

      const txnRef = userRef.collection('transactions').doc();
      tx.set(txnRef, {
        type: 'deduction',
        amount,
        description: description || null,
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, newBalance, deducted: true };
    });
  }

  /**
   * Refund Qredits to a user (Compensation Logic).
   * Used when a paid operation fails mid-process.
   * @param {string} userId
   * @param {number} amount
   * @param {string} description
   */
  static async refund(userId, amount, description) {
    const userRef = db.collection('users').doc(userId);

    return await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      // If user doesn't exist, we can't refund, but this shouldn't happen in this flow
      if (!userSnap.exists) return;

      const currentBalance = userSnap.data().qredit_balance || 0;
      const newBalance = currentBalance + amount;

      tx.update(userRef, { qredit_balance: newBalance });

      const txnRef = userRef.collection('transactions').doc();
      tx.set(txnRef, {
        type: 'refund',
        amount,
        description: description || 'System Refund',
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, newBalance };
    });
  }
}

module.exports = QreditService;