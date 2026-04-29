# Threads API — Expo Integration Guide

Base URL: `https://<your-server>/api/threads`  
All endpoints require `Authorization: Bearer <jwt>`.

---

## Types

```ts
type ThreadVisibility = 'public' | 'followers';
type MediaType = 'image' | 'video';

interface ThreadMedia {
  id: string;
  type: MediaType;
  url: string;           // empty string ('') while video is processing
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSecs: number | null;
  mimeType: string;
  order: number;
  processing?: boolean;  // true when video compression is in progress
}

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
  parentId: string | null;   // null for root threads
  rootId: string | null;
  visibility: ThreadVisibility;
  likesCount: number;
  repliesCount: number;
  repostsCount: number;
  likedByMe: boolean;
  repostedByMe: boolean;
  createdAt: string;         // ISO 8601
  updatedAt: string;
}

interface PaginatedThreads {
  threads: Thread[];
  nextCursor: string | null;  // pass as ?cursor= for the next page
}
```

---

## Creating a Thread

### `POST /api/threads`

Send a `multipart/form-data` request.

| Field        | Type                          | Required | Notes                                    |
|--------------|-------------------------------|----------|------------------------------------------|
| `text`       | string                        | No*      | Thread body. Required if no media.       |
| `visibility` | `"public"` \| `"followers"`   | No       | Defaults to `"public"`.                  |
| `media`      | File[]                        | No*      | Up to 4 images **or** 1 video.           |

\* At least one of `text` or `media` must be provided.

**Accepted MIME types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`  
**Max file size:** 200 MB per file.

**Rules:**
- Max **4 images** per thread.
- Max **1 video** per thread — cannot be mixed with images.

```ts
import * as ImagePicker from 'expo-image-picker';

