# Group Chat — Expo Client Reference

Real-time group messaging with text, images, videos, and file attachments.  
Uses **REST API** for CRUD and **Socket.IO (WebSocket)** for real-time delivery, typing indicators, and read receipts.

---

## Installation

```bash
npx expo install socket.io-client
```

---

## TypeScript Types

```ts
export type MessageType = "text" | "image" | "video" | "file" | "system";

export type EntityType =
  | "mention"    // @username
  | "hashtag"    // #tag
  | "url"        // auto-detected URL
  | "bold"       // **bold**
  | "italic"     // *italic*
  | "underline"  // __underline__
  | "code"       // `inline code`
  | "pre"        // ```code block```
  | "text_link"  // clickable text with custom URL
  | "text_mention"; // mention with user reference

export interface MessageEntity {
  type: EntityType;
  offset: number;  // start position in text (UTF-16 code units)
  length: number;  // length of entity (UTF-16 code units)
  url?: string;    // only for text_link
  userId?: string; // only for text_mention
}

export interface ChatAttachment {
  id: string;
  messageId: string;
  url: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
}

export interface ChatSender {
  id: string;
  fullName: string;
  username: string;
  avatarUrl: string | null;
}

export interface ChatMessage {
  id: string;
  groupId: string;
  senderId: string;
  type: MessageType;
  text: string | null;
  entities: MessageEntity[] | null;
  replyToId: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  sender: ChatSender;
  attachments: ChatAttachment[];
  replyTo: {
    id: string;
    text: string | null;
    type: MessageType;
    sender: Pick<ChatSender, "id" | "fullName" | "username">;
  } | null;
}

export interface UnreadCount {
  groupId: string;
  unreadCount: number;
  lastMessage: {
    id: string;
    text: string | null;
    type: MessageType;
    createdAt: string;
    sender: Pick<ChatSender, "id" | "fullName" | "username">;
  } | null;
}

export interface PaginatedMessages {
  data: ChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedAttachments {
  data: (ChatAttachment & {
    message: {
      id: string;
      senderId: string;
      type: MessageType;
      createdAt: string;
      sender: Pick<ChatSender, "id" | "fullName" | "username">;
    };
  })[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

---

## Socket.IO — Real-Time Connection

### Connect

```ts
import { io, Socket } from "socket.io-client";

const BASE_URL = "https://your-server.com";

let socket: Socket;

