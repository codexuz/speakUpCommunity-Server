# Threads — Save / Bookmark Update
**Server version:** April 30, 2026

---

## Overview

Reposts have been **removed** and replaced with a **save (bookmark)** feature. Users can now save any thread for personal reference; saved threads are private and only visible to the user who saved them.

### Breaking changes at a glance

| Area | Before | After |
|------|--------|-------|
| Thread field | `repostsCount: number` | `savesCount: number` |
| Thread field | `repostedByMe: boolean` | `savedByMe: boolean` |
| Thread field | `reposts: Repost[]` | _removed_ |
| Endpoint | `POST /api/threads/:id/repost` | `POST /api/threads/:id/save` |
| Endpoint | _(none)_ | `GET /api/threads/saved` _(new)_ |

---

## Updated Thread Object

```ts
interface Thread {
  id: string;
  author: {
    id: string;
    username: string;
    fullName: string;
    avatarUrl: string | null;
    verifiedTeacher: boolean;
  };
  text: string | null;
  media: ThreadMedia[];
  parentId: string | null;
  rootId: string | null;
  visibility: 'public' | 'followers';
  likesCount: number;
  repliesCount: number;
  savesCount: number;       // was repostsCount
  likedByMe: boolean;
  savedByMe: boolean;       // was repostedByMe
  createdAt: string;        // ISO 8601
  updatedAt: string;
}
```

> The `reposts` array that was previously embedded in the thread object has been removed entirely.

---

## Endpoints

### `POST /api/threads/:id/save` — Toggle save

Saves or un-saves a thread. No request body required.

**Rules:**
- Any authenticated user can save any thread (including their own).
- Calling the endpoint again on an already-saved thread removes the save (toggle).

```ts
async function toggleSave(token: string, threadId: string): Promise<{ saved: boolean }> {
  const res = await fetch(`https://<server>/api/threads/${threadId}/save`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json(); // { saved: true } or { saved: false }
}
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{ "saved": true }` | Thread was saved |
| 200 | `{ "saved": false }` | Save was removed |
| 404 | `{ "error": "Thread not found" }` | Thread does not exist or is deleted |

---

### `GET /api/threads/saved` — List saved threads

Returns the current user's saved threads in reverse-save order (most recently saved first). Cursor-based pagination.

**Query params:**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `cursor` | string | — | `id` of the last save record received |
| `limit` | number | 20 | Max 50 |

**Response:**

```ts
interface PaginatedThreads {
  threads: Thread[];
  nextCursor: string | null;
}
```

Threads that were soft-deleted after being saved are automatically excluded from the response.

```ts
async function fetchSavedThreads(
  token: string,
  cursor?: string,
  limit = 20,
): Promise<PaginatedThreads> {
  const url = new URL('https://<server>/api/threads/saved');
  if (cursor) url.searchParams.set('cursor', cursor);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

---

## UI Migration Guide

### Save button

Replace the repost button with a bookmark / save button that reads `thread.savedByMe`.

```tsx
function SaveButton({ thread, token }: { thread: Thread; token: string }) {
  const [saved, setSaved] = React.useState(thread.savedByMe);
  const [count, setCount] = React.useState(thread.savesCount);

  async function handlePress() {
    const prev = saved;
    // Optimistic update
    setSaved(!saved);
    setCount((c) => (prev ? c - 1 : c + 1));
    try {
      const result = await toggleSave(token, thread.id);
      setSaved(result.saved);
      setCount((c) => (result.saved !== prev ? (result.saved ? c + 1 : c - 1) : c));
    } catch {
      // Revert on failure
      setSaved(prev);
      setCount((c) => (prev ? c + 1 : c - 1));
    }
  }

  return (
    <Pressable onPress={handlePress}>
      <BookmarkIcon filled={saved} />
      <Text>{count}</Text>
    </Pressable>
  );
}
```

### Saved threads screen

```tsx
import { FlashList } from '@shopify/flash-list';

function SavedThreadsScreen({ token }: { token: string }) {
  const [threads, setThreads] = React.useState<Thread[]>([]);
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [hasMore, setHasMore] = React.useState(true);

  async function loadMore() {
    if (!hasMore) return;
    const data = await fetchSavedThreads(token, cursor);
    setThreads((prev) => [...prev, ...data.threads]);
    setCursor(data.nextCursor ?? undefined);
    setHasMore(data.nextCursor !== null);
  }

  React.useEffect(() => { loadMore(); }, []);

  return (
    <FlashList
      data={threads}
      renderItem={({ item }) => <ThreadCard thread={item} token={token} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      estimatedItemSize={120}
    />
  );
}
```

---

## Store / State Updates

If you store threads in Zustand, Redux, or a similar store, update the relevant slices:

```ts
// Remove
repostsCount: number;
repostedByMe: boolean;

// Add
savesCount: number;
savedByMe: boolean;
```

Remove any `reposts` array handling — it is no longer returned by the server.

When toggling a save, apply the optimistic update pattern shown above and reconcile with the server response.
