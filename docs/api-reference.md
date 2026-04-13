# SpeakUp Community API — Expo Client Reference

All authenticated endpoints require the `Authorization: Bearer <token>` header.

```ts
const BASE_URL = "https://your-server.com/api";

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
```

---

## Table of Contents

- [TypeScript Types](#typescript-types)
- [CEFR Scoring](#cefr-scoring)
- [Auth](#auth)
- [Tests & Questions](#tests--questions)
- [Speaking (Test Sessions)](#speaking-test-sessions)
- [Reviews (Session-based)](#reviews-session-based)
- [Groups](#groups)
- [Community Feed](#community-feed)
- [Analytics (Teacher)](#analytics-teacher)
- [Teacher Verification](#teacher-verification)
- [Health Check](#health-check)
- [Error Handling](#error-handling)

---

## TypeScript Types

```ts
export interface User {
  id: string;
  username: string;
  fullName: string;
  role: "student" | "teacher" | "admin";
  verifiedTeacher: boolean;
  avatarUrl: string | null;
  gender: string | null;
  region: string | null;
}

export interface Test {
  id: number;
  title: string;
  description: string | null;
  createdAt: string;
  questions: Question[];
}

export interface Question {
  id: number;
  testId: number;
  qText: string;
  part: string;
  image: string | null;
  speakingTimer: number;
  prepTimer: number;
  createdAt: string;
}

export interface TestSession {
  id: string;
  testId: number;
  userId: string;
  visibility: "private" | "group" | "community";
  groupId: string | null;
  likes: number;
  commentsCount: number;
  scoreAvg: number | null;
  cefrLevel: string | null; // "A2" | "B1" | "B2" | "C1"
  createdAt: string;
  test?: Pick<Test, "id" | "title" | "description">;
  user?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
  responses?: SpeakingResponse[];
  reviews?: Review[];
  isLiked?: boolean;
  _count?: { responses: number; reviews?: number; comments?: number };
}

export interface SpeakingResponse {
  id: string;
  questionId: number;
  studentId: string;
  sessionId: string | null;
  localUri: string | null;
  remoteUrl: string | null;
  teacherScore: number | null;
  teacherFeedback: string | null;
  audioProcessed: boolean;
  createdAt: string;
  student?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
  question?: Pick<Question, "id" | "qText" | "part" | "speakingTimer" | "prepTimer">;
}

export interface Review {
  id: string;
  sessionId: string;
  reviewerId: string;
  score: number; // 0–75
  cefrLevel: string; // "A2" | "B1" | "B2" | "C1"
  feedback: string | null;
  createdAt: string;
  reviewer?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
}

export interface Comment {
  id: string;
  sessionId: string;
  userId: string;
  text: string;
  createdAt: string;
  user?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  referralCode: string;
  createdAt: string;
  memberCount?: number;
  myRole?: "owner" | "teacher" | "student";
}

export interface GroupMember {
  id: string;
  groupId: string;
  userId: string;
  role: "owner" | "teacher" | "student";
  joinedAt: string;
  user?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
}

export interface GroupJoinRequest {
  id: string;
  groupId: string;
  userId: string;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  user?: Pick<User, "id" | "fullName" | "username" | "avatarUrl">;
}

export interface TeacherVerification {
  id: string;
  userId: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  sessionId: string;
  userId: string;
  device: string;
  ip: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
```

---

## CEFR Scoring

Reviews use a **0–75** point scale. The CEFR level is derived automatically:

| Score Range | CEFR Level |
|-------------|------------|
| 0–37 | A2 |
| 38–50 | B1 |
| 51–64 | B2 |
| 65–75 | C1 |

The `cefrLevel` field is included in review objects and session objects (based on `scoreAvg`).

---

## Auth

### Login

```ts
const login = async (username: string, password: string) => {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.json(); // { token: string, user: User }
};
```

### Register

```ts
const register = async (data: {
  username: string;
  fullName: string;
  password: string;
  gender?: string;
  region?: string;
  avatarUrl?: string;
}) => {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json(); // 201 { token: string, user: User }
};
```

### Logout

```ts
const logout = async (token: string) => {
  const res = await fetch(`${BASE_URL}/auth/logout`, {
    method: "POST",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

### Update Profile

```ts
const updateProfile = async (
  token: string,
  data: { fullName?: string; gender?: string; region?: string }
) => {
  const res = await fetch(`${BASE_URL}/auth/profile`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // User
};
```

### Upload User Avatar

```ts
const uploadUserAvatar = async (token: string, imageUri: string) => {
  const formData = new FormData();
  formData.append("avatar", {
    uri: imageUri,
    name: "avatar.jpg",
    type: "image/jpeg",
  } as any);

  const res = await fetch(`${BASE_URL}/auth/avatar`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return res.json(); // User
};
```

### Update Push Token

```ts
const updatePushToken = async (token: string, pushToken: string) => {
  const res = await fetch(`${BASE_URL}/auth/push-token`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ pushToken }),
  });
  return res.json(); // { success: true }
};
```

### List Sessions

```ts
const getSessions = async (token: string) => {
  const res = await fetch(`${BASE_URL}/auth/sessions`, {
    headers: headers(token),
  });
  return res.json(); // { sessions: AuthSession[] }
};
```

### Revoke All Sessions

```ts
const revokeAllSessions = async (token: string) => {
  const res = await fetch(`${BASE_URL}/auth/sessions`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { revoked: number }
};
```

### Revoke Specific Session

```ts
const revokeSession = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/auth/sessions/${sessionId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

---

## Tests & Questions

### List All Tests

```ts
const getTests = async (token: string) => {
  const res = await fetch(`${BASE_URL}/tests`, {
    headers: headers(token),
  });
  return res.json(); // Test[]
};
```

### Get Single Test

```ts
const getTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}`, {
    headers: headers(token),
  });
  return res.json(); // Test
};
```

### Create Test 🔒 teacher/admin

```ts
const createTest = async (
  token: string,
  data: { title: string; description?: string }
) => {
  const res = await fetch(`${BASE_URL}/tests`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // 201 Test
};
```

### Update Test 🔒 teacher/admin

```ts
const updateTest = async (
  token: string,
  testId: number,
  data: { title?: string; description?: string }
) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // Test
};
```

### Delete Test 🔒 teacher/admin

```ts
const deleteTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { message: "Test deleted" }
};
```

> Deleting a test **cascades** to all its questions and their responses.

### List Questions for a Test

```ts
const getQuestions = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}/questions`, {
    headers: headers(token),
  });
  return res.json(); // Question[]
};
```

### Get Single Question

```ts
const getQuestion = async (token: string, questionId: number) => {
  const res = await fetch(`${BASE_URL}/tests/questions/${questionId}`, {
    headers: headers(token),
  });
  return res.json(); // Question
};
```

### Create Question 🔒 teacher/admin

```ts
const createQuestion = async (
  token: string,
  testId: number,
  data: {
    qText: string;
    part: string;
    image?: string;
    speakingTimer?: number; // default 30
    prepTimer?: number; // default 5
  }
) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}/questions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // 201 Question
};
```

### Update Question 🔒 teacher/admin

```ts
const updateQuestion = async (
  token: string,
  questionId: number,
  data: {
    qText?: string;
    part?: string;
    image?: string;
    speakingTimer?: number;
    prepTimer?: number;
  }
) => {
  const res = await fetch(`${BASE_URL}/tests/questions/${questionId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // Question
};
```

### Delete Question 🔒 teacher/admin

```ts
const deleteQuestion = async (token: string, questionId: number) => {
  const res = await fetch(`${BASE_URL}/tests/questions/${questionId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { message: "Question deleted" }
};
```

---

## Speaking (Test Sessions)

All speaking data is organized into **test sessions**. A `TestSession` represents one user taking one test. Each session contains multiple `Response` records (one per question). Reviews, likes, and comments are attached to the **session**, not individual responses.

### SSE — Real-time Events

```ts
import EventSource from "react-native-sse";

const connectSSE = (token: string) => {
  const es = new EventSource(`${BASE_URL}/speaking/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  es.addEventListener("new-speaking", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("new-review", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("new-comment", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("audio-processed", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("join-request", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("join-approved", (e) => console.log(JSON.parse(e.data)));
  es.addEventListener("join-rejected", (e) => console.log(JSON.parse(e.data)));

  return es;
};
```

### My Sessions

```ts
const mySessions = async (token: string, page = 1, limit = 20) => {
  const res = await fetch(
    `${BASE_URL}/speaking/my?page=${page}&limit=${limit}`,
    { headers: headers(token) }
  );
  return res.json();
  // { data: TestSession[], pagination: Pagination }
  // Each session includes: test { id, title, description }, _count { responses }
};
```

### Get Session Detail

Returns the full session with test info, user info, all responses (with questions), reviews, and comment count.

```ts
const getSession = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/speaking/sessions/${sessionId}`, {
    headers: headers(token),
  });
  return res.json();
  // TestSession with:
  //   test: { id, title, description }
  //   user: { id, fullName, username, avatarUrl }
  //   responses: SpeakingResponse[] (each with question details)
  //   reviews: Review[] (each with reviewer info and cefrLevel)
  //   isLiked: boolean
  //   cefrLevel: string | null
  //   _count: { comments }
};
```

### Pending Reviews 🔒 teacher

Sessions that have not been reviewed yet.

```ts
const pendingSessions = async (token: string, page = 1, limit = 20) => {
  const res = await fetch(
    `${BASE_URL}/speaking/pending?page=${page}&limit=${limit}`,
    { headers: headers(token) }
  );
  return res.json();
  // { data: TestSession[], pagination: Pagination }
  // Each session includes: user, test, _count { responses }
};
```

### Submit Audio 🔒 student

Upload a single audio response. Pass `testId` to create a new session, or `sessionId` to add to an existing one.

```ts
const submitSpeaking = async (
  token: string,
  audioUri: string,
  questionId: number,
  options: {
    visibility?: "private" | "group" | "community";
    groupId?: string;
    sessionId?: string; // add to existing session
    testId?: number; // create new session for this test
  } = {}
) => {
  const formData = new FormData();
  formData.append("audio", {
    uri: audioUri,
    name: "recording.m4a",
    type: "audio/m4a",
  } as any);
  formData.append("questionId", String(questionId));
  if (options.visibility) formData.append("visibility", options.visibility);
  if (options.groupId) formData.append("groupId", options.groupId);
  if (options.sessionId) formData.append("sessionId", options.sessionId);
  if (options.testId) formData.append("testId", String(options.testId));

  const res = await fetch(`${BASE_URL}/speaking`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return res.json();
  // 201 SpeakingResponse with sessionId
};
```

**Session creation flow:**
1. First question: pass `testId` + `visibility` + optional `groupId` → a new `TestSession` is created
2. Subsequent questions: pass the returned `sessionId` → responses are added to the same session

### Get Single Response

```ts
const getResponse = async (token: string, id: string) => {
  const res = await fetch(`${BASE_URL}/speaking/${id}`, {
    headers: headers(token),
  });
  return res.json(); // SpeakingResponse (with student, question, isLiked)
};
```

### Update Visibility

Updates the session's visibility (not the individual response).

```ts
const updateSubmission = async (
  token: string,
  id: string,
  visibility: "private" | "group" | "community"
) => {
  const res = await fetch(`${BASE_URL}/speaking/${id}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({ visibility }),
  });
  return res.json(); // SpeakingResponse
};
```

### Delete Response

```ts
const deleteSubmission = async (token: string, id: string) => {
  const res = await fetch(`${BASE_URL}/speaking/${id}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

### Like / Unlike Session

```ts
const likeSession = async (token: string, sessionId: string) => {
  const res = await fetch(
    `${BASE_URL}/speaking/sessions/${sessionId}/like`,
    { method: "POST", headers: headers(token) }
  );
  return res.json(); // { success: true }
};

const unlikeSession = async (token: string, sessionId: string) => {
  const res = await fetch(
    `${BASE_URL}/speaking/sessions/${sessionId}/like`,
    { method: "DELETE", headers: headers(token) }
  );
  return res.json(); // { success: true }
};
```

### Add Comment to Session

```ts
const addComment = async (
  token: string,
  sessionId: string,
  text: string
) => {
  const res = await fetch(
    `${BASE_URL}/speaking/sessions/${sessionId}/comment`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ text }),
    }
  );
  return res.json(); // 201 Comment
};
```

### List Session Comments

```ts
const getComments = async (
  token: string,
  sessionId: string,
  page = 1,
  limit = 20
) => {
  const res = await fetch(
    `${BASE_URL}/speaking/sessions/${sessionId}/comments?page=${page}&limit=${limit}`,
    { headers: headers(token) }
  );
  return res.json(); // { data: Comment[], pagination: Pagination }
};
```

---

## Reviews (Session-based)

Reviews are posted per **session**, not per individual response. Each reviewer can submit one review per session (upsert). Score range is **0–75** with automatic CEFR level.

### Submit / Update Review

```ts
const submitReview = async (
  token: string,
  sessionId: string,
  data: { score: number; feedback?: string } // score: 0–75
) => {
  const res = await fetch(`${BASE_URL}/reviews/${sessionId}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json();
  // 201 Review { id, sessionId, reviewerId, score, cefrLevel, feedback, createdAt, reviewer }
};
```

> Cannot review your own session. One review per reviewer per session (upserts on conflict).

### List Reviews for a Session

```ts
const getReviews = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/reviews/${sessionId}`, {
    headers: headers(token),
  });
  return res.json(); // Review[] (each with cefrLevel and reviewer info)
};
```

### Delete My Review

```ts
const deleteMyReview = async (token: string, sessionId: string) => {
  const res = await fetch(`${BASE_URL}/reviews/${sessionId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

> Deleting a review recalculates the session's `scoreAvg`.

---

## Groups

### My Groups

```ts
const myGroups = async (token: string) => {
  const res = await fetch(`${BASE_URL}/groups/my`, {
    headers: headers(token),
  });
  return res.json(); // Group[] (with member_count, myRole)
};
```

### Search Groups

```ts
const searchGroups = async (token: string, query: string) => {
  const res = await fetch(
    `${BASE_URL}/groups/search?q=${encodeURIComponent(query)}`,
    { headers: headers(token) }
  );
  return res.json();
  // [{ id, name, description, createdAt, creator, memberCount,
  //    status: "member" | "pending" | "none" }]
};
```

### Get Group

```ts
const getGroup = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}`, {
    headers: headers(token),
  });
  return res.json(); // Group (with creator, myRole)
};
```

### Get Group Members

```ts
const getGroupMembers = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/members`, {
    headers: headers(token),
  });
  return res.json(); // GroupMember[]
};
```

### Get Group Sessions (Submissions)

Returns test sessions submitted to the group, with CEFR levels.

```ts
const getGroupSessions = async (
  token: string,
  groupId: string,
  page = 1,
  limit = 20
) => {
  const res = await fetch(
    `${BASE_URL}/groups/${groupId}/submissions?page=${page}&limit=${limit}`,
    { headers: headers(token) }
  );
  return res.json();
  // { data: TestSession[] (with user, test, cefrLevel, _count), pagination: Pagination }
};
```

### Create Group 🔒 teacher/admin

```ts
const createGroup = async (
  token: string,
  data: { name: string; description?: string }
) => {
  const res = await fetch(`${BASE_URL}/groups`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // 201 Group (creator is auto-added as owner)
};
```

### Update Group 🔒 group owner/teacher

```ts
const updateGroup = async (
  token: string,
  groupId: string,
  data: { name?: string; description?: string }
) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // Group
};
```

### Delete Group 🔒 group owner

```ts
const deleteGroup = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

### Upload Group Avatar 🔒 group owner/teacher

```ts
const uploadGroupAvatar = async (
  token: string,
  groupId: string,
  imageUri: string
) => {
  const formData = new FormData();
  formData.append("avatar", {
    uri: imageUri,
    name: "avatar.jpg",
    type: "image/jpeg",
  } as any);

  const res = await fetch(`${BASE_URL}/groups/${groupId}/avatar`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  return res.json(); // Group
};
```

### Regenerate Referral Code 🔒 group owner/teacher

```ts
const regenerateCode = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/regenerate-code`, {
    method: "POST",
    headers: headers(token),
  });
  return res.json(); // { referralCode: string }
};
```

### Join via Referral Code (instant)

```ts
const joinByCode = async (token: string, referralCode: string) => {
  const res = await fetch(`${BASE_URL}/groups/join`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ referralCode }),
  });
  return res.json(); // Group
};
```

### Request to Join (needs approval)

```ts
const requestJoin = async (
  token: string,
  groupId: string,
  message?: string
) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/request-join`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ message }),
  });
  return res.json(); // 201 GroupJoinRequest
};
```

### List Join Requests 🔒 group owner/teacher

```ts
const getJoinRequests = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/join-requests`, {
    headers: headers(token),
  });
  return res.json(); // GroupJoinRequest[]
};
```

### Approve Join Request 🔒 group owner/teacher

```ts
const approveJoin = async (
  token: string,
  groupId: string,
  requestId: string,
  role: "student" | "teacher" = "student"
) => {
  const res = await fetch(
    `${BASE_URL}/groups/${groupId}/approve-join/${requestId}`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ role }),
    }
  );
  return res.json(); // { success: true }
};
```

### Reject Join Request 🔒 group owner/teacher

```ts
const rejectJoin = async (
  token: string,
  groupId: string,
  requestId: string
) => {
  const res = await fetch(
    `${BASE_URL}/groups/${groupId}/reject-join/${requestId}`,
    {
      method: "POST",
      headers: headers(token),
    }
  );
  return res.json(); // { success: true }
};
```

### Add Teacher to Group 🔒 group owner

```ts
const addTeacher = async (
  token: string,
  groupId: string,
  userId: string
) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/add-teacher`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ userId }),
  });
  return res.json(); // { success: true }
};
```

