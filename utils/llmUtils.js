const { model } = require('../config/ai');
const { chunkText } = require('./fileUtils');

async function sendMessageWithRetry(chat, message, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await chat.sendMessage(message);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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
  const { numMcq = 15, numTf = 5 } = options;

  console.log(`🚀 Starting "Divide & Conquer" Generation...`);

  // --- 1. PREPARE TEXT CHUNKS (The Secret Sauce) ---
  // We split the text so workers don't overlap.
  const cleanText = text.substring(0, 200000); // Safety cap
  const midPoint = Math.floor(cleanText.length / 2);
  
  // Chunk 1: Beginning to Middle (with a little overlap buffer)
  const textFirstHalf = cleanText.substring(0, midPoint + 500);
  
  // Chunk 2: Middle to End
  const textSecondHalf = cleanText.substring(midPoint);

  const quizSchema = {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            question: { type: "STRING" },
            options: { type: "ARRAY", items: { type: "STRING" } },
            answer: { type: "STRING" }
          },
          required: ["question", "options", "answer"]
        }
      }
    }
  };

  const formattingRules = `
  MATH FORMATTING:
  - Use standard LaTeX for formulas ($E=mc^2$).
  - Output raw strings (e.g. \\frac).
  `;

  // --- 2. WORKER FUNCTION ---
  const generateBatch = async (label, type, count, textSegment) => {
    if (count <= 0) return [];
    
    const typeDescription = type === 'MCQ' 
      ? `Multiple-Choice Questions (4 options each)` 
      : `True/False Questions (2 options each)`;

    console.log(`   -> [${label}] Processing ${count} ${type}...`);
    
    // We pass ONLY the specific segment of text to this worker
    const prompt = `Create a study quiz based ONLY on the text fragment provided below.
    TASK: Generate exactly ${count} ${typeDescription}.
    ${formattingRules}
    TEXT FRAGMENT: ${textSegment}`;

    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: quizSchema,
          maxOutputTokens: 8192,
          temperature: 0.3,
        }
      });
      const data = JSON.parse(result.response.text());
      return data.questions || [];
    } catch (e) {
      console.error(`   x [${label}] Failed: ${e.message}`);
      return []; 
    }
  };

  // --- 3. EXECUTE PARALLEL WORKERS ON DIFFERENT TEXTS ---
  const mcqSplit1 = Math.ceil(numMcq / 2);
  const mcqSplit2 = numMcq - mcqSplit1;
  
  try {
    const [batch1, batch2, batch3] = await Promise.all([
      // Worker A: Quiz on the FIRST HALF
      generateBatch("Worker A (First Half)", 'MCQ', mcqSplit1, textFirstHalf),
      
      // Worker B: Quiz on the SECOND HALF
      generateBatch("Worker B (Second Half)", 'MCQ', mcqSplit2, textSecondHalf),
      
      // Worker C: Quiz on EVERYTHING (T/F are usually distinct enough)
      generateBatch("Worker C (T/F)", 'TF', numTf, cleanText)
    ]);

    const allQuestions = [...batch1, ...batch2, ...batch3];
    
    console.log(`✅ Final Count: ${allQuestions.length} / ${numMcq + numTf}`);
    return { questions: allQuestions };

  } catch (error) {
    console.error("Critical Failure:", error);
    throw error;
  }
}

// async function generateQuizFromText(text, options = {}) {
//   const { numMcq = 15, numTf = 5 } = options;
//   const prompt = `Create a study quiz from the text below. Return STRICT JSON only with shape: {"questions": [{"question": string, "options": string[], "answer": string}]}.\n- Include exactly ${numMcq} multiple-choice items.\n- Include ${numTf} true/false by using options ["True","False"] and answer must be either "True" or "False".\nTEXT:\n${text}`;
//   const result = await model.generateContent(prompt);
//   const raw = (await result.response.text()).replace(/```json/g, '').replace(/```/g, '').trim();
//   try {
//     const parsed = JSON.parse(raw);
//     const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
//     const normalized = questions.map((q) => {
//       const question = (q.question || q.prompt || '').toString();
//       const options = Array.isArray(q.options) ? q.options.map((o) => o.toString()) : [];
//       const answer = (q.answer || '').toString();
//       return { question, options, answer };
//     });
//     return { questions: normalized };
//   } catch (e) {
//     console.error('Quiz JSON parse failed:', e.message);
//     return { questions: [] };
//   }
// }

