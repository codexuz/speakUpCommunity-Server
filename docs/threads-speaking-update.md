# Threads & Speaking — Expo App Update Notes
**Server version:** April 30, 2026

---

## 1. Threads

### 1.1 Thread / Reply object shape

All thread and reply endpoints return the same shape:

```json
{
  "id": "string (BigInt as string)",
  "author": {
    "id": "uuid",
    "username": "string",
    "fullName": "string",
    "avatarUrl": "string | null",
    "verifiedTeacher": "boolean"
  },
  "text": "string | null",
  "media": [
    {
      "id": "string",
      "type": "image | video",
      "url": "string",
      "thumbnailUrl": "string | null",
      "width": "number | null",
      "height": "number | null",
      "durationSecs": "number | null",
      "mimeType": "string",
      "order": "number",
      "processing": "boolean (video only, present while compressing)"
    }
  ],
  "parentId": "string | null",
  "rootId": "string | null",
  "visibility": "public | followers",
  "likesCount": "number",
  "repliesCount": "number",
  "repostsCount": "number",
  "likedByMe": "boolean",
  "repostedByMe": "boolean",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

> **Media upload rules:** up to 4 images **or** 1 video per thread/reply. Images and video cannot be mixed. Max file size 200 MB. Use `multipart/form-data` with field name `media`.

---

### 1.2 Endpoints

All endpoints require `Authorization: Bearer <token>`.

#### Feeds

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/threads/feed` | Following feed (own + followed users' root threads) |
| `GET` | `/api/threads/discover` | Public discovery feed (all public root threads) |
| `GET` | `/api/threads/user/:userId` | Root threads by a specific user |

**Pagination** (cursor-based, all feed endpoints):
```
?cursor=<lastId>&limit=20   (max 50)
```
Response:
```json
{ "threads": [...], "nextCursor": "string | null" }
```

---

#### Create

**`POST /api/threads`** — create a root thread  
`multipart/form-data`

| Field | Type | Required |
|-------|------|----------|
| `text` | string | if no media |
| `visibility` | `public` \| `followers` | no (default `public`) |
| `media` | file[] | if no text |

---

**`POST /api/threads/:id/reply`** — reply to a thread  
Same fields as create. `parentId` is taken from the URL param.  
- `repliesCount` on the parent is **atomically incremented** in the same transaction.

---

#### Read

**`GET /api/threads/:id`** — single thread or reply  
Returns 403 if visibility is `followers` and the viewer does not follow the author.

**`GET /api/threads/:id/replies`** — paginated replies  
```
?cursor=<lastId>&limit=20
```
Response: `{ "replies": [...], "nextCursor": "string | null" }`

---

#### Edit (new)

**`PATCH /api/threads/:id`** — edit text or visibility (author only)

Request body (JSON):
```json
{
  "text": "Updated text",
  "visibility": "followers"
}
```
- Both fields are optional but at least one must be provided.
- Cannot clear `text` if the thread has no media.
- Returns the full updated thread object.

---

#### Delete (updated)

**`DELETE /api/threads/:id`** — soft-delete (author or admin)

When deleting a **reply**:
- Parent's `repliesCount` is **decremented** atomically.
- All likes on the deleted node are removed so the `likesCount` stays consistent.

Response: `{ "success": true }`

---

#### Interactions

**`POST /api/threads/:id/like`** — toggle like  
Response: `{ "liked": true | false }`

**`POST /api/threads/:id/repost`** — toggle repost  
Optional body: `{ "quoteText": "string" }`  
Response: `{ "reposted": true | false }`  
> Cannot repost your own thread.

---

#### Reports (new)

**`POST /api/threads/:id/report`** — report a thread or reply

Request body:
```json
{ "reason": "Spam / hate speech / etc." }
```
- One report per user per thread (returns `409` if already reported).
- Cannot report your own thread.

Response: `{ "reported": true }`

---

**`DELETE /api/threads/:id/report`** — retract own report  
Response: `{ "deleted": true }`

---

### 1.3 What changed vs. the previous version

| Area | Change |
|------|--------|
| `PATCH /:id` | **New.** Edit text and/or visibility on any thread or reply. |
| `DELETE /:id` | Now decrements parent `repliesCount` and clears likes atomically when a reply is deleted. |
| `POST /:id/report` | **New.** Submit a moderation report with a reason string. |
| `DELETE /:id/report` | **New.** Retract your own report. |

---

---

## 2. Speaking

### 2.1 Visibility options (breaking change)

The `group` visibility value has been **removed**. Accepted values are now:

| Value | Meaning |
|-------|---------|
| `private` | Only the student (and teachers/admins) can view |
| `community` | Visible to everyone *(default)* |
| `ai_only` | Only the AI processes it; not shown in any feed |

Update any picker/selector in the app to remove the `group` option.

---

### 2.2 Submit a recording

**`POST /api/speaking`** — student only, `multipart/form-data`

| Field | Type | Required |
|-------|------|----------|
| `questionId` | number string | yes |
| `audio` | file (m4a / wav / webm) | recommended |
| `visibility` | `private` \| `community` \| `ai_only` | no (default `community`) |
| `sessionId` | string | use existing session |
| `testId` | number string | create a new session for this test |
| `isAnonymous` | `true` \| `false` | no |


After upload:
1. Audio is stored and compressed in the background.
2. **AI feedback is automatically generated** (Deepgram → OpenAI) and stored against the response.
3. No group notification is sent — the group mechanism has been removed.

---

### 2.3 Session detail — `checks` array (new)

**`GET /api/speaking/sessions/:sessionId`**

The response now includes a unified `checks` array that combines **AI feedback** and **teacher reviews** in one list. Each entry has a `label` field identifying its source.

#### Access rules (simplified)

- Owner (student who submitted) — always allowed
- Teacher or Admin — always allowed  
- Anyone else — only if `visibility === 'community'`

#### Response shape

```json
{
  "id": "string",
  "examType": "cefr | ielts",
  "visibility": "private | community | ai_only",
  "scoreAvg": "number | null",
  "cefrLevel": "A2 | B1 | B2 | C1 | C2 | null",
  "isLiked": "boolean",
  "test": { "id": "number", "title": "string", "description": "string | null" },
  "user": { "id": "uuid", "fullName": "string", "username": "string", "avatarUrl": "string | null" },
  "responses": [
    {
      "id": "string",
      "questionId": "number",
      "remoteUrl": "string | null",
      "audioProcessed": "boolean",
      "createdAt": "ISO timestamp",
      "question": {
        "id": "number",
        "qText": "string",
        "part": "string",
        "speakingTimer": "number",
        "prepTimer": "number"
      }
    }
  ],
  "checks": [
    {
      "label": "AI",
      "responseId": "string",
      "score": "number (exam-native scale, see 2.4)",
      "level": "A2 | B1 | B2 | C1 | C2",
      "overallScore": "number (0–100 internal)",
      "grammarScore": "number (0–100)",
      "fluencyScore": "number (0–100)",
      "vocabDiversity": "number (0–100)",
      "pronScore": "number (0–100)",
      "fluencyWPM": "number",
      "pauseCount": "number",
      "aiSummary": "string",
      "naturalness": "string",
      "transcript": "string",
      "grammarIssues": [
        { "original": "string", "corrected": "string", "explanation": "string" }
      ],
      "vocabSuggestions": [
        { "word": "string", "alternatives": ["string"], "context": "string" }
      ],
      "pronIssues": [
        { "word": "string", "issue": "string", "tip": "string" }
      ],
      "fillerWords": { "um": 2, "like": 1 }
    },
    {
      "label": "TEACHER",
      "id": "string",
      "reviewer": { "id": "uuid", "fullName": "string", "avatarUrl": "string | null" },
      "score": "number (exam-native scale)",
      "level": "A2 | B1 | B2 | C1 | C2",
      "feedback": "string | null",
      "createdAt": "ISO timestamp"
    }
  ],
  "_count": { "comments": "number" }
}
```

> **Rendering tip:** use `check.label === 'AI'` vs `'TEACHER'` to render different badge styles. Both expose a `score` on the same native scale and a `level` string ready for display.

---

### 2.4 Score scales

| Exam type | AI `score` field | Teacher `score` field | Level mapping |
|-----------|------------------|-----------------------|---------------|
| `cefr` | 0 – 75 (integer) | 0 – 75 | ≤37 → A2, ≤51 → B1, ≤65 → B2, >65 → C1 |
| `ielts` | 0 – 9 (0.5 steps) | 0 – 9 (0.5 steps) | ≤3.5 → A2, ≤4.5 → B1, ≤6.0 → B2, ≤7.5 → C1, >7.5 → C2 |

The `level` string is pre-computed by the server — you can render it directly.

---

### 2.5 Other endpoints (unchanged)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/speaking/events` | SSE stream for real-time events |
| `GET` | `/api/speaking/my` | Current user's sessions (paginated) |
| `GET` | `/api/speaking/pending` | **Teacher only** — all unreviewed sessions (no group filter) |
| `GET` | `/api/speaking/:id` | Single response detail |
| `PUT` | `/api/speaking/sessions/:sessionId` | Update visibility (`private \| community \| ai_only`) |
| `DELETE` | `/api/speaking/:id` | Delete a response |
| `DELETE` | `/api/speaking/sessions/:sessionId` | Delete a session and all its responses |
| `POST` | `/api/speaking/sessions/:sessionId/like` | Like a session |
| `DELETE` | `/api/speaking/sessions/:sessionId/like` | Unlike a session |
| `POST` | `/api/speaking/sessions/:sessionId/comment` | Add a comment |
| `PUT` | `/api/speaking/comments/:commentId` | Edit own comment |
| `DELETE` | `/api/speaking/comments/:commentId` | Delete own comment |
| `GET` | `/api/speaking/sessions/:sessionId/comments` | Paginated comments |

---

### 2.6 What changed vs. the previous version

| Area | Change |
|------|--------|
| `group` visibility | **Removed** from all submission and update endpoints. |
| Group membership checks | **Removed** from `POST /`, `GET /:id`, `GET /sessions/:sessionId`. |
| `GET /pending` | Now returns **all** unreviewed sessions across all students (no group scoping). |
| AI feedback | **New `score` field** in exam-native scale (CEFR 0–75 / IELTS 0–9 in 0.5 steps) stored and returned. |
| `GET /sessions/:sessionId` | Returns `checks` array (AI + TEACHER items with `label`). `aiFeedback` is no longer nested inside each response. `reviews` key removed. |
| `PUT /sessions/:sessionId` | Visibility enum restricted to `private | community | ai_only`. |

---

## 3. Recommended Expo migration checklist

- [ ] Remove `group` from all speaking visibility pickers
- [ ] Remove `groupId` from `POST /api/speaking` form data
- [ ] Update `GET /api/speaking/sessions/:id` consumer to read `checks[]` instead of separate `reviews[]` and per-response `aiFeedback`
- [ ] Render `check.label` badge: `AI` (purple/gradient) vs `TEACHER` (blue/verified)
- [ ] Display `check.score` with unit: e.g. `"6.5 / 9"` for IELTS, `"58 / 75"` for CEFR
- [ ] Display `check.level` as a band chip (A2 / B1 / B2 / C1 / C2)
- [ ] On thread delete, optimistically decrement parent's `repliesCount` in local state
- [ ] Add report sheet: `POST /api/threads/:id/report` with reason picker
- [ ] Add edit sheet for own threads/replies: `PATCH /api/threads/:id`
