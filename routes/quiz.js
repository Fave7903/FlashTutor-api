const express = require('express');
const router = express.Router();
const { model } = require('../config/ai');

router.post('/quiz', async (req, res) => {
  const { history, numQuestions } = req.body;

  try {
    // 1. IMPROVED PROMPT: Explicitly defines the schema
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
      // Optional: If your SDK/Model supports generationConfig, enable JSON mode here
      // generationConfig: { responseMimeType: "application/json" } 
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
    console.error('Error in /quiz endpoint:', err);
    // Return a valid empty structure so Flutter doesn't crash on null
    res.status(500).json({ error: 'Internal Server Error', questions: [] });
  }
});

// router.post('/quiz', async (req, res) => {
//   console.log('Quiz request received');
//   const { history, numQuestions } = req.body;
//   try {
//     const prompt = `Based on the conversation we just had, generate ${numQuestions} multiple-choice quiz questions and answers. Format JSON {"questions":[...]}`;
//     const chat = model.startChat({ history });
//     const result = await chat.sendMessage(prompt);
//     const response = await result.response;
//     const text = response.text().replace(/```json/g, '').replace(/```/g, '');
//     res.json(JSON.parse(text));
//   } catch (err) {
//     console.error('Error in /quiz endpoint:', err);
//     res.status(500).json({ error: 'Internal Server Error' });
//   }
// });

module.exports = router;

