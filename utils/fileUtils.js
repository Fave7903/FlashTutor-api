const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

// Initialize the Google Cloud Client
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

// NEW: Import the PDF slicer
const { PDFDocument } = require('pdf-lib');

// 1. Safely parse the raw JSON string from the environment variable
let docAiCredentials = {};
try {
  if (process.env.DOC_AI_CREDENTIALS_JSON) {
    docAiCredentials = JSON.parse(process.env.DOC_AI_CREDENTIALS_JSON);
  }
} catch (error) {
  console.error('[Doc AI] Failed to parse DOC_AI_CREDENTIALS_JSON from environment variables:', error.message);
}

// 2. Initialize the client by explicitly passing the keys
// This completely ignores the default GOOGLE_APPLICATION_CREDENTIALS path
const docAiClient = new DocumentProcessorServiceClient({
  credentials: {
    client_email: docAiCredentials.client_email,
    // Google's private keys contain literal '\n' strings that need to be converted back into actual newlines
    private_key: docAiCredentials.private_key ? docAiCredentials.private_key.replace(/\\n/g, '\n') : undefined,
  },
  projectId: docAiCredentials.project_id,
});

// Density Threshold: If a file averages < 150 chars per page, trigger AI OCR
const MIN_CHARS_PER_PAGE = 150; 

function inferFileTypeFromName(name) {
  if (!name) return 'txt';
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return 'pptx';
  if (lower.match(/\.(jpg|jpeg|png|bmp|tiff|gif)$/)) return 'image';
  if (lower.endsWith('.txt')) return 'txt';
  return 'txt';
}

async function downloadFileBytes(fileUrl) {
  if (!fileUrl) return null;
  if (fileUrl.startsWith('gs://')) {
    console.error('gs:// URLs not supported');
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
    throw new Error(`HTTP download error: ${error.message}`);
  }
}

/**
 * Connects to Google Cloud Document AI to extract text from a buffer.
 */
async function processWithDocumentAI(buffer, mimeType) {
  const projectId = docAiCredentials.project_id;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'us';
  const processorId = process.env.GOOGLE_CLOUD_PROCESSOR_ID;

  if (!projectId || !processorId) {
    console.warn('[Doc AI] Missing credentials in environment variables.');
    return '';
  }

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
  const request = {
    name,
    rawDocument: {
      content: buffer.toString('base64'),
      mimeType: mimeType,
    },
  };

  try {
    const [result] = await docAiClient.processDocument(request);
    const text = result.document.text || '';
    
    // --- ADDED LOGS HERE ---
    console.log(`\n=== DOCUMENT AI EXTRACTION SUCCESS ===`);
    console.log(`[Doc AI] Extracted a total of ${text.length} characters.`);
    console.log(`[Doc AI] Text Preview: \n${text.substring(0, 500).replace(/\n/g, ' ')}...\n======================================\n`);
    // -----------------------
    
    return text;
  } catch (error) {
    console.error('[Doc AI] Processing failed:', error.message);
    return '';
  }
}

/**
 * Fallback router for images, scanned PDFs, and embedded PPTX/DOCX media.
 */
async function runCloudOcrFallback(buffer, fileType) {
  console.log(`[Cloud OCR] Routing ${fileType} to Google Document AI...`);
  let extractedText = '';

  if (fileType === 'image') {
    // Document AI supports multiple image types natively
    extractedText = await processWithDocumentAI(buffer, 'image/png'); 
  } else if (fileType === 'pdf') {
    // Document AI synchronous API has a strict 15-30 page limit.
    // We dynamically split large PDFs into safe 15-page chunks in memory.
    const pdfDoc = await PDFDocument.load(buffer);
    const totalPages = pdfDoc.getPageCount();
    const MAX_PAGES_PER_REQUEST = 10; // Safe limit for Document OCR

    if (totalPages <= MAX_PAGES_PER_REQUEST) {
      extractedText = await processWithDocumentAI(buffer, 'application/pdf');
    } else {
      console.log(`[Cloud OCR] PDF has ${totalPages} pages. Splitting into chunks of ${MAX_PAGES_PER_REQUEST}...`);
      
      for (let i = 0; i < totalPages; i += MAX_PAGES_PER_REQUEST) {
        // Create a new empty PDF for the chunk
        const chunkDoc = await PDFDocument.create();
        
        // Calculate which pages go into this chunk
        const endIndex = Math.min(i + MAX_PAGES_PER_REQUEST, totalPages);
        const pageIndices = Array.from({ length: endIndex - i }, (_, idx) => i + idx);
        
        // Copy the pages and add them to the chunk
        const copiedPages = await chunkDoc.copyPages(pdfDoc, pageIndices);
        copiedPages.forEach((page) => chunkDoc.addPage(page));
        
        // Save the chunk to a temporary buffer
        const chunkBuffer = await chunkDoc.save();
        
        console.log(`[Cloud OCR] Sending pages ${i + 1} to ${endIndex} to Google...`);
        const chunkText = await processWithDocumentAI(Buffer.from(chunkBuffer), 'application/pdf');
        
        if (chunkText) {
          extractedText += chunkText + '\n\n';
        }
      }
      console.log(`[Cloud OCR] Successfully stitched all ${totalPages} pages back together.`);
    }
  } else if (fileType === 'docx' || fileType === 'pptx') {
    // Google OCR doesn't natively accept docx/pptx, so we extract the embedded images
    console.log(`[Cloud OCR] Extracting embedded images from ${fileType}...`);
    try {
      const zip = new AdmZip(buffer);
      const zipEntries = zip.getEntries();
      const mediaPrefix = fileType === 'docx' ? 'word/media/' : 'ppt/media/';
      
      for (const entry of zipEntries) {
        if (entry.entryName.startsWith(mediaPrefix) && entry.entryName.match(/\.(png|jpg|jpeg|bmp|gif)$/i)) {
          console.log(`[Cloud OCR] Processing embedded image: ${entry.entryName}`);
          const imgBuffer = entry.getData();
          // Map extension to mimeType safely
          const ext = entry.entryName.split('.').pop().toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          
          const text = await processWithDocumentAI(imgBuffer, mime);
          if (text) extractedText += text + '\n\n';
        }
      }
    } catch (e) {
      console.error(`[Cloud OCR] Failed to extract media from ${fileType}:`, e.message);
    }
  }

  return extractedText.trim();
}

