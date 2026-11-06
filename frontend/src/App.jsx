import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

const icon = (c) => (c === 0 ? '☀️' : c <= 2 ? '⛅' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : '⛈️');
const hue = (t) => Math.max(0, Math.min(220, 220 - t * 5));
const day = (d) => new Date(d).toLocaleDateString(undefined, { weekday: 'short' });

/* ---------- auth ---------- */
function AuthScreen({ onAuth, notify }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api[mode](form);
      localStorage.setItem('token', data.token);
      localStorage.setItem('email', data.email);
      onAuth(data.email);
    } catch (err) {
      notify(err.status === 422 ? 'Enter a valid email and a 6+ character password' : err.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="hero">
        <h1>🌍 Cityscope</h1>
        <p>Save the cities you care about. Track live weather, 5-day forecasts and your own notes.</p>
        <ul><li>⚡ Live data from Open-Meteo</li><li>🔒 Secure JWT sessions</li><li>⭐ Favorites, search &amp; sort</li></ul>
      </div>
      <form className="card auth" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
        <input type="email" placeholder="Email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input type="password" placeholder="Password (6+ characters)" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}</button>
        <a onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
        </a>
      </form>
    </div>
  );
}

/* ---------- forecast mini-chart ---------- */
function Forecast({ daily }) {
  const lo = Math.min(...daily.map((d) => d.min));
  const hi = Math.max(...daily.map((d) => d.max));
  const span = Math.max(hi - lo, 1);
  return (
    <div className="forecast">
      {daily.map((d) => (
        <div key={d.date} className="fday">
          <span className="muted">{day(d.date)}</span>
          <span>{icon(d.code)}</span>
          <div className="bar"><i style={{ bottom: `${((d.min - lo) / span) * 100}%`, height: `${Math.max(((d.max - d.min) / span) * 100, 8)}%` }} /></div>
          <small>{Math.round(d.max)}° <span className="muted">{Math.round(d.min)}°</span></small>
        </div>
      ))}
    </div>
  );
}

/* ---------- city card ---------- */
function CityCard({ city, onChange, onDelete, notify }) {
  const [w, setW] = useState(null);
  const [note, setNote] = useState(city.note);

  useEffect(() => { api.weather(city.id).then(setW).catch(() => setW(false)); }, [city.id]);

  const t = w?.current?.temperature_2m;
  const saveNote = async () => {
    if (note === city.note) return;
    try { onChange(await api.patchCity(city.id, { note })); notify('Note saved', 'ok'); } catch (e) { notify(e.message); }
  };

  return (
    <article className="card city">
      <div className="top" style={t != null ? { background: `linear-gradient(135deg, hsl(${hue(t)} 75% 48%), hsl(${hue(t) + 30} 70% 35%))` } : {}}>
        <div className="row">
          <div><h3>{city.name}</h3><small>{city.country}</small></div>
          <div className="actions">
            <button className="icon" title="Favorite" onClick={async () => onChange(await api.patchCity(city.id, { favorite: !city.favorite }))}>{city.favorite ? '⭐' : '☆'}</button>
            <button className="icon" title="Remove" onClick={() => onDelete(city.id)}>🗑</button>
          </div>
        </div>
        {w === null && <div className="skeleton" />}
        {w === false && <p>Weather unavailable</p>}
        {w && (
          <div className="now">
            <span className="emoji">{icon(w.current.weather_code)}</span>
            <span className="temp">{Math.round(t)}°</span>
            <div className="meta"><span>💨 {w.current.wind_speed_10m} km/h</span><span>💧 {w.current.relative_humidity_2m}%</span></div>
          </div>
        )}
      </div>
      <div className="body">
        {w && <Forecast daily={w.daily} />}
        <textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} />
      </div>
    </article>
  );
}

/* ---------- main ---------- */
export default function App() {
  const [user, setUser] = useState(localStorage.getItem('token') ? localStorage.getItem('email') : null);
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [toast, setToast] = useState(null);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState({ q: '', favorite: false, sort: 'recent' });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  const notify = useCallback((msg, type = 'err') => { setToast({ msg, type }); setTimeout(() => setToast(null), 2800); }, []);
  const logout = () => { localStorage.clear(); localStorage.setItem('theme', theme); setUser(null); setData({ items: [], total: 0 }); };

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); }, [theme]);

  const load = useCallback(() => {
    api.cities({ q: filter.q, favorite: filter.favorite, sort: filter.sort })
      .then((d) => { setData(d); setLoaded(true); })
      .catch((e) => (e.status === 401 ? logout() : notify(e.message)));
    api.stats().then(setStats).catch(() => {});
  }, [filter]);

  useEffect(() => { if (user) { const id = setTimeout(load, 250); return () => clearTimeout(id); } }, [user, load]);

  // debounced search-as-you-type
  useEffect(() => {
    if (query.trim().length < 2) return setResults([]);
    const id = setTimeout(() => api.search(query.trim()).then(setResults).catch(() => setResults([])), 350);
    return () => clearTimeout(id);
  }, [query]);

  const add = async (c) => {
    try { await api.addCity({ name: c.name, country: c.country, lat: c.lat, lon: c.lon }); setQuery(''); setResults([]); notify(`${c.name} saved`, 'ok'); load(); }
    catch (e) { notify(e.message); }
  };
  const remove = async (id) => { await api.removeCity(id); notify('City removed', 'ok'); load(); };
  const patchLocal = (c) => setData((d) => ({ ...d, items: d.items.map((x) => (x.id === c.id ? c : x)) }));

  if (!user) return (<><AuthScreen onAuth={setUser} notify={notify} />{toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}</>);

  return (
    <>
      <header className="nav">
        <h1>🌍 Cityscope</h1>
        <div className="actions">
          <span className="muted hide-sm">{user}</span>
          <button className="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="ghost" onClick={logout}>Log out</button>
        </div>
      </header>

      <main>
        <section className="stats">
          <div className="card stat"><span className="muted">Saved cities</span><b>{stats?.total ?? '–'}</b></div>
          <div className="card stat"><span className="muted">Favorites</span><b>{stats?.favorites ?? '–'}</b></div>
          <div className="card stat"><span className="muted">🔥 Hottest</span><b>{stats?.hottest ? `${stats.hottest.name} ${Math.round(stats.hottest.temp)}°` : '–'}</b></div>
          <div className="card stat"><span className="muted">🧊 Coldest</span><b>{stats?.coldest ? `${stats.coldest.name} ${Math.round(stats.coldest.temp)}°` : '–'}</b></div>
        </section>

        <div className="searchbox">
          <input className="big" placeholder="🔎 Search a city to add (e.g. Bengaluru)…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {results.length > 0 && (
            <ul className="dropdown card">
              {results.map((r) => (
                <li key={`${r.lat}${r.lon}`} onClick={() => add(r)}>
                  <span>{r.name} <small className="muted">{[r.admin, r.country].filter(Boolean).join(', ')}</small></span><b>＋</b>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="filters">
          <input placeholder="Filter saved cities…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <button className={filter.favorite ? 'primary' : 'ghost'} onClick={() => setFilter({ ...filter, favorite: !filter.favorite })}>⭐ Favorites</button>
          <select value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })}>
            <option value="recent">Newest first</option><option value="name">A → Z</option>
          </select>
        </div>

        <div className="grid">
          {data.items.map((c) => <CityCard key={c.id} city={c} onChange={patchLocal} onDelete={remove} notify={notify} />)}
        </div>
        {loaded && !data.items.length && <div className="empty"><span>🧭</span><p>No cities here yet. Search above to add your first one.</p></div>}
      </main>
      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </>
  );
}
