# 🌍 Cityscope — Full-Stack Weather Notebook

Search cities worldwide, save them, favorite them, add notes, and watch live weather + 5-day forecasts.

## Tech Stack
- **Frontend:** React 18, Vite, hand-written responsive CSS (dark/light theme)
- **Backend:** Python, FastAPI, Pydantic validation, SQLAlchemy 2.0 ORM
- **Database:** SQLite (swap via `DATABASE_URL` for PostgreSQL)
- **Auth:** JWT + bcrypt
- **External APIs:** Open-Meteo geocoding + forecast (no key required)
- **Testing:** pytest + FastAPI TestClient

## Backend Features
- JWT auth with per-user data isolation
- Async external API calls (httpx) with a 10-minute **TTL cache**
- Sliding-window **rate limiter** middleware (429 on abuse)
- Search / filter / sort / pagination on saved cities
- Duplicate protection, input validation, consistent error handling
- `/api/stats` aggregates weather for many cities **concurrently** (`asyncio.gather`)
- Auto-generated Swagger docs at `/docs`

## Run locally (Python 3.10+, Node 18+)
```bash
# Terminal 1 — API
cd backend
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # optional; set JWT_SECRET
uvicorn main:app --reload --port 8000

# Terminal 2 — UI
cd frontend && npm install && npm run dev
```
UI: http://localhost:5173 · API docs: http://localhost:8000/docs

## Tests
```bash
cd backend && pytest -q
```

## API
| Method | Route | Description |
|---|---|---|
| POST | /api/auth/register, /login | Auth, returns JWT |
| GET | /api/auth/me | Current user |
| GET | /api/search?q= | Geocode a city (external API) |
| GET | /api/cities?q=&favorite=&sort=&limit=&offset= | List with filters |
| POST | /api/cities | Save city |
| PATCH | /api/cities/{id} | Update note / favorite |
| DELETE | /api/cities/{id} | Remove city |
| GET | /api/cities/{id}/weather | Current + 5-day forecast (cached) |
| GET | /api/stats | Totals, hottest, coldest |
