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


// async function summarizeLongText(text) {
//   const chunks = chunkText(text);
//   if (chunks.length === 0) return { bullets: [], overview: '', keyTerms: [] };

//   console.log(`🚀 Summarizing ${chunks.length} chunks...`);

//   // --- 1. PARALLEL PROCESSING ---
//   // We map over all chunks simultaneously instead of waiting in a loop.
//   // We also ask for a mini-overview here so the final step has narrative context.
//   const partialSummaries = await Promise.all(chunks.map(async (chunk, index) => {
//     const prompt = `Summarize this text section. Provide a 2-sentence overview, 3-5 key bullet points, and 3-5 key terms.\n\nTEXT:\n${chunk}`;
//     try {
//       const result = await model.generateContent(prompt);
//       return (await result.response).text();
//     } catch (e) {
//       console.warn(`Chunk ${index} failed, skipping...`);
//       return ''; 
//     }
//   }));

//   const combined = partialSummaries.filter(Boolean).join('\n\n---NEXT SECTION---\n\n');

//   // --- 2. NATIVE JSON SCHEMA ---
//   // This forces Gemini to return a perfect Javascript object. No regex needed.
//   const summarySchema = {
//     type: "OBJECT",
//     properties: {
//       overview: { type: "STRING" },
//       bullets: { type: "ARRAY", items: { type: "STRING" } },
//       keyTerms: { type: "ARRAY", items: { type: "STRING" } }
//     },
//     required: ["overview", "bullets", "keyTerms"]
//   };

//   // --- 3. CONSOLIDATION PROMPT ---
//   // Explicitly tell the model HOW to synthesize the massive text into a final form.
//   const finalPrompt = `You are an expert academic summarizer. I am giving you partial summaries of a larger document. 
//   Synthesize them into one cohesive, final master summary.
  
//   REQUIREMENTS:
//   1. 'overview': Write a cohesive 3-4 sentence narrative overview of the entire document.
//   2. 'bullets': Extract exactly 7-10 of the most critical bullet points overall.
//   3. 'keyTerms': Extract exactly 5-8 of the most important key terms overall.

//   PARTIAL SUMMARIES:
//   ${combined}`;

//   try {
//     const finalResult = await model.generateContent({
//       contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
//       generationConfig: {
//         responseMimeType: "application/json",
//         responseSchema: summarySchema,
//         temperature: 0.3, // Lower temp = more factual/focused summaries
//       }
//     });

//     const data = JSON.parse(finalResult.response.text());
    
//     // Safety fallback in case the model returns empty arrays
//     return {
//       overview: data.overview || 'No overview generated.',
//       bullets: data.bullets && data.bullets.length > 0 ? data.bullets : ['No bullet points generated.'],
//       keyTerms: data.keyTerms && data.keyTerms.length > 0 ? data.keyTerms : ['No key terms generated.']
//     };

//   } catch (error) {
//     console.error("Critical Summary Generation Error:", error);
//     return { 
//       overview: 'Failed to synthesize summary.', 
//       bullets: ['An error occurred while generating the summary.'], 
//       keyTerms: [] 
//     };
//   }
// }