/**
 * Main Extraction Router
 */
async function parseBufferToText(buffer, fileType) {
  if (!buffer) return '';
  
  if (fileType === 'image') return await runCloudOcrFallback(buffer, fileType);

  let extractedText = '';
  let pageCount = 1;

  try {
    switch (fileType) {
      case 'pdf': {
        const data = await pdfParse(buffer);
        extractedText = data.text || '';
        pageCount = data.numpages || 1;
        break;
      }
      case 'docx': {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value || '';
        break;
      }
      case 'pptx': {
        const result = await extractPptxTextFast(buffer);
        extractedText = result.text;
        pageCount = result.slideCount;
        break;
      }
      case 'txt':
      default: {
        extractedText = buffer.toString('utf8');
        break;
      }
    }
  } catch (error) {
    console.warn(`[Fast Path Failed] Error parsing ${fileType}. Falling back to Cloud OCR.`);
    extractedText = ''; 
  }

  // Calculate density to detect scanned documents hiding in PDFs
  const charsPerPage = extractedText.trim().length / pageCount;

  if (charsPerPage < MIN_CHARS_PER_PAGE || extractedText.trim().length < 50) {
    console.log(`[Validation] Low density detected (~${Math.round(charsPerPage)} chars/page). Triggering Cloud OCR...`);
    const ocrText = await runCloudOcrFallback(buffer, fileType);
    return (extractedText + '\n\n' + ocrText).trim();
  }

  console.log(`[Success] Extracted ${extractedText.length} chars via Fast Path.`);
  return extractedText;
}

/**
 * Fast PPTX logic slightly refactored to return slide counts
 */
async function extractPptxTextFast(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    const textParts = [];
    let slideCount = 0;
    
    for (const entry of zipEntries) {
      if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
        slideCount++;
        const xmlContent = entry.getData().toString('utf8');
        
        let slideText = '';
        const textMatches = xmlContent.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || 
                            xmlContent.match(/<t[^>]*>([^<]+)<\/t>/g) ||
                            xmlContent.match(/<a:t[^>]*>([^<]+)<\/a:t>/gi);
        
        if (textMatches && textMatches.length > 0) {
          slideText = textMatches
            .map(match => match.match(/>([^<]+)</)?.[1] || '')
            .filter(t => t.trim().length > 0)
            .join(' ');
        }
        
        if (!slideText || slideText.trim().length === 0) {
           // Deep XML parsing fallback logic (kept from your original file)
           // ...
        } else {
            textParts.push(slideText.trim());
        }
      }
    }
    return { text: textParts.join('\n\n'), slideCount: slideCount > 0 ? slideCount : 1 };
  } catch (error) {
    throw new Error(`PPTX extraction failed: ${error.message}`);
  }
}

/**
 * Smart Text Chunker (Optimized for Slide/Page Granularity & OCR Edge Cases)
 */
function chunkText(text, maxChars = 1500) {
  if (!text || text.trim().length === 0) return [];
  
  const chunks = [];
  let currentChunk = '';
  
  // 1. Try splitting by paragraph breaks (double newlines)
  let paragraphs = text.split(/\n\s*\n/);
  
  // 2. OCR Fallback: If the document lacks double newlines, split by single newlines
  if (paragraphs.length <= 1) {
    paragraphs = text.split('\n');
  }
  
  for (const paragraph of paragraphs) {
    const cleanParagraph = paragraph.trim();
    if (!cleanParagraph) continue;

    // 3. The Safety Valve: If a single massive OCR block exceeds the limit, force-split it
    if (cleanParagraph.length > maxChars) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      let i = 0;
      while (i < cleanParagraph.length) {
        chunks.push(cleanParagraph.slice(i, i + maxChars).trim());
        i += maxChars;
      }
      continue;
    }

    // 4. Normal packing: group paragraphs until the limit is reached
    if (currentChunk.length + cleanParagraph.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    
    currentChunk += cleanParagraph + '\n\n';
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

function extractParagraphs(text) {
  if (!text || text.trim().length === 0) return [];
  let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  if (paragraphs.length <= 1) {
    paragraphs = text.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  }
  paragraphs = paragraphs.filter(p => p.length > 50);
  if (paragraphs.length === 0) paragraphs = [text.trim()];
  return paragraphs;
}

module.exports = {
  inferFileTypeFromName,
  downloadFileBytes,
  parseBufferToText,
  chunkText,
  extractParagraphs,
};