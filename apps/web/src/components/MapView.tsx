'use client';

import { useEffect, useRef } from 'react';
import type { Map, Marker } from 'maplibre-gl';
import type { Delivery, Location } from '../lib/types';

export function MapView({ delivery, location }: { delivery: Delivery; location: Location | null }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const driverMarker = useRef<Marker | null>(null);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    void import('maplibre-gl').then((maplibregl) => {
      if (cancelled || !container.current) return;
      const instance = new maplibregl.Map({
        container: container.current,
        style: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty',
        center: [delivery.pickup_lng, delivery.pickup_lat],
        zoom: 12,
      });
      map.current = instance;
      new maplibregl.Marker({ color: '#20bfa9' })
        .setLngLat([delivery.pickup_lng, delivery.pickup_lat]).addTo(instance);
      new maplibregl.Marker({ color: '#f59e66' })
        .setLngLat([delivery.dropoff_lng, delivery.dropoff_lat]).addTo(instance);
      if (location) {
        driverMarker.current = new maplibregl.Marker({ color: '#5178f5' })
          .setLngLat([location.lng, location.lat]).addTo(instance);
      }
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      driverMarker.current = null;
    };
    // A new delivery gets a new map; location updates move the existing marker below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivery.id]);

  useEffect(() => {
    if (!location || !map.current) return;
    void import('maplibre-gl').then((maplibregl) => {
      if (!map.current) return;
      if (!driverMarker.current) {
        driverMarker.current = new maplibregl.Marker({ color: '#5178f5' }).setLngLat([location.lng, location.lat]).addTo(map.current);
      } else {
        driverMarker.current.setLngLat([location.lng, location.lat]);
      }
    });
  }, [location]);

  return <div className="map" ref={container} aria-label="Delivery tracking map" />;
}