async function summarizeLongText(text) {
  // ---------------------------------------------------------
  // 🛡️ FIX 1: SAFETY CAPS FOR MASSIVE DOCUMENTS (Textbooks)
  // ---------------------------------------------------------
  const cleanText = text.substring(0, 150000); 
  let chunks = chunkText(cleanText);

  // Hard cap chunks to prevent the final prompt from exploding the context window
  if (chunks.length > 15) {
    console.warn(`Text too large. Capping at 15 chunks.`);
    chunks = chunks.slice(0, 15);
  }

  if (chunks.length === 0) return { bullets: [], overview: '', keyTerms: [] };

  console.log(`🚀 Summarizing ${chunks.length} chunks with batching...`);

  // ---------------------------------------------------------
  // ⏱️ FIX 2: BATCH PROCESSING (Prevents 429 Rate Limits)
  // ---------------------------------------------------------
  const partialSummaries = [];
  const BATCH_SIZE = 4;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    console.log(`   -> Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(chunks.length / BATCH_SIZE)}...`);
    
    const batchResults = await Promise.all(batch.map(async (chunk, index) => {
      // 🧠 FIX 3: SOFTENED PROMPT FOR SHORT DOCUMENTS
      const prompt = `You are an expert tutor. Extract highly detailed notes from this section. Include a comprehensive overview, exhaustive key bullet points (with sub-points if necessary), and all crucial key terms with their definitions. Do not invent information.\n\nTEXT:\n${chunk}`;
      try {
        const result = await model.generateContent(prompt);
        return (await result.response).text();
      } catch (e) {
        console.warn(`Chunk ${i + index} failed, skipping...`);
        return ''; 
      }
    }));
    
    partialSummaries.push(...batchResults);
    
    // Anti-rate-limit delay: Wait 2 seconds between batches
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const combined = partialSummaries.filter(Boolean).join('\n\n---NEXT SECTION---\n\n');

  const summarySchema = {
    type: "OBJECT",
    properties: {
      overview: { type: "STRING", description: "A detailed, multi-paragraph overview of the entire material." },
      bullets: { type: "ARRAY", items: { type: "STRING", description: "Extensive, highly detailed study points. Use Markdown for bolding and structure." } },
      keyTerms: { type: "ARRAY", items: { type: "STRING", description: "Key terms AND their definitions." } }
    },
    required: ["overview", "bullets", "keyTerms"]
  };

  // ---------------------------------------------------------
  // ⚖️ FIX 4: DYNAMIC CONSOLIDATION PROMPT
  // ---------------------------------------------------------
  const finalPrompt = `You are an expert academic summarizer preparing a student for a final exam. I am giving you detailed notes from a larger document. 
  Synthesize them into one cohesive, comprehensive, and highly detailed master summary.
  
  REQUIREMENTS:
  1. 'overview': Write a highly detailed, comprehensive narrative overview capturing all major themes and concepts.
  2. 'bullets': Extract ALL critical topics. Make each point highly detailed with sub-points. Use Markdown (e.g., bolding key phrases). For long documents, aim for 10-20 points. For shorter documents, extract only as many as the text genuinely supports without inventing information.
  3. 'keyTerms': Extract all crucial key terms and provide a concise definition for each in the format "**Term:** Definition". Do not invent terms.

  PARTIAL SUMMARIES:
  ${combined}`;

  try {
    const finalResult = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: summarySchema,
        temperature: 0.3, 
        // ---------------------------------------------------------
        // 📏 FIX 5: PREVENT JSON TRUNCATION
        // ---------------------------------------------------------
        maxOutputTokens: 8192, 
      }
    });

    const data = JSON.parse(finalResult.response.text());
    
    return {
      overview: data.overview || 'No overview generated.',
      bullets: data.bullets && data.bullets.length > 0 ? data.bullets : ['No bullet points generated.'],
      keyTerms: data.keyTerms && data.keyTerms.length > 0 ? data.keyTerms : ['No key terms generated.']
    };

  } catch (error) {
    console.error("Critical Summary Generation Error:", error);
    throw new Error("Failed to generate detailed summary. The file might be too short or complex for this format.");
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

// ⚡ ADDED username PARAMETER HERE (defaults to empty string) ⚡
async function generateTutorialModule(paragraphText, moduleIndex = 0, username = '') {
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

  // ⚡ INJECT PERSONALIZATION IF USERNAME IS PROVIDED ⚡
  const personalTouch = username 
    ? `\n- Personalization: Occasionally address the student by their name (${username}) to build a friendly connection.` 
    : '';

  const tutorialPrompt = `${introText}Teach this concept clearly and simply. Explain step-by-step, then ask ONE comprehension question at the end to check understanding.

Teaching style:
- Clear and step-by-step
- Engaging with light humor
- Interactive: ask questions to check understanding
- Motivational: encourage learning
- Concise to keep tokens minimal${personalTouch}

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

module.exports = {
  sendMessageWithRetry,
  summarizeLongText,
  generateQuizFromText,
  generateTutorialModule,
  model,
};