"""Cityscope API — FastAPI + SQLAlchemy + JWT + cached external weather API."""
import asyncio
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Float, ForeignKey, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

SECRET = os.getenv("JWT_SECRET", "dev-secret")
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./cityscope.db")
CACHE_TTL, RATE_LIMIT, RATE_WINDOW = 600, 120, 60  # seconds / requests / seconds

# ---------------- database ----------------
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    password: Mapped[str] = mapped_column(String)


class City(Base):
    __tablename__ = "cities"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    country: Mapped[str] = mapped_column(String, default="")
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String, default="")
    favorite: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    def to_dict(self):
        return {c.name: getattr(self, c.name) for c in self.__table__.columns if c.name != "user_id"}


Base.metadata.create_all(engine)


def get_db():
    with SessionLocal() as db:
        yield db


# ---------------- schemas ----------------
class Credentials(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=6, max_length=128)


class CityIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    country: str = ""
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class CityPatch(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)
    favorite: Optional[bool] = None


# ---------------- app + middleware ----------------
app = FastAPI(title="Cityscope API", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("CLIENT_URL", "http://localhost:5173")],
    allow_methods=["*"],
    allow_headers=["*"],
)

_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def rate_limiter(request: Request, call_next):
    """Sliding-window rate limit per client IP."""
    ip, now = request.client.host if request.client else "anon", time.time()
    q = _hits[ip]
    while q and q[0] < now - RATE_WINDOW:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return JSONResponse({"detail": "Too many requests"}, status_code=429)
    q.append(now)
    return await call_next(request)


# ---------------- auth ----------------
bearer = HTTPBearer(auto_error=False)


def make_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=7)
    return jwt.encode({"sub": str(user.id), "exp": exp}, SECRET, algorithm="HS256")


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    try:
        uid = int(jwt.decode(creds.credentials, SECRET, algorithms=["HS256"])["sub"])
    except Exception:
        raise HTTPException(401, "Unauthorized")
    user = db.get(User, uid)
    if not user:
        raise HTTPException(401, "Unauthorized")
    return user


@app.post("/api/auth/register", status_code=201)
def register(body: Credentials, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Email already registered")
    user = User(email=email, password=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode())
    db.add(user)
    db.commit()
    return {"token": make_token(user), "email": user.email}


@app.post("/api/auth/login")
def login(body: Credentials, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if not user or not bcrypt.checkpw(body.password.encode(), user.password.encode()):
        raise HTTPException(401, "Invalid credentials")
    return {"token": make_token(user), "email": user.email}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "email": user.email}


# ---------------- external API + TTL cache ----------------
_cache: dict[str, tuple[float, dict]] = {}


async def fetch_json(url: str, params: dict) -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        return r.json()


async def get_weather(lat: float, lon: float) -> dict:
    key = f"{lat:.2f},{lon:.2f}"
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        raw = await fetch_json("https://api.open-meteo.com/v1/forecast", {
            "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 5,
            "current": "temperature_2m,wind_speed_10m,relative_humidity_2m,weather_code",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code",
        })
    except Exception:
        raise HTTPException(502, "Weather provider unavailable")
    d = raw["daily"]
    data = {
        "current": raw["current"],
        "daily": [
            {"date": d["time"][i], "max": d["temperature_2m_max"][i],
             "min": d["temperature_2m_min"][i], "code": d["weather_code"][i]}
            for i in range(len(d["time"]))
        ],
    }
    _cache[key] = (time.time() + CACHE_TTL, data)
    return data


@app.get("/api/search")
async def search(q: str = Query(min_length=2), _: User = Depends(current_user)):
    try:
        data = await fetch_json("https://geocoding-api.open-meteo.com/v1/search", {"name": q, "count": 6})
    except Exception:
        raise HTTPException(502, "Geocoding provider unavailable")
    return [{"name": c["name"], "country": c.get("country", ""), "admin": c.get("admin1", ""),
             "lat": c["latitude"], "lon": c["longitude"]} for c in data.get("results", [])]


# ---------------- cities ----------------
def owned_city(city_id: int, user: User, db: Session) -> City:
    city = db.get(City, city_id)
    if not city or city.user_id != user.id:
        raise HTTPException(404, "City not found")
    return city


@app.get("/api/cities")
def list_cities(
    q: str = "", favorite: bool = False, sort: str = Query("recent", pattern="^(recent|name)$"),
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    stmt = select(City).where(City.user_id == user.id)
    if q:
        stmt = stmt.where(City.name.ilike(f"%{q}%"))
    if favorite:
        stmt = stmt.where(City.favorite.is_(True))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    stmt = stmt.order_by(City.name if sort == "name" else City.id.desc()).limit(limit).offset(offset)
    return {"items": [c.to_dict() for c in db.scalars(stmt)], "total": total}


@app.post("/api/cities", status_code=201)
def add_city(body: CityIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    dup = db.scalar(select(City).where(City.user_id == user.id, City.name == body.name, City.country == body.country))
    if dup:
        raise HTTPException(409, "City already saved")
    city = City(user_id=user.id, **body.model_dump())
    db.add(city)
    db.commit()
    return city.to_dict()


@app.patch("/api/cities/{city_id}")
def update_city(city_id: int, body: CityPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    city = owned_city(city_id, user, db)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(city, field, value)
    db.commit()
    return city.to_dict()


@app.delete("/api/cities/{city_id}", status_code=204)
def delete_city(city_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(owned_city(city_id, user, db))
    db.commit()


@app.get("/api/cities/{city_id}/weather")
async def city_weather(city_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    city = owned_city(city_id, user, db)
    return await get_weather(city.lat, city.lon)


@app.get("/api/stats")
async def stats(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Dashboard summary; fetches weather for up to 10 cities concurrently."""
    cities = list(db.scalars(select(City).where(City.user_id == user.id).limit(10)))
    total = db.scalar(select(func.count()).select_from(City).where(City.user_id == user.id))
    favs = db.scalar(select(func.count()).select_from(City).where(City.user_id == user.id, City.favorite.is_(True)))
    results = await asyncio.gather(*(get_weather(c.lat, c.lon) for c in cities), return_exceptions=True)
    temps = [(c.name, r["current"]["temperature_2m"]) for c, r in zip(cities, results) if isinstance(r, dict)]
    hottest = max(temps, key=lambda t: t[1], default=None)
    coldest = min(temps, key=lambda t: t[1], default=None)
    return {
        "total": total, "favorites": favs,
        "hottest": hottest and {"name": hottest[0], "temp": hottest[1]},
        "coldest": coldest and {"name": coldest[0], "temp": coldest[1]},
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}
