const express = require('express');
const router = express.Router();
const { downloadFileBytes, parseBufferToText, inferFileTypeFromName } = require('../utils/fileUtils');
const { 
  startTutorialSession, 
  getNextTutorialModule, 
  handleTutorialFollowUp 
} = require('../services/tutorialService');

/**
 * POST /tutorial/start
 * Start a new tutorial session by uploading a file or providing raw text
 */
router.post('/tutorial/start', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

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

    const sessionId = await startTutorialSession(userId, text);
    
    res.json({ 
      sessionId,
      message: 'Tutorial session started successfully'
    });
  } catch (err) {
    console.error('Error in /tutorial/start:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

/**
 * POST /tutorial/next
 * Get the next tutorial module
 */
router.post('/tutorial/next', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const result = await getNextTutorialModule(sessionId);
    res.json(result);
  } catch (err) {
    console.error('Error in /tutorial/next:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

/**
 * POST /tutorial/followup
 * Handle follow-up questions about the current tutorial module
 */
router.post('/tutorial/followup', async (req, res) => {
  try {
    const { sessionId, question } = req.body;
    
    if (!sessionId || !question) {
      return res.status(400).json({ error: 'sessionId and question are required' });
    }

    const result = await handleTutorialFollowUp(sessionId, question);
    res.json(result);
  } catch (err) {
    console.error('Error in /tutorial/followup:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

module.exports = router;

