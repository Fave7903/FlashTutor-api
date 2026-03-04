const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { downloadFileBytes, parseBufferToText, inferFileTypeFromName } = require('../utils/fileUtils');
const { startTutorialSession, getNextTutorialModule, handleTutorialFollowUp } = require('../services/tutorialService');
const RateLimitService = require('../services/rateLimitService');

router.post('/tutorial/start', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, userId } = req.body;
    const idempotencyKey = req.headers['idempotency-key'];

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    // Idempotency Check
    if (idempotencyKey) {
      const keyRef = admin.firestore().collection('idempotency_keys').doc(idempotencyKey);
      const keyDoc = await keyRef.get();

      if (keyDoc.exists) {
        const data = keyDoc.data();
        if (data.status === 'PROCESSING') return res.status(409).json({ error: 'Creation in progress' });
        if (data.status === 'COMPLETED') return res.json(data.result);
      } else {
        await keyRef.set({ status: 'PROCESSING', userId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }

    await RateLimitService.checkAndIncrement(userId, 'tutorial');

    // Processing Logic
    let text = '';
    try {
      if (rawText) text = rawText;
      else if (fileUrl) {
        const fileBuffer = await downloadFileBytes(fileUrl);
        const fileType = inferFileTypeFromName(fileName || fileUrl);
        text = await parseBufferToText(fileBuffer, fileType);
      } else {
        throw new Error('Provide rawText or fileUrl');
      }

      if (!text || text.trim().length === 0) throw new Error('No text extracted');

      // Start Session (Service handles logic)
      const sessionId = await startTutorialSession(userId, text, fileName || 'Untitled Tutorial');
      
      const responsePayload = { sessionId, message: 'Tutorial session started successfully' };

      if (idempotencyKey) {
        await admin.firestore().collection('idempotency_keys').doc(idempotencyKey).update({
          status: 'COMPLETED',
          result: responsePayload
        });
      }

      res.json(responsePayload);

    } catch (err) {
      if (idempotencyKey) await admin.firestore().collection('idempotency_keys').doc(idempotencyKey).update({ status: 'FAILED' });
      
      // ⚡ UPDATED: Return required amount for frontend display
      if (err.code === 'INSUFFICIENT_FUNDS' || err.code === 'RATE_LIMIT_EXCEEDED') {
        return res.status(402).json({ 
          error: err.message, 
          message: err.message,
          required: err.required || 0 
        });
      }

      console.error('Error in /tutorial/start:', err);
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }

  } catch (err) {
    console.error('Error in /tutorial/start:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

router.post('/tutorial/next', async (req, res) => {
    try {
      const { userId, sessionId } = req.body;
      if (!userId || !sessionId) return res.status(400).json({ error: 'userId and sessionId are required' });
      const result = await getNextTutorialModule(userId, sessionId);
      res.json(result);
    } catch (err) {
      console.error('Error in /tutorial/next:', err);
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
});
  
router.post('/tutorial/followup', async (req, res) => {
    try {
      const { userId, sessionId, question, moduleIndex } = req.body;
      if (!userId || !sessionId || !question) return res.status(400).json({ error: 'userId, sessionId and question are required' });
      const result = await handleTutorialFollowUp(userId, sessionId, question, Number.isInteger(moduleIndex) ? moduleIndex : undefined);
      res.json(result);
    } catch (err) {
      console.error('Error in /tutorial/followup:', err);
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
});

module.exports = router;