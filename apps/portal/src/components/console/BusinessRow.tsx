import { useState } from 'react';
import { Copy, ExternalLink, Globe, MapPin } from 'lucide-react';
import {
  GATE_CRITERIA,
  GATE_CRITERIA_LABELS,
  type ConsoleBusinessRow,
  type GateCriterion,
} from '../../hooks/use-business-console';

const cellStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: '12px',
  color: 'var(--text-secondary)',
  verticalAlign: 'top',
  borderBottom: '1px solid var(--border)',
};

// Real Google Place IDs start with letters like ChIJ / GhIJ / Eic and
// are opaque base64-ish tokens. During an earlier dedup pass we found
// entries where an addressLine1 had leaked into the placeId field —
// those show up as strings with spaces, commas, or short length. When
// we can't trust the placeId, fall back to a Maps text search on
// `<name> <addressLine1>` so the row link still lands somewhere useful.
function isProbablyRealPlaceId(pid: string | null): boolean {
  if (!pid) return false;
  const trimmed = pid.trim();
  if (!trimmed) return false;
  if (trimmed.length < 20) return false;
  if (/[\s,]/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  return true;
}

function mapsHref(row: ConsoleBusinessRow): string {
  if (isProbablyRealPlaceId(row.placeId)) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(row.placeId!)}`;
  }
  const q = [row.name, row.addressLine1].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/${encodeURIComponent(q || row.name || row._id)}`;
}

function normalizeWebsite(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

// 10-dot gate strip. Filled = passing, hollow = failing. Missing
// gateStatus reads as all-hollow. Hover on a dot to see which
// criterion it represents and whether it passed.
function GateStrip({ gate }: { gate: Record<string, any> | null }) {
  return (
    <div style={{ display: 'flex', gap: '2px' }}>
      {GATE_CRITERIA.map((c) => {
        const pass = !!gate?.[c];
        return (
          <span
            key={c}
            title={`${GATE_CRITERIA_LABELS[c as GateCriterion]}: ${pass ? 'pass' : 'fail'}`}
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: pass ? 'var(--green, #22c55e)' : 'transparent',
              border: `1px solid ${pass ? 'var(--green, #22c55e)' : 'var(--border-strong, var(--border))'}`,
            }}
          />
        );
      })}
    </div>
  );
}

function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(id);
          setCopied(true);
          setTimeout(() => setCopied(false), 900);
        } catch {
          // clipboard unavailable — silent no-op is fine
        }
      }}
      title="Copy _id"
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: copied ? 'var(--green, #22c55e)' : 'var(--text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px',
      }}
    >
      <Copy size={12} />
    </button>
  );
}

export function BusinessRow({ row }: { row: ConsoleBusinessRow }) {
  const cover = row.coverThumbnail ?? row.cover ?? null;
  const emailTier =
    row.emailVerification?.confidence &&
    row.emailVerification?.source === 'website_scrape'
      ? String(row.emailVerification.confidence)
      : null;
  return (
    <tr>
      <td style={{ ...cellStyle, width: '52px' }}>
        {cover ? (
          <img
            src={cover}
            alt=""
            style={{
              width: '40px',
              height: '30px',
              objectFit: 'cover',
              borderRadius: '4px',
              background: 'var(--surface-elevated)',
              border: '1px solid var(--border)',
            }}
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
        ) : (
          <div
            style={{
              width: '40px',
              height: '30px',
              borderRadius: '4px',
              background: 'var(--surface-elevated)',
              border: '1px dashed var(--border)',
            }}
          />
        )}
      </td>
      <td style={{ ...cellStyle, color: 'var(--text)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontWeight: 500 }}>{row.name ?? '(unnamed)'}</span>
          <span
            style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '340px',
            }}
          >
            {row.addressLine1 ?? ''}
          </span>
        </div>
      </td>
      <td style={cellStyle}>
        {[row.city, row.state].filter(Boolean).join(', ') || '—'}
      </td>
      <td style={cellStyle}>
        <GateStrip gate={row.gateStatus} />
      </td>
      <td style={cellStyle}>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 6px',
            fontSize: '10px',
            fontWeight: 600,
            borderRadius: '4px',
            background: row.isActive
              ? 'rgba(34, 197, 94, 0.12)'
              : 'rgba(115, 115, 115, 0.12)',
            color: row.isActive
              ? 'var(--green, #22c55e)'
              : 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {row.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style={cellStyle}>
        <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
          {row.resolveStatus?.hours ?? '—'}
        </span>
      </td>
      <td style={{ ...cellStyle, maxWidth: '200px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span
            style={{
              fontSize: '11px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'inline-block',
              maxWidth: '160px',
            }}
          >
            {row.email ?? '—'}
          </span>
          {emailTier && (
            <span
              title={`Verified email (tier ${emailTier}) — captured by website scrape`}
              style={{
                fontSize: '9px',
                fontWeight: 700,
                padding: '1px 4px',
                borderRadius: '3px',
                background: 'rgba(34, 197, 94, 0.14)',
                color: 'var(--green, #22c55e)',
                letterSpacing: '0.04em',
              }}
            >
              {emailTier}
            </span>
          )}
        </div>
      </td>
      <td style={cellStyle}>
        <span
          title={row.placeId ?? ''}
          style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}
        >
          {row.placeId ? row.placeId.slice(0, 12) + '…' : '—'}
        </span>
      </td>
      <td style={{ ...cellStyle, width: '108px' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <a
            href={mapsHref(row)}
            target="_blank"
            rel="noreferrer noopener"
            title={
              isProbablyRealPlaceId(row.placeId)
                ? 'Open in Google Maps by placeId'
                : 'Open in Google Maps (search fallback — placeId missing/malformed)'
            }
            style={{
              color: 'var(--text-secondary)',
              display: 'inline-flex',
              padding: '2px',
            }}
          >
            <MapPin size={12} />
          </a>
          {row.website && (
            <a
              href={normalizeWebsite(row.website)}
              target="_blank"
              rel="noreferrer noopener"
              title="Open website"
              style={{
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                padding: '2px',
              }}
            >
              <Globe size={12} />
            </a>
          )}
          {row.cover && (
            <a
              href={row.cover}
              target="_blank"
              rel="noreferrer noopener"
              title="Open cover"
              style={{
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                padding: '2px',
              }}
            >
              <ExternalLink size={12} />
            </a>
          )}
          <CopyIdButton id={row._id} />
        </div>
      </td>
    </tr>
  );
}