export function connectChat(token: string) {
  socket = io(BASE_URL, {
    path: "/ws/chat",
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on("connect", () => {
    console.log("Chat connected:", socket.id);
  });

  socket.on("connect_error", (err) => {
    console.error("Chat connection error:", err.message);
    // If "Token revoked" or "Session revoked", redirect to login
  });

  return socket;
}

export function disconnectChat() {
  socket?.disconnect();
}
```

> **On connect**, the server automatically joins the user to all their group rooms. No manual join needed for groups they already belong to.

### Listen for Events

```ts
// New message in any joined group
socket.on("new-message", (message: ChatMessage) => {
  // Append to chat list if message.groupId matches current screen
});

// Message was edited
socket.on("message-edited", (message: ChatMessage) => {
  // Update the message in your local state by message.id
});

// Message was deleted
socket.on("message-deleted", (data: { groupId: string; messageId: string }) => {
  // Mark message as deleted in local state or remove it
});

// Typing indicators
socket.on("user-typing", (data: {
  groupId: string;
  userId: string;
  username: string;
  isTyping: boolean;
}) => {
  // Show/hide "username is typing..." in the chat header
});

// Read receipts
socket.on("messages-read", (data: {
  groupId: string;
  userId: string;
  lastMessageId: string;
}) => {
  // Update read status checkmarks for messages up to lastMessageId
});

// Room join confirmation
socket.on("joined-group", (data: { groupId: string }) => {
  console.log("Joined group room:", data.groupId);
});
```

### Emit Events

```ts
// Typing indicator — call on text input change
socket.emit("typing", { groupId: "xxx", isTyping: true });
// Call with isTyping: false when user stops typing (e.g. debounce 2s)

// Mark messages as read — call when user views latest messages
socket.emit("mark-read", { groupId: "xxx", lastMessageId: "123" });

// Manually join a group room (rarely needed, auto-joined on connect)
socket.emit("join-group", "group-uuid");

// Leave a group room (e.g. when navigating away from chat screen)
socket.emit("leave-group", "group-uuid");
```

---

## REST API — Messages

All endpoints require `Authorization: Bearer <token>` header.

```ts
const BASE_URL = "https://your-server.com/api";
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
```

### Load Message History

Cursor-based pagination. Returns newest messages first.

```ts
// First page
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/messages?limit=30`,
  { headers: headers(token) }
);
const { data, nextCursor, hasMore }: PaginatedMessages = await res.json();

// Load older messages
if (hasMore) {
  const res = await fetch(
    `${BASE_URL}/group-chat/${groupId}/messages?limit=30&cursor=${nextCursor}`,
    { headers: headers(token) }
  );
}
```

### Send Text Message

```ts
const res = await fetch(`${BASE_URL}/group-chat/${groupId}/messages`, {
  method: "POST",
  headers: headers(token),
  body: JSON.stringify({
    text: "Hello everyone!",
    replyToId: null, // or message ID string to reply to
    entities: null,  // or array of MessageEntity[]
  }),
});
const message: ChatMessage = await res.json(); // 201
```

#### Sending a Message with Entities (Rich Text)

Entities describe formatting ranges within the `text` field (Telegram-style).

```ts
const text = "Visit Google or ask @john for help!";
const entities: MessageEntity[] = [
  { type: "url", offset: 6, length: 6 },           // "Google"
  { type: "text_link", offset: 6, length: 6, url: "https://google.com" },
  { type: "mention", offset: 20, length: 5 },       // "@john"
  { type: "bold", offset: 26, length: 8 },          // "for help"
];

const res = await fetch(`${BASE_URL}/group-chat/${groupId}/messages`, {
  method: "POST",
  headers: headers(token),
  body: JSON.stringify({ text, entities }),
});
const message: ChatMessage = await res.json(); // 201
```

### Send Files (Images / Videos / Documents)

Use `multipart/form-data`. Field name is `files` (up to 10). Optional `text` caption, `replyToId`, and `entities` (stringified JSON array).

```ts
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";

// Pick images
const result = await ImagePicker.launchImageLibraryAsync({
  allowsMultipleSelection: true,
  quality: 0.8,
});

if (!result.canceled) {
  const formData = new FormData();
  formData.append("text", "Check out these photos!"); // optional caption

  for (const asset of result.assets) {
    const ext = asset.uri.split(".").pop() || "jpg";
    formData.append("files", {
      uri: asset.uri,
      name: `photo.${ext}`,
      type: asset.mimeType || `image/${ext}`,
    } as any);
  }

  const res = await fetch(
    `${BASE_URL}/group-chat/${groupId}/messages/attachment`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      // Do NOT set Content-Type — fetch sets the multipart boundary automatically
      body: formData,
    }
  );
  const message: ChatMessage = await res.json(); // 201
}
```

**File size limits:**

| Type | Max Size | Allowed MIME Types |
|------|----------|--------------------|
| Image | 10 MB | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| Video | 50 MB | `video/mp4`, `video/quicktime`, `video/webm` |
| File | 50 MB | Any |

**Max attachments per message:** 10

### Send Document / File

```ts
const result = await DocumentPicker.getDocumentAsync({ multiple: true });

if (!result.canceled) {
  const formData = new FormData();
  for (const file of result.assets) {
    formData.append("files", {
      uri: file.uri,
      name: file.name,
      type: file.mimeType || "application/octet-stream",
    } as any);
  }

  await fetch(`${BASE_URL}/group-chat/${groupId}/messages/attachment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
}
```

### Edit Message

Only the sender can edit. Only text is editable.

```ts
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/messages/${messageId}`,
  {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify({
      text: "Updated message text",
      entities: [{ type: "bold", offset: 0, length: 7 }], // optional
    }),
  }
);
const updated: ChatMessage = await res.json(); // isEdited: true
```

### Delete Message

Sender can delete own messages. Group owner/teacher can delete anyone's.  
Soft-delete — `isDeleted` becomes `true`, `text` becomes `null`.

```ts
await fetch(
  `${BASE_URL}/group-chat/${groupId}/messages/${messageId}`,
  { method: "DELETE", headers: headers(token) }
);
// { success: true }
```

### Get Single Message

```ts
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/messages/${messageId}`,
  { headers: headers(token) }
);
const message: ChatMessage = await res.json();
```

### Search Messages

```ts
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/messages/search?q=homework&limit=20`,
  { headers: headers(token) }
);
const messages: ChatMessage[] = await res.json();
```

