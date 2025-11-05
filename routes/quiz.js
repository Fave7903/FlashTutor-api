const express = require('express');
const router = express.Router();
const { model } = require('../config/ai');

router.post('/quiz', async (req, res) => {
  const { history, numQuestions } = req.body;
  try {
    const prompt = `Based on the conversation we just had, generate ${numQuestions} multiple-choice quiz questions and answers. Format JSON {"questions":[...]}`;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(prompt);
    const response = await result.response;
    const text = response.text().replace(/```json/g, '').replace(/```/g, '');
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Error in /quiz endpoint:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;

