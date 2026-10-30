import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { GeoPlacesClient, GetPlaceCommand, ReverseGeocodeCommand, SuggestCommand } from '@aws-sdk/client-geo-places';
import { z } from 'zod';
import { requireAuth, requireRole } from './auth.js';

const places = new GeoPlacesClient({ region: process.env.GEO_PLACES_REGION ?? 'ap-south-1' });
const coordinate = z.coerce.number().finite();
const position = z.object({ lat: coordinate.min(-90).max(90), lng: coordinate.min(-180).max(180) });
const search = z.object({ q: z.string().trim().min(3).max(120), lat: coordinate.min(-90).max(90).optional(), lng: coordinate.min(-180).max(180).optional() });

export const placesRouter = Router();
placesRouter.use(requireAuth, requireRole('customer'));
placesRouter.use(rateLimit({ windowMs: 60_000, limit: 30, keyGenerator: (request) => request.user!.id }));

placesRouter.get('/suggest', async (request, response) => {
  const input = search.safeParse(request.query);
  if (!input.success) return response.status(400).json({ error: 'Enter at least three characters to search' });
  const { q, lat, lng } = input.data;
  if ((lat === undefined) !== (lng === undefined)) return response.status(400).json({ error: 'Provide both bias coordinates' });
  try {
    const result = await places.send(new SuggestCommand({
      QueryText: q,
      MaxResults: 5,
      MaxQueryRefinements: 0,
      ...(lat !== undefined && lng !== undefined ? { BiasPosition: [lng, lat] } : {}),
    }));
    return response.json({ suggestions: (result.ResultItems ?? [])
      .filter((item) => item.Place?.PlaceId && item.Title)
      .map((item) => ({ placeId: item.Place!.PlaceId, title: item.Title, address: item.Place?.Address?.Label ?? '' })) });
  } catch (error) {
    console.error('Place suggestions:', error);
    return response.status(502).json({ error: 'Address suggestions are temporarily unavailable' });
  }
});

placesRouter.post('/resolve', async (request, response) => {
  const input = z.object({ placeId: z.string().min(1).max(500) }).safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: 'Invalid place selection' });
  try {
    const place = await places.send(new GetPlaceCommand({ PlaceId: input.data.placeId, IntendedUse: 'Storage' }));
    const [lng, lat] = place.Position ?? [];
    if (lat === undefined || lng === undefined) return response.status(404).json({ error: 'Place has no coordinates' });
    return response.json({ address: place.Address?.Label ?? place.Title ?? `${lat}, ${lng}`, lat, lng });
  } catch (error) {
    console.error('Resolve place:', error);
    return response.status(502).json({ error: 'Could not resolve that address' });
  }
});

placesRouter.get('/reverse', async (request, response) => {
  const input = position.safeParse(request.query);
  if (!input.success) return response.status(400).json({ error: 'Invalid map position' });
  const { lat, lng } = input.data;
  try {
    const result = await places.send(new ReverseGeocodeCommand({
      QueryPosition: [lng, lat], MaxResults: 1, QueryRadius: 1000, IntendedUse: 'Storage',
    }));
    const nearest = result.ResultItems?.[0];
    const address = nearest?.Distance !== undefined && nearest.Distance <= 100 && nearest.Address?.Label
      ? nearest.Address.Label : `Map pin at ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return response.json({ address, lat, lng });
  } catch (error) {
    console.error('Reverse geocode:', error);
    return response.status(502).json({ error: 'Could not look up that location' });
  }
});
