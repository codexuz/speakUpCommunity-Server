import { DeepgramClient } from '@deepgram/sdk';
import OpenAI from 'openai';
import prisma from '../prisma';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

export interface TranscriptionResult {
  transcript: string;
  words: { word: string; start: number; end: number; confidence: number }[];
  duration: number;
}

export interface AIAnalysis {
  grammarScore: number;
  fluencyScore: number;
  vocabDiversity: number;
  pronScore: number;
  overallScore: number;
  grammarIssues: { original: string; corrected: string; explanation: string }[];
  vocabSuggestions: { word: string; alternatives: string[]; context: string }[];
  pronIssues: { word: string; issue: string; tip: string }[];
  naturalness: string;
  fillerWords: Record<string, number>;
  aiSummary: string;
}

/**
 * Transcribe audio using Deepgram
 */
export async function transcribeAudio(audioBuffer: Buffer, mimetype: string): Promise<TranscriptionResult> {
  const response = await deepgram.listen.v1.media.transcribeFile(audioBuffer, {
    model: 'nova-3',
    language: 'en',
    smart_format: true,
    punctuate: true,
    utterances: true,
    diarize: false,
  });

  if (!('results' in response)) {
    throw new Error('Unexpected Deepgram response (callback mode)');
  }

  const channel = response.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const transcript = alternative?.transcript || '';
  const words = ((alternative as any)?.words || []).map((w: any) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
  }));
  const duration = (response as any).metadata?.duration || 0;

  return { transcript, words, duration };
}

/**
 * Analyze transcript with OpenAI for grammar, naturalness, vocabulary
 */
export async function analyzeWithAI(
  transcript: string,
  words: TranscriptionResult['words'],
  duration: number,
  questionText: string,
): Promise<AIAnalysis> {
  // Calculate fluency metrics from word timestamps
  const wordCount = words.length;
  const fluencyWPM = duration > 0 ? (wordCount / duration) * 60 : 0;

  // Count filler words
  const fillerPatterns = ['um', 'uh', 'er', 'ah', 'like', 'you know', 'basically', 'actually', 'so', 'well'];
  const fillerWords: Record<string, number> = {};
  const lowerTranscript = transcript.toLowerCase();
  for (const filler of fillerPatterns) {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    const matches = lowerTranscript.match(regex);
    if (matches && matches.length > 0) {
      fillerWords[filler] = matches.length;
    }
  }

  // Calculate pronunciation score from Deepgram confidence
  const avgConfidence = words.length > 0
    ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
    : 0;

  // Count pauses (gaps > 1.5s between words)
  let pauseCount = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i].start - words[i - 1].end > 1.5) {
      pauseCount++;
    }
  }

  // AI analysis via OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are an expert English language speaking assessor. Analyze the student's spoken response and provide structured feedback. Return JSON with these exact fields:

{
  "grammarScore": <0-100 integer>,
  "fluencyScore": <0-100 integer>,
  "vocabDiversity": <0-100 integer>,
  "overallScore": <0-100 integer>,
  "grammarIssues": [{"original": "what they said", "corrected": "correct version", "explanation": "brief rule"}],
  "vocabSuggestions": [{"word": "overused word", "alternatives": ["better option 1", "better option 2"], "context": "in what context"}],
  "naturalness": "A 2-3 sentence assessment of how natural this sounds to a native speaker, with specific suggestions",
  "aiSummary": "A brief encouraging 2-sentence summary of their performance with one key improvement area"
}

Scoring guide:
- grammarScore: 90-100 = near-native, 70-89 = good with minor errors, 50-69 = understandable with noticeable errors, below 50 = significant errors
- fluencyScore: Consider the WPM (${fluencyWPM.toFixed(0)}), pause count (${pauseCount}), and filler word usage. Natural speech is 120-150 WPM.
- vocabDiversity: Variety of vocabulary, avoidance of repetition, appropriate word choices
- overallScore: Weighted combination of all factors

Keep grammarIssues to max 5 most important. Keep vocabSuggestions to max 3.`,
      },
      {
        role: 'user',
        content: `Question/Prompt: "${questionText}"

Student's spoken response (transcript): "${transcript}"

