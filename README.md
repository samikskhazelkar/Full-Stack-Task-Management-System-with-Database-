# Task Manager (Express + SQLite + vanilla JS)

## Run
    cp .env.example .env     # set a long random JWT_SECRET
    npm install
    npm start                # http://localhost:3000  (Node >= 20.6)

## Stack
- **Backend:** Express, better-sqlite3 (file DB `tasks.db`, created automatically), JWT auth, bcrypt, helmet, rate limiting
- **Frontend:** single static page (`public/index.html`), Kanban board: To do / In progress / Done

## API (all `/api/tasks*` routes need `Authorization: Bearer <token>`)
| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | returns `{ token, email }` |
| GET | /api/tasks?status=&priority=&q= | only the caller's tasks |
| POST | /api/tasks | `{ title, description?, status?, priority?, due_date? }` |
| PATCH | /api/tasks/:id | any subset of the fields above |
| DELETE | /api/tasks/:id | |

## Schema
`users(id, email UNIQUE, password_hash, created_at)` and
`tasks(id, user_id → users ON DELETE CASCADE, title, description, status, priority, due_date, created_at, updated_at)`
with CHECK constraints on status/priority and an index on `(user_id, status)`.

## Production notes
- All queries are parameterized; every task query is scoped by `user_id`, so users can't touch each other's data.
- To move to Postgres/MySQL, only `src/db.js` and the prepared statements in `src/server.js` change.
- Put it behind HTTPS; consider httpOnly cookies instead of localStorage for the token.
- Back up `tasks.db` (WAL mode: copy `tasks.db*` or use SQLite's `.backup`).
