// const { extractParagraphs } = require('../utils/fileUtils');
const { chunkText } = require('../utils/fileUtils');
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

// ⚡ ADDED: username parameter ⚡
// async function generateLearningModule(paragraph, index, username = '') {
//   // First, generate the rich tutorial text (explanation + embedded question)
//   const tutorial = await generateTutorialModule(paragraph, index, username);
//   const text = tutorial.text;

//   // Try to extract the explicit question from the generated text
//   let questionText = '';
//   const lines = text.split('\n');
//   for (let i = lines.length - 1; i >= 0; i--) {
//     const line = lines[i].trim();
//     if (!line) continue;
//     if (line.includes('?') || line.toLowerCase().includes('question')) {
//       questionText = line;
//       break;
//     }
//   }

//   // Get a one-sentence summary + rubric for grading
//   const rubricPrompt = `You are Qlearit. Given the original paragraph and the tutorial explanation with its question, produce STRICT JSON:
// {
//   "summary": string,
//   "rubric": string
// }
// Return ONLY JSON, no prose or fences.

// Original paragraph:
// ${paragraph}

// Tutorial explanation:
// ${text}

// If you are unsure, still return best-effort JSON.`;

//   let summary = '';
//   let rubric = '';
  
//   // Robust fallback logic
//   const defaultSummary = 'Key concepts from this section.';
//   const defaultRubric = 'Evaluate the answer based on correctness. If correct, praise. If incorrect, explain gently.';

//   try {
//     const result = await model.generateContent(rubricPrompt);
//     const rawText = (await result.response.text())
//       .replace(/```json/gi, '')
//       .replace(/```/g, '')
//       .trim();
    
//     // Attempt parse
//     const parsed = JSON.parse(rawText);
    
//     // Use parsed value OR fallback if empty
//     summary = parsed.summary && parsed.summary.trim() ? parsed.summary : defaultSummary;
//     rubric = parsed.rubric && parsed.rubric.trim() ? parsed.rubric : defaultRubric;

//   } catch (_) {
//     console.warn(`[Tutorial] JSON generation failed for module ${index}. Using fallbacks.`);
//     summary = defaultSummary;
//     rubric = defaultRubric;
//   }

//   // Final safety check: If we found a question, we MUST have a rubric
//   if (questionText && (!rubric || rubric === '')) {
//     rubric = defaultRubric;
//   }

//   return {
//     index,
//     content: text,
//     summary,
//     question: questionText,
//     rubric,
//   };
// }


