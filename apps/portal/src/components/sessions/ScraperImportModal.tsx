import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X, Upload, FileJson, AlertCircle, CheckCircle2, Trash2,
} from 'lucide-react';
import { useImportScraperData } from '../../hooks/use-sessions';
import { useLocations, US_STATES } from '../../hooks/use-locations';
import { Button } from '../ui/Button';
import type { Environment } from '@pinntag-dop/types';

const ENVIRONMENTS: Environment[] = [
  'dev', 'pre-prod', 'staging', 'production',
];

const INDUSTRY_CATEGORIES: Record<string, string[]> = {
  'Food & Drinks': [
    'Restaurant',
    'Café / Coffee',
    'Bar / Pub',
    'Bakery / Dessert',
    'Food Truck / Pop-up',
    'Brewery / Winery',
  ],
  'Entertainment': [
    'Live Music',
    'Nightclub & Dance',
    'Cinema / Theater',
    'Cultural & Arts',
    'Comedy Club',
  ],
  'Sports & Outdoor': [
    'Gym / Fitness',
    'Yoga / Pilates',
    'Sports Facility',
    'Adventure / Outdoor',
    'Parks / Recreation',
  ],
  'Activities & Experiences': [
    'Bowling',
    'Arcades & Amusements',
    'Games & Challenges',
    'Golf / Mini Golf',
    'VR / Gaming',
    'Adventure & Active Fun',
  ],
  'Beauty & Wellness': [
    'Spa & Massage',
    'Hair',
    'Beauty',
    'Nail',
    'Aesthetic',
    'Med spa',
    'Wellness',
  ],
  'Clubs & Classes': [
    'Art & Craft',
    'Music / Performing Arts',
    'Language & Cultural',
    'Skill Training',
    'Dance',
    'Cooking',
  ],
  'Local Attractions': [
    'Museum',
    'Art Gallery',
    'Cultural Attraction',
    'Historical Site / Landmark',
    'Botanical Garden / Park',
    'Zoo / Aquarium',
  ],
  'Local Services': [
    'Home Repair',
    'Auto Services',
    'Pet Care',
    'Tutoring',
    'Cleaning',
    'Landscaping',
    'Business & Professional',
  ],
  'Retail & Shopping': [
    'Fashion & Apparel',
    'Specialty / Boutique',
    'Grocery / Market',
    'Shoes & Accessories',
    'Pop-up / Seasonal',
  ],
  'Places to Stay': [
    'Hotel / Resort',
    'Bed & Breakfast',
    'Hostel / Guesthouse',
    'Serviced Apartment',
    'Camping / Glamping',
  ],
};

const INDUSTRIES = Object.keys(INDUSTRY_CATEGORIES);

function defaultName(): string {
  return `Scraper Import ${new Date().toISOString().slice(0, 10)}`;
}

