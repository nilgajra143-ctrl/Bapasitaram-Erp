import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Clock,
  ExternalLink,
  Fuel,
  Loader2,
  MapPin,
  Navigation,
  Route as RouteIcon,
  Scale,
  Search,
  Truck,
  Wrench,
} from 'lucide-react';
import type { CompanySettings, Trip } from '../types/erp';
import { DEFAULT_DIESEL_RATE } from '../types/erp';
import { formatINR } from '../utils/formatters';

interface RouteMapViewProps {
  trips: Trip[];
  companySettings: CompanySettings | null;
}

interface LatLngPoint {
  lat: number;
  lng: number;
}

interface ComputedRouteSummary {
  distanceMeters: number;
  durationMillis: number;
  originPos: LatLngPoint | null;
  destinationPos: LatLngPoint | null;
}

interface NearbyStopPlace {
  id: string;
  name: string;
  address: string;
  location: LatLngPoint;
  googleMapsURI?: string;
  category: StopCategory;
}

type StopCategory = 'diesel' | 'weighbridge' | 'workshop' | 'hub';

const STOP_CATEGORIES: Array<{
  id: StopCategory;
  label: string;
  queryPrefix: string;
  icon: React.ComponentType<{ className?: string }>;
  pinColor: string;
}> = [
  {
    id: 'diesel',
    label: 'Diesel Pumps',
    queryPrefix: '24 hour diesel petrol pump truck stop near',
    icon: Fuel,
    pinColor: '#d97706',
  },
  {
    id: 'weighbridge',
    label: 'Weighbridges',
    queryPrefix: 'weighbridge dharam kanta near',
    icon: Scale,
    pinColor: '#0369a1',
  },
  {
    id: 'workshop',
    label: 'Truck Workshops',
    queryPrefix: 'commercial truck repair workshop service near',
    icon: Wrench,
    pinColor: '#b91c1c',
  },
  {
    id: 'hub',
    label: 'Transport Hubs',
    queryPrefix: 'transport nagar logistics hub near',
    icon: Truck,
    pinColor: '#047857',
  },
];

const DEFAULT_INDIA_CENTER: LatLngPoint = { lat: 22.3039, lng: 70.8022 };

function isQuotaError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === 'object' && err !== null
        ? JSON.stringify(err)
        : String(err);
  return (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('OVER_QUERY_LIMIT') ||
    msg.includes('QuotaExceeded') ||
    msg.includes('OverQuotaMapError') ||
    msg.includes('429')
  );
}

function triggerQuotaBannerIfNeeded(err: unknown) {
  if (isQuotaError(err)) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
}

function formatDuration(durationMillis: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMillis / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `${mins} min`;
  return `${hours} hr ${mins} min`;
}

