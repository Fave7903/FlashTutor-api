const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.API_KEY);

// const model = new GenerativeModel({
//   model: 'gemini-1.5-flash',
//   apiKey: apiKey,
//   generationConfig: new GenerationConfig({ maxOutputTokens: 100 }),
// });


const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash"});

app.post('/chat', async (req, res) => {
  const { history, newMessage } = req.body;
  

  const chat = model.startChat({
        history,
  });

  // const msg = "How many paws are in my house?";

  async function sendMessageWithRetry(newMessage, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await chat.sendMessage(newMessage);
      } catch (err) {
        console.error(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt === retries) throw err;
        // Wait for a short period before retrying
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  try{
    const result = await sendMessageWithRetry(newMessage);
    const response = await result.response;
    const text = response.text();
    console.log(text);

    res.json({ response: text });
  } catch (err) {
    console.error('Error in /chat endpoint:', err);
    res.status(500).send('Internal Server Error');
  }
}); 

// Function to generate quiz questions based on chat history
async function generateQuizQuestions(history, numQuestions) {
  const prompt = `Based on the conversation we just had, generate ${numQuestions} multiple-choice quiz questions and answers. Each question should have a correct answer and three incorrect options. Format the response as JSON with 'questions' as an array of objects with 'question', 'options' (array of 4 options), and 'answer' (correct option). Ensure the 'questions' field is always there no matter the number of questions.`;

  const chat = model.startChat({
    history,
  });

  try {
    const result = await chat.sendMessage(prompt);
    const response = await result.response;
    let text = await response.text();
    text = text.replace(/```json/g, '').replace(/```/g, '');
    console.log(text);
    return JSON.parse(text);
  } catch (err) {
    console.error('Error in generateQuizQuestions function:', err);
    throw err;
  }
}

app.post('/quiz', async (req, res) => {
  const { history, numQuestions } = req.body;
  
  try {
    const quizData = await generateQuizQuestions(history, numQuestions);
    res.json(quizData);
  } catch (err) {
    console.error('Error in /quiz endpoint:', err);
    res.status(500).send('Internal Server Error');
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