Additional metrics:
- Words per minute: ${fluencyWPM.toFixed(1)}
- Total words: ${wordCount}
- Duration: ${duration.toFixed(1)}s
- Pause count (>1.5s gaps): ${pauseCount}
- Filler words detected: ${JSON.stringify(fillerWords)}
- Average pronunciation confidence: ${(avgConfidence * 100).toFixed(1)}%`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content || '{}';
  let analysis: any;
  try {
    analysis = JSON.parse(content);
  } catch {
    analysis = {};
  }

  return {
    grammarScore: clamp(analysis.grammarScore ?? 50, 0, 100),
    fluencyScore: clamp(analysis.fluencyScore ?? 50, 0, 100),
    vocabDiversity: clamp(analysis.vocabDiversity ?? 50, 0, 100),
    pronScore: clamp(Math.round(avgConfidence * 100), 0, 100),
    overallScore: clamp(analysis.overallScore ?? 50, 0, 100),
    grammarIssues: Array.isArray(analysis.grammarIssues) ? analysis.grammarIssues.slice(0, 5) : [],
    vocabSuggestions: Array.isArray(analysis.vocabSuggestions) ? analysis.vocabSuggestions.slice(0, 3) : [],
    pronIssues: buildPronIssues(words),
    naturalness: analysis.naturalness || '',
    fillerWords,
    aiSummary: analysis.aiSummary || '',
  };
}

/**
 * Build pronunciation issues from low-confidence words
 */
function buildPronIssues(words: TranscriptionResult['words']) {
  return words
    .filter((w) => w.confidence < 0.75)
    .slice(0, 5)
    .map((w) => ({
      word: w.word,
      issue: `Low clarity (${Math.round(w.confidence * 100)}% confidence)`,
      tip: `Try pronouncing "${w.word}" more clearly with emphasis on each syllable`,
    }));
}

/**
 * Convert internal 0-100 overallScore to the exam-specific scale.
 * CEFR: 0–75 (integer), IELTS: 0–9 in 0.5 steps
 */
function toExamScore(overallScore: number, examType: 'cefr' | 'ielts'): number {
  if (examType === 'ielts') {
    const raw = (overallScore / 100) * 9;
    return Math.round(raw * 2) / 2; // nearest 0.5
  }
  return Math.round((overallScore / 100) * 75);
}

/**
 * Full AI feedback pipeline: transcribe → analyze → store
 */
export async function generateAIFeedback(
  responseId: bigint,
  audioBuffer: Buffer,
  mimetype: string,
  questionText: string,
  examType: 'cefr' | 'ielts' = 'cefr',
): Promise<void> {
  // Step 1: Transcribe with Deepgram
  const transcription = await transcribeAudio(audioBuffer, mimetype);

  if (!transcription.transcript.trim()) {
    // No speech detected — store minimal feedback
    await prisma.aIFeedback.create({
      data: {
        responseId,
        examType,
        aiScore: 0,
        transcript: '',
        grammarScore: 0,
        fluencyWPM: 0,
        fluencyScore: 0,
        vocabDiversity: 0,
        pronScore: 0,
        overallScore: 0,
        grammarIssues: [],
        vocabSuggestions: [],
        pronIssues: [],
        naturalness: 'No speech was detected in the audio.',
        fillerWords: {},
        pauseCount: 0,
        aiSummary: 'We could not detect any speech. Please try recording again.',
      },
    });
    return;
  }

  // Step 2: Analyze with OpenAI
  const analysis = await analyzeWithAI(
    transcription.transcript,
    transcription.words,
    transcription.duration,
    questionText,
  );

  // Step 3: Count pauses
  let pauseCount = 0;
  for (let i = 1; i < transcription.words.length; i++) {
    if (transcription.words[i].start - transcription.words[i - 1].end > 1.5) {
      pauseCount++;
    }
  }

  const fluencyWPM = transcription.duration > 0
    ? (transcription.words.length / transcription.duration) * 60
    : 0;

  const aiScore = toExamScore(analysis.overallScore, examType);

  // Step 4: Store in DB
  await prisma.aIFeedback.create({
    data: {
      responseId,
      examType,
      aiScore,
      transcript: transcription.transcript,
      grammarScore: analysis.grammarScore,
      fluencyWPM: Math.round(fluencyWPM * 10) / 10,
      fluencyScore: analysis.fluencyScore,
      vocabDiversity: analysis.vocabDiversity,
      pronScore: analysis.pronScore,
      overallScore: analysis.overallScore,
      grammarIssues: analysis.grammarIssues,
      vocabSuggestions: analysis.vocabSuggestions,
      pronIssues: analysis.pronIssues,
      naturalness: analysis.naturalness,
      fillerWords: analysis.fillerWords,
      pauseCount,
      aiSummary: analysis.aiSummary,
    },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
