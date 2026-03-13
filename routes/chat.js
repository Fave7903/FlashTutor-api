const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { model } = require('../config/ai');
const { sendMessageWithRetry } = require('../utils/llmUtils');
const RateLimitService = require('../services/rateLimitService');

router.post('/chat', async (req, res) => {
  try {
    const { history, newMessage } = req.body;

    // 1. Authenticate User (Required for Rate Limiting)
    let userId;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const token = req.headers.authorization.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
      } catch (e) {
        // Continue without user ID if auth fails, but won't be able to rate limit properly
        // Or enforce strictly:
        // return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // 2. Rate Limit (Free Mode)
    if (userId) {
      await RateLimitService.checkAndIncrement(userId, 'chat');
    }

   // 3. Process Chat
   const chat = model.startChat({ history });
   const result = await sendMessageWithRetry(chat, newMessage);
   const response = await result.response;
   
   // ⚡ NEW: Extract the raw parts array to preserve thought signatures
   const rawParts = response.candidates[0].content.parts;

   // ⚡ NEW: Send both the text and the parts back to Flutter
   res.json({ 
     response: response.text(),
     parts: rawParts
   });

  } catch (err) {
    if (err.code === 'RATE_LIMIT_EXCEEDED') {
       return res.status(402).json({ error: err.message });
    }
    console.error('Error in /chat endpoint:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;