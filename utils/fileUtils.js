const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

function inferFileTypeFromName(name) {
  if (!name) return 'txt';
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) return 'pptx';
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
    case 'pptx': {
      try {
        const zip = new AdmZip(buffer);
        const zipEntries = zip.getEntries();
        const textParts = [];
        
        // Extract text from slide XML files
        for (const entry of zipEntries) {
          if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
            try {
              const xmlContent = entry.getData().toString('utf8');
              
              // First, try simple regex extraction as fallback
              let slideText = '';
              const textMatches = xmlContent.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || 
                                  xmlContent.match(/<t[^>]*>([^<]+)<\/t>/g) ||
                                  xmlContent.match(/<a:t[^>]*>([^<]+)<\/a:t>/gi);
              
              if (textMatches && textMatches.length > 0) {
                slideText = textMatches
                  .map(match => {
                    const textMatch = match.match(/>([^<]+)</);
                    return textMatch ? textMatch[1] : '';
                  })
                  .filter(t => t && t.trim().length > 0)
                  .join(' ');
              }
              
              // If regex didn't work, try XML parsing
              if (!slideText || slideText.trim().length === 0) {
                const parser = new xml2js.Parser({
                  explicitArray: false,
                  ignoreAttrs: true,
                  mergeAttrs: false,
                  explicitCharkey: false,
                  trim: true,
                });
                const result = await parser.parseStringPromise(xmlContent);
                
                // Extract text from various possible locations in PPTX XML
                const extractText = (obj, depth = 0) => {
                  if (depth > 30) return ''; // Prevent infinite recursion
                  
                  if (typeof obj === 'string') {
                    // Filter out XML namespace URLs and other non-text content
                    const str = obj.trim();
                    if (!str || 
                        str.startsWith('http://') || 
                        str.startsWith('https://') || 
                        str.startsWith('urn:') ||
                        str.startsWith('<?xml') ||
                        str.includes('xmlns:')) {
                      return '';
                    }
                    return str;
                  }
                  
                  if (Array.isArray(obj)) {
                    return obj.map(item => extractText(item, depth + 1))
                              .filter(t => t && t.length > 0)
                              .join(' ');
                  }
                  
                  if (typeof obj === 'object' && obj !== null) {
                    let text = '';
                    
                    // Check for text in various possible keys
                    const textKeys = ['a:t', 't', 'a:r', 'r', 'a:p', 'p', '_'];
                    for (const key of textKeys) {
                      if (obj[key]) {
                        const txt = extractText(obj[key], depth + 1);
                        if (txt) text += txt + ' ';
                      }
                    }
                    
                    // Recursively search all properties
                    for (const key in obj) {
                      if (!key.startsWith('$') && !key.includes('xmlns') && !key.includes(':')) {
                        const txt = extractText(obj[key], depth + 1);
                        if (txt) text += txt + ' ';
                      }
                    }
                    
                    return text.trim();
                  }
                  
                  return '';
                };
                
                slideText = extractText(result).trim();
              }
              
              // Clean up the extracted text
              if (slideText && slideText.length > 0) {
                const cleanText = slideText
                  .replace(/http:\/\/[^\s]+/g, '') // Remove HTTP URLs
                  .replace(/https:\/\/[^\s]+/g, '') // Remove HTTPS URLs
                  .replace(/urn:[^\s]+/g, '') // Remove URNs
                  .replace(/xmlns[^=]*="[^"]*"/g, '') // Remove xmlns attributes
                  .replace(/<[^>]+>/g, '') // Remove any remaining XML tags
                  .replace(/\s+/g, ' ') // Normalize whitespace
                  .trim();
                
                if (cleanText && cleanText.length > 0) {
                  textParts.push(cleanText);
                }
              }
            } catch (slideError) {
              console.error(`Error parsing slide ${entry.entryName}:`, slideError);
              // Continue with other slides
            }
          }
        }
        
        const finalText = textParts.join('\n\n');
        if (!finalText || finalText.trim().length === 0) {
          console.error('No text extracted from PPTX file');
          throw new Error('No text content found in PowerPoint file');
        }
        
        return finalText;
      } catch (error) {
        console.error('Error parsing PPTX:', error);
        throw new Error(`Failed to extract text from PPTX: ${error.message}`);
      }
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