function FileDropZone({
  label,
  file,
  onFile,
  onClear,
  optional,
}: {
  label: string;
  file: File | null;
  onFile: (f: File) => void;
  onClear: () => void;
  optional?: boolean;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: '12px',
          color: 'var(--text-secondary)',
          marginBottom: '6px',
        }}
      >
        {label}
        {optional && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              marginLeft: '6px',
            }}
          >
            (optional)
          </span>
        )}
      </label>
      {!file ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          onMouseEnter={(e) => {
            if (isDragging) return;
            (e.currentTarget as HTMLElement).style.borderColor = '#A1A1AA';
          }}
          onMouseLeave={(e) => {
            if (isDragging) return;
            (e.currentTarget as HTMLElement).style.borderColor = '#E4E4E7';
          }}
          style={{
            border: `2px dashed ${isDragging ? '#1A6BFF' : '#E4E4E7'}`,
            borderRadius: '8px',
            padding: '24px',
            textAlign: 'center',
            cursor: 'pointer',
            backgroundColor: isDragging ? '#EFF6FF' : 'transparent',
            transition: 'all 150ms',
          }}
        >
          <FileJson
            size={18}
            style={{
              color: 'var(--text-secondary)',
              marginBottom: '6px',
            }}
          />
          <p
            style={{
              fontSize: '13px',
              color: 'var(--text)',
              fontWeight: 500,
              marginBottom: '2px',
            }}
          >
            Drop a .json file or click
          </p>
          <p
            style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
            }}
          >
            Only .json supported
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
            style={{ display: 'none' }}
          />
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 14px',
            border: '1px solid var(--border)',
            borderRadius: '8px',
          }}
        >
          <FileJson
            size={16}
            style={{ color: '#16A34A', flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--text)',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.name}
            </p>
            <p
              style={{
                fontSize: '11px',
                color: 'var(--text-muted)',
              }}
            >
              {(file.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <button
            onClick={onClear}
            style={{
              color: 'var(--text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function ScraperImportModal({
  onClose,
  environment,
}: {
  onClose: () => void;
  environment: Environment;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(defaultName());
  const [env, setEnv] = useState<Environment>(environment);
  const [defaultIndustry, setDefaultIndustry] = useState<string>('');
  const [defaultCity, setDefaultCity] = useState<string>('');
  const [defaultState, setDefaultState] = useState<string>('');
  const [industryError, setIndustryError] = useState('');
  const { data: locations } = useLocations();
  const [scraperFile, setScraperFile] = useState<File | null>(null);
  const [emailFile, setEmailFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{
    processed: number;
    emailMatched: number;
    categoryMapped: number;
    categoryFallback: number;
    hoursUnparsed: number;
    addressInvalid: number;
    noCoords: number;
    noPlaceId: number;
    noName: number;
    sessionId: string;
  } | null>(null);

  const importScraper = useImportScraperData();

  const handleSubmit = async () => {
    if (!scraperFile) {
      setError('Scraper data file is required');
      return;
    }
    if (!name.trim()) {
      setError('Session name is required');
      return;
    }
    setIndustryError('');
    if (!defaultIndustry) {
      setIndustryError('Please select an industry');
      return;
    }
    setError('');
    try {
      const result = await importScraper.mutateAsync({
        scraperFile,
        emailFile: emailFile ?? undefined,
        name: name.trim(),
        environment: env,
        actor: 'Operator',
        defaultIndustry,
        ...(defaultCity ? { defaultCity } : {}),
        ...(defaultState ? { defaultState } : {}),
      });
      setSuccess({
        processed: result.stats.processed,
        emailMatched: result.stats.emailMatched,
        categoryMapped: result.stats.categoryMapped,
        categoryFallback: result.stats.categoryFallback,
        hoursUnparsed: result.stats.hoursUnparsed,
        addressInvalid: result.stats.addressInvalid,
        noCoords: result.stats.noCoords,
        noPlaceId: result.stats.noPlaceId,
        noName: result.stats.noName,
        sessionId: result.sessionId,
      });
      setTimeout(() => {
        navigate(`/sessions/${result.sessionId}`);
      }, 1500);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ?? err.message ?? 'Import failed',
      );
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          width: '520px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
          color: 'var(--text)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            Import scraper data
          </h2>
          <button
            onClick={onClose}
            style={{
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: '4px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Name */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Session name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName()}
              style={{ width: '100%' }}
            />
          </div>

          {/* Environment */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Environment
            </label>
            <select
              value={env}
              onChange={(e) => setEnv(e.target.value as Environment)}
              style={{
                width: '100%',
                height: '36px',
                paddingLeft: '10px',
                paddingRight: '28px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                backgroundColor: 'var(--surface)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>

          {/* Industry */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              Industry *
            </label>
            <select
              value={defaultIndustry}
              onChange={(e) => {
                setDefaultIndustry(e.target.value);
                setIndustryError('');
              }}
              style={{
                width: '100%',
                height: '36px',
                paddingLeft: '10px',
                paddingRight: '28px',
                border: `1px solid ${
                  industryError ? '#DC2626' : 'var(--border)'
                }`,
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                backgroundColor: 'var(--surface)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="" disabled>
                Select an industry
              </option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
            {industryError && (
              <p
                style={{
                  fontSize: '12px',
                  color: '#DC2626',
                  marginTop: '4px',
                }}
              >
                {industryError}
              </p>
            )}
            <p
              style={{
                fontSize: '11px',
                color: 'var(--text-muted)',
                marginTop: '6px',
                lineHeight: 1.5,
              }}
            >
              Category is auto-detected per business from Google data;
              unresolved ones are set later by Fix taxonomy.
            </p>
          </div>

          {/* City (optional) */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              City{' '}
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  marginLeft: '4px',
                }}
              >
                (optional)
              </span>
            </label>
            <select
              value={defaultCity}
              onChange={(e) => {
                const value = e.target.value;
                setDefaultCity(value);
                const hit = locations?.find((l) => l.city === value);
                if (hit) setDefaultState(hit.state);
              }}
              style={{
                width: '100%',
                height: '36px',
                paddingLeft: '10px',
                paddingRight: '28px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                backgroundColor: 'var(--surface)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="">— None —</option>
              {(locations ?? [])
                .filter((l) => l.isActive)
                .map((l) => (
                  <option key={l._id} value={l.city}>
                    {l.city} ({l.state})
                  </option>
                ))}
            </select>
          </div>

          {/* State (optional, auto-fills from City) */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '12px',
                color: 'var(--text-secondary)',
                marginBottom: '6px',
              }}
            >
              State{' '}
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  marginLeft: '4px',
                }}
              >
                (optional, auto-fills from city)
              </span>
            </label>
            <select
              value={defaultState}
              onChange={(e) => setDefaultState(e.target.value)}
              style={{
                width: '100%',
                height: '36px',
                paddingLeft: '10px',
                paddingRight: '28px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                backgroundColor: 'var(--surface)',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="">— None —</option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* Scraper data file */}
          <FileDropZone
            label="Scraper data (JSON array)"
            file={scraperFile}
            onFile={setScraperFile}
            onClear={() => setScraperFile(null)}
          />

          {/* Email map file */}
          <FileDropZone
            label="Email map"
            file={emailFile}
            onFile={setEmailFile}
            onClear={() => setEmailFile(null)}
            optional
          />

          {/* Error */}
          {error && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                padding: '10px 14px',
                backgroundColor: '#FEF2F2',
                borderRadius: '8px',
                alignItems: 'flex-start',
              }}
            >
              <AlertCircle
                size={14}
                style={{
                  color: '#DC2626',
                  flexShrink: 0,
                  marginTop: '1px',
                }}
              />
              <p style={{ fontSize: '13px', color: '#DC2626' }}>
                {error}
              </p>
            </div>
          )}

          {/* Success */}
          {success && (
            <div
              style={{
                display: 'flex',
                gap: '10px',
                padding: '12px 14px',
                backgroundColor: '#F0FDF4',
                borderRadius: '8px',
                alignItems: 'flex-start',
              }}
            >
              <CheckCircle2
                size={16}
                style={{
                  color: '#16A34A',
                  flexShrink: 0,
                  marginTop: '1px',
                }}
              />
              <div style={{ fontSize: '13px', color: '#166534' }}>
                <p style={{ fontWeight: 500, marginBottom: '4px' }}>
                  Imported {success.processed} businesses
                </p>
                <p style={{ fontSize: '12px', lineHeight: 1.5 }}>
                  {success.emailMatched} emails matched ·{' '}
                  {success.categoryMapped} categories mapped ·{' '}
                  {success.categoryFallback} used fallback
                </p>
                {(success.hoursUnparsed > 0 ||
                  success.addressInvalid > 0 ||
                  success.noCoords > 0 ||
                  success.noPlaceId > 0 ||
                  success.noName > 0) && (
                  <p
                    style={{
                      fontSize: '12px',
                      lineHeight: 1.5,
                      marginTop: '4px',
                      color: '#92400E',
                    }}
                  >
                    Data quality: {success.hoursUnparsed} hours unparsed ·{' '}
                    {success.addressInvalid} invalid address ·{' '}
                    {success.noCoords} no coords · {success.noPlaceId} no
                    placeId · {success.noName} no name
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            flexShrink: 0,
          }}
        >
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={importScraper.isPending}
          >
            Cancel
          </Button>
          <Button
            icon={<Upload size={14} />}
            loading={importScraper.isPending}
            disabled={!scraperFile || !!success}
            onClick={handleSubmit}
          >
            Import &amp; transform
          </Button>
        </div>
      </div>
    </div>
  );
}