// ⚡ ADDED: username parameter ⚡
async function generateLearningModule(paragraph, index, username = '') {
  // First, generate the rich tutorial text (explanation + embedded question)
  const tutorial = await generateTutorialModule(paragraph, index, username);
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

  // 1. Define the Strict Schema
  // Note: Depending on your @google/generative-ai SDK version, you can use 
  // the string "OBJECT"/"STRING" or import { SchemaType } and use SchemaType.OBJECT
  const tutorialMetaSchema = {
    type: "OBJECT",
    properties: {
      summary: { 
        type: "STRING",
        description: "A concise, one-sentence summary of the key concepts taught in the tutorial explanation."
      },
      rubric: { 
        type: "STRING",
        description: "Strict grading criteria for the comprehension question. State exactly what makes an answer correct, partially correct, or incorrect."
      }
    },
    required: ["summary", "rubric"]
  };

  // 2. Simplified Prompt (No need to beg for JSON anymore)
  const rubricPrompt = `You are Qlearit. Given the original paragraph and the tutorial explanation, extract the summary and create a grading rubric.

  Original paragraph:
  ${paragraph}

  Tutorial explanation:
  ${text}`;

  let summary = '';
  let rubric = '';
  
  const defaultSummary = 'Key concepts from this section.';
  const defaultRubric = 'Evaluate the answer based on correctness. If correct, praise. If incorrect, explain gently.';

  try {
    // 3. Pass the schema into generationConfig
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: rubricPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: tutorialMetaSchema
      }
    });

    // The response is now mathematically guaranteed to be valid JSON matching your schema
    const rawText = result.response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);
    
    summary = parsed.summary;
    rubric = parsed.rubric;

  } catch (err) {
    // This catch block will now only trigger on actual network failures 
    // or API outages, not formatting errors!
    console.error(`[Qlearit] Schema generation failed for module ${index}:`, err.message);
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
// ⚡ ADD fileUrl and rawText to the parameters
async function startTutorialSession(userId, text, fileName = 'Untitled Tutorial', fileUrl = null, rawText = null) {
  const paragraphs = chunkText(text);
  if (paragraphs.length === 0) {
    throw new Error('No paragraphs extracted from text');
  }

  // ⚡ FETCH USERNAME EFFICIENTLY ONCE PER SESSION ⚡
  let username = '';
  try {
    const userDoc = await db.collection(USERS_COLLECTION).doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      // Adjust this to match whatever field name you use for the user's name
      username = userData.username || '';
    }
  } catch (err) {
    console.warn(`[Tutorial] Could not fetch username for user ${userId}:`, err.message);
  }

  const BASE_UPLOAD_COST = 0;
  const CHUNK_COST = 1; 
  const totalCost = BASE_UPLOAD_COST + (paragraphs.length * CHUNK_COST);

  // Deduct first
  const deductionResult = await QreditService.deduct(userId, totalCost, `Tutorial (${paragraphs.length} modules)`);

  try {
    const modules = await Promise.all(
      // ⚡ Pass the fetched username down to the generator ⚡
      paragraphs.map((paragraph, index) => generateLearningModule(paragraph, index, username))
    );

    const payload = {
      userId,
      fileName, 
      fileUrl,
      rawText,
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

    if (deductionResult && deductionResult.deducted) {
      try {
        await QreditService.refund(userId, totalCost, `Refund: Failed Tutorial Generation`);
      } catch (refundErr) {
        console.error('CRITICAL: REFUND FAILED', refundErr);
      }
      throw err;
    }
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

// 1. Add history = [] to the parameters
async function handleTutorialFollowUp(userId, sessionId, userMessage, moduleIndex, history = []) {
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

  // 2. BUILD THE HISTORY STRING
  let historyText = "";
  if (history && history.length > 0) {
    historyText = "\n--- CONVERSATION HISTORY ---\n";
    history.forEach(msg => {
      const role = msg.role === 'user' ? 'Student' : 'Tutor';
      historyText += `${role}: ${msg.text}\n`;
    });
    historyText += "----------------------------\n";
  }

  const hasRubric = Boolean(module?.rubric && module.rubric.trim());
  const hasQuestion = Boolean(module?.question && module.question.trim());
  
  const shouldGrade = (hasRubric || hasQuestion) && typeof moduleIndex === 'number';

  if (shouldGrade) {
    const specificQuestion = module.question || "the material just covered";
    const effectiveRubric = hasRubric 
      ? module.rubric 
      : `Verify if the answer correctly addresses "${specificQuestion}" based on the text.`;

    // 3. UPDATE GRADING PROMPT TO SUPPORT INTENT RECOGNITION
    const prompt = `You are "Tutor Qlearit," a friendly, encouraging, and highly intelligent study companion.
    
    Goal: Evaluate the student's answer to a specific question based on the provided Source Text and Rubric OR answer their questions if they need help.
    
    Source Text (The Module):
    ${module.content}
    
    The Question Asked to the Student: 
    ${specificQuestion}
    
    Grading Rubric: 
    ${effectiveRubric}
    ${historyText}
    
    User's Latest Message: 
    ${userMessage}
    
    Instructions:
    1. Intent Check: Look at the Conversation History and the User's Latest Message. Determine if the user is attempting to answer "The Question Asked" OR if they are asking a follow-up question/chatting (e.g., asking for an explanation, advantages, or saying "I don't know").
    2. IF they are asking a question/chatting: Answer their question conversationally based on the Source Text. Do NOT grade them or force them to answer the original question right now.
    3. IF they are attempting to answer the question: Evaluate them using the Rubric. Praise if correct, guide if partially correct, explain if incorrect.
    4. Tone: Warm, supportive.
    5. Length: Concise (2-3 sentences). Do NOT mention the rubric or source text to the user.
    
    Response:`;

    const result = await model.generateContent(prompt);
    const response = await result.response;

    return {
      response: response.candidates?.[0]?.content?.parts?.[0]?.text || '',
      isAnswer: true, 
    };
  }

  // 4. UPDATE NORMAL CHAT PROMPT TO INCLUDE HISTORY
  const prompt = `You are "Tutor Qlearit," a brilliant, warm, and highly conversational academic tutor. 
  You are currently helping a student study the following module:

  --- MODULE TEXT ---
  ${module.content}
  -------------------
  ${historyText}

  The student just said: "${userMessage}"

  Instructions for your response:
  1. Persona: Speak like a friendly human mentor. Be conversational, encouraging, and natural.
  2. Teaching Style: Frequently use relatable allegories, analogies, and metaphors to break down complex ideas from the text.
  3. Context: Base your factual explanations on the provided Module Text.
  4. Formatting: Keep it digestible. You can use emojis sparingly. Avoid sounding like a rigid textbook.

  Response:`;

  const result = await model.generateContent(prompt);
  const response = await result.response;

  return {
    response: response.candidates?.[0]?.content?.parts?.[0]?.text || '',
    isAnswer: false,
  };
}

module.exports = {
  startTutorialSession,
  getNextTutorialModule,
  handleTutorialFollowUp,
  generateLearningModule,
};