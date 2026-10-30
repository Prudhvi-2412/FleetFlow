'use client';

import { useEffect, useRef, useState } from 'react';
import type { Map, Marker } from 'maplibre-gl';

type Point = { lat: number; lng: number } | null;

export function LocationPickerMap({ pickup, dropoff, active, onPick }: {
  pickup: Point;
  dropoff: Point;
  active: 'pickup' | 'dropoff';
  onPick: (lat: number, lng: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const library = useRef<typeof import('maplibre-gl') | null>(null);
  const markers = useRef<{ pickup?: Marker; dropoff?: Marker }>({});
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    void import('maplibre-gl').then((maplibregl) => {
      if (cancelled || !container.current) return;
      library.current = maplibregl;
      const instance = new maplibregl.Map({
        container: container.current,
        style: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
        center: [77.606, 12.975],
        zoom: 12,
      });
      instance.on('click', (event) => onPickRef.current(event.lngLat.lat, event.lngLat.lng));
      map.current = instance;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      library.current = null;
      markers.current = {};
    };
  }, []);

  useEffect(() => {
    if (!map.current || !library.current) return;
    for (const [kind, point, color] of [
      ['pickup', pickup, '#20bfa9'],
      ['dropoff', dropoff, '#f59e66'],
    ] as const) {
      if (!point) { markers.current[kind]?.remove(); delete markers.current[kind]; continue; }
      if (!markers.current[kind]) markers.current[kind] = new library.current.Marker({ color }).addTo(map.current);
      markers.current[kind]?.setLngLat([point.lng, point.lat]);
    }
    const focus = active === 'pickup' ? pickup : dropoff;
    if (focus) map.current.flyTo({ center: [focus.lng, focus.lat], zoom: 14 });
  }, [pickup, dropoff, active, mapReady]);

  return <div className="map location-picker-map" ref={container} aria-label={`Click map to set ${active} location`} />;
}
