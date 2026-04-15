# API Updates — App Release Notes

## Global Groups

Groups now support an `isGlobal` flag. Global groups are public communities visible to all users.

### What changed

- **`isGlobal` field** added to all group responses (`boolean`, default `false`)
- Only **verified teachers** and **admins** can create global groups
- Global groups appear automatically in `GET /api/groups/my` for all users even without joining — returned with `myRole: null`
- `GET /api/groups/:id` is accessible for global groups without membership
- `GET /api/groups/search` excludes global groups (they already appear in `/my`)

### New endpoint

**`POST /api/groups/:id/join`** — Join a global group directly (no referral code needed)

- No request body required
- Returns the group object
- Returns `409` if already a member
- Returns `403` if the group is not global

### Creating a global group

**`POST /api/groups`**

```json
{
  "name": "Community English Practice",
  "description": "Open group for everyone",
  "isGlobal": true
}
```

Returns `403` if the user is not a verified teacher or admin.

### Client-side ad banners

Use `isGlobal` to conditionally show ads in non-global groups:

```tsx
{!group.isGlobal && <AdBanner />}
```

---


## Reviews — My Groups Reviews

`GET /api/reviews/my-groups` returns **reviews on sessions** from students in the teacher's groups.

### Response

```json
{
  "data": [
    {
      "id": "456",
      "score": 45,
      "feedback": "Good fluency",
      "cefrLevel": "B1",
      "createdAt": "...",
      "reviewer": { "id": "...", "fullName": "...", "username": "...", "avatarUrl": "..." },
      "session": {
        "id": "123",
        "groupId": "...",
        "scoreAvg": 42.5,
        "test": { "id": 1, "title": "IELTS Part 2" },
        "user": { "id": "...", "fullName": "...", "username": "...", "avatarUrl": "..." },
        "group": { "id": "...", "name": "..." }
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

Query params: `?page=1&limit=20`

---

## Speaking — Updates

### Visibility update (endpoint changed)

**Before (removed):** `PUT /api/speaking/:id`

**After:** `PUT /api/speaking/sessions/:sessionId`

```json
{ "visibility": "private" | "group" | "community" }
```

### Pending sessions scoped to teacher's groups

`GET /api/speaking/pending` now returns only unreviewed sessions from groups where the teacher is an owner or teacher. Response includes `group: { id, name }`.

### Submission group validation

`POST /api/speaking` now validates:

1. If `groupId` is provided, the group must exist and **not be global** (`isGlobal: false`)
2. The user must be a member of the group
3. If validation fails, `groupId` is ignored and visibility `"group"` falls back to `"private"`

---

## Ads API

CRUD for banner ads. All users can fetch active ads; only admins can manage them.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ads` | Any user | List active ads |
| GET | `/api/ads/all` | Admin | List all ads (including inactive) |
| GET | `/api/ads/:id` | Admin | Get single ad |
| POST | `/api/ads` | Admin | Create ad (multipart) |
| PUT | `/api/ads/:id` | Admin | Update ad (multipart) |
| DELETE | `/api/ads/:id` | Admin | Delete ad |

### Creating an ad

`POST /api/ads` — multipart/form-data

| Field | Type | Required |
|-------|------|----------|
| `title` | string | Yes |
| `image` | file (image, max 5MB) | Yes |
| `linkUrl` | string | No |

### Updating an ad

`PUT /api/ads/:id` — multipart/form-data

| Field | Type | Required |
|-------|------|----------|
| `title` | string | No |
| `image` | file (image, max 5MB) | No |
| `linkUrl` | string | No |
| `isActive` | boolean | No |

### Ad response shape

```json
{
  "id": 1,
  "title": "Learn English Fast",
  "imageUrl": "https://...",
  "linkUrl": "https://...",
  "isActive": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Client-side usage

Fetch active ads and display in non-global groups:

```tsx
const { data: ads } = useAds();

{!group.isGlobal && ads.length > 0 && <AdBanner ad={ads[0]} />}
```

---

## Migration Required

Run the following to apply the schema change:

```bash
npx prisma db push
```

This adds the `is_global` column (default `false`) to the `groups` table and creates the `ads` table.
