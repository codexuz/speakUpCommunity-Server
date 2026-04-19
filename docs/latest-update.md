# Latest Update — Writing Tests & AI Assessment

## Overview

Full writing assessment system with AI-powered feedback, IELTS/CEFR scoring, teacher reviews, gamification, and real-time notifications.

---

## New Prisma Models

| Model | Description |
|---|---|
| `WritingTest` | A test container (title, description, examType: `ielts` \| `cefr`, isPublished) |
| `WritingTask` | Individual task/prompt within a test (taskText, part, image, minWords, maxWords, timeLimit) |
| `WritingSession` | A student's attempt at a test (links user, test, group, visibility, scoreAvg, cefrLevel) |
| `WritingResponse` | Submitted essay (essayText, wordCount, timeTakenSec) |
| `WritingAIFeedback` | AI-generated assessment (4 criteria scores, grammar issues, vocab suggestions, improved essay) |
| `WritingReview` | Teacher review (score, feedback). Unique per reviewer per session |

**Updated models:** `User` (new relations), `Group` (writingSessions relation), `UserProgress` (new `totalWritings` field)

---

## API Endpoints

All routes: `/api/writing`, require authentication.

### Writing Tests (teacher/admin)

| Method | Path | Description |
|---|---|---|
| `GET` | `/tests` | List tests (paginated). Query: `examType`, `page`, `limit`, `isPublished` |
| `GET` | `/tests/:id` | Get single test with tasks |
| `POST` | `/tests` | Create test. Body: `{ title, description?, examType, isPublished? }` |
| `PUT` | `/tests/:id` | Update test |
| `DELETE` | `/tests/:id` | Delete test |

### Writing Tasks (teacher/admin)

| Method | Path | Description |
|---|---|---|
| `GET` | `/tests/:testId/tasks` | List tasks for a test |
| `POST` | `/tests/:testId/tasks` | Create task. Body: `{ taskText, part, image?, minWords?, maxWords?, timeLimit? }` |
| `PUT` | `/tasks/:id` | Update task |
| `DELETE` | `/tasks/:id` | Delete task |

### Essay Submission (student)

| Method | Path | Description |
|---|---|---|
| `POST` | `/submit` | Submit essay. Body: `{ taskId, essayText, sessionId?, testId?, visibility?, groupId?, timeTakenSec? }` |

- Auto-creates a `WritingSession` if `testId` is provided without `sessionId`
- Validates group membership for group visibility
- Enqueues a background job for AI assessment + gamification

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/my` | Current user's sessions (paginated) |
| `GET` | `/sessions/:sessionId` | Full session with responses, AI feedback, and reviews |
| `DELETE` | `/sessions/:sessionId` | Delete session (owner/teacher/admin) |

### AI Feedback

| Method | Path | Description |
|---|---|---|
| `GET` | `/ai-feedback/:responseId` | AI feedback for a single response |
| `GET` | `/ai-feedback/session/:sessionId` | All AI feedbacks for a session + aggregate scores |

### Teacher Reviews

| Method | Path | Description |
|---|---|---|
| `POST` | `/sessions/:sessionId/review` | Submit review. Body: `{ score, feedback? }` |

- Recalculates session `scoreAvg` and `cefrLevel`
- Awards reviewer 15 XP
- Sends push + SSE notification to student

---

## Scoring System

### IELTS (examType: `ielts`)

- **Range:** 0–9 (0.5 increments)
- **4 criteria:** Task Achievement, Coherence & Cohesion, Lexical Resource, Grammatical Range
- **Overall:** Average of 4 criteria
- **CEFR mapping:** ≤3.5 → A2, ≤4.5 → B1, ≤6 → B2, ≤7.5 → C1, 8+ → C2

### CEFR (examType: `cefr`)

- **Range:** 1–6 (integers)
- **Same 4 criteria**, overall is rounded average
- **Level mapping:** 1 → A2, 2 → B1, 3 → lower B2, 4 → higher B2, 5 → C1, 6 → C2

---

## AI Feedback Details

- **Model:** GPT-4o-mini (temperature 0.3, JSON mode)
- **Output:**
  - 4 criteria scores + overall score + CEFR level
  - `grammarIssues` — up to 8 items: `{ original, corrected, explanation }`
  - `vocabSuggestions` — up to 5 items: `{ word, alternatives[], context }`
  - `coherenceNotes` — up to 4 items: `{ issue, suggestion }`
  - `taskNotes` — task completion assessment
  - `aiSummary` — encouraging 2-3 sentence summary
  - `improvedEssay` — rewritten improved version

---

## Background Worker

- **Queue:** `writing-processing` (BullMQ)
- **Concurrency:** 3
- **Retries:** 3 attempts with exponential backoff (2s base)
- **Pipeline per job:**
  1. Generate AI feedback via OpenAI
  2. Send push notification + SSE event to student
  3. Award 20 XP
  4. Increment `totalWritings`
  5. Check achievement milestones

---

## Gamification

| Action | Reward |
|---|---|
| Submit writing | 20 XP |
| Review a session (teacher) | 15 XP |

### Writing Achievements

| Milestone | Achievement Key |
|---|---|
| First writing | `first_writing` |
| 10 writings | `10_writings` |
| 50 writings | `50_writings` |
| 100 writings | `100_writings` |

---


## Writing Tests & AI Assessment

### Writing TypeScript Types

```ts
type WritingExamType = "ielts" | "cefr";

