const { extractParagraphs } = require('../utils/fileUtils');
const { model, generateTutorialModule } = require('../utils/llmUtils');
const { admin, db } = require('../config/firestore');
const QreditService = require('./qreditService');

const USERS_COLLECTION = 'users';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function buildExpireAtTimestamp() {
  return admin.firestore.Timestamp.fromDate(new Date(Date.now() + SESSION_TTL_MS));
}

function tutorialCollectionForUser(userId) {
  return db.collection(USERS_COLLECTION).doc(userId).collection('tutorials');
}

async function generateLearningModule(paragraph, index) {
  // First, generate the rich tutorial text (explanation + embedded question)
  const tutorial = await generateTutorialModule(paragraph, index);
  const text = tutorial.text;

  // Try to extract the explicit question from the generated text
  let questionText = '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.includes('?') || line.toLowerCase().includes('question')) {
      questionText = line;
      break;
    }
  }

  // Get a one-sentence summary + rubric for grading from the paragraph + tutorial
  const rubricPrompt = `You are Qlearit. Given the original paragraph and the tutorial explanation with its question, produce STRICT JSON:
{
  "summary": string,   // one-sentence summary of the core idea
  "rubric": string     // key concepts a correct answer MUST mention
}
Return ONLY JSON, no prose or fences.

Original paragraph:
${paragraph}

Tutorial explanation:
${text}

If you are unsure, still return best-effort JSON.`;

  let summary = '';
  let rubric = '';
  try {
    const result = await model.generateContent(rubricPrompt);
    const rawText = (await result.response.text())
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(rawText);
    summary = parsed.summary || '';
    rubric = parsed.rubric || '';
  } catch (_) {
    summary = '';
    rubric = '';
  }

  return {
    index,
    content: text, // full tutorial text (explanation + question)
    summary,
    question: questionText,
    rubric,
  };
}

async function fetchActiveSession(userId, sessionId) {
  const docRef = tutorialCollectionForUser(userId).doc(sessionId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('Session not found');
  }

  const data = doc.data();
  const now = admin.firestore.Timestamp.now();

  if (!data.expireAt || data.expireAt.toMillis() <= now.toMillis()) {
    throw new Error('Session expired');
  }

  return { id: doc.id, data, ref: docRef };
}

/**
 * Start a new tutorial session
 * @param {string} userId - User ID (used for Firestore path: users/{userId}/tutorials/{sessionId})
 * @param {string} text - Text content to extract paragraphs from
 * @returns {Promise<string>} Session ID
 */
async function startTutorialSession(userId, text) {
  const paragraphs = extractParagraphs(text);
  if (paragraphs.length === 0) {
    throw new Error('No paragraphs extracted from text');
  }

  // 1. Calculate Costs
  const BASE_UPLOAD_COST = 5;
  const CHUNK_COST = 1; // 1 Qredit per chunk/paragraph
  const totalCost = BASE_UPLOAD_COST + (paragraphs.length * CHUNK_COST);

  // 2. Deduct Qredits
  // This will throw { code: 'INSUFFICIENT_FUNDS' } if balance is too low
  await QreditService.deduct(userId, totalCost, `Tutorial (${paragraphs.length} modules)`);

  const modules = await Promise.all(
    paragraphs.map((paragraph, index) => generateLearningModule(paragraph, index))
  );

  const payload = {
    userId,
    createdAt: admin.firestore.Timestamp.now(),
    expireAt: buildExpireAtTimestamp(),
    completed: false,
    modules,
  };

  const docRef = await tutorialCollectionForUser(userId).add(payload);
  return docRef.id;
}

/**
 * Get the full tutorial modules for a session (client caches and slices locally)
 * @param {string} userId - User ID
 * @param {string} sessionId - Session ID
 * @returns {Promise<{done: boolean, modules: Array, total: number, createdAt?: Date}>}
 */
async function getNextTutorialModule(userId, sessionId) {
  const { data } = await fetchActiveSession(userId, sessionId);
  const modules = Array.isArray(data.modules) ? data.modules : [];

  return {
    done: false,
    modules,
    total: modules.length,
    createdAt: data.createdAt ? data.createdAt.toDate() : undefined,
  };
}

/**
 * Handle user response (either answer to question or follow-up question)
 * @param {string} userId - User ID
 * @param {string} sessionId - Session ID
 * @param {string} userMessage - User's message (answer or question)
 * @param {number} [moduleIndex] - Module index for grading context
 * @returns {Promise<{response: string, isAnswer: boolean}>}
 */
async function handleTutorialFollowUp(userId, sessionId, userMessage, moduleIndex) {
  const { data } = await fetchActiveSession(userId, sessionId);
  const modules = Array.isArray(data.modules) ? data.modules : [];

  if (!modules.length) {
    throw new Error('No tutorial content found for this session');
  }

  const index =
    typeof moduleIndex === 'number' && moduleIndex >= 0 && moduleIndex < modules.length
      ? moduleIndex
      : modules.length - 1;

  const module = modules[index];

  // Decide if this is a grading flow (requires rubric) or a help flow.
  const shouldGrade = Boolean(module?.rubric && typeof moduleIndex === 'number');

  if (shouldGrade) {
    // REVISED GRADING PROMPT
    const prompt = `You are "Tutor Qlearit," a friendly, encouraging, and highly intelligent study companion for university students.
    
    Your Goal: Evaluate the student's answer based on the Rubric provided without stating the use of the Rubric.
    
    Rubric: ${module.rubric}
    User Answer: ${userMessage}
    
    Instructions:
    1. Tone: Warm, supportive, and conversational (like a smart study partner).
    2. If Correct: Start with genuine praise (e.g., "Spot on!", "That's exactly right!", "Brilliant!"). reinforcing *why* it's correct briefly.
    3. If Partially Correct: Validate what they got right first, then gently nudge them towards the missing part (e.g., "You're on the right track! You mentioned X, but don't forget about Y...").
    4. If Incorrect: Be encouraging. Don't just say "Wrong." Say something like, "Not quite, but good try! Think of it this way..." and explain the correct concept simply using the rubric.
    5. Length: Keep it concise (2-3 sentences max) so they can move to the next module quickly.
    
    Response:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return {
      response: response.text(),
      isAnswer: true,
    };
  }

  // REVISED FOLLOW-UP QUESTION PROMPT
  const prompt = `You are "Tutor Qlearit," an expert academic tutor who makes complex topics feel easy.
  
  Your Goal: Answer the student's follow-up question based *only* on the provided context.
  
  Context (Module Content): ${module.content}
  Student Question: ${userMessage}
  
  Instructions:
  1. Tone: Helpful, clear, and patient. Avoid jargon unless you explain it.
  2. Constraint: Answer ONLY using the information in the "Module Content" provided above. If the answer isn't in the text, politely say "That's a great question, but this specific module doesn't cover it. Let's focus on what's here!"
  3. Style: Use an analogy if it helps explain a difficult concept.
  4. Brevity: Keep your answer focused and under 4 sentences.
  
  Response:`;

  const result = await model.generateContent(prompt);
  const response = await result.response;

  return {
    response: response.text(),
    isAnswer: false,
  };
}

module.exports = {
  startTutorialSession,
  getNextTutorialModule,
  handleTutorialFollowUp,
};