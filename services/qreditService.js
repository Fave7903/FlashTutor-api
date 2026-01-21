const admin = require('firebase-admin');
const { db } = require('../config/firestore');

class QreditService {
  /**
   * Deduct Qredits from a user, unless Free Mode is enabled.
   * @param {string} userId
   * @param {number} amount
   * @param {string} description
   * @returns {Promise<{success: true, deducted: false, message: 'Free Mode'} | {success: true, newBalance: number}>}
   */
  static async deduct(userId, amount, description) {
    // Step A: Free Mode Check
    const configRef = db.collection('system_settings').doc('config');
    const configSnap = await configRef.get();
    const isFreeMode = configSnap.exists && configSnap.data()?.is_free_mode === true;
    if (isFreeMode) {
      return { success: true, deducted: false, message: 'Free Mode' };
    }

    // Step B: Transaction
    const userRef = db.collection('users').doc(userId);

    const result = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw { code: 'USER_NOT_FOUND', userId };
      }

      const currentBalance = userSnap.data().qredit_balance || 0;

      if (currentBalance < amount) {
        throw { code: 'INSUFFICIENT_FUNDS', current: currentBalance, required: amount };
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

      return { success: true, newBalance };
    });

    return result;
  }
}

module.exports = QreditService;