export interface WritingTest {
  id: number;
  title: string;
  description: string | null;
  examType: WritingExamType;
  isPublished: boolean;
  createdAt: string;
  tasks?: WritingTask[];
}

export interface WritingTask {
  id: number;
  testId: number;
  taskText: string;
  part: string; // e.g. "Task 1", "Task 2"
  image: string | null;
  minWords: number; // default 150
  maxWords: number; // default 250
  timeLimit: number; // seconds, default 1200 (20 min)
}

export interface WritingSession {
  id: string;
  testId: number;
  userId: string;
  examType: WritingExamType;
  visibility: "private" | "group" | "community" | "ai_only";
  groupId: string | null;
  scoreAvg: number | null;
  cefrLevel: string | null; // "A2" | "B1" | "B2" | "C1" | "C2"
  createdAt: string;
  test?: Pick<WritingTest, "id" | "title" | "description">;
  user?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
  responses?: WritingResponse[];
  reviews?: WritingReview[];
  _count?: { responses: number };
}

export interface WritingResponse {
  id: string;
  taskId: number;
  studentId: string;
  sessionId: string | null;
  essayText: string;
  wordCount: number;
  timeTakenSec: number | null;
  createdAt: string;
  student?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
  task?: Pick<WritingTask, "id" | "taskText" | "part" | "minWords" | "maxWords">;
  aiFeedback?: WritingAIFeedback | null;
}

export interface WritingAIFeedback {
  id: string;
  responseId: string;
  examType: WritingExamType;
  taskAchievement: number;
  coherenceCohesion: number;
  lexicalResource: number;
  grammaticalRange: number;
  overallScore: number;
  cefrLevel: string;
  grammarIssues: { original: string; corrected: string; explanation: string }[];
  vocabSuggestions: { word: string; alternatives: string[]; context: string }[];
  coherenceNotes: { issue: string; suggestion: string }[];
  taskNotes: string | null;
  aiSummary: string | null;
  improvedEssay: string | null;
  createdAt: string;
}

