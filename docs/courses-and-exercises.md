# Courses, Lectures & Exercises — Complete Guide

> **API base:** `/api/courses`
> **Auth:** All endpoints require `Authorization: Bearer <token>`
> **Roles:** Lecture/Exercise creation requires `admin` role. Students access player and lecture viewer endpoints.

This document covers the full course system: data model, all API endpoints (lectures + exercises), payload examples, and UI/UX guidance.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Model](#2-data-model)
3. [Exercise Types Reference](#3-exercise-types-reference)
4. [API Endpoints — Browse & Progress](#4-api-endpoints--browse--progress)
5. [API Endpoints — Admin Builder](#5-api-endpoints--admin-builder)
6. [API Endpoints — Lecture Viewer (Student)](#6-api-endpoints--lecture-viewer-student)
7. [API Endpoints — Exercise Player](#7-api-endpoints--exercise-player)
8. [TypeScript Types](#8-typescript-types)
9. [Lecture Builder UI/UX (Admin)](#9-lecture-builder-uiux-admin)
10. [Lecture Viewer UI/UX (Student)](#10-lecture-viewer-uiux-student)
11. [Exercise Builder UI/UX (Teacher/Admin)](#11-exercise-builder-uiux-teacheradmin)
12. [Exercise Player UI/UX (Student)](#12-exercise-player-uiux-student)
13. [Course Map UI/UX](#13-course-map-uiux)
14. [Expo Implementation Notes](#14-expo-implementation-notes)

---

## 1. Architecture Overview

```
Course
 └── CourseUnit (ordered)
      └── Lesson (ordered, type: practice|lecture|mixed, xpReward)
           ├── Lecture (ordered, typed: text|audio|video)
           │    └── LectureAttachment[] — downloadable files (PDF, docs, etc.)
           └── Exercise (ordered, typed)
                ├── ExerciseOption[]        — for choice-based types
                ├── ExerciseMatchPair[]     — for match-pairs type
                ├── ExerciseWordBankItem[]  — for word-ordering types
                └── ExerciseConversationLine[] — for dialogue types
```

**Lesson types:**
- `practice` — exercises only (current default, backward-compatible)
- `lecture` — learning content only (text articles, audio, video + file attachments)
- `mixed` — lecture content followed by practice exercises

**Player flow:**

```
Lecture lesson:   Open → [Lecture 1] → [Lecture 2] → Mark Read (progress 100%)
Practice lesson:  Start Session → [Exercise 1] → Submit → ... → Complete Session
Mixed lesson:     [Lectures] → [Exercises] → Complete
```

---

## 2. Data Model

### Course → Unit → Lesson hierarchy

| Field | Type | Description |
|-------|------|-------------|
| `Course.level` | `string` | CEFR level: `A2`, `B1`, `B2`, `C1` |
| `Course.isPublished` | `boolean` | Only published courses visible to students |
| `Course.order` | `int` | Display order on course list |
| `CourseUnit.order` | `int` | Order within the course |
| `Lesson.type` | `LessonType` | `practice` (default), `lecture`, or `mixed` |
| `Lesson.order` | `int` | Order within the unit |
| `Lesson.xpReward` | `int` | XP earned on first completion (default 10) |

### Lecture fields

| Field | Type | Description |
|-------|------|-------------|
| `contentType` | `LectureContentType` | `text`, `audio`, `video`, or `mixed` |
| `title` | `string` | Lecture section title |
| `order` | `int` | Display sequence within the lesson |
| `textBody` | `string?` | Rich text / markdown content (for `text` type) |
| `mediaUrl` | `string?` | ⚠️ **Deprecated** — kept for backward compatibility. Use `audioUrl`/`videoUrl` instead |
| `audioUrl` | `string?` | Dedicated audio URL |
| `videoUrl` | `string?` | Dedicated video URL |
| `thumbnailUrl` | `string?` | Preview image for audio/video player |
| `durationSec` | `int?` | Duration in seconds for audio/video |

### Lecture child models

| Model | Fields | Description |
|-------|--------|-------------|
| `LectureAttachment` | `url`, `fileName`, `fileSize`, `mimeType`, `order` | Downloadable files (PDF, docs, slides, etc.) |
| `UserLectureProgress` | `completed`, `progressPct`, `completedAt` | Per-user read/watch progress (0-100%) |

### Exercise fields

| Field | Type | Used by | Description |
|-------|------|---------|-------------|
| `type` | `ExerciseType` | All | Determines which UI template to render |
| `order` | `int` | All | Display sequence within the lesson |
| `prompt` | `string` | All | Instruction text shown to the user |
| `promptAudio` | `string?` | listenAndChoose, tapWhatYouHear | Audio for the prompt itself |
| `correctAnswer` | `string?` | fillInBlank, speakTheAnswer, translateSentence | Plain-text correct answer for validation |
| `sentenceTemplate` | `string?` | fillInBlank | e.g. `"I ___ to school yesterday"` — blank marked with `___` |
| `targetText` | `string?` | listenRepeat, pronunciation | The exact text the user should say |
| `audioUrl` | `string?` | listenRepeat, listenAndChoose, tapWhatYouHear, pronunciation | Reference audio clip |
| `imageUrl` | `string?` | multipleChoice, fillInBlank | Context illustration |
| `hints` | `json?` | All | `["First hint", "Second hint"]` — progressive hints |
| `explanation` | `string?` | All | Shown after answering (why correct/wrong) |
| `difficulty` | `int` | All | `1` = easy, `2` = medium, `3` = hard |
| `xpReward` | `int` | All | XP per correct answer (default 10) |

### Child models

| Model | Fields | Used by |
|-------|--------|---------|
| `ExerciseOption` | `text`, `audioUrl?`, `imageUrl?`, `isCorrect`, `order` | multipleChoice, listenAndChoose, tapWhatYouHear, fillInBlank (dropdown) |
| `ExerciseMatchPair` | `leftText`, `leftAudio?`, `rightText`, `rightAudio?`, `order` | matchPairs |
| `ExerciseWordBankItem` | `text`, `correctPosition`, `isDistractor` | reorderWords, translateSentence |
| `ExerciseConversationLine` | `speaker`, `text`, `audioUrl?`, `isUserTurn`, `acceptedAnswers?`, `order` | completeConversation, roleplay |

### Player models

| Model | Key Fields | Description |
|-------|-----------|-------------|
| `ExerciseSession` | `hearts(5)`, `combo`, `maxCombo`, `totalXp`, `correctCount`, `wrongCount`, `completed` | One play-through of a lesson |
| `ExerciseAttempt` | `userAnswer(json)`, `isCorrect`, `xpEarned`, `timeTakenMs` | One answer per exercise |

---

## 3. Exercise Types Reference

### 3.1 `multipleChoice`
> Pick the correct answer from 3–4 options.

```json
{
  "type": "multipleChoice",
  "prompt": "What does 'ubiquitous' mean?",
  "imageUrl": null,
  "explanation": "'Ubiquitous' means present everywhere.",
  "options": [
    { "text": "Rare and unique", "isCorrect": false, "order": 0 },
    { "text": "Present everywhere", "isCorrect": true, "order": 1 },
    { "text": "Very expensive", "isCorrect": false, "order": 2 },
    { "text": "Extremely fast", "isCorrect": false, "order": 3 }
  ]
}
```

### 3.2 `listenAndChoose`
> Listen to audio, then pick the correct option.

```json
{
  "type": "listenAndChoose",
  "prompt": "Listen and choose what the speaker is describing.",
  "audioUrl": "https://cdn.example.com/audio/city-description.mp3",
  "options": [
    { "text": "A beach", "imageUrl": "beach.jpg", "isCorrect": false, "order": 0 },
    { "text": "A city", "imageUrl": "city.jpg", "isCorrect": true, "order": 1 },
    { "text": "A forest", "imageUrl": "forest.jpg", "isCorrect": false, "order": 2 }
  ]
}
```

### 3.3 `tapWhatYouHear`
> Listen to audio, then tap the correct transcription.

```json
{
  "type": "tapWhatYouHear",
  "prompt": "Tap what you hear.",
  "audioUrl": "https://cdn.example.com/audio/sentence-42.mp3",
  "options": [
    { "text": "She went to the store", "isCorrect": false, "order": 0 },
    { "text": "She wants to explore", "isCorrect": true, "order": 1 },
    { "text": "She was at the shore", "isCorrect": false, "order": 2 }
  ]
}
```

### 3.4 `fillInBlank`
> Complete the sentence by typing or selecting the missing word.

**Typing variant:**
```json
{
  "type": "fillInBlank",
  "prompt": "Complete the sentence.",
  "sentenceTemplate": "I ___ to school yesterday.",
  "correctAnswer": "went",
  "hints": ["Past tense of 'go'"],
  "explanation": "'Went' is the past tense of 'go'."
}
```

**Dropdown variant (with options):**
```json
{
  "type": "fillInBlank",
  "prompt": "Choose the correct word.",
  "sentenceTemplate": "She ___ very happy today.",
  "options": [
    { "text": "is", "isCorrect": true, "order": 0 },
    { "text": "are", "isCorrect": false, "order": 1 },
    { "text": "am", "isCorrect": false, "order": 2 }
  ]
}
```

### 3.5 `listenRepeat`
> Listen to audio, then record yourself repeating it.

```json
{
  "type": "listenRepeat",
  "prompt": "Listen and repeat the sentence.",
  "targetText": "The weather has been incredibly pleasant this week.",
  "audioUrl": "https://cdn.example.com/audio/weather-sentence.mp3",
  "difficulty": 2
}
```

### 3.6 `speakTheAnswer`
> Answer a question by speaking.

```json
{
  "type": "speakTheAnswer",
  "prompt": "What did you do last weekend? Answer in 2–3 sentences.",
  "correctAnswer": null,
  "imageUrl": "https://cdn.example.com/images/weekend.jpg",
  "hints": ["Talk about activities", "Use past tense"]
}
```

### 3.7 `pronunciation`
> Practice pronouncing a specific word or phrase.

```json
{
  "type": "pronunciation",
  "prompt": "Say this word clearly.",
  "targetText": "entrepreneur",
  "audioUrl": "https://cdn.example.com/audio/entrepreneur.mp3",
  "hints": ["on-truh-pruh-NUR"]
}
```

### 3.8 `matchPairs`
> Match items from two columns (e.g. word ↔ definition, English ↔ translation).

```json
{
  "type": "matchPairs",
  "prompt": "Match each word with its meaning.",
  "matchPairs": [
    { "leftText": "Eloquent", "rightText": "Fluent and persuasive", "order": 0 },
    { "leftText": "Benevolent", "rightText": "Kind and generous", "order": 1 },
    { "leftText": "Diligent", "rightText": "Hardworking", "order": 2 },
    { "leftText": "Resilient", "rightText": "Able to recover quickly", "order": 3 }
  ]
}
```

### 3.9 `reorderWords`
> Arrange scrambled word tiles into the correct sentence.

```json
{
  "type": "reorderWords",
  "prompt": "Put the words in the correct order.",
  "correctAnswer": "She has been studying English for three years",
  "wordBankItems": [
    { "text": "She", "correctPosition": 0, "isDistractor": false },
    { "text": "has", "correctPosition": 1, "isDistractor": false },
    { "text": "been", "correctPosition": 2, "isDistractor": false },
    { "text": "studying", "correctPosition": 3, "isDistractor": false },
    { "text": "English", "correctPosition": 4, "isDistractor": false },
    { "text": "for", "correctPosition": 5, "isDistractor": false },
    { "text": "three", "correctPosition": 6, "isDistractor": false },
    { "text": "years", "correctPosition": 7, "isDistractor": false },
    { "text": "since", "correctPosition": -1, "isDistractor": true }
  ]
}
```

### 3.10 `translateSentence`
> Translate a sentence using a word bank.

```json
{
  "type": "translateSentence",
  "prompt": "Translate to English: 'Men bugun maktabga bordim'",
  "correctAnswer": "I went to school today",
  "wordBankItems": [
    { "text": "I", "correctPosition": 0, "isDistractor": false },
    { "text": "went", "correctPosition": 1, "isDistractor": false },
    { "text": "to", "correctPosition": 2, "isDistractor": false },
    { "text": "school", "correctPosition": 3, "isDistractor": false },
    { "text": "today", "correctPosition": 4, "isDistractor": false },
    { "text": "yesterday", "correctPosition": -1, "isDistractor": true },
    { "text": "go", "correctPosition": -1, "isDistractor": true }
  ]
}
```

### 3.11 `completeConversation`
> Fill in the missing lines of a dialogue.

```json
{
  "type": "completeConversation",
  "prompt": "Complete the conversation at a restaurant.",
  "conversationLines": [
    { "speaker": "Waiter", "text": "Good evening! Table for two?", "isUserTurn": false, "order": 0 },
    { "speaker": "You", "text": "", "isUserTurn": true, "acceptedAnswers": ["Yes, please", "Yes please", "Yes, for two"], "order": 1 },
    { "speaker": "Waiter", "text": "Right this way. Here are your menus.", "isUserTurn": false, "order": 2 },
    { "speaker": "You", "text": "", "isUserTurn": true, "acceptedAnswers": ["Thank you", "Thanks"], "order": 3 },
    { "speaker": "Waiter", "text": "Can I get you something to drink?", "isUserTurn": false, "order": 4 },
    { "speaker": "You", "text": "", "isUserTurn": true, "acceptedAnswers": ["Water, please", "I'll have water", "Just water please"], "order": 5 }
  ]
}
```

### 3.12 `roleplay`
> Act out a role in a spoken conversation — user records audio for their turns.

```json
{
  "type": "roleplay",
  "prompt": "You're checking in at a hotel. Speak your lines.",
  "conversationLines": [
    { "speaker": "Receptionist", "text": "Welcome to Grand Hotel. Do you have a reservation?", "audioUrl": "receptionist-1.mp3", "isUserTurn": false, "order": 0 },
    { "speaker": "You", "text": "Yes, I booked a room under the name Smith.", "isUserTurn": true, "acceptedAnswers": null, "order": 1 },
    { "speaker": "Receptionist", "text": "Let me check... Yes, a double room for three nights. May I see your ID?", "audioUrl": "receptionist-2.mp3", "isUserTurn": false, "order": 2 },
    { "speaker": "You", "text": "Sure, here it is.", "isUserTurn": true, "acceptedAnswers": null, "order": 3 }
  ]
}
```

---

## 4. API Endpoints — Browse & Progress

### `GET /api/courses`
List published courses with user progress.

**Query params:** `?level=B1` (optional filter)

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Everyday English",
      "description": "...",
      "level": "B1",
      "imageUrl": "...",
      "order": 1,
      "totalLessons": 24,
      "completedLessons": 8,
      "progressPercent": 33,
      "units": [
        { "id": "uuid", "title": "Greetings", "order": 1, "_count": { "lessons": 6 } }
      ]
    }
  ]
}
```

### `GET /api/courses/:id`
Course detail with units, lessons (including `type` field), and per-lesson progress.

**Response includes per-lesson:**
```json
{
  "id": "lesson-uuid",
  "title": "At the Airport",
  "type": "mixed",
  "order": 3,
  "xpReward": 15,
  "completed": true,
  "score": 0.9,
  "xpEarned": 15
}
```

### `GET /api/courses/lessons/:lessonId`
Lesson detail with all lectures (+ attachments) and exercises.

**Response:** Full lesson object with `lectures[]` (each with `attachments[]`) and `exercises[]` (each with `options[]`, `matchPairs[]`, `wordBankItems[]`, `conversationLines[]`).

### `POST /api/courses/lessons/:lessonId/complete`
Mark a lesson as completed (legacy — prefer using exercise session flow).

**Body:** `{ "score": 85 }` (optional 0–100)

---

## 5. API Endpoints — Admin Builder

All admin endpoints require `admin` role.

### Courses

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/courses/admin/create` | `{ title, description, level, order?, isPublished? }` + optional `image` file |
| `PUT` | `/api/courses/admin/:id` | Same fields (all optional) + optional `image` file |
| `DELETE` | `/api/courses/admin/:id` | — |

### Units

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/courses/admin/units` | `{ courseId, title, order? }` |
| `PUT` | `/api/courses/admin/units/:id` | `{ title?, order? }` |
| `DELETE` | `/api/courses/admin/units/:id` | — |

### Lessons

| Method | Path | Body |
|--------|------|------|
| `POST` | `/api/courses/admin/lessons` | `{ unitId, title, type?, order?, xpReward? }` |
| `PUT` | `/api/courses/admin/lessons/:id` | `{ title?, type?, order?, xpReward? }` |
| `DELETE` | `/api/courses/admin/lessons/:id` | — |

> **`type`** values: `"practice"` (default), `"lecture"`, `"mixed"`

### Lectures

#### `POST /api/courses/admin/lectures`
Create a lecture with optional file uploads (multipart/form-data).

**Form fields:**
- `lessonId` (required), `contentType` (required: `text`|`audio`|`video`|`mixed`), `title` (required)
- `order`, `textBody`, `audioUrl`, `videoUrl`, `thumbnailUrl`, `durationSec` (optional)
- `mediaUrl` (optional, deprecated — kept for backward compatibility)
- `audio` — single file upload for audio content
- `video` — single file upload for video content
- `media` — single file upload (backward compat, use `audio`/`video` instead)
- `thumbnail` — single file upload for preview image
- `attachments` — up to 10 downloadable files (PDF, docs, etc.)

**JSON-only example (no file upload):**
```json
{
  "lessonId": "uuid",
  "contentType": "text",
  "title": "Introduction to Present Perfect",
  "order": 0,
  "textBody": "# Present Perfect\n\nThe present perfect tense is used to..."
}
```

**Audio/video example (multipart):**
```
POST /api/courses/admin/lectures
Content-Type: multipart/form-data

lessonId=uuid
contentType=video
title=Pronunciation Guide
durationSec=320
video=@video.mp4
thumbnail=@preview.jpg
attachments=@worksheet.pdf
attachments=@transcript.txt
```

**Audio-only example:**
```
POST /api/courses/admin/lectures
Content-Type: multipart/form-data

lessonId=uuid
contentType=audio
title=Listening Practice Episode 5
durationSec=180
audio=@episode5.mp3
thumbnail=@cover.jpg
```

**Mixed lecture (audio + video URLs):**
```json
{
  "lessonId": "uuid",
  "contentType": "mixed",
  "title": "Full Lesson: Greetings",
  "audioUrl": "https://cdn.example.com/audio/greetings.mp3",
  "videoUrl": "https://cdn.example.com/video/greetings.mp4",
  "durationSec": 420
}
```

#### `PUT /api/courses/admin/lectures/:id`
Update a lecture. Same form fields as create (all optional). When `attachments` files are uploaded, existing attachments are **replaced**.

#### `DELETE /api/courses/admin/lectures/:id`
Deletes the lecture, its attachments, and all progress records (cascade).

#### `POST /api/courses/admin/lectures/:id/attachments`
Add files to an existing lecture without replacing existing ones.

**Form field:** `files` — up to 10 files

#### `DELETE /api/courses/admin/lecture-attachments/:id`
Delete a single attachment.

### Exercises

#### `POST /api/courses/admin/exercises`

Create an exercise with all child data in a single request.

**Body:**
```json
{
  "lessonId": "uuid",
  "type": "multipleChoice",
  "order": 1,
  "prompt": "What does 'ubiquitous' mean?",
  "difficulty": 2,
  "xpReward": 15,
  "explanation": "'Ubiquitous' means present everywhere.",
  "options": [
    { "text": "Present everywhere", "isCorrect": true, "order": 0 },
    { "text": "Rare and unique", "isCorrect": false, "order": 1 },
    { "text": "Very expensive", "isCorrect": false, "order": 2 }
  ]
}
```

**Required fields:** `lessonId`, `type`, `prompt`
**Optional fields:** everything else (see [Exercise fields](#exercise-fields) table)
**Nested arrays:** `options`, `matchPairs`, `wordBankItems`, `conversationLines` — created together with the exercise.

#### `PUT /api/courses/admin/exercises/:id`

Update exercise. When child arrays (`options`, `matchPairs`, etc.) are provided, the existing children are **replaced atomically** (deleted + recreated in a transaction).

#### `DELETE /api/courses/admin/exercises/:id`

Deletes the exercise and all child records (cascade).

---

## 6. API Endpoints — Lecture Viewer (Student)

### `GET /api/courses/lectures/:lectureId`
Get a single lecture with attachments and user progress.

**Response:**
```json
{
  "id": "lecture-uuid",
  "lessonId": "lesson-uuid",
  "contentType": "video",
  "title": "Pronunciation Guide",
  "order": 0,
  "textBody": null,
  "mediaUrl": null,
  "audioUrl": null,
  "videoUrl": "https://cdn.example.com/lectures/video.mp4",
  "thumbnailUrl": "https://cdn.example.com/lectures/thumb.jpg",
  "durationSec": 320,
  "attachments": [
    {
      "id": "att-uuid",
      "url": "https://cdn.example.com/files/worksheet.pdf",
      "fileName": "worksheet.pdf",
      "fileSize": 245000,
      "mimeType": "application/pdf",
      "order": 0
    }
  ],
  "lesson": { "id": "...", "title": "..." },
  "userProgress": {
    "completed": false,
    "progressPct": 45,
    "completedAt": null
  }
}
```

### `POST /api/courses/lectures/:lectureId/progress`
Update lecture view/read progress.

**Body:**
```json
{ "progressPct": 75 }
```

When `progressPct` reaches 100, the lecture is automatically marked as `completed`.

**Response:**
```json
{
  "id": "progress-uuid",
  "userId": "user-uuid",
  "lectureId": "lecture-uuid",
  "completed": false,
  "progressPct": 75,
  "completedAt": null
}
```

---

## 7. API Endpoints — Exercise Player

### `POST /api/courses/lessons/:lessonId/start`
Start a new exercise session. Returns session state + all exercises for the lesson.

**Response:**
```json
{
  "session": {
    "id": "session-uuid",
    "hearts": 5,
    "combo": 0,
    "maxCombo": 0,
    "totalXp": 0,
    "correctCount": 0,
    "wrongCount": 0,
    "completed": false
  },
  "exercises": [ /* full exercise objects with options, pairs, etc. */ ]
}
```

### `POST /api/courses/sessions/:sessionId/attempt`
Submit one exercise answer.

**Body:**
```json
{
  "exerciseId": "exercise-uuid",
  "userAnswer": { "selectedOptionId": "option-uuid" },
  "isCorrect": true,
  "timeTakenMs": 4200
}
```

**`userAnswer` formats by type:**

| Exercise Type | `userAnswer` shape |
|---------------|-------------------|
| `multipleChoice` | `{ "selectedOptionId": "uuid" }` |
| `listenAndChoose` | `{ "selectedOptionId": "uuid" }` |
| `tapWhatYouHear` | `{ "selectedOptionId": "uuid" }` |
| `fillInBlank` | `{ "text": "went" }` or `{ "selectedOptionId": "uuid" }` |
| `listenRepeat` | `{ "audioUrl": "recording-url", "transcript": "..." }` |
| `speakTheAnswer` | `{ "audioUrl": "recording-url", "transcript": "..." }` |
| `pronunciation` | `{ "audioUrl": "recording-url", "score": 85 }` |
| `matchPairs` | `{ "pairs": [["left-uuid","right-uuid"], ...] }` |
| `reorderWords` | `{ "orderedWords": ["She","has","been","studying","English","for","three","years"] }` |
| `translateSentence` | `{ "orderedWords": ["I","went","to","school","today"] }` |
| `completeConversation` | `{ "answers": { "1": "Yes, please", "3": "Thank you", "5": "Water, please" } }` |
| `roleplay` | `{ "recordings": { "1": "audio-url-1", "3": "audio-url-2" } }` |

**Response:**
```json
{
  "attempt": {
    "id": "attempt-uuid",
    "isCorrect": true,
    "xpEarned": 15
  },
  "session": {
    "hearts": 5,
    "combo": 3,
    "maxCombo": 3,
    "totalXp": 45,
    "correctCount": 3,
    "wrongCount": 0
  }
}
```

### `POST /api/courses/sessions/:sessionId/complete`
Complete the session. Awards XP to user progress and marks lesson as completed.

**Response:** Full session with all attempts.

### `GET /api/courses/sessions/:sessionId`
Get session state and attempts (e.g. for resuming or reviewing).

---

## 8. TypeScript Types

```ts
// ─── Enums ──────────────────────────────────────────────────────

type LessonType = "practice" | "lecture" | "mixed";

type LectureContentType = "text" | "audio" | "video";

type ExerciseType =
  | "listenRepeat"
  | "speakTheAnswer"
  | "fillInBlank"
  | "multipleChoice"
  | "listenAndChoose"
  | "roleplay"
  | "pronunciation"
  | "matchPairs"
  | "reorderWords"
  | "translateSentence"
  | "tapWhatYouHear"
  | "completeConversation";

// ─── Models ─────────────────────────────────────────────────────

interface Course {
  id: string;
  title: string;
  description: string;
  level: string; // A2, B1, B2, C1
  imageUrl: string | null;
  isPublished: boolean;
  order: number;
  units: CourseUnit[];
  // Client-computed
  totalLessons?: number;
  completedLessons?: number;
  progressPercent?: number;
}

interface CourseUnit {
  id: string;
  courseId: string;
  title: string;
  order: number;
  lessons: Lesson[];
}

interface Lesson {
  id: string;
  unitId: string;
  title: string;
  type: LessonType;
  order: number;
  xpReward: number;
  lectures?: Lecture[];
  exercises?: Exercise[];
  // Progress overlay
  completed?: boolean;
  score?: number | null;
  xpEarned?: number;
}

interface Lecture {
  id: string;
  lessonId: string;
  contentType: LectureContentType;
  title: string;
  order: number;
  textBody: string | null;
  /** @deprecated Use audioUrl/videoUrl instead. Kept for backward compatibility. */
  mediaUrl: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  createdAt: string;
  updatedAt: string;
  attachments: LectureAttachment[];
  // Client overlay
  userProgress?: UserLectureProgress | null;
}

interface LectureAttachment {
  id: string;
  lectureId: string;
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  order: number;
}

interface UserLectureProgress {
  id: string;
  userId: string;
  lectureId: string;
  completed: boolean;
  progressPct: number; // 0-100
  completedAt: string | null;
}

interface Exercise {
  id: string;
  lessonId: string;
  type: ExerciseType;
  order: number;
  prompt: string;
  promptAudio: string | null;
  correctAnswer: string | null;
  sentenceTemplate: string | null;
  targetText: string | null;
  audioUrl: string | null;
  imageUrl: string | null;
  hints: string[] | null;
  explanation: string | null;
  difficulty: number;
  xpReward: number;
  // Children
  options: ExerciseOption[];
  matchPairs: ExerciseMatchPair[];
  wordBankItems: ExerciseWordBankItem[];
  conversationLines: ExerciseConversationLine[];
}

interface ExerciseOption {
  id: string;
  text: string;
  audioUrl: string | null;
  imageUrl: string | null;
  isCorrect: boolean;
  order: number;
}

interface ExerciseMatchPair {
  id: string;
  leftText: string;
  leftAudio: string | null;
  rightText: string;
  rightAudio: string | null;
  order: number;
}

interface ExerciseWordBankItem {
  id: string;
  text: string;
  correctPosition: number;
  isDistractor: boolean;
}

interface ExerciseConversationLine {
  id: string;
  speaker: string;
  text: string;
  audioUrl: string | null;
  isUserTurn: boolean;
  acceptedAnswers: string[] | null;
  order: number;
}

// ─── Player ─────────────────────────────────────────────────────

interface ExerciseSession {
  id: string;
  userId: string;
  lessonId: string;
  hearts: number;
  combo: number;
  maxCombo: number;
  totalXp: number;
  correctCount: number;
  wrongCount: number;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  attempts?: ExerciseAttempt[];
}

interface ExerciseAttempt {
  id: string;
  sessionId: string;
  exerciseId: string;
  userAnswer: Record<string, any>;
  isCorrect: boolean;
  xpEarned: number;
  timeTakenMs: number | null;
  createdAt: string;
}
```

---

## 9. Lecture Builder UI/UX (Admin)

### 9.1 Builder Page Flow (Updated)

```
Course List → [+ New Course] → Course Editor
  └── Unit List (drag to reorder)
       └── Lesson List (drag to reorder)
            ├── Lesson type selector: [Practice] [Lecture] [Mixed]
            ├── IF lecture|mixed → Lecture List (drag to reorder)
            │    └── [+ Add Lecture] → Lecture Editor Modal
            └── IF practice|mixed → Exercise List (drag to reorder)
                 └── [+ Add Exercise] → Exercise Editor Modal
```

### 9.2 Lesson Type Selector

When creating or editing a lesson, show a **segmented control** at the top:

```
┌─────────────────────────────────────────────────┐
│  Lesson: "Present Perfect Tense"                │
│                                                  │
│  Type: [Practice] [📖 Lecture] [Mixed]          │
│         ^^^^^^^^                                 │
│  (Selecting "Lecture" or "Mixed" reveals the     │
│   lecture section below)                         │
│                                                  │
│  ── Lectures (drag to reorder) ──               │
│  ┌─ 1. Introduction to Present Perfect ─ 📝 ─┐ │
│  │     Type: text  │  [Edit] [✕]              │ │
│  ├─ 2. Grammar Rules Explained ──── 🎧 ──────┤ │
│  │     Type: audio │  5:32  │  [Edit] [✕]    │ │
│  ├─ 3. Watch: Real Conversations ── 🎬 ──────┤ │
│  │     Type: video │  8:15  │  [Edit] [✕]    │ │
│  └────────────────────────────────────────────┘ │
│  [+ Add Lecture]                                 │
│                                                  │
│  ── Exercises (if type = practice|mixed) ──     │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

### 9.3 Lecture Editor Modal

```
┌─────────────────────────────────────────────────┐
│  Create Lecture                           [X]   │
│─────────────────────────────────────────────────│
│                                                  │
│  Content Type: [📝 Text] [🎧 Audio] [🎬 Video] │
│                                                  │
│  Title: ┌──────────────────────────────────┐    │
│         │ Introduction to Present Perfect  │    │
│         └──────────────────────────────────┘    │
│                                                  │
│  ┌─ Type-specific fields ──────────────────┐    │
│  │                                          │    │
│  │  IF text:                                │    │
│  │  ┌─ Rich Text Editor ──────────────┐    │    │
│  │  │ # Present Perfect               │    │    │
│  │  │ The present perfect tense is...  │    │    │
│  │  │ **Bold** _italic_ `code`        │    │    │
│  │  └─────────────────────────────────┘    │    │
│  │                                          │    │
│  │  IF audio:                               │    │
│  │  [🎵 Upload Audio File]  or  [Paste URL]│    │
│  │  Duration: [__:__] (auto-detected)       │    │
│  │  [📷 Upload Thumbnail]                   │    │
│  │                                          │    │
│  │  IF video:                               │    │
│  │  [🎬 Upload Video File]  or  [Paste URL]│    │
│  │  Duration: [__:__] (auto-detected)       │    │
│  │  [📷 Upload Thumbnail]                   │    │
│  │                                          │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ── Attachments (downloadable files) ──         │
│  📎 worksheet.pdf  (245 KB)          [✕]        │
│  📎 transcript.txt (12 KB)           [✕]        │
│  [+ Add Files]                                   │
│                                                  │
│  Order: [0]                                      │
│                                                  │
│                          [Cancel] [Save]         │
└─────────────────────────────────────────────────┘
```

### 9.4 UX Recommendations for Lecture Builder

1. **Content type with icons** — Segmented control with 📝/🎧/🎬 icons. Switching type clears the previous content field and shows the relevant one.

2. **Rich text editor** — For `text` type, use a markdown editor with toolbar (bold, italic, headings, lists, code blocks). Libraries: `react-native-pell-rich-editor` or render markdown preview with `react-native-markdown-display`.

3. **Media upload with preview** — After uploading audio/video:
   - Show an inline player preview (play/pause button + duration).
   - Auto-detect `durationSec` from the file metadata.
   - For video: extract a thumbnail frame automatically or let admin upload one.

4. **Attachment management:**
   - Drag to reorder attachments.
   - Show file icon based on `mimeType` (PDF icon, DOC icon, etc.).
   - Show file size in human-readable format.
   - `[+ Add Files]` opens `expo-document-picker` with multi-select.

5. **Upload to MinIO** — Use `multipart/form-data` with the `media`, `thumbnail`, and `attachments` fields. The server handles storage and returns URLs.

6. **Drag to reorder lectures** — Same `react-native-draggable-flatlist` pattern. Send updated `order` values via `PUT /admin/lectures/:id`.

7. **Duplicate lecture** — One-tap button to copy a lecture's content into a new lecture (new order = last + 1).

8. **Validation before save:**
   - `text` type: require `textBody` to be non-empty.
   - `audio`/`video` type: require `mediaUrl` or uploaded file.
   - All types: require `title`.

---

## 10. Lecture Viewer UI/UX (Student)

### 10.1 Lesson Entry — Type-Based Routing

When student taps a lesson node on the course map:

| Lesson Type | Behavior |
|-------------|----------|
| `practice` | Go directly to Exercise Player (existing flow) |
| `lecture` | Open Lecture Viewer with ordered lecture list |
| `mixed` | Open Lecture Viewer → after all lectures read, show "Start Practice" button → Exercise Player |

### 10.2 Lecture Viewer — Text Type

```
┌───────────────────────────────────────────┐
│  ← Back    Present Perfect Tense    1/3   │  ← Header + lecture position
│───────────────────────────────────────────│
│                                           │
│  Introduction to Present Perfect          │  ← Lecture title
│  ─────────────────────────────────────    │
│                                           │
│  # Present Perfect                        │  ← Rendered markdown
│                                           │
│  The present perfect tense is used to     │
│  describe actions that happened at an     │
│  unspecified time before now. The exact   │
│  time is not important.                   │
│                                           │
│  **Structure:**                           │
│  Subject + have/has + past participle     │
│                                           │
│  **Examples:**                            │
│  • I **have visited** France twice.       │
│  • She **has finished** her homework.     │
│                                           │
│  ─────────────────────────────────────    │
│  📎 Attachments                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📄 worksheet.pdf (245 KB)  [⬇ Download]│
│  │ 📄 grammar-chart.pdf (89 KB) [⬇]     │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━ 100%            │  ← Read progress bar
│           [ Next Lecture → ]              │
└───────────────────────────────────────────┘
```

**Scroll-based progress:** As the user scrolls through text content, `progressPct` updates automatically. When the user reaches the bottom, it sends `{ progressPct: 100 }` to mark as completed.

### 10.3 Lecture Viewer — Audio Type

```
┌───────────────────────────────────────────┐
│  ← Back    Grammar Rules Explained  2/3   │
│───────────────────────────────────────────│
│                                           │
│         ┌─────────────────────┐           │
│         │                     │           │
│         │   🖼️ Thumbnail      │           │  ← Thumbnail image
│         │                     │           │
│         └─────────────────────┘           │
│                                           │
│     Grammar Rules Explained               │  ← Title
│     5:32 • Audio Lesson                   │  ← Duration + type badge
│                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━         │  ← Audio progress bar
│  2:15                           5:32      │
│                                           │
│         ⏪   [ ▶ Play ]   ⏩              │  ← Audio controls
│                                           │
│  Speed: [0.75x] [1x] [1.25x] [1.5x]     │  ← Playback speed
│                                           │
│  ─────────────────────────────────────    │
│  📎 Attachments                           │
│  📄 transcript.txt (12 KB)    [⬇]        │
│                                           │
│           [ Next Lecture → ]              │
└───────────────────────────────────────────┘
```

**Audio progress:** `progressPct` = `(currentPosition / totalDuration) * 100`. Auto-sends progress updates at 25%, 50%, 75%, and 100% marks.

### 10.4 Lecture Viewer — Video Type

```
┌───────────────────────────────────────────┐
│  ← Back    Real Conversations       3/3   │
│───────────────────────────────────────────│
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │                                     │  │
│  │          📹 Video Player            │  │  ← Full-width video
│  │          (expo-av Video)            │  │
│  │    ▶ 3:42 ━━━━━━━━━━━━━━━ 8:15     │  │
│  │    [CC] [⛶ Fullscreen]             │  │
│  │                                     │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  Watch: Real Conversations                │  ← Title
│  8:15 • Video Lesson                      │
│                                           │
│  Speed: [0.75x] [1x] [1.25x] [1.5x]     │
│                                           │
│  ─────────────────────────────────────    │
│  📎 Attachments                           │
│  📄 conversation-script.pdf   [⬇]        │
│                                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 45%        │  ← Overall lecture progress
│           [ Complete & Continue → ]       │
└───────────────────────────────────────────┘
```

**Video progress:** Same as audio — track playback position and auto-send progress updates.

### 10.5 Lecture List View (for lessons with multiple lectures)

```
┌───────────────────────────────────────────┐
│  ← Back    Present Perfect Tense          │
│───────────────────────────────────────────│
│                                           │
│  📖 Lecture Content (3 sections)          │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ ✅ 1. Introduction to Present Perfect│  │
│  │    📝 Text • Completed              │  │
│  ├─────────────────────────────────────┤  │
│  │ 🔵 2. Grammar Rules Explained       │  │  ← Current (in-progress)
│  │    🎧 Audio • 5:32 • 45% done      │  │
│  ├─────────────────────────────────────┤  │
│  │ ○  3. Watch: Real Conversations     │  │  ← Not started
│  │    🎬 Video • 8:15                  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  IF type=mixed AND all lectures completed:│
│  ─────────────────────────────────────    │
│  🏋️ Practice Exercises (6 exercises)     │
│  [ Start Practice → ]                     │
│                                           │
└───────────────────────────────────────────┘
```

### 10.6 Attachment Download

- Tap `[⬇ Download]` → use `expo-file-system` to download to the device.
- Show download progress indicator on the button.
- After download, open with `expo-sharing` or `Linking.openURL()` for supported types.
- Show file icon based on MIME type:
  - `application/pdf` → 📄
  - `image/*` → 🖼️
  - `audio/*` → 🎵
  - `video/*` → 🎬
  - default → 📎

### 10.7 Progress Tracking Logic

```ts
// Auto-track text lecture progress based on scroll position
function onTextScroll(scrollY: number, contentHeight: number, viewportHeight: number) {
  const maxScroll = contentHeight - viewportHeight;
  if (maxScroll <= 0) return 100; // Content fits on screen
  return Math.min(100, Math.round((scrollY / maxScroll) * 100));
}

// Auto-track audio/video progress based on playback
function onPlaybackUpdate(positionMs: number, durationMs: number) {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.round((positionMs / durationMs) * 100));
}

// Send progress to server (debounced — every 10% change or on complete)
let lastSentPct = 0;
function maybeSendProgress(lectureId: string, pct: number) {
  if (pct >= 100 || pct - lastSentPct >= 10) {
    api.post(`/courses/lectures/${lectureId}/progress`, { progressPct: pct });
    lastSentPct = pct;
  }
}
```

---

## 11. Exercise Builder UI/UX (Teacher/Admin)

### 11.1 Builder Page Flow

```
Course List → [+ New Course] → Course Editor
  └── Unit List (drag to reorder)
       └── Lesson List (drag to reorder)
            └── Exercise List (drag to reorder)
                 └── [+ Add Exercise] → Exercise Editor Modal
```

### 11.2 Exercise Editor Modal — Layout

The modal should adapt its form fields based on the selected `type`.

```
┌─────────────────────────────────────────────────┐
│  Create Exercise                          [X]   │
│─────────────────────────────────────────────────│
│                                                  │
│  Type: [▼ Multiple Choice          ]            │
│                                                  │
│  Prompt: ┌──────────────────────────────────┐   │
│          │ What does 'ubiquitous' mean?     │   │
│          └──────────────────────────────────┘   │
│                                                  │
│  ┌─ Type-specific fields ──────────────────┐    │
│  │  (Rendered dynamically — see 8.3)       │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  ── Advanced ──                                  │
│  Difficulty: [● Easy ○ Medium ○ Hard]           │
│  XP Reward:  [10]                               │
│  Explanation: ┌─────────────────────────────┐   │
│               │ Shown after the student...  │   │
│               └─────────────────────────────┘   │
│  Hints:      [+ Add Hint]                       │
│              • "Past tense of go"    [✕]        │
│                                                  │
│  [Preview]                    [Cancel] [Save]   │
└─────────────────────────────────────────────────┘
```

### 11.3 Type-Specific Field Panels

Show/hide these sections based on the selected exercise type:

| Type | Fields shown |
|------|-------------|
| `multipleChoice` | Options list with `[+ Add Option]`, toggle `isCorrect`, optional image per option |
| `listenAndChoose` | Audio upload + Options list with optional images |
| `tapWhatYouHear` | Audio upload + Options list (text only) |
| `fillInBlank` | Sentence template input (`___` for blank) + either `correctAnswer` text input OR options list |
| `listenRepeat` | Target text + Audio upload |
| `speakTheAnswer` | Optional image upload (prompt already has text) |
| `pronunciation` | Target text + Audio upload + optional phonetic hint |
| `matchPairs` | Pair editor: rows of `[Left text] ↔ [Right text]` + `[+ Add Pair]` |
| `reorderWords` | Correct sentence input → auto-split into word bank + `[+ Add Distractor]` |
| `translateSentence` | Source sentence in prompt + Correct English sentence → auto-split into word bank + `[+ Add Distractor]` |
| `completeConversation` | Conversation builder: rows with speaker dropdown, text, `isUserTurn` toggle, accepted answers |
| `roleplay` | Conversation builder: same as above but user turns expect audio recording |

### 11.4 UX Recommendations for Builder

1. **Type selector with icons** — Use visual cards instead of a plain dropdown. Each card shows the exercise type icon + a one-line description. Group into categories:
   - **Listen** — listenRepeat, listenAndChoose, tapWhatYouHear
   - **Speak** — speakTheAnswer, pronunciation, roleplay
   - **Read/Write** — multipleChoice, fillInBlank, reorderWords, translateSentence
   - **Interactive** — matchPairs, completeConversation

2. **Drag-to-reorder exercises** — Use `react-native-draggable-flatlist` for reordering. Send updated `order` values to `PUT /admin/exercises/:id`.

3. **Smart word bank generator** — For `reorderWords` and `translateSentence`:
   - Teacher types the correct sentence.
   - App auto-splits into word items and assigns `correctPosition`.
   - Teacher taps `[+ Distractor]` to add wrong words.

4. **Conversation builder timeline** — For `completeConversation` and `roleplay`:
   - Show as a chat-like timeline with alternating left/right bubbles.
   - Tap a bubble to edit. "User turn" bubbles are highlighted with a different color.
   - Each user-turn bubble has an "Accepted answers" chip list.

5. **Live preview** — A `[Preview]` button renders the exercise exactly as the student would see it, so the teacher can test before saving.

6. **Bulk import** — Accept a JSON array to create multiple exercises at once (call `POST /admin/exercises` in a loop or add a batch endpoint later).

7. **Duplicate exercise** — One-tap duplicate button that pre-fills the editor with an existing exercise's data (new order = last + 1).

8. **Audio upload** — Use `expo-av` for recording or `expo-document-picker` for file upload. Upload to MinIO via a signed URL or your upload endpoint, then store the returned URL.

9. **Validation before save:**
   - `multipleChoice` / `listenAndChoose` / `tapWhatYouHear`: require ≥ 2 options with exactly 1 correct.
   - `fillInBlank` with template: require `___` in `sentenceTemplate`.
   - `matchPairs`: require ≥ 2 pairs.
   - `reorderWords` / `translateSentence`: require ≥ 3 non-distractor words.
   - `completeConversation`: require ≥ 1 user turn with accepted answers.

10. **Color-coded difficulty** — Green/Yellow/Red chips for Easy/Medium/Hard so teachers can visually scan the lesson's difficulty curve.

---

## 12. Exercise Player UI/UX (Student)

### 12.1 Session Flow

```
┌───────────────────────────────────────────┐
│  ❤️❤️❤️❤️❤️        ━━━━━━━━━━━━━━  3/10   │  ← Hearts + Progress bar
│───────────────────────────────────────────│
│                                           │
│  What does 'ubiquitous' mean?             │  ← Prompt
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │  ○  Rare and unique                 │  │  ← Options
│  ├─────────────────────────────────────┤  │
│  │  ●  Present everywhere       ✓      │  │  ← Selected (correct)
│  ├─────────────────────────────────────┤  │
│  │  ○  Very expensive                  │  │
│  ├─────────────────────────────────────┤  │
│  │  ○  Extremely fast                  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  💡 'Ubiquitous' means present everywhere │  ← Explanation (after answer)
│                                           │
│           [ Continue → ]                  │  ← Next exercise
│                                           │
│  🔥 Combo: 3        +15 XP               │  ← Combo + XP earned
└───────────────────────────────────────────┘
```

### 12.2 Exercise Type UI Templates

#### Multiple Choice / Listen & Choose / Tap What You Hear
- Show prompt text at top.
- If `audioUrl` present: large **play button** above options.
- Options as full-width rounded cards. If `imageUrl` on options, show image thumbnails.
- Tap to select → button turns green (correct) or red (wrong) with haptic feedback.
- After answering, show `explanation` below in a subtle info box.

#### Fill in the Blank
- Render `sentenceTemplate` as a sentence with a highlighted **blank slot** (underlined or a pill-shaped input).
- **Typing mode** (no options): show keyboard with the blank focused.
- **Dropdown mode** (has options): tap the blank → bottom sheet with options.
- Validate against `correctAnswer` (case-insensitive, trimmed).

#### Listen & Repeat / Pronunciation
- Show target text in a large, readable font.
- **Play reference audio** button (speaker icon).
- **Record** button: large circular mic button at bottom. Press-and-hold or tap to toggle.
- Use `expo-av` for recording. After recording, show a waveform + replay button.
- For pronunciation: show a score meter (0–100) after comparison.

#### Speak the Answer
- Show prompt (+ optional image as context).
- Hints expandable: "💡 Tap for a hint" → reveals hints one at a time.
- Record button at bottom.
- After recording, auto-transcribe and show transcript. Teacher/AI evaluates later.

#### Match Pairs
- Two columns of tappable cards.
- Tap a left card → it highlights. Tap a right card → if correct pair, both cards fly to a "matched" area with a green checkmark. If wrong, both shake and reset.
- Shuffled order on both sides.
- If audio present on pairs, tap speaker icon on each card to hear it.

#### Reorder Words / Translate Sentence
- **Word bank** at bottom: horizontal scrollable row of rounded pill buttons.
- **Answer area** at top: empty slots where tapped words snap into place (left-to-right).
- Tap a word in the bank → it moves to the next slot in the answer area.
- Tap a word in the answer area → it returns to the bank.
- For `translateSentence`: source sentence displayed above the answer area.
- Distractor words are mixed in (they look identical to valid words).

#### Complete Conversation
- Chat-bubble layout, scrollable.
- Bot lines: left-aligned gray bubbles with speaker name above.
- User-turn lines: right-aligned blue bubble outlines (empty).
- When reaching a user turn: show a **text input** at the bottom for typing (or option chips if few accepted answers).
- After typing, validate against `acceptedAnswers` (fuzzy: case-insensitive, trimmed, common punctuation ignored).
- Fill in the bubble with the user's answer + green check or red X.

#### Roleplay
- Same chat-bubble layout.
- Bot lines: left-aligned with optional play audio button.
- User-turn lines: right-aligned with a **mic record button** instead of text input.
- After recording, show a mini waveform in the bubble.
- Scoring is optional (based on speech comparison if AI enabled).

### 12.3 Hearts System

| Event | Effect |
|-------|--------|
| Wrong answer | Lose 1 heart. Heart icon cracks with animation. |
| Hearts reach 0 | Session ends. Show "Out of hearts" modal with options: **Wait** (timer refill), **Use coins** (spend coins for refill), or **Review mistakes**. |
| Correct answer | No heart change. |

**UI:** Hearts row at top-left, displayed as ❤️ icons. Lost hearts shown as 🖤.

### 12.4 Combo & XP System

| Event | Effect |
|-------|--------|
| Correct answer | `combo++`, earn `exercise.xpReward` XP. |
| 3+ combo | Show 🔥 fire animation. Optionally multiply XP: `xp * (1 + combo * 0.1)`. |
| Wrong answer | Combo resets to 0. |

**UI:**
- Combo counter below the progress bar. Fire emoji appears at 3+.
- XP earned floats up as `+15 XP` animation after each correct answer.
- Progress bar fills based on `currentExercise / totalExercises`.

### 12.5 Session Complete Screen

```
┌───────────────────────────────────────────┐
│                                           │
│              ⭐ Lesson Complete! ⭐        │
│                                           │
│         ┌─────────────────────┐           │
│         │    🏆  85 XP         │           │
│         │    🔥  Max Combo: 7  │           │
│         │    ✅  9/10 Correct  │           │
│         │    ⏱   3m 42s        │           │
│         └─────────────────────┘           │
│                                           │
│         ❤️❤️❤️❤️🖤                         │
│         4 hearts remaining                │
│                                           │
│     [Review Mistakes]  [Continue →]       │
│                                           │
└───────────────────────────────────────────┘
```

- **Review Mistakes** — Shows only the exercises where `isCorrect === false`, with the correct answer highlighted.
- **Continue** — Returns to the course map. The completed lesson node changes to a star/checkmark.
- Celebration confetti animation on first completion.

### 12.6 Animations & Feedback

| Event | Animation |
|-------|-----------|
| Correct answer | Green flash + checkmark + haptic success. Sound: "ding!" |
| Wrong answer | Red flash + shake + haptic error. Sound: "buzz" |
| Combo 3+ | 🔥 Fire burst from combo counter |
| Heart lost | Heart cracks and fades to gray |
| Lesson complete | Confetti + star burst + XP counter roll-up |
| Word tile tap (reorder) | Tile pops up from bank, slides to answer slot |
| Match pair correct | Both cards shrink + fly together with a spark |

Use `react-native-reanimated` for spring/timing animations, `expo-haptics` for haptic feedback, and `expo-av` for sound effects.

---

## 13. Course Map UI/UX

### 13.1 Duolingo-style Path Layout

Instead of a flat list, show lessons as nodes on a **winding vertical path** (snake pattern). Each node now shows **lesson type** with a distinct icon:

```
         ★🏋️ (Lesson 1 — practice, completed)
        /
       ★📖 (Lesson 2 — lecture, completed)
        \
         ◉📖🏋️ (Lesson 3 — mixed, current)
        /
       🔒🏋️ (Lesson 4 — practice, locked)
        \
         🔒📖 (Lesson 5 — lecture, locked)
```

**Node states:**
| State | Visual | Interaction |
|-------|--------|-------------|
| Completed | Gold star + checkmark | Tap to replay (no XP) |
| Current | Glowing/pulsing circle, larger | Tap to start |
| Locked | Gray circle + 🔒 | Tap shows "Complete previous lesson first" |

**Lesson type badges on nodes:**
| Type | Badge | Description |
|------|-------|-------------|
| `practice` | 🏋️ | Exercise icon |
| `lecture` | 📖 | Book icon |
| `mixed` | 📖🏋️ | Both icons |

### 13.2 Unit Headers

Between lesson node groups, show unit title banners:

```
━━━━━━━━ Unit 1: Greetings ━━━━━━━━
      ★ → ● → ◉
━━━━━━━ Unit 2: At the Airport ━━━━━━━
      🔒 → 🔒 → 🔒
```

### 13.3 Progress Indicators

- **Course card** (list screen): circular progress ring showing `progressPercent`.
- **Unit**: `3/6 lessons completed` text under the unit header.
- **Lesson node**: colored fill based on score (green = high, yellow = okay, orange = low).

---

## 14. Expo Implementation Notes

### 14.1 Key Dependencies

```bash
npx expo install expo-av expo-haptics expo-document-picker expo-file-system expo-sharing
npm install react-native-reanimated react-native-gesture-handler react-native-draggable-flatlist react-native-markdown-display
```

| Package | Used for |
|---------|----------|
| `expo-av` | Audio/video playback in lectures, audio recording in exercises |
| `expo-haptics` | Haptic feedback on exercise answers |
| `expo-document-picker` | Uploading lecture media + attachments (admin) |
| `expo-file-system` | Downloading lecture attachments (student) |
| `expo-sharing` | Opening downloaded files (student) |
| `react-native-markdown-display` | Rendering text lecture `textBody` as rich content |
| `react-native-reanimated` | Animations (exercise feedback, lecture transitions) |
| `react-native-draggable-flatlist` | Reordering lectures + exercises (admin) |

### 14.2 Answer Validation (Client-Side)

The client should validate answers locally for instant feedback, then confirm with the server via the attempt endpoint.

```ts
function validateAnswer(exercise: Exercise, userAnswer: any): boolean {
  switch (exercise.type) {
    case "multipleChoice":
    case "listenAndChoose":
    case "tapWhatYouHear": {
      const selected = exercise.options.find(o => o.id === userAnswer.selectedOptionId);
      return selected?.isCorrect ?? false;
    }
    case "fillInBlank": {
      if (userAnswer.selectedOptionId) {
        const selected = exercise.options.find(o => o.id === userAnswer.selectedOptionId);
        return selected?.isCorrect ?? false;
      }
      return exercise.correctAnswer?.toLowerCase().trim() === userAnswer.text?.toLowerCase().trim();
    }
    case "matchPairs": {
      // All pairs must match by order index
      return userAnswer.pairs.every(([leftId, rightId]: [string, string]) => {
        const pair = exercise.matchPairs.find(p => p.id === leftId || p.id === rightId);
        return pair !== undefined; // simplified — real logic checks both sides
      });
    }
    case "reorderWords":
    case "translateSentence": {
      const correct = exercise.wordBankItems
        .filter(w => !w.isDistractor)
        .sort((a, b) => a.correctPosition - b.correctPosition)
        .map(w => w.text);
      return JSON.stringify(userAnswer.orderedWords) === JSON.stringify(correct);
    }
    case "completeConversation": {
      const userTurns = exercise.conversationLines.filter(l => l.isUserTurn);
      return userTurns.every(turn => {
        const answer = userAnswer.answers?.[turn.order];
        return turn.acceptedAnswers?.some(
          a => a.toLowerCase().trim() === answer?.toLowerCase().trim()
        );
      });
    }
    case "listenRepeat":
    case "speakTheAnswer":
    case "pronunciation":
    case "roleplay":
      return true; // Server/AI evaluates speech
    default:
      return false;
  }
}
```

### 14.3 Audio Recording Helper

```ts
import { Audio } from "expo-av";

async function startRecording(): Promise<Audio.Recording> {
  await Audio.requestPermissionsAsync();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  const { recording } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY
  );
  return recording;
}

async function stopAndUpload(recording: Audio.Recording): Promise<string> {
  await recording.stopAndUnloadAsync();
  const uri = recording.getURI()!;
  // Upload to your server/MinIO and return the remote URL
  const remoteUrl = await uploadAudioFile(uri);
  return remoteUrl;
}
```

### 14.4 Recommended Screen Structure

```
app/
  (tabs)/
    courses/
      index.tsx              — Course list (GET /api/courses)
      [courseId].tsx          — Course map with units & lesson nodes (GET /api/courses/:id)
      lesson/    — Course list (GET /api/courses)
      [courseId].tsx          — Course map with units & lesson nodes (GET /api/courses/:id)
      lesson/
        [lessonId].tsx       — Lesson router: checks lesson.type → routes to lectures or exercises
        lectures/
          index.tsx          — Lecture list for a lesson (shows all lectures with progress)
          [lectureId].tsx    — Lecture viewer (text/audio/video + attachments + progress tracking)
        exercises/
          [lessonId].tsx     — Exercise player (POST start → attempt loop → complete)
          review.tsx         — Review mistakes after session
  (admin)/
    courses/
      index.tsx              — Admin course list with [+ Create]
      [courseId]/
        edit.tsx             — Course/unit/lesson editor with drag-to-reorder
        lectures/
          [lessonId].tsx     — Lecture list + [+ Add Lecture] → modal editor
        exercises/
          [lessonId].tsx     — Exercise list + [+ Add Exercise] → modal editor
```

### 11.5 Lesson Router Logic

The lesson screen should route based on `lesson.type`:

```ts
// app/(tabs)/courses/lesson/[lessonId].tsx

function LessonScreen({ lesson }: { lesson: Lesson }) {
  switch (lesson.type) {
    case "lecture":
      // Show lecture list → tap each to view
      return <LectureListScreen lesson={lesson} />;

    case "mixed":
      // Show lecture list first, then "Start Practice" button
      // when all lectures are completed
      return <MixedLessonScreen lesson={lesson} />;

    case "practice":
    default:
      // Go directly to exercise player (existing flow)
      return <ExercisePlayerScreen lesson={lesson} />;
  }
}
```

### 11.6 Lecture Media Playback

```ts
import { Audio, Video, ResizeMode } from "expo-av";

// Audio lecture playback
async function playAudioLecture(mediaUrl: string) {
  const { sound } = await Audio.Sound.createAsync(
    { uri: mediaUrl },
    { shouldPlay: true },
    (status) => {
      if (status.isLoaded && status.durationMillis) {
        const pct = Math.round((status.positionMillis / status.durationMillis) * 100);
        maybeSendProgress(lectureId, pct);
      }
    }
  );
  return sound;
}

// Video lecture — use <Video> component
// <Video
//   source={{ uri: lecture.mediaUrl }}
//   resizeMode={ResizeMode.CONTAIN}
//   useNativeControls
//   onPlaybackStatusUpdate={(status) => { ... }}
//   style={{ width: '100%', aspectRatio: 16/9 }}
// />
```

### 11.7 Lecture Attachment Download

```ts
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

async function downloadAttachment(attachment: LectureAttachment) {
  const fileUri = FileSystem.documentDirectory + attachment.fileName;

  const download = FileSystem.createDownloadResumable(
    attachment.url,
    fileUri,
    {},
    (progress) => {
      const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
      // Update download progress UI
    }
  );

  const result = await download.downloadAsync();
  if (result?.uri) {
    await Sharing.shareAsync(result.uri);
  }
}
        edit.tsx             — Course/unit/lesson editor with drag-to-reorder
        lectures/
          [lessonId].tsx     — Lecture list + [+ Add Lecture] → modal editor
        exercises/
          [lessonId].tsx     — Exercise list + [+ Add Exercise] → modal editor
```

### 14.5 Lesson Router Logic

The lesson screen should route based on `lesson.type`:

```ts
// app/(tabs)/courses/lesson/[lessonId].tsx

function LessonScreen({ lesson }: { lesson: Lesson }) {
  switch (lesson.type) {
    case "lecture":
      // Show lecture list → tap each to view
      return <LectureListScreen lesson={lesson} />;

    case "mixed":
      // Show lecture list first, then "Start Practice" button
      // when all lectures are completed
      return <MixedLessonScreen lesson={lesson} />;

    case "practice":
    default:
      // Go directly to exercise player (existing flow)
      return <ExercisePlayerScreen lesson={lesson} />;
  }
}
```

### 14.6 Lecture Media Playback

```ts
import { Audio, Video, ResizeMode } from "expo-av";

// Audio lecture playback
async function playAudioLecture(mediaUrl: string) {
  const { sound } = await Audio.Sound.createAsync(
    { uri: mediaUrl },
    { shouldPlay: true },
    (status) => {
      if (status.isLoaded && status.durationMillis) {
        const pct = Math.round((status.positionMillis / status.durationMillis) * 100);
        maybeSendProgress(lectureId, pct);
      }
    }
  );
  return sound;
}

// Video lecture — use <Video> component
// <Video
//   source={{ uri: lecture.mediaUrl }}
//   resizeMode={ResizeMode.CONTAIN}
//   useNativeControls
//   onPlaybackStatusUpdate={(status) => { ... }}
//   style={{ width: '100%', aspectRatio: 16/9 }}
// />
```

### 14.7 Lecture Attachment Download

```ts
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";

async function downloadAttachment(attachment: LectureAttachment) {
  const fileUri = FileSystem.documentDirectory + attachment.fileName;

  const download = FileSystem.createDownloadResumable(
    attachment.url,
    fileUri,
    {},
    (progress) => {
      const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
      // Update download progress UI
    }
  );

  const result = await download.downloadAsync();
  if (result?.uri) {
    await Sharing.shareAsync(result.uri);
  }
}
```
