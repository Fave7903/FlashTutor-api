const express = require('express');
const router = express.Router();
const admin = require('firebase-admin'); // Required for token verification
const { downloadFileBytes, parseBufferToText, inferFileTypeFromName } = require('../utils/fileUtils');
const { summarizeLongText, generateQuizFromText } = require('../utils/llmUtils');
const QreditService = require('../services/qreditService');

router.post('/api/process-file', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, mode, options, history = [] } = req.body || {};
    
    // 1. Authenticate User to get userId
    let userId;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const token = req.headers.authorization.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
      } catch (e) {
        console.error('Token verification failed:', e);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
      }
    }

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: User authentication required for deduction' });
    }

    if (!mode || !['summary', 'quiz'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid or missing mode. Must be "summary" or "quiz"' });
    }

    // 2. Deduct Qredits
    // Cost: 5 (Upload) + 5 (Generation) = 10 Qredits
    const OPERATION_COST = 10;
    
    try {
      await QreditService.deduct(userId, OPERATION_COST, `Generated ${mode}`);
    } catch (error) {
      if (error.code === 'INSUFFICIENT_FUNDS') {
        return res.status(402).json({ 
          error: 'Insufficient Qredits', 
          message: `You need ${OPERATION_COST} Qredits to perform this action.`,
          required: OPERATION_COST 
        });
      }
      throw error; // Rethrow other errors
    }

    // 3. Process Content (Existing Logic)
    let text = '';
    if (rawText && typeof rawText === 'string' && rawText.trim().length > 0) {
      text = rawText;
    } else if (fileUrl) {
      const fileBuffer = await downloadFileBytes(fileUrl);
      const fileType = inferFileTypeFromName(fileName || fileUrl);
      text = await parseBufferToText(fileBuffer, fileType);
    } else {
      return res.status(400).json({ error: 'Provide rawText or fileUrl' });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text extracted from file' });
    }

    if (mode === 'summary') {
      return res.json(await summarizeLongText(text));
    }
    if (mode === 'quiz') {
      return res.json(await generateQuizFromText(text, options || {}));
    }
  } catch (err) {
    console.error('Error in /api/process-file:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;