export interface WritingReview {
  id: string;
  sessionId: string;
  reviewerId: string;
  score: number;
  cefrLevel: string;
  feedback: string | null;
  createdAt: string;
  reviewer?: Pick<User, "id" | "fullName" | "avatarUrl">;
}
```

### Writing Scoring

**IELTS** — 0–9 (0.5 increments). 4 criteria averaged:

| IELTS Band | CEFR Level |
|------------|------------|
| 0–3.5 | A2 |
| 4–4.5 | B1 |
| 5–6 | B2 |
| 6.5–7.5 | C1 |
| 8–9 | C2 |

**CEFR** — 1–6 (integers). 4 criteria averaged and rounded:

| Score | CEFR Level |
|-------|------------|
| 1 | A2 |
| 2 | B1 |
| 3 | Lower B2 |
| 4 | Higher B2 |
| 5 | C1 |
| 6 | C2 |

### List Writing Tests

```ts
const getWritingTests = async (
  token: string,
  params?: { examType?: WritingExamType; page?: number; limit?: number }
) => {
  const query = new URLSearchParams();
  if (params?.examType) query.set("examType", params.examType);
  if (params?.page) query.set("page", String(params.page));
  if (params?.limit) query.set("limit", String(params.limit));

  const res = await fetch(`${BASE_URL}/writing/tests?${query}`, {
    headers: headers(token),
  });
  return res.json() as Promise<{
    data: WritingTest[];
    meta: Pagination;
  }>;
};
```

### Get Single Writing Test

```ts
const getWritingTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/writing/tests/${testId}`, {
    headers: headers(token),
  });
  return res.json() as Promise<WritingTest>;
};
```

### Create Writing Test (teacher/admin)

```ts
const createWritingTest = async (
  token: string,
  data: { title: string; description?: string; examType: WritingExamType; isPublished?: boolean }
) => {
  const res = await fetch(`${BASE_URL}/writing/tests`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json() as Promise<WritingTest>;
};
```

### Update Writing Test (teacher/admin)

```ts
const updateWritingTest = async (
  token: string,
  testId: number,
  data: Partial<{ title: string; description: string; examType: WritingExamType; isPublished: boolean }>
) => {
  const res = await fetch(`${BASE_URL}/writing/tests/${testId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json() as Promise<WritingTest>;
};
```

### Delete Writing Test (teacher/admin)

```ts
const deleteWritingTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/writing/tests/${testId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { message: "Writing test deleted" }
};
```

### List Tasks for a Test

```ts
const getWritingTasks = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/writing/tests/${testId}/tasks`, {
    headers: headers(token),
  });
  return res.json() as Promise<WritingTask[]>;
};
```

### Create Task (teacher/admin)

```ts
const createWritingTask = async (
  token: string,
  testId: number,
  data: {
    taskText: string;
    part: string;
    image?: string;
    minWords?: number;
    maxWords?: number;
    timeLimit?: number;
  }
) => {
  const res = await fetch(`${BASE_URL}/writing/tests/${testId}/tasks`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json() as Promise<WritingTask>;
};
```

### Update Task (teacher/admin)

