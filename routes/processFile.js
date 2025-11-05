const express = require('express');
const router = express.Router();
const { downloadFileBytes, parseBufferToText, inferFileTypeFromName } = require('../utils/fileUtils');
const { summarizeLongText, generateQuizFromText } = require('../utils/llmUtils');

router.post('/api/process-file', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, mode, options, history = [] } = req.body || {};
    if (!mode || !['summary', 'quiz'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid or missing mode. Must be "summary" or "quiz"' });
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

