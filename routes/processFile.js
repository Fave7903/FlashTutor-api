const express = require('express');
const router = express.Router();
const admin = require('firebase-admin'); 
const { downloadFileBytes, parseBufferToText, inferFileTypeFromName } = require('../utils/fileUtils');
const { summarizeLongText, generateQuizFromText } = require('../utils/llmUtils');
const QreditService = require('../services/qreditService');

router.post('/api/process-file', async (req, res) => {
  const { fileUrl, fileName, rawText, mode, options } = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'];
  const OPERATION_COST = 5; // Flat fee for summary or quiz

  try {
    // 1. Authenticate User
    let userId;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const token = req.headers.authorization.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
      } catch (e) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
      }
    } else {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    if (!mode || !['summary', 'quiz'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Must be "summary" or "quiz"' });
    }

    // 2. IDEMPOTENCY CHECK
    // Prevent double-processing if the user clicks twice or network retries
    if (idempotencyKey) {
      const keyRef = admin.firestore().collection('idempotency_keys').doc(idempotencyKey);
      const keyDoc = await keyRef.get();

      if (keyDoc.exists) {
        const data = keyDoc.data();
        if (data.status === 'PROCESSING') {
          return res.status(409).json({ error: 'Operation in progress' });
        }
        if (data.status === 'COMPLETED') {
          // Return the cached result - NO NEW CHARGE
          return res.json(data.result);
        }
        // If status is 'FAILED', we allow retry (proceed below)
      } else {
        // Lock the key
        await keyRef.set({
          status: 'PROCESSING',
          userId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    // 3. DEDUCT FIRST (Strategy A)
    try {
      await QreditService.deduct(userId, OPERATION_COST, `Generated ${mode}`);
    } catch (error) {
      // Mark idempotency as failed so they can try again
      if (idempotencyKey) {
        await admin.firestore().collection('idempotency_keys').doc(idempotencyKey).update({ status: 'FAILED_FUNDS' });
      }
      
      if (error.code === 'INSUFFICIENT_FUNDS') {
        return res.status(402).json({ 
          error: 'Insufficient Qredits', 
          message: `Balance too low. Required: ${OPERATION_COST}`,
          required: OPERATION_COST 
        });
      }
      throw error; // Rethrow other errors (e.g. database down)
    }

    // 4. PERFORM OPERATION (Wrapped in Safety Net)
    try {
      let text = '';
      if (rawText && typeof rawText === 'string' && rawText.trim().length > 0) {
        text = rawText;
      } else if (fileUrl) {
        const fileBuffer = await downloadFileBytes(fileUrl);
        const fileType = inferFileTypeFromName(fileName || fileUrl);
        text = await parseBufferToText(fileBuffer, fileType);
      } else {
         throw new Error('Provide rawText or fileUrl');
      }

      if (!text || text.trim().length === 0) {
        throw new Error('No text extracted from file');
      }

      let result;
      if (mode === 'summary') {
        result = await summarizeLongText(text);
      } else if (mode === 'quiz') {
        result = await generateQuizFromText(text, options || {});
      }

      // Success! Cache result and unlock Idempotency Key
      if (idempotencyKey) {
        await admin.firestore().collection('idempotency_keys').doc(idempotencyKey).update({
          status: 'COMPLETED',
          result: result
        });
      }

      return res.json(result);

    } catch (opError) {
      // 🚨 CRITICAL: Operation Failed AFTER Payment. REFUND THE USER.
      console.error(`[ProcessFile] Failed after deduction for user ${userId}. Refunding...`);
      
      try {
        await QreditService.refund(userId, OPERATION_COST, `Refund: Failed ${mode}`);
      } catch (refundError) {
        console.error('CRITICAL: REFUND FAILED. MANUAL INTERVENTION NEEDED.', refundError);
      }

      // Mark Idempotency as FAILED_AI so they can retry
      if (idempotencyKey) {
        await admin.firestore().collection('idempotency_keys').doc(idempotencyKey).update({ status: 'FAILED_AI' });
      }
      
      throw opError; // Throw so the outer catch block handles the 500 response
    }

  } catch (err) {
    console.error('Error in /api/process-file:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

module.exports = router;