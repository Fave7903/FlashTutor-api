const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

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

/**
 * Extract paragraphs from text, splitting on double newlines or keeping single paragraphs
 * @param {string} text - The text to extract paragraphs from
 * @returns {string[]} Array of paragraph strings
 */
function extractParagraphs(text) {
  if (!text || text.trim().length === 0) return [];
  
  // Split on double newlines first (paragraph breaks)
  let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  
  // If we got very few paragraphs, try splitting on single newlines
  if (paragraphs.length <= 1) {
    paragraphs = text.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  }
  
  // Filter out very short paragraphs (likely headers or formatting artifacts)
  paragraphs = paragraphs.filter(p => p.length > 50);
  
  // If still too few, return the whole text as one paragraph
  if (paragraphs.length === 0) {
    paragraphs = [text.trim()];
  }
  
  return paragraphs;
}

module.exports = {
  inferFileTypeFromName,
  downloadFileBytes,
  parseBufferToText,
  chunkText,
  extractParagraphs,
};

