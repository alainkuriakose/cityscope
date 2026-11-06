import os

os.environ["DATABASE_URL"] = "sqlite:///./test_cityscope.db"

import pytest
from fastapi.testclient import TestClient

import main

FAKE = {
    "current": {"temperature_2m": 21.5, "wind_speed_10m": 9, "relative_humidity_2m": 60, "weather_code": 1},
    "daily": {"time": ["2026-01-01"], "temperature_2m_max": [25], "temperature_2m_min": [15], "weather_code": [1]},
}


async def fake_fetch(url, params):
    return FAKE


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(main, "fetch_json", fake_fetch)
    main._cache.clear()
    yield


@pytest.fixture(scope="module", autouse=True)
def cleanup():
    yield
    main.engine.dispose()
    if os.path.exists("test_cityscope.db"):
        os.remove("test_cityscope.db")


client = TestClient(main.app)


def auth(email):
    r = client.post("/api/auth/register", json={"email": email, "password": "secret123"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_requires_auth():
    assert client.get("/api/cities").status_code == 401


def test_register_duplicate_and_login():
    auth("a@test.com")
    assert client.post("/api/auth/register", json={"email": "a@test.com", "password": "secret123"}).status_code == 409
    assert client.post("/api/auth/login", json={"email": "a@test.com", "password": "wrong-pass"}).status_code == 401


def test_city_crud_weather_and_isolation():
    h1, h2 = auth("b@test.com"), auth("c@test.com")
    city = client.post("/api/cities", headers=h1, json={"name": "Pune", "country": "India", "lat": 18.5, "lon": 73.8}).json()
    assert client.post("/api/cities", headers=h1, json={"name": "Pune", "country": "India", "lat": 18.5, "lon": 73.8}).status_code == 409
    assert client.patch(f"/api/cities/{city['id']}", headers=h1, json={"favorite": True}).json()["favorite"] is True
    assert client.get("/api/cities?favorite=true", headers=h1).json()["total"] == 1
    assert client.get(f"/api/cities/{city['id']}/weather", headers=h1).json()["current"]["temperature_2m"] == 21.5
    assert client.get("/api/stats", headers=h1).json()["hottest"]["name"] == "Pune"
    # another user can't touch it
    assert client.delete(f"/api/cities/{city['id']}", headers=h2).status_code == 404
    assert client.delete(f"/api/cities/{city['id']}", headers=h1).status_code == 204
