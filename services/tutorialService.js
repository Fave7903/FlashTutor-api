const { getRedisClient } = require('../config/redis');
const { extractParagraphs } = require('../utils/fileUtils');
const { generateTutorialModule } = require('../utils/llmUtils');
const config = require('../config');

/**
 * Start a new tutorial session
 * @param {string} userId - User ID
 * @param {string} text - Text content to extract paragraphs from
 * @returns {Promise<string>} Session ID
 */
async function startTutorialSession(userId, text) {
  const redis = await getRedisClient();
  const sessionId = `${userId}:${Date.now()}`;
  
  const paragraphs = extractParagraphs(text);
  
  if (paragraphs.length === 0) {
    throw new Error('No paragraphs extracted from text');
  }
  
  const paragraphsKey = `session:${sessionId}:paragraphs`;
  const metaKey = `session:${sessionId}:meta`;
  const currentParagraphKey = `session:${sessionId}:current:paragraph`;
  
  // Store paragraphs in Redis LIST
  for (const paragraph of paragraphs) {
    await redis.rPush(paragraphsKey, paragraph);
  }
  
  // Store metadata in Redis HASH
  await redis.hSet(metaKey, {
    index: '0',
    userId: userId,
    total: paragraphs.length.toString(),
  });
  
  // Set TTL on all keys (3 hours)
  await redis.expire(paragraphsKey, config.tutorialSessionTTL);
  await redis.expire(metaKey, config.tutorialSessionTTL);
  
  return sessionId;
}

/**
 * Get the next tutorial module
 * @param {string} sessionId - Session ID
 * @returns {Promise<{done: boolean, module?: string, currentIndex?: number, total?: number, isQuestion?: boolean}>}
 */
async function getNextTutorialModule(sessionId) {
  const redis = await getRedisClient();
  const metaKey = `session:${sessionId}:meta`;
  const paragraphsKey = `session:${sessionId}:paragraphs`;
  const currentParagraphKey = `session:${sessionId}:current:paragraph`;
  const hasAskedQuestionKey = `session:${sessionId}:hasAskedQuestion`;
  
  // Get current index
  const indexStr = await redis.hGet(metaKey, 'index');
  if (indexStr === null) {
    throw new Error('Session not found or expired');
  }
  
  let index = parseInt(indexStr, 10);
  const totalStr = await redis.hGet(metaKey, 'total');
  const total = parseInt(totalStr || '0', 10);
  
  // Check if we've reached the end
  if (index >= total) {
    // Clean up session
    await redis.del(paragraphsKey);
    await redis.del(metaKey);
    await redis.del(currentParagraphKey);
    await redis.del(hasAskedQuestionKey);
    return { done: true };
  }
  
  // Get paragraph at current index
  const paragraph = await redis.lIndex(paragraphsKey, index);
  if (!paragraph) {
    // Session finished
    await redis.del(paragraphsKey);
    await redis.del(metaKey);
    await redis.del(currentParagraphKey);
    await redis.del(hasAskedQuestionKey);
    return { done: true };
  }
  
  // Store current paragraph for follow-up questions
  await redis.set(currentParagraphKey, paragraph, { EX: config.tutorialSessionTTL });
  // Reset question flag for new module
  await redis.del(hasAskedQuestionKey);
  
  // Generate tutorial module from this paragraph
  const moduleResult = await generateTutorialModule(paragraph, index);
  
  // Extract question from the module text if it exists
  let questionText = null;
  if (moduleResult.isQuestion) {
    // Try to extract the question part (usually at the end)
    const lines = moduleResult.text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.includes('?') || line.toLowerCase().includes('question')) {
        questionText = line;
        break;
      }
    }
    // If no specific line found, use the last sentence
    if (!questionText) {
      const sentences = moduleResult.text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      if (sentences.length > 0) {
        const lastSentence = sentences[sentences.length - 1].trim();
        if (lastSentence.includes('?') || lastSentence.toLowerCase().includes('question')) {
          questionText = lastSentence;
        }
      }
    }
    
    // Store question tracking
    if (questionText) {
      await redis.set(hasAskedQuestionKey, '1', { EX: config.tutorialSessionTTL });
      await redis.set(`session:${sessionId}:lastQuestion`, questionText, { EX: config.tutorialSessionTTL });
    }
  }
  
  // Increment index
  await redis.hSet(metaKey, 'index', (index + 1).toString());
  
  return {
    done: false,
    module: moduleResult.text,
    currentIndex: index + 1,
    total,
    isQuestion: moduleResult.isQuestion,
  };
}

/**
 * Handle user response (either answer to question or follow-up question)
 * @param {string} sessionId - Session ID
 * @param {string} userMessage - User's message (answer or question)
 * @returns {Promise<{response: string, isAnswer: boolean}>}
 */
async function handleTutorialFollowUp(sessionId, userMessage) {
  const redis = await getRedisClient();
  const currentParagraphKey = `session:${sessionId}:current:paragraph`;
  const metaKey = `session:${sessionId}:meta`;
  const hasAskedQuestionKey = `session:${sessionId}:hasAskedQuestion`;
  const lastQuestionKey = `session:${sessionId}:lastQuestion`;
  
  // Get current paragraph
  const paragraph = await redis.get(currentParagraphKey);
  if (!paragraph) {
    throw new Error('No active tutorial module. Please start a new session or proceed to next module.');
  }
  
  // Check if session exists
  const userId = await redis.hGet(metaKey, 'userId');
  if (!userId) {
    throw new Error('Session not found or expired');
  }
  
  // Check if we just asked a question
  const hasAskedQuestion = await redis.get(hasAskedQuestionKey);
  const lastQuestion = await redis.get(lastQuestionKey);
  
  if (hasAskedQuestion && lastQuestion) {
    // User is answering a question - evaluate and provide feedback
    const prompt = `You are FlashTutor. You just asked the student this comprehension question:

Question: ${lastQuestion}

Current paragraph being taught:
${paragraph}

Student's answer: ${userMessage}

Evaluate the student's answer:
1. Acknowledge if they got it correct or incorrect (be encouraging)
2. Provide brief feedback on their answer
3. Give a concise explanation of the correct answer or expand on the concept
4. Be supportive and educational

Keep it concise but thorough.`;

    const { model } = require('../utils/llmUtils');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    // Clear the question flag since we've processed the answer
    await redis.del(hasAskedQuestionKey);
    await redis.del(lastQuestionKey);
    
    return {
      response: response.text(),
      isAnswer: true,
    };
  } else {
    // User is asking a follow-up question
    const prompt = `You are FlashTutor. The student is asking a follow-up question about the current tutorial module.
  
Current paragraph we're teaching:
${paragraph}

Student's question:
${userMessage}

Answer the question based only on the paragraph above. Be concise, helpful, and educational.`;

    const { model } = require('../utils/llmUtils');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    return {
      response: response.text(),
      isAnswer: false,
    };
  }
}

module.exports = {
  startTutorialSession,
  getNextTutorialModule,
  handleTutorialFollowUp,
};

