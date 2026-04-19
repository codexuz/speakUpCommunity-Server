import OpenAI from 'openai';
import prisma from '../prisma';
import { ExamType } from '@prisma/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── IELTS band → CEFR mapping ─────────────────────────────────
// IELTS 0-3.5 → A2, 4-4.5 → B1, 5-6 → B2, 6.5-7.5 → C1, 8-9 → C2
function ieltsBandToCefr(band: number): string {
  if (band <= 3.5) return 'A2';
  if (band <= 4.5) return 'B1';
  if (band <= 6.0) return 'B2';
  if (band <= 7.5) return 'C1';
  return 'C2';
}

// ─── CEFR score → CEFR level mapping ───────────────────────────
// 1 → A2, 2 → B1, 3 → lower B2, 4 → higher B2, 5 → C1, 6 → C2
function cefrScoreToLevel(score: number): string {
  if (score <= 1) return 'A2';
  if (score <= 2) return 'B1';
  if (score <= 4) return 'B2';
  if (score <= 5) return 'C1';
  return 'C2';
}

export function deriveCefrLevel(score: number, examType: ExamType): string {
  return examType === 'ielts' ? ieltsBandToCefr(score) : cefrScoreToLevel(score);
}

export interface WritingAIAnalysis {
  taskAchievement: number;
  coherenceCohesion: number;
  lexicalResource: number;
  grammaticalRange: number;
  overallScore: number;
  grammarIssues: { original: string; corrected: string; explanation: string }[];
  vocabSuggestions: { word: string; alternatives: string[]; context: string }[];
  coherenceNotes: { issue: string; suggestion: string }[];
  taskNotes: string;
  aiSummary: string;
  improvedEssay: string;
}

function getSystemPrompt(examType: ExamType, taskText: string): string {
  if (examType === 'ielts') {
    return `You are an expert IELTS Writing examiner. Assess the student's essay strictly following the IELTS Writing Band Descriptors. Return JSON with these exact fields:

{
  "taskAchievement": <0-9 float, 0.5 increments>,
  "coherenceCohesion": <0-9 float, 0.5 increments>,
  "lexicalResource": <0-9 float, 0.5 increments>,
  "grammaticalRange": <0-9 float, 0.5 increments>,
  "overallScore": <0-9 float, 0.5 increments — average of four criteria>,
  "grammarIssues": [{"original": "what they wrote", "corrected": "correct version", "explanation": "brief rule"}],
  "vocabSuggestions": [{"word": "overused/incorrect word", "alternatives": ["better option 1", "better option 2"], "context": "in what context"}],
  "coherenceNotes": [{"issue": "cohesion problem", "suggestion": "how to fix"}],
  "taskNotes": "Assessment of how well the task/question was addressed, paragraph structure, and completeness",
  "aiSummary": "A brief encouraging 2-3 sentence summary with key strengths and one priority improvement area",
  "improvedEssay": "A rewritten Band 7+ version of the student's essay maintaining their ideas"
}

IELTS Band Descriptors summary:
- Band 9: Expert — full mastery
- Band 7-8: Very Good/Good — good command with occasional inaccuracies
- Band 5-6: Modest/Competent — partial command, frequent errors but meaning is clear
- Band 3-4: Limited/Extremely Limited — basic meaning conveyed with many errors
- Band 1-2: Non/Intermittent user

Keep grammarIssues to max 8. Keep vocabSuggestions to max 5. Keep coherenceNotes to max 4.`;
  }

  // CEFR scoring
  return `You are an expert CEFR Writing assessor. Assess the student's essay following the CEFR Writing competence framework. Return JSON with these exact fields:

{
  "taskAchievement": <1-6 integer>,
  "coherenceCohesion": <1-6 integer>,
  "lexicalResource": <1-6 integer>,
  "grammaticalRange": <1-6 integer>,
  "overallScore": <1-6 integer — average of four criteria, rounded>,
  "grammarIssues": [{"original": "what they wrote", "corrected": "correct version", "explanation": "brief rule"}],
  "vocabSuggestions": [{"word": "overused/incorrect word", "alternatives": ["better option 1", "better option 2"], "context": "in what context"}],
  "coherenceNotes": [{"issue": "cohesion problem", "suggestion": "how to fix"}],
  "taskNotes": "Assessment of how well the task was addressed and completeness",
  "aiSummary": "A brief encouraging 2-3 sentence summary with key strengths and one priority improvement area",
  "improvedEssay": "An improved version of the student's essay at one level higher, maintaining their ideas"
}

CEFR Writing Levels:
- 1 (A2): Can write short, simple texts on familiar topics. Limited vocabulary and simple sentence structures.
- 2 (B1): Can write straightforward connected text on familiar topics. Some cohesion and basic range.
- 3 (Lower B2): Can write clear detailed text on a range of subjects. Good paragraph organization with some complexity.
- 4 (Higher B2): Can write well-structured text, argue for/against. Good range of vocabulary and grammar.
- 5 (C1): Can write clear, well-structured text on complex subjects. Sophisticated vocabulary and grammar.
- 6 (C2): Can write smooth, fluent text in an appropriate style. Near-native command of language.

Keep grammarIssues to max 8. Keep vocabSuggestions to max 5. Keep coherenceNotes to max 4.`;
}

