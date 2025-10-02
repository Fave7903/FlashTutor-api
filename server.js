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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// Firebase Admin SDK disabled - using public file access only
console.log('Firebase Admin SDK disabled - using public file access');

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
    console.error('gs:// URLs not supported - Firebase Admin SDK disabled');
    throw new Error('File URL format not supported. Please use HTTPS URLs.');
  }
  try {
    const response = await axios.get(fileUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('HTTP download failed:', error.message);
    throw new Error(`HTTP download error: ${error.message}`);
  }
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
  const prompt = `Create a study quiz from the text below. Return STRICT JSON only with shape: {"questions": [{"question": string, "options": string[], "answer": string}]}.\n- Include exactly ${numMcq} multiple-choice items.\n- Include ${numTf} true/false by using options ["True","False"] and answer must be either "True" or "False".\n- Include ${numSa} short answer by using 3-4 plausible options and set the correct one in answer.\nTEXT:\n${text}`;
  const result = await model.generateContent(prompt);
  const raw = (await result.response.text()).replace(/```json/g, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const normalized = questions.map((q) => {
      const question = (q.question || q.prompt || '').toString();
      const options = Array.isArray(q.options) ? q.options.map((o) => o.toString()) : [];
      const answer = (q.answer || '').toString();
      return { question, options, answer };
    });
    return { questions: normalized };
  } catch (e) {
    console.error('Quiz JSON parse failed:', e.message);
    return { questions: [] };
  }
}

// NEW: Tutorial generation
async function generateTutorialFromText(text) {
  const prompt = `You are FlashTutor, an expert, fun, and engaging AI tutor. 
Your job is to help me deeply understand topics from uploaded notes or study materials. 

Teach in a way that is:
- Clear, step-by-step, and easy to grasp 
- Engaging, with light humor and creativity to keep it fun 
- Interactive: ask me questions, check if I understand, and encourage me to reflect 
- Motivational: give gentle encouragement to boost my confidence 
- Resourceful: suggest places I can read more or dive deeper 

Make the tutorial intensive and intentional so the knowledge sinks in. 
Your ultimate goal is to help me succeed, understand in depth, and be ready to get an A.

TEXT:\n${text}`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return { tutorial: response.text() };
}

app.post('/chat', async (req, res) => {
  const { history, newMessage } = req.body;
  const chat = model.startChat({ history });

  async function sendMessageWithRetry(newMessage, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await chat.sendMessage(newMessage);
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  try {
    const result = await sendMessageWithRetry(newMessage);
    const response = await result.response;
    res.json({ response: response.text() });
  } catch (err) {
    console.error('Error in /chat endpoint:', err);
    res.status(500).send('Internal Server Error');
  }
});

// File processing endpoint
app.post('/api/process-file', async (req, res) => {
  try {
    const { fileUrl, fileName, rawText, mode, options } = req.body || {};
    if (!mode || !['summary', 'quiz', 'tutorial'].includes(mode)) {
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
      return res.json(await summarizeLongText(text));
    }
    if (mode === 'quiz') {
      return res.json(await generateQuizFromText(text, options || {}));
    }
    if (mode === 'tutorial') {
      return res.json(await generateTutorialFromText(text));
    }
  } catch (err) {
    console.error('Error in /api/process-file:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/quiz', async (req, res) => {
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
    res.status(500).send('Internal Server Error');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
