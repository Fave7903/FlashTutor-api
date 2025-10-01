const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const admin = require('firebase-admin');

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


const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite"});

// Initialize Firebase Admin SDK (for auth verification and optional Storage access)
if (!admin.apps.length) {
  try {
    const usingADC = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
    admin.initializeApp({
      // applicationDefault() will load GOOGLE_APPLICATION_CREDENTIALS when set locally,
      // or use default service account when running on Google Cloud.
      credential: admin.credential.applicationDefault(),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
    });
    console.log(`firebase-admin initialized. ADC: ${usingADC ? 'GOOGLE_APPLICATION_CREDENTIALS set' : 'default credentials'}`);
  } catch (err) {
    console.error('Failed to initialize firebase-admin:', err.message);
  }
}

async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization token' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    return next();
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function inferFileTypeFromName(name) {
  if (!name) return 'txt';
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt')) return 'txt';
  return 'txt';
}

async function downloadFileBytes(fileUrl) {
  if (!fileUrl) return null;
  if (fileUrl.startsWith('gs://')) {
    const bucketName = fileUrl.split('gs://')[1].split('/')[0];
    const path = fileUrl.replace(`gs://${bucketName}/`, '');
    const bucket = admin.storage().bucket(bucketName);
    const file = bucket.file(path);
    const [buffer] = await file.download();
    return buffer;
  }
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function parseBufferToText(buffer, fileType) {
  if (!buffer) return '';
  switch (fileType) {
    case 'pdf': {
      const data = await pdfParse(buffer);
      return data.text || '';
    }
    case 'docx': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    }
    default: {
      return buffer.toString('utf8');
    }
  }
}

function chunkText(text, maxChars = 12000) {
  if (!text) return [];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxChars));
    i += maxChars;
  }
  return chunks;
}

async function summarizeLongText(text) {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { bullets: [], overview: '', keyTerms: [] };
  const partialSummaries = [];
  for (const chunk of chunks) {
    const prompt = `Summarize the following text into 5-10 concise bullet points, and list 3-7 key terms.\n\nTEXT:\n${chunk}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    partialSummaries.push(response.text());
  }
  const combined = partialSummaries.join('\n');
  const finalPrompt = `You are given multiple partial summaries of a document.\nReturn strict JSON with keys: bullets (string[]), overview (string), keyTerms (string[]).\n\nPARTIAL SUMMARIES:\n${combined}`;
  const final = await model.generateContent(finalPrompt);
  const finalText = (await final.response.text())
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(finalText);
  } catch (_) {
    return { bullets: combined.split('\n').filter(Boolean), overview: '', keyTerms: [] };
  }
}

async function generateQuizFromText(text, options = {}) {
  const { numMcq = 5, numTf = 3, numSa = 2 } = options;
  const prompt = `Create a study quiz from the text below. Return STRICT JSON only with shape: {"questions": [{"question": string, "options": string[], "answer": string}]}.\n- Include exactly ${numMcq} multiple-choice items.\n- Include ${numTf} true/false by using options ["True","False"] and answer must be either "True" or "False".\n- Include ${numSa} short answer by using 3-4 plausible options and set the correct one in answer.\nDo NOT include any keys other than question, options, answer.\nTEXT:\n${text}`;
  const result = await model.generateContent(prompt);
  const raw = (await result.response.text()).replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    // Normalize to ensure required keys exist
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const normalized = questions.map((q) => {
      const question = (q.question || q.prompt || '').toString();
      const options = Array.isArray(q.options) ? q.options.map((o) => o.toString()) : [];
      const answer = (q.answer || '').toString();
      return { question, options, answer };
    });
    return { questions: normalized };
  } catch (e) {
    console.error('Quiz JSON parse failed, returning fallback:', e.message);
    return { questions: [] };
  }
}

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

// File processing endpoint
// body: { fileUrl?: string, fileName?: string, rawText?: string, mode: 'summary'|'quiz', options?: {...} }
app.post('/api/process-file', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, mode, options } = req.body || {};
    if (!mode || !['summary', 'quiz'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid or missing mode' });
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
      const summary = await summarizeLongText(text);
      return res.json(summary);
    }

    if (mode === 'quiz') {
      const quiz = await generateQuizFromText(text, options || {});
      return res.json(quiz);
    }
  } catch (err) {
    console.error('Error in /api/process-file:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
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