async function createThread(
  token: string,
  text: string,
  assets: ImagePicker.ImagePickerAsset[],
  visibility: ThreadVisibility = 'public',
): Promise<Thread> {
  const form = new FormData();
  form.append('text', text);
  form.append('visibility', visibility);

  for (const asset of assets) {
    const ext = asset.uri.split('.').pop() ?? 'jpg';
    const mimeType = asset.type === 'video' ? `video/${ext}` : `image/${ext}`;
    form.append('media', {
      uri: asset.uri,
      name: `media.${ext}`,
      type: mimeType,
    } as any);
  }

  const res = await fetch('https://<server>/api/threads', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

**Response `201`:** A `Thread` object.  
If a video was attached, the media item will have `processing: true` and `url: ''`. Listen on the SSE stream (see below) to receive the final URL.

---

## Replying to a Thread

### `POST /api/threads/:id/reply`

Same `multipart/form-data` body as creating a thread.

```ts
async function replyToThread(
  token: string,
  parentId: string,
  text: string,
  assets: ImagePicker.ImagePickerAsset[] = [],
): Promise<Thread> {
  const form = new FormData();
  if (text) form.append('text', text);
  for (const asset of assets) {
    const ext = asset.uri.split('.').pop() ?? 'jpg';
    form.append('media', { uri: asset.uri, name: `media.${ext}`, type: `image/${ext}` } as any);
  }

  const res = await fetch(`https://<server>/api/threads/${parentId}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

---

## Reading Threads

### `GET /api/threads/feed` — Followed-user feed
Returns root-level threads from users the current user follows (includes own threads).

### `GET /api/threads/discover` — Public discovery feed
Returns all public root-level threads.

### `GET /api/threads/user/:userId` — A user's threads
Returns root-level threads by a specific user. Threads with `visibility: "followers"` are hidden unless the viewer follows that user.

**Pagination** (all three feeds):

| Query Param | Type   | Default | Notes                            |
|-------------|--------|---------|----------------------------------|
| `cursor`    | string | —       | `id` of the last item received.  |
| `limit`     | number | 20      | Max 50.                          |

```ts
async function fetchFeed(
  token: string,
  cursor?: string,
): Promise<PaginatedThreads> {
  const url = new URL('https://<server>/api/threads/feed');
  if (cursor) url.searchParams.set('cursor', cursor);
  url.searchParams.set('limit', '20');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}
```

### `GET /api/threads/:id` — Single thread

```ts
const res = await fetch(`https://<server>/api/threads/${id}`, {
  headers: { Authorization: `Bearer ${token}` },
});
```

Returns `403` if the thread is `visibility: "followers"` and the viewer doesn't follow the author.

### `GET /api/threads/:id/replies` — Paginated replies

Same `cursor` / `limit` query params. Returns `{ replies: Thread[], nextCursor }`.

---

## Liking

### `POST /api/threads/:id/like`

Toggles like. No request body needed.

```ts
const res = await fetch(`https://<server>/api/threads/${id}/like`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
});
const { liked } = await res.json(); // boolean
```

---

## Reposting

### `POST /api/threads/:id/repost`

Toggles repost. Optionally include a quote.

```ts
const res = await fetch(`https://<server>/api/threads/${id}/repost`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ quoteText: 'Great point!' }),  // optional
});
const { reposted } = await res.json(); // boolean
```

Cannot repost your own thread (returns `400`).

---

## Deleting a Thread

### `DELETE /api/threads/:id`

Soft-deletes the thread. Only the author or an admin may delete.

```ts
await fetch(`https://<server>/api/threads/${id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});
```

---

## Real-time Video Processing (SSE)

When a thread is created with a video, the server immediately queues compression in the background. The HTTP response contains the thread with `media[n].processing = true` and `url: ''`.

Connect to the SSE stream to receive the final URL:

```
GET /api/speaking/events
Authorization: Bearer <jwt>
```

> The SSE endpoint is shared across all server-sent features. Use the `event` field to filter.

### Events

| Event name        | When fired                      |
|-------------------|---------------------------------|
| `video:processing`| Compression job has started     |
| `video:ready`     | Compression finished, URL ready |
| `video:error`     | Compression failed              |

### Payloads

```ts
// video:processing
{ mediaId: string; status: 'processing' }

// video:ready
{ mediaId: string; url: string; thumbnailUrl: string | null; durationSecs: number }

// video:error
{ mediaId: string; error: string }
```

### Expo implementation

```ts
import { useEffect, useRef } from 'react';
import { useThreadsStore } from '../store/threads'; // your Zustand/Redux store

export function useVideoSSE(token: string) {
  const esRef = useRef<EventSource | null>(null);
  const updateMedia = useThreadsStore((s) => s.updateMedia);

  useEffect(() => {
    const es = new EventSource(
      `https://<server>/api/speaking/events`,
      // Pass the token via a query param if your server supports it,
      // or switch to a polyfill that supports custom headers (see note below).
    );

    es.addEventListener('video:ready', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      // { mediaId, url, thumbnailUrl, durationSecs }
      updateMedia(data.mediaId, {
        url: data.url,
        thumbnailUrl: data.thumbnailUrl,
        durationSecs: data.durationSecs,
        processing: false,
      });
    });

    es.addEventListener('video:error', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      updateMedia(data.mediaId, { processing: false, url: '' });
      console.warn('Video processing failed:', data.error);
    });

    esRef.current = es;
    return () => es.close();
  }, [token]);
}
```

> **Note on auth headers with EventSource:**  
> The browser/Expo `EventSource` does not support custom headers. Use the [`react-native-sse`](https://github.com/binaryminds/react-native-sse) package which accepts a `headers` option, or pass the JWT as a `?token=` query parameter and validate it on the server.

---

## Rendering video with `processing` state

```tsx
import { Video } from 'expo-av';

function ThreadMediaItem({ item }: { item: ThreadMedia }) {
  if (item.type === 'video') {
    if (item.processing || !item.url) {
      return <VideoProcessingPlaceholder thumbnail={item.thumbnailUrl} />;
    }
    return (
      <Video
        source={{ uri: item.url }}
        posterSource={item.thumbnailUrl ? { uri: item.thumbnailUrl } : undefined}
        useNativeControls
        style={{ width: '100%', aspectRatio: 16 / 9 }}
      />
    );
  }
  return <Image source={{ uri: item.url }} />;
}
```

---

## Error Responses

All errors follow the shape `{ error: string }`.

| Status | Meaning                                                    |
|--------|------------------------------------------------------------|
| 400    | Validation error (missing fields, too many files, etc.)    |
| 403    | Not allowed to view followers-only thread                  |
| 404    | Thread not found or deleted                               |
| 500    | Internal server error                                      |
