'use client';

import { useEffect, useState } from 'react';
import type { Coords } from '@/lib/types';

/** Fallbacks for when the browser denies geolocation. */
const CITIES: Array<{ name: string; coords: Coords }> = [
  { name: 'Almaty', coords: { lat: 43.238, lon: 76.8829 } },
  { name: 'Astana', coords: { lat: 51.1282, lon: 71.4304 } },
  { name: 'Shymkent', coords: { lat: 42.3417, lon: 69.5901 } },
  { name: 'Karaganda', coords: { lat: 49.8047, lon: 73.1094 } },
];

/** Radius stops, in metres. A slider over these reads better than free km. */
const RADIUS_STOPS = [500, 1000, 2000, 3000, 5000, 7500, 10_000, 15_000, 25_000];

export type LocationSource = 'gps' | 'city' | null;

interface Props {
  onSearch: (input: { coords: Coords; radiusM: number; item: string }) => void;
  onCancel: () => void;
  running: boolean;
}

export function SearchForm({ onSearch, onCancel, running }: Props) {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [source, setSource] = useState<LocationSource>(null);
  const [cityName, setCityName] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [radiusIndex, setRadiusIndex] = useState(4); // 5 km
  const [item, setItem] = useState('');

  const radiusM = RADIUS_STOPS[radiusIndex];

  // Ask for location on first paint — it is the one thing the app cannot guess.
  useEffect(() => {
    requestLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function requestLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError('This browser has no geolocation support.');
      return;
    }

    setLocating(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setSource('gps');
        setCityName(null);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied — pick a city instead.'
            : 'Could not get your location — pick a city instead.'
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }

  function pickCity(city: (typeof CITIES)[number]) {
    setCoords(city.coords);
    setSource('city');
    setCityName(city.name);
    setLocationError(null);
  }

  const canSearch = coords !== null && item.trim().length >= 2 && !running;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSearch || !coords) return;
    onSearch({ coords, radiusM, item: item.trim() });
  }

  return (
    <form onSubmit={submit} className="card p-5 sm:p-6" style={{ boxShadow: 'var(--shadow)' }}>
      {/* ---- item ------------------------------------------------------ */}
      <div className="mb-6">
        <label htmlFor="item" className="field-label">
          What are you looking for
        </label>
        <input
          id="item"
          className="text-input"
          placeholder="iPhone 15 Pro 256GB"
          value={item}
          onChange={(e) => setItem(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={running}
        />
      </div>

      {/* ---- radius ---------------------------------------------------- */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <span className="field-label" style={{ marginBottom: 0 }}>
            Search radius
          </span>
          <span
            className="text-sm font-semibold tabular-nums"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {radiusM < 1000 ? `${radiusM} m` : `${radiusM / 1000} km`}
          </span>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={RADIUS_STOPS.length - 1}
          step={1}
          value={radiusIndex}
          onChange={(e) => setRadiusIndex(Number(e.target.value))}
          disabled={running}
          aria-label="Search radius"
        />
      </div>

      {/* ---- location -------------------------------------------------- */}
      <div className="mb-6">
        <span className="field-label">Your location</span>

        {coords && (
          <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
            {source === 'gps' ? (
              <>
                Using your device location{' '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                  ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})
                </span>
              </>
            ) : (
              <>Centred on {cityName}</>
            )}
          </p>
        )}

        {locationError && (
          <p className="text-sm mb-3" style={{ color: 'var(--warn)' }}>
            {locationError}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={requestLocation}
            disabled={locating || running}
            aria-pressed={source === 'gps'}
          >
            {locating ? 'Locating…' : 'Use my location'}
          </button>

          {CITIES.map((city) => (
            <button
              key={city.name}
              type="button"
              className="btn btn-ghost"
              onClick={() => pickCity(city)}
              disabled={running}
              aria-pressed={source === 'city' && cityName === city.name}
            >
              {city.name}
            </button>
          ))}
        </div>
      </div>

      {/* ---- submit ---------------------------------------------------- */}
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={!canSearch}>
          {running ? 'Searching…' : 'Find best price'}
        </button>

        {running && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Stop
          </button>
        )}

        {!coords && !locating && (
          <span className="text-sm" style={{ color: 'var(--faint)' }}>
            Set a location to search
          </span>
        )}
      </div>
    </form>
  );
}
