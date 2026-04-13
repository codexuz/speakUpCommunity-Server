# Tests & Questions API — Expo Usage Guide

All endpoints require a valid JWT token in the `Authorization` header.

```ts
const BASE_URL = "https://your-server.com/api";

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
```

---

## Tests

### List all tests (with questions)

```ts
const getTests = async (token: string) => {
  const res = await fetch(`${BASE_URL}/tests`, {
    headers: headers(token),
  });
  return res.json();
};
```

**Response**

```json
[
  {
    "id": 1,
    "title": "IELTS Speaking Mock 1",
    "description": "Full 3-part mock test",
    "createdAt": "2026-04-13T00:00:00.000Z",
    "questions": [
      {
        "id": 1,
        "testId": 1,
        "qText": "Describe your hometown.",
        "part": "part1",
        "image": null,
        "speakingTimer": 30,
        "prepTimer": 5,
        "createdAt": "2026-04-13T00:00:00.000Z"
      }
    ]
  }
]
```

---

### Get single test

```ts
const getTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}`, {
    headers: headers(token),
  });
  return res.json();
};
```

---

### Create a test 🔒 teacher / admin

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
  return res.json(); // 201
};
```

| Field         | Type     | Required |
| ------------- | -------- | -------- |
| `title`       | `string` | Yes      |
| `description` | `string` | No       |

---

### Update a test 🔒 teacher / admin

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
  return res.json();
};
```

Only include the fields you want to change — the rest stay untouched.

---

### Delete a test 🔒 teacher / admin

```ts
const deleteTest = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  return res.json(); // { message: "Test deleted" }
};
```

> Deleting a test **cascades** — all its questions (and their responses) are also removed.

---

## Questions

### List questions for a test

```ts
const getQuestions = async (token: string, testId: number) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}/questions`, {
    headers: headers(token),
  });
  return res.json();
};
```

---

### Get single question

```ts
const getQuestion = async (token: string, questionId: number) => {
  const res = await fetch(`${BASE_URL}/tests/questions/${questionId}`, {
    headers: headers(token),
  });
  return res.json();
};
```

---

### Create a question 🔒 teacher / admin

```ts
const createQuestion = async (
  token: string,
  testId: number,
  data: {
    qText: string;
    part: string;
    image?: string;
    speakingTimer?: number;
    prepTimer?: number;
  }
) => {
  const res = await fetch(`${BASE_URL}/tests/${testId}/questions`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(data),
  });
  return res.json(); // 201
};
```

| Field           | Type     | Required | Default |
| --------------- | -------- | -------- | ------- |
| `qText`         | `string` | Yes      | —       |
| `part`          | `string` | Yes      | —       |
| `image`         | `string` | No       | `null`  |
| `speakingTimer` | `number` | No       | `30`    |
| `prepTimer`     | `number` | No       | `5`     |

---

### Update a question 🔒 teacher / admin

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
  return res.json();
};
```

---

### Delete a question 🔒 teacher / admin

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

## Error responses

All endpoints return errors in the same shape:

```json
{ "error": "Error message here" }
```

| Status | Meaning                                     |
| ------ | ------------------------------------------- |
| `400`  | Missing required fields                     |
| `401`  | Invalid / missing token                     |
| `403`  | Role not allowed (need teacher or admin)    |
| `404`  | Resource not found                          |
| `500`  | Server error                                |

---

## TypeScript types (for the Expo app)

```ts
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
```