async function generateTutorialModule(paragraphText, moduleIndex = 0) {
  // For the first module, use a welcoming prompt. For subsequent modules, be continuous.
  const introText = moduleIndex === 0 
    ? `You are Qlearit, an expert, fun, and engaging AI tutor. I'll be teaching you step by step. Let's begin!\n\n`
    : `Continuing with the next concept:\n\n`;

  // Strict formatting rules to ensure Flutter renders Math and Tables correctly
  const formattingRules = `
### STRICT FORMATTING RULES:
1. **Mathematical Formulas (LaTeX Only):**
   - **Inline Math:** Use single dollar signs. Example: $E = mc^2$ or "Let $x$ be the variable."
   - **Block Math:** Use double dollar signs. Example: $$ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} $$
   - **Matrices:** Use LaTeX environments inside double dollars. Example: $$ \\begin{vmatrix} 1 & 2 \\\\ 3 & 4 \\end{vmatrix} $$
   - **Do NOT** use code blocks (like \`\`\`math) for equations.

2. **Tables & Text (Markdown Only):**
   - **Tables:** Use standard Markdown tables. Do NOT use LaTeX arrays/tabular for text data.
   - **Styling:** Use **bold**, *italics*, and lists as normal.
   - **Conflict Prevention:** Never put standard text descriptions inside a LaTeX math block.
`;

  const tutorialPrompt = `${introText}Teach this concept clearly and simply. Explain step-by-step, then ask ONE comprehension question at the end to check understanding.

Teaching style:
- Clear and step-by-step
- Engaging with light humor
- Interactive: ask questions to check understanding
- Motivational: encourage learning
- Concise to keep tokens minimal

${formattingRules}

Paragraph to teach:
${paragraphText}

Now teach this concept and ask ONE comprehension question at the end.`;

  const result = await model.generateContent(tutorialPrompt);
  const response = await result.response;
  const text = response.text();

  // Try to detect if there's a question in the response
  const questionIndicators = ['?', 'question', 'what', 'how', 'why', 'which', 'can you'];
  const hasQuestion = questionIndicators.some(indicator => 
    text.toLowerCase().includes(indicator.toLowerCase())
  );

  return {
    text,
    isQuestion: hasQuestion,
  };
}

// async function generateTutorialModule(paragraphText, moduleIndex = 0) {
//   // For the first module, use a welcoming prompt. For subsequent modules, be continuous.
//   const introText = moduleIndex === 0 
//     ? `You are Qlearit, an expert, fun, and engaging AI tutor. I'll be teaching you step by step. Let's begin!\n\n`
//     : `Continuing with the next concept:\n\n`;
  
//   const tutorialPrompt = `${introText}Teach this concept clearly and simply. Explain step-by-step, then ask ONE comprehension question at the end to check understanding.

// Teaching style:
// - Clear and step-by-step
// - Engaging with light humor
// - Interactive: ask questions to check understanding
// - Motivational: encourage learning
// - Concise to keep tokens minimal

// Paragraph to teach:
// ${paragraphText}

// Now teach this concept and ask ONE comprehension question at the end.`;

//   const result = await model.generateContent(tutorialPrompt);
//   const response = await result.response;
//   const text = response.text();
  
//   // Try to detect if there's a question in the response
//   const questionIndicators = ['?', 'question', 'what', 'how', 'why', 'which', 'can you'];
//   const hasQuestion = questionIndicators.some(indicator => 
//     text.toLowerCase().includes(indicator.toLowerCase())
//   );
  
//   return {
//     text,
//     isQuestion: hasQuestion,
//   };
// }

module.exports = {
  sendMessageWithRetry,
  summarizeLongText,
  generateQuizFromText,
  generateTutorialModule,
  model,
};