---

## REST API — Media & File Gallery

### Media Gallery (Images & Videos)

Cursor-paginated list of all image/video attachments in a group.

```ts
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/media?limit=30`,
  { headers: headers(token) }
);
const { data, nextCursor, hasMore }: PaginatedAttachments = await res.json();
```

### Shared Files

Cursor-paginated list of non-media file attachments.

```ts
const res = await fetch(
  `${BASE_URL}/group-chat/${groupId}/files?limit=30`,
  { headers: headers(token) }
);
const { data, nextCursor, hasMore }: PaginatedAttachments = await res.json();
```

---

## REST API — Unread Messages

### Get Unread Counts for All Groups

Returns unread message count + last message preview for every group the user belongs to.

```ts
const res = await fetch(`${BASE_URL}/group-chat/unread/counts`, {
  headers: headers(token),
});
const { data }: { data: UnreadCount[] } = await res.json();

// Example response:
// { data: [
//   { groupId: "abc", unreadCount: 5, lastMessage: { id: "99", text: "Hey!", ... } },
//   { groupId: "def", unreadCount: 0, lastMessage: null }
// ] }
```

### Mark Messages as Read (REST)

Persists the read cursor for the user in a group.

```ts
await fetch(`${BASE_URL}/group-chat/${groupId}/read`, {
  method: "POST",
  headers: headers(token),
  body: JSON.stringify({ lastMessageId: "123" }),
});
// { success: true }
```

> You can also mark-read via WebSocket (see socket events above). Both methods persist the cursor.

---

## Full Integration Example

### Chat Hook

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const BASE_URL = "https://your-server.com";
const API = `${BASE_URL}/api`;

export function useGroupChat(groupId: string, token: string) {
  const socketRef = useRef<Socket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<string | null>(null);

  // Connect socket
  useEffect(() => {
    const socket = io(BASE_URL, {
      path: "/ws/chat",
      auth: { token },
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("new-message", (msg: ChatMessage) => {
      if (msg.groupId === groupId) {
        setMessages((prev) => [msg, ...prev]);
      }
    });

    socket.on("message-edited", (msg: ChatMessage) => {
      if (msg.groupId === groupId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? msg : m))
        );
      }
    });

    socket.on("message-deleted", (data) => {
      if (data.groupId === groupId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId
              ? { ...m, isDeleted: true, text: null }
              : m
          )
        );
      }
    });

    socket.on("user-typing", (data) => {
      if (data.groupId === groupId) {
        setTypingUsers((prev) => {
          const next = new Map(prev);
          if (data.isTyping) next.set(data.userId, data.username);
          else next.delete(data.userId);
          return next;
        });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [groupId, token]);

  // Load initial + paginated messages
  const loadMessages = useCallback(async () => {
    const url = cursorRef.current
      ? `${API}/group-chat/${groupId}/messages?limit=30&cursor=${cursorRef.current}`
      : `${API}/group-chat/${groupId}/messages?limit=30`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: PaginatedMessages = await res.json();
    setMessages((prev) => [...prev, ...json.data]);
    cursorRef.current = json.nextCursor;
    setHasMore(json.hasMore);
  }, [groupId, token]);

  // Send text
  const sendText = useCallback(
    async (text: string, replyToId?: string, entities?: MessageEntity[]) => {
      await fetch(`${API}/group-chat/${groupId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          replyToId: replyToId ?? null,
          entities: entities ?? null,
        }),
      });
    },
    [groupId, token]
  );

  // Send files
  const sendFiles = useCallback(
    async (files: { uri: string; name: string; type: string }[], caption?: string) => {
      const formData = new FormData();
      if (caption) formData.append("text", caption);
      for (const file of files) {
        formData.append("files", file as any);
      }
      await fetch(`${API}/group-chat/${groupId}/messages/attachment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
    },
    [groupId, token]
  );

  // Typing indicator
  const sendTyping = useCallback(
    (isTyping: boolean) => {
      socketRef.current?.emit("typing", { groupId, isTyping });
    },
    [groupId]
  );

  // Mark as read (persists to DB via REST + emits via WebSocket)
  const markRead = useCallback(
    async (lastMessageId: string) => {
      // Persist via REST
      fetch(`${API}/group-chat/${groupId}/read`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ lastMessageId }),
      }).catch(() => {});
      // Also emit for real-time read receipts
      socketRef.current?.emit("mark-read", { groupId, lastMessageId });
    },
    [groupId, token]
  );

  return {
    messages,
    typingUsers,
    hasMore,
    loadMessages,
    sendText,
    sendFiles,
    sendTyping,
    markRead,
  };
}
```

### Screen Usage

```tsx
export default function GroupChatScreen({ groupId }: { groupId: string }) {
  const { token } = useAuth();
  const {
    messages,
    typingUsers,
    hasMore,
    loadMessages,
    sendText,
    sendFiles,
    sendTyping,
    markRead,
  } = useGroupChat(groupId, token);

  useEffect(() => {
    loadMessages();
  }, []);

  // Mark latest message as read when screen is focused
  useEffect(() => {
    if (messages.length > 0) {
      markRead(messages[0].id);
    }
  }, [messages[0]?.id]);

  return (
    <FlatList
      data={messages}
      inverted
      onEndReached={() => hasMore && loadMessages()}
      renderItem={({ item }) => <ChatBubble message={item} />}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        typingUsers.size > 0 ? (
          <Text>{[...typingUsers.values()].join(", ")} typing...</Text>
        ) : null
      }
    />
  );
}
```

---

## Error Responses

All endpoints return errors in the format:

```json
{ "error": "Error description" }
```

| Status | Meaning |
|--------|---------|
| `400` | Validation error (missing text, file too large, etc.) |
| `401` | Not authenticated / token expired |
| `403` | Not a member of this group |
| `404` | Message not found |
| `409` | Conflict (duplicate) |
| `500` | Server error |

---

## Endpoint Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/group-chat/unread/counts` | Unread counts for all groups |
| `GET` | `/api/group-chat/:groupId/messages?limit=30&cursor=` | Load message history (paginated) |
| `GET` | `/api/group-chat/:groupId/messages/search?q=&limit=` | Search messages |
| `GET` | `/api/group-chat/:groupId/messages/:messageId` | Get single message |
| `POST` | `/api/group-chat/:groupId/messages` | Send text message |
| `POST` | `/api/group-chat/:groupId/messages/attachment` | Send files (multipart) |
| `PUT` | `/api/group-chat/:groupId/messages/:messageId` | Edit message |
| `DELETE` | `/api/group-chat/:groupId/messages/:messageId` | Delete message |
| `POST` | `/api/group-chat/:groupId/read` | Mark messages as read |
| `GET` | `/api/group-chat/:groupId/media?limit=30&cursor=` | Media gallery |
| `GET` | `/api/group-chat/:groupId/files?limit=30&cursor=` | Shared files list |

### WebSocket Events

**Connect:** `io("https://server.com", { path: "/ws/chat", auth: { token } })`

| Direction | Event | Payload |
|-----------|-------|---------|
| **Receive** | `new-message` | `ChatMessage` |
| **Receive** | `message-edited` | `ChatMessage` |
| **Receive** | `message-deleted` | `{ groupId, messageId }` |
| **Receive** | `user-typing` | `{ groupId, userId, username, isTyping }` |
| **Receive** | `messages-read` | `{ groupId, userId, lastMessageId }` |
| **Receive** | `joined-group` | `{ groupId }` |
| **Send** | `typing` | `{ groupId, isTyping }` |
| **Send** | `mark-read` | `{ groupId, lastMessageId }` |
| **Send** | `join-group` | `groupId` (string) |
| **Send** | `leave-group` | `groupId` (string) |