```ts
const updateWritingTask = async (
  token: string,
  taskId: number,
  data: Partial<{
    taskText: string;
    part: string;
    image: string | null;
    minWords: number;
    maxWords: number;
    timeLimit: number;
  }>
) => {
  const res = await fetch(`${BASE_URL}/writing/tasks/${taskId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json() as Promise<WritingTask>;
};
```

### Delete Task (teacher/admin)

```ts
const deleteWritingTask = async (token: string, taskId: number) => {
  const res = await fetch(`${BASE_URL}/writing/tasks/${taskId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { message: "Task deleted" }
};
```

### Submit Essay (student)

For the **first task** in a test, send `testId` — a session is auto-created. For subsequent tasks, send the returned `sessionId`.

```ts
const submitEssay = async (
  token: string,
  data: {
    taskId: number;
    essayText: string;
    testId?: number; // first submission — creates session
    sessionId?: string; // subsequent submissions — reuses session
    visibility?: "private" | "group" | "community" | "ai_only";
    groupId?: string;
    timeTakenSec?: number;
  }
) => {
  const res = await fetch(`${BASE_URL}/writing/submit`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json() as Promise<WritingResponse & { sessionId: string | null }>;
};
```

**Example flow — multi-task test:**

```ts
// Task 1: send testId, get back sessionId
const resp1 = await submitEssay(token, {
  taskId: tasks[0].id,
  essayText: essay1,
  testId: test.id,
  visibility: "community",
});

// Task 2: send sessionId from first response
const resp2 = await submitEssay(token, {
  taskId: tasks[1].id,
  essayText: essay2,
  sessionId: resp1.sessionId!,
});
```

> AI feedback is generated in the background. Listen for the `writing-ai-feedback` SSE event or poll the AI feedback endpoint.

### My Writing Sessions

```ts
const getMyWritingSessions = async (
  token: string,
  params?: { page?: number; limit?: number }
) => {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  if (params?.limit) query.set("limit", String(params.limit));

  const res = await fetch(`${BASE_URL}/writing/my?${query}`, {
    headers: headers(token),
  });
  return res.json() as Promise<{
    data: WritingSession[];
    pagination: Pagination;
  }>;
};
```

### Get Writing Session Detail

Returns full session with responses (including AI feedback) and teacher reviews.

```ts
const getWritingSession = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/writing/sessions/${sessionId}`, {
    headers: headers(token),
  });
  return res.json() as Promise<WritingSession>;
};
```

### Delete Writing Session

```ts
const deleteWritingSession = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/writing/sessions/${sessionId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

### Get AI Feedback for a Response

```ts
const getWritingAIFeedback = async (token: string, responseId: string) => {
  const res = await fetch(`${BASE_URL}/writing/ai-feedback/${responseId}`, {
    headers: headers(token),
  });
  return res.json() as Promise<WritingAIFeedback>;
};
```

> Returns `404` with `"AI feedback not found. It may still be processing."` if not ready yet.

### Get All AI Feedbacks for a Session

Returns individual feedbacks + aggregate score and CEFR level.

```ts
const getSessionAIFeedbacks = async (token: string, sessionId: string) => {
  const res = await fetch(
    `${BASE_URL}/writing/ai-feedback/session/${sessionId}`,
    { headers: headers(token) }
  );
  return res.json() as Promise<{
    feedbacks: (WritingAIFeedback & {
      response: { id: string; task: Pick<WritingTask, "id" | "taskText" | "part"> };
    })[];
    aggregate: {
      averageOverallScore: number | null;
      cefrLevel: string | null;
      totalResponses: number;
    };
  }>;
};
```

### Submit Teacher Review (teacher/admin)

```ts
const submitWritingReview = async (
  token: string,
  sessionId: string,
  data: {
    score: number; // IELTS: 0–9 (0.5 steps) | CEFR: 1–6
    feedback?: string;
  }
) => {
  const res = await fetch(
    `${BASE_URL}/writing/sessions/${sessionId}/review`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(data),
    }
  );
  return res.json() as Promise<WritingReview>;
};
```

> Returns `409` if the teacher already reviewed this session.

### SSE Events for Writing

Listen on your existing SSE connection for these events:

| Event | Payload | When |
|-------|---------|------|
| `writing-ai-feedback` | `{ responseId: string, message: string }` | AI finished processing an essay |
| `writing-review` | `{ sessionId: string, reviewerName: string, score: number, cefrLevel: string }` | Teacher submitted a review |

**Example SSE handler:**

```ts
eventSource.addEventListener("writing-ai-feedback", (event) => {
  const data = JSON.parse(event.data);
  // Refresh AI feedback for this response
  // e.g. refetch getWritingAIFeedback(token, data.responseId)
});

eventSource.addEventListener("writing-review", (event) => {
  const data = JSON.parse(event.data);
  // Show notification: "Your writing was reviewed! Score: X, Level: Y"
  // e.g. refetch getWritingSession(token, data.sessionId)
});
```

### Push Notifications for Writing

| Trigger | Title | Body | Data |
|---------|-------|------|------|
| AI feedback ready | Writing baholandi ✍️ | AI sizning inshoingizni tekshirdi. Natijalarni ko'ring! | `{ type: "writing-ai-feedback", responseId }` |
| Teacher review | Writing tekshirildi ✅ | {name} sizning inshoingizni baholadi: {score}/{max} | `{ type: "writing-review", sessionId, score }` |

**Handle in your notification listener:**

```ts
import * as Notifications from "expo-notifications";

Notifications.addNotificationResponseReceivedListener((response) => {
  const data = response.notification.request.content.data;

  if (data.type === "writing-ai-feedback") {
    // Navigate to writing response detail
    navigation.navigate("WritingFeedback", { responseId: data.responseId });
  }

  if (data.type === "writing-review") {
    // Navigate to writing session detail
    navigation.navigate("WritingSession", { sessionId: data.sessionId });
  }
});
```