function extractLatLng(loc: unknown): LatLngPoint | null {
  if (!loc || typeof loc !== 'object') return null;
  const obj = loc as {
    lat?: number | (() => number);
    lng?: number | (() => number);
    latitude?: number;
    longitude?: number;
  };
  const lat =
    typeof obj.lat === 'function'
      ? obj.lat()
      : typeof obj.lat === 'number'
        ? obj.lat
        : typeof obj.latitude === 'number'
          ? obj.latitude
          : null;
  const lng =
    typeof obj.lng === 'function'
      ? obj.lng()
      : typeof obj.lng === 'number'
        ? obj.lng
        : typeof obj.longitude === 'number'
          ? obj.longitude
          : null;
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

/**
 * Modern Places API (New) Autocomplete Input using AutocompleteSuggestion + AutocompleteSessionToken
 * + place.fetchFields() (Zero-Legacy compliant).
 */
function PlaceSearchInput({
  label,
  value,
  placeholder,
  onChange,
  onSelectLocation,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (nextVal: string) => void;
  onSelectLocation: (displayText: string, location: LatLngPoint | null) => void;
}) {
  const placesLib = useMapsLibrary('places');
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!placesLib || !open) return;
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
        if (!sessionTokenRef.current) {
          sessionTokenRef.current = new AutocompleteSessionToken();
        }
        setLoading(true);
        const res = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: trimmed,
          sessionToken: sessionTokenRef.current,
          includedRegionCodes: ['in'],
        });
        if (!cancelled) {
          setSuggestions(res?.suggestions ?? []);
        }
      } catch (err) {
        triggerQuotaBannerIfNeeded(err);
        if (!cancelled) {
          setSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [placesLib, value, open]);

  const handleSelectSuggestion = async (
    suggestion: google.maps.places.AutocompleteSuggestion
  ) => {
    if (!suggestion.placePrediction) return;
    const fallbackText = suggestion.placePrediction.text?.text || value;
    setOpen(false);
    setSuggestions([]);

    try {
      const place = suggestion.placePrediction.toPlace();
      await place.fetchFields({
        fields: ['displayName', 'formattedAddress', 'location'],
      });
      const labelText = place.formattedAddress || place.displayName || fallbackText;
      const coords = extractLatLng(place.location);
      onSelectLocation(labelText, coords);
    } catch (err) {
      triggerQuotaBannerIfNeeded(err);
      onSelectLocation(fallbackText, null);
    } finally {
      // Reset session token after Place Details fetch per Places API (New) billing best practices
      sessionTokenRef.current = null;
    }
  };

  return (
    <div ref={wrapperRef} className="relative space-y-1">
      <label className="block text-xs font-medium text-slate-700">{label}</label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          placeholder={placeholder}
          className="w-full px-3 py-2 pr-8 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-500 bg-white"
        />
        {loading && (
          <Loader2 className="w-4 h-4 animate-spin text-slate-400 absolute right-2.5 top-2.5" />
        )}
      </div>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
          {suggestions.map((suggestion, idx) => (
            <li key={idx}>
              <button
                type="button"
                onClick={() => void handleSelectSuggestion(suggestion)}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-start gap-2 cursor-pointer"
              >
                <MapPin className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                <span className="leading-snug">{suggestion.placePrediction?.text?.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Modern Routes API renderer using `useMapsLibrary('routes')` -> `Route.computeRoutes()`
 * and `primaryRoute.createPolylines()` (Zero-Legacy compliant).
 */
function ModernRouteLayer({
  origin,
  destination,
  computeTrigger,
  onRouteComputed,
  onRouteLoadingChange,
  onRouteError,
}: {
  origin: string;
  destination: string;
  computeTrigger: number;
  onRouteComputed: (summary: ComputedRouteSummary | null) => void;
  onRouteLoadingChange: (loading: boolean) => void;
  onRouteError: (error: string | null) => void;
}) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  useEffect(() => {
    if (!map || !routesLib || computeTrigger === 0) return;
    const trimmedOrigin = origin.trim();
    const trimmedDest = destination.trim();
    if (!trimmedOrigin || !trimmedDest) return;

    let cancelled = false;

    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];
    onRouteError(null);
    onRouteLoadingChange(true);

    // Modern Routes API SDK wrapper (`Route.computeRoutes`), bypassing CORS
    // Doc: https://developers.google.com/maps/documentation/javascript/routes?utm_campaign=gmp_mcp_codeassist_v1_aistudio
    const RouteClass = (routesLib as unknown as {
      Route?: {
        computeRoutes: (req: Record<string, unknown>) => Promise<{
          routes?: Array<{
            distanceMeters?: number;
            durationMillis?: number;
            viewport?: google.maps.LatLngBounds;
            legs?: Array<{
              startLocation?: unknown;
              endLocation?: unknown;
            }>;
            createPolylines?: () => google.maps.Polyline[];
          }>;
        }>;
      };
    }).Route;

    if (!RouteClass?.computeRoutes) {
      onRouteLoadingChange(false);
      onRouteError('Routes library is still loading. Please try again in a moment.');
      return;
    }

    RouteClass.computeRoutes({
      origin: trimmedOrigin,
      destination: trimmedDest,
      travelMode: 'DRIVING',
      fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'legs'],
    })
      .then((res) => {
        if (cancelled) return;
        onRouteLoadingChange(false);
        const primaryRoute = res?.routes?.[0];
        if (!primaryRoute) {
          onRouteComputed(null);
          onRouteError('No driving route found between these locations. Try more specific city/port names.');
          return;
        }

        if (typeof primaryRoute.createPolylines === 'function') {
          const newPolylines = primaryRoute.createPolylines();
          newPolylines.forEach((polyline) => {
            polyline.setOptions({
              strokeColor: '#0f172a',
              strokeOpacity: 0.9,
              strokeWeight: 5,
            });
            polyline.setMap(map);
          });
          polylinesRef.current = newPolylines;
        }

        if (primaryRoute.viewport) {
          map.fitBounds(primaryRoute.viewport, 60);
        }

        const firstLeg = primaryRoute.legs?.[0];
        const originPos = extractLatLng(firstLeg?.startLocation);
        const destinationPos = extractLatLng(firstLeg?.endLocation);

        onRouteComputed({
          distanceMeters: primaryRoute.distanceMeters ?? 0,
          durationMillis: primaryRoute.durationMillis ?? 0,
          originPos,
          destinationPos,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onRouteLoadingChange(false);
        triggerQuotaBannerIfNeeded(err);
        onRouteComputed(null);
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Unable to compute route. Please verify both origin and destination.';
        onRouteError(message);
      });

    return () => {
      cancelled = true;
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [
    map,
    routesLib,
    origin,
    destination,
    computeTrigger,
    onRouteComputed,
    onRouteLoadingChange,
    onRouteError,
  ]);

  return null;
}

function NearbyStopsFinder({
  anchorLocationName,
  onStopsLoaded,
}: {
  anchorLocationName: string;
  onStopsLoaded: (stops: NearbyStopPlace[]) => void;
}) {
  const placesLib = useMapsLibrary('places');
  const map = useMap();
  const [activeCategory, setActiveCategory] = useState<StopCategory | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const handleFindStops = useCallback(
    async (category: StopCategory) => {
      if (!placesLib) return;
      const targetArea = anchorLocationName.trim() || 'Mundra Port, Gujarat, India';
      const meta = STOP_CATEGORIES.find((c) => c.id === category);
      if (!meta) return;

      setActiveCategory(category);
      setSearching(true);
      setSearchMessage(null);

      try {
        // Modern Places API (New): Place.searchByText
        // Doc: https://developers.google.com/maps/documentation/javascript/place-search?utm_campaign=gmp_mcp_codeassist_v1_aistudio
        const { places } = await placesLib.Place.searchByText({
          textQuery: `${meta.queryPrefix} ${targetArea}`,
          fields: ['id', 'displayName', 'formattedAddress', 'location', 'googleMapsURI'],
          maxResultCount: 8,
          region: 'IN',
        });

        const mapped: NearbyStopPlace[] = (places ?? [])
          .map((p): NearbyStopPlace | null => {
            const loc = extractLatLng(p.location);
            if (!loc) return null;
            return {
              id: p.id || `${loc.lat}-${loc.lng}`,
              name: p.displayName || 'Verified Location',
              address: p.formattedAddress || '',
              location: loc,
              googleMapsURI: p.googleMapsURI || undefined,
              category,
            };
          })
          .filter((item): item is NearbyStopPlace => item !== null);

        onStopsLoaded(mapped);

        if (mapped.length === 0) {
          setSearchMessage(`No ${meta.label.toLowerCase()} found near "${targetArea}".`);
        } else {
          setSearchMessage(`Found ${mapped.length} ${meta.label.toLowerCase()} near ${targetArea}.`);
          if (map && mapped[0]?.location) {
            map.panTo(mapped[0].location);
            if ((map.getZoom() ?? 6) < 10) {
              map.setZoom(11);
            }
          }
        }
      } catch (err) {
        triggerQuotaBannerIfNeeded(err);
        onStopsLoaded([]);
        setSearchMessage('Unable to fetch nearby stops right now.');
      } finally {
        setSearching(false);
      }
    },
    [placesLib, anchorLocationName, onStopsLoaded, map]
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-600">Find Fleet Stops Near Destination:</span>
        {STOP_CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isSelected = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              disabled={searching || !placesLib}
              onClick={() => void handleFindStops(cat.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer disabled:opacity-50 ${
                isSelected
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{cat.label}</span>
            </button>
          );
        })}
        {searching && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
      </div>
      {searchMessage && <p className="text-xs text-slate-500">{searchMessage}</p>}
    </div>
  );
}

function RouteMapWorkspace({
  trips,
  companySettings,
}: RouteMapViewProps) {
  const [selectedTripId, setSelectedTripId] = useState<string>('');
  const [originText, setOriginText] = useState('Gandhidham, Gujarat, India');
  const [destinationText, setDestinationText] = useState('Ahmedabad, Gujarat, India');
  const [originCoords, setOriginCoords] = useState<LatLngPoint | null>(null);
  const [destinationCoords, setDestinationCoords] = useState<LatLngPoint | null>(null);
  const [computeTrigger, setComputeTrigger] = useState(0);
  const [routeSummary, setRouteSummary] = useState<ComputedRouteSummary | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [nearbyStops, setNearbyStops] = useState<NearbyStopPlace[]>([]);
  const [activeMarkerInfo, setActiveMarkerInfo] = useState<{
    position: LatLngPoint;
    title: string;
    subtitle: string;
    uri?: string;
  } | null>(null);
  const [truckMileageKmPerL, setTruckMileageKmPerL] = useState<string>('4.0');

  const dieselRate = companySettings?.defaultDieselRate ?? DEFAULT_DIESEL_RATE;

  const tripsWithRoute = useMemo(
    () =>
      trips
        .filter((t) => t.origin?.trim() && t.destination?.trim())
        .slice(0, 60),
    [trips]
  );

  const handleLoadTrip = (tripId: string) => {
    setSelectedTripId(tripId);
    const found = trips.find((t) => t.id === tripId);
    if (!found) return;
    setOriginText(found.origin);
    setDestinationText(found.destination);
    setOriginCoords(null);
    setDestinationCoords(null);
    setNearbyStops([]);
    setActiveMarkerInfo(null);
    setComputeTrigger((c) => c + 1);
  };

  const handleComputeRoute = (e: React.FormEvent) => {
    e.preventDefault();
    if (!originText.trim() || !destinationText.trim()) {
      setRouteError('Please enter both Origin and Destination.');
      return;
    }
    setActiveMarkerInfo(null);
    setComputeTrigger((c) => c + 1);
  };

  const distanceKm = routeSummary ? routeSummary.distanceMeters / 1000 : 0;
  const parsedMileage = Math.max(0.5, Number(truckMileageKmPerL) || 4);
  const estDieselQuantityL = distanceKm > 0 ? distanceKm / parsedMileage : 0;
  const estDieselAmountINR = estDieselQuantityL * dieselRate;

  const displayOriginPos = routeSummary?.originPos ?? originCoords;
  const displayDestPos = routeSummary?.destinationPos ?? destinationCoords;

  return (
    <div className="space-y-5">
      {/* Route Planner Control Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900">
              Trip Route Map & Fleet Stops
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Visualize existing ERP trip routes or plan new routes with live distance, ETA, diesel estimates, and nearby fleet stops.
            </p>
          </div>

          {tripsWithRoute.length > 0 && (
            <div className="w-full md:w-80">
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                Load From Existing ERP Trip (Read-Only)
              </label>
              <select
                value={selectedTripId}
                onChange={(e) => handleLoadTrip(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              >
                <option value="">-- Select a trip to map --</option>
                {tripsWithRoute.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.tripDate} | {t.lrNumber || t.vehicleNumber} | {t.origin} → {t.destination}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <form onSubmit={handleComputeRoute} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-5">
            <PlaceSearchInput
              label="Origin (Loading Point / Port / City)"
              value={originText}
              placeholder="e.g., Mundra Port, Gujarat"
              onChange={(val) => {
                setOriginText(val);
                setSelectedTripId('');
              }}
              onSelectLocation={(label, coords) => {
                setOriginText(label);
                setOriginCoords(coords);
              }}
            />
          </div>

          <div className="md:col-span-5">
            <PlaceSearchInput
              label="Destination (Unloading Point / City)"
              value={destinationText}
              placeholder="e.g., Ahmedabad, Gujarat"
              onChange={(val) => {
                setDestinationText(val);
                setSelectedTripId('');
              }}
              onSelectLocation={(label, coords) => {
                setDestinationText(label);
                setDestinationCoords(coords);
              }}
            />
          </div>

          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={routeLoading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[38px] bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
            >
              {routeLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Navigation className="w-4 h-4" />
              )}
              <span>Show Route</span>
            </button>
          </div>
        </form>

        {routeError && (
          <div className="px-3.5 py-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
            {routeError}
          </div>
        )}

        {/* Route Metrics Strip (Diesel Quantity & Diesel Amount strictly separate) */}
        {routeSummary && (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <RouteIcon className="w-3.5 h-3.5 text-slate-700" />
                <span>Road Distance</span>
              </div>
              <div className="font-mono text-base font-semibold text-slate-900 mt-1">
                {distanceKm.toFixed(1)} km
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <Clock className="w-3.5 h-3.5 text-slate-700" />
                <span>Est. Drive Time</span>
              </div>
              <div className="font-mono text-base font-semibold text-slate-900 mt-1">
                {formatDuration(routeSummary.durationMillis)}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="flex items-center justify-between text-[11px] font-medium text-slate-500">
                <span>Truck Avg (km/L)</span>
              </div>
              <input
                type="number"
                min="1"
                max="20"
                step="0.5"
                value={truckMileageKmPerL}
                onChange={(e) => setTruckMileageKmPerL(e.target.value)}
                className="mt-1 w-24 px-2 py-0.5 text-sm font-mono font-semibold text-slate-900 bg-white border border-slate-300 rounded"
              />
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
                <Fuel className="w-3.5 h-3.5 text-amber-600" />
                <span>Est. Diesel Quantity</span>
              </div>
              <div className="font-mono text-base font-semibold text-slate-900 mt-1">
                {estDieselQuantityL.toFixed(1)} L
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-[11px] font-medium text-slate-500">
                Est. Diesel Amount (@ ₹{dieselRate}/L)
              </div>
              <div className="font-mono text-base font-semibold text-slate-900 mt-1">
                {formatINR(estDieselAmountINR)}
              </div>
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-slate-100">
          <NearbyStopsFinder
            anchorLocationName={destinationText || originText}
            onStopsLoaded={setNearbyStops}
          />
        </div>
      </div>

      {/* Interactive Map + Nearby Stops Side Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          {/* Explicit height prevents CF2 Map Height Collapse */}
          <div className="w-full h-[520px] lg:h-[600px]">
            <GoogleMap
              mapId="DEMO_MAP_ID"
              defaultCenter={DEFAULT_INDIA_CENTER}
              defaultZoom={6}
              gestureHandling="greedy"
              streetViewControl={false}
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              className="w-full h-full"
            >
              <ModernRouteLayer
                origin={originText}
                destination={destinationText}
                computeTrigger={computeTrigger}
                onRouteComputed={setRouteSummary}
                onRouteLoadingChange={setRouteLoading}
                onRouteError={setRouteError}
              />

              {displayOriginPos && (
                <AdvancedMarker
                  position={displayOriginPos}
                  title={`Origin: ${originText}`}
                  onClick={() =>
                    setActiveMarkerInfo({
                      position: displayOriginPos,
                      title: 'Origin (Loading)',
                      subtitle: originText,
                    })
                  }
                >
                  <Pin background="#047857" borderColor="#065f46" glyphColor="#ffffff" />
                </AdvancedMarker>
              )}

              {displayDestPos && (
                <AdvancedMarker
                  position={displayDestPos}
                  title={`Destination: ${destinationText}`}
                  onClick={() =>
                    setActiveMarkerInfo({
                      position: displayDestPos,
                      title: 'Destination (Unloading)',
                      subtitle: destinationText,
                    })
                  }
                >
                  <Pin background="#0f172a" borderColor="#020617" glyphColor="#ffffff" />
                </AdvancedMarker>
              )}

              {nearbyStops.map((stop) => {
                const catMeta = STOP_CATEGORIES.find((c) => c.id === stop.category);
                return (
                  <AdvancedMarker
                    key={stop.id}
                    position={stop.location}
                    title={stop.name}
                    onClick={() =>
                      setActiveMarkerInfo({
                        position: stop.location,
                        title: stop.name,
                        subtitle: stop.address,
                        uri: stop.googleMapsURI,
                      })
                    }
                  >
                    <Pin
                      background={catMeta?.pinColor || '#d97706'}
                      borderColor="#ffffff"
                      glyphColor="#ffffff"
                    />
                  </AdvancedMarker>
                );
              })}

              {activeMarkerInfo && (
                <InfoWindow
                  position={activeMarkerInfo.position}
                  onCloseClick={() => setActiveMarkerInfo(null)}
                >
                  <div className="p-1 max-w-[240px] space-y-1">
                    <div className="text-xs font-semibold text-slate-900">
                      {activeMarkerInfo.title}
                    </div>
                    <div className="text-[11px] text-slate-600 leading-snug">
                      {activeMarkerInfo.subtitle}
                    </div>
                    {activeMarkerInfo.uri && (
                      <a
                        href={activeMarkerInfo.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline pt-0.5"
                      >
                        <span>Open in Google Maps</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </InfoWindow>
              )}
            </GoogleMap>
          </div>
        </div>

        {/* Verified Fleet Stops Results List */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-4 flex flex-col max-h-[600px]">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-slate-700" />
              <h3 className="font-display text-sm font-semibold text-slate-900">
                Nearby Fleet Stops
              </h3>
            </div>
            <span className="text-xs font-mono text-slate-500">{nearbyStops.length} found</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 mt-2">
            {nearbyStops.length === 0 ? (
              <div className="py-12 text-center space-y-2 px-4">
                <MapPin className="w-7 h-7 text-slate-300 mx-auto" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  Select a stop category above (Diesel Pumps, Weighbridges, Truck Workshops, or Transport Hubs) to locate verified places near your destination.
                </p>
              </div>
            ) : (
              nearbyStops.map((stop) => (
                <div key={stop.id} className="py-3 space-y-1">
                  <button
                    type="button"
                    onClick={() =>
                      setActiveMarkerInfo({
                        position: stop.location,
                        title: stop.name,
                        subtitle: stop.address,
                        uri: stop.googleMapsURI,
                      })
                    }
                    className="text-left text-xs font-semibold text-slate-900 hover:text-sky-700 cursor-pointer"
                  >
                    {stop.name}
                  </button>
                  <p className="text-[11px] text-slate-500 leading-snug">{stop.address}</p>
                  {stop.googleMapsURI && (
                    <a
                      href={stop.googleMapsURI}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-700 hover:underline"
                    >
                      <span>View on Google Maps</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const RouteMapView: React.FC<RouteMapViewProps> = ({ trips, companySettings }) => {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  if (!apiKey) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center space-y-2">
        <MapPin className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="font-display text-base font-semibold text-slate-900">
          Google Maps Configuration Pending
        </h2>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          The Google Maps API key is loaded from your workspace environment variables. Please refresh once provisioning completes.
        </p>
      </div>
    );
  }

  return (
    <APIProvider apiKey={apiKey} language="en" region="IN">
      <RouteMapWorkspace trips={trips} companySettings={companySettings} />
    </APIProvider>
  );
};