### Leave Group

```ts
const leaveGroup = async (token: string, groupId: string) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/leave`, {
    method: "POST",
    headers: headers(token),
  });
  return res.json(); // { success: true }
};
```

### Remove Member 🔒 group owner/teacher

```ts
const removeMember = async (
  token: string,
  groupId: string,
  userId: string
) => {
  const res = await fetch(`${BASE_URL}/groups/${groupId}/remove-member`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ userId }),
  });
  return res.json(); // { success: true }
};
```

---

## Community Feed

The community feed shows **test sessions** with `visibility: "community"`.

### Get Feed

```ts
const getCommunityFeed = async (
  token: string,
  strategy: "latest" | "trending" | "top" = "latest",
  page = 1,
  limit = 20
) => {
  const res = await fetch(
    `${BASE_URL}/community/feed?strategy=${strategy}&page=${page}&limit=${limit}`,
    { headers: headers(token) }
  );
  return res.json();
  // { data: TestSession[] (with user, test, cefrLevel, isLiked, _count), pagination, strategy }
};
```

| Strategy | Behavior |
|----------|----------|
| `latest` | Newest first |
| `trending` | Last 7 days, sorted by likes + comments |
| `top` | All time, sorted by `scoreAvg` descending |

---

## Analytics (Teacher)

> All analytics endpoints require `teacher` role.

### Overview

```ts
const getOverview = async (token: string) => {
  const res = await fetch(`${BASE_URL}/analytics/overview`, {
    headers: headers(token),
  });
  return res.json();
  // { totalSubmissions, totalReviews, totalStudents, avgScore,
  //   todaySubmissions, todayReviews }
};
```

### Submissions Over Time

```ts
const getSubmissionStats = async (token: string, days = 30) => {
  const res = await fetch(`${BASE_URL}/analytics/submissions?days=${days}`, {
    headers: headers(token),
  });
  return res.json(); // [{ date: string, count: number }]
};
```

### Score Trends

```ts
const getScoreStats = async (token: string, days = 30) => {
  const res = await fetch(`${BASE_URL}/analytics/scores?days=${days}`, {
    headers: headers(token),
  });
  return res.json(); // [{ date, avg_score, review_count }]
};
```

### Teacher Activity

```ts
const getTeacherActivity = async (token: string, days = 30) => {
  const res = await fetch(
    `${BASE_URL}/analytics/teacher-activity?days=${days}`,
    { headers: headers(token) }
  );
  return res.json(); // [{ id, name, avatar_url, reviews_given, avg_score_given }]
};
```

---

## Teacher Verification

### Request Verification

```ts
const requestTeacherVerification = async (
  token: string,
  reason?: string
) => {
  const res = await fetch(`${BASE_URL}/teacher-verification`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ reason }),
  });
  return res.json(); // 201 TeacherVerification
};
```

### Check My Verification Status

```ts
const myVerificationStatus = async (token: string) => {
  const res = await fetch(`${BASE_URL}/teacher-verification/me`, {
    headers: headers(token),
  });
  return res.json(); // TeacherVerification (or 404)
};
```

### List All Requests 🔒 admin

```ts
const listVerifications = async (
  token: string,
  status?: "pending" | "approved" | "rejected"
) => {
  const url = status
    ? `${BASE_URL}/teacher-verification?status=${status}`
    : `${BASE_URL}/teacher-verification`;
  const res = await fetch(url, { headers: headers(token) });
  return res.json(); // TeacherVerification[] (with user info)
};
```

### Approve / Reject 🔒 admin

```ts
const reviewVerification = async (
  token: string,
  id: string,
  data: { status: "approved" | "rejected"; reviewNote?: string }
) => {
  const res = await fetch(`${BASE_URL}/teacher-verification/${id}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // TeacherVerification
};
```

> When approved, the user's role is set to `teacher` and `verifiedTeacher` becomes `true`.

---

## Health Check

```ts
const healthCheck = async () => {
  const res = await fetch(`${BASE_URL}/health`);
  return res.json(); // { status: "ok" }
};
```

---

## Error Handling

All errors return:

```json
{ "error": "Error message here" }
```

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid required fields |
| `401` | Invalid or missing token |
| `403` | Role not allowed |
| `404` | Resource not found |
| `409` | Conflict (duplicate, already exists) |
| `500` | Server error |

**Recommended Expo helper:**

```ts
async function api<T>(
  url: string,
  token: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers(token),
      ...options?.headers,
    },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data as T;
}
```
