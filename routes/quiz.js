const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { model } = require('../config/ai');
const RateLimitService = require('../services/rateLimitService');

router.post('/quiz', async (req, res) => {
  try {
    const { history, numQuestions } = req.body;

    // 1. Authenticate User
    let userId;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const token = req.headers.authorization.split('Bearer ')[1];
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
      } catch (e) {
         // Silently fail auth or enforce it
      }
    }

    // 2. Rate Limit (Free Mode - 'quiz' category)
    if (userId) {
      await RateLimitService.checkAndIncrement(userId, 'quiz');
    }

    // 3. IMPROVED PROMPT: Explicitly defines the schema
    const prompt = `
      Based on the conversation history provided, generate exactly ${numQuestions} multiple-choice quiz questions.
      
      RETURN STRICT JSON ONLY. Do not include markdown formatting or chat text.
      The JSON must match this exact schema:
      {
        "questions": [
          {
            "question": "string",
            "options": ["string", "string", "string", "string"], 
            "answer": "string (must be one of the options)"
          }
        ]
      }
    `;

    const chat = model.startChat({ 
      history: history,
    });

    const result = await chat.sendMessage(prompt);
    const response = await result.response;
    
    // Clean the raw text (removes ```json and ```)
    const rawText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    
    // 2. DATA NORMALIZATION: Prevents type errors in Flutter
    const parsed = JSON.parse(rawText);
    const questionsList = Array.isArray(parsed.questions) ? parsed.questions : [];

    // Map over the results to guarantee the shape matches what Flutter expects
    const normalizedQuestions = questionsList.map((q) => {
      return {
        question: (q.question || q.prompt || "Error: Missing Question").toString(),
        // Ensure options is always an array of strings
        options: Array.isArray(q.options) 
          ? q.options.map(o => o.toString()) 
          : ["True", "False"], // Fallback if options are missing
        answer: (q.answer || "").toString()
      };
    });

    // Send the safe, normalized data back to Flutter
    res.json({ questions: normalizedQuestions });

  } catch (err) {
    if (err.code === 'RATE_LIMIT_EXCEEDED') {
       return res.status(402).json({ error: err.message });
    }
    console.error('Error in /quiz endpoint:', err);
    // Return a valid empty structure so Flutter doesn't crash on null
    res.status(500).json({ error: 'Internal Server Error', questions: [] });
  }
});

module.exports = router;