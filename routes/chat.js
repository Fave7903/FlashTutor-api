const express = require('express');
const router = express.Router();
const { model } = require('../config/ai');
const { sendMessageWithRetry } = require('../utils/llmUtils');

router.post('/chat', async (req, res) => {
  const { history, newMessage } = req.body;
  const chat = model.startChat({ history });

  try {
    const result = await sendMessageWithRetry(chat, newMessage);
    const response = await result.response;
    res.json({ response: response.text() });
  } catch (err) {
    console.error('Error in /chat endpoint:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;

