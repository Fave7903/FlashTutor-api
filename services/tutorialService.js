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

  // Get a one-sentence summary + rubric for grading
  const rubricPrompt = `You are Qlearit. Given the original paragraph and the tutorial explanation with its question, produce STRICT JSON:
{
  "summary": string,
  "rubric": string
}
Return ONLY JSON, no prose or fences.

Original paragraph:
${paragraph}

Tutorial explanation:
${text}

If you are unsure, still return best-effort JSON.`;

  let summary = '';
  let rubric = '';
  
  // ⚡ FIXED: Robust fallback logic
  const defaultSummary = 'Key concepts from this section.';
  const defaultRubric = 'Evaluate the answer based on correctness. If correct, praise. If incorrect, explain gently.';

  try {
    const result = await model.generateContent(rubricPrompt);
    const rawText = (await result.response.text())
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    // Attempt parse
    const parsed = JSON.parse(rawText);
    
    // Use parsed value OR fallback if empty
    summary = parsed.summary && parsed.summary.trim() ? parsed.summary : defaultSummary;
    rubric = parsed.rubric && parsed.rubric.trim() ? parsed.rubric : defaultRubric;

  } catch (_) {
    console.warn(`[Tutorial] JSON generation failed for module ${index}. Using fallbacks.`);
    summary = defaultSummary;
    rubric = defaultRubric;
  }

  // Final safety check: If we found a question, we MUST have a rubric
  if (questionText && (!rubric || rubric === '')) {
    rubric = defaultRubric;
  }

  return {
    index,
    content: text,
    summary,
    question: questionText,
    rubric,
  };
}

// Fetch session logic
async function fetchActiveSession(userId, sessionId) {
  const docRef = tutorialCollectionForUser(userId).doc(sessionId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('Session not found');
  }

  const data = doc.data();
  const now = admin.firestore.Timestamp.now();
  
  const isExpired = !data.expireAt || data.expireAt.toMillis() <= now.toMillis();
  const isCompleted = data.completed === true;

  if (isExpired && !isCompleted) {
    throw new Error('Session expired');
  }

  return { id: doc.id, data, ref: docRef };
}

/**
 * Start a new tutorial session
 */
async function startTutorialSession(userId, text, fileName = 'Untitled Tutorial') {
  const paragraphs = extractParagraphs(text);
  if (paragraphs.length === 0) {
    throw new Error('No paragraphs extracted from text');
  }

  const BASE_UPLOAD_COST = 0;
  const CHUNK_COST = 1; 
  const totalCost = BASE_UPLOAD_COST + (paragraphs.length * CHUNK_COST);

  // Deduct first
  await QreditService.deduct(userId, totalCost, `Tutorial (${paragraphs.length} modules)`);

  try {
    const modules = await Promise.all(
      paragraphs.map((paragraph, index) => generateLearningModule(paragraph, index))
    );

    const payload = {
      userId,
      fileName, 
      createdAt: admin.firestore.Timestamp.now(),
      expireAt: buildExpireAtTimestamp(),
      completed: false,
      score: 0, 
      modules,
    };

    const docRef = await tutorialCollectionForUser(userId).add(payload);
    return docRef.id;

  } catch (err) {
    console.error(`[Tutorial] Generation failed for user ${userId}. Refunding...`);
    try {
      await QreditService.refund(userId, totalCost, `Refund: Failed Tutorial Generation`);
    } catch (refundErr) {
      console.error('CRITICAL: REFUND FAILED', refundErr);
    }
    throw err;
  }
}

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

  // ⚡ FIXED: Fallback logic for existing broken sessions
  // If there is a rubric OR a question, we treat it as a grading event.
  // This ensures 'isAnswer' becomes true, allowing the frontend button to appear.
  const hasRubric = Boolean(module?.rubric && module.rubric.trim());
  const hasQuestion = Boolean(module?.question && module.question.trim());
  
  const shouldGrade = (hasRubric || hasQuestion) && typeof moduleIndex === 'number';

  if (shouldGrade) {
    // Use stored rubric OR a generic fallback if the stored one is empty
    const effectiveRubric = hasRubric 
      ? module.rubric 
      : "Evaluate the user's answer based on the provided context. If correct, praise them. If incorrect, explain the right answer politely.";

    const prompt = `You are "Tutor Qlearit," a friendly, encouraging, and highly intelligent study companion.
    
    Goal: Evaluate answer based on Rubric without mentioning rubric.
    Rubric: ${effectiveRubric}
    User Answer: ${userMessage}
    
    Instructions:
    1. Tone: Warm, supportive.
    2. If Correct: Praise.
    3. If Partially Correct: Validate and nudge.
    4. If Incorrect: Explain simply.
    5. Length: Concise (2-3 sentences).
    
    Response:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return {
      response: response.text(),
      isAnswer: true, // This allows the frontend to show the Next button
    };
  }

  // Normal Chat (No grading intended)
  const prompt = `You are "Tutor Qlearit," an expert academic tutor.
  Goal: Answer follow-up based ONLY on context.
  Context: ${module.content}
  Student Question: ${userMessage}
  Instructions: Helpful, clear, max 4 sentences.
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