export async function analyzeWriting(
  essayText: string,
  taskText: string,
  examType: ExamType,
): Promise<WritingAIAnalysis> {
  const wordCount = essayText.trim().split(/\s+/).length;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: getSystemPrompt(examType, taskText) },
      {
        role: 'user',
        content: `Task/Prompt: "${taskText}"

Student's essay (${wordCount} words):
"""
${essayText}
"""`,
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

  const maxScore = examType === 'ielts' ? 9 : 6;
  const minScore = examType === 'ielts' ? 0 : 1;

  return {
    taskAchievement: clamp(analysis.taskAchievement ?? minScore, minScore, maxScore),
    coherenceCohesion: clamp(analysis.coherenceCohesion ?? minScore, minScore, maxScore),
    lexicalResource: clamp(analysis.lexicalResource ?? minScore, minScore, maxScore),
    grammaticalRange: clamp(analysis.grammaticalRange ?? minScore, minScore, maxScore),
    overallScore: clamp(analysis.overallScore ?? minScore, minScore, maxScore),
    grammarIssues: Array.isArray(analysis.grammarIssues) ? analysis.grammarIssues.slice(0, 8) : [],
    vocabSuggestions: Array.isArray(analysis.vocabSuggestions) ? analysis.vocabSuggestions.slice(0, 5) : [],
    coherenceNotes: Array.isArray(analysis.coherenceNotes) ? analysis.coherenceNotes.slice(0, 4) : [],
    taskNotes: analysis.taskNotes || '',
    aiSummary: analysis.aiSummary || '',
    improvedEssay: analysis.improvedEssay || '',
  };
}

/**
 * Full writing AI feedback pipeline: analyze → store
 */
export async function generateWritingAIFeedback(
  responseId: bigint,
  essayText: string,
  taskText: string,
  examType: ExamType,
): Promise<void> {
  const analysis = await analyzeWriting(essayText, taskText, examType);
  const cefrLevel = deriveCefrLevel(analysis.overallScore, examType);

  await prisma.writingAIFeedback.create({
    data: {
      responseId,
      examType,
      taskAchievement: analysis.taskAchievement,
      coherenceCohesion: analysis.coherenceCohesion,
      lexicalResource: analysis.lexicalResource,
      grammaticalRange: analysis.grammaticalRange,
      overallScore: analysis.overallScore,
      cefrLevel,
      grammarIssues: analysis.grammarIssues,
      vocabSuggestions: analysis.vocabSuggestions,
      coherenceNotes: analysis.coherenceNotes,
      taskNotes: analysis.taskNotes,
      aiSummary: analysis.aiSummary,
      improvedEssay: analysis.improvedEssay,
    },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
