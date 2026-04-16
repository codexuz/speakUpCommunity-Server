# SpeakUp Community v2 — Engagement Features Update

> **Backend version:** v2.0 — April 2026
> **New API routes:** `/api/progress`, `/api/challenges`, `/api/courses`, `/api/ai-feedback`
> **New env vars:** `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`

This document covers all 6 new engagement phases, the API contracts for each, and UI/UX recommendations for the Expo app.

---

## Table of Contents

1. [AI Hybrid Feedback](#1-ai-hybrid-feedback)
2. [Gamification System](#2-gamification-system)
3. [Daily & Weekly Challenges](#3-daily--weekly-challenges)
4. [Duolingo-style Courses](#4-duolingo-style-courses)
5. [Low-Pressure Practice Mode](#5-low-pressure-practice-mode)
6. [Social Reputation System](#6-social-reputation-system)
7. [Dual Exam Scoring (CEFR + IELTS)](#7-dual-exam-scoring-cefr--ielts)
8. [TypeScript Types](#typescript-types)
9. [Migration & Environment Setup](#migration--environment-setup)
10. [UI/UX Design Guide](#uiux-design-guide)

---

## 1. AI Hybrid Feedback

Every audio response now gets automatic AI analysis via Deepgram (transcription) + OpenAI (scoring). Feedback is generated asynchronously by the audio worker after processing.

### How it works

1. User submits a recording → audio worker processes it
2. Deepgram Nova-3 transcribes with word-level timestamps + confidence
3. OpenAI GPT-4o-mini scores grammar, fluency, vocabulary, naturalness
4. Pronunciation score is computed from Deepgram word confidence
5. Result is stored as `AIFeedback` linked to the `Response`

### Endpoints

#### `GET /api/ai-feedback/:responseId`

Returns AI feedback for a single response.

**Auth:** Owner, teacher, or admin.

**Response:**

```json
{
  "id": "clx...",
  "responseId": "12345",
  "transcript": "I usually wake up at seven o'clock and...",
  "grammarScore": 78,
  "fluencyWPM": 132.5,
  "fluencyScore": 82,
  "vocabDiversity": 71,
  "pronScore": 88,
  "overallScore": 80,
  "grammarIssues": [
    {
      "original": "I go to work by walk",
      "corrected": "I walk to work",
      "explanation": "Use the verb form, not 'by walk'"
    }
  ],
  "vocabSuggestions": [
    {
      "word": "good",
      "alternatives": ["excellent", "wonderful", "pleasant"],
      "context": "describing your morning"
    }
  ],
  "pronIssues": [
    {
      "word": "usually",
      "issue": "Low clarity (68% confidence)",
      "tip": "Try pronouncing \"usually\" more clearly with emphasis on each syllable"
    }
  ],
  "naturalness": "Your speech sounds fairly natural with good pacing. Try connecting ideas with transitions like 'after that' or 'then' instead of starting new sentences.",
  "fillerWords": { "um": 3, "like": 2 },
  "pauseCount": 2,
  "aiSummary": "Good overall performance! Your grammar is solid with minor preposition errors. Focus on reducing filler words to sound more confident.",
  "createdAt": "2026-04-16T...",
  "response": {
    "studentId": "...",
    "question": { "qText": "Describe your morning routine", "part": 2 }
  }
}
```

Returns `404` if feedback hasn't been generated yet (still processing).

#### `GET /api/ai-feedback/session/:sessionId`

Returns all AI feedbacks for a test session with aggregated scores.

**Auth:** Owner, teacher, admin. Public/group sessions accessible by anyone.

**Response:**

```json
{
  "feedbacks": [
    {
      "id": "...",
      "responseId": "12345",
      "transcript": "...",
      "grammarScore": 78,
      "fluencyScore": 82,
      "overallScore": 80,
      "aiSummary": "...",
      "response": {
        "id": "12345",
        "question": { "id": 1, "qText": "Describe your morning routine", "part": 2 }
      }
    }
  ],
  "aggregate": {
    "averageOverallScore": 77,
    "averageFluencyWPM": 128.3,
    "totalResponses": 3
  }
}
```

#### `POST /api/ai-feedback/:responseId/helpful`

Mark someone's recording as helpful — gives the speaker a reputation vote + XP.

**Body:** None required.

**Response:** `{ "message": "Helpful vote recorded" }`

Cannot vote on your own feedback. Returns `400` if attempted.

---

## 2. Gamification System

Full XP, levels, streaks, coins, achievements, and leaderboards.

### XP Reward Table

| Action | XP | Coins |
|--------|-----|-------|
| Submit a recording | 20 | — |
| AI score above 60 | 30 (bonus) | — |
| Review someone's session | 15 | — |
| Complete daily challenge | 50 | 5 |
| Complete weekly challenge | 200 | 50 |
| Receive helpful vote | 10 | 2 |
| Complete a lesson | 10 | — |
| 7-day streak (one-time) | 100 | 20 |
| 30-day streak (one-time) | 500 | 100 |

### Level Curve

Level N requires `N × 100` XP to reach the next level.
- Level 1 → 2: 100 XP
- Level 2 → 3: 200 XP
- Level 5 → 6: 500 XP

Total XP for level N = `N × (N-1) × 50`

### Streak System

- A streak increments each day the user earns XP (recording, review, challenge, lesson)
- Streak resets at 1 AM UTC if the user had no activity the previous day
- **Streak Freeze:** Users can buy freezes with coins (50 coins each, max 3). A freeze auto-prevents one missed day.

### Endpoints

#### `GET /api/progress/me`

Returns the user's full progress profile.

**Response:**

```json
{
  "id": "...",
  "userId": "...",
  "xp": 1250,
  "level": 5,
  "coins": 120,
  "currentStreak": 12,
  "longestStreak": 18,
  "streakFreezes": 1,
  "weeklyXP": 350,
  "lastActiveDate": "2026-04-16T00:00:00.000Z",
  "fluencyWPMAvg": 128.5,
  "vocabDiversityAvg": 72.3,
  "pronScoreAvg": 85.1,
  "xpInCurrentLevel": 250,
  "xpForNextLevel": 500,
  "xpPercent": 50
}
```

#### `GET /api/progress/achievements`

Returns all achievements with user's unlock status.

**Response:**

```json
{
  "data": [
    {
      "id": "...",
      "key": "first_recording",
      "title": "First Steps",
      "description": "Submit your first recording",
      "category": "speaking",
      "xpReward": 50,
      "coinReward": 10,
      "unlocked": true,
      "unlockedAt": "2026-04-10T..."
    },
    {
      "id": "...",
      "key": "7_day_streak",
      "title": "Week Warrior",
      "description": "Maintain a 7-day streak",
      "category": "streak",
      "xpReward": 100,
      "coinReward": 20,
      "unlocked": false,
      "unlockedAt": null
    }
  ]
}
```

**Achievement categories:** `speaking`, `social`, `streak`, `mastery`

**All achievements:**

| Key | Title | Description | Category |
|-----|-------|-------------|----------|
| `first_recording` | First Steps | Submit your first recording | speaking |
| `10_recordings` | Getting Started | Submit 10 recordings | speaking |
| `50_recordings` | Dedicated Speaker | Submit 50 recordings | speaking |
| `100_recordings` | Speaking Master | Submit 100 recordings | speaking |
| `helpful_reviewer` | Helpful Reviewer | Give 10 reviews | social |
| `50_reviews` | Dedicated Reviewer | Give 50 reviews | social |
| `100_reviews` | Review Master | Give 100 reviews | social |
| `7_day_streak` | Week Warrior | 7-day streak | streak |
| `30_day_streak` | Streak Master | 30-day streak | streak |
| `level_5` | Rising Star | Reach level 5 | mastery |
| `level_10` | Fluency Champion | Reach level 10 | mastery |
| `community_star` | Community Star | 100 likes received | social |
| `first_challenge` | Challenge Accepted | First daily challenge | speaking |
| `course_completer` | Course Completer | Complete an entire course | mastery |

#### `POST /api/progress/check-achievements`

Manually trigger achievement check. Called automatically by the server after XP actions, but can be triggered by the client too.

**Response:**

```json
{
  "newlyUnlocked": [
    { "id": "...", "key": "10_recordings", "title": "Getting Started" }
  ]
}
```

#### `POST /api/progress/buy-streak-freeze`

Purchase a streak freeze (costs 50 coins, max 3 active freezes).

**Response (success):** `{ "success": true, "message": "Streak freeze purchased", "streakFreezes": 2, "coins": 70 }`

**Response (fail):** `{ "error": "Not enough coins. Need 50, have 30" }` (status 400)

#### `GET /api/progress/leaderboard?type=weekly&limit=20`

**Query params:**
- `type`: `weekly` (default), `alltime`, `streak`
- `limit`: 1–50 (default 20)

**Response:**

```json
{
  "type": "weekly",
  "data": [
    {
      "userId": "...",
      "weeklyXP": 450,
      "level": 7,
      "user": { "id": "...", "fullName": "Sara K.", "username": "sara_k", "avatarUrl": "..." }
    }
  ],
  "userRank": 5,
  "userProgress": { "...full progress object..." }
}
```

#### `GET /api/progress/weekly-summary`

Weekly improvement dashboard data.

**Response:**

```json
{
  "weeklyXP": 350,
  "weeklyRecordings": 8,
  "currentStreak": 12,
  "level": 5,
  "improvements": {
    "fluency": 5,
    "grammar": -2,
    "vocabulary": 8
  },
  "averages": {
    "fluencyWPM": 128.5,
    "vocabDiversity": 72.3,
    "pronScore": 85.1
  },
  "totalFeedbacks": 8
}
```

Improvement values are the delta between the first and second half of this week's AI feedbacks. Positive = improving.

#### `GET /api/progress/reputation?userId=optional`

Get reputation profile. Defaults to current user. Pass `?userId=...` to view others.

**Response:**

```json
{
  "id": "...",
  "userId": "...",
  "helpfulVotes": 42,
  "reviewsGiven": 28,
  "clarityScore": 85.5,
  "mentorLevel": 2,
  "mentorLabel": "Mentor",
  "badges": ["helpful_10", "reviewer_25", "clear_speaker"],
  "user": { "id": "...", "fullName": "Sara K.", "username": "sara_k", "avatarUrl": "..." }
}
```

**Mentor levels:**
| Level | Label | Requirement |
|-------|-------|-------------|
| 0 | (none) | Default |
| 1 | Helper | 10+ reviews, 5+ helpful votes |
| 2 | Mentor | 25+ reviews, 20+ helpful votes, 70+ clarity |
| 3 | Expert | 50+ reviews, 50+ helpful votes, 80+ clarity |

---

## 3. Daily & Weekly Challenges

Auto-generated daily and weekly speaking challenges. Daily challenges rotate from a pool of 31 prompts; weekly challenges from 8.

### Endpoints

#### `GET /api/challenges?type=daily`

List active challenges. Omit `type` for all.

**Query params:** `type` — `daily`, `weekly`, `special` (optional)

**Response:**

```json
{
  "data": [
    {
      "id": "...",
      "title": "Morning Routine",
      "description": "Describe your typical morning",
      "type": "daily",
      "difficulty": "beginner",
      "promptText": "Describe your morning routine in 30 seconds. What do you do first?",
      "promptImage": null,
      "startsAt": "2026-04-16T00:00:00.000Z",
      "endsAt": "2026-04-17T00:00:00.000Z",
      "xpReward": 50,
      "coinReward": 5,
      "isActive": true,
      "submitted": false,
      "participantCount": 42
    }
  ]
}
```

#### `GET /api/challenges/:id`

Challenge detail with recent submissions feed.

**Response:**

```json
{
  "id": "...",
  "title": "Morning Routine",
  "description": "...",
  "type": "daily",
  "difficulty": "beginner",
  "promptText": "Describe your morning routine...",
  "startsAt": "...",
  "endsAt": "...",
  "xpReward": 50,
  "coinReward": 5,
  "submitted": true,
  "userSubmission": {
    "id": "...",
    "responseId": "12345",
    "submittedAt": "..."
  },
  "participantCount": 42,
  "submissions": [
    {
      "id": "...",
      "userId": "...",
      "responseId": "12345",
      "submittedAt": "...",
      "user": { "id": "...", "fullName": "Sara K.", "username": "sara_k", "avatarUrl": "..." }
    }
  ]
}
```

#### `POST /api/challenges/:id/submit`

Submit a recording for a challenge. Multipart form-data.

**Body (multipart):**

| Field | Type | Required |
|-------|------|----------|
| `audio` | file (audio, max 50MB) | Yes |
| `questionId` | number | No (defaults to 1) |

**Response:**

```json
{
  "submission": { "id": "...", "challengeId": "...", "userId": "...", "responseId": "12345" },
  "responseId": "12345",
  "xpEarned": 50,
  "coinsEarned": 5
}
```

Returns `400` if already submitted or challenge expired.

#### `GET /api/challenges/history?page=1&limit=20`

User's past challenge submissions (paginated).

**Response:**

```json
{
  "data": [
    {
      "id": "...",
      "challengeId": "...",
      "responseId": "12345",
      "submittedAt": "...",
      "challenge": {
        "id": "...",
        "title": "Morning Routine",
        "type": "daily",
        "difficulty": "beginner",
        "xpReward": 50
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 15, "totalPages": 1 }
}
```

### Admin Endpoints (teacher/admin only)

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/challenges/admin/create` | `{ title, promptText, startsAt, endsAt, description?, type?, difficulty?, xpReward?, coinReward? }` |
| `PUT` | `/api/challenges/admin/:id` | Same fields, all optional |
| `DELETE` | `/api/challenges/admin/:id` | — |

---

## 4. Duolingo-style Courses

Structured courses with a hierarchy: **Course → Unit → Lesson → Exercise**.

### Exercise Types

| Type | Description |
|------|-------------|
| `listenRepeat` | Listen to audio, repeat it |
| `speakTheAnswer` | Answer a question by speaking |
| `fillInBlank` | Fill in the missing word |
| `multipleChoice` | Choose the correct option |
| `reorderWords` | Drag words into correct order |
| `matchPairs` | Match words/phrases together |
| `translate` | Translate a sentence |

### Endpoints

#### `GET /api/courses?level=B1`

List published courses with user's progress.

**Query params:** `level` — `A2`, `B1`, `B2`, `C1` (optional)

**Response:**

```json
{
  "data": [
    {
      "id": "...",
      "title": "Everyday Conversations",
      "description": "Learn to speak in daily situations",
      "level": "B1",
      "imageUrl": "https://...",
      "isPublished": true,
      "order": 1,
      "totalLessons": 24,
      "completedLessons": 8,
      "progressPercent": 33,
      "units": [
        {
          "id": "...",
          "title": "Unit 1: Greetings",
          "order": 1,
          "_count": { "lessons": 6 }
        }
      ]
    }
  ]
}
```

#### `GET /api/courses/:id`

Course detail with units, lessons, and per-lesson completion status.

**Response:**

```json
{
  "id": "...",
  "title": "Everyday Conversations",
  "description": "...",
  "level": "B1",
  "imageUrl": "...",
  "units": [
    {
      "id": "...",
      "title": "Unit 1: Greetings",
      "order": 1,
      "lessons": [
        {
          "id": "...",
          "title": "Introducing Yourself",
          "order": 1,
          "xpReward": 10,
          "completed": true,
          "score": 85,
          "xpEarned": 10
        },
        {
          "id": "...",
          "title": "Asking for Directions",
          "order": 2,
          "xpReward": 10,
          "completed": false,
          "score": null,
          "xpEarned": 0
        }
      ]
    }
  ]
}
```

#### `GET /api/courses/lessons/:lessonId`

Lesson detail with all exercises.

**Response:**

```json
{
  "id": "...",
  "title": "Introducing Yourself",
  "unitId": "...",
  "order": 1,
  "xpReward": 10,
  "unit": {
    "id": "...",
    "title": "Unit 1: Greetings",
    "course": { "id": "...", "title": "Everyday Conversations", "level": "B1" }
  },
  "exercises": [
    {
      "id": "...",
      "type": "listenRepeat",
      "order": 1,
      "prompt": "Listen and repeat: 'Hi, my name is Sara. Nice to meet you.'",
      "correctAnswer": "Hi, my name is Sara. Nice to meet you.",
      "options": null,
      "audioUrl": "https://...",
      "imageUrl": null,
      "hints": ["Focus on the 'nice to meet you' pronunciation"]
    },
    {
      "id": "...",
      "type": "multipleChoice",
      "order": 2,
      "prompt": "Which phrase is used to introduce yourself?",
      "correctAnswer": "My name is...",
      "options": ["My name is...", "I am go...", "He is called..."],
      "audioUrl": null,
      "imageUrl": null,
      "hints": null
    }
  ]
}
```

#### `POST /api/courses/lessons/:lessonId/complete`

Mark a lesson as completed after user finishes all exercises.

**Body:** `{ "score": 85 }` (0–100, optional)

**Response:**

```json
{
  "progress": {
    "id": "...",
    "userId": "...",
    "lessonId": "...",
    "completed": true,
    "score": 85,
    "xpEarned": 10,
    "completedAt": "..."
  },
  "xpEarned": 10
}
```

Returns `{ "message": "Already completed", "xpEarned": 0 }` if re-completed.

### Admin Endpoints (admin only)

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/courses/admin/create` | `{ title, description, level, imageUrl?, order? }` |
| `PUT` | `/api/courses/admin/:id` | `{ title?, description?, level?, imageUrl?, isPublished?, order? }` |
| `DELETE` | `/api/courses/admin/:id` | — |
| `POST` | `/api/courses/admin/units` | `{ courseId, title, order? }` |
| `PUT` | `/api/courses/admin/units/:id` | `{ title?, order? }` |
| `DELETE` | `/api/courses/admin/units/:id` | — |
| `POST` | `/api/courses/admin/lessons` | `{ unitId, title, order?, xpReward? }` |
| `PUT` | `/api/courses/admin/lessons/:id` | `{ title?, order?, xpReward? }` |
| `DELETE` | `/api/courses/admin/lessons/:id` | — |
| `POST` | `/api/courses/admin/exercises` | `{ lessonId, type, prompt, order?, correctAnswer?, options?, audioUrl?, imageUrl?, hints? }` |
| `PUT` | `/api/courses/admin/exercises/:id` | Same fields, all optional |
| `DELETE` | `/api/courses/admin/exercises/:id` | — |

---

## 5. Low-Pressure Practice Mode

A privacy-focused mode for shy users who want AI feedback without community exposure.

### What changed

#### Visibility

The `visibility` field on `TestSession` now accepts a fourth value:

```
"private" | "group" | "community" | "ai_only"
```

- **`ai_only`** — Only the student sees the session. AI feedback is generated, but the session never appears in community feeds, group submissions, or pending reviews. No humans review it.

#### Anonymous Sessions

Sessions can now be created with `isAnonymous: true`:

```json
POST /api/speaking
{
  "testId": 1,
  "visibility": "community",
  "isAnonymous": true
}
```

When `isAnonymous` is `true`, the session appears in the community feed but the user info is masked:

```json
{
  "user": {
    "fullName": "Anonymous Speaker",
    "username": "anonymous",
    "avatarUrl": null
  }
}
```

#### Practice Room Groups

Groups now have an `isPracticeRoom` boolean (default `false`). Practice room groups are low-stakes environments where:
- All submissions are automatically anonymous
- AI feedback is the primary review mechanism
- Useful for class exercises where students shouldn't compare

---

## 6. Social Reputation System

A trust/contribution system that rewards helpful community members.

### How points are earned

| Action | Effect |
|--------|--------|
| Give a review | `reviewsGiven` +1 |
| Receive a helpful vote | `helpfulVotes` +1 |
| Submit a recording with good AI score | `clarityScore` updated (running avg) |

### Mentor levels auto-computed

| Level | Label | Requirements |
|-------|-------|--------------|
| 0 | — | Default |
| 1 | Helper | 10+ reviews, 5+ helpful votes |
| 2 | Mentor | 25+ reviews, 20+ helpful votes, 70+ clarity |
| 3 | Expert | 50+ reviews, 50+ helpful votes, 80+ clarity |

### Badges auto-computed

| Badge Key | Requirement |
|-----------|-------------|
| `helpful_10` | 10+ helpful votes |
| `helpful_50` | 50+ helpful votes |
| `reviewer_10` | 10+ reviews given |
| `reviewer_25` | 25+ reviews given |
| `reviewer_50` | 50+ reviews given |
| `clear_speaker` | 80+ clarity score |

### Endpoint

`GET /api/progress/reputation?userId=optional` — See [Gamification section](#get-apiprogressreputationuseridoptional).

---

## 7. Dual Exam Scoring (CEFR + IELTS)

Sessions now support both CEFR (0–75) and IELTS (0–9) scoring. The exam type is set when the session is created and determines the score range for reviews.

### How it works

1. User creates a speaking session with `examType: 'cefr'` (default) or `examType: 'ielts'`
2. Reviewers score using the appropriate scale based on the session's exam type
3. Level labels are derived from the score automatically

### Score Ranges & Level Mapping

| Level | CEFR Score (0–75) | IELTS Band (0–9) |
|-------|-------------------|-------------------|
| A2    | 0 – 37            | 0 – 3.5           |
| B1    | 38 – 50           | 4.0 – 4.5         |
| B2    | 51 – 64           | 5.0 – 6.0         |
| C1    | 65 – 75           | 6.5 – 7.5         |
| C2    | —                 | 8.0 – 9.0         |

> IELTS scores use **0.5 steps** (e.g. 5.5, 6.0, 6.5, 7.0).

### API Changes

#### Test creation — `POST /api/tests`

New optional body field:

```json
{ "title": "IELTS Speaking Part 1", "description": "...", "testType": "ielts" }
```

`testType` defaults to `"cefr"` if omitted. Valid values: `"cefr"` | `"ielts"`. Can also be updated via `PUT /api/tests/:id`.

#### Session creation — `POST /api/speaking/submit`

The session's `examType` is now **automatically inherited** from `test.testType`. No need to pass `examType` in the request body.

```json
{
  "testId": 1,
  "visibility": "group"
}
```

> If `testId` points to an IELTS test, the session is automatically created with `examType: 'ielts'`.

#### Review submission — `POST /api/reviews/:sessionId`

The score is validated based on the session's exam type:

- **CEFR session:** `score` must be an integer 0–75
- **IELTS session:** `score` must be 0–9 in 0.5 steps (e.g. `5.5`, `6.0`, `7.5`)

```json
// CEFR review
{ "score": 62, "feedback": "Good fluency" }

// IELTS review
{ "score": 6.5, "feedback": "Good fluency" }
```

#### Response changes

All session responses now include `examType`. Level labels adapt automatically:

```json
// CEFR session
{ "scoreAvg": 58, "examType": "cefr", "cefrLevel": "B2" }

// IELTS session
{ "scoreAvg": 6.5, "examType": "ielts", "cefrLevel": "C1" }
```

Affected endpoints:
- `GET /api/speaking/sessions/:id` — session detail + reviews include level labels
- `GET /api/reviews/:sessionId` — each review includes `cefrLevel` per exam type
- `GET /api/reviews/my-groups` — includes `examType` in session select
- `GET /api/community/feed` — feed items include `cefrLevel` per exam type
- `GET /api/groups/:id/sessions` — group sessions include `cefrLevel` per exam type

### Database Changes

```sql
-- New enum
CREATE TYPE "exam_type" AS ENUM ('cefr', 'ielts');

-- tests: new column (defaults to cefr for existing tests)
ALTER TABLE "tests" ADD COLUMN "test_type" "exam_type" NOT NULL DEFAULT 'cefr';

-- test_sessions: new column (defaults to cefr for existing data)
ALTER TABLE "test_sessions" ADD COLUMN "exam_type" "exam_type" NOT NULL DEFAULT 'cefr';

-- reviews: score changed from INT to FLOAT (for IELTS 0.5 bands)
ALTER TABLE "reviews" ALTER COLUMN "score" TYPE DOUBLE PRECISION;
```

### Expo App Changes

**Session creation screen:** Add an exam type picker before starting:

```
┌─────────────────────────────────────┐
│  Choose Exam Type                   │
│                                     │
│  ┌─────────────┐ ┌──────────────┐  │
│  │   📘 CEFR   │ │  📗 IELTS    │  │
│  │   0 – 75    │ │   0 – 9      │  │
│  │  ✓ Selected │ │              │  │
│  └─────────────┘ └──────────────┘  │
│                                     │
│  [ Start Speaking ]                 │
└─────────────────────────────────────┘
```

**Review screen:** Adapt the slider based on `session.examType`:

```
// CEFR mode                     // IELTS mode
┌──────────────────┐             ┌──────────────────┐
│ Score: 62 / 75   │             │ Band: 6.5 / 9    │
│ ████████████░░░  │             │ ████████████░░░  │
│ Level: B2        │             │ Level: C1        │
└──────────────────┘             └──────────────────┘
```

**TypeScript type:**

```ts
type ExamType = 'cefr' | 'ielts';

interface Session {
  // ...existing fields
  examType: ExamType;
  cefrLevel: string | null; // "A2" | "B1" | "B2" | "C1" | "C2"
}

// Score validation helper
function isValidScore(score: number, examType: ExamType): boolean {
  if (examType === 'ielts') {
    return score >= 0 && score <= 9 && (score * 2) % 1 === 0;
  }
  return Number.isInteger(score) && score >= 0 && score <= 75;
}
```

---

## TypeScript Types

Add these to your Expo app's type definitions:

```typescript
// ─── AI Feedback ────────────────────────────────────────────────

interface AIFeedback {
  id: string;
  responseId: string;
  transcript: string;
  grammarScore: number;       // 0–100
  fluencyWPM: number;         // words per minute
  fluencyScore: number;       // 0–100
  vocabDiversity: number;     // 0–100
  pronScore: number;          // 0–100
  overallScore: number;       // 0–100
  grammarIssues: GrammarIssue[];
  vocabSuggestions: VocabSuggestion[];
  pronIssues: PronIssue[];
  naturalness: string;
  fillerWords: Record<string, number>;
  pauseCount: number;
  aiSummary: string;
  createdAt: string;
}

interface GrammarIssue {
  original: string;
  corrected: string;
  explanation: string;
}

interface VocabSuggestion {
  word: string;
  alternatives: string[];
  context: string;
}

interface PronIssue {
  word: string;
  issue: string;
  tip: string;
}

interface SessionFeedbackAggregate {
  averageOverallScore: number | null;
  averageFluencyWPM: number | null;
  totalResponses: number;
}

// ─── Gamification ───────────────────────────────────────────────

interface UserProgress {
  id: string;
  userId: string;
  xp: number;
  level: number;
  coins: number;
  currentStreak: number;
  longestStreak: number;
  streakFreezes: number;
  weeklyXP: number;
  lastActiveDate: string | null;
  fluencyWPMAvg: number;
  vocabDiversityAvg: number;
  pronScoreAvg: number;
  // Computed by /me endpoint:
  xpInCurrentLevel: number;
  xpForNextLevel: number;
  xpPercent: number;
}

interface Achievement {
  id: string;
  key: string;
  title: string;
  description: string;
  category: 'speaking' | 'social' | 'streak' | 'mastery';
  xpReward: number;
  coinReward: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

interface LeaderboardEntry {
  userId: string;
  weeklyXP?: number;
  xp?: number;
  currentStreak?: number;
  level: number;
  user: { id: string; fullName: string; username: string; avatarUrl: string | null };
}

interface WeeklySummary {
  weeklyXP: number;
  weeklyRecordings: number;
  currentStreak: number;
  level: number;
  improvements: {
    fluency: number;   // delta, can be negative
    grammar: number;
    vocabulary: number;
  };
  averages: {
    fluencyWPM: number;
    vocabDiversity: number;
    pronScore: number;
  };
  totalFeedbacks: number;
}

// ─── Challenges ─────────────────────────────────────────────────

interface Challenge {
  id: string;
  title: string;
  description: string | null;
  type: 'daily' | 'weekly' | 'special';
  difficulty: string;
  promptText: string;
  promptImage: string | null;
  startsAt: string;
  endsAt: string;
  xpReward: number;
  coinReward: number;
  isActive: boolean;
  submitted: boolean;
  participantCount: number;
}

interface ChallengeSubmission {
  id: string;
  challengeId: string;
  userId: string;
  responseId: string;
  submittedAt: string;
  challenge?: Challenge;
  user?: { id: string; fullName: string; username: string; avatarUrl: string | null };
}

// ─── Courses ────────────────────────────────────────────────────

interface Course {
  id: string;
  title: string;
  description: string;
  level: string;            // A2, B1, B2, C1
  imageUrl: string | null;
  isPublished: boolean;
  order: number;
  totalLessons: number;
  completedLessons: number;
  progressPercent: number;
  units: CourseUnit[];
}

interface CourseUnit {
  id: string;
  courseId: string;
  title: string;
  order: number;
  lessons: Lesson[];
  _count?: { lessons: number };
}

interface Lesson {
  id: string;
  unitId: string;
  title: string;
  order: number;
  xpReward: number;
  completed: boolean;
  score: number | null;
  xpEarned: number;
}

interface Exercise {
  id: string;
  lessonId: string;
  type: 'listenRepeat' | 'speakTheAnswer' | 'fillInBlank' | 'multipleChoice' | 'reorderWords' | 'matchPairs' | 'translate';
  order: number;
  prompt: string;
  correctAnswer: string | null;
  options: string[] | null;       // JSON array for multipleChoice
  audioUrl: string | null;
  imageUrl: string | null;
  hints: string[] | null;         // JSON array of hint strings
}

// ─── Reputation ─────────────────────────────────────────────────

interface UserReputation {
  id: string;
  userId: string;
  helpfulVotes: number;
  reviewsGiven: number;
  clarityScore: number;
  mentorLevel: 0 | 1 | 2 | 3;
  mentorLabel: '' | 'Helper' | 'Mentor' | 'Expert';
  badges: string[];
  user: { id: string; fullName: string; username: string; avatarUrl: string | null };
}

// ─── Updated existing types ─────────────────────────────────────

// TestSession now includes:
interface TestSession {
  // ...existing fields...
  visibility: 'private' | 'group' | 'community' | 'ai_only';
  isAnonymous: boolean;  // NEW
}
```

---

## Migration & Environment Setup

### 1. Environment Variables

Add to your `.env`:

```env
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
```

Both are required for AI feedback to work. Without them, audio processing still works but AI feedback is skipped.

### 2. Database Migration

```bash
npx prisma migrate deploy
```

This adds 12 new tables and modifies existing ones:

**New tables:** `ai_feedbacks`, `user_progress`, `achievements`, `user_achievements`, `challenges`, `challenge_submissions`, `courses`, `course_units`, `lessons`, `exercises`, `user_lesson_progress`, `user_reputations`

**Modified tables:**
- `tests` — added `test_type` (default `'cefr'`)
- `test_sessions` — added `is_anonymous` (default `false`), `exam_type` (default `'cefr'`, inherited from test)
- `groups` — added `is_practice_room` (default `false`), `max_level`
- `Visibility` enum — added `ai_only`
- `ExamType` enum — new (`cefr`, `ielts`)
- `reviews.score` — changed from `INT` to `DOUBLE PRECISION` (for IELTS 0.5 bands)

### 3. Achievement Seeding

Achievements are automatically seeded on server startup. No manual action needed.

### 4. Cron Jobs

The server automatically starts these cron jobs:

| Schedule | Job | Description |
|----------|-----|-------------|
| Sunday 00:00 UTC | Weekly XP reset | Resets `weeklyXP` to 0 for all users |
| Daily 01:00 UTC | Streak check | Breaks streaks for inactive users (or uses freeze) |
| Daily 00:00 UTC | Daily challenge | Auto-creates from 31-prompt pool |
| Monday 00:00 UTC | Weekly challenge | Auto-creates from 8-prompt pool |

---

## UI/UX Design Guide

### General Principles

- **Duolingo-inspired** progression feel with friendly animations
- **Bottom-up feedback** — every recording should show actionable AI feedback
- **Encourage, don't punish** — streaks, XP, and levels should feel rewarding, not stressful
- **Progressive disclosure** — show advanced features (courses, challenges) as users level up

---

### Screen: Home Dashboard (updated)

Replace the current home screen with a gamified dashboard:

```
┌─────────────────────────────────────┐
│ 🔥 12-day streak     Level 5  ⭐    │
│ ████████░░░░ 250/500 XP            │
│ 🪙 120 coins                        │
├─────────────────────────────────────┤
│ ┌───────────┐  ┌───────────────┐   │
│ │ 📋 Daily  │  │ 📚 Continue   │   │
│ │ Challenge │  │ Course: B1    │   │
│ │ "Morning  │  │ Unit 2 • 33%  │   │
│ │ Routine"  │  │               │   │
│ └───────────┘  └───────────────┘   │
├─────────────────────────────────────┤
│ This Week                           │
│ Grammar ▲ +5   Fluency ▲ +3       │
│ Vocab   ▲ +8   8 recordings       │
├─────────────────────────────────────┤
│ 🏆 Leaderboard                      │
│ 1. Sara K.    450 XP               │
│ 2. John M.    380 XP               │
│ 3. You        350 XP  ← highlight  │
└─────────────────────────────────────┘
```

**Implementation notes:**
- Fetch `GET /api/progress/me` for top bar (streak, level, XP, coins)
- Fetch `GET /api/progress/weekly-summary` for "This Week" section
- Fetch `GET /api/challenges?type=daily` for daily challenge card
- Fetch `GET /api/courses` for course progress card (show most recent / in-progress)
- Fetch `GET /api/progress/leaderboard?type=weekly&limit=5` for mini-leaderboard
- Use Expo `Animated` for the XP progress bar — animate on value change
- Streak fire icon should pulse when streak is active

---

### Screen: AI Feedback Results

Show after a recording is processed (push notification or poll endpoint):

```
┌─────────────────────────────────────┐
│  Overall Score                      │
│       ┌─────┐                       │
│       │ 80  │  Great job!           │
│       └─────┘                       │
│                                     │
│ ┌────────┬────────┬────────┬──────┐ │
│ │Grammar │Fluency │Vocab   │Pron  │ │
│ │  78    │  82    │  71    │  88  │ │
│ │ ██████ │ ██████ │ █████  │█████ │ │
│ └────────┴────────┴────────┴──────┘ │
│                                     │
│ 📝 Transcript                       │
│ "I usually wake up at seven..."     │
│                                     │
│ ⚠️ Grammar Issues                   │
│ ┌─────────────────────────────────┐ │
│ │ "I go to work by walk"         │ │
│ │ → "I walk to work"             │ │
│ │ Use the verb form, not 'by...' │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 💡 Vocabulary Tips                  │
│ Instead of "good" try:             │
│ excellent • wonderful • pleasant    │
│                                     │
│ 🗣️ Pronunciation                    │
│ "usually" — 68% confidence         │
│ Try emphasizing each syllable       │
│                                     │
│ 🎯 Filler Words: um(3) like(2)     │
│ ⏸️ Long Pauses: 2                   │
│                                     │
│ 💬 "Good overall performance!..."   │
│                                     │
│ +20 XP earned  +30 bonus (score>60) │
└─────────────────────────────────────┘
```

**Implementation notes:**
- Fetch `GET /api/ai-feedback/:responseId` after audio processing completes
- Use circular progress indicators for the 4 score categories
- Color code scores: green (80+), yellow (60-79), orange (40-59), red (<40)
- Grammar issues should be expandable cards with red→green diff highlighting
- Filler words → show as small pills/badges with counts
- Animate XP reward popup at the bottom with confetti if score > 80
- If feedback returns 404, show "Processing..." skeleton with a retry button

---

### Screen: Challenges Tab

Add a new bottom tab or section in the existing "Practice" tab:

```
┌─────────────────────────────────────┐
│ ⚡ Challenges                        │
│ ┌─────────┐ ┌─────────┐            │
│ │ Daily   │ │ Weekly  │ │ History │ │
│ └─────────┘ └─────────┘            │
├─────────────────────────────────────┤
│ 📋 Today's Challenge                │
│ "Morning Routine"                   │
│ Beginner • 42 participants          │
│ Ends in 14h 23m                     │
│                                     │
│ "Describe your morning routine in   │
│ 30 seconds. What do you do first?   │
│ What do you eat for breakfast?"     │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │        🎤 Record Now            │ │
│ │        +50 XP • +5 coins       │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ✅ You submitted! View your AI      │
│    feedback →                       │
├─────────────────────────────────────┤
│ 📋 This Week's Challenge            │
│ "Online vs Offline Learning"        │
│ Advanced • Ends in 5 days           │
│ +200 XP • +50 coins                │
│                                     │
│ 🎤 Record Now                       │
└─────────────────────────────────────┘
```

**Implementation notes:**
- Fetch `GET /api/challenges` to list active daily + weekly
- `submitted` boolean controls whether to show "Record Now" or "View Feedback"
- Show countdown timer using `endsAt` field — use `setInterval` or a library like `react-native-countdown`
- Record button triggers the same audio recording flow as speaking submissions, but `POST /api/challenges/:id/submit` instead
- Show XP/coin animation on successful submission
- History tab: paginated list from `GET /api/challenges/history`

---

### Screen: Courses

A Duolingo-like course browser and lesson player:

```
┌─────────────────────────────────────┐
│ 📚 Courses                          │
│ ┌────────┐ ┌────────┐ ┌────────┐  │
│ │  A2   │ │  B1   │ │  B2   │   │
│ └────────┘ └────────┘ └────────┘  │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ 🗣️ Everyday Conversations       │ │
│ │ B1 • 8/24 lessons              │ │
│ │ ████████░░░░ 33%               │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ 💼 Business English             │ │
│ │ B2 • 0/18 lessons              │ │
│ │ ░░░░░░░░░░░░ 0%               │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘

Course Detail → Unit List:
┌─────────────────────────────────────┐
│ ← Everyday Conversations    B1     │
├─────────────────────────────────────┤
│ Unit 1: Greetings                   │
│  ✅ Introducing Yourself   +10 XP  │
│  ✅ Asking for Directions  +10 XP  │
│  🔓 Making Small Talk              │
│  🔒 At the Restaurant              │
│  🔒 Shopping                       │
│  🔒 Phone Calls                    │
│                                     │
│ Unit 2: Daily Life                  │
│  🔓 Morning Routine                │
│  🔒 At Work                        │
│  🔒 ...                            │
└─────────────────────────────────────┘

Lesson Player:
┌─────────────────────────────────────┐
│ ← Lesson 3/6       ████░░ 2/5     │
├─────────────────────────────────────┤
│                                     │
│ 🔊 Listen and Repeat               │
│                                     │
│ "Hi, my name is Sara.              │
│  Nice to meet you."                │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │       ▶️ Play Audio              │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │       🎤 Record Your Voice      │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 💡 Hint: Focus on "nice to meet"   │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │           Next →                │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

**Implementation notes:**
- Level filter tabs at top (A2/B1/B2/C1) — pass as `?level=` query param
- Course card shows progress bar using `progressPercent`
- Course detail: lessons are sequential. Lock lessons that come after the first incomplete one (client-side logic — server allows any order)
- Lesson player: cycle through exercises one by one, track correct answers
- On lesson complete: `POST /api/courses/lessons/:lessonId/complete` with computed score
- Exercise type determines the UI component:
  - `listenRepeat` → play audio + record button
  - `speakTheAnswer` → show prompt + record button
  - `fillInBlank` → text input with blanks
  - `multipleChoice` → radio buttons from `options` array
  - `reorderWords` → draggable word tiles
  - `matchPairs` → two-column matching
  - `translate` → text input
- Animate XP reward and progress bar after lesson completion

---

### Screen: Practice Mode (ai_only)

Add a "Practice Solo" option alongside existing speaking flow:

```
┌─────────────────────────────────────┐
│ How do you want to practice?        │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 👥 Community                    │ │
│ │ Share with everyone, get        │ │
│ │ human + AI reviews              │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 👤 Group Only                   │ │
│ │ Share with your group members   │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 🤖 AI Only (Practice Mode)     │ │  ← NEW
│ │ Private. Only you see it.       │ │
│ │ Get instant AI feedback.        │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ 🔒 Private                     │ │
│ │ No reviews, just practice      │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ☐ Post anonymously                 │  ← NEW (if community/group)
└─────────────────────────────────────┘
```

**Implementation notes:**
- Map selection to `visibility` field: `community`, `group`, `ai_only`, `private`
- Show "Post anonymously" checkbox only when `visibility` is `community` or `group` — maps to `isAnonymous: true`
- When `ai_only` is selected, skip the "waiting for review" state and go straight to AI feedback polling
- AI feedback typically arrives within 5–15 seconds after recording submission

---

### Screen: Profile / Reputation

Add reputation section to user profile:

```
┌─────────────────────────────────────┐
│     ┌─────┐                         │
│     │ 📷  │  Sara K.                │
│     └─────┘  @sara_k               │
│              🏅 Mentor               │ ← mentor label badge
│              Level 7 • 🔥 18 days    │
├─────────────────────────────────────┤
│ Reputation                          │
│ ┌────────┬────────┬────────┐       │
│ │ 👍 42  │ ✍️ 28  │ 🗣️ 85  │       │
│ │ Votes  │Reviews │Clarity │       │
│ └────────┴────────┴────────┘       │
│                                     │
│ 🏆 Badges                           │
│ [helpful_10] [reviewer_25]         │
│ [clear_speaker]                     │
├─────────────────────────────────────┤
│ 🏅 Achievements  (8/14)            │
│ ✅ First Steps                      │
│ ✅ Getting Started                  │
│ ✅ Week Warrior                     │
│ ✅ Helpful Reviewer                 │
│ ✅ Rising Star                      │
│ 🔒 Speaking Master (need 100 rec.) │
│ 🔒 Streak Master (need 30-day)     │
│ ...                                 │
└─────────────────────────────────────┘
```

**Implementation notes:**
- Fetch `GET /api/progress/reputation` for the reputation section
- Fetch `GET /api/progress/achievements` for the achievements list
- Show mentor badge next to username everywhere (profile, feed, leaderboard)
- Achievements: show locked ones grayed out with progress hint
- Badges: use custom icons/emojis for each badge key
- Tapping an achievement could show a detail modal with the requirement

---

### Component: XP Toast / Animation

Show a floating XP toast whenever the user earns XP:

```
┌─────────────────────────────┐
│  +20 XP  🎉  Level Up! → 6 │
└─────────────────────────────┘
```

**Implementation notes:**
- Use `react-native-reanimated` for slide-up + fade animation
- Show after: recording submission, review, challenge completion, lesson completion
- If level changed, show a special "Level Up!" celebration with `confetti-cannon`
- Achievement unlock: show a full-screen modal with the achievement icon + title + description
- Store last known XP in local state, compare with API response to detect changes

---

### Component: Streak Banner

Show on home screen and as a persistent reminder:

```
Daily active:     🔥 12-day streak!
About to expire:  🔥 12 days — Don't break it! Practice now
Broken:           💔 Streak lost. Start a new one today!
Has freeze:       🧊 1 streak freeze active
```

**Implementation notes:**
- Compare `lastActiveDate` with today's date to determine state
- If streak is at risk (no activity today and it's after 6 PM local time), show amber warning
- "Buy Streak Freeze" button → `POST /api/progress/buy-streak-freeze`
- Store streak state in AsyncStorage for instant display before API responds

---

### Navigation Updates

**Bottom tabs (suggested):**

| Tab | Icon | Primary Screen |
|-----|------|---------------|
| Home | 🏠 | Dashboard (XP, streak, weekly summary, mini-leaderboard) |
| Practice | 🎤 | Speaking flow (existing + ai_only mode) |
| Challenges | ⚡ | Daily/weekly challenges |
| Courses | 📚 | Course browser and lesson player |
| Profile | 👤 | Profile + achievements + reputation |

Or keep existing 4-tab layout and add Challenges and Courses inside a "Learn" tab with a segmented control.

---

### Color Palette Suggestions

| Element | Color | Usage |
|---------|-------|-------|
| XP / Level | `#FFB800` (gold) | XP text, level badges, progress bars |
| Streak fire | `#FF6B35` (orange) | Streak counter, fire icon |
| Coins | `#F5C542` (light gold) | Coin counter and rewards |
| Score green | `#4CAF50` | Scores 80+ |
| Score yellow | `#FFC107` | Scores 60–79 |
| Score orange | `#FF9800` | Scores 40–59 |
| Score red | `#F44336` | Scores <40 |
| Achievement unlocked | `#7C4DFF` (purple) | Achievement badges |
| Mentor badge | `#00BCD4` (teal) | Mentor/reputation badges |
| AI feedback | `#2196F3` (blue) | AI-related UI elements |
| Practice mode | `#9E9E9E` (grey) | Anonymous/private indicators |

---

### Recommended Expo Packages

| Package | Purpose |
|---------|---------|
| `react-native-reanimated` | XP animations, progress bar transitions |
| `react-native-gesture-handler` | Word reorder exercises, drag interactions |
| `react-native-confetti-cannon` | Level up celebrations |
| `react-native-circular-progress` | Score wheels on AI feedback screen |
| `react-native-countdown-component` | Challenge countdown timers |
| `expo-av` | Audio playback for listenRepeat exercises |
| `expo-haptics` | Haptic feedback on XP gain, achievement unlock |
| `@shopify/flash-list` | Efficient leaderboard and achievement lists |

---

### API Fetch Patterns

```typescript
// Example: React Query hooks for new endpoints

// Progress
const useProgress = () => useQuery(['progress'], () => api.get('/progress/me'));
const useAchievements = () => useQuery(['achievements'], () => api.get('/progress/achievements'));
const useLeaderboard = (type: string) => useQuery(['leaderboard', type], () => api.get(`/progress/leaderboard?type=${type}`));
const useWeeklySummary = () => useQuery(['weekly-summary'], () => api.get('/progress/weekly-summary'));
const useReputation = (userId?: string) => useQuery(['reputation', userId], () => api.get(`/progress/reputation${userId ? `?userId=${userId}` : ''}`));

// AI Feedback
const useAIFeedback = (responseId: string) => useQuery(
  ['ai-feedback', responseId],
  () => api.get(`/ai-feedback/${responseId}`),
  { retry: 3, retryDelay: 5000 } // Retry while processing
);
const useSessionFeedback = (sessionId: string) => useQuery(['session-feedback', sessionId], () => api.get(`/ai-feedback/session/${sessionId}`));

// Challenges
const useChallenges = (type?: string) => useQuery(['challenges', type], () => api.get(`/challenges${type ? `?type=${type}` : ''}`));
const useChallenge = (id: string) => useQuery(['challenge', id], () => api.get(`/challenges/${id}`));
const useChallengeHistory = (page: number) => useQuery(['challenge-history', page], () => api.get(`/challenges/history?page=${page}`));

// Courses
const useCourses = (level?: string) => useQuery(['courses', level], () => api.get(`/courses${level ? `?level=${level}` : ''}`));
const useCourse = (id: string) => useQuery(['course', id], () => api.get(`/courses/${id}`));
const useLesson = (id: string) => useQuery(['lesson', id], () => api.get(`/courses/lessons/${id}`));

// Mutations
const useSubmitChallenge = () => useMutation((data: { challengeId: string; formData: FormData }) =>
  api.postForm(`/challenges/${data.challengeId}/submit`, data.formData)
);
const useCompleteLesson = () => useMutation((data: { lessonId: string; score?: number }) =>
  api.post(`/courses/lessons/${data.lessonId}/complete`, { score: data.score })
);
const useBuyStreakFreeze = () => useMutation(() => api.post('/progress/buy-streak-freeze'));
const useMarkHelpful = () => useMutation((responseId: string) => api.post(`/ai-feedback/${responseId}/helpful`));
